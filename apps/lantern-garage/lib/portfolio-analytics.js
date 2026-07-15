"use strict";
/**
 * portfolio-analytics.js — ex-ante Sharpe / correlation analytics and a
 * covariance-aware rebalance PROPOSAL over the operator's actual holdings.
 *
 * Loop stage: Reason. Turns observed positions (trader_positions / IBKR per
 * ADR-0022) + measured daily total-return history into evidence-bearing
 * allocation analysis. It NEVER places orders — Act stays behind
 * lib/trading-guard.js and the ADR-0020 gates.
 *
 * The math applies docs/UNISONA-SHARPE-CERTIFICATE.md to the user's own
 * holdings: annualized Sharpe + Lo (2002) 95% CI (same formulas as
 * scripts/daily-backtest-harness.js), pairwise correlations (Thm 1), and a
 * shrunk tangency allocation w ∝ Σ⁻¹μ (Thm 2) under long-only + max-weight
 * constraints. Raw sample tangency is a well-known error-maximizer, so both
 * Σ and μ are shrunk before inversion, and every output carries its CI so a
 * proposal that is statistically indistinguishable from the current weights
 * can be reported as exactly that.
 *
 * HONEST SCOPE (Noise-Sorting rules):
 *  - Daily total-return history (Yahoo adjclose, dividends reinvested).
 *  - Constant-mix (daily-rebalanced) portfolio arithmetic; taxes, slippage,
 *    borrowing, and capacity are NOT modeled.
 *  - The Lo (2002) CI assumes i.i.d. returns — it is a FLOOR on uncertainty.
 *  - Every figure is historical. Backtest ≠ future performance. This module
 *    is decision support; it is not personalized investment advice.
 */

const https = require("https");
const { tickerToYahoo } = require("./market-data-yahoo");

const TRADING_DAYS = 252;
const MIN_SERIES_OBS = 60;   // exclude symbols with under ~3 months of history
const THIN_WINDOW_OBS = 126; // warn when the aligned window is under ~6 months
const HIST_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_SYMBOLS = 20;      // analysis cap (top holdings by value)

// ── daily total-return history (same source + shape as the backtest harness) ──

const _histCache = new Map(); // `${sym}|${years}` → { at, map }

function _getJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0 (KeystonePortfolio)" } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (_e) { reject(new Error("bad JSON")); } });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
  });
}

