'use strict';
/**
 * score_predictions.js — the instrument-accountability loop (operator, 2026-08-31):
 * "our backtests often tell the opposite of what actually happens — we can't know
 *  how many good fixes we rejected and bad fixes we approved."
 *
 * Every lab/backtest/replay verdict that leads to an arm (or a rejection) is a
 * PREDICTION. This tool makes them falsifiable and keeps score per INSTRUMENT, so
 * "should we trust this harness for this question?" becomes a measured answer
 * instead of a feeling. Convergence records for our own tooling: claim, evidence,
 * confidence, source.
 *
 *   node experiments/score_predictions.js            # scoreboard + due checks
 *
 * Ledger: data/trading/prediction-ledger.jsonl — one JSON object per line:
 *   { id, made, instrument, change, prediction, outcome, evidence?, scored?,
 *     metric?: {kind, box, since}, horizon_sessions?, due? }
 * outcome: CONFIRMED | REVERSED | MISLEADING | INVALIDATED_BY_FIDELITY |
 *          INCONCLUSIVE | OPEN
 *
 * Auto-computable metric kinds (from the live journals; everything else is
 * "manual" and just listed when due):
 *   carry_exit_pnl_sum — sum of exit P&L on positions held overnight since `since`
 *   median_entry_mae   — median mae_pct across exits since `since`
 *   day_pnl_sum        — sum of all exit P&L since `since`
 *
 * Journal paths (override with env when the deploy layout differs):
 *   PRED_STABLE_JOURNAL / PRED_RACE_JOURNAL
 */
const fs = require('fs');
const path = require('path');

const LEDGER = path.join(__dirname, '..', 'data', 'trading', 'prediction-ledger.jsonl');
const JOURNALS = {
  stable: process.env.PRED_STABLE_JOURNAL || 'C:/dev/lantern-os-stable/data/lantern-garage/trading/autopilot-trades.jsonl',
  race: process.env.PRED_RACE_JOURNAL || 'C:/dev/lantern-race/data/lantern-garage/trading/autopilot-trades.jsonl',
};

const ET = (iso) => new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York' }));
const DAY = (iso) => ET(iso).toLocaleDateString('en-CA');

function loadJournal(box) {
  try {
    return fs.readFileSync(JOURNALS[box], 'utf8').trim().split('\n')
      .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
      .filter(Boolean);
  } catch (_e) { return null; }
}

/** Exits since a date, each tagged overnight/intraday by joining to the prior
 *  entry for the symbol (same convention as the 2x2 decomposition analyses). */
function exitsSince(box, since) {
  const rows = loadJournal(box);
  if (!rows) return null;
  const lastEntry = {}; const out = [];
  for (const r of rows) {
    if (!r.ts) continue;
    if (r.event === 'entry' && r.symbol) { lastEntry[r.symbol] = r.ts; continue; }
    if (r.event === 'exit' && r.pnl != null) {
      const e = lastEntry[r.symbol]; delete lastEntry[r.symbol];
      if (DAY(r.ts) < since) continue;
      out.push({ pnl: r.pnl, mae: r.mae_pct, overnight: e ? DAY(e) !== DAY(r.ts) : true, entryDay: e ? DAY(e) : null });
    }
  }
  return out;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

function computeMetric(m) {
  if (!m || m.kind === 'manual') return null;
  let ex = exitsSince(m.box || 'stable', m.since || '2026-09-01');
  if (!ex) return { error: `journal for ${m.box} unreadable` };
  // entered_since: true — count only trades ENTERED on/after `since`. An exit
  // after the arm whose entry predates it carries the OLD config's decision;
  // for entry-side changes that contamination flips medians (the median_entry_mae
  // check on t2-engine read −0.05% clean vs −0.23% contaminated). Exit-side rules
  // (decarry, weekend-flat) keep the default exit-day frame — an old position
  // exited under the new rule IS the rule's effect. Opt-in so the 17 already-
  // scored rows keep the semantics they were scored under.
  if (m.entered_since) ex = ex.filter((x) => x.entryDay && x.entryDay >= (m.since || '2026-09-01'));
  if (m.kind === 'carry_exit_pnl_sum') {
    const s = ex.filter((x) => x.overnight);
    return { value: `$${s.reduce((a, x) => a + x.pnl, 0).toFixed(0)} across ${s.length} carry exits` };
  }
  if (m.kind === 'median_entry_mae') {
    const s = ex.filter((x) => x.mae != null);
    return { value: `${median(s.map((x) => x.mae)).toFixed(2)}% median MAE across ${s.length} exits` };
  }
  if (m.kind === 'day_pnl_sum') {
    return { value: `$${ex.reduce((a, x) => a + x.pnl, 0).toFixed(0)} across ${ex.length} exits` };
  }
  return { error: `unknown metric kind ${m.kind}` };
}

(function main() {
  const rows = fs.readFileSync(LEDGER, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
  const today = DAY(new Date().toISOString());

  // ── instrument scoreboard ──────────────────────────────────────────────────
  const by = {};
  for (const r of rows) {
    const b = (by[r.instrument] = by[r.instrument] || { n: 0, ok: 0, bad: 0, open: 0, other: 0 });
    b.n++;
    if (r.outcome === 'CONFIRMED') b.ok++;
    else if (r.outcome === 'REVERSED' || r.outcome === 'MISLEADING' || r.outcome === 'INVALIDATED_BY_FIDELITY') b.bad++;
    else if (r.outcome === 'OPEN') b.open++;
    else b.other++;
  }
  console.log('INSTRUMENT SCOREBOARD — resolved predictions only ("bad" = reversed/misleading/fidelity-invalidated)\n');
  console.log('  instrument            n   confirmed  bad  open  hit-rate(resolved)');
  for (const [k, b] of Object.entries(by).sort((a, z) => z[1].n - a[1].n)) {
    const resolved = b.ok + b.bad;
    console.log(`  ${k.padEnd(20)}${String(b.n).padStart(3)}${String(b.ok).padStart(9)}${String(b.bad).padStart(7)}${String(b.open).padStart(6)}   ${resolved ? Math.round(100 * b.ok / resolved) + '%' : '—'}`);
  }

  // ── open predictions + due checks ──────────────────────────────────────────
  console.log('\nOPEN PREDICTIONS');
  for (const r of rows.filter((x) => x.outcome === 'OPEN')) {
    const due = r.due ? (r.due <= today ? 'DUE NOW' : `due ${r.due}`) : 'no due date';
    console.log(`\n  [${r.id}] (${r.instrument}) ${due}`);
    console.log(`    change:     ${r.change}`);
    console.log(`    prediction: ${r.prediction}`);
    const m = computeMetric(r.metric);
    if (m) console.log(`    live so far: ${m.value || m.error}`);
  }
  console.log('\nScoring rule: when a prediction is due, set outcome + evidence + scored date in the ledger.');
  console.log('An instrument below ~50% on a question class is NOT an instrument for that class — use a live shadow or A/B instead.');
})();
