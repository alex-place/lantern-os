// #3240 — scorecard breakdown slices (symbol / ET hour / exit reason / skip log).
//
// The contract under test: slices carry the SAME honesty pipeline as the headline
// scorecard (no-fill attempts dropped, re-decisions collapsed BEFORE bucketing,
// confirmed-vs-all split preserved), and the skip log groups by number-normalized
// decline reason. Fixture-driven — no live ledger, no network.
//
// Run: node apps/lantern-garage/test/scorecard-breakdown.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { breakdown, BREAKDOWN_KEYS } = require('../lib/trader-scorecard');

const FIXTURE = path.join(__dirname, 'tmp-breakdown-fixture.jsonl');

// 14:30Z = 10:30 ET (EDT); 19:45Z = 15:45 ET.
const rows = [
  { ts: '2026-08-03T14:30:00.000Z', event: 'exit', symbol: 'SPY', qty: 10, entry: 100, pnl: 50, pnl_pct: 0.5, reason: 'zone_r1 (banked)', status: 'filled' },
  { ts: '2026-08-03T19:45:00.000Z', event: 'exit', symbol: 'QQQ', qty: 5, entry: 200, pnl: -30, pnl_pct: -0.3, reason: 'stop (broker STP)', status: 'placed' },
  // duplicate pair — same (symbol, entry, qty): must collapse to ONE round-trip (last wins)
  { ts: '2026-08-04T14:30:00.000Z', event: 'exit', symbol: 'IWM', qty: 7, entry: 50.123456, pnl: 900, pnl_pct: 9, reason: 'trailing_stop', status: 'filled' },
  { ts: '2026-08-04T19:45:00.000Z', event: 'exit', symbol: 'IWM', qty: 7, entry: 50.123456, pnl: 20, pnl_pct: 0.2, reason: 'trailing_stop', status: 'filled' },
  // profit-only exit reason — win rate is structural, must be flagged
  { ts: '2026-08-05T14:30:00.000Z', event: 'exit', symbol: 'SPY', qty: 4, entry: 101, pnl: 10, pnl_pct: 0.1, reason: 'take_profit_R (1R)', status: 'filled' },
  // dry-run decision — in `all`, NOT in `confirmed`
  { ts: '2026-08-05T14:35:00.000Z', event: 'exit', symbol: 'TNA', qty: 3, entry: 30, pnl: 5, pnl_pct: 0.5, reason: 'signal_exit', status: 'dry_run' },
  // broker-rejected attempt — realized nothing, excluded from BOTH views
  { ts: '2026-08-05T14:40:00.000Z', event: 'exit', symbol: 'SPY', qty: 2, entry: 99, pnl: 999, pnl_pct: 9, reason: 'signal_exit', status: 'rejected' },
  // entries are not exits
  { ts: '2026-08-03T13:00:00.000Z', event: 'entry', symbol: 'SPY', qty: 10, entry: 100 },
  // skip log — numbers normalize away, so these are ONE reason family
  { ts: '2026-08-03T13:05:00.000Z', event: 'skip', symbol: 'SPY', reason: 'gross 81.2% > cap 80%' },
  { ts: '2026-08-03T13:06:00.000Z', event: 'skip', symbol: 'QQQ', reason: 'gross 83% > cap 80%' },
  { ts: '2026-08-03T13:07:00.000Z', event: 'skip', symbol: 'SPY', reason: 'cooldown active' },
];

fs.writeFileSync(FIXTURE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

let failures = 0;
const check = (name, fn) => {
  try { fn(); process.stdout.write('  ok  - ' + name + '\n'); }
  catch (e) { failures++; process.stderr.write('  FAIL- ' + name + '\n      ' + e.message + '\n'); }
};

check('unknown ?by= is a typed error, not a throw', () => {
  const r = breakdown('nope', FIXTURE);
  assert.strictEqual(r.error, 'unknown_breakdown');
  assert.deepStrictEqual(r.supported, BREAKDOWN_KEYS);
});

check('by=symbol: confirmed excludes dry_run + rejected; groups are per symbol', () => {
  const r = breakdown('symbol', FIXTURE);
  assert.ok(r.confirmed.SPY && r.confirmed.QQQ && r.confirmed.IWM);
  assert.strictEqual(r.confirmed.TNA, undefined, 'dry_run must not reach confirmed');
  assert.strictEqual(r.all.TNA.trades, 1, 'dry_run appears in the all view');
  // rejected SPY row excluded from both views
  assert.strictEqual(r.confirmed.SPY.trades, 2);
  assert.strictEqual(r.all.SPY.trades, 2);
});

check('dedupe happens BEFORE bucketing — duplicate IWM pair is one round-trip, last wins', () => {
  const r = breakdown('symbol', FIXTURE);
  assert.strictEqual(r.confirmed.IWM.trades, 1);
  assert.strictEqual(r.confirmed.IWM.totalRealized, 20, 'the LAST duplicate row is the survivor');
});

check('by=reason: profit-only families are flagged, others are not', () => {
  const r = breakdown('reason', FIXTURE);
  assert.strictEqual(r.confirmed.take_profit_R.profitOnly, true);
  assert.strictEqual(r.confirmed.stop.profitOnly, false);
  // reasonFamily stops at the first digit, so zone_r1/zone_r2 share the zone_r family.
  assert.strictEqual(r.confirmed.zone_r.trades, 1);
});

check('by=hour: buckets are ET hours (14:30Z → 10:00 ET)', () => {
  const r = breakdown('hour', FIXTURE);
  assert.ok(r.confirmed['10:00 ET'], 'expected a 10:00 ET bucket, got ' + Object.keys(r.confirmed).join(','));
  assert.ok(r.confirmed['15:00 ET'], 'expected a 15:00 ET bucket');
});

check('by=skip: numeric noise normalizes, counts + distinct symbols + total are right', () => {
  const r = breakdown('skip', FIXTURE);
  assert.strictEqual(r.totalSkips, 3);
  const capKey = Object.keys(r.groups).find((k) => k.includes('cap #%'));
  assert.ok(capKey, 'the two gross>cap skips should share one normalized family');
  assert.strictEqual(r.groups[capKey].count, 2);
  assert.strictEqual(r.groups[capKey].symbols, 2);
  const cool = Object.keys(r.groups).find((k) => k.includes('cooldown'));
  assert.strictEqual(r.groups[cool].count, 1);
});

fs.unlinkSync(FIXTURE);
process.exit(failures ? 1 : 0);
