/**
 * Lantern Garage Watchdog — pure Node.js process supervisor.
 * Restarts the server on crash, exit, or port conflict. No external deps.
 *
 * Usage: node watchdog.js
 *        (replaces: node server.js)
 */
const { spawn } = require("child_process");
const path = require("path");

const SERVER_SCRIPT = path.join(__dirname, "server.js");
const RESTART_DELAY_MS = 3000;
const MAX_RESTARTS = 10;
const MIN_UPTIME_MS = 5000;

let child = null;
let startTime = 0;
let restartCount = 0;
let stopping = false;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[watchdog ${ts}] ${msg}`);
}

function startServer() {
  if (stopping) return;

  startTime = Date.now();
  child = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: __dirname,
    stdio: "inherit",
    env: process.env
  });

  log(`Server started (pid ${child.pid})`);

  child.on("exit", (code, signal) => {
    const uptime = Date.now() - startTime;
    log(`Server exited code=${code} signal=${signal} uptime=${uptime}ms`);

    if (stopping) return;

    if (uptime < MIN_UPTIME_MS) {
      restartCount++;
      if (restartCount > MAX_RESTARTS) {
        log(`Too many rapid restarts (${restartCount}). Giving up.`);
        process.exit(1);
      }
      log(`Rapid restart detected (${restartCount}/${MAX_RESTARTS}). Backing off...`);
    } else {
      restartCount = 0;
    }

    log(`Restarting in ${RESTART_DELAY_MS}ms...`);
    setTimeout(startServer, RESTART_DELAY_MS);
  });

  child.on("error", (err) => {
    log(`Server spawn error: ${err.message}`);
    if (!stopping) {
      setTimeout(startServer, RESTART_DELAY_MS);
    }
  });
}

function stop() {
  stopping = true;
  log("Stopping server...");
  if (child && !child.killed) {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child && !child.killed) {
        child.kill("SIGKILL");
      }
    }, 5000);
  }
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", stop);

startServer();
