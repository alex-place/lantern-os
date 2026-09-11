'use strict';
/**
 * test/split-supervisor.test.js — #3523.
 *
 * With LANTERN_SPLIT=1 the website and the trader run as two processes under one
 * supervisor: web on the public port, trader on loopback. A child that dies comes back
 * without touching the other, and a redeploy's SIGTERM stops both. Fake child processes
 * stand in for server.js, so nothing real boots.
 * Run: node --test apps/lantern-garage/test/split-supervisor.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const sup = require('../lib/split-supervisor');

function fakeSpawn() {
  const procs = [];
  const spawnImpl = (cmd, args, opts) => {
    const p = new EventEmitter();
    Object.assign(p, { pid: 1000 + procs.length, exitCode: null, signalCode: null, env: opts.env, args });
    p.kill = (sig) => { p.signalCode = sig; setImmediate(() => p.emit('exit', null, sig)); };
    p.die = (code) => { p.exitCode = code; p.emit('exit', code, null); };
    procs.push(p);
    return p;
  };
  return { procs, spawnImpl };
}

test('two children: web on the public PORT, trader on loopback, neither splits again', () => {
  const [web, trader] = sup.childSpecs({ PORT: '8080', LANTERN_SPLIT: '1', SESSION_SECRET: 's' });
  assert.deepStrictEqual([web.name, web.env.LANTERN_ROLE, web.env.PORT], ['web', 'web', '8080']);
  assert.strictEqual(web.env.LANTERN_TRADER_URL, 'http://127.0.0.1:4190');
  assert.deepStrictEqual([trader.name, trader.env.LANTERN_ROLE], ['trader', 'trader']);
  assert.deepStrictEqual([trader.env.LANTERN_GARAGE_PORT, trader.env.LANTERN_GARAGE_HOST], ['4190', '127.0.0.1']);
  assert.strictEqual(web.env.LANTERN_SPLIT, undefined);
  assert.strictEqual(trader.env.LANTERN_SPLIT, undefined);
  assert.strictEqual(trader.env.SESSION_SECRET, 's', 'both children get the same environment otherwise');
  assert.strictEqual(sup.childSpecs({ LANTERN_TRADER_PORT: '5001' })[1].env.LANTERN_GARAGE_PORT, '5001');
});

test('both children run server.js', () => {
  const { procs, spawnImpl } = fakeSpawn();
  const s = sup.run({ env: {}, spawnImpl, log: () => {}, exit: () => {}, signals: false });
  assert.strictEqual(procs.length, 2);
  for (const p of procs) assert.strictEqual(p.args[0], sup.SERVER);
  s.shutdown('SIGTERM');
});

test('restart backoff: 1s, 2s, 4s ... capped at 30s', () => {
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 9].map(sup.backoffMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test('a child that dies is restarted, and the other is never touched', async () => {
  const { procs, spawnImpl } = fakeSpawn();
  const logs = [];
  const s = sup.run({ env: { PORT: '8080' }, spawnImpl, log: (l) => logs.push(l), exit: () => {}, signals: false });
  procs[1].die(1);                                   // the trader crashes
  assert.match(logs.join('\n'), /trader exited \(1\); restarting in 1s/);
  await new Promise((r) => setTimeout(r, 1150));
  assert.strictEqual(procs.length, 3, 'the trader came back');
  assert.strictEqual(procs[2].env.LANTERN_ROLE, 'trader');
  assert.strictEqual(procs[0].exitCode, null, 'the web process kept running');
  assert.strictEqual(procs[0].signalCode, null);
  s.shutdown('SIGTERM');
});

test("a redeploy's SIGTERM stops both children, restarts nothing, and exits", async () => {
  const { procs, spawnImpl } = fakeSpawn();
  let exited = null;
  const s = sup.run({ env: {}, spawnImpl, log: () => {}, exit: (c) => { exited = c; }, signals: false });
  s.shutdown('SIGTERM');
  await new Promise((r) => setImmediate(() => setImmediate(r)));
  assert.deepStrictEqual(procs.map((p) => p.signalCode), ['SIGTERM', 'SIGTERM']);
  assert.strictEqual(exited, 0);
  assert.strictEqual(procs.length, 2, 'nothing restarted during shutdown');
});
