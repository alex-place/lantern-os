"use strict";
/**
 * Port-bind guard / diagnostics (#1549).
 *
 * Long-lived servers (lantern-garage 4177, MCP 8771, trading 5050…) crash with a raw
 * EADDRINUSE and no port fallback when a stale instance still holds the port — and the
 * old message didn't say WHO holds it, so freeing it was guesswork. This provides a
 * reusable bind-probe (defer to an existing healthy instance — a singleton guard) and an
 * actionable EADDRINUSE help string that names the owning PID and the exact command to
 * free it.
 *
 * probePort / findOwnerCommand / eaddrinuseHelp are pure(-ish) and testable; findPortOwner
 * shells out (netstat / lsof) and is verified live.
 */
const net = require("net");
const { execFile } = require("child_process");

// Is something already listening on host:port? Resolves true (in use) / false (free).
// A connect that succeeds → in use; ECONNREFUSED / timeout → free.
function probePort(port, host = "127.0.0.1", timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; try { sock.destroy(); } catch { /* noop */ } resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

// The OS command to list who is holding a port.
function findOwnerCommand(port, platform = process.platform) {
  return platform === "win32"
    ? `Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object OwningProcess`
    : `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
}

// The OS command to kill a PID.
function killCommand(pid, platform = process.platform) {
  return platform === "win32" ? `Stop-Process -Id ${pid} -Force` : `kill ${pid}`;
}

// Actionable EADDRINUSE guidance: names the owner (if known) + how to free the port or use
// another. `owner` is { pid, name } or null.
function eaddrinuseHelp(port, owner, platform = process.platform) {
  const who = owner && owner.pid
    ? ` It is held by ${owner.name ? owner.name + " " : ""}PID ${owner.pid}.`
    : "";
  const free = owner && owner.pid ? killCommand(owner.pid, platform) : findOwnerCommand(port, platform);
  return [
    `Port ${port} is already in use.${who}`,
    `  - If that is a healthy Lantern instance, just open http://127.0.0.1:${port}`,
    `  - To free the port: ${free}`,
    `  - Or start on another port: set LANTERN_GARAGE_PORT and restart`,
  ].join("\n");
}

// Find the PID listening on `port` (best-effort, cross-platform). Resolves { pid, name } or
// null. Never throws.
function findPortOwner(port, platform = process.platform) {
  return new Promise((resolve) => {
    if (platform === "win32") {
      execFile("netstat", ["-ano", "-p", "tcp"], { timeout: 4000, windowsHide: true }, (err, out) => {
        if (err || !out) return resolve(null);
        const line = out.split("\n").find((l) => /LISTENING/i.test(l) && new RegExp(`[:.]${port}\\b`).test(l));
        const pid = line && (line.trim().match(/(\d+)\s*$/) || [])[1];
        if (!pid) return resolve(null);
        // Best-effort process name.
        execFile("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeout: 4000, windowsHide: true }, (e2, o2) => {
          const name = (!e2 && o2 && (o2.match(/^"([^"]+)"/) || [])[1]) || null;
          resolve({ pid: parseInt(pid, 10), name });
        });
      });
    } else {
      execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 4000 }, (err, out) => {
        const pid = !err && out && out.trim().split("\n")[0];
        resolve(pid ? { pid: parseInt(pid, 10), name: null } : null);
      });
    }
  });
}

module.exports = { probePort, findOwnerCommand, killCommand, eaddrinuseHelp, findPortOwner };
