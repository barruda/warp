// Local bridge for Warp's web build (compiled with the `remote_tty` feature).
//
// Warp's remote_tty event loop opens a WebSocket to `window.PASEO_WARP_PTY_URL` (our patch in
// app/src/terminal/remote_tty/event_loop.rs; upstream hard-codes ws://127.0.0.1:3030/create)
// and appends `num_rows`/`num_cols`. Wire format:
//   binary frames  -> raw PTY bytes, both directions
//   text frames    -> JSON {width,height,width_px,height_px} resize (client -> server)
// The shell starts the way desktop Warp starts it (crates/warp_terminal/src/local_tty/shell.rs):
//   bash  `exec -a bash bash --rcfile <(echo '<init>')`, where <init> is Warp's bash_init_shell.sh with the
//         session id Warp sent in the /create URL (`shell=bash&session_id=…&honor_ps1=…`).
//   zsh   `exec -a -zsh zsh -g --no-rcs`; Warp types the zsh init script into the PTY itself.
// Either way the init script sends the InitShell hook and Warp then types the full bootstrap,
// which sources the user's rc files (bash: /etc/profile and ~/.bash_profile, like a login shell).
// A Warp build from before bash support sends no session_id and always gets zsh.
//
// The Paseo `warp` plugin runs this as a child process. Environment:
//   WARP_BRIDGE_TOKEN  required for /create; pages get it in their URL (?token=...)
//   PORT               0 picks a free port. Prints `WARP_BRIDGE_READY <port>` once listening.
//   BUNDLE_DIR         the wasm bundle; defaults to the release build here, else the debug one.
//   WARP_SHELL_TYPE    "bash" (default) or "zsh"; a page URL's ?shell= overrides it.
//   WARP_BASH, WARP_ZSH  the shell binaries.
// The bridge exits when its stdin closes, so it dies with the plugin process.

import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import os from "node:os";
import pty from "node-pty";
import { WebSocketServer } from "ws";

const HERE = new URL(".", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 3030);
const HOST = process.env.HOST ?? "127.0.0.1";
const TOKEN = process.env.WARP_BRIDGE_TOKEN ?? "";
const ZSH = process.env.WARP_ZSH ?? "/usr/bin/zsh";
const BASH = process.env.WARP_BASH ?? "/bin/bash";
const SHELL_TYPE = process.env.WARP_SHELL_TYPE === "zsh" ? "zsh" : "bash";
const BASH_INIT = join(HERE, "../app/assets/bundled/bootstrap/bash_init_shell.sh");
// Desktop Warp's BASH_HISTORY_SIZE_SENTINEL: bash loads the whole history file, and the bootstrap
// unsets these again unless the user's rc files changed them.
const BASH_HISTORY_SIZE_SENTINEL = "57265949261";

// Re-resolved per request so a finished release build replaces the debug one without a restart.
function bundleDir() {
  if (process.env.BUNDLE_DIR) return resolve(process.env.BUNDLE_DIR);
  const target = join(HERE, "../target/wasm32-unknown-unknown");
  const candidates = ["release-wasm", "dev-wasm"].map((profile) => join(target, profile, "bundle"));
  return candidates.find((dir) => existsSync(join(dir, "wasm/warp_bg.wasm"))) ?? candidates[0];
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff2": "font/woff2",
};

// Sets PASEO_WARP_PTY_URL from this page's own URL before Warp starts; Warp rewrites the URL later.
const INDEX_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Warp</title>
  <style>
    body { margin: 0; background-color: black; }
    canvas { display: block; width: 100vw; height: 100vh; height: 100svh; outline: none; }
  </style>
</head>
<body>
  <script type="module">
    const page = new URL(window.location.href);
    const pty = new URL("/create", page);
    pty.protocol = page.protocol === "https:" ? "wss:" : "ws:";
    for (const key of ["token", "cwd"]) {
      const value = page.searchParams.get(key);
      if (value) pty.searchParams.set(key, value);
    }
    window.PASEO_WARP_PTY_URL = pty.toString();
    const shell = page.searchParams.get("shell");
    window.PASEO_WARP_SHELL = shell === "bash" || shell === "zsh" ? shell : "@@SHELL_TYPE@@";
    import("/assets/client/wasm/warp.js").then(({ default: init }) => init());
  </script>
