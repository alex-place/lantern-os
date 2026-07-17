/**
 * Proper-betting stake sizing unit tests: lib/kalshi-proper-bet.js
 * properBetSize() — the theorem-backed (arXiv 2607.06166, Def. 2 + Thm. 1)
 * advisory sizing behind the Kalshi suggestion cards' `properBet` field.
 *
 * Fully offline: pure math, no network, no Kalshi API, no RNG.
 *
 * Run: node tests/test_kalshi_proper_bet.js
 */

const assert = require("assert");
const path = require("path");

const { properBetSize, DEFAULT_MAX_FRACTION } = require(path.join(
  __dirname, "..", "apps", "lantern-garage", "lib", "kalshi-proper-bet"
));

const suggest = require(path.join(
  __dirname, "..", "apps", "lantern-garage", "lib", "kalshi-suggest"
));

function logit(x) { return Math.log(x / (1 - x)); }
function kl(p, q) { return p * Math.log(p / q) + (1 - p) * Math.log((1 - p) / (1 - q)); }

function main() {
  // ── 1) real edge, both sides ───────────────────────────────────────────────
  // YES edge: forecast 70%, YES ask 60¢
  const yes = properBetSize({ forecast: 0.7, price: 0.6, bankroll: 1000, rule: "brier" });
  assert.strictEqual(yes.ok, true, yes.reason);
  assert.strictEqual(yes.side, "yes");
  assert.ok(yes.contracts > 0 && yes.stakeDollars > 0, "positive stake on a real YES edge");
  assert.strictEqual(yes.zeroReason, null);
  assert.ok(yes.edge.scoreGap > 0, "S(p)-eval must beat S(q)-eval when trading");
  assert.ok(yes.edge.forecastScore > yes.edge.marketScore, "forecast score > market score");
  assert.ok(yes.expectedProfitPerContract > 0, "positive frictionless edge per contract");
  assert.ok(Math.abs(yes.stakeDollars - yes.contracts * yes.costPerContractDollars) < 0.01,
    "stake = contracts × cost");
  assert.ok(yes.stakeDollars <= 1000 * DEFAULT_MAX_FRACTION + 1e-9,
    "stake never exceeds the per-market bankroll cap");

  // NO edge: forecast 30%, YES ask 40¢ (frictionless NO price 60¢) → buy NO
  const no = properBetSize({ forecast: 0.3, price: 0.4, bankroll: 1000, rule: "brier" });
  assert.strictEqual(no.ok, true, no.reason);
  assert.strictEqual(no.side, "no");
  assert.ok(no.contracts > 0 && no.edge.scoreGap > 0, "positive stake + edge on the NO side");

  // Mirror symmetry: (0.7 vs 0.6, YES) and (0.3 vs 0.4, NO) are the same bet
  // in traded-side space → identical magnitude, fraction, contracts, edge.
  assert.ok(Math.abs(yes.magnitude - no.magnitude) < 1e-12, "mirrored magnitudes equal");
  assert.ok(Math.abs(yes.targetFraction - no.targetFraction) < 1e-12, "mirrored fractions equal");
  assert.strictEqual(yes.contracts, no.contracts, "mirrored contracts equal");
  assert.ok(Math.abs(yes.edge.scoreGap - no.edge.scoreGap) < 1e-12, "mirrored score gaps equal");

  // Both rules agree on the SIDE (sign(p − q)), for both directions
  for (const rule of ["brier", "log"]) {
    assert.strictEqual(properBetSize({ forecast: 0.7, price: 0.6, bankroll: 1000, rule }).side, "yes");
    assert.strictEqual(properBetSize({ forecast: 0.3, price: 0.4, bankroll: 1000, rule }).side, "no");
  }

  // ── 2) no edge → honest zero stake ─────────────────────────────────────────
  for (const rule of ["brier", "log"]) {
    const flat = properBetSize({ forecast: 0.5, price: 0.5, bankroll: 1000, rule });
    assert.strictEqual(flat.ok, true);
    assert.strictEqual(flat.side, null, "p = q must not trade");
    assert.strictEqual(flat.contracts, 0);
    assert.strictEqual(flat.stakeDollars, 0);
    assert.strictEqual(flat.zeroReason, "no-edge");
    assert.strictEqual(flat.edge, null, "no edge block when there is no trade");
  }

  // §3.3.4 spread deadband: forecast 55%, YES ask 57¢, NO ask 45¢ —
  // p < yesAsk and (1 − p) = noAsk, so neither side clears its executable price.
  const dead = properBetSize({ forecast: 0.55, price: 0.57, noPrice: 0.45, bankroll: 1000, rule: "brier" });
  assert.strictEqual(dead.ok, true);
  assert.strictEqual(dead.side, null, "inside the spread the proper bet abstains");
  assert.strictEqual(dead.contracts, 0);
  assert.strictEqual(dead.zeroReason, "inside-spread");
  // ...but a forecast clearing the ask does trade despite the spread
  const clears = properBetSize({ forecast: 0.62, price: 0.57, noPrice: 0.45, bankroll: 1000, rule: "brier" });
  assert.strictEqual(clears.side, "yes");
  assert.ok(clears.contracts > 0, "forecast above the ask trades through the spread");

  // ── 3) degenerate inputs rejected ──────────────────────────────────────────
  const badCases = [
    { forecast: 0, price: 0.5, bankroll: 100 },            // certainty is not a forecast
    { forecast: 1, price: 0.5, bankroll: 100 },
    { forecast: -0.2, price: 0.5, bankroll: 100 },
    { forecast: NaN, price: 0.5, bankroll: 100 },
    { forecast: "0.6", price: 0.5, bankroll: 100 },        // strings rejected
    { forecast: 0.6, price: 0, bankroll: 100 },            // dead book
    { forecast: 0.6, price: 1, bankroll: 100 },
    { forecast: 0.6, price: NaN, bankroll: 100 },
    { forecast: 0.6, price: 0.5, noPrice: 0, bankroll: 100 },
    { forecast: 0.6, price: 0.5, noPrice: 1.2, bankroll: 100 },
    { forecast: 0.6, price: 0.5, bankroll: 0 },
    { forecast: 0.6, price: 0.5, bankroll: -50 },
    { forecast: 0.6, price: 0.5, bankroll: Infinity },
    { forecast: 0.6, price: 0.5, bankroll: 100, rule: "kelly" },   // Kelly is exactly what this replaces
    { forecast: 0.6, price: 0.5, bankroll: 100, maxFraction: 0 },
    { forecast: 0.6, price: 0.5, bankroll: 100, maxFraction: 1.5 },
  ];
  for (const c of badCases) {
    const r = properBetSize(c);
    assert.strictEqual(r.ok, false, `must reject ${JSON.stringify(c)}`);
    assert.ok(typeof r.reason === "string" && r.reason.length > 0, "rejection carries a reason");
  }
  // "quadratic" is an accepted alias for the Brier rule
  const alias = properBetSize({ forecast: 0.7, price: 0.6, bankroll: 1000, rule: "quadratic" });
  assert.strictEqual(alias.ok, true);
  assert.strictEqual(alias.rule, "brier");

  // ── 4) Brier vs log differ as the paper says ───────────────────────────────
  // Same margin |p − q| = 0.05 at the boundary vs at mid-price. Brier sizes on
  // the margin alone → identical fractions; the log rule's logit gap blows up
  // near the boundary → it stakes strictly more there (paper Remark 5/Table 1:
  // sizes ∝ ∇G(p) − ∇G(q), which is rule-dependent).
  const bExtreme = properBetSize({ forecast: 0.10, price: 0.05, bankroll: 1000, rule: "brier" });
  const bMid = properBetSize({ forecast: 0.55, price: 0.50, bankroll: 1000, rule: "brier" });
  const lExtreme = properBetSize({ forecast: 0.10, price: 0.05, bankroll: 1000, rule: "log" });
  const lMid = properBetSize({ forecast: 0.55, price: 0.50, bankroll: 1000, rule: "log" });
  assert.ok(Math.abs(bExtreme.targetFraction - bMid.targetFraction) < 1e-12,
    "Brier: equal margins → equal bankroll fractions");
  assert.ok(lExtreme.targetFraction > lMid.targetFraction * 2,
    "log: the same margin near the boundary must be sized much larger");
  // And at one and the same (p, q) the two rules size differently
  const b = properBetSize({ forecast: 0.75, price: 0.5, bankroll: 1000, rule: "brier" });
  const l = properBetSize({ forecast: 0.75, price: 0.5, bankroll: 1000, rule: "log" });
  assert.ok(Math.abs(b.targetFraction - l.targetFraction) > 1e-6,
    "Brier and log variants must size the same bet differently");

  // Magnitudes are the exact single-leg s_G = ∇G(p) − ∇G(q) reductions
  assert.ok(Math.abs(b.magnitude - 0.25) < 1e-12, "Brier magnitude = p − q");
  assert.ok(Math.abs(l.magnitude - (logit(0.75) - logit(0.5))) < 1e-12, "log magnitude = logit gap");
  // Score gaps are the closed-form Bregman divergences: 2(p−q)² and KL(p‖q)
  assert.ok(Math.abs(b.edge.scoreGap - 2 * 0.25 * 0.25) < 1e-12, "Brier score gap = 2(p−q)²");
  assert.ok(Math.abs(l.edge.scoreGap - kl(0.75, 0.5)) < 1e-12, "log score gap = KL(p‖q)");

  // ── 5) stake scales with bankroll ──────────────────────────────────────────
  // p = 0.75, q = 0.50 → Brier fraction = 0.1 × 0.25/0.8 = 0.03125 exactly.
  const small = properBetSize({ forecast: 0.75, price: 0.5, bankroll: 160, rule: "brier" });
  const big = properBetSize({ forecast: 0.75, price: 0.5, bankroll: 1600, rule: "brier" });
  assert.strictEqual(small.contracts, 10, "bankroll 160 × 0.03125 / $0.50 = 10 contracts");
  assert.strictEqual(big.contracts, 100, "10× bankroll → 10× contracts");
  assert.ok(Math.abs(big.stakeDollars - 10 * small.stakeDollars) < 0.01, "stake scales linearly");
  // Tiny bankroll → can't afford one contract → honest zero, not a forced bet
  const dust = properBetSize({ forecast: 0.75, price: 0.5, bankroll: 10, rule: "brier" });
  assert.strictEqual(dust.contracts, 0);
  assert.strictEqual(dust.stakeDollars, 0);
  assert.strictEqual(dust.zeroReason, "stake-below-one-contract");
  assert.strictEqual(dust.side, "yes", "direction still reported for transparency");

  console.log("ok - properBetSize: edge both sides, spread deadband, honest zeros, degenerate rejection, Brier/log divergence, bankroll scaling");

  // ── 6) suggestion wiring: buildProperBet advisory block ────────────────────
  const market = { yes_ask: 60, no_ask: 42 };
  const fav = { side: "yes", sideAsk: 60 };
  // proven ledger, 70% measured win rate → forecast P(YES) = 0.70 > 0.60 ask
  const proven = suggest.buildProperBet(market, fav, {
    proven: true, winRate: 70, sampleN: 44, category: "test-cat",
  });
  assert.strictEqual(proven.available, true);
  assert.strictEqual(proven.bankroll, 100, "default advisory bankroll is $100");
  for (const rule of ["brier", "log"]) {
    assert.strictEqual(proven[rule].side, "yes", `${rule} advisory side follows the forecast`);
    assert.ok(proven[rule].scoreGap > 0, `${rule} advisory carries the scoring-rule edge`);
    assert.ok(proven[rule].stakeDollars <= 100 * DEFAULT_MAX_FRACTION + 1e-9, `${rule} stake capped`);
  }
  assert.strictEqual(proven.agreesWithCard, true);

  // unproven ledger → no probability forecast → honestly unavailable
  const unproven = suggest.buildProperBet(market, fav, { proven: false, winRate: null, sampleN: 3, category: "test-cat" });
  assert.strictEqual(unproven.available, false);
  assert.ok(/unproven/.test(unproven.reason), "reason names the missing evidence");

  // proven but the measured win rate is BELOW the ask → the advisory may flip
  // sides or abstain, but it must never manufacture a YES stake
  const contra = suggest.buildProperBet(market, fav, { proven: true, winRate: 55, sampleN: 44, category: "test-cat" });
  assert.strictEqual(contra.available, true);
  assert.notStrictEqual(contra.brier.side, "yes", "no YES stake when the forecast is under the ask");
  assert.strictEqual(contra.agreesWithCard, false);

  // degenerate book → unavailable, never a throw
  const deadBook = suggest.buildProperBet({ yes_ask: 0, no_ask: 100 }, fav, { proven: true, winRate: 70, sampleN: 44, category: "x" });
  assert.strictEqual(deadBook.available, false);

  console.log("ok - buildProperBet: proven-ledger advisory both rules, unproven/degenerate honesty, side disagreement surfaced");
}

main();
