'use strict';
/**
 * polarity-ledger.test.js — the counterfactual ledger #3343 built has to be
 * usable as evidence, and until now it was not.
 *
 * Audited 2026-08-25: 6,182 logged wrapper fires, 67 of them decisions the
 * day-trader could ever have acted on. 2,112 landed on a weekend, 1,720 outside
 * 09:30-16:00 ET (one at 23:15 ET off a frozen 19:45 extended-hours bar, re-fired
 * every 60s all night), and the rest were the same symbol re-logged inside one
 * entry-cadence hour. The naive read of the raw file — "the veto blocks 46% of
 * candidates" — is wrong by an order of magnitude; in-session, on a decision
 * basis, the selective gate allows 19 of 24.
 *
 * And on 2026-08-21 the file flipped between mode "0" and mode "selective" 132
 * times in one session: two engines writing the same tree under different
 * environments (the headless-boot failure #3454 closed). Nothing on a row said
 * who wrote it, so the ghost's 43 decisions were indistinguishable from the
 * armed engine's 24.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polledger-'));
const LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_TRADES_LOG = LOG;
const scan = require('../lib/signal-engine/scan');

const read = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => { if (fs.existsSync(LOG)) fs.unlinkSync(LOG); };
// a wall-clock instant expressed in ET (EDT in August), as a real Date
const etAt = (isoDay, h, m) => new Date(`${isoDay}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`);
const withAll = (fn) => {
  const prev = process.env.TRADER_POLARITY_LOG_ALL;
  process.env.TRADER_POLARITY_LOG_ALL = '1';
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.TRADER_POLARITY_LOG_ALL; else process.env.TRADER_POLARITY_LOG_ALL = prev;
  }
};

test('the session window accepts exactly the minutes the day-trader can act in', () => {
  const WED = '2026-08-19';
  assert.strictEqual(scan._inRegularSession(etAt(WED, 9, 29)), false, '09:29 is pre-market');
  assert.strictEqual(scan._inRegularSession(etAt(WED, 9, 30)), true, 'the open counts');
  assert.strictEqual(scan._inRegularSession(etAt(WED, 12, 0)), true);
  assert.strictEqual(scan._inRegularSession(etAt(WED, 16, 0)), true, 'the close counts');
  assert.strictEqual(scan._inRegularSession(etAt(WED, 16, 1)), false, 'after the bell is not a decision');
  assert.strictEqual(scan._inRegularSession(etAt(WED, 23, 15)), false, 'the 23:15 sample that re-fired all night');
  assert.strictEqual(scan._inRegularSession(etAt(WED, 3, 15)), false);
});

test('weekends are never decisions, at any hour', () => {
  for (const day of ['2026-08-22', '2026-08-23']) {          // Sat, Sun
    for (const h of [9, 10, 12, 15]) {
      assert.strictEqual(scan._inRegularSession(etAt(day, h, 45)), false, `${day} ${h}:45 must not journal`);
    }
  }
});

test('an in-session fire is written', () => {
  reset();
  scan._logVeto({ event: 'polarity_veto', symbol: 'SQQQ', price: 38.9, mode: 'selective' }, etAt('2026-08-19', 13, 49));
  const rows = read();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].symbol, 'SQQQ');
  assert.strictEqual(rows[0].mode, 'selective', 'caller-supplied fields survive');
  assert.ok(rows[0].ts, 'and the timestamp is still first');
});

test('the 2,112 weekend rows and the 23:15 all-nighter are refused at the source', () => {
  reset();
  scan._logVeto({ event: 'polarity_veto', symbol: 'TZA', price: 22.1 }, etAt('2026-08-22', 14, 0));   // Saturday
  scan._logVeto({ event: 'polarity_allow', symbol: 'SQQQ', price: 38.1 }, etAt('2026-08-19', 23, 15)); // off-session
  scan._logVeto({ event: 'polarity_veto', symbol: 'SOXS', price: 12.5 }, etAt('2026-08-20', 3, 15));   // overnight
  assert.deepStrictEqual(read(), [], 'none of these were decisions the engine could act on');
});

test('TRADER_POLARITY_LOG_ALL=1 restores the firehose for extended-hours work', () => {
  reset();
  withAll(() => scan._logVeto({ event: 'polarity_allow', symbol: 'SOXS', price: 12.5 }, etAt('2026-08-22', 14, 0)));
  const rows = read();
  assert.strictEqual(rows.length, 1, 'the escape hatch must write regardless of the clock');
  assert.strictEqual(rows[0].symbol, 'SOXS');
});

test('every row names its writing process, so a second engine is visible', () => {
  reset();
  scan._logVeto({ event: 'polarity_veto', symbol: 'SPXS', price: 9.1, mode: 'selective' }, etAt('2026-08-19', 11, 0));
  const [r] = read();
  assert.strictEqual(r.pid, process.pid, 'the ghost writer of 2026-08-21 was detectable only by an accidental mode flip');
});

test('instrumentation still never breaks the scan', () => {
  const circular = { event: 'polarity_veto', symbol: 'TZA' };
  circular.self = circular;                       // JSON.stringify throws
  assert.doesNotThrow(() => scan._logVeto(circular, etAt('2026-08-19', 11, 0)));
});

test('the default clock is still used when no instant is supplied', () => {
  reset();
  // production calls _logVeto(rec) with one argument; the guard must consult the
  // real clock rather than crash or silently pass.
  assert.doesNotThrow(() => scan._logVeto({ event: 'polarity_veto', symbol: 'SQQQ', price: 1 }));
  const rows = read();
  assert.ok(rows.length === 0 || rows.length === 1, 'writes iff the wall clock is in session');
  if (rows.length) assert.strictEqual(rows[0].pid, process.pid);
});

test('the row records the mode that JUDGED the fire, not a re-read of the env', () => {
  const prev = process.env.TRADER_SHORT_EDGE;
  process.env.TRADER_SHORT_EDGE = 'selective';
  try {
    // an explicit opts.shortEdge wins over the env inside applyPolarity, so the
    // ledger has to say so — otherwise the one field naming the rule is a lie.
    const r = scan.applyPolarity('SQQQ', 'BULLISH', { shortEdge: '0', spy: { tape: -0.2, mom30: 0, ll: false } });
    assert.strictEqual(r.mode, '0', 'the applied mode, not the environment');
    assert.ok(r.veto, 'and mode 0 still vetoes');
    const s = scan.applyPolarity('SQQQ', 'BULLISH', { spy: { tape: -0.2, mom30: 0, ll: false }, wrapperDD: -0.5, underlyingTape: 0.1, etMin: 720 });
    assert.strictEqual(s.mode, 'selective', 'falling back to the env when no override is given');
  } finally {
    if (prev === undefined) delete process.env.TRADER_SHORT_EDGE; else process.env.TRADER_SHORT_EDGE = prev;
  }
});

test('a 1x instrument is untouched and still carries a mode for the ledger', () => {
  const r = scan.applyPolarity('SPY', 'BULLISH', {});
  assert.strictEqual(r.direction, 'BULLISH');
  assert.strictEqual(r.veto, null);
  assert.ok(typeof r.mode === 'string', 'every verdict names its mode');
});
