#!/usr/bin/env node
// unisona.ai desktop launcher — Phase 1 (thin, dependency-free)
//
// Boots the ONE unmodified Convergence Core server (apps/lantern-garage/server.js)
// in clean chat-only mode on a free loopback port, waits until it answers, then
// opens the UI as a STANDALONE APP WINDOW (Edge/Chrome "--app" mode — chromeless,
// own taskbar icon), not a browser tab. Closing that window stops the Core and tears
// down the whole child-process tree.
//
// Design contract: see docs/adr/0014-unisona-desktop-launcher.md.
//   G1 — One Core: we spawn server.js UNMODIFIED. No forked server here.
//   G5 — No Electron: we reuse the WebView2/Edge engine already on Windows via app
//     mode; no bundled Chromium. (Falls back to the default browser if neither Edge
//     nor Chrome is found.)
//   Loopback only: we set LANTERN_GARAGE_HOST=127.0.0.1 and never set PORT
//     (setting PORT flips server.js to bind 0.0.0.0 — public — see server.js:79).
//   Windowless: the shipped exe is GUI-subsystem (no console window), so logs go to
//     a file, not stdout — see the log redirect below.
//
// This file uses ONLY Node builtins so it can be wrapped by Node SEA without pulling
// a dependency tree.

"use strict";

const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

// Per-boot loopback token (ADR-0014 G4). Passed to the Core as UNISONA_LOCAL_TOKEN
// and to the browser via the launch URL (?__lt=…); the Core turns that into a
// SameSite=Strict cookie so the local UI authenticates automatically while a
// DNS-rebind/CSRF page (same loopback IP, no token) cannot. Fresh every launch.
const localToken = crypto.randomBytes(24).toString("hex");

// ── SEA detection + Core location (needed by BOTH the launcher and core mode) ──
// Are we running as a packaged Single Executable Application (Node SEA)? If so,
// process.execPath is unisona.exe — a SEA whose EMBEDDED entry is THIS file, not a
// generic node — and __dirname is not a real on-disk path.
let isSea = false;
try { isSea = require("node:sea").isSea(); } catch { /* Node <20 / no node:sea */ }

// serverDir holds the Core (its server.js). Dev: the app dir beside this launcher.
// Packaged: the app tree the installer lays beside the exe (resources/app), or an
// explicit UNISONA_SERVER_DIR. The __dirname branch is never evaluated under SEA.
const defaultServerDir = isSea
  ? path.join(path.dirname(process.execPath), "resources", "app")
  : path.join(__dirname, "..");
const serverDir = path.resolve(process.env.UNISONA_SERVER_DIR || defaultServerDir);
const serverEntry = path.join(serverDir, "server.js");

// ── Core mode (single-exe trick) ──────────────────────────────────────────────
// A SEA can only ever run its OWN embedded entry (this file), so to boot the Core
// from the SAME single unisona.exe — with NO second bundled node runtime — the
// launcher re-execs itself with UNISONA_CORE=1, and here we hand off to the on-disk
// server.js. createRequire loads it as a normal CJS module: its real __dirname and
// node_modules resolve against serverDir, so the Core runs exactly as `node
// server.js` would. (In dev the child is plain `node server.js` and never gets here.)
if (process.env.UNISONA_CORE === "1") {
  require("node:module").createRequire(serverEntry)(serverEntry);
  return; // CommonJS top-level return — must NOT fall through into the launcher
}

// ── Windowless logging ────────────────────────────────────────────────────────
// The shipped exe is GUI-subsystem (no console — see build-desktop-exe.mjs), so
// stdout/stderr have nowhere to go and writing to them can throw. When packaged,
// redirect all launcher logs — and the Core child's output — to a rolling file.
const logDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "unisona", "logs");
let logFd = null;
if (isSea) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logFd = fs.openSync(path.join(logDir, "desktop.log"), "a");
    const write = (...a) => { try { fs.writeSync(logFd, a.join(" ") + "\n"); } catch { /* best-effort */ } };
    console.log = write;
    console.error = write;
    console.warn = write;
  } catch { /* logging is best-effort; never block boot on it */ }
}

