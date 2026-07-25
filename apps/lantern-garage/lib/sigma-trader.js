'use strict';

/**
 * sigma-trader.js — the long-horizon "Sigma Trader" allocation engine, live on the
 * PAPER Alpaca account (ADR-0027 broker, ADR-0028 governance). Loop stage: Act,
 * but slow-and-diversified, NOT a day-trader.
 *
 * This is the deployment of the backtested Champion (now the Sigma Trader) (experiments/dca_champion_2k.py):
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
 *     caller explicitly arms it AND the operator set SIGMA_ARM=1. "A person always
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
const LEDGER = path.join(__dirname, '..', 'data', 'lantern-garage', 'trading', 'sigma-trader.jsonl');
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
 *   target$_i = equity · gross · weight_i   (gross clamped [0, MAX_GROSS])
 */
function computeRebalance({ equity, gross, weights, prices, positions = [], bandPct = DEFAULT_BAND_PCT }) {
  const g = Math.max(0, Math.min(MAX_GROSS, Number(gross) || 0));
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
  return { orders, targets, grossUsed: g, equity: eq };
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

// ── gross mode + financing accounting (23y walk-forward evidence, 2026-07-25) ──
// Re-measured with REAL financing (Fed Funds + IBKR's 1.5% spread, ACT/360): the
// static-2× book beat SPY on BOTH CAGR and Sharpe (17.6%/0.79 vs 11.1%/0.66) — the
// old "leverage doesn't pay" verdict was an artifact of pricier financing assumptions.
// The brake (0–2×) stays the DEFAULT (best Sharpe 0.96, DD −20%); '2x' is opt-in and,
// like everything here, paper-gated. Financing/cash-yield are ACCOUNTED in the ledger
// so the paper track record is honest — un-modeled financing would overstate a levered
// book by the full borrow cost.
function grossMode() {
  const m = String(process.env.SIGMA_GROSS_MODE || 'brake').toLowerCase();
  return (m === '1x' || m === '2x' || m === 'brake') ? m : 'brake';
}
function grossFor(mode) {
  if (mode === '1x') return 1.0;
  if (mode === '2x') return 2.0;
  return _liveGross();                                    // brake (default)
}
/** Benchmark (Fed Funds) rate %, cached daily from FRED's keyless CSV; env override
 *  SIGMA_BENCHMARK_RATE wins; falls back to the last-good/4.5% if offline. */
let _bmCache = { at: 0, rate: null };
async function _benchmarkRate() {
  const env = parseFloat(process.env.SIGMA_BENCHMARK_RATE);
  if (Number.isFinite(env)) return env;
  const now = Date.now();
  if (_bmCache.rate != null && now - _bmCache.at < 24 * 3600 * 1000) return _bmCache.rate;
  try {
    const https = require('https');
    const txt = await new Promise((resolve, reject) => {
      https.get('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF', (r) => {
        let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(d));
      }).on('error', reject).setTimeout(8000, function () { this.destroy(); reject(new Error('timeout')); });
    });
    const rows = txt.trim().split('\n');
    for (let i = rows.length - 1; i > 0; i--) {
      const v = parseFloat(rows[i].split(',')[1]);
      if (Number.isFinite(v)) { _bmCache = { at: now, rate: v }; return v; }
    }
  } catch (_e) { /* offline → fall through */ }
  return _bmCache.rate != null ? _bmCache.rate : 4.5;
}
/** Daily financing/cash accounting for a gross target. Pure given the rate. */
function financingFor(gross, equity, benchmarkPct, { spreadPct = 1.5, cashHaircutPct = 0.5 } = {}) {
  const g = Math.max(0, Math.min(MAX_GROSS, Number(gross) || 0));
  if (g > 1) {
    const apr = benchmarkPct + spreadPct;                            // IBKR Pro tier ≈ BM+1.5%
    return { financing_apr: +apr.toFixed(2), est_daily_cost: +(((g - 1) * equity * apr / 100) / 360).toFixed(2), cash_yield_apr: 0 };
  }
  const yieldApr = Math.max(0, benchmarkPct - cashHaircutPct);       // idle cash earns ≈ BM−0.5%
  return { financing_apr: 0, est_daily_cost: 0, cash_yield_apr: +yieldApr.toFixed(2), est_daily_yield: +(((1 - g) * equity * yieldApr / 100) / 360).toFixed(2) };
}

// Which Alpaca account this run trades. Two modes:
//   • no userId  → the Sigma Trader's OWN dedicated account (SIGMA_ALPACA_* keys /
//     its own OAuth). The classic standalone Sigma book (scheduler, /sigma-trader).
//   • a userId   → THAT user's own connected account (Phase 2: the "Champion" trader
//     the user selected as their active strategy — runs on their own paper account).
// Either way, if the account fetch returns null the engine plans but places nothing,
// and the paper-only guard in rebalanceNow refuses any non-paper account.
const acctId = (userId) => userId || require('./alpaca-adapter').SIGMA_USER;

