"use strict";
// #2790 (M5 math) / #2855 (Act) — KKT log water-filling allocation of a scarce grounding/compute
// budget across sub-goals by value-of-information.
//
// Problem:  minimize  Σ uᵢ·e^{−γᵢ·bᵢ}   s.t.  Σ bᵢ ≤ B,  bᵢ ≥ 0
//   uᵢ = utility/uncertainty of node i (how much a wrong answer there costs)
//   γᵢ = marginal value-decay rate of spending on node i (diminishing returns)
//   B  = total budget (grounding fetches / compute / tokens) to allocate this step
//
// KKT stationarity gives log water-filling:
//   bᵢ* = max(0, (1/γᵢ)·ln(γᵢ·uᵢ / ν))
// where ν is the water level (the "shadow price of reasoning", 2606.03092): a node gets NOTHING
// until γᵢuᵢ > ν (a hard threshold), then its allocation grows only with ln. ν is chosen so the
// budget binds (Σ bᵢ* = B). This is the principled form of the shipped heuristics: the D≤0.5
// fetch cutoff is the water level, and a frozen/collapsed node (γᵢ→0: no marginal value of more
// retrieval) drops to zero allocation. Pure; never throws.

/** Σ of the (positive) KKT allocations at a given water level ν. Monotone ↓ in ν. */
function _sumAlloc(u, g, nu) {
  let s = 0;
  for (let i = 0; i < u.length; i++) {
    const b = (1 / g[i]) * Math.log((g[i] * u[i]) / nu);
    if (b > 0) s += b;
  }
  return s;
}

/**
 * Allocate budget B across nodes by log water-filling.
 * @param {number[]} utilities  uᵢ ≥ 0
 * @param {number[]} gammas      γᵢ > 0 (value-decay rates; a frozen node → γ→0 → no allocation)
 * @param {number}   budget      B ≥ 0
 * @param {{iters?:number}} [opts]
 * @returns {{allocations:number[], waterLevel:(number|null), active:number[], total:number}}
 */
function waterFill(utilities, gammas, budget, opts = {}) {
  const n = Array.isArray(utilities) ? utilities.length : 0;
  const zero = { allocations: new Array(n).fill(0), waterLevel: null, active: [], total: 0 };
  if (n === 0) return zero;

  const u = utilities.map((x) => Math.max(0, Number(x) || 0));
  const g = gammas.map((x) => Math.max(1e-9, Number(x) || 0));
  const B = Math.max(0, Number(budget) || 0);
  if (B === 0) return zero;

  // At ν = max(γᵢuᵢ) every allocation is ≤ 0 (sum 0); as ν→0 the sum →∞. Bisect for Σ = B.
  const nuHi = Math.max(...u.map((ui, i) => g[i] * ui));
  if (!(nuHi > 0)) return { ...zero, waterLevel: 0 };

  let lo = nuHi * 1e-12;
  let hi = nuHi;
  const iters = opts.iters || 200;
  for (let it = 0; it < iters; it++) {
    const nu = 0.5 * (lo + hi);
    // sum decreasing in ν: overspending (s > B) means the water level is too LOW → raise lo.
    if (_sumAlloc(u, g, nu) > B) lo = nu;
    else hi = nu;
  }
  const nu = 0.5 * (lo + hi);
  const allocations = u.map((ui, i) => {
    const b = (1 / g[i]) * Math.log((g[i] * ui) / nu);
    return b > 0 ? b : 0;
  });
  const total = allocations.reduce((a, b) => a + b, 0);
  const active = allocations.map((b, i) => (b > 1e-9 ? i : -1)).filter((i) => i >= 0);
  return {
    allocations: allocations.map((x) => Number(x.toFixed(6))),
    waterLevel: nu,
    active,
    total: Number(total.toFixed(6)),
  };
}

module.exports = { waterFill };
