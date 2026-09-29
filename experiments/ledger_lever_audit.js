'use strict';
/**
 * ledger_lever_audit.js — STRENGTHS OR WEAKNESSES? (operator question, 2026-09-28)
 *
 * Every scored row of the prediction ledger is a lever somebody believed in. This groups the
 * rows into DISTINCT levers and sorts each lever into one of two families:
 *
 *   W  repair a weakness   the change REMOVES or SHRINKS trades / exposure to avoid a loss:
 *                          a gate, veto, cap, block, early exit, flatten rule, throttle,
 *                          de-size-on-condition, pruning a name
 *   S  extend a strength   the change ADDS trades / exposure / time-in-trade where the edge
 *                          already earns: new names, more slots, a restriction removed, wider
 *                          admission, a wider profit floor, a longer hold, a second signal
 *
 * Not counted in either family: pure size (Z, excluded by the operator's rule "not via position
 * sizing"), re-ranking / re-architecture (R), measurements and fidelity rows (they are not levers).
 *
 * Status is the verdict of the MOST FAITHFUL surface the ledger holds for that lever, which is
 * not always the row's own outcome (a row scores a PREDICTION; e.g. cadence-60 is MISLEADING as
 * a prediction about its first surface, and the cadence rule itself holds on every later one):
 *
 *   worked   passed its bar and is armed, or stands as a candidate in shadow
 *   failed   lost on the most faithful surface
 *   dial     trades return for drawdown (or the reverse), a regime trade-off, or inconclusive
 *
 * Era: "aug" = first tested before 2026-09-05 (the foundational gate program), "sep" = after.
 *
 * Usage: node experiments/ledger_lever_audit.js [--json]
 */
const fs = require('fs');
const path = require('path');
const LEDGER = path.join(__dirname, '..', 'data', 'trading', 'prediction-ledger.jsonl');