/**
 * Compute the current plan (weights, targets, drift orders) WITHOUT trading. Reads the
 * target account's Alpaca positions/equity, daily bars for the universe, and the brake.
 * @param {string} [userId]  run on this user's own account (Champion); omit for Sigma's.
 */
async function plan({ bandPct = DEFAULT_BAND_PCT, userId } = {}) {
  const alpaca = require('./alpaca-adapter');
  const yahoo = require('./market-data-yahoo');
  const uid = acctId(userId);
  const acct = await alpaca.getAccount(uid).catch(() => null);
  const bm = await yahoo.getBarsMulti(UNIVERSE, '1d').catch(() => ({ bars: {} }));
  const bars = (bm && bm.bars) || {};
  const closesBySym = {}; const prices = {};
  for (const s of UNIVERSE) {
    const b = (bars[s] && bars[s].bars) || [];
    closesBySym[s] = b.map((x) => x.close);
    if (b.length) prices[s] = b[b.length - 1].close;
  }
  const { weights, used, dropped } = targetWeights(closesBySym);
  const mode = grossMode();
  const gross = grossFor(mode);
  // No dedicated Sigma account yet → return the target allocation but no orders, and
  // flag it, so the UI can prompt "connect the Sigma Trader's own account".
  if (!acct) {
    const note = userId
      ? 'No Alpaca account connected for this user. Add your Alpaca paper API keys in Settings → Connections, then switch the active trader to Champion.'
      : 'The Sigma Trader has no dedicated account. Set SIGMA_ALPACA_API_KEY_ID/_SECRET (a SEPARATE Alpaca paper account) or connect one — it will not borrow the day-trader’s book.';
    return { ok: true, account: 'not_configured', equity: 0, gross, gross_mode: mode, weights, used, dropped, orders: [], targets: {}, note };
  }
  const equity = Number(acct.equity) || Number(acct.portfolio_value) || 0;
  const pos = (await alpaca.getPositions(uid).catch(() => null)) || { positions: [] };
  for (const p of pos.positions) if (p.current_price > 0) prices[String(p.symbol).toUpperCase()] = p.current_price;
  const reb = computeRebalance({ equity, gross, weights, prices, positions: pos.positions, bandPct });
  const financing = financingFor(reb.grossUsed, equity, await _benchmarkRate());
  return { ok: true, account: acct.account_id, env: acct.env || 'paper', equity, gross, gross_mode: mode, financing, weights, used, dropped, prices, positions: pos.positions, ...reb };
}

/**
 * Rebalance the Sigma Trader's OWN paper book toward the target. DRY unless BOTH
 * arm:true AND SIGMA_ARM=1. Refuses a non-paper account. Refuses entirely if no
 * dedicated Sigma account is configured (so it never touches the day-trader).
 */
async function rebalanceNow({ arm = false, bandPct = DEFAULT_BAND_PCT, maxOrders = Infinity, userId } = {}) {
  const p = await plan({ bandPct, userId });
  if (!p.ok) return p;
  if (p.account === 'not_configured') return { ...p, executed: false, refused: 'no_dedicated_account' };
  const armed = arm && process.env.SIGMA_ARM === '1';
  if (armed && p.env === 'live') { logLedger({ event: 'refused_live', equity: p.equity }); return { ...p, executed: false, refused: 'live_account_forbidden' }; }
  if (!armed) { logLedger({ event: 'plan_dry', equity: p.equity, gross: p.gross, weights: p.weights, orders: p.orders }); return { ...p, executed: false, dryRun: true }; }
  const alpaca = require('./alpaca-adapter');
  const uid = acctId(userId);
  const results = [];
  for (const o of p.orders.slice(0, maxOrders)) {
    // Free shares reserved by resting orders before a sell (defensive — on its own
    // account there should be none, but a prior partial rebalance could leave some).
    let cancelled = 0;
    if (o.side === 'sell') cancelled = await alpaca.cancelOpenOrders(uid, o.symbol).catch(() => 0);
    const r = await alpaca.placeOrder(uid, { ticker: o.symbol, side: o.side, qty: o.qty, type: 'market', timeInForce: 'day' }).catch((e) => ({ status: 'error', reason: e.message }));
    results.push({ ...o, cancelledResting: cancelled, status: r && r.status, order_id: r && r.order_id, reason: r && r.reason });
  }
  logLedger({ event: 'rebalance', account: p.account, equity: p.equity, gross: p.gross, gross_mode: p.gross_mode, financing: p.financing, weights: p.weights, orders: results });
  return { ...p, executed: true, results };
}

module.exports = { UNIVERSE, solve, tangencyDir, targetWeights, computeRebalance, plan, rebalanceNow, _liveGross, grossMode, grossFor, financingFor, LEDGER, MAX_GROSS };