// The dedicated Edge/Chrome profile our app window uses. Isolating it (a) keeps the
// window out of the user's normal browser session, and (b) gives us a stable marker
// to detect when the window is really closed (see watchAppWindow).
const appProfileDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "unisona", "app-profile");

// ── Configuration ───────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const host = "127.0.0.1"; // loopback only — never exposed
const landingPage = args.page || process.env.UNISONA_LANDING_PAGE || "/";
const openBrowser = !args["no-open"] && process.env.UNISONA_NO_OPEN !== "1";
const readyTimeoutMs = Number(process.env.UNISONA_READY_TIMEOUT_MS || 45_000);

let child = null;
let shuttingDown = false;

// ── Main ─────────────────────────────────────────────────────────────────────
(async function main() {
  banner();

  if (!fs.existsSync(serverEntry)) {
    fail(
      `Cannot find the Core server at:\n    ${serverEntry}\n` +
        `Set UNISONA_SERVER_DIR to the folder that contains server.js.`
    );
    return;
  }

  const port = args.port ? Number(args.port) : await findFreePort(host);
  // Clean display URL (token is added only to the URL we actually open, below).
  const url = `http://${host}:${port}${landingPage}`;

  console.log(`[unisona] Core server:  ${serverEntry}`);
  console.log(`[unisona] Binding:      ${host}:${port} (loopback only)`);
  console.log(`[unisona] Mode:         chat-only, hardened (AppData state · vault keys · loopback token)`);
  console.log("");

  child = spawnServer(port);

  // If the server dies during boot (e.g. missing node_modules), say so plainly
  // instead of hanging on the readiness poll.
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    fail(
      `The Core server exited before it was ready ` +
        `(code=${code}, signal=${signal || "none"}).\n` +
        `If this is a fresh checkout, install deps first:\n` +
        `    npm install --prefix "${serverDir}"`
    );
  });

  const ready = await waitForServer(host, port, readyTimeoutMs);
  if (!ready) {
    fail(`Server did not answer on ${host}:${port} within ${readyTimeoutMs} ms.`);
    return;
  }

  console.log(`[unisona] Ready → ${url}`);
  // G4: the app window must carry the per-boot token on first load so the Core can
  // hand back the SameSite cookie that authenticates every LATER request (fetch,
  // EventSource, assets). Without this, UNISONA_LOCAL_TOKEN would lock the UI out of
  // all operator actions. The token rotates each launch; the durable carrier is the cookie.
  const openUrl = `${url}${url.includes("?") ? "&" : "?"}__lt=${localToken}`;
  if (openBrowser) {
    const appProc = openAppWindow(openUrl);
    if (appProc) {
      // Do NOT tie shutdown to the process we spawned: when Edge/Chrome is already
      // running, it hands our window to the existing browser and the spawned process
      // exits IMMEDIATELY — which would look like "window closed" and kill the Core
      // out from under a live window (the ERR_CONNECTION_REFUSED bug). Instead, watch
      // for any browser process still using our dedicated profile; the app quits only
      // when the real window is gone. No console to Ctrl+C, no orphaned headless server.
      watchAppWindow(appProfileDir);
      console.log("[unisona] Opened the app window.");
    } else {
      console.log("[unisona] Opened your default browser (no app-mode browser found).");
    }
  } else {
    console.log(`[unisona] Open this URL in your browser (auto-open disabled):\n    ${openUrl}`);
  }
})().catch((err) => fail(err && err.stack ? err.stack : String(err)));

