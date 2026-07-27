"use strict";

/**
 * test/spiral-stall-tiering.test.js
 *
 * The cascade-policy quick wins (cross-domain prior art → the spiral loop):
 *
 *   - STOP-ON-STALL (ECC decoders): `stallLimit` consecutive non-advancing turns
 *     halt the run with reason "stalled"; a cycling generator (same candidate
 *     re-proposed) halts with reason "loop" — no grinding to the turn cap.
 *   - PASS-TERMINATES / cheapest-check-first (hierarchical assay): a candidate
 *     identical to one that already stalled, or to the current best, is scored as a
 *     stall WITHOUT paying the verifier.
 *   - BIDIRECTIONAL TIERING (call-routing): after a fully-stalled turn the next
 *     turn starts at the frontier rung (no doomed cheap try); any commit
 *     de-escalates back to cheap.
 *   - WHOLE-ANSWER CONFIDENCE: the returned confidence is the fraction of tests the
 *     best committed candidate passes — decoupled from where the loop stopped.
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/spiral-stall-tiering.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { runSpiral } = require("../lib/spiral-harness");

// results helper: { a: true, b: false } → [{ name, passed }]
const R = (m) => Object.entries(m).map(([name, passed]) => ({ name, passed }));
const sink = () => {
  const rows = [];
  return { file: "(test)", rows, append: (r) => rows.push(r) };
};
const clock = () => 1_700_000_000_000;
// verify parses "pass:a,b" → pass/fail over the fixed test names a, b.
const parseVerify = (text) => {
  const m = String(text || "").match(/pass:([a-z0-9,]*)/i);
  const passing = new Set((m ? m[1] : "").split(",").filter(Boolean));
  return R({ a: passing.has("a"), b: passing.has("b") });
};

test("stop-on-stall: stallLimit consecutive no-progress turns halt 'stalled' before the cap", async () => {
  let i = 0;
  const r = await runSpiral({
    problem: { id: "s1", prompt: "hopeless" },
    // Unique text each turn (so the loop detector stays out of the way) that never
    // passes anything — pure stall.
    tiers: { cheap: async () => ({ text: `pass: /*${i++}*/`, cost: 0.001 }) },
    verify: async (text) => parseVerify(text),
    corpus: sink(), now: clock, maxTurns: 12,
  });
  assert.equal(r.haltReason, "stalled", "halts honestly instead of grinding the cap");
  assert.equal(r.turns, 3, "default stallLimit is 3 consecutive stalls");
  assert.equal(r.solved, false);
  assert.equal(r.memory.length, 0);
  assert.equal(r.confidence, 0, "nothing committed → whole-answer confidence 0");
});

test("a commit RESETS the stall counter (stalls must be consecutive)", async () => {
  let i = 0;
  const seq = ["pass: x0", "pass: x1", "pass:a", "pass: x2", "pass: x3", "pass: x4"];
  const r = await runSpiral({
    problem: { id: "s2", prompt: "advances mid-run" },
    tiers: { cheap: async () => ({ text: seq[i++] || "pass: tail" + i, cost: 0.001 }) },
    verify: async (text) => parseVerify(text),
    corpus: sink(), now: clock, maxTurns: 12,
  });
  // stalls at t0,t1 (2) → commit at t2 resets → stalls at t3,t4,t5 (3) → halt.
  assert.equal(r.haltReason, "stalled");
  assert.equal(r.turns, 6, "the pre-commit stalls did not count toward the final run");
  assert.equal(r.memory.length, 1, "the one advancing step committed");
});

test("loop detection: a re-proposed stalled candidate skips the paid verify and halts 'loop'", async () => {
  let verifyCalls = 0;
  const events = [];
  const r = await runSpiral({
    problem: { id: "s3", prompt: "cycling generator" },
    tiers: { cheap: async () => ({ text: "pass: same-every-turn", cost: 0.001 }) },
    verify: async (text) => { verifyCalls += 1; return parseVerify(text); },
    onStep: (e) => events.push(e.type),
    corpus: sink(), now: clock, maxTurns: 12,
  });
  assert.equal(verifyCalls, 1, "the identical candidate is never re-verified (cheapest check first)");
  assert.equal(r.haltReason, "loop", "two consecutive all-duplicate turns = the generator is cycling");
  assert.equal(r.turns, 3, "t0 real verify+stall, t1+t2 duplicate turns");
  assert.ok(events.includes("verify_skipped"), "the skip is surfaced to the transcript");
});

test("re-proposing the CURRENT BEST is also a free stall (it cannot advance itself)", async () => {
  let verifyCalls = 0;
  let i = 0;
  const seq = ["pass:a", "pass:a", "pass:a,b"]; // t1 re-proposes the committed best
  const r = await runSpiral({
    problem: { id: "s4", prompt: "echoes its own best" },
    tiers: { cheap: async () => ({ text: seq[i++], cost: 0.001 }) },
    verify: async (text) => { verifyCalls += 1; return parseVerify(text); },
    corpus: sink(), now: clock, maxTurns: 5,
  });
  assert.equal(r.solved, true);
  assert.equal(verifyCalls, 2, "t0 and t2 paid; the t1 echo of the best was free");
  assert.equal(r.corpusRows.filter((x) => x.verifySkipped).length, 1, "the skip is in the corpus row");
});

test("sticky rise: after a fully-stalled turn the next turn starts at the frontier (no doomed cheap try)", async () => {
  let cheapCalls = 0;
  let escCalls = 0;
  const r = await runSpiral({
    problem: { id: "s5", prompt: "hard for everyone" },
    tiers: {
      cheap: async () => ({ text: `pass: c${cheapCalls++}`, cost: 0.001 }),
      escalate: async () => ({ text: `pass: e${escCalls++}`, cost: 0.02 }),
    },
    verify: async (text) => parseVerify(text),
    corpus: sink(), now: clock, maxTurns: 12, escalationContract: false,
  });
  assert.equal(r.haltReason, "stalled");
  assert.equal(cheapCalls, 1, "cheap tried once (t0); t1+t2 went straight to the frontier");
  assert.equal(escCalls, 3, "the frontier carried every turn of the hard streak");
  assert.equal(r.escalations, 3);
  assert.equal(r.escalationRate, 1);
});

test("de-escalation: a frontier commit returns the NEXT turn to the cheap rung", async () => {
  let cheapCalls = 0;
  let escCalls = 0;
  const cheapSeq = ["pass: c0", "pass:a,b"]; // t0 stalls; t1 (post-rescue) solves cheap
  const r = await runSpiral({
    problem: { id: "s6", prompt: "hard start, easy finish" },
    tiers: {
      cheap: async () => ({ text: cheapSeq[cheapCalls++], cost: 0.001 }),
      escalate: async () => { escCalls += 1; return { text: "pass:a", cost: 0.02 }; },
    },
    verify: async (text) => parseVerify(text),
    corpus: sink(), now: clock, maxTurns: 12,
  });
  assert.equal(r.solved, true);
  assert.equal(escCalls, 1, "one rescue only");
  assert.equal(cheapCalls, 2, "after the frontier commit the loop de-escalated and cheap finished");
  assert.equal(r.memory.length, 2);
});

test("stickyTiers:false restores cheap-first-every-turn", async () => {
  let cheapCalls = 0;
  let escCalls = 0;
  const r = await runSpiral({
    problem: { id: "s7", prompt: "hard, legacy tiering" },
    tiers: {
      cheap: async () => ({ text: `pass: c${cheapCalls++}`, cost: 0.001 }),
      escalate: async () => ({ text: `pass: e${escCalls++}`, cost: 0.02 }),
    },
    verify: async (text) => parseVerify(text),
    corpus: sink(), now: clock, maxTurns: 12, stickyTiers: false, escalationContract: false,
  });
  assert.equal(r.haltReason, "stalled");
  assert.equal(cheapCalls, 3, "every turn re-tried cheap first (the legacy shape)");
  assert.equal(escCalls, 3);
});

test("stallLimit:0 disables the stall/loop halts (outer cap still rules); dup-skip economics stay", async () => {
  let verifyCalls = 0;
  const r = await runSpiral({
    problem: { id: "s8", prompt: "never solved, halting disabled" },
    tiers: { cheap: async () => ({ text: "pass: constant", cost: 0.001 }) },
    verify: async (text) => { verifyCalls += 1; return parseVerify(text); },
    corpus: sink(), now: clock, maxTurns: 4, stallLimit: 0,
  });
  assert.equal(r.haltReason, "maxTurns", "with stop-on-stall disabled only the cap halts");
  assert.equal(r.turns, 4);
  assert.equal(verifyCalls, 1, "duplicates still never pay the verifier");
});

test("whole-answer confidence: partial progress reports the committed pass fraction, not the halt reason", async () => {
  let i = 0;
  const seq = ["pass:a", "pass: x0", "pass: x1", "pass: x2"]; // commit 1/2 tests, then stall out
  const r = await runSpiral({
    problem: { id: "s9", prompt: "half-solved then stuck" },
    tiers: { cheap: async () => ({ text: seq[i++] || "pass: t" + i, cost: 0.001 }) },
    verify: async (text) => parseVerify(text),
    corpus: sink(), now: clock, maxTurns: 12,
  });
  assert.equal(r.haltReason, "stalled");
  assert.equal(r.solved, false);
  assert.equal(r.confidence, 0.5, "best committed candidate passes a but not b → 0.5");
});

test("whole-answer confidence: solved is 1", async () => {
  const r = await runSpiral({
    problem: { id: "s10", prompt: "easy" },
    tiers: { cheap: async () => ({ text: "pass:a,b", cost: 0.001 }) },
    verify: async (text) => parseVerify(text),
    corpus: sink(), now: clock,
  });
  assert.equal(r.solved, true);
  assert.equal(r.confidence, 1);
});

test("escalation contract (#2867): a verified non-advancing escalation halts the run immediately", async () => {
  let cheapCalls = 0;
  let escCalls = 0;
  const r = await runSpiral({
    problem: { id: "s11", prompt: "frontier can't help either" },
    tiers: {
      cheap: async () => ({ text: `pass: c${cheapCalls++}`, cost: 0.001 }),
      escalate: async () => ({ text: `pass: e${escCalls++}`, cost: 0.02 }),
    },
    verify: async (text) => parseVerify(text),
    corpus: sink(), now: clock, maxTurns: 12,
  });
  assert.equal(r.haltReason, "escalation-noncontractive", "frontier spend must help or the loop stops");
  assert.equal(r.turns, 1, "halts on the FIRST non-contractive escalation");
  assert.equal(escCalls, 1, "exactly one frontier call was paid");
  assert.equal(r.memory.length, 0);
});

test("escalation contract: dup-skipped escalations never trigger it (the loop detector owns those)", async () => {
  const r = await runSpiral({
    problem: { id: "s12", prompt: "both tiers echo the same wrong code" },
    tiers: {
      cheap: async () => ({ text: "pass: same-wrong", cost: 0.001 }),
      escalate: async () => ({ text: "pass: same-wrong", cost: 0.02 }),
    },
    verify: async (text) => parseVerify(text),
    corpus: sink(), now: clock, maxTurns: 12,
  });
  assert.equal(r.haltReason, "loop", "a no-new-information echo is loop evidence, not a contract breach");
});

test("failure cache (#2869): avoid-constraints ride into every tiers ctx; unsolved halts record VERIFIED failures only", async () => {
  const seenAvoid = [];
  const recorded = [];
  const stubCache = {
    avoidFor: () => [{ approachHash: "h1", snippet: "function f(){bad}", failingTests: ["t0"] }],
    recordFailures: (args) => recorded.push(args),
  };
  let i = 0;
  const r = await runSpiral({
    problem: { id: "s13", prompt: "recurring task" },
    tiers: { cheap: async (ctx) => { seenAvoid.push(ctx.avoid); return { text: `pass: v${i++}`, cost: 0.001 }; } },
    verify: async (text) => parseVerify(text),
    corpus: sink(), now: clock, maxTurns: 12, failureCache: stubCache,
  });
  assert.equal(r.haltReason, "stalled");
  assert.ok(seenAvoid.every((a) => Array.isArray(a) && a.length === 1), "avoid list reached every propose call");
  assert.equal(recorded.length, 1, "one record on the unsolved halt");
  assert.equal(recorded[0].stalledCandidates.length, 3, "all three REAL-verified stalls recorded");
  assert.ok(recorded[0].stalledCandidates.every((c) => c.failingTests.length > 0), "failing test names captured");
});

test("failure cache: solved runs record nothing; no cache configured = no ctx.avoid surprises", async () => {
  const recorded = [];
  const stubCache = { avoidFor: () => [], recordFailures: (a) => recorded.push(a) };
  const r1 = await runSpiral({
    problem: { id: "s14", prompt: "easy" },
    tiers: { cheap: async () => ({ text: "pass:a,b", cost: 0.001 }) },
    verify: async (text) => parseVerify(text),
    corpus: sink(), now: clock, failureCache: stubCache,
  });
  assert.equal(r1.solved, true);
  assert.equal(recorded.length, 0, "solved → nothing recorded");
  const ctxs = [];
  await runSpiral({
    problem: { id: "s15", prompt: "no cache" },
    tiers: { cheap: async (ctx) => { ctxs.push(ctx.avoid); return { text: "pass:a,b", cost: 0.001 }; } },
    verify: async (text) => parseVerify(text),
    corpus: sink(), now: clock,
  });
  assert.ok(ctxs.every((a) => Array.isArray(a) && a.length === 0), "default is an empty avoid list");
});

test("memory cap (#2977): prompt view is windowed + text-capped; ratchet history stays complete", async () => {
  const seenMemories = [];
  const BIG = "x".repeat(10_000);
  let t = 0;
  const r = await runSpiral({
    problem: { id: "s16", prompt: "long horizon" },
    tiers: { cheap: async (ctx) => { seenMemories.push(ctx.memory); return { text: `${BIG}/*${t++}*/`, cost: 0.001 }; } },
    // Every candidate "advances" (never solves) so memory grows each turn.
    verify: async () => ({ advanced: true, solved: false, fixRate: 0.5, penalizedFixRate: 0.5 }),
    corpus: sink(), now: clock, maxTurns: 6,
  });
  assert.equal(r.memory.length, 6, "the RETURNED ratchet history is complete");
  assert.ok(r.memory.every((s) => s.text.length > 9000), "full texts preserved internally");
  const lastView = seenMemories[seenMemories.length - 1];
  assert.equal(lastView.length, 4, "prompt view capped at the default window of 4");
  assert.ok(lastView.every((s) => s.text.length <= 4000), "per-step text capped in the view");
  assert.ok(lastView.every((s) => !s.text || s._truncated === 10_006 || s.text.length <= 4000), "true length receipted");
  assert.ok(r.corpusRows.filter((x) => x.advanced).every((x) => x.text && x.text.length > 9000),
    "advancing corpus rows carry the FULL text — the distillation record is complete");
});

test("memory cap: memoryWindow 0 = uncapped view (legacy); small runs unaffected by defaults", async () => {
  const seen = [];
  let t = 0;
  await runSpiral({
    problem: { id: "s17", prompt: "uncapped" },
    tiers: { cheap: async (ctx) => { seen.push(ctx.memory.length); return { text: `v${t++}`, cost: 0.001 }; } },
    verify: async () => ({ advanced: true, solved: false, fixRate: 0.5, penalizedFixRate: 0.5 }),
    corpus: sink(), now: clock, maxTurns: 6, memoryWindow: 0,
  });
  assert.equal(seen[seen.length - 1], 5, "window 0 passes the whole history");
});

test("holdout (#2999): a visible-solve that breaks the held-out test is NOT solved; the loop recovers", async () => {
  let t = 0;
  // Candidate 0 passes ALL visible tests but fails holdout (the memorizer).
  // Candidate 1 passes visible AND holdout (the real solution).
  const cands = ["pass:a,b", "pass:a,b,H"];
  const r = await runSpiral({
    problem: { id: "s18", prompt: "transduction trap" },
    tiers: { cheap: async () => ({ text: cands[Math.min(t++, 1)], cost: 0.001 }) },
    verify: async (text) => parseVerify(text), // visible split: tests a,b
    holdoutVerify: async (text) => [{ name: "H", passed: /H/.test(text) }],
    corpus: sink(), now: clock, maxTurns: 6,
  });
  assert.equal(r.solved, true, "the loop kept going past the memorizer and truly solved");
  assert.equal(r.turns, 2, "one holdout rejection, then the real solve");
  assert.equal(r.y, "pass:a,b,H", "the returned answer passes the held-out test");
  assert.equal(r.confidence, 1);
  assert.equal(r.holdout.frac, 1);
});

test("holdout: unsolved runs return the HOLDOUT-best commit, visible-best kept in yVisible", async () => {
  let t = 0;
  // Both commit (advance on visible); first scores better on holdout than second.
  const seq = ["pass:a,H", "pass:a,b"]; // second is visible-better but holdout-worse
  const r = await runSpiral({
    problem: { id: "s19", prompt: "select visible, return holdout" },
    tiers: { cheap: async () => ({ text: seq[t] || `pass: filler${t}`, cost: 0.001, model: `m${t++}` }) },
    verify: async (text) => parseVerify(text),
    holdoutVerify: async (text) => [{ name: "H", passed: /H/.test(text) }],
    corpus: sink(), now: clock, maxTurns: 12, stallLimit: 3,
  });
  assert.equal(r.solved, false);
  assert.equal(r.y, "pass:a,H", "holdout-best returned even though a later commit was visible-better");
  assert.equal(r.yVisible, "pass:a,b", "visible-best preserved for transparency");
  assert.equal(r.confidence, 1, "confidence is the held-out pass fraction of the returned answer");
});

test("holdout: absent → legacy semantics untouched (y = visible-best, holdout null)", async () => {
  const r = await runSpiral({
    problem: { id: "s20", prompt: "legacy" },
    tiers: { cheap: async () => ({ text: "pass:a,b", cost: 0.001 }) },
    verify: async (text) => parseVerify(text),
    corpus: sink(), now: clock,
  });
  assert.equal(r.solved, true);
  assert.equal(r.y, "pass:a,b");
  assert.equal(r.holdout, null);
});

test("splitHoldout: last-n held out deterministically; the visible split is never emptied", () => {
  const { splitHoldout } = require("../lib/spiral-tiers");
  const tests = [{ name: "a" }, { name: "b" }, { name: "c" }];
  const s = splitHoldout(tests, 1);
  assert.deepEqual(s.visible.map((t) => t.name), ["a", "b"]);
  assert.deepEqual(s.holdout.map((t) => t.name), ["c"]);
  const greedy = splitHoldout(tests, 99);
  assert.equal(greedy.visible.length, 1, "visible never empties — a loop with no selection tests cannot ratchet");
  assert.equal(splitHoldout([{ name: "only" }], 1).holdout.length, 0, "a single test stays visible");
});
