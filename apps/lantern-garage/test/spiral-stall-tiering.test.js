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
