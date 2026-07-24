// portfolio-analytics — offline unit tests (no network: history is injected).
// Covers the math the UNISONA-SHARPE-CERTIFICATE tools stand on: alignment,
// Sharpe + Lo(2002) CI, drawdown, correlation/covariance, constant-mix streams,
// shrunk tangency (Thm 2) with long-only + cap, holdings parsing, and the
// analyze/propose/what-if orchestrators.
//
// Run: node test/portfolio-analytics.test.js
const assert = require("assert");
const pa = require("../lib/portfolio-analytics");

let failures = 0;
function check(name, fn) {
  const done = (e) => {
    if (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
    else console.log("  ok  -", name);
  };
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.then(() => done(), done);
    done();
  } catch (e) { done(e); }
  return Promise.resolve();
}
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

// Build a Map<date, price> from a start price and a daily-return series.
function mkSeries(startPx, rets) {
  const m = new Map();
  let px = startPx;
  const d0 = Date.UTC(2024, 0, 1);
  m.set(new Date(d0).toISOString().slice(0, 10), px);
  rets.forEach((r, i) => {
    px *= 1 + r;
    m.set(new Date(d0 + (i + 1) * 86400000).toISOString().slice(0, 10), px);
  });
  return m;
}
// Deterministic pseudo-random return stream (no Math.random — reproducible).
function mkRets(n, seed, drift = 0.0004, vol = 0.01) {
  const out = [];
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(drift + vol * ((x / 2147483648) * 2 - 1));
  }
  return out;
}

