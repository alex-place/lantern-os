/**
 * Advisor math unit tests (#trader-advisor): lib/portfolio-analytics.js
 * planContribution() — the buy-only contribution planner behind the trader
 * dashboard Advisor tab (/api/trading/portfolio/contribution) and the
 * contribution_plan chat tool.
 *
 * Fully offline: daily history is injected via opts.history (the same seam
 * analyzeHoldings/proposeRebalance expose for tests), so no network and no
 * broker are needed. Deterministic price paths (no RNG).
 *
 * Run: node tests/test_portfolio_contribution_plan.js
 */

const assert = require("assert");
const path = require("path");

const pa = require(path.join(__dirname, "..", "apps", "lantern-garage", "lib", "portfolio-analytics"));

// ── deterministic daily price history: ~320 trading days per symbol ──────────
function series(p0, drift, wobble, phase) {
  const m = new Map();
  const d = new Date("2025-01-02T00:00:00Z");
  let i = 0, made = 0;
  while (made < 320) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) {
      const px = p0 * Math.exp(drift * made + wobble * Math.sin(made / 7 + phase));
      m.set(d.toISOString().slice(0, 10), Math.round(px * 100) / 100);
      made += 1;
    }
    d.setUTCDate(d.getUTCDate() + 1);
    i += 1;
    if (i > 1000) throw new Error("calendar runaway");
  }
  return m;
}

const history = {
  AAA: series(100, 0.0009, 0.010, 0.0), // strong steady grower → tangency likes it
  BBB: series(50, 0.0002, 0.030, 1.3),  // choppy, weak drift
  CCC: series(25, 0.0005, 0.015, 2.6),  // middling
};

