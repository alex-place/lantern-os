#!/usr/bin/env node
// unisona.ai desktop launcher — Phase 1 (thin, dependency-free)
//
// Boots the ONE unmodified Convergence Core server (apps/lantern-garage/server.js)
// in clean chat-only mode on a free loopback port, waits until it answers, then
// opens the user's default browser at it. Ctrl+C (or the tray, later) stops it and
// tears down the whole child-process tree.
//
// Design contract: see docs/adr/0014-unisona-desktop-launcher.md.
//   G1 — One Core: we spawn server.js UNMODIFIED. No forked server here.
//   G5 — No Electron: we reuse the user's own browser; no bundled Chromium.
//   Loopback only: we set LANTERN_GARAGE_HOST=127.0.0.1 and never set PORT
//     (setting PORT flips server.js to bind 0.0.0.0 — public — see server.js:79).
//
// This file uses ONLY Node builtins so it can be wrapped by pkg / Node SEA later
// without pulling a dependency tree.

"use strict";

const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");

// Per-boot loopback token (ADR-0014 G4). Passed to the Core as UNISONA_LOCAL_TOKEN
// and to the browser via the launch URL (?__lt=…); the Core turns that into a
// SameSite=Strict cookie so the local UI authenticates automatically while a
// DNS-rebind/CSRF page (same loopback IP, no token) cannot. Fresh every launch.
const localToken = crypto.randomBytes(24).toString("hex");

// ── Configuration ───────────────────────────────────────────────────────────
// serverDir defaults to the garage app that ships beside this launcher
// (apps/lantern-garage). UNISONA_SERVER_DIR overrides it — used both by the
// packaged app (points at the unpacked resources) and for dev-testing this
// launcher from a worktree against a checkout that has node_modules installed.
const args = parseArgs(process.argv.slice(2));
const serverDir = path.resolve(
  process.env.UNISONA_SERVER_DIR || path.join(__dirname, "..")
);
const serverEntry = path.join(serverDir, "server.js");
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
  // G4: the browser must carry the per-boot token on first load so the Core can hand
  // back the SameSite cookie that authenticates every LATER request (fetch, EventSource,
  // assets). Without this, UNISONA_LOCAL_TOKEN would lock the local UI out of all
  // operator actions. The token rotates each launch; the durable carrier is the cookie.
  const openUrl = `${url}${url.includes("?") ? "&" : "?"}__lt=${localToken}`;
  if (openBrowser) {
    openInBrowser(openUrl);
    console.log("[unisona] Opened your default browser.");
  } else {
    console.log(`[unisona] Open this URL in your browser (auto-open disabled):\n    ${openUrl}`);
  }
  console.log("[unisona] Press Ctrl+C to stop.\n");
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
  });

  const proc = spawn(process.execPath, [serverEntry], {
    cwd: serverDir,
    env,
    stdio: "inherit", // surface the Core's own logs to the console
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

// ── Open default browser (cross-platform, no deps) ──────────────────────────────
function openInBrowser(url) {
  try {
    if (process.platform === "win32") {
      // `start` is a cmd builtin; the empty "" is the window title (required when
      // the URL is quoted). detached so closing the launcher never kills it.
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch (err) {
    console.warn(`[unisona] Could not auto-open a browser: ${err.message}`);
  }
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