// ── Server process ────────────────────────────────────────────────────────────
function spawnServer(port) {
  // Build a clean, chat-only environment. Gates verified against server.js:
  //   Chat-only   skip market collectors + convergence loops (LANTERN_CHAT_ONLY=1)
  //   MCP server  ON unless LANTERN_MCP_SERVER=false        (server.js)
  //   MCP OAuth   ON unless LANTERN_MCP_OAUTH=false          (server.js)
  //   Trading     microservice/AI-trader off (LANTERN_DISABLE_TRADING=1);
  //               in-process autoscan off (TRADER_AUTOSCAN=0)
  //   Tunnel      ON unless LANTERN_CLOUDFLARE_TUNNEL=false  (server.js)
  //   Discord     spawns iff DISCORD_BOT_TOKEN + LANTERN_DISCORD_GUILD_ID are
  //               present — so we strip them from the child env, not pass a flag.
  //   crypto-observer / pr-watcher already default OFF.
  const env = { ...process.env };
  delete env.PORT; // ensure loopback bind (server.js keys host off PORT)
  delete env.DISCORD_BOT_TOKEN; // don't spawn the Discord bot from the desktop app
  delete env.LANTERN_DISCORD_GUILD_ID;
  Object.assign(env, {
    LANTERN_GARAGE_PORT: String(port),
    LANTERN_GARAGE_HOST: host,
    LANTERN_CHAT_ONLY: "1",
    LANTERN_MCP_SERVER: "false",
    LANTERN_MCP_OAUTH: "false",
    LANTERN_DISABLE_TRADING: "1",
    TRADER_AUTOSCAN: "0",
    LANTERN_CLOUDFLARE_TUNNEL: "false",
    // Desktop hardening (ADR-0014 Phase-0): relocate writable state to
    // %APPDATA%\unisona (G2), read keys from the DPAPI vault (G3), and require the
    // per-boot loopback token so loopback ≠ admin (G4). All three are now wired.
    UNISONA_DESKTOP: "1",
    UNISONA_LOCAL_TOKEN: localToken,
    // Tell the Core child where the app tree is (it re-derives serverEntry here).
    UNISONA_SERVER_DIR: serverDir,
    // The bundled app declares a `file:../..` self-dep (lantern-os) that isn't
    // symlinked in the packaged tree, so server.js's dependency preflight would
    // false-positive on it and exit. Skip the preflight in the packaged app — the
    // installer ships a complete node_modules, so the check is redundant here.
    SKIP_DEP_PREFLIGHT: "1",
  });

  // The Core child. Packaged (SEA): re-enter THIS same unisona.exe with
  // UNISONA_CORE=1 — the embedded entry then hands off to server.js, so ONE runtime
  // serves both roles (no second bundled node). Dev: process.execPath IS node, so
  // run server.js directly.
  const [coreCmd, coreArgs] = isSea
    ? [process.execPath, []]
    : [process.execPath, [serverEntry]];
  if (isSea) env.UNISONA_CORE = "1";

  // Windowless (packaged): no console to inherit — send the Core's output to the log
  // file. Dev: inherit the terminal so `node launcher.js` shows the Core's logs.
  const coreStdio = isSea ? ["ignore", logFd || "ignore", logFd || "ignore"] : "inherit";
  const proc = spawn(coreCmd, coreArgs, {
    cwd: serverDir,
    env,
    stdio: coreStdio,
  });
  proc.on("error", (err) => fail(`Failed to start the Core server: ${err.message}`));
  return proc;
}

// ── Readiness poll ─────────────────────────────────────────────────────────────
// Any HTTP response (even a redirect or 404) proves the listener is up.
function waitForServer(h, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (shuttingDown) return resolve(false);
      const req = http.get({ host: h, port, path: "/", timeout: 2000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 400);
    };
    tick();
  });
}

