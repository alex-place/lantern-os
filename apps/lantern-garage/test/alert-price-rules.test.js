// #3352 — price alert rules: the thirteen operators TradingView offers.
//
// Contract: validation is data-driven off PRICE_OPS (channel ops need two values and
// order them, percent ops are bounded); the crossing/moving family is judged against
// the price the rule LAST saw, which the server owns; and a rule with no previous
// observation waits a scan rather than firing on first sight.
//
// Run: node apps/lantern-garage/test/alert-price-rules.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-price-'));
process.env.ALERTS_DIR = TMP;

const store = require('../lib/alert-store');
const { matchRule, evaluateScan } = require('../lib/alert-engine');

let failures = 0;
const check = (name, fn) => {
  try { fn(); process.stdout.write('  ok  - ' + name + '\n'); }
  catch (e) { failures++; process.stderr.write('  FAIL- ' + name + '\n      ' + e.message + '\n'); }
};

const rule = (op, value, value2, lastPrice) => {
  const r = store.normalizeRule({ symbol: 'SPY', type: 'price', op, value, value2 });
  assert.ok(r.ok, 'rule should normalize: ' + JSON.stringify(r));
  return Object.assign(r.rule, { lastPrice: lastPrice === undefined ? null : lastPrice });
};
const sig = (price) => ({ symbol: 'SPY', entry_price: price });

check('validation: every operator is accepted, junk is not', () => {
  for (const op of Object.keys(store.PRICE_OPS)) {
    const needs2 = store.PRICE_OPS[op].needs === 2;
    const r = store.normalizeRule({ symbol: 'SPY', type: 'price', op, value: 10, value2: needs2 ? 20 : undefined });
    assert.ok(r.ok, op + ' should be valid');
  }
  assert.strictEqual(store.normalizeRule({ symbol: 'SPY', type: 'price', op: 'nope', value: 1 }).error, 'invalid_op');
  assert.strictEqual(store.normalizeRule({ symbol: 'SPY', type: 'price', op: 'greater' }).error, 'invalid_value');
  assert.strictEqual(store.normalizeRule({ symbol: 'SPY', type: 'price', op: 'inside_channel', value: 5 }).error, 'invalid_value2');
  assert.strictEqual(store.normalizeRule({ symbol: 'SPY', type: 'price', op: 'inside_channel', value: 5, value2: 5 }).error, 'empty_channel');
  assert.strictEqual(store.normalizeRule({ symbol: 'SPY', type: 'price', op: 'moving_up_pct', value: 0 }).error, 'invalid_percent');
  assert.strictEqual(store.normalizeRule({ symbol: 'SPY', type: 'price', op: 'moving_up', value: -1 }).error, 'invalid_move');
});

check('channel bounds are ordered however they were typed', () => {
  const r = store.normalizeRule({ symbol: 'SPY', type: 'price', op: 'inside_channel', value: 90, value2: 70 }).rule;
  assert.strictEqual(r.value, 70);
  assert.strictEqual(r.value2, 90);
});

check('level ops: greater than / less than', () => {
  assert.ok(matchRule(rule('greater', 100), sig(101)));
  assert.strictEqual(matchRule(rule('greater', 100), sig(100)), null, 'equal is not greater');
  assert.ok(matchRule(rule('less', 100), sig(99)));
  assert.strictEqual(matchRule(rule('less', 100), sig(100)), null);
});

check('crossing needs a previous price and both directions count', () => {
  assert.strictEqual(matchRule(rule('crossing', 100, undefined, null), sig(101)), null,
    'no previous observation cannot have crossed');
  assert.ok(matchRule(rule('crossing', 100, undefined, 99), sig(101)), 'up through the level');
  assert.ok(matchRule(rule('crossing', 100, undefined, 101), sig(99)), 'down through the level');
  assert.strictEqual(matchRule(rule('crossing', 100, undefined, 101), sig(102)), null, 'staying above is not crossing');
});

check('crossing up and crossing down are directional', () => {
  assert.ok(matchRule(rule('crossing_up', 100, undefined, 99), sig(100)), 'touching counts as crossing up');
  assert.strictEqual(matchRule(rule('crossing_up', 100, undefined, 101), sig(99)), null);
  assert.ok(matchRule(rule('crossing_down', 100, undefined, 101), sig(100)));
  assert.strictEqual(matchRule(rule('crossing_down', 100, undefined, 99), sig(101)), null);
});

