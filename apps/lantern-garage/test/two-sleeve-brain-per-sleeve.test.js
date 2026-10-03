'use strict';
/**
 * two-sleeve-brain-per-sleeve.test.js — every engine sleeve gets its OWN brain instance (2026-10-03).
 *
 * require() caches by path, so before runner-support.loadSleeveBrain every sleeve after the first on the same app tree
 * (S, the noise leg M, the close-IBS sleeve C all run ".") shared the first sleeve's auto-trader instance: its cooldowns,
 * entry/exit clocks, cadence decision and stop registry, and the journal and state files it captured at load. Pinned here:
 *   - on a fake tree, three loads give three instances, each with the journal/state paths of its own sleeve and its own
 *     module-level map; a plain second require would have handed back the first instance (the bug);
 *   - on the REAL stable brain of this tree, two sleeves get distinct instances with distinct STATE_FILE paths and distinct
 *     breakeven/stop registries.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSleeveBrain } = require('../lib/two-sleeve/runner-support');

test('three sleeves on one fake tree get three brains, each with its own journal, state and module state', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-tree-'));
  fs.mkdirSync(path.join(app, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(app, 'lib', 'auto-trader.js'), [
    "'use strict';",
    "const log = process.env.TRADER_TRADES_LOG, state = process.env.TRADER_STATE_FILE;",
    "const cooldowns = new Map();",
    "module.exports = { log, state, cooldowns };",
  ].join('\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-dir-'));
  const plainFirst = require(path.join(app, 'lib', 'auto-trader'));
  const plainSecond = require(path.join(app, 'lib', 'auto-trader'));
  assert.strictEqual(plainFirst, plainSecond, 'a plain require hands every later sleeve the first instance — the bug');
  delete require.cache[require.resolve(path.join(app, 'lib', 'auto-trader'))];
  const loaded = new Set();
  const S = loadSleeveBrain({ app, id: 'S', dir, loaded });
  const M = loadSleeveBrain({ app, id: 'M', dir, loaded });
  const C = loadSleeveBrain({ app, id: 'C', dir, loaded });
  assert.notStrictEqual(S, M); assert.notStrictEqual(M, C); assert.notStrictEqual(S, C);
  assert.equal(S.log, path.join(dir, 'S.autopilot-trades.jsonl'));
  assert.equal(M.log, path.join(dir, 'M.autopilot-trades.jsonl'));
  assert.equal(C.state, path.join(dir, 'C.state.json'));
  S.cooldowns.set('SPY', Date.now());
  assert.equal(C.cooldowns.has('SPY'), false, "S's cooldown is not C's");
});

test('the real stable brain: two sleeves on this tree get distinct instances, state files and stop registries', () => {
  const app = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-real-'));
  const loaded = new Set();
  const S = loadSleeveBrain({ app, id: 'S', dir, loaded });
  const C = loadSleeveBrain({ app, id: 'C', dir, loaded });
  assert.notStrictEqual(S, C);
  assert.equal(S.STATE_FILE, path.join(dir, 'S.state.json'));
  assert.equal(C.STATE_FILE, path.join(dir, 'C.state.json'));
  assert.notStrictEqual(S._beStopAt, C._beStopAt, 'each brain keeps its own breakeven/stop registry');
  S._beStopAt.set('SPY', 500);
  assert.equal(C._beStopAt.has('SPY'), false);
});
