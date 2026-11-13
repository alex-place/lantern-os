'use strict';
/**
 * plan-watch.test.js — the plan watchdog (lib/plan-watch.js), alert only: off unless TRADER_PLAN_WATCH=alert; a trade on its plan
 * says nothing; each condition (overdue exit, unprotected, size, short, missing position, an exit outside its plan, a position with
 * no plan) is said once when it starts, after its passes, and once when it clears; a recorded down-day carry moves the exit time;
 * a fault reaches the ALERTS file; a relaunch says nothing twice; and in the brain: the pass's own reads reach it, off by default.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('../lib/plan-watch');
const tp = require('../lib/trade-plan');

const DAY = '2026-09-22', NEXT = '2026-09-23';   // a Tuesday and a Wednesday (EDT)
const at = (day, hh, mm = 0, ss = 0) => tp.msOf(day, hh * 60 + mm) + ss * 1000;
const iso = (ms) => new Date(ms).toISOString();
const ENV = { TRADER_PLAN_WATCH: 'alert' };

/** A sleeve journal in a temp dir; `log` is the brain's logTrade: it stamps the row and appends it to the same file. */
function journal(name = 'M') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-watch-'));
  const file = path.join(dir, `${name}.autopilot-trades.jsonl`), alerts = path.join(dir, 'plan-watch-ALERTS.log');
  fs.writeFileSync(file, '');
  const J = { dir, file, alerts, said: [], now: 0 };
  J.append = (r) => fs.appendFileSync(file, JSON.stringify(r) + '\n');
  J.log = (r) => { const row = { ts: iso(J.now), user: 'trade-plan', ...r }; J.said.push(row); J.append(row); };
  J.run = (now, positions, orders) => { J.now = now; return pw.check({ now, positions, orders, journal: file, log: J.log, alertsFile: alerts, sleeve: name, env: ENV }); };
  return J;
}
const INVERSE = ['SQQQ', 'SOXS', 'SPXS'];
function plan({ kind = 'M', symbol = 'TQQQ', qty = 10, entryAt, exitBy, stop = 46, exits = null, rule = 'the de-carry at 15:55' } = {}) {
  const leg = [{ rule: 'band_exit' }, { rule: 'stop', price: stop }, { rule: 'loss_cap', price: 46 }, { rule: 'late_gate' }, { rule: 'decarry' },
    ...(INVERSE.includes(symbol) ? [{ rule: 'carry_downday', applies: true }] : [])];
  return { ts: iso(entryAt + 3000), user: 'trade-plan', event: 'trade_plan', v: 2, mode: 'shadow', kind, symbol,
    entry: { at: iso(entryAt), qty, price: 50, stop }, expected: { exit_by: iso(exitBy), exit_rule: rule }, exits: exits || leg };
}
const entryRow = (symbol, ms, qty = 10) => ({ ts: iso(ms), user: 'local-owner', event: 'entry', symbol, qty, entry: 50 });
const exitRow = (symbol, ms, reason, pnl = 0) => ({ ts: iso(ms), user: 'local-owner', event: 'exit', symbol, reason, pnl, entry: 50, exit: 50 });
const stopOrder = (symbol, qty, status = 'submitted') => ({ orderId: `s-${symbol}`, symbol, side: 'SELL', qty, filledQty: 0, status, orderType: 'stop', price: 46 });
const kinds = (rows) => rows.map((r) => [r.event, r.check, r.level || null]);

test('off unless TRADER_PLAN_WATCH=alert: nothing read, nothing written', async () => {
  pw._reset(); const J = journal();
  J.append(entryRow('TQQQ', at(DAY, 10))); J.append(plan({ entryAt: at(DAY, 10), exitBy: at(DAY, 15, 55) }));
  for (const env of [{}, { TRADER_PLAN_WATCH: '1' }, { TRADER_PLAN_WATCH: 'shadow' }]) {
    assert.strictEqual(await pw.check({ now: at(DAY, 16, 30), positions: [{ symbol: 'TQQQ', qty: 10 }], orders: [], journal: J.file, log: J.log, env }), null);
  }
  assert.deepStrictEqual(J.said, []); assert.ok(!fs.existsSync(J.alerts));
  assert.strictEqual(pw.enabled({ TRADER_PLAN_WATCH: ' Alert ' }), true);
});