</body>
</html>
`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);
  const file = resolveBundlePath(pathname);
  if (file === "index") {
    res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" });
    res.end(INDEX_HTML.replace("@@SHELL_TYPE@@", SHELL_TYPE));
    return;
  }
  if (!file) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

// Same layout as Warp's own dev server (crates/serve-wasm/src/main.rs).
function resolveBundlePath(pathname) {
  const under = (dir, rest) => {
    const base = join(bundleDir(), dir);
    const file = normalize(join(base, rest));
    return file.startsWith(base) ? file : null;
  };
  if (pathname.startsWith("/assets/client/wasm/"))
    return under("wasm", pathname.slice("/assets/client/wasm/".length));
  if (pathname.startsWith("/assets/client/static/"))
    return under("assets", pathname.slice("/assets/client/static/".length));
  return "index";
}

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname !== "/create" || (TOKEN && url.searchParams.get("token") !== TOKEN)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => startSession(ws, url));
});

function startSession(ws, url) {
  const cols = Number(url.searchParams.get("num_cols")) || 80;
  const rows = Number(url.searchParams.get("num_rows")) || 24;
  const requestedCwd = url.searchParams.get("cwd");
  const cwd = requestedCwd && existsSync(requestedCwd) ? requestedCwd : os.homedir();

  const sessionId = url.searchParams.get("session_id");
  const bash = url.searchParams.get("shell") === "bash" && /^\d+$/.test(sessionId ?? "");

  const env = {
    ...process.env,
    TERM: "xterm-256color",
    TERM_PROGRAM: "WarpTerminal",
    COLORTERM: "truecolor",
    SHELL: bash ? BASH : ZSH,
    WARP_IS_LOCAL_SHELL_SESSION: "1",
    WARP_USE_SSH_WRAPPER: "0",
    WARP_INITIAL_WORKING_DIR: cwd,
  };
  for (const key of ["DESKTOP_STARTUP_ID", "WARP_BRIDGE_TOKEN", "PORT", "BUNDLE_DIR", "WARP_SHELL_TYPE"])
    delete env[key];

  let command;
  if (bash) {
    Object.assign(env, {
      HISTFILESIZE: BASH_HISTORY_SIZE_SENTINEL,
      HISTSIZE: BASH_HISTORY_SIZE_SENTINEL,
      WARP_INITIAL_HISTFILESIZE: BASH_HISTORY_SIZE_SENTINEL,
      WARP_INITIAL_HISTSIZE: BASH_HISTORY_SIZE_SENTINEL,
    });
    // Like desktop Warp, the rcfile is a process substitution, so no file is left behind.
    const init = bashInitScript(sessionId, url.searchParams.get("honor_ps1") === "1");
    command = `exec -a bash '${BASH}' --rcfile <(echo '${init.replaceAll("'", `'"'"'`)}')`;
  } else {
    command = `exec -a -zsh '${ZSH}' -g --no-rcs`;
  }

  const term = pty.spawn("/bin/bash", ["-c", command], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
  });
  console.log(
    `[bridge] session pid=${term.pid} ${bash ? "bash" : "zsh"} ${cols}x${rows} cwd=${cwd}`,
  );

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(Buffer.from(data, "utf8"), { binary: true });
  });
  term.onExit(({ exitCode }) => {
    console.log(`[bridge] pid=${term.pid} exited ${exitCode}`);
    ws.close();
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      term.write(Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data).toString("utf8"));
      return;
    }
    try {
      const { width, height } = JSON.parse(data.toString());
      if (width > 0 && height > 0) term.resize(width, height);
    } catch (err) {
      console.warn("[bridge] bad control frame", err);
    }
  });
  ws.on("close", () => {
    try {
      term.kill();
    } catch {}
  });
}

// Warp's bash_init_shell.sh, as desktop Warp fills it in (crates/warp_terminal/src/bootstrap.rs),
// with the honor-PS1 setting the zsh path types into the PTY instead.
function bashInitScript(sessionId, honorPs1) {
  const script = readFileSync(BASH_INIT, "utf8")
    .replaceAll("@@WARP_SESSION_ID@@", sessionId)
    .replaceAll("@@USING_CON_PTY_BOOLEAN@@", "false");
  return `WARP_HONOR_PS1="${honorPs1 ? 1 : 0}"\n${script}`;
}

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  console.log(`WARP_BRIDGE_READY ${port}`);
  console.log(`[bridge] http://${HOST}:${port}  bundle=${bundleDir()}`);
});

if (process.env.WARP_BRIDGE_EXIT_ON_STDIN_CLOSE === "1") {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
  process.stdin.resume();
}