/** Map<YYYY-MM-DD, adjclose> for `symbol` over the last `years` years. */
async function fetchDailyHistory(symbol, years) {
  const yrs = Math.max(2, Math.min(10, Math.round(Number(years) || 5)));
  const raw = String(symbol || "").trim().toUpperCase();
  if (!/^[A-Z0-9.\-=^]{1,12}$/.test(raw)) throw new Error(`invalid ticker '${symbol}'`);
  const key = `${raw}|${yrs}`;
  const hit = _histCache.get(key);
  if (hit && Date.now() - hit.at < HIST_CACHE_TTL_MS) return hit.map;
  const sym = encodeURIComponent(tickerToYahoo(raw));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=${yrs}y`;
  const j = await _getJson(url);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  const ts = (r && r.timestamp) || [];
  const adj = r && r.indicators && r.indicators.adjclose && r.indicators.adjclose[0]
    && r.indicators.adjclose[0].adjclose;
  if (!Array.isArray(adj)) throw new Error(`no adjclose history for ${raw}`);
  const map = new Map();
  for (let i = 0; i < ts.length; i++) {
    if (adj[i] == null) continue;
    map.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), +adj[i]);
  }
  _histCache.set(key, { at: Date.now(), map });
  return map;
}

async function _pmap(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Fetch history for all symbols. `history` (tests / offline) is an object of
 * symbol → Map<date, px> that bypasses the network entirely.
 */
async function _fetchAll(symbols, years, history, fetchFn) {
  const seriesBySym = {};
  const excluded = [];
  await _pmap(symbols, 4, async (s) => {
    try {
      const m = history ? (history[s] || null) : await (fetchFn || fetchDailyHistory)(s, years);
      if (m && m.size >= MIN_SERIES_OBS) seriesBySym[s] = m;
      else excluded.push({ symbol: s, reason: m ? `only ${m.size} daily observations` : "no history available" });
    } catch (e) {
      excluded.push({ symbol: s, reason: e.message });
    }
  });
  return { seriesBySym, excluded };
}

// ── return alignment + statistics ─────────────────────────────────────────────

/**
 * Intersect the dates of every series, sort, and compute simple daily returns.
 * seriesBySym: { SYM: Map<YYYY-MM-DD, adjclose> }
 * → { symbols, dates (return dates, len T), returns: { SYM: number[T] } }
 */
function alignReturns(seriesBySym) {
  const symbols = Object.keys(seriesBySym);
  if (!symbols.length) return { symbols: [], dates: [], returns: {} };
  let common = null;
  for (const s of symbols) {
    const keys = new Set(seriesBySym[s].keys());
    common = common === null ? keys : new Set([...common].filter((d) => keys.has(d)));
  }
  const dates = [...common].sort();
  const returns = {};
  for (const s of symbols) {
    const px = dates.map((d) => seriesBySym[s].get(d));
    const r = [];
    for (let i = 1; i < px.length; i++) r.push(px[i - 1] > 0 ? px[i] / px[i - 1] - 1 : 0);
    returns[s] = r;
  }
  return { symbols, dates: dates.slice(1), returns };
}

function _mean(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}

function _stdev(a) {
  if (a.length < 2) return 0;
  const m = _mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

/** Annualized Sharpe + Lo (2002) 95% CI — identical math to the harness. */
function sharpeCI(dailyRets) {
  const T = dailyRets.length;
  if (T < 3) return { sharpe: 0, lo: 0, hi: 0, se: 0, obs: T };
  const sd = _stdev(dailyRets);
  const s = sd > 0 ? _mean(dailyRets) / sd : 0;
  const se = Math.sqrt((1 + (s * s) / 2) / T);
  const k = Math.sqrt(TRADING_DAYS);
  return { sharpe: s * k, lo: (s - 1.96 * se) * k, hi: (s + 1.96 * se) * k, se: se * k, obs: T };
}

/** Max drawdown of the compounded equity curve of a daily-return stream. */
function maxDrawdown(dailyRets) {
  let eq = 1, peak = 1, mdd = 0;
  for (const r of dailyRets) {
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    const dd = eq / peak - 1;
    if (dd < mdd) mdd = dd;
  }
  return mdd;
}

/** Geometric annualized return of a daily stream. */
function annualizedReturn(dailyRets) {
  const T = dailyRets.length;
  if (!T) return 0;
  const growth = dailyRets.reduce((g, r) => g * (1 + r), 1);
  return growth > 0 ? Math.pow(growth, TRADING_DAYS / T) - 1 : -1;
}

/** Pairwise Pearson correlation matrix (n×n) in `symbols` order. */
function correlationMatrix(returns, symbols) {
  const n = symbols.length;
  const out = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    out[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const a = returns[symbols[i]], b = returns[symbols[j]];
      const T = Math.min(a.length, b.length);
      const ma = _mean(a), mb = _mean(b);
      let cov = 0, va = 0, vb = 0;
      for (let t = 0; t < T; t++) {
        const da = a[t] - ma, db = b[t] - mb;
        cov += da * db; va += da * da; vb += db * db;
      }
      const rho = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
      out[i][j] = rho; out[j][i] = rho;
    }
  }
  return out;
}

/** Daily sample covariance matrix (n×n) in `symbols` order. */
function covarianceMatrix(returns, symbols) {
  const n = symbols.length;
  const means = symbols.map((s) => _mean(returns[s]));
  const out = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const a = returns[symbols[i]], b = returns[symbols[j]];
      const T = Math.min(a.length, b.length);
      if (T < 2) continue;
      let cov = 0;
      for (let t = 0; t < T; t++) cov += (a[t] - means[i]) * (b[t] - means[j]);
      cov /= T - 1;
      out[i][j] = cov; out[j][i] = cov;
    }
  }
  return out;
}

/** Constant-mix (daily-rebalanced) portfolio return stream. weights aligns to symbols. */
function portfolioReturns(weights, returns, symbols) {
  const T = Math.min(...symbols.map((s) => returns[s].length));
  const out = new Array(T);
  for (let t = 0; t < T; t++) {
    let r = 0;
    for (let i = 0; i < symbols.length; i++) r += weights[i] * returns[symbols[i]][t];
    out[t] = r;
  }
  return out;
}

// ── tangency weights (Thm 2) with shrinkage + long-only + cap ─────────────────

/** Gauss–Jordan solve A·x = b with partial pivoting. Throws on singular A. */
function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-14) throw new Error("singular covariance matrix");
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

/**
 * Enforce a per-position ceiling: cap the overweights, redistribute the excess
 * pro-rata among the uncapped. weights must already sum to 1.
 */
function capWeights(weights, maxWeight) {
  const n = weights.length;
  const cap = Math.max(Number(maxWeight) || 0, 1 / n + 1e-9); // 1/n is the feasibility floor
  const w = [...weights];
  for (let iter = 0; iter < 25; iter++) {
    let excess = 0;
    const uncapped = [];
    for (let i = 0; i < n; i++) {
      if (w[i] > cap) { excess += w[i] - cap; w[i] = cap; }
      else if (w[i] < cap - 1e-12) uncapped.push(i);
    }
    if (excess < 1e-12 || !uncapped.length) break;
    const base = uncapped.reduce((s, i) => s + w[i], 0);
    for (const i of uncapped) w[i] += base > 0 ? (excess * w[i]) / base : excess / uncapped.length;
  }
  return w;
}

/**
 * Long-only, capped, shrunk tangency weights (w ∝ Σ⁻¹μ, Thm 2).
 * Returns { weights: number[n] (sums to 1), fallback: string|null }.
 * covShrink pulls off-diagonals toward 0; muShrink pulls means toward the
 * cross-sectional mean — both temper the optimizer's estimation-error appetite.
 */
function tangencyWeights({ symbols, mu, cov, covShrink = 0.35, muShrink = 0.5, maxWeight = 0.35 }) {
  const n = symbols.length;
  if (n === 1) return { weights: [1], fallback: null };
  const muBar = _mean(mu);
  const muS = mu.map((m) => (1 - muShrink) * m + muShrink * muBar);
  const covS = cov.map((row, i) => row.map((c, j) => (i === j ? c : (1 - covShrink) * c)));
  let w, fallback = null;
  try {
    w = solveLinear(covS, muS);
  } catch (_e) {
    w = new Array(n).fill(1 / n);
    fallback = "covariance matrix was singular — fell back to equal weights";
  }
  w = w.map((x) => (x > 0 ? x : 0)); // long-only
  const sum = w.reduce((s, x) => s + x, 0);
  if (sum <= 1e-12) {
    w = new Array(n).fill(1 / n);
    fallback = fallback || "no holding had positive shrunk expected return — fell back to equal weights";
  } else {
    w = w.map((x) => x / sum);
  }
  return { weights: capWeights(w, maxWeight), fallback };
}

// ── holdings parsing + orchestrators ──────────────────────────────────────────

/**
 * Normalize /api/trading/positions rows into priced long holdings.
 * → { holdings: [{symbol, qty, price, value}], skipped: [{symbol, reason}] }
 */
function parseHoldings(positions) {
  const holdings = [];
  const skipped = [];
  for (const p of Array.isArray(positions) ? positions : []) {
    const symbol = String(p && (p.symbol || p.ticker) || "").trim().toUpperCase();
    if (!symbol) continue;
    const qty = Number(p.qty);
    if (!Number.isFinite(qty) || qty === 0) continue;
    if (qty < 0) { skipped.push({ symbol, reason: "short position — this analysis models long-only holdings" }); continue; }
    const price = Number(p.current_price)
      || (Number(p.market_value) > 0 ? Number(p.market_value) / qty : 0)
      || Number(p.avg_entry_price) || Number(p.avg_price) || 0;
    if (!(price > 0)) { skipped.push({ symbol, reason: "no usable price on the position row" }); continue; }
    holdings.push({ symbol, qty, price, value: qty * price });
  }
  holdings.sort((a, b) => b.value - a.value);
  if (holdings.length > MAX_SYMBOLS) {
    for (const h of holdings.slice(MAX_SYMBOLS)) {
      skipped.push({ symbol: h.symbol, reason: `beyond the top-${MAX_SYMBOLS}-by-value analysis cap` });
    }
    holdings.length = MAX_SYMBOLS;
  }
  return { holdings, skipped };
}

function _hhi(weights) {
  return weights.reduce((s, w) => s + w * w, 0);
}

function _avgPairwise(corr) {
  const n = corr.length;
  if (n < 2) return 0;
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { sum += corr[i][j]; cnt++; }
  return cnt ? sum / cnt : 0;
}

function _windowStats(weights, returns, symbols) {
  const stream = portfolioReturns(weights, returns, symbols);
  return {
    sharpe: sharpeCI(stream),
    volAnnual: _stdev(stream) * Math.sqrt(TRADING_DAYS),
    maxDD: maxDrawdown(stream),
    annReturn: annualizedReturn(stream),
  };
}

/**
 * Analyze actual holdings: weights, per-symbol stats, correlations,
 * constant-mix portfolio Sharpe/vol/maxDD at CURRENT weights, concentration.
 * opts: { years, history?, fetchFn? } — history/fetchFn for offline tests.
 */
async function analyzeHoldings(positions, opts = {}) {
  const years = Math.max(2, Math.min(10, Math.round(Number(opts.years) || 5)));
  const { holdings, skipped } = parseHoldings(positions);
  if (!holdings.length) return { ok: false, reason: "no priced long positions to analyze", excluded: skipped };
  const { seriesBySym, excluded } = await _fetchAll(holdings.map((h) => h.symbol), years, opts.history, opts.fetchFn);
  const usable = holdings.filter((h) => seriesBySym[h.symbol]);
  const allExcluded = [...skipped, ...excluded];
  if (!usable.length) return { ok: false, reason: "no return history for any holding", excluded: allExcluded };

  const aligned = alignReturns(Object.fromEntries(usable.map((h) => [h.symbol, seriesBySym[h.symbol]])));
  const symbols = usable.map((h) => h.symbol);
  const totalValue = usable.reduce((s, h) => s + h.value, 0);
  const weights = usable.map((h) => h.value / totalValue);
  const obs = Math.min(...symbols.map((s) => aligned.returns[s].length));

  const perSymbol = usable.map((h, i) => {
    const r = aligned.returns[h.symbol];
    return {
      symbol: h.symbol, qty: h.qty, price: h.price, value: h.value, weight: weights[i],
      sharpe: sharpeCI(r), volAnnual: _stdev(r) * Math.sqrt(TRADING_DAYS), annReturn: annualizedReturn(r),
    };
  });
  const corr = correlationMatrix(aligned.returns, symbols);
  const notes = [];
  if (obs < THIN_WINDOW_OBS) {
    notes.push(`aligned window is only ${obs} trading days (a holding has short history) — estimates are very noisy`);
  }

  return {
    ok: true,
    window: { years, obs, from: aligned.dates[0] || null, to: aligned.dates[aligned.dates.length - 1] || null },
    symbols, weights, totalValue, perSymbol,
    correlations: { matrix: corr, avgPairwise: _avgPairwise(corr) },
    portfolio: _windowStats(weights, aligned.returns, symbols),
    concentration: {
      maxWeight: { symbol: symbols[weights.indexOf(Math.max(...weights))], weight: Math.max(...weights) },
      hhi: _hhi(weights),
      effectiveN: 1 / _hhi(weights),
    },
    excluded: allExcluded,
    notes,
    _aligned: aligned, // internal reuse (proposeRebalance); callers should ignore
  };
}

/** Do two 95% CIs overlap? Overlap ⇒ statistically indistinguishable here. */
function ciOverlap(a, b) {
  return !(a.lo > b.hi || b.lo > a.hi);
}

/**
 * Covariance-aware rebalance PROPOSAL over the existing holdings only.
 * Never touches a broker: the order list is a computed diff, not an action.
 * opts: { years, maxWeight, covShrink, muShrink, history?, fetchFn? }
 */
async function proposeRebalance(positions, opts = {}) {
  const analysis = await analyzeHoldings(positions, opts);
  if (!analysis.ok) return analysis;
  const { symbols, weights, totalValue, _aligned: aligned } = analysis;
  if (symbols.length < 2) {
    return { ok: false, reason: "rebalancing needs at least 2 priced holdings with history (diversification math is pairwise)", excluded: analysis.excluded };
  }

  const mu = symbols.map((s) => _mean(aligned.returns[s]));
  const cov = covarianceMatrix(aligned.returns, symbols);
  const maxWeight = Math.min(1, Math.max(0.1, Number(opts.maxWeight) || 0.35));
  const tang = tangencyWeights({
    symbols, mu, cov, maxWeight,
    covShrink: opts.covShrink != null ? opts.covShrink : 0.35,
    muShrink: opts.muShrink != null ? opts.muShrink : 0.5,
  });

  const current = analysis.portfolio;
  const proposed = _windowStats(tang.weights, aligned.returns, symbols);
  const holdingsBySym = Object.fromEntries(analysis.perSymbol.map((p) => [p.symbol, p]));

  // Dry-run order diff: dollar deltas → whole-share orders, skipping dust
  // (< 1% of portfolio value) so the proposal doesn't churn pennies.
  const threshold = Math.max(totalValue * 0.01, 1);
  const orders = [];
  symbols.forEach((s, i) => {
    const h = holdingsBySym[s];
    const delta = tang.weights[i] * totalValue - h.value;
    if (Math.abs(delta) < threshold) return;
    const shares = Math.floor(Math.abs(delta) / h.price);
    if (shares < 1) return;
    orders.push({
      symbol: s,
      action: delta > 0 ? "BUY" : "SELL",
      shares,
      estDollars: Math.round(shares * h.price * 100) / 100,
      price: h.price,
    });
  });

  const notes = [...analysis.notes];
  if (tang.fallback) notes.push(tang.fallback);

  return {
    ok: true,
    window: analysis.window,
    symbols,
    totalValue,
    currentWeights: weights,
    proposedWeights: tang.weights,
    current,
    proposed,
    distinguishable: !ciOverlap(current.sharpe, proposed.sharpe),
    orders,
    excluded: analysis.excluded,
    notes,
    method: {
      objective: "max ex-ante Sharpe (w ∝ Σ⁻¹μ, UNISONA-SHARPE-CERTIFICATE Thm 2)",
      constraints: `long-only; max weight ${Math.round(maxWeight * 100)}%; existing holdings only`,
      shrinkage: `cov off-diagonal ×${1 - (opts.covShrink != null ? opts.covShrink : 0.35)}, μ pulled ${((opts.muShrink != null ? opts.muShrink : 0.5) * 100)}% toward cross-sectional mean`,
    },
  };
}

/**
 * Buy-only contribution PLAN: route new cash toward the holdings most under
 * their shrunk-tangency target weight, without selling anything. This is the
 * "where should this month's deposit go" question — deterministic, fractional-
 * share aware, and NEVER an order placement (Act stays behind ADR-0020 gates).
 *
 * Method: compute the same long-only capped tangency target as
 * proposeRebalance, then fill per-symbol dollar deficits vs the
 * post-contribution total. If the cash more than covers all deficits, the
 * remainder is spread at target weights. A single holding degenerates to
 * "all cash to it" (with the concentration note the analysis already carries).
 *
 * opts: { years, maxWeight, covShrink, muShrink, history?, fetchFn? }
 */
async function planContribution(positions, cash, opts = {}) {
  const amount = Math.round(Number(cash) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "contribution must be a positive dollar amount" };
  }
  const analysis = await analyzeHoldings(positions, opts);
  if (!analysis.ok) return analysis;
  const { symbols, weights, totalValue, _aligned: aligned, perSymbol } = analysis;

  let target = [1];
  let tangFallback = null;
  if (symbols.length >= 2) {
    const mu = symbols.map((s) => _mean(aligned.returns[s]));
    const cov = covarianceMatrix(aligned.returns, symbols);
    const tang = tangencyWeights({
      symbols, mu, cov,
      maxWeight: Math.min(1, Math.max(0.1, Number(opts.maxWeight) || 0.35)),
      covShrink: opts.covShrink != null ? opts.covShrink : 0.35,
      muShrink: opts.muShrink != null ? opts.muShrink : 0.5,
    });
    target = tang.weights;
    tangFallback = tang.fallback || null;
  }

  // Deficits vs the target on the post-contribution total; buy-only fill.
  const newTotal = totalValue + amount;
  const deficits = symbols.map((s, i) => Math.max(0, target[i] * newTotal - weights[i] * totalValue));
  const defSum = deficits.reduce((a, b) => a + b, 0);
  const alloc = defSum >= amount
    ? deficits.map((d) => (defSum > 0 ? amount * (d / defSum) : 0))
    : deficits.map((d, i) => d + (amount - defSum) * target[i]);

  // Dust floor: skip slices under $1 or 2% of the contribution — a $0.40 buy
  // is fee/spread noise at retail scale. Skipped dollars are reported, not lost.
  const dust = Math.max(1, amount * 0.02);
  const orders = [];
  let planned = 0;
  symbols.forEach((s, i) => {
    const dollars = Math.round(alloc[i] * 100) / 100;
    if (dollars < dust) return;
    const price = perSymbol[i].price;
    orders.push({
      symbol: s,
      action: "BUY",
      dollars,
      estShares: price > 0 ? Math.round((dollars / price) * 10000) / 10000 : null,
      price,
    });
    planned += dollars;
  });
  orders.sort((a, b) => b.dollars - a.dollars);

  const afterWeights = symbols.map((s, i) => (weights[i] * totalValue + alloc[i]) / newTotal);
  const notes = [...analysis.notes,
    "buy-only: the contribution is routed toward underweight holdings; nothing is sold",
    "share counts assume fractional-share support — whole-share brokers round down"];
  if (tangFallback) notes.push(tangFallback);
  if (planned < amount - 0.01) {
    notes.push(`$${(amount - planned).toFixed(2)} left unallocated (slices under the $${dust.toFixed(2)} dust floor)`);
  }

  return {
    ok: true,
    window: analysis.window,
    symbols,
    totalValue,
    contribution: amount,
    currentWeights: weights,
    targetWeights: target,
    afterWeights,
    current: analysis.portfolio,
    after: _windowStats(afterWeights, aligned.returns, symbols),
    orders,
    excluded: analysis.excluded,
    notes,
    method: {
      objective: "fill dollar deficits vs the shrunk tangency target (w ∝ Σ⁻¹μ), buy-only",
      constraints: `long-only; max weight ${Math.round((Math.min(1, Math.max(0.1, Number(opts.maxWeight) || 0.35))) * 100)}%; existing holdings only; nothing sold`,
      shrinkage: `cov off-diagonal ×${1 - (opts.covShrink != null ? opts.covShrink : 0.35)}, μ pulled ${((opts.muShrink != null ? opts.muShrink : 0.5) * 100)}% toward cross-sectional mean`,
    },
  };
}

/**
 * Score an arbitrary weight allocation (what-if). Weights may be fractions or
 * percents — they are normalized by their sum. Public market data only.
 * opts: { years, history?, fetchFn? }
 */
async function scoreWeights(weightsBySym, opts = {}) {
  const entries = Object.entries(weightsBySym || {})
    .map(([s, w]) => [String(s).trim().toUpperCase(), Number(w)])
    .filter(([s, w]) => s && Number.isFinite(w) && w > 0);
  if (!entries.length) return { ok: false, reason: "no positive weights supplied" };
  if (entries.length > 15) return { ok: false, reason: "too many symbols (max 15)" };
  const years = Math.max(2, Math.min(10, Math.round(Number(opts.years) || 5)));
  const total = entries.reduce((s, [, w]) => s + w, 0);
  const target = entries.map(([s, w]) => [s, w / total]);

  const { seriesBySym, excluded } = await _fetchAll(target.map(([s]) => s), years, opts.history, opts.fetchFn);
  const usable = target.filter(([s]) => seriesBySym[s]);
  if (!usable.length) return { ok: false, reason: "no return history for any symbol", excluded };
  // Renormalize over the symbols that actually have history so weights still sum to 1.
  const usableTotal = usable.reduce((s, [, w]) => s + w, 0);
  const symbols = usable.map(([s]) => s);
  const weights = usable.map(([, w]) => w / usableTotal);

  const aligned = alignReturns(Object.fromEntries(symbols.map((s) => [s, seriesBySym[s]])));
  const obs = Math.min(...symbols.map((s) => aligned.returns[s].length));
  const corr = correlationMatrix(aligned.returns, symbols);
  const notes = [];
  if (obs < THIN_WINDOW_OBS) notes.push(`aligned window is only ${obs} trading days — estimates are very noisy`);

  return {
    ok: true,
    window: { years, obs, from: aligned.dates[0] || null, to: aligned.dates[aligned.dates.length - 1] || null },
    symbols, weights,
    perSymbol: symbols.map((s, i) => ({
      symbol: s, weight: weights[i],
      sharpe: sharpeCI(aligned.returns[s]),
      volAnnual: _stdev(aligned.returns[s]) * Math.sqrt(TRADING_DAYS),
      annReturn: annualizedReturn(aligned.returns[s]),
    })),
    correlations: { matrix: corr, avgPairwise: _avgPairwise(corr) },
    portfolio: _windowStats(weights, aligned.returns, symbols),
    excluded,
    notes,
  };
}

module.exports = {
  // orchestrators
  analyzeHoldings, proposeRebalance, scoreWeights, planContribution,
  // primitives (exported for tests + reuse)
  fetchDailyHistory, alignReturns, sharpeCI, maxDrawdown, annualizedReturn,
  correlationMatrix, covarianceMatrix, portfolioReturns,
  solveLinear, capWeights, tangencyWeights, parseHoldings, ciOverlap,
  TRADING_DAYS,
};