// [family, era, status, lever, ledger rows, the number that decided it]
const LEVERS = [
  // ── W: repair a weakness ──────────────────────────────────────────────────────────────────
  ['W', 'aug', 'worked', 'entry cadence 60 (hour-boundary entries)', ['cadence-60', 'cadence-off-stable', 'oos-armed-knobs-2026-apr-jul', 'reval-part3-nine-windows'], 'removing it: 10.00 -> 7.59% at maxDD 2.49 -> 4.16 (Apr-Jul); cadence 30 3-5, 120 3-6 over nine windows'],
  ['W', 'aug', 'worked', 'T2 entry confirmation', ['t2-engine', 't2-stable-arm', 'armed-stack-faithful', 'confirm-off-stable'], 'removing it: 5.83 -> 3.33% at maxDD 0.96 -> 2.56 (60 sessions); 4.34 -> 0.48% on Jun-Aug'],
  ['W', 'aug', 'failed', 'T1 confirmation (one rising close)', ['t1-worse'], 'worse than no confirmation (-1.03%)'],
  ['W', 'aug', 'worked', 'morning gate 0.12', ['morning-darkness', 'reval-core-thresholds-nine-windows'], 'gate off: h2 +40.0 -> +22.0; holds over nine windows'],
  ['W', 'aug', 'worked', 'weekend flat', ['weekend-flat', 'weekend-flat-arm', 'weekend-hold-stable', 'weekendhold-floor15-oor'], 'live net +$3,248 over two weekends; hold loses 1-3 out of regime at maxDD 9.3 (costs 6-8pp in the bull tape)'],
  ['W', 'aug', 'worked', 'end-of-day decarry of 3x names', ['carry-2x2', 'decarry-live-arm', 'decarry-off-stable'], 'live net +$2,813 in 5 sessions; off: 4.34 -> 1.93% at maxDD 0.57 -> 2.67 (Jun-Aug)'],
  ['W', 'aug', 'worked', 'inverse-SPY gate', ['armed-stack-faithful', 'loose-stable-entry-gates'], 'removing it: 5.83 -> 4.33% at maxDD 0.96 -> 1.88'],
  ['W', 'aug', 'worked', 'falling-knife veto', ['knife-macd-artifact'], 'return/maxDD 1.02 -> 2.19 on the real feed'],
  ['W', 'aug', 'failed', 'entry judge as a blocking gate', ['judge-gate'], 'approves 40% WR, rejects 69% WR'],
  ['W', 'aug', 'dial', 'P_MIN 0.50 floor', ['pmin-050'], 'unmeasurable live (refusals not journaled)'],
  ['W', 'aug', 'failed', 'leveraged concurrency cap', ['levcap-cap2'], '4.94 -> 4.04%, h1 flips negative'],
  ['W', 'aug', 'failed', 'tape exit (adverse-extremes early exit)', ['tape-exit'], '5.60 -> 1.42%, maxDD doubled'],
  ['W', 'sep', 'failed', 'regime size dial (quarter size on weak opens)', ['regime-size', 'regime-dial-on-race', 'race-regime-dial-arm', 'regime-dial-leave-one-out-repaired'], 'forfeited ~$6,800 of a +$10,009 live period; every leave-one-out raises return at flat drawdown'],
  ['W', 'sep', 'failed', 'entry stagger', ['entry-stagger'], '5.80 -> 4.15%, maxDD unchanged'],
  ['W', 'sep', 'failed', 'zone ladder re-added (early banking)', ['zone-ladder-under-stack'], '5.80 -> 2.64%, maxDD 0.96 -> 2.44'],
  ['W', 'sep', 'failed', 'lower trail arm (bank small gains)', ['trail-arm-sweep'], '10.93 -> 10.6%, maxDD worse'],
  ['W', 'sep', 'failed', 'tighter generator (deeper washouts only)', ['generator-tighter-stable', 'reval-core-thresholds-nine-windows'], 'monotone decline 5.83 -> 1.09%; IBS 0.25 = 36.1% vs 48.9% over nine windows'],
  ['W', 'sep', 'failed', 'entry-time separator (refuse a losing bucket)', ['entry-separator-study'], 'no robust negative bucket in 197 trades'],
  ['W', 'sep', 'worked', 'race sleeve without the 3x index longs', ['race-minus-3x-index-longs', 'oos-engine-r-knobs'], 'putting them back costs -4.46 / -4.56pp on two out-of-sample windows'],
  ['W', 'sep', 'dial', 'late entry block 15:00-16:00', ['late-block-15-stable', 'reval-armed-knobs-nine-windows'], '-0.42pp for +8pp positive weeks on one window; a wash over nine'],
  ['W', 'sep', 'dial', 'race sleeve: no Friday entries', ['race-no-friday-entries', 'race-friday-enter-flat'], 'race replay +0.37pp with WR 71 -> 76; live row open'],
  ['W', 'sep', 'failed', 'carry-loser rules (close the underwater at the close)', ['carry-loser-rules'], '16.39 -> 12.18%, drawdown worse'],
  ['W', 'sep', 'dial', 'overnight 3x trim', ['overnight-3x-trim-curve', 'engine-overnight-trim-50'], 'linear: each quarter trimmed costs ~1.8pp for ~0.5pp of drawdown'],
  ['W', 'sep', 'dial', 'weekend inverse flatten', ['weekend-inverse-flatten'], 'zero-fire in replay; unmeasured'],
  ['W', 'sep', 'failed', 'one-day cooldown after a stop', ['harness-stop-fill-fidelity', 'engine-r-cooldown-off', 'oos-engine-r-knobs'], 'costs the race brain 3.15pp per 60 sessions and buys zero drawdown'],
  ['W', 'sep', 'failed', 'metals bucket cap', ['metals-bucket-cap-2', 'metals-bucket-cap-oos'], 'helps Q1 (+0.73pp), hurts Apr-Jul (-0.72pp at +0.97 maxDD)'],
  ['W', 'sep', 'failed', 'race stop width 2 / 4 / 5%', ['engine-r-stop-width'], '16.64 -> 14.98 / 13.61 / 11.58%'],
  ['W', 'sep', 'failed', 'signal-exit P&L floor (hold a losing bounce exit)', ['oos-signal-exit-floor'], '10.00 -> 6.97% at maxDD 2.49 -> 4.07 out of sample'],
  ['W', 'sep', 'failed', 'static knobs as protectors of a losing quarter', ['q4-2025-losing-tape-knobs', 'regime-protection-sweep'], 'nothing turns Q4 2025 positive; each protector taxes the trending window 1-3pp'],
  ['W', 'sep', 'failed', 'adaptive depth keyed to the SPY trend', ['adaptive-washout-depth'], 'Jul-Sep 17.83 -> 11.17% for 0.1pp of protection'],
  ['W', 'sep', 'dial', 'adaptive depth keyed to trailing P&L', ['adaptive-trailing-pnl-depth', 'adaptive-depth-oos-2025', 'oos-2024-armed-24-and-depth', 'adaptive-depth-020-nine-windows', 'engine-full-size-adaptive'], '0.20: net -0.02pp over nine windows, maxDD lower on five; 0.15: -2.2pp; shadow live, due 2026-10-10'],
  ['W', 'sep', 'dial', 'regime-conditional env responses', ['regime-env-responses'], 'slots 6 -> 3 while deep: Q4 +1.45pp, Q1 -1.07pp'],
  ['W', 'sep', 'failed', 'adaptive depth + afternoon block while deep', ['adaptive-depth-plus-afternoon-block'], 'Apr-Jul 9.85 -> 4.28%'],
  ['W', 'sep', 'failed', 'engine regime responses (race slots 5 -> 2 while deep)', ['engine-regime-responses'], 'rescues the two worst quarters, Q3-25 -1.42 -> -2.83'],
  ['W', 'sep', 'failed', 'per-name throttle', ['adaptive-symbol-throttle'], '48.86 -> 30.77% over nine windows'],
  ['W', 'sep', 'failed', 'leveraged wrapper needs its underlying to confirm', ['leveraged-underlying-confirm'], '4-5 over nine windows, 48.86 -> 47.52%'],
  ['W', 'sep', 'failed', 'max hold 1-2 sessions', ['round6-anatomy-variants'], 'max hold 1: 0-3; max hold 2: no effect'],
  ['W', 'sep', 'failed', 'Friday entry cut-offs on stable', ['round6-anatomy-variants'], 'no Friday entries 1-4 (-2.1pp); from 12:00 2-5'],
  ['W', 'sep', 'dial', 'universe without the leveraged index wrappers', ['round6-anatomy-variants'], '4-4 (+1.6pp), maxDD ok 6/9'],
  ['W', 'sep', 'worked', 'leveraged index wrappers enter only from 13:00', ['round6-anatomy-variants', 'lev-index-from-13-oor', 'lev-index-from-13-knob'], '9 wins, 2 losses, 2 flat over 13 windows; maxDD ok 12/13; shadow live, due 2026-10-17'],
  ['W', 'sep', 'failed', 'washout breadth gate', ['washout-breadth-gate'], 'every cap loses: 51.05 -> 20.7 .. 47.6% over 13 windows'],
  ['W', 'sep', 'failed', 'stable timing rules on the race sleeve', ['engine-r-timing-stack'], '42.33 -> 16.87 / 11.96 / 9.36% over 13 windows'],
  ['W', 'sep', 'dial', 'prune TLT', ['prune-tlt'], '+0.38pp / +0.01pp'],
  ['W', 'sep', 'dial', 'selective polarity gate on inverse wrappers', ['polarity-modes-stop-harness', 'oos-polarity-modes'], 'costs ~3pp on a strong window, trims 0.9pp of the losing quarter'],

  // ── S: extend a strength ──────────────────────────────────────────────────────────────────
  ['S', 'aug', 'worked', 'wider admission IBS 0.15 -> 0.30', ['ibs-030', 'generator-tighter-stable', 'reval-core-thresholds-nine-windows'], '0.30 = 48.9% vs 0.25 = 36.1% and 0.35 = 41.1% over nine windows (the first live read was REVERSED)'],
  ['S', 'aug', 'worked', 'hour block 13:30-14:30 removed', ['hourblock-off'], 'leave-one-out: block back = 5.33 vs 5.83%; live n=5 too small'],
  ['S', 'aug', 'dial', 'slots 5 -> 6', ['cap6'], 'neutral: 5.72 vs 5.83%, maxDD identical'],
  ['S', 'sep', 'failed', 'deep-washout cadence bypass', ['deep-washout-bypass'], '+29% trades, 5.80 -> 5.25%, h1 +5.75 -> +0.08'],
  ['S', 'sep', 'worked', 'step floor 0.5 -> 1.0 (let the winner run)', ['step-floor-1pct-stable', 'oos-armed-knobs-2026-apr-jul', 'reval-part3-nine-windows'], '+1.09pp / +0.46pp on two windows, +0.95pp out of sample, +5.0pp vs 0.75 over nine'],
  ['S', 'sep', 'dial', 'step floor 1.5', ['reval-part3-nine-windows', 'weekendhold-floor15-oor'], '9-3 over 13 windows but the worst window got worse (maxDD 6.43 -> 9.46)'],
  ['S', 'sep', 'failed', 'bounce exit level 0.7 / 0.8 (hold for a fuller bounce)', ['ibs-exit-level-stable'], '4.34 -> 4.26 / 3.60%'],
  ['S', 'sep', 'failed', 'cadence off (recycling)', ['cadence-off-stable'], '4.34 -> 2.30%, maxDD 0.57 -> 2.11'],
  ['S', 'sep', 'failed', 'confirmation off', ['confirm-off-stable'], '4.34 -> 0.48%, maxDD 0.57 -> 3.03 (Jun-Aug)'],
  ['S', 'sep', 'dial', 'decarry off (carry 3x overnight)', ['decarry-off-stable', 'reval-part3-nine-windows', 'gap-fill-sensitivity-carries'], '4-3 over nine windows (+3.8pp under close fills), maxDD ok 6/9'],
  ['S', 'sep', 'failed', 'weekend hold', ['weekend-hold-stable', 'reval-part3-nine-windows', 'weekendhold-floor15-oor'], '5-3 in 2024-26 (+8pp), 1-3 out of regime with maxDD 9.3'],
  ['S', 'sep', 'failed', 'looser entry gates (IBS 0.35 / 0.40, morning 0.20 / 0.30, 8 slots)', ['loose-stable-entry-gates', 'reval-core-thresholds-nine-windows'], 'IBS 0.35 = 41.1% vs 48.9% over nine windows, drawdown up'],
  ['S', 'sep', 'failed', 'universe + 24 liquid ETFs as one block', ['universe-expansion-24'], '3.51 -> 3.25% and 1.41 -> 0.19%: displacement'],
  ['S', 'sep', 'worked', 'commodities USO XOP GDX SLV XLE', ['stable-plus-commodities-5', 'oos-window-2026-apr-jul', 'oos-2025-armed-24', 'oos-2024-armed-24-and-depth', 'out-of-regime-2022-2023', 'consistency-map-2016-2024'], 'with the wrappers: 16 names 11.8% -> 24 names 51.1% over 13 windows; the 24 beat the 16 on 13 of 14 windows'],
  ['S', 'sep', 'worked', 'leveraged commodity longs NUGT JNUG UCO', ['universe-leveraged-commodity-long', 'universe-leveraged-commodity-3', 'oos-decompose-21-vs-24'], '+2.95pp / +0.91pp on two windows; all of the Apr-Jul gain (+3.1pp)'],
  ['S', 'sep', 'worked', 'additive commodities sleeve (own slots)', ['additive-commodities-sleeve'], '+0.85pp / +0.4pp at 2@6 with the base trade count kept'],
  ['S', 'sep', 'failed', 'second commodity family (UNG GDXJ XME COPX DBA URA SIL)', ['universe-commodity-family-2', 'commodity-family-2-per-name-long-history'], 'Aug +1.75pp, Sept -0.36pp at maxDD +0.48'],
  ['S', 'sep', 'failed', 'inverse commodity wrappers', ['universe-leveraged-commodity-inverse'], 'return up, maxDD doubles on both windows'],
  ['S', 'sep', 'failed', 'international family', ['universe-international-family'], '-0.37pp / -0.59pp'],
  ['S', 'sep', 'dial', 'XME', ['universe-xme', 'engine-s-xme', 'oos2-window-2026-q1'], '+0.64 / +0.31pp in sample, 5.37 -> 4.14% on Q1 2026'],
  ['S', 'sep', 'failed', 'race sleeve + commodities', ['engine-r-commodities-5', 'live-engine-r-commodities-5'], 'a 5-6% drawdown regime out of sample against 1.3% without them'],
  ['S', 'sep', 'failed', 'race sleeve + commodity wrappers', ['engine-r-wrappers-3'], 'maxDD 1.32 -> 5.99 out of sample'],
  ['S', 'sep', 'failed', 'strength (momentum) sleeve', ['strength-sleeve-r1', 'strength-momentum-exits'], 'alone 0.50% at maxDD 7.69; in the blend it costs 1.3-3.3pp'],
  ['S', 'sep', 'dial', 'Friday afternoon inverse strength entry', ['race-friday-inverse-only', 'race-friday-pm-inverse-strength'], 'the whole gain is four TZA trades'],
  ['S', 'sep', 'dial', 'race + TZA', ['race-plus-tza'], 'replay +2.07pp, first half only; live row open'],
  ['S', 'sep', 'worked', 'race stop cooldown removed', ['engine-r-cooldown-off', 'oos-engine-r-knobs'], '+2.75pp on Jun-Aug; +4.37 / +2.74pp out of sample'],
  ['S', 'sep', 'worked', 'regime size dial removed', ['regime-dial-leave-one-out-repaired', 'stable-combo-floor-regime', 'oos-armed-knobs-2026-apr-jul'], '+0.34pp stable, +0.82pp engine at flat drawdown'],
  ['S', 'sep', 'failed', 'race entry depth 0.15 -> 0.20 / 0.25', ['loose-engine-r-ibs', 'engine-r-timing-stack'], '42.33 -> 32.56% over 13 windows (3-9)'],
  ['S', 'sep', 'failed', 'race gates looser', ['loose-engine-r-gates'], 'persistence off 16.64 -> 15.86%'],
  ['S', 'sep', 'dial', 'polarity top (inverse entries at the session top of the underlying)', ['polarity-modes-stop-harness', 'oos-polarity-modes'], 'beats selective by 2pp on Apr-Jul, loses September and Q4'],
];

