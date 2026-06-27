"use strict";

/**
 * test/model-leaderboard.test.js
 *
 * The PCSF leaderboard's compositeScore must stay BOUNDED in [0,1] — it is a
 * Laplace-smoothed, decay-weighted WIN RATE, not a raw success accumulator.
 *
 * Regression for the Explore-feed runaway: source:Flourishing reached ~10000 on
 * /api/explore/feed because every click/dwell pushed recordModelOutcome →
 * recordOutcomeWithDecay, which summed successes with decay=1.0 forever. Diversity
 * rerank (#1315) masked it in the UI but the score still polluted score-based
 * logic. This pins the score to [0,1] and the debug outcomes tail to a bound.
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/model-leaderboard.test.js
 */

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// Stub agent-performance BEFORE model-leaderboard binds it (destructured require),
// so (1) recordModelOutcome never writes to the real data/agent-performance.jsonl,
// and (2) we can drive the getTopAgentsForTask fallback deterministically.
let _agentRows = [];
const _apId = require.resolve("../lib/agent-performance");
require.cache[_apId] = {
  id: _apId,
  filename: _apId,
  loaded: true,
  exports: {
    getTopAgentsForTask: async () => _agentRows,
    recordAgentCallFromConvergenceReceipt: async () => {},
  },
};

const lb = require("../lib/model-leaderboard");
const { recordOutcomeWithDecay, recordModelOutcome, rankCandidates, rankCandidatesByDomain, getDomainScope, clearDomainScope } = lb;

// Everything (explore sources + model/provider keys) lives in model-routing/global.
const D = "model-routing";
const S = "global";

beforeEach(() => { clearDomainScope(D, S); _agentRows = []; });

function record(key, success, { decay = 1.0, cost = 0, dwellMs = 0 } = {}) {
  return recordOutcomeWithDecay(D, S, key, success, dwellMs, cost, decay);
}
function scoreOf(key) {
  return getDomainScope(D, S)[key].score;
}

// ── The bug: unbounded accumulator → 10000 ───────────────────────────────────

test("10000 successive successes stay bounded at <=1 (the source:Flourishing runaway)", () => {
  let last;
  for (let i = 0; i < 10000; i++) last = record("source:Flourishing", true);
  assert.ok(last.score <= 1, `score must be <=1, got ${last.score}`);
  assert.ok(last.score > 0.99, `score should converge toward 1.0, got ${last.score}`);
  assert.equal(scoreOf("source:Flourishing"), last.score);
});

test("the debug outcomes tail is bounded — no per-traffic memory leak", () => {
  for (let i = 0; i < 5000; i++) record("source:Flourishing", true);
  const len = getDomainScope(D, S)["source:Flourishing"].outcomes.length;
  assert.ok(len <= 50, `outcomes tail must stay bounded, got ${len}`);
});

// ── Win-rate semantics vs the 0.5 cold prior ─────────────────────────────────

test("an engaged source floats ABOVE the 0.5 cold prior; a dismissed source sinks BELOW", () => {
  const click = record("source:Engaged", true).score;
  const dismiss = record("source:Dismissed", false).score;
  assert.ok(click > 0.5, `one click should float above cold prior, got ${click}`);
  assert.ok(dismiss < 0.5, `one dismiss should sink below cold prior, got ${dismiss}`);
});

test("a fully-dismissed source converges toward 0 (sinks below every cold-start card)", () => {
  let last;
  for (let i = 0; i < 200; i++) last = record("source:AllBad", false);
  assert.ok(last.score < 0.05, `all-dismiss should approach 0, got ${last.score}`);
});

test("a 50/50 source sits at ~0.5 (no engagement signal either way)", () => {
  for (let i = 0; i < 100; i++) { record("source:Mixed", true); record("source:Mixed", false); }
  const s = scoreOf("source:Mixed");
  assert.ok(Math.abs(s - 0.5) < 0.02, `50/50 should be ~0.5, got ${s}`);
});

// ── Cost-awareness stays bounded (model-routing) ─────────────────────────────