check('channel ops: inside / outside are stateless, entering / exiting are not', () => {
  assert.ok(matchRule(rule('inside_channel', 90, 110), sig(100)));
  assert.strictEqual(matchRule(rule('inside_channel', 90, 110), sig(120)), null);
  assert.ok(matchRule(rule('outside_channel', 90, 110), sig(120)));
  assert.strictEqual(matchRule(rule('outside_channel', 90, 110), sig(100)), null);

  assert.ok(matchRule(rule('entering_channel', 90, 110, 80), sig(100)), 'came in from below');
  assert.strictEqual(matchRule(rule('entering_channel', 90, 110, 95), sig(100)), null, 'already inside');
  assert.ok(matchRule(rule('exiting_channel', 90, 110, 100), sig(120)), 'left through the top');
  assert.strictEqual(matchRule(rule('exiting_channel', 90, 110, 120), sig(130)), null, 'already outside');
});

check('moving ops measure the change since the last observation', () => {
  assert.ok(matchRule(rule('moving_up', 5, undefined, 100), sig(105)));
  assert.strictEqual(matchRule(rule('moving_up', 5, undefined, 100), sig(104)), null);
  assert.ok(matchRule(rule('moving_down', 5, undefined, 100), sig(95)));
  assert.strictEqual(matchRule(rule('moving_down', 5, undefined, 100), sig(96)), null);
  assert.strictEqual(matchRule(rule('moving_up', 5, undefined, null), sig(999)), null,
    'no previous price means no measurable move');
});

check('percent moves are relative, not absolute', () => {
  assert.ok(matchRule(rule('moving_up_pct', 2, undefined, 100), sig(102)));
  assert.strictEqual(matchRule(rule('moving_up_pct', 2, undefined, 100), sig(101.5)), null);
  assert.ok(matchRule(rule('moving_down_pct', 2, undefined, 100), sig(98)));
  // the same 2-point move is only 0.2% on a 1000 stock, so it must NOT fire
  assert.strictEqual(matchRule(rule('moving_up_pct', 2, undefined, 1000), sig(1002)), null);
});

check('a junk price never fires anything', () => {
  for (const px of [0, -1, NaN, null, undefined]) {
    for (const op of Object.keys(store.PRICE_OPS)) {
      assert.strictEqual(matchRule(rule(op, 10, 20, 15), sig(px)), null, op + ' with price ' + px);
    }
  }
});

check('the scan records what each price rule saw, so the NEXT scan can compare', () => {
  const saved = store.saveRule('pxu', { symbol: 'SPY', type: 'price', op: 'crossing_up', value: 100, cooldownMin: 5 });
  assert.strictEqual(saved.ok, true);
  const t0 = Date.parse('2026-08-19T14:00:00Z');

  // first scan below the level: nothing to cross yet, but the price is remembered
  assert.strictEqual(evaluateScan({ signals: [sig(99)] }, t0), 0);
  assert.strictEqual(store.listRules('pxu')[0].lastPrice, 99, 'observation persisted');

  // second scan above it: now there is a crossing
  assert.strictEqual(evaluateScan({ signals: [sig(101)] }, t0 + 60000), 1);
  assert.strictEqual(store.listRules('pxu')[0].lastPrice, 101);
});

check('re-saving a rule cannot fake a crossing by resetting lastPrice', () => {
  const r = store.saveRule('sneaky2', { symbol: 'SPY', type: 'price', op: 'crossing_up', value: 100 });
  evaluateScan({ signals: [sig(99)] }, Date.parse('2026-08-19T15:00:00Z'));
  const seen = store.listRules('sneaky2')[0].lastPrice;
  assert.strictEqual(seen, 99);
  store.saveRule('sneaky2', Object.assign({}, r.rule, { lastPrice: 200 }));   // malicious edit
  assert.strictEqual(store.listRules('sneaky2')[0].lastPrice, 99, 'server-owned value survives');
});

check('fail-soft: a malformed price rule never throws or breaks the scan', () => {
  assert.strictEqual(matchRule({ type: 'price', symbol: 'SPY', op: 'crossing' }, sig(100)), null);
  assert.strictEqual(matchRule({ type: 'price', symbol: 'SPY', op: 'bogus', value: 1 }, sig(100)), null);
  // evaluateScan may legitimately fire rules left by earlier checks -- what matters is
  // that it RETURNS a count instead of throwing, whatever the rule set contains.
  assert.strictEqual(typeof evaluateScan({ signals: [sig(100)] }), 'number');
  assert.strictEqual(evaluateScan({ signals: [{ symbol: 'SPY', entry_price: 'junk' }] }), 0);
  assert.strictEqual(evaluateScan(null), 0);
});

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
