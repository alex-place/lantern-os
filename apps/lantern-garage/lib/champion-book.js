'use strict';

/**
 * champion-book.js — the long-horizon "Champion" allocation engine, live on the
 * PAPER Alpaca account (ADR-0027 broker, ADR-0028 governance). Loop stage: Act,
 * but slow-and-diversified, NOT a day-trader.
 *
 * This is the deployment of the backtested Champion (experiments/dca_champion_2k.py):
 * a momentum-tilted, shrunk-tangency allocation across a fixed ETF universe, scaled
 * by the streaming vol-target brake's live gross (brake-monitor.js), rebalanced with
 * a no-churn band. It composes three existing pieces:
 *   target weights  (this file, ported from tangency_dir)
 *      ×  live gross (brake-monitor.getStatus().grossTarget, 0..2×, → cash in storms)
 *      →  dollar targets  →  diff vs current Alpaca positions  →  fractional orders.
 *
 * GOVERNANCE (non-negotiable, matches ADR-0028):
 *   - PAPER ONLY. Refuses to trade a live (non-paper) Alpaca account outright.
 *   - DRY BY DEFAULT: rebalanceNow computes the plan and places NOTHING unless the
 *     caller explicitly arms it AND the operator set CHAMPION_ARM=1. "A person always
 *     decides."  Real capital stays gated on the Sharpe-CI mandate, which nothing has
 *     met — this only ever builds the paper track record the gate will one day measure.
 *   - Every rebalance is appended to a JSONL ledger so the gate can score it later.
 *
 * The math (targetWeights / tangencyDir / computeRebalance) is pure + unit-tested.
 */

const fs = require('fs');
const path = require('path');

// Fixed universe — the 8-asset momentum book (matches experiments/dca_champion_2k.py).
const UNIVERSE = ['SPY', 'QQQ', 'IWM', 'EFA', 'TLT', 'GLD', 'XMMO', 'SPMO'];
const LEDGER = path.join(__dirname, '..', 'data', 'lantern-garage', 'trading', 'champion-book.jsonl');
const MAX_GROSS = 2.0;              // hard leverage ceiling (ADR-0028 §4)
const DEFAULT_BAND_PCT = 0.6;       // don't trade a leg whose drift < this % of equity (no-churn)

// ── linear algebra (small, dependency-free) ─────────────────────────────────
/** Solve A·x = b for a small square system via Gaussian elimination w/ partial pivot. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.concat([b[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;           // singular
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

// ── the allocation (ported from tangency_dir, brake_intraday_evidence.py) ────
/**
 * Long-only shrunk-tangency direction. Shrinks off-diagonal covariance toward 0 and
 * mean returns toward their cross-sectional mean, solves cov·w = mu, clips ≥ 0,
 * normalizes to sum 1, then iteratively caps any single weight at `cap`.
 */
function tangencyDir(mu, cov, { cap = 0.35, covShrink = 0.35, muShrink = 0.5 } = {}) {
  const n = mu.length;
  const c = cov.map((row) => row.slice());
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) c[i][j] *= (1 - covShrink);
  for (let i = 0; i < n; i++) c[i][i] += 1e-10;
  const muMean = mu.reduce((s, x) => s + x, 0) / n;
  const m = mu.map((x) => muShrink * muMean + (1 - muShrink) * x);
  let w = solve(c, m) || mu.map(() => 1);
  w = w.map((x) => (x > 0 ? x : 0));
  let sum = w.reduce((s, x) => s + x, 0);
  if (sum <= 0) { w = mu.map(() => 1); sum = n; }
  w = w.map((x) => x / sum);
  const capN = Math.max(cap, 1 / n + 1e-9);
  for (let it = 0; it < 20; it++) {
    const over = w.map((x) => x > capN);
    if (!over.some(Boolean)) break;
    let excess = 0; let freeSum = 0;
    for (let i = 0; i < n; i++) { if (over[i]) { excess += w[i] - capN; w[i] = capN; } else freeSum += w[i]; }
    if (freeSum <= 0) break;
    for (let i = 0; i < n; i++) if (!over[i]) w[i] += excess * (w[i] / freeSum);
  }
  return w;
}

/** Per-asset daily returns from a closes series. */
function returnsOf(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) r.push(closes[i] / closes[i - 1] - 1);
  return r;
}

/**
 * Target weights from daily closes per symbol. mu = mean daily return × 21 (monthly),
 * cov = sample covariance × 21, over the common aligned window. Assets with < minObs
 * clean observations are dropped (no fake pre-history — matches the backtest's rule).
 * Returns { weights: {SYM: w}, used: [SYM], dropped: [SYM] }.
 */