test('a trade on its plan says nothing; a de-carry that does not sell is overdue 3 minutes after its time, said once, cleared when it goes', async () => {
  pw._reset(); const J = journal();
  const entryAt = at(DAY, 10, 0, 25);
  J.append(entryRow('TQQQ', entryAt)); J.append(plan({ entryAt, exitBy: at(DAY, 15, 55) }));
  const pos = [{ symbol: 'TQQQ', qty: 10, side: 'long' }], ords = [stopOrder('TQQQ', 10)];
  for (const [h, m] of [[10, 1], [12, 0], [15, 55], [15, 57]]) await J.run(at(DAY, h, m, 22), pos, ords);
  assert.deepStrictEqual(J.said, [], 'on plan: nothing said');
  const r = await J.run(at(DAY, 15, 58, 22), pos, ords);
  assert.strictEqual(r.open, 1);
  assert.deepStrictEqual(kinds(J.said), [['plan_alert', 'overdue_exit', 'fault']]);
  assert.strictEqual(J.said[0].symbol, 'TQQQ'); assert.strictEqual(J.said[0].sleeve, 'M'); assert.strictEqual(J.said[0].plan_at, iso(entryAt));
  assert.match(J.said[0].why, /^still held 3 min after the de-carry at 15:55$/);
  assert.match(fs.readFileSync(J.alerts, 'utf8'), /Z {2}M TQQQ overdue_exit: still held 3 min after the de-carry at 15:55\n$/);
  await J.run(at(DAY, 15, 59, 22), pos, ords);
  assert.strictEqual(J.said.length, 1, 'said once');
  J.append(exitRow('TQQQ', at(DAY, 15, 59, 40), 'eod_decarry (leveraged overnight gap risk #3298) — flat into the close', 12));
  await J.run(at(DAY, 16, 0, 22), [], []);
  assert.deepStrictEqual(J.said.slice(1).map((x) => [x.event, x.check, x.lasted_min]), [['plan_alert_cleared', 'overdue_exit', 2]]);
  await J.run(at(DAY, 16, 5, 22), [], []);
  assert.strictEqual(J.said.length, 2, 'the de-carry is in its plan: no exit alert; a closed plan is not watched');
  assert.strictEqual(fs.readFileSync(J.alerts, 'utf8').split('\n').filter(Boolean).length, 1, 'a clearing writes no alert line');
});