// ── Free-port discovery ────────────────────────────────────────────────────────
function findFreePort(h) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, h, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ── Open the app window (chromeless Edge/Chrome "--app" mode) ────────────────────
// Returns the spawned browser process (truthy) if app mode launched, or null if we
// fell back to the plain default browser. main() watches the profile (not this
// process) for the real window-close, so the return value is only a launched/fell-back
// signal — the spawned process itself often exits right away when Edge is already up.
function openAppWindow(url) {
  const browser = process.platform === "win32" ? findWindowsBrowser() : findUnixBrowser();
  if (browser) {
    const args = [
      `--app=${url}`,
      `--user-data-dir=${appProfileDir}`,
      "--window-size=1280,860",
      "--no-first-run",
      "--no-default-browser-check",
    ];
    try {
      return spawn(browser, args, { stdio: "ignore", windowsHide: true });
    } catch (err) {
      console.warn(`[unisona] app-mode launch failed (${err.message}); falling back to default browser.`);
    }
  }
  // Fallback: the platform default browser (a normal tab — no window lifecycle handle).
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    else spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  } catch (err) {
    console.warn(`[unisona] Could not auto-open a browser: ${err.message}`);
  }
  return null;
}

// Locate an Edge (preferred — WebView2 engine, always on Win10/11) or Chrome exe.
function findWindowsBrowser() {
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  const candidates = [
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    local && path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  return candidates.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || null;
}

function findUnixBrowser() {
  const names = process.platform === "darwin"
    ? ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
       "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return names.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || null;
}

// ── Watch the app window (browser-lifecycle-proof) ──────────────────────────────
// A browser launched with `--user-data-dir=<profile>` keeps at least one process
// alive (with that profile in its command line) for as long as the window is open —
// regardless of whether OUR spawned process daemonized. So we poll for any browser
// process using our profile: once none remain (after the window has actually shown),
// the user closed it → shut down the Core. Windows-only; elsewhere we just stay up.
function watchAppWindow(profileDir) {
  if (process.platform !== "win32") return; // no reliable poll off Windows — leave the Core up
  let sawOpen = false;
  let misses = 0;
  const timer = setInterval(() => {
    if (shuttingDown) { clearInterval(timer); return; }
    countBrowsersUsingProfile(profileDir, (n) => {
      if (n < 0) return;                 // couldn't check this tick — try again
      if (n > 0) { sawOpen = true; misses = 0; return; }
      if (!sawOpen) return;              // window hasn't appeared yet — keep waiting
      if (++misses >= 2) { clearInterval(timer); shutdown("app window closed"); }
    });
  }, 3000);
}

// Count msedge/chrome processes whose command line references our profile dir.
// Uses PowerShell CIM (windowsHide so no flashing console). n<0 = check failed.
function countBrowsersUsingProfile(profileDir, cb) {
  const filter = "name='msedge.exe' or name='chrome.exe' or name='msedgewebview2.exe'";
  const cmd =
    `@(Get-CimInstance Win32_Process -Filter "${filter}" | ` +
    `Where-Object { $_.CommandLine -like '*${profileDir}*' }).Count`;
  let out = "";
  try {
    const ps = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    ps.stdout.on("data", (d) => { out += d; });
    ps.on("error", () => cb(-1));
    ps.on("close", () => cb(Number.parseInt(String(out).trim(), 10) || 0));
  } catch { cb(-1); }
}

// ── Graceful shutdown (kills the whole child tree) ──────────────────────────────
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[unisona] Shutting down${reason ? ` (${reason})` : ""}…`);
  if (child && child.pid && !child.killed) {
    if (process.platform === "win32") {
      // /T kills the process tree (server.js may spawn collectors/children);
      // /F forces it. Fire-and-forget, then exit.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  setTimeout(() => process.exit(0), 400);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ── Helpers ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-open") out["no-open"] = true;
    else if (a === "--port") out.port = argv[++i];
    else if (a === "--page") out.page = argv[++i];
    else if (a.startsWith("--port=")) out.port = a.slice(7);
    else if (a.startsWith("--page=")) out.page = a.slice(7);
  }
  return out;
}

function banner() {
  console.log("");
  console.log("  ┌───────────────────────────────────────┐");
  console.log("  │   unisona.ai — local reasoning cockpit │");
  console.log("  │   your memory. your keys. your machine.│");
  console.log("  └───────────────────────────────────────┘");
  console.log("");
}

function fail(msg) {
  console.error(`\n[unisona] ${msg}\n`);
  shutdown("startup error");
  setTimeout(() => process.exit(1), 500);
}
