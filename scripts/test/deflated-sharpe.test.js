"use strict";
// Unit tests for the Deflated-Sharpe machinery added to daily-backtest-harness.js.
// Run: node scripts/test/deflated-sharpe.test.js
const assert = require("assert");
const {
  normCdf, normInv, moments, deflatedSharpe, attachDeflatedSharpe,
} = require("../daily-backtest-harness.js");

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  pass++;
  console.log("  ✓ " + name);
}
function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

console.log("Deflated Sharpe unit tests\n");

// normCdf: known points.
ok("normCdf(0) = 0.5", approx(normCdf(0), 0.5, 1e-6));
ok("normCdf(1.96) ≈ 0.975", approx(normCdf(1.96), 0.975, 1e-3));
ok("normCdf(-1.96) ≈ 0.025", approx(normCdf(-1.96), 0.025, 1e-3));

// normInv is the inverse of normCdf.
ok("normInv(0.975) ≈ 1.96", approx(normInv(0.975), 1.96, 1e-3));
ok("normInv(0.5) = 0", approx(normInv(0.5), 0, 1e-6));
ok("normInv(normCdf(1.3)) ≈ 1.3 (round-trip)", approx(normInv(normCdf(1.3)), 1.3, 1e-3));

// moments: a symmetric series has ~0 skew and ~3 kurtosis... build a normal-ish set.
const sym = [];
for (let i = -50; i <= 50; i++) sym.push(i / 100); // uniform, symmetric
const m = moments(sym);
ok("moments: symmetric series has ~0 skew", approx(m.skew, 0, 1e-6));
ok("moments: perPeriodSharpe of zero-mean series ~ 0", approx(m.perPeriodSharpe, 0, 1e-6));

// A left-skewed series (fat left tail) should report negative skew.
const leftSkew = [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, -0.20];
ok("moments: left-tailed series has negative skew", moments(leftSkew).skew < 0);

// deflatedSharpe: MONOTONICITY — more trials must never RAISE the DSR (harder to be real).
const base = deflatedSharpe(0.12, 0, 3, 500, 2, 0.01).dsr;
const many = deflatedSharpe(0.12, 0, 3, 500, 50, 0.01).dsr;
ok("DSR decreases (or holds) as trial count rises", many <= base + 1e-9);
ok("DSR with few trials is a valid probability in [0,1]", base >= 0 && base <= 1);

// deflatedSharpe: a genuinely strong, single-trial Sharpe over a long sample survives.
const strong = deflatedSharpe(0.25, 0, 3, 2000, 1, 1e-9).dsr;
ok("Strong SR, 1 trial, long sample → DSR high (>0.95)", strong > 0.95);

// deflatedSharpe: a weak Sharpe found after many trials should NOT survive.
const weak = deflatedSharpe(0.05, 0, 3, 300, 40, 0.02).dsr;
ok("Weak SR after 40 trials → DSR low (<0.9)", weak < 0.9);

// Negative skew (fat left tail) should REDUCE the DSR vs a symmetric series at the same SR.
const symDsr = deflatedSharpe(0.15, 0, 3, 800, 5, 0.01).dsr;
const skewDsr = deflatedSharpe(0.15, -1.5, 8, 800, 5, 0.01).dsr;
ok("Fat-left-tail (neg skew, high kurt) lowers DSR", skewDsr < symDsr);

// attachDeflatedSharpe: end-to-end over a fake sleeve set.
const rows = [
  { name: "A", _perPeriodSharpe: 0.20, _skew: 0, _kurt: 3, _obs: 1000 },
  { name: "B", _perPeriodSharpe: 0.05, _skew: 0, _kurt: 3, _obs: 1000 },
  { name: "C", _perPeriodSharpe: 0.02, _skew: 0, _kurt: 3, _obs: 1000 },
];
attachDeflatedSharpe(rows);
ok("attach: every row gets a deflated_sharpe field", rows.every((r) => "deflated_sharpe" in r));
ok("attach: trial count == number of sleeves", rows.every((r) => r.dsr_trials === 3));
ok("attach: best sleeve has higher DSR than worst", rows[0].deflated_sharpe >= rows[2].deflated_sharpe);
ok("attach: single-row set yields null DSR (can't deflate 1 trial)", (() => {
  const one = [{ name: "solo", _perPeriodSharpe: 0.3, _skew: 0, _kurt: 3, _obs: 500 }];
  attachDeflatedSharpe(one);
  return one[0].deflated_sharpe === null;
})());

console.log(`\n${pass} assertions passed.`);