function targetWeights(closesBySym, { minObs = 60 } = {}) {
  const rets = {}; const used = []; const dropped = [];
  for (const s of UNIVERSE) {
    const r = returnsOf((closesBySym[s] || []).filter((x) => x > 0));
    if (r.length >= minObs) { rets[s] = r; used.push(s); } else dropped.push(s);
  }
  if (used.length < 2) return { weights: {}, used, dropped };
  const L = Math.min(...used.map((s) => rets[s].length));       // common window (from the recent tail)
  const R = used.map((s) => rets[s].slice(-L));
  const mu = R.map((r) => (r.reduce((a, b) => a + b, 0) / L) * 21);
  const cov = R.map((ri) => R.map((rj) => {
    const mi = ri.reduce((a, b) => a + b, 0) / L, mj = rj.reduce((a, b) => a + b, 0) / L;
    let s = 0; for (let k = 0; k < L; k++) s += (ri[k] - mi) * (rj[k] - mj);
    return (s / (L - 1)) * 21;
  }));
  const w = tangencyDir(mu, cov);
  const weights = {}; used.forEach((s, i) => { weights[s] = Math.round(w[i] * 1e4) / 1e4; });
  return { weights, used, dropped };
}

/**
 * Given target weights, live gross, prices and current positions, produce the
 * rebalance orders. Only legs whose drift exceeds bandPct of equity are traded
 * (no-churn). Fractional shares. Pure.
 *   target$_i = equity · gross · weight_i   (gross clamped [0, min(maxGross, MAX_GROSS)])
 *
 * `maxGross` caps the leverage the live brake can request. Default MAX_GROSS (2×,
 * unchanged). Pass maxGross=1.0 for the "Conservative (no-margin)" book — it NEVER
 * borrows and only ever de-risks toward cash. Deep-history research (S&P 1927+, Nasdaq
 * 1971+; experiments/DEEP_HISTORY_RESEARCH_LOG.md) found the ≤1× cash-defensive book
 * had the best Sharpe (0.71-0.90 vs 0.42-0.60 buy&hold) and shallowest drawdown at
 * ~1 trade/month — and matches Faber/AQR/Antonacci. `maxGross` can only LOWER the
 * ceiling, never raise it above the hard MAX_GROSS.
 */
function computeRebalance({ equity, gross, weights, prices, positions = [], bandPct = DEFAULT_BAND_PCT, maxGross = MAX_GROSS }) {
  const cap = Math.max(0, Math.min(MAX_GROSS, Number.isFinite(Number(maxGross)) ? Number(maxGross) : MAX_GROSS));
  const g = Math.max(0, Math.min(cap, Number(gross) || 0));
  const eq = Number(equity) || 0;
  const held = {};
  for (const p of positions) held[String(p.symbol).toUpperCase()] = Number(p.market_value) || 0;
  const band = eq * (bandPct / 100);
  const orders = []; const targets = {};
  const syms = new Set([...Object.keys(weights), ...Object.keys(held)]);
  for (const s of syms) {
    const px = Number(prices[s]) || 0;
    const targetVal = eq * g * (weights[s] || 0);           // 0 for a name we now exclude → sell it
    const curVal = held[s] || 0;
    const diff = targetVal - curVal;
    targets[s] = Math.round(targetVal);
    if (Math.abs(diff) < band || px <= 0) continue;          // within the no-churn band → leave it
    const qty = Math.round((Math.abs(diff) / px) * 1e4) / 1e4;
    if (qty <= 0) continue;
    orders.push({ symbol: s, side: diff > 0 ? 'buy' : 'sell', qty, notional: Math.round(Math.abs(diff)) });
  }
  orders.sort((a, b) => (a.side === b.side ? 0 : a.side === 'sell' ? -1 : 1));   // sells first (free buying power)
  return { orders, targets, grossUsed: g, grossCap: cap, equity: eq };
}