test("at equal win rate, a cheaper candidate outranks an expensive one — and both stay <=1", () => {
  for (let i = 0; i < 100; i++) {
    record("local", true, { cost: 0 });
    record("cloud", true, { cost: 0.01 });
  }
  const local = scoreOf("local");
  const cloud = scoreOf("cloud");
  assert.ok(local >= cloud, `local ($0) should rank >= cloud, got local=${local} cloud=${cloud}`);
  assert.ok(local <= 1 && cloud <= 1, "cost-aware scores must remain bounded <=1");
});

// ── Recency: decayFactor<1 weights recent outcomes ───────────────────────────

test("recency weighting: recent dismissals drag a once-good source down faster than a plain mean", () => {
  // 20 early successes then 5 recent dismissals, with decay so recent dominates.
  for (let i = 0; i < 20; i++) record("source:Decaying", true, { decay: 0.8 });
  for (let i = 0; i < 5; i++) record("source:Decaying", false, { decay: 0.8 });
  const decayed = scoreOf("source:Decaying");
  // Plain (no-decay) win rate of 20 wins / 25 = 0.8; recency-weighted must be lower.
  assert.ok(decayed < 0.8, `recency-weighted score should be dragged below the plain mean, got ${decayed}`);
  assert.ok(decayed >= 0 && decayed <= 1, "decayed score must stay bounded");
});

// ── The actual explore path: recordModelOutcome → rankCandidates ─────────────

test("explore interaction path (recordModelOutcome) keeps source scores bounded and ranks engaged > cold > dismissed", async () => {
  // Mirror routes/explore.js: key = source:<name>, taskType = "explore", cost 0.
  for (let i = 0; i < 10000; i++) await recordModelOutcome("source:Flourishing", "explore", true, 50, 0);
  await recordModelOutcome("source:Spam", "explore", false, 0, 0); // a single dismiss

  assert.ok(scoreOf("source:Flourishing") <= 1, "engaged source must stay bounded <=1");

  const cards = [
    { key: "source:Flourishing" }, // heavily engaged
    { key: "source:Read" },        // never interacted → cold prior
    { key: "source:Spam" },        // dismissed once
  ];
  const ranked = await rankCandidates(cards, "explore");
  const order = ranked.map((c) => c.key);
  assert.equal(order[0], "source:Flourishing", `engaged source should rank first, got ${order.join(", ")}`);
  assert.equal(order[2], "source:Spam", `dismissed source should rank last, got ${order.join(", ")}`);
  // The engaged source's lead over cold is bounded, not a 10000:0.5 blowout.
  const top = ranked.find((c) => c.key === "source:Flourishing").score;
  assert.ok(top <= 1, `top score must be bounded, got ${top}`);
});

// ── The actual live 10000: the unbounded agent-performance compositeScore fallback

test("the cold/restart fallback is bounded — agent-performance compositeScore must NOT leak into the ranking", async () => {
  // Reproduce the real live blowup: a fresh process has NO in-memory domain entry,
  // so rankCandidatesByDomain falls back to getTopAgentsForTask(). For a fast
  // ($latency≈0), free (cost 0), always-successful source the persisted log yields
  // compositeScore = (1.0 * 10) / (0.1 * 0.01) = 10000 — while successRate = 1.0.
  _agentRows = [{ agentId: "source:Flourishing", successRate: 1.0, compositeScore: 10000 }];

  const ranked = await rankCandidatesByDomain(
    [{ key: "source:Flourishing" }, { key: "source:Read" }],
    D,
    S,
    { coldStart: 0.5, taskType: "explore" },
  );
  const flo = ranked.find((c) => c.key === "source:Flourishing");
  assert.ok(flo.score <= 1, `fallback score must be bounded <=1, got ${flo.score} (regression: 10000 leaked)`);
  assert.equal(flo.score, 1.0, "successRate 1.0 maps to a bounded 1.0, not the 10000 compositeScore");
  // Still ranks above the cold-prior source — bounded lead, not a blowout.
  assert.equal(ranked[0].key, "source:Flourishing", "engaged fallback source still ranks first");
});
