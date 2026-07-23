"use strict";

/**
 * test/spiral-harness.test.js
 *
 * The Phase-0 spiral loop (ADR-0029): the convergence loop run on ONE problem, whose
 * per-turn engine is a verified cascade (cheap → verify → escalate-inheriting-progress).
 * These tests pin the behaviors the design promises, with stub tiers + a stub verifier
 * so the loop is exercised end-to-end with no server or GPU:
 *
 *   - the ratchet: memory grows ONLY on a verified advance
 *   - the cascade: escalation fires ONLY when cheap stalls, and the escalate tier
 *     INHERITS the accumulated memory (progress preserved, not restarted)
 *   - honest halt: solved | answerability-decline | maxTurns
 *   - the escalation corpus: one row per turn, escalated+advancing rows flagged as
 *     distillation targets (the VTD fuel)
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/spiral-harness.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { runSpiral } = require("../lib/spiral-harness");

const R = (spec) => Object.entries(spec).map(([name, passed]) => ({ name, passed }));
// A collecting corpus sink + fixed clock so runs are deterministic and inspectable.
const sink = () => {
  const rows = [];
  return { file: "(test)", rows, append: (r) => rows.push(r) };
};
const clock = () => 1_700_000_000_000;

// A cheap tier that returns whatever text it's told; verify parses "pass:a,b" → results.
const parseVerify = (text) => {
  const m = String(text || "").match(/pass:([a-z0-9,]*)/i);
  const passing = new Set((m ? m[1] : "").split(",").filter(Boolean));
  return R({ a: passing.has("a"), b: passing.has("b"), c: passing.has("c") });
};

test("cheap solves on turn 0 → one commit, zero escalations, halt solved", async () => {
  const corpus = sink();
  const r = await runSpiral({
    problem: { id: "p1", prompt: "solve abc" },
    tiers: { cheap: async () => ({ text: "pass:a,b,c", cost: 0.001, model: "cheap" }), escalate: async () => { throw new Error("must not escalate"); } },
    verify: async (text) => parseVerify(text),
    corpus, now: clock,
  });
  assert.equal(r.solved, true);
  assert.equal(r.haltReason, "solved");
  assert.equal(r.escalations, 0, "cheap sufficed → no frontier spend");
  assert.equal(r.memory.length, 1, "one verified step committed");
  assert.equal(corpus.rows.length, 1);
  assert.equal(corpus.rows[0].tier, "cheap");
  assert.equal(corpus.rows[0].distillTarget, false, "a cheap step is not a distillation target");
});

test("cheap stalls → escalate rescues, and the escalated commit is a distillation target", async () => {
  const corpus = sink();
  let escalateSawMemory = null;
  const r = await runSpiral({
    problem: { id: "p2", prompt: "solve abc" },
    tiers: {
      cheap: async () => ({ text: "pass:", cost: 0.001, model: "cheap" }), // passes nothing → stalls
      escalate: async (ctx) => { escalateSawMemory = ctx.memory.length; return { text: "pass:a,b,c", cost: 0.02, model: "frontier" }; },
    },
    verify: async (text) => parseVerify(text),
    corpus, now: clock,
  });
  assert.equal(r.solved, true);
  assert.equal(r.escalations, 1, "exactly one escalation");
  assert.equal(escalateSawMemory, 0, "escalation inherits the (empty, turn-0) memory");
  assert.equal(corpus.rows[0].tier, "escalated");
  assert.equal(corpus.rows[0].distillTarget, true, "escalated + advancing = a VTD distillation target");
  assert.ok(r.cost >= 0.02, "the frontier call is billed");
});

test("escalation INHERITS accumulated progress (memory carries prior commits)", async () => {
  const corpus = sink();
  const seen = [];
  let turn = 0;
  const r = await runSpiral({
    problem: { id: "p3", prompt: "solve abc" },
    tiers: {
      // turn 0: cheap fixes 'a' (advances, commits). turn 1: cheap stalls → escalate,
      // which must SEE the turn-0 commit in memory (inherited progress).
      cheap: async () => ({ text: turn++ === 0 ? "pass:a" : "pass:a", cost: 0.001, model: "cheap" }),
      escalate: async (ctx) => { seen.push(ctx.memory.length); return { text: "pass:a,b,c", cost: 0.02, model: "frontier" }; },
    },
    verify: async (text) => parseVerify(text),
    corpus, now: clock,
  });
  assert.equal(r.solved, true);
  assert.deepEqual(seen, [1], "the escalate tier ran once and inherited 1 committed step");
  assert.equal(r.memory.length, 2, "turn-0 cheap commit + turn-1 escalated commit");
});

test("the ratchet: a non-advancing turn commits NOTHING and the loop continues", async () => {
  const corpus = sink();
  let turn = 0;
  const r = await runSpiral({
    problem: { id: "p4", prompt: "solve abc" },
    tiers: {
      // turn 0: advance (fix a). turn 1: same patch — no movement (stall, no commit).
      // turn 2: finish. No escalate tier → stalls just de-ratchet.
      cheap: async () => {
        const t = turn++;
        return { text: t === 0 ? "pass:a" : t === 1 ? "pass:a" : "pass:a,b,c", cost: 0.001, model: "cheap" };
      },
    },
    verify: async (text) => parseVerify(text),
    corpus, now: clock, maxTurns: 5,
  });
  assert.equal(r.solved, true);
  assert.equal(r.memory.length, 2, "only the two ADVANCING turns committed (turn 1 stalled)");
  assert.equal(r.turns, 3, "three turns ran");
  const stalls = corpus.rows.filter((x) => !x.advanced).length;
  assert.equal(stalls, 1, "the middle turn is logged as a non-advance");
});

test("honest-can't: answerability decline halts BEFORE spending a tier call", async () => {
  const corpus = sink();
  let cheapCalls = 0;
  const r = await runSpiral({
    problem: { id: "p5", prompt: "unanswerable" },
    tiers: { cheap: async () => { cheapCalls++; return { text: "pass:", cost: 1 }; } },
    verify: async (text) => parseVerify(text),
    answerability: async () => 0.05, // below the 0.15 floor
    corpus, now: clock,
  });
  assert.equal(r.haltReason, "answerability", "stops rather than bluffing");
  assert.equal(cheapCalls, 0, "no tier call spent once it's judged unanswerable");
  assert.equal(r.solved, false);
  assert.equal(r.cost, 0, "nothing billed");
});

test("maxTurns caps the unbounded loop; nothing spurious commits", async () => {
  const corpus = sink();
  const r = await runSpiral({
    problem: { id: "p6", prompt: "never solved" },
    tiers: { cheap: async () => ({ text: "pass:", cost: 0.001, model: "cheap" }) }, // always stalls
    verify: async (text) => parseVerify(text),
    // stallLimit 0: this test pins the OUTER safety cap; stop-on-stall (which would
    // halt this all-stall run earlier, honestly) has its own tests in
    // spiral-stall-tiering.test.js.
    corpus, now: clock, maxTurns: 3, stallLimit: 0,
  });
  assert.equal(r.haltReason, "maxTurns");
  assert.equal(r.solved, false);
  assert.equal(r.memory.length, 0, "no verified step ever committed");
  assert.equal(r.turns, 3, "ran exactly maxTurns turns");
  assert.equal(r.escalationRate, 0, "no escalate tier configured");
});

test("onStep surfaces a chat-renderable transcript (turn_start → verify → commit → halt)", async () => {
  const events = [];
  await runSpiral({
    problem: { id: "p7", prompt: "solve" },
    tiers: { cheap: async () => ({ text: "pass:a,b,c", cost: 0.001, model: "cheap" }) },
    verify: async (text) => parseVerify(text),
    onStep: (e) => events.push(e.type),
    corpus: sink(), now: clock,
  });
  for (const t of ["turn_start", "cheap_try", "verify", "commit", "halt"]) {
    assert.ok(events.includes(t), `emits a ${t} event for the chat panel`);
  }
});

test("escalationRate + cost accounting reflect the cascade", async () => {
  const corpus = sink();
  let turn = 0;
  const r = await runSpiral({
    problem: { id: "p8", prompt: "solve abc" },
    tiers: {
      // turn 0: cheap advances (fix a). turn 1: cheap stalls → escalate solves.
      cheap: async () => ({ text: turn++ === 0 ? "pass:a" : "pass:a", cost: 0.001, model: "cheap" }),
      escalate: async () => ({ text: "pass:a,b,c", cost: 0.05, model: "frontier" }),
    },
    verify: async (text) => parseVerify(text),
    corpus, now: clock,
  });
  assert.equal(r.turns, 2);
  assert.equal(r.escalations, 1);
  assert.ok(Math.abs(r.escalationRate - 0.5) < 1e-9, "1 of 2 turns escalated");
  // cost = cheap(0.001) + cheap(0.001) + escalate(0.05)
  assert.ok(Math.abs(r.cost - 0.052) < 1e-9, "billed both cheap tries + the one escalation");
});

test("validation: missing tiers.cheap or verify throws early", async () => {
  await assert.rejects(runSpiral({ problem: { id: "x" }, verify: async () => [] }), /tiers\.cheap/);
  await assert.rejects(runSpiral({ problem: { id: "x" }, tiers: { cheap: async () => ({ text: "" }) } }), /verify/);
  await assert.rejects(runSpiral({ tiers: { cheap: async () => ({}) }, verify: async () => [] }), /problem/);
});
