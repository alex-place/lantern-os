'use strict';
/**
 * walk-forward.js — a reusable IS-WFA-OOS strategy-validation harness (#2582).
 *
 * experiments/trader_walkforward.js proves the signal engine has no look-ahead bar-by-bar, but
 * it optimizes and reports on ONE window — so a stop-width sweep picked on the whole sample is
 * still in-sample fitting. The honest question a strategy must answer before capital is
 * "does a rule chosen on the PAST hold up on data it never saw", and the standard answer is
 * walk-forward analysis: split the series into sequential folds, OPTIMIZE parameters on each
 * fold's in-sample (IS) segment, then measure ONLY on the immediately-following out-of-sample
 * (OOS) segment the optimizer never touched. Concatenating the OOS segments gives the one honest
 * track record; Walk-Forward Efficiency (OOS score / IS score) says how much of the fitted edge
 * survives contact with unseen data.
 *
 * This module is the engine, decoupled from any specific strategy or data source: bars, the
 * `simulate(bars, params) -> trades` function, the param grid, and the objective are all
 * injected, so the same harness validates the stock autopilot, a Kalshi rule, or a synthetic
 * toy. No network, no broker, no app import — pure and unit-testable.
 *
 * A trade is { retPct } at minimum (fractional/percent return net of costs); `R` (return in
 * risk units) is used when present. The caller's `simulate` owns entry/exit/cost logic and the
 * no-look-ahead guarantee WITHIN a segment; this harness owns the no-look-ahead guarantee ACROSS
 * folds (an OOS segment is always strictly after the IS window it was validated against).
 */

/** Aggregate metrics over a list of trades. Pure; empty-safe. */
function metrics(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winRate: 0, expectancyPct: 0, avgR: 0, profitFactor: 0, sharpe: 0, maxDDpct: 0, totalReturnPct: 0 };
  const rets = trades.map((t) => Number(t.retPct) || 0);
  const wins = rets.filter((r) => r > 0);
  const gW = wins.reduce((s, r) => s + r, 0);
  const gL = rets.filter((r) => r < 0).reduce((s, r) => s + r, 0);
  const hasR = trades.every((t) => typeof t.R === 'number' && isFinite(t.R));
  // equity: compound 1% of equity per trade by R when available, else by retPct
  let eq = 1, peak = 1, mdd = 0;
  for (const t of trades) {
    eq *= (1 + 0.01 * (hasR ? t.R : (Number(t.retPct) || 0)));
    peak = Math.max(peak, eq);
    mdd = Math.min(mdd, eq / peak - 1);
  }
  const mean = rets.reduce((s, r) => s + r, 0) / n;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / n) || 1e-9;
  return {
    n,
    winRate: +(wins.length / n * 100).toFixed(2),
    expectancyPct: +(mean * 100).toFixed(4),
    avgR: hasR ? +(trades.reduce((s, t) => s + t.R, 0) / n).toFixed(4) : null,
    // profit factor: gross wins / |gross losses|. No losses AND some wins → Infinity (flagged).
    profitFactor: gL < 0 ? +(gW / Math.abs(gL)).toFixed(3) : (gW > 0 ? Infinity : 0),
    sharpe: +((mean / sd) * Math.sqrt(252)).toFixed(3),   // per-trade Sharpe proxy, annualized
    maxDDpct: +(mdd * 100).toFixed(2),
    totalReturnPct: +((eq - 1) * 100).toFixed(2),
  };
}

/**
 * Build the sequential IS/OOS fold boundaries over `total` bars.
 *
 * @param anchored  true  → IS always starts at 0 and GROWS each fold (anchored WFA);
 *                  false → IS is a fixed-width window that SLIDES (rolling WFA).
 * Folds march forward by `oosBars` so the OOS segments TILE the series with no overlap and no
 * gaps — every out-of-sample bar is scored exactly once.
 * @returns [{ isStart, isEnd, oosStart, oosEnd }] with [start,end) half-open indices.
 */
function makeFolds(total, isBars, oosBars, anchored) {
  if (!Number.isInteger(total) || total <= 0) throw new Error('walkForward: need a positive bar count');
  if (isBars <= 0 || oosBars <= 0) throw new Error('walkForward: isBars and oosBars must be positive');
  const folds = [];
  let oosStart = isBars;
  while (oosStart + oosBars <= total) {
    const isStart = anchored ? 0 : oosStart - isBars;
    folds.push({ isStart, isEnd: oosStart, oosStart, oosEnd: oosStart + oosBars });
    oosStart += oosBars;
  }
  return folds;
}

/**
 * Run walk-forward analysis.
 *
 * @param {object} cfg
 *   bars      {Array}    the full ordered series (any shape `simulate` understands)
 *   grid      {Array}    candidate parameter objects to optimize over on each IS window
 *   simulate  {function} (barsSlice, params) => trades[]  — the strategy under test
 *   score     {function} (metrics) => number — the objective maximized on IS (default: sharpe)
 *   isBars    {number}   in-sample window length (bars)
 *   oosBars   {number}   out-of-sample window length (bars)
 *   anchored  {boolean}  anchored (growing IS) vs rolling (sliding IS); default true
 *   gates     {object}   pre-committed pass thresholds (see DEFAULT_GATES)
 * @returns {object} { folds, oos, wfe, gate, config } — `oos` is metrics over the concatenated
 *   OOS trades (the honest track record); `wfe` is the walk-forward efficiency summary.
 */