test('unprotected: the plan listed a stop and the working sells cover fewer shares, three passes running', async () => {
  pw._reset(); const J = journal();
  const entryAt = at(DAY, 10, 0, 25);
  J.append(entryRow('TQQQ', entryAt)); J.append(plan({ entryAt, exitBy: at(DAY, 15, 55) }));
  const pos = [{ symbol: 'TQQQ', qty: 10 }];
  await J.run(at(DAY, 10, 1, 22), pos, []); await J.run(at(DAY, 10, 2, 22), pos, [stopOrder('TQQQ', 10, 'canceled')]);
  assert.deepStrictEqual(J.said, [], 'two passes: the brain re-protects on its next pass');
  await J.run(at(DAY, 10, 3, 22), pos, [{ ...stopOrder('TQQQ', 10), side: 'BUY' }]);
  assert.deepStrictEqual(J.said.map((x) => [x.check, x.level, x.passes]), [['unprotected', 'fault', 3]]);
  assert.match(J.said[0].why, /no working sell order covers the 10 shares \(the plan's stop: 46\)/);
  await J.run(at(DAY, 10, 4, 22), pos, [{ ...stopOrder('TQQQ', 10), filledQty: 4 }]);
  assert.strictEqual(J.said.length, 1, 'a stop with 6 of 10 left covers 6: still the same condition');
  await J.run(at(DAY, 10, 5, 22), pos, [{ ...stopOrder('TQQQ', 10), filledQty: 4 }, { orderId: 'm1', symbol: 'TQQQ', side: 'sell', qty: 4, status: 'submitted', orderType: 'market' }]);
  assert.deepStrictEqual(J.said.slice(1).map((x) => [x.event, x.check, x.lasted_min]), [['plan_alert_cleared', 'unprotected', 2]], 'the stop\'s unfilled 6 and a working sale of 4 cover it');
  // a pass that sees cover starts the count over
  await J.run(at(DAY, 10, 6, 22), pos, []); await J.run(at(DAY, 10, 7, 22), pos, []); await J.run(at(DAY, 10, 8, 22), pos, [stopOrder('TQQQ', 10)]);
  await J.run(at(DAY, 10, 9, 22), pos, []); await J.run(at(DAY, 10, 10, 22), pos, []);
  assert.strictEqual(J.said.length, 2);
  // no stop in the plan: nothing to check
  pw._reset(); const K = journal();
  K.append(entryRow('SPY', entryAt)); K.append(plan({ kind: 'O', symbol: 'SPY', entryAt, exitBy: at(NEXT, 9, 40), stop: null, exits: [{ rule: 'loss_cap', price: 460 }, { rule: 'sale_0940' }], rule: 'the 09:40 sale' }));
  for (let m = 1; m <= 4; m++) await K.run(at(DAY, 10, m, 22), [{ symbol: 'SPY', qty: 10 }], []);
  assert.deepStrictEqual(K.said, []);
});

test('the size: a quantity off the plan after two passes, a short at once', async () => {
  pw._reset(); const J = journal();
  const entryAt = at(DAY, 10, 0, 25);
  J.append(entryRow('TQQQ', entryAt)); J.append(plan({ entryAt, exitBy: at(DAY, 15, 55) }));
  await J.run(at(DAY, 10, 1, 22), [{ symbol: 'TQQQ', qty: 9 }], [stopOrder('TQQQ', 9)]);
  assert.deepStrictEqual(J.said, []);
  await J.run(at(DAY, 10, 2, 22), [{ symbol: 'TQQQ', qty: '9' }], [stopOrder('TQQQ', 9)]);
  assert.deepStrictEqual(J.said.map((x) => [x.check, x.why]), [['size_mismatch', 'the broker holds 9, the plan 10']]);
  assert.deepStrictEqual(J.said[0].detail, { held: 9, planned: 10 });
  await J.run(at(DAY, 10, 3, 22), [{ symbol: 'TQQQ', qty: 5, side: 'short' }], []);
  assert.deepStrictEqual(kinds(J.said.slice(1)), [['plan_alert', 'short_position', 'fault'], ['plan_alert_cleared', 'size_mismatch', null]]);
  assert.match(J.said[1].why, /^the broker shows -5 shares: short/);
});

test('missing position: info while it never appeared, a fault once seen and gone without an exit row; the exit row clears it', async () => {
  pw._reset(); const J = journal();
  const entryAt = at(DAY, 10, 0, 25);
  J.append(entryRow('TQQQ', entryAt)); J.append(plan({ entryAt, exitBy: at(DAY, 15, 55) }));
  for (const m of [1, 2, 3]) await J.run(at(DAY, 10, m, 22), [], []);
  assert.deepStrictEqual(J.said, [], 'the first minute is the fill; then three passes');
  await J.run(at(DAY, 10, 4, 22), [], []);
  assert.deepStrictEqual(kinds(J.said), [['plan_alert', 'missing_position', 'info']]);
  assert.match(J.said[0].why, /the entry may not have filled/);
  const pos = [{ symbol: 'TQQQ', qty: 10 }], ords = [stopOrder('TQQQ', 10)];
  await J.run(at(DAY, 10, 5, 22), pos, ords);
  assert.deepStrictEqual(kinds(J.said.slice(1)), [['plan_alert_cleared', 'missing_position', null]]);
  for (const m of [6, 7]) await J.run(at(DAY, 10, m, 22), [], []);
  assert.strictEqual(J.said.length, 2);
  await J.run(at(DAY, 10, 8, 22), [], []);
  assert.deepStrictEqual(kinds(J.said.slice(2)), [['plan_alert', 'missing_position', 'fault']], 'seen, then gone with no exit row');
  J.append(exitRow('TQQQ', at(DAY, 10, 5, 50), 'broker fill', -40));
  await J.run(at(DAY, 10, 9, 22), [], []);
  assert.deepStrictEqual(kinds(J.said.slice(3)), [['plan_alert_cleared', 'missing_position', null]], 'the stop is in the plan: no exit alert');
  // a plan whose position never appeared is left alone a day after its exit time
  pw._reset(); const K = journal();
  K.append(entryRow('UPRO', at(DAY, 10, 0, 25))); K.append(plan({ symbol: 'UPRO', entryAt: at(DAY, 10, 0, 25), exitBy: at(DAY, 15, 55) }));
  for (const m of [1, 2, 3, 4]) await K.run(at('2026-09-24', 10, m, 22), [], []);
  assert.deepStrictEqual(K.said, [], 'stale: nothing to watch');
});

test('an exit by a rule the plan did not list is a fault, said once; a loss-cap sale in the extended hours is listed but outside the measured design: info', async () => {
  pw._reset(); const J = journal('C');
  const cAt = at(DAY, 15, 55, 25);
  J.append(entryRow('IWM', cAt)); J.append(plan({ kind: 'C', symbol: 'IWM', entryAt: cAt, exitBy: at(NEXT, 15, 50), exits: [{ rule: 'stop', price: 200 }, { rule: 'loss_cap', price: 202 }, { rule: 'max_hold' }], rule: 'the max-hold sale' }));
  await J.run(at(NEXT, 10, 0, 22), [{ symbol: 'IWM', qty: 10 }], [stopOrder('IWM', 10)]);
  J.append(exitRow('IWM', at(NEXT, 10, 0, 40), 'momentum_exit (3 bearish scans)', -15));
  await J.run(at(NEXT, 10, 1, 22), [], []);
  assert.deepStrictEqual(kinds(J.said), [['plan_alert', 'exit_outside_plan', 'fault']]);
  assert.strictEqual(J.said[0].once, true); assert.strictEqual(J.said[0].detail.branch, 'other:momentum_exit'); assert.strictEqual(J.said[0].detail.reason, 'momentum_exit');
  assert.strictEqual(J.said[0].why, 'the plan listed no other:momentum_exit rule');
  await J.run(at(NEXT, 10, 2, 22), [], []);
  assert.strictEqual(J.said.length, 1, 'said once');
  pw._reset();                                                            // a relaunch minutes after the exit
  await J.run(at(NEXT, 10, 4, 0), [], []);
  assert.strictEqual(J.said.length, 1, 'not said again after a relaunch');
  assert.match(fs.readFileSync(J.alerts, 'utf8'), /C IWM exit_outside_plan: the plan listed no other:momentum_exit rule/);
  // the leg's inverse carry sold by the cap at 04:12 the next morning: in its plan, outside the measured design
  pw._reset(); const K = journal();
  const mAt = at(DAY, 15, 0, 25);
  K.append(entryRow('SOXS', mAt)); K.append(plan({ symbol: 'SOXS', entryAt: mAt, exitBy: at(DAY, 15, 55) }));
  K.append({ ts: iso(at(DAY, 15, 55, 22)), user: 'trade-plan', event: 'plan_carry', symbol: 'SOXS', day: DAY, spy_pct: -1.8 });
  await K.run(at(DAY, 15, 56, 22), [{ symbol: 'SOXS', qty: 10 }], [stopOrder('SOXS', 10)]);
  K.append(exitRow('SOXS', at(NEXT, 4, 12, 30), 'max_loss (-8.0% <= -8%)', -300));
  await K.run(at(NEXT, 4, 15, 0), [], []);
  assert.deepStrictEqual(kinds(K.said), [['plan_alert', 'exit_outside_plan', 'info']]);
  assert.strictEqual(K.said[0].detail.branch, 'carried_then_cap'); assert.strictEqual(K.said[0].detail.extended_hours, true);
  assert.ok(!fs.existsSync(K.alerts), 'info never reaches the ALERTS file');
});

test('a down-day carry the brain recorded moves the exit to the next session\'s de-carry; without it the carry is overdue', async () => {
  for (const carried of ['plan_carry', 'skip', false]) {
    pw._reset(); const J = journal();
    const entryAt = at(DAY, 15, 0, 25);
    J.append(entryRow('SQQQ', entryAt)); J.append(plan({ symbol: 'SQQQ', entryAt, exitBy: at(DAY, 15, 55) }));
    if (carried === 'plan_carry') J.append({ ts: iso(at(DAY, 15, 55, 22)), user: 'trade-plan', event: 'plan_carry', symbol: 'SQQQ', day: DAY, spy_pct: -1.8 });
    if (carried === 'skip') J.append({ ts: iso(at(DAY, 15, 55, 26)), user: 'local-owner', event: 'skip', symbol: 'SQQQ', direction: null, p_win: null,
      reason: 'carry_downday — eod_decarry suppressed: SPY -1.80% on the session (at or below -1.5%); the inverse breakdown rides the gap' });
    const pos = [{ symbol: 'SQQQ', qty: 10 }], ords = [stopOrder('SQQQ', 10)];
    await J.run(at(DAY, 15, 59, 22), pos, ords);
    await J.run(at(NEXT, 9, 35, 22), pos, ords);
    if (!carried) { assert.deepStrictEqual(J.said.map((x) => x.check), ['overdue_exit']); continue; }
    assert.deepStrictEqual(J.said, [], 'carried by its rule: not overdue overnight');
    await J.run(at(NEXT, 15, 57, 22), pos, ords);
    assert.deepStrictEqual(J.said, []);
    await J.run(at(NEXT, 15, 58, 22), pos, ords);
    assert.deepStrictEqual(J.said.map((x) => x.check), ['overdue_exit']);
    assert.match(J.said[0].why, /after the next session's de-carry \(the down-day carry held it: SPY -1\.8 %\)/, carried);
    assert.strictEqual(J.said[0].detail.exit_by, iso(at(NEXT, 15, 55)));
  }
});

test('a position with no plan: info after two passes, said once, cleared when it goes; held from before the plans began', async () => {
  pw._reset(); const J = journal('O');
  J.append(entryRow('SPY', at('2026-09-18', 15, 55, 28), 7));            // Friday, before any plan
  const tAt = at(DAY, 10, 0, 25);
  J.append(entryRow('QQQ', tAt)); J.append(plan({ kind: 'O', symbol: 'QQQ', entryAt: tAt, exitBy: at(NEXT, 9, 40), stop: 400, exits: [{ rule: 'stop', price: 400 }, { rule: 'sale_0940' }], rule: 'the 09:40 sale' }));
  J.append(entryRow('SMH', at(DAY, 10, 1, 0), 5));                        // after the first plan, with no plan row
  const pos = [{ symbol: 'SPY', qty: 7 }, { symbol: 'QQQ', qty: 10 }, { symbol: 'SMH', qty: 5 }], ords = [stopOrder('QQQ', 10)];
  await J.run(at(DAY, 10, 2, 22), pos, ords);
  assert.deepStrictEqual(J.said, []);
  await J.run(at(DAY, 10, 3, 22), pos, ords);
  const by = Object.fromEntries(J.said.map((x) => [x.symbol, x]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['SMH', 'SPY']);
  assert.strictEqual(by.SPY.level, 'info'); assert.strictEqual(by.SPY.why, 'held from before this sleeve wrote plans');
  assert.match(by.SMH.why, /^held with no open plan/); assert.strictEqual(by.SMH.key, `${DAY}:SMH:unplanned_position`);
  await J.run(at(DAY, 10, 4, 22), pos, ords);
  assert.strictEqual(J.said.length, 2, 'said once');
  await J.run(at(DAY, 10, 5, 22), pos.filter((p) => p.symbol !== 'SPY'), ords);
  assert.deepStrictEqual(J.said.slice(2).map((x) => [x.event, x.symbol]), [['plan_alert_cleared', 'SPY']]);
  assert.ok(!fs.existsSync(J.alerts));
});

test('a relaunch rebuilds the open plans and the alerts in force from the journal: nothing is said twice', async () => {
  pw._reset(); const J = journal();
  const entryAt = at(DAY, 10, 0, 25);
  J.append(entryRow('TQQQ', entryAt)); J.append(plan({ entryAt, exitBy: at(DAY, 15, 55) }));
  // a long wrapper carried overnight (no carry rule in its plan) and sold this morning, hours before the watch began
  J.append(entryRow('UPRO', at('2026-09-21', 11, 0, 25))); J.append(plan({ symbol: 'UPRO', entryAt: at('2026-09-21', 11, 0, 25), exitBy: at('2026-09-21', 15, 55) }));
  J.append(exitRow('UPRO', at(DAY, 9, 35, 30), 'signal_exit', -9));
  const pos = [{ symbol: 'TQQQ', qty: 10 }], ords = [stopOrder('TQQQ', 10)];
  await J.run(at(DAY, 15, 58, 22), pos, ords);
  assert.deepStrictEqual(J.said.map((x) => x.check), ['overdue_exit'], 'an exit hours before the first check is history, not an alert');
  pw._reset();                                                            // the runner relaunches
  await J.run(at(DAY, 16, 5, 0), pos, ords);
  assert.strictEqual(J.said.length, 1, 'the alert in force came back from the journal');
  J.append(exitRow('TQQQ', at(DAY, 16, 6, 0), 'eod_decarry', 5));
  await J.run(at(DAY, 16, 10, 0), [], []);
  assert.deepStrictEqual(J.said.slice(1).map((x) => [x.event, x.check]), [['plan_alert_cleared', 'overdue_exit']]);
  assert.strictEqual(J.said[1].since, J.said[0].ts);
});

test('a journal that cannot be read is said once an hour, and the pass goes on', async () => {
  pw._reset();
  const said = [];
  const bad = path.join(os.tmpdir(), 'plan-watch-unreadable', 'x.jsonl');
  const realOpen = fs.promises.open;   // a journal the process may not read (the same on every platform): EACCES on open
  fs.promises.open = async (p, ...a) => { if (p === bad) { const e = new Error(`EACCES: permission denied, open '${p}'`); e.code = 'EACCES'; throw e; } return realOpen.call(fs.promises, p, ...a); };
  try {
    const run = (now) => pw.check({ now, positions: [], orders: [], journal: bad, log: (r) => said.push(r), env: ENV });
    assert.strictEqual(await run(at(DAY, 10)), null); assert.strictEqual(await run(at(DAY, 10, 30)), null);
    assert.strictEqual(said.length, 1); assert.strictEqual(said[0].event, 'plan_watch_error');
    await run(at(DAY, 11, 1)); assert.strictEqual(said.length, 2);
  } finally { fs.promises.open = realOpen; }
});

test('a sleeve that has never written its journal is an empty one: no error, nothing said, and its first rows are read when they come', async () => {
  pw._reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-watch-nojournal-'));
  const file = path.join(dir, 'T.autopilot-trades.jsonl');   // not created: T had never traded when the watchdog first read it (2026-11-09)
  const said = [];
  const log = (r) => { const row = { ts: iso(now), user: 'trade-plan', ...r }; said.push(row); fs.appendFileSync(file, JSON.stringify(row) + '\n'); };
  let now = at(DAY, 4, 0, 10);
  const run = (n, positions = []) => { now = n; return pw.check({ now: n, positions, orders: [], journal: file, log, sleeve: 'T', env: ENV }); };
  const r = await run(now);
  assert.notStrictEqual(r, null, 'a missing journal is not a failed read');
  assert.deepStrictEqual(said, [], 'nothing said, no plan_watch_error');
  assert.ok(!fs.existsSync(file), 'the check creates no journal');
  // the sleeve's first trade: the plan and the entry land, and the next pass reads them from the start of the new file
  const e = at(DAY, 15, 55);
  fs.appendFileSync(file, JSON.stringify(plan({ kind: 'T', symbol: 'TLT', entryAt: e, exitBy: at(NEXT, 15, 55), exits: [{ rule: 'calendar' }] })) + '\n');
  fs.appendFileSync(file, JSON.stringify(entryRow('TLT', e + 4000)) + '\n');
  const r2 = await run(e + 60000, [{ symbol: 'TLT', qty: 10 }]);
  assert.strictEqual(r2.open, 1, 'the new plan is read');
  assert.deepStrictEqual(said.filter((x) => x.event === 'plan_watch_error'), []);
});

test('the adherence read: the forward read\'s map, shared', () => {
  const P = plan({ entryAt: at(DAY, 10), exitBy: at(DAY, 15, 55) });
  const x = (min, reason) => ({ ts: iso(at(DAY, 0, min)), reason });
  assert.deepStrictEqual(pw.adherenceOf(P, { ts: P.entry.at }, x(15 * 60 + 30, 'signal_exit')), { branch: 'late_gate', in_plan: true, in_design: true, extended_hours: false, why: undefined });
  assert.strictEqual(pw.adherenceOf(P, { ts: P.entry.at }, x(11 * 60, 'signal_exit')).branch, 'band_exit');
  assert.strictEqual(pw.adherenceOf({ ...P, exits: [{ rule: 'stop', price: 1 }] }, { ts: P.entry.at }, x(11 * 60, 'signal_exit')).in_plan, false);
  assert.strictEqual(pw.adherenceOf(P, { ts: P.entry.at }, { ts: iso(at(DAY, 16, 30)), reason: 'max_loss (-8%)' }).in_design, false, 'a cap sale after the close');
});

// ---- in the brain: the pass's own reads reach it; off by default ---------------------------------------------------------------
test('the brain: with TRADER_PLAN_WATCH=alert a pass checks its open plans from its own reads; off, nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-watch-brain-'));
  const log = path.join(dir, 'C.autopilot-trades.jsonl');
  Object.assign(process.env, {
    TRADER_TRADES_LOG: log, TRADER_STATE_FILE: path.join(dir, 'state.json'), TRADER_AUTO_EXECUTE: '1', TRADER_REQUIRE_PERSIST: '0',
    TRADER_ENTRY_KNIFE_FILTER: '0', TRADER_SUP_ENTRY: '0', TRADER_STRESS_MULT: '1', TRADER_ENTRY_CONFIRM: '0', TRADER_ENTRY_CADENCE_MIN: '0',
    TRADER_MOMENTUM_EXIT: '0', TRADER_ZONE_EXIT: '0', TRADER_TAKE_PROFIT_R: '0', TRADER_EXIT_MIN_PWIN: '0', TRADER_EOD_DECARRY: '0', TRADER_LIMIT_SHADOW: '0',
    TRADER_ENTRY_TAGS_DIR: path.join(dir, 'no-tags'),
  });
  for (const k of ['TRADER_MANAGE_EXITS', 'TRADER_ENTRY_REQUOTE', 'TRADER_ENTRY_TAGS', 'TRADER_TREND_SHADOW', 'TRADER_NOISE_SHADOW', 'TRADER_RISE_SHADOW', 'TRADER_TRADE_PLAN', 'TRADER_PLAN_WATCH', 'TRADER_PLAN_WATCH_ALERTS']) delete process.env[k];
  const mdPath = require.resolve('../lib/market-data-yahoo');
  require.cache[mdPath] = { id: mdPath, filename: mdPath, loaded: true, exports: {
    getQuotes: async (tickers) => tickers.map((t) => ({ ticker: t, price: 500, chg_pct: 0 })), getBars: async () => ({ bars: [] }), getBarsMulti: async () => ({ bars: {} }),
    getSessionBars15m: async () => ({ bars: [] }), getBarsWindow: async () => ({ bars: [] }), getMarketStatus: async () => ({}), isUsEquityMarketOpen: () => true } };
  const brain = require('../lib/auto-trader');
  const NOW = at(NEXT, 15, 30);
  const write = (rows) => fs.writeFileSync(log, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const rows = () => fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const seed = [entryRow('QQQ', at(DAY, 15, 55, 25)), plan({ kind: 'C', symbol: 'QQQ', entryAt: at(DAY, 15, 55, 25), exitBy: at(NEXT, 14, 0), stop: 460, exits: [{ rule: 'stop', price: 460 }, { rule: 'max_hold' }], rule: 'the max-hold sale' })];
  const asked = [];
  const bridge = { getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }), getIBKRDayPnl: async () => 0, cancelIBKROrder: async () => ({ ok: true }),
    getIBKRPositions: async () => { asked.push('positions'); return [{ symbol: 'QQQ', qty: 10, avg_entry_price: 500, current_price: 501 }]; },
    getIBKROpenOrders: async () => { asked.push('orders'); return [stopOrder('QQQ', 10)]; },
    placeIBKROrder: async () => ({ status: 'placed', order_id: 'x' }) };
  const settle = async (pred) => { for (let i = 0; i < 40 && !pred(); i++) await new Promise((r) => setTimeout(r, 25)); };
  // off: the pass reads as it always did and nothing is said
  write(seed);
  await brain.runAutoTrade({ signals: [] }, { bridge, userId: 'local-owner', now: NOW });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!rows().some((r) => /^plan_/.test(r.event)), 'off by default');
  const readsOff = asked.length;
  // on: the same pass, the same reads, and the overdue max hold is said under the user trade-plan
  brain._resetCooldowns(); pw._reset(); asked.length = 0; write(seed);
  process.env.TRADER_PLAN_WATCH = 'alert';
  try {
    await brain.runAutoTrade({ signals: [] }, { bridge, userId: 'local-owner', now: NOW });
    await settle(() => rows().some((r) => r.event === 'plan_alert'));
    const a = rows().filter((r) => r.event === 'plan_alert');
    assert.deepStrictEqual(a.map((r) => [r.user, r.check, r.symbol, r.sleeve]), [['trade-plan', 'overdue_exit', 'QQQ', 'C']]);
    assert.strictEqual(asked.length, readsOff, 'no extra broker read');
    assert.match(fs.readFileSync(path.join(dir, 'plan-watch-ALERTS.log'), 'utf8'), /C QQQ overdue_exit: still held 90 min after the max-hold sale/);
  } finally { delete process.env.TRADER_PLAN_WATCH; }
});