const rows = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
const byId = new Map(rows.map((r) => [r.id, r]));
const missing = [];
for (const L of LEVERS) for (const id of L[4]) if (!byId.has(id)) missing.push(`${L[3]}: ${id}`);
if (missing.length) { console.error('rows named by the audit that the ledger does not hold:\n  ' + missing.join('\n  ')); process.exit(1); }

const used = new Set(LEVERS.flatMap((L) => L[4]));
const tally = {};
for (const [fam, era, status] of LEVERS) {
  for (const k of [`${fam}/all`, `${fam}/${era}`]) { tally[k] = tally[k] || { worked: 0, failed: 0, dial: 0 }; tally[k][status]++; }
}
const rate = (t) => (t.worked + t.failed ? Math.round(100 * t.worked / (t.worked + t.failed)) : null);
const out = { made: new Date().toISOString().slice(0, 10), ledger_rows: rows.length, rows_cited: used.size, levers: LEVERS.length, tally: Object.fromEntries(Object.entries(tally).map(([k, t]) => [k, { ...t, decided: t.worked + t.failed, hit_rate_pct: rate(t) }])) };

if (process.argv.includes('--json')) { console.log(JSON.stringify(out)); process.exit(0); }
console.log(`ledger ${rows.length} rows, ${used.size} cited, ${LEVERS.length} distinct levers\n`);
console.log('| family | era | worked | failed | dial / open | hit rate of the decided |');
console.log('|---|---|---|---|---|---|');
for (const fam of ['W', 'S']) for (const era of ['aug', 'sep', 'all']) {
  const t = tally[`${fam}/${era}`] || { worked: 0, failed: 0, dial: 0 };
  console.log(`| ${fam === 'W' ? 'repair a weakness' : 'extend a strength'} | ${era} | ${t.worked} | ${t.failed} | ${t.dial} | ${rate(t) == null ? '-' : rate(t) + '%'} |`);
}
for (const fam of ['W', 'S']) {
  console.log(`\n${fam === 'W' ? 'REPAIR A WEAKNESS' : 'EXTEND A STRENGTH'} - what worked`);
  for (const L of LEVERS.filter((x) => x[0] === fam && x[2] === 'worked')) console.log(`  [${L[1]}] ${L[3]}: ${L[5]}`);
}
