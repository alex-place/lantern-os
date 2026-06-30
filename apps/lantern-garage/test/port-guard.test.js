// #1549 — port-bind guard: probe, owner-finder, and actionable EADDRINUSE help.
//
// Run: node apps/lantern-garage/test/port-guard.test.js
const assert = require("assert");
const net = require("net");
const pg = require("../lib/port-guard");

let failures = 0;
async function check(name, fn) {
  try { await fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

async function run() {
  // findOwnerCommand / killCommand — platform-specific
  await check("findOwnerCommand: Windows uses Get-NetTCPConnection, POSIX uses lsof", () => {
    assert.ok(/Get-NetTCPConnection -LocalPort 4177/.test(pg.findOwnerCommand(4177, "win32")));
    assert.ok(/lsof .*4177/.test(pg.findOwnerCommand(4177, "linux")));
  });
  await check("killCommand per platform", () => {
    assert.strictEqual(pg.killCommand(123, "win32"), "Stop-Process -Id 123 -Force");
    assert.strictEqual(pg.killCommand(123, "linux"), "kill 123");
  });

  // eaddrinuseHelp — names the owner + the free command
  await check("eaddrinuseHelp names the owning PID and a kill command", () => {
    const msg = pg.eaddrinuseHelp(4177, { pid: 999, name: "node.exe" }, "win32");
    assert.ok(/Port 4177 is already in use/.test(msg));
    assert.ok(/node\.exe PID 999/.test(msg));
    assert.ok(/Stop-Process -Id 999 -Force/.test(msg));
    assert.ok(/another port/.test(msg));
  });
  await check("eaddrinuseHelp without a known owner falls back to the find command", () => {
    const msg = pg.eaddrinuseHelp(8771, null, "linux");
    assert.ok(/lsof .*8771/.test(msg));        // tells you how to find the owner
    assert.ok(!/PID/.test(msg.split("\n")[0])); // no fabricated PID
  });

  // probePort — behavioral, deterministic
  await check("probePort: free port → false", async () => {
    // pick a high port nothing should hold
    assert.strictEqual(await pg.probePort(59321, "127.0.0.1", 300), false);
  });
  await check("probePort: a port we are listening on → true", async () => {
    const srv = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const port = srv.address().port;
    try {
      assert.strictEqual(await pg.probePort(port, "127.0.0.1", 500), true);
    } finally { srv.close(); }
  });

  // findPortOwner — live: it finds the PID of a port we hold, and null for a free one
  await check("findPortOwner: returns this process's PID for a port we hold", async () => {
    const srv = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const port = srv.address().port;
    try {
      const owner = await pg.findPortOwner(port);
      assert.ok(owner && owner.pid === process.pid, `expected owner.pid ${process.pid}, got ${owner && owner.pid}`);
    } finally { srv.close(); }
  });
  await check("findPortOwner: null for a free port", async () => {
    assert.strictEqual(await pg.findPortOwner(59322), null);
  });

  if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
  process.stdout.write("\nall port-guard checks passed\n");
}

run();