function logLedger(rec) {
  try { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n'); }
  catch (_e) { /* logging must never break the engine */ }
}

// ── live orchestration ───────────────────────────────────────────────────────
function _liveGross() {
  try {
    const st = require('./brake-monitor').getStatus();
    // Brake not running / warming → unlevered (1.0), NEVER assume 2× on silence.
    return (st && typeof st.grossTarget === 'number') ? st.grossTarget : 1.0;
  } catch (_e) { return 1.0; }
}

/**
 * Compute the current plan (weights, targets, drift orders) WITHOUT trading.
 * Reads the paper Alpaca account, daily bars for the universe, and the live brake.
 */
async function plan(userId, { bandPct = DEFAULT_BAND_PCT, conservative = false, maxGross } = {}) {
  // Conservative (no-margin) mode: cap gross at 1.0 (never borrow) and widen the
  // no-churn band so the book rebalances less (deep-history research: ~1 trade/month
  // is the low-turnover optimum). Both are strict de-risking knobs.
  const cap = conservative ? 1.0 : (Number.isFinite(Number(maxGross)) ? Number(maxGross) : MAX_GROSS);
  if (conservative && bandPct === DEFAULT_BAND_PCT) bandPct = 1.5;
  const alpaca = require('./alpaca-adapter');
  const yahoo = require('./market-data-yahoo');
  const acct = await alpaca.getAccount(userId).catch(() => null);
  if (!acct) return { ok: false, reason: 'no_alpaca_account' };
  const equity = Number(acct.equity) || Number(acct.portfolio_value) || 0;
  const bm = await yahoo.getBarsMulti(UNIVERSE, '1d').catch(() => ({ bars: {} }));
  const bars = (bm && bm.bars) || {};
  const closesBySym = {}; const prices = {};
  for (const s of UNIVERSE) {
    const b = (bars[s] && bars[s].bars) || [];
    closesBySym[s] = b.map((x) => x.close);
    if (b.length) prices[s] = b[b.length - 1].close;
  }
  const { weights, used, dropped } = targetWeights(closesBySym);
  const pos = (await alpaca.getPositions(userId).catch(() => null)) || { positions: [] };
  // prefer the broker's live price for held names
  for (const p of pos.positions) if (p.current_price > 0) prices[String(p.symbol).toUpperCase()] = p.current_price;
  const gross = _liveGross();
  const reb = computeRebalance({ equity, gross, weights, prices, positions: pos.positions, bandPct, maxGross: cap });
  return { ok: true, env: acct.env || 'paper', mode: conservative ? 'conservative' : 'standard', equity, gross, weights, used, dropped, prices, positions: pos.positions, ...reb };
}

/**
 * Rebalance the paper book toward the target. DRY unless BOTH arm:true AND
 * CHAMPION_ARM=1. Refuses a non-paper account. Places fractional PAPER market orders.
 */
async function rebalanceNow(userId, { arm = false, bandPct = DEFAULT_BAND_PCT, conservative = false, maxGross } = {}) {
  // ACCOUNT SEPARATION (operator rule 2026-07-26): the Champion is an INVESTOR,
  // not a trader — like a personal investing account next to a trading account, it
  // EXECUTES only on its own dedicated identity (CHAMPION_ALPACA_* keys or a
  // connection stored under 'champion-book'). plan(userId) stays advisory on any
  // account; ORDERS never touch the traders' book.
  const alpaca = require('./alpaca-adapter');
  const armed = arm && process.env.CHAMPION_ARM === '1';
  const execUser = alpaca.CHAMPION_USER;
  if (armed && !alpaca.championAvailable()) {
    const p = await plan(userId, { bandPct, conservative, maxGross });
    logLedger({ event: 'refused_shared_account', equity: p.ok ? p.equity : null });
    return { ...(p.ok ? p : {}), ok: p.ok, executed: false, refused: 'no_dedicated_account',
      reason: 'The Champion is an investor and will not trade the traders’ account. Give it its own: CHAMPION_ALPACA_API_KEY_ID/_SECRET (a separate Alpaca paper account).' };
  }
  const p = await plan(armed ? execUser : userId, { bandPct, conservative, maxGross });
  if (!p.ok) return p;
  // Hard refuse: never trade a live account from this engine.
  if (armed && p.env === 'live') { logLedger({ event: 'refused_live', equity: p.equity }); return { ...p, executed: false, refused: 'live_account_forbidden' }; }
  if (!armed) { logLedger({ event: 'plan_dry', equity: p.equity, gross: p.gross, weights: p.weights, orders: p.orders }); return { ...p, executed: false, dryRun: true }; }
  const results = [];
  for (const o of p.orders) {
    const r = await alpaca.placeOrder(execUser, { ticker: o.symbol, side: o.side, qty: o.qty, type: 'market', timeInForce: 'day' }).catch((e) => ({ status: 'error', reason: e.message }));
    results.push({ ...o, status: r && r.status, order_id: r && r.order_id });
  }
  logLedger({ event: 'rebalance', account: 'champion-dedicated', equity: p.equity, gross: p.gross, weights: p.weights, orders: results });
  return { ...p, executed: true, results };
}

module.exports = { UNIVERSE, solve, tangencyDir, targetWeights, computeRebalance, plan, rebalanceNow, _liveGross, LEDGER, MAX_GROSS };
