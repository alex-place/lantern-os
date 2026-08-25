'use strict';
/**
 * eaddrinuse-exit.test.js — a server that cannot bind must DIE, not go headless.
 *
 * The defect (found 2026-08-25 by a pre-open wellness check): server.js requires
 * routes/trading BEFORE server.listen(), and that module schedules the autoscan
 * and fast-exit loops at module load. So when listen() failed with EADDRINUSE the
 * handler's `process.exitCode = 1` never took effect — the event loop was held
 * open by the scan timers forever — and the process stayed alive with no HTTP
 * listener while still scanning and placing orders against the same broker
 * account as the instance that owned the port. Two such strays were found in two
 * days (8/24 pid 26188, 8/25 pid 20776), each born minutes after a crash-restart
 * while the old process still held the port.
 *
 * This test boots a real server on a taken port and asserts the process exits
 * non-zero on its own. It is deliberately an integration test: the bug was that
 * the process STAYED ALIVE, which only a real spawn can prove.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

test('a server whose port is already taken exits instead of running headless', async () => {
  const port = await freePort();
  // hold the port so the server cannot bind
  const squatter = net.createServer();
  await new Promise((res, rej) => { squatter.once('error', rej); squatter.listen(port, '127.0.0.1', res); });

  try {
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: String(port),
        LANTERN_GARAGE_HOST: '127.0.0.1',
        TRADER_AUTOSCAN: '1',        // the loops that used to hold the event loop open
        TRADER_AUTO_EXECUTE: '0',    // never place an order from a test
        TRADER_MANAGE_EXITS: '0',
        // setting PORT makes the boot treat this as a non-loopback bind, which trips the
        // SESSION_SECRET guard before listen() is ever reached; a throwaway value gets the
        // boot far enough to attempt the bind, which is what this test is about.
        SESSION_SECRET: 'eaddrinuse-test-only-not-a-real-secret',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), 25000);
      child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });

    if (exited.timedOut) {
      child.kill('SIGKILL');
      assert.fail(`the server did NOT exit on EADDRINUSE — it is running headless (the leak). Output:\n${out.slice(-800)}`);
    }
    assert.notStrictEqual(exited.code, 0, `expected a non-zero exit, got ${exited.code}`);
    assert.ok(/already in use|EADDRINUSE|in use/i.test(out), `the reason should be named in the log. Output:\n${out.slice(-500)}`);
  } finally {
    await new Promise((res) => squatter.close(res));
  }
});