async function main() {

  // ── alignReturns ──────────────────────────────────────────────────────────────
  await check("alignReturns intersects dates and computes simple returns", () => {
    const a = new Map([["2024-01-01", 100], ["2024-01-02", 110], ["2024-01-03", 121]]);
    const b = new Map([["2024-01-01", 50], ["2024-01-02", 55], ["2024-01-03", 55], ["2024-01-04", 60]]);
    const al = pa.alignReturns({ A: a, B: b });
    assert.deepStrictEqual(al.dates, ["2024-01-02", "2024-01-03"]); // 01-04 dropped (missing in A)
    approx(al.returns.A[0], 0.10); approx(al.returns.A[1], 0.10);
    approx(al.returns.B[0], 0.10); approx(al.returns.B[1], 0.0);
  });

  // ── sharpeCI (must mirror the harness / Lo 2002) ──────────────────────────────
  await check("sharpeCI matches the hand-computed Lo(2002) formula", () => {
    const rets = [0.01, -0.005, 0.02, 0.0, 0.01];
    const T = rets.length;
    const mean = rets.reduce((s, r) => s + r, 0) / T;
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (T - 1));
    const s = mean / sd;
    const se = Math.sqrt((1 + (s * s) / 2) / T);
    const k = Math.sqrt(252);
    const got = pa.sharpeCI(rets);
    approx(got.sharpe, s * k); approx(got.lo, (s - 1.96 * se) * k); approx(got.hi, (s + 1.96 * se) * k);
    assert.strictEqual(got.obs, T);
  });

  // ── maxDrawdown / annualizedReturn ────────────────────────────────────────────
  await check("maxDrawdown finds the peak-to-trough loss", () => {
    approx(pa.maxDrawdown([0.10, -0.50, 0.10]), -0.50); // peak 1.10 → trough 0.55
  });
  await check("annualizedReturn compounds geometrically", () => {
    const r = pa.annualizedReturn(new Array(252).fill(0.001));
    approx(r, Math.pow(1.001, 252) - 1, 1e-9);
  });

  // ── correlation / covariance ──────────────────────────────────────────────────
  await check("correlationMatrix: identical → 1, inverted → −1", () => {
    const r = { A: [0.01, -0.02, 0.03], B: [0.01, -0.02, 0.03], C: [-0.01, 0.02, -0.03] };
    const m = pa.correlationMatrix(r, ["A", "B", "C"]);
    approx(m[0][1], 1); approx(m[0][2], -1); approx(m[1][2], -1); approx(m[0][0], 1);
  });
  await check("covarianceMatrix diagonal equals sample variance", () => {
    const rets = [0.01, -0.005, 0.02];
    const mean = rets.reduce((s, x) => s + x, 0) / 3;
    const v = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / 2;
    const m = pa.covarianceMatrix({ A: rets }, ["A"]);
    approx(m[0][0], v);
  });

  // ── portfolioReturns (constant-mix) ───────────────────────────────────────────
  await check("portfolioReturns is the weighted sum per day", () => {
    const r = { A: [0.02, 0.0], B: [0.0, 0.02] };
    const s = pa.portfolioReturns([0.5, 0.5], r, ["A", "B"]);
    approx(s[0], 0.01); approx(s[1], 0.01);
  });

  // ── solveLinear / tangency / cap ──────────────────────────────────────────────
  await check("solveLinear solves a known 2×2 system", () => {
    const x = pa.solveLinear([[2, 0], [0, 4]], [2, 8]);
    approx(x[0], 1); approx(x[1], 2);
  });
  await check("tangency (no shrink): uncorrelated, equal-var → w ∝ μ", () => {
    const t = pa.tangencyWeights({
      symbols: ["A", "B"], mu: [0.002, 0.001],
      cov: [[0.0001, 0], [0, 0.0001]],
      covShrink: 0, muShrink: 0, maxWeight: 1,
    });
    approx(t.weights[0], 2 / 3, 1e-9); approx(t.weights[1], 1 / 3, 1e-9);
    assert.strictEqual(t.fallback, null);
  });
  await check("tangency long-only: negative-μ asset gets weight 0", () => {
    const t = pa.tangencyWeights({
      symbols: ["A", "B"], mu: [0.002, -0.001],
      cov: [[0.0001, 0], [0, 0.0001]],
      covShrink: 0, muShrink: 0, maxWeight: 1,
    });
    approx(t.weights[0], 1); approx(t.weights[1], 0);
  });
  await check("tangency all-negative μ falls back to equal weights with a note", () => {
    const t = pa.tangencyWeights({
      symbols: ["A", "B"], mu: [-0.002, -0.001],
      cov: [[0.0001, 0], [0, 0.0001]],
      covShrink: 0, muShrink: 0, maxWeight: 1,
    });
    approx(t.weights[0], 0.5); approx(t.weights[1], 0.5);
    assert.ok(t.fallback && /equal weights/.test(t.fallback));
  });
  await check("capWeights caps and redistributes pro-rata", () => {
    const w = pa.capWeights([0.8, 0.2], 0.6);
    approx(w[0], 0.6); approx(w[1], 0.4);
    approx(w[0] + w[1], 1);
  });
  await check("capWeights respects the 1/n feasibility floor", () => {
    const w = pa.capWeights([0.7, 0.2, 0.1], 0.1); // cap 0.1 infeasible for n=3 → floor 1/3
    assert.ok(Math.max(...w) <= 1 / 3 + 1e-6);
    approx(w.reduce((s, x) => s + x, 0), 1, 1e-9);
  });

  // ── parseHoldings ─────────────────────────────────────────────────────────────
  await check("parseHoldings prices rows, skips shorts and unpriced, sorts by value", () => {
    const { holdings, skipped } = pa.parseHoldings([
      { symbol: "aapl", qty: 10, current_price: 200 },
      { symbol: "GLD", qty: 30, market_value: 6300 },
      { symbol: "TSLA", qty: -5, current_price: 250 },
      { symbol: "ZERO", qty: 3 },
    ]);
    assert.deepStrictEqual(holdings.map((h) => h.symbol), ["GLD", "AAPL"]);
    approx(holdings[0].value, 6300); approx(holdings[1].value, 2000);
    assert.strictEqual(skipped.length, 2);
    assert.ok(skipped.find((s) => s.symbol === "TSLA" && /short/.test(s.reason)));
    assert.ok(skipped.find((s) => s.symbol === "ZERO" && /price/.test(s.reason)));
  });

  // ── orchestrators (offline via injected history) ──────────────────────────────
  const N = 300;
  const history = {
    AAA: mkSeries(100, mkRets(N, 7, 0.0008, 0.012)),
    BBB: mkSeries(50, mkRets(N, 99, 0.0004, 0.010)),
    CCC: mkSeries(20, mkRets(N, 12345, 0.0006, 0.015)),
  };
  const positions = [
    { symbol: "AAA", qty: 10, current_price: 100 }, // $1000
    { symbol: "BBB", qty: 10, current_price: 50 },  // $500
    { symbol: "CCC", qty: 25, current_price: 20 },  // $500
  ];

  await check("analyzeHoldings: weights from market value, stats finite, matrix square", async () => {
    const a = await pa.analyzeHoldings(positions, { years: 2, history });
    assert.ok(a.ok, a.reason);
    approx(a.weights.reduce((s, w) => s + w, 0), 1, 1e-9);
    approx(a.weights[0], 0.5, 1e-9); // AAA is half the book
    assert.strictEqual(a.correlations.matrix.length, 3);
    assert.ok(Number.isFinite(a.portfolio.sharpe.sharpe));
    assert.ok(a.portfolio.sharpe.lo < a.portfolio.sharpe.hi);
    assert.ok(a.concentration.effectiveN > 1 && a.concentration.effectiveN <= 3);
    assert.ok(a.window.obs >= N - 2);
  });

  await check("analyzeHoldings excludes symbols with no history and says why", async () => {
    const a = await pa.analyzeHoldings(
      [...positions, { symbol: "GHOST", qty: 5, current_price: 10 }],
      { years: 2, history });
    assert.ok(a.ok);
    assert.ok(a.excluded.find((e) => e.symbol === "GHOST"));
    assert.strictEqual(a.symbols.length, 3);
  });

  await check("proposeRebalance: weights sum to 1, orders move toward the proposal", async () => {
    const r = await pa.proposeRebalance(positions, { years: 2, history, maxWeight: 0.5 });
    assert.ok(r.ok, r.reason);
    approx(r.proposedWeights.reduce((s, w) => s + w, 0), 1, 1e-9);
    assert.ok(Math.max(...r.proposedWeights) <= 0.5 + 1e-9);
    assert.ok(typeof r.distinguishable === "boolean");
    const total = r.totalValue;
    for (const o of r.orders) {
      const i = r.symbols.indexOf(o.symbol);
      const cur = r.currentWeights[i] * total;
      const tgt = r.proposedWeights[i] * total;
      assert.ok(o.action === (tgt > cur ? "BUY" : "SELL"), `${o.symbol} order direction`);
      assert.ok(o.shares >= 1);
      assert.ok(o.estDollars <= Math.abs(tgt - cur) + o.price, `${o.symbol} order overshoots`);
    }
  });

  await check("proposeRebalance refuses a single-holding book", async () => {
    const r = await pa.proposeRebalance([positions[0]], { years: 2, history });
    assert.ok(!r.ok && /at least 2/.test(r.reason));
  });

  await check("scoreWeights normalizes percents and fractions the same way", async () => {
    const p = await pa.scoreWeights({ AAA: 60, BBB: 40 }, { years: 2, history });
    const f = await pa.scoreWeights({ AAA: 0.6, BBB: 0.4 }, { years: 2, history });
    assert.ok(p.ok && f.ok);
    approx(p.weights[0], 0.6, 1e-9); approx(f.weights[0], 0.6, 1e-9);
    approx(p.portfolio.sharpe.sharpe, f.portfolio.sharpe.sharpe, 1e-9);
  });

  await check("scoreWeights rejects empty/negative input honestly", async () => {
    const r = await pa.scoreWeights({ AAA: -1 }, { years: 2, history });
    assert.ok(!r.ok && /no positive weights/.test(r.reason));
  });

  await check("ciOverlap: overlapping bands are indistinguishable", () => {
    assert.strictEqual(pa.ciOverlap({ lo: 0.2, hi: 1.0 }, { lo: 0.8, hi: 1.6 }), true);
    assert.strictEqual(pa.ciOverlap({ lo: 0.2, hi: 0.7 }, { lo: 0.8, hi: 1.6 }), false);
  });

  // ── tool registry wiring ──────────────────────────────────────────────────────
  await check("tool-runner registers the three portfolio tools with honest policies", () => {
    const { REGISTRY } = require("../lib/tool-runner");
    for (const name of ["portfolio_analysis", "portfolio_whatif", "propose_rebalance"]) {
      assert.ok(REGISTRY[name], `${name} missing from REGISTRY`);
      assert.strictEqual(REGISTRY[name].policy, "read");
      assert.ok(typeof REGISTRY[name].run === "function");
    }
    assert.strictEqual(REGISTRY.portfolio_whatif.guest_safe, true);       // public data only
    assert.ok(!REGISTRY.portfolio_analysis.guest_safe);                    // account data
    assert.ok(!REGISTRY.propose_rebalance.guest_safe);                     // account data
    assert.ok(/never suggests new purchases|NEVER places orders/i.test(REGISTRY.propose_rebalance.desc));
  });

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nAll portfolio-analytics tests passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