function walkForward(cfg) {
  const {
    bars, grid, simulate,
    score = (m) => m.sharpe,
    isBars, oosBars, anchored = true,
    gates = {},
  } = cfg || {};
  if (!Array.isArray(bars)) throw new Error('walkForward: bars must be an array');
  if (!Array.isArray(grid) || !grid.length) throw new Error('walkForward: grid must be a non-empty array');
  if (typeof simulate !== 'function') throw new Error('walkForward: simulate must be a function');

  const G = { ...DEFAULT_GATES, ...gates };
  const folds = makeFolds(bars.length, isBars, oosBars, anchored);
  const allOos = [];
  const foldReports = [];

  for (const f of folds) {
    const isSlice = bars.slice(f.isStart, f.isEnd);
    // Optimize on IS ONLY: score every grid point, keep the best. Ties → first (stable).
    let best = null;
    for (const params of grid) {
      const m = metrics(simulate(isSlice, params));
      const s = score(m);
      if (best === null || s > best.score) best = { params, score: s, isMetrics: m };
    }
    // Evaluate the chosen params on the OOS segment the optimizer never saw.
    const oosSlice = bars.slice(f.oosStart, f.oosEnd);
    const oosTrades = simulate(oosSlice, best.params);
    const oosMetrics = metrics(oosTrades);
    allOos.push(...oosTrades);
    // Walk-forward efficiency for this fold: how much of the IS edge survived OOS.
    const isScore = best.score;
    const oosScore = score(oosMetrics);
    foldReports.push({
      window: f,
      chosenParams: best.params,
      isScore: +Number(isScore).toFixed(4),
      oosScore: +Number(oosScore).toFixed(4),
      wfe: isScore > 0 ? +(oosScore / isScore).toFixed(3) : null,
      oos: oosMetrics,
    });
  }

  const oos = metrics(allOos);
  const wfes = foldReports.map((r) => r.wfe).filter((x) => x !== null && isFinite(x));
  const avgWfe = wfes.length ? +(wfes.reduce((s, x) => s + x, 0) / wfes.length).toFixed(3) : null;
  const wfe = {
    perFold: foldReports.map((r) => r.wfe),
    avg: avgWfe,
    // consistency: fraction of folds whose OOS score stayed positive — a cliff even at high avg
    // WFE means the edge is a few lucky folds, not a robust rule.
    positiveOosFraction: foldReports.length
      ? +(foldReports.filter((r) => r.oosScore > 0).length / foldReports.length).toFixed(3) : null,
  };

  const gate = evalGates({ folds: foldReports, oos, wfe }, G);
  return { folds: foldReports, oos, wfe, gate, config: { isBars, oosBars, anchored, nFolds: folds.length, gates: G } };
}

// Pre-committed gates — a strategy passes walk-forward only if ALL hold. Stated up front so a
// disappointing run can't move the goalposts (the same discipline the Σ₀ eval ledger imposes).
const DEFAULT_GATES = {
  minFolds: 3,             // too few OOS windows and WFE is noise, not evidence
  minAvgWfe: 0.5,          // at least half the in-sample edge must survive out of sample
  minOosProfitFactor: 1.0, // the concatenated OOS track record must at least not lose money
  minPositiveOosFraction: 0.5, // the edge must show in a majority of folds, not one lucky one
  maxOosDrawdownPct: 25,   // OOS max drawdown ceiling (as a negative-tolerant magnitude)
};

function evalGates(r, G) {
  const checks = [
    { name: 'folds', pass: r.folds.length >= G.minFolds, got: r.folds.length, need: `>= ${G.minFolds}` },
    { name: 'avgWFE', pass: r.wfe.avg !== null && r.wfe.avg >= G.minAvgWfe, got: r.wfe.avg, need: `>= ${G.minAvgWfe}` },
    { name: 'oosProfitFactor', pass: r.oos.profitFactor >= G.minOosProfitFactor, got: r.oos.profitFactor, need: `>= ${G.minOosProfitFactor}` },
    { name: 'positiveOosFraction', pass: r.wfe.positiveOosFraction !== null && r.wfe.positiveOosFraction >= G.minPositiveOosFraction, got: r.wfe.positiveOosFraction, need: `>= ${G.minPositiveOosFraction}` },
    { name: 'oosMaxDrawdown', pass: Math.abs(r.oos.maxDDpct) <= G.maxOosDrawdownPct, got: r.oos.maxDDpct, need: `|dd| <= ${G.maxOosDrawdownPct}%` },
  ];
  return { pass: checks.every((c) => c.pass), checks };
}

module.exports = { walkForward, makeFolds, metrics, evalGates, DEFAULT_GATES };
