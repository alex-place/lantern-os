"use strict";
// Bradley-Terry-Luce ranking from pairwise comparisons -- the same ranking method Robin uses to
// turn an LLM judge's pairwise preferences into an ordering (Bradley & Terry 1952; Robin,
// arXiv:2505.13400 Methods 4.1).
//
// WHY PAIRWISE AT ALL. Asking a model to score N proposals on a 1-10 scale produces numbers that
// are not comparable across calls -- the scale drifts with the prompt, the order, and the batch.
// Asking "which of these two is better" is a single decision with a single winner, and BTL
// recovers a global strength from many such decisions. Robin measured 88% intra-rater
// consistency on repeated identical pairs versus 61% for human experts, which is the empirical
// case for doing it this way.
//
// SCHEDULE. Robin's rule, kept: <= 25 items -> every pair (round robin); more than 25 -> 300
// pairs sampled at random. Sampling here is from a seeded LCG, not Math.random, so a run is
// reproducible from its seed -- a ranking you cannot reproduce is not evidence.
//
// ESTIMATOR. Minorization-maximization (Hunter 2004), the standard fixed-point iteration for
// BTL. Strengths are normalised to sum to 1. Items that never lose would diverge, so a symmetric
// prior of `alpha` half-wins against a phantom average opponent is added -- without it a single
// undefeated item takes infinite strength and the ordering below it becomes noise.

const MAX_PAIRS = 300;
const ROUND_ROBIN_MAX = 25;

function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Which pairs to compare. Deterministic given (n, seed).
function schedule(n, seed = 1) {
  const all = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) all.push([i, j]);
  if (n <= ROUND_ROBIN_MAX) return all;
  const rnd = lcg(seed);
  for (let i = all.length - 1; i > 0; i--) {          // Fisher-Yates with the seeded stream
    const j = Math.floor(rnd() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, MAX_PAIRS);
}

// results: [{i, j, winner}] where winner is i or j (index into items). Ties are dropped by the
// caller -- BTL has no tie term here and a silently-split tie would be a fabricated preference.
function fit(n, results, { alpha = 0.5, iters = 200, tol = 1e-9 } = {}) {
  const wins = new Array(n).fill(alpha);              // symmetric prior, see header
  const pairs = new Map();                            // "i,j" -> count of comparisons
  for (const r of results) {
    if (r.winner !== r.i && r.winner !== r.j) continue;
    wins[r.winner] += 1;
    const key = r.i < r.j ? `${r.i},${r.j}` : `${r.j},${r.i}`;
    pairs.set(key, (pairs.get(key) || 0) + 1);
  }
  let p = new Array(n).fill(1 / n);
  for (let it = 0; it < iters; it++) {
    const next = new Array(n).fill(0);
    const denom = new Array(n).fill(2 * alpha);       // the prior's own denominator term
    for (const [key, cnt] of pairs) {
      const [a, b] = key.split(",").map(Number);
      const s = p[a] + p[b];
      denom[a] += cnt / s;
      denom[b] += cnt / s;
    }
    for (let i = 0; i < n; i++) next[i] = wins[i] / (denom[i] || 1e-12);
    const sum = next.reduce((x, y) => x + y, 0) || 1;
    let delta = 0;
    for (let i = 0; i < n; i++) {
      const v = next[i] / sum;
      delta = Math.max(delta, Math.abs(v - p[i]));
      next[i] = v;
    }
    p = next;
    if (delta < tol) break;
  }
  return p;
}

// items: any[]; compare(a, b, i, j) -> index of the winner (i or j) or null to skip the pair.
async function rank(items, compare, { seed = 1, alpha = 0.5 } = {}) {
  const pairs = schedule(items.length, seed);
  const results = [];
  for (const [i, j] of pairs) {
    const winner = await compare(items[i], items[j], i, j);
    if (winner === i || winner === j) results.push({ i, j, winner });
  }
  const strength = fit(items.length, results, { alpha });
  const order = items.map((item, i) => ({ item, index: i, strength: strength[i],
                                          wins: results.filter((r) => r.winner === i).length,
                                          comparisons: results.filter((r) => r.i === i || r.j === i).length }))
    .sort((a, b) => b.strength - a.strength);
  return { order, results, pairs: pairs.length };
}

module.exports = { rank, fit, schedule, lcg, MAX_PAIRS, ROUND_ROBIN_MAX };