async function main() {
  // Portfolio deliberately skewed: AAA (the best risk-adjusted series) is tiny,
  // BBB dominates — so the buy-only fill must route new cash mostly to AAA.
  const positions = [
    { symbol: "AAA", qty: 1, current_price: 100 },   // ~$100
    { symbol: "BBB", qty: 14, current_price: 50 },   // ~$700
    { symbol: "CCC", qty: 8, current_price: 25 },    // ~$200
  ];

  // 1) basic shape + conservation of cash
  const r = await pa.planContribution(positions, 100, { years: 2, history });
  assert.strictEqual(r.ok, true, `plan should succeed: ${r.reason}`);
  assert.strictEqual(r.contribution, 100);
  assert.ok(r.orders.length >= 1, "should produce at least one buy");
  for (const o of r.orders) {
    assert.strictEqual(o.action, "BUY", "contribution plan is buy-only");
    assert.ok(o.dollars > 0 && o.estShares > 0, "orders carry dollars + fractional shares");
  }
  const planned = r.orders.reduce((s, o) => s + o.dollars, 0);
  assert.ok(planned <= 100 + 0.01, `planned $${planned} must not exceed the contribution`);
  assert.ok(planned >= 100 - Math.max(1, 100 * 0.02) * r.symbols.length - 0.01,
    "most of the contribution should be allocated (dust floor aside)");

  // 2) weights: after-weights sum to 1 and move toward the target
  const sumAfter = r.afterWeights.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sumAfter - 1) < 1e-9, `after-weights must sum to 1 (got ${sumAfter})`);
  const iAAA = r.symbols.indexOf("AAA");
  const iBBB = r.symbols.indexOf("BBB");
  assert.ok(iAAA >= 0 && iBBB >= 0, "both symbols analyzed");
  assert.ok(r.afterWeights[iAAA] > r.currentWeights[iAAA] - 1e-12,
    "buy-only: no weight is reduced below what dilution alone implies");
  const gapBefore = r.targetWeights[iAAA] - r.currentWeights[iAAA];
  const gapAfter = r.targetWeights[iAAA] - r.afterWeights[iAAA];
  assert.ok(gapBefore > 0, "test setup: AAA must start under its target weight");
  assert.ok(gapAfter < gapBefore, "the contribution must close the underweight gap");
  const oAAA = r.orders.find((o) => o.symbol === "AAA");
  assert.ok(oAAA, "the most-underweight, best-Sharpe holding gets bought");

  // 3) nothing is ever sold — even when one position is grossly overweight
  assert.ok(r.orders.every((o) => o.action === "BUY"), "no SELL rows, ever");

  // 4) single holding degenerates to all-in on it
  const one = await pa.planContribution([{ symbol: "AAA", qty: 2, current_price: 100 }], 20,
    { years: 2, history });
  assert.strictEqual(one.ok, true, `single-holding plan should succeed: ${one.reason}`);
  assert.strictEqual(one.orders.length, 1);
  assert.strictEqual(one.orders[0].symbol, "AAA");
  assert.ok(Math.abs(one.orders[0].dollars - 20) < 0.01, "all cash to the only holding");

  // 5) invalid contributions are refused honestly
  for (const bad of [0, -5, NaN, "nope"]) {
    const b = await pa.planContribution(positions, bad, { years: 2, history });
    assert.strictEqual(b.ok, false, `cash=${bad} must be rejected`);
  }

  // 6) ex-ante stats are present for both states (the UI + tool render them)
  for (const k of ["current", "after"]) {
    assert.ok(r[k] && typeof r[k].sharpe.sharpe === "number" && typeof r[k].maxDD === "number",
      `${k} window stats must carry sharpe + maxDD`);
  }

  console.log("ok - planContribution: buy-only fill, cash conservation, weight convergence, degenerate + invalid inputs");

  // ── ADR-0028: max-return objective, Sharpe mandate, tax estimates ──────────

  // 7) maxReturnWeights: long-only, capped, vol ceiling respected, sums to 1
  const symbols = ["AAA", "BBB", "CCC"];
  const aligned = pa.alignReturns({ AAA: history.AAA, BBB: history.BBB, CCC: history.CCC });
  const mu = symbols.map((s) => aligned.returns[s].reduce((a, b) => a + b, 0) / aligned.returns[s].length);
  const cov = pa.covarianceMatrix(aligned.returns, symbols);
  const tightCapDaily = 0.05 / Math.sqrt(pa.TRADING_DAYS); // 5%/yr — must bind
  const mr = pa.maxReturnWeights({ symbols, mu, cov, maxVolDaily: tightCapDaily, maxWeight: 0.6 });
  const wsum = mr.weights.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(wsum - 1) < 1e-6, `max-return weights must sum to 1 (got ${wsum})`);
  assert.ok(mr.weights.every((w) => w >= -1e-9 && w <= 0.6 + 1e-6), "long-only + cap respected");
  const shrunk = cov.map((row, i2) => row.map((x, j) => (i2 === j ? x : x * 0.65)));
  const volOf = (w) => {
    let v = 0;
    for (let a2 = 0; a2 < w.length; a2++) for (let b2 = 0; b2 < w.length; b2++) v += w[a2] * shrunk[a2][b2] * w[b2];
    return Math.sqrt(Math.max(v, 0));
  };
  assert.ok(volOf(mr.weights) <= tightCapDaily * 1.05, "the vol ceiling must bind (within solver tolerance)");
  // loose ceiling → corner solution, expected return ≥ tangency's
  const loose = pa.maxReturnWeights({ symbols, mu, cov, maxVolDaily: 1, maxWeight: 0.6 });
  const tang = pa.tangencyWeights({ symbols, mu, cov, maxWeight: 0.6 });
  const eret = (w) => w.reduce((s2, x, i2) => s2 + x * mu[i2], 0);
  assert.ok(eret(loose.weights) >= eret(tang.weights) - 1e-9,
    "with a loose ceiling, max-return must earn at least the tangency expected return");

  // 8) mandate verdicts (ADR-0028)
  assert.strictEqual(pa.mandateVerdict({ sharpe: 2.5, lo: 2.1, hi: 2.9 }, 2), "meets_ci");
  assert.strictEqual(pa.mandateVerdict({ sharpe: 2.2, lo: 1.4, hi: 3.0 }, 2), "meets_point");
  assert.strictEqual(pa.mandateVerdict({ sharpe: 0.8, lo: 0.1, hi: 1.5 }, 2), "below");
  // default target = the Buffett bar (Berkshire lifetime Sharpe, ADR-0028 recalibration)
  const prevMandate = process.env.KEYSTONE_SHARPE_MANDATE;
  delete process.env.KEYSTONE_SHARPE_MANDATE;
  assert.strictEqual(pa.sharpeMandate(), 0.79, "default mandate must be the Buffett bar (0.79)");
  if (prevMandate != null) process.env.KEYSTONE_SHARPE_MANDATE = prevMandate;

  // 9) proposeRebalance carries objective, mandate + tax; SELL rows carry est. gains
  const posOverweight = [
    { symbol: "AAA", qty: 1, current_price: 100, avg_entry_price: 90 },
    { symbol: "BBB", qty: 40, current_price: 50, avg_entry_price: 20 },  // huge overweight, big gain
    { symbol: "CCC", qty: 8, current_price: 25, avg_entry_price: 30 },
  ];
  const reb = await pa.proposeRebalance(posOverweight, { years: 2, history, objective: "max_return", maxVol: 0.10 });
  assert.strictEqual(reb.ok, true, `rebalance should succeed: ${reb.reason}`);
  assert.strictEqual(reb.objective, "max_return");
  assert.ok(reb.mandate && reb.mandate.target > 0 && ["meets_ci", "meets_point", "below"].includes(reb.mandate.current),
    "mandate block present with a valid verdict");
  const sells = reb.orders.filter((o) => o.action === "SELL");
  assert.ok(sells.length >= 1, "the overweight winner must be trimmed");
  assert.ok(sells.every((o) => typeof o.estGain === "number"), "SELL rows carry estimated realized gain");
  assert.ok(reb.tax && reb.tax.estTaxCost >= 0 && reb.tax.rate > 0, "tax block present with non-negative cost");
  assert.ok(reb.tax.estRealizedGain > 0, "trimming a 150% winner must realize a positive est. gain");

  console.log("ok - ADR-0028: max-return frontier solver, mandate verdicts, tax-aware rebalance proposals");
}

main().catch((e) => { console.error(e); process.exit(1); });
