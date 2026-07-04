// Σ₀ Council review (lib/council-review.js): ONE call folds both faces into Δ and routes it
// through the 3-way answerability gate (grounded / seam-open / pin). Δ is a max() so neither
// failure mode hides inside the other, and a PIN (unreachable) must NOT escalate to a human.
//
// Run: node apps/lantern-garage/test/council-review.test.js
const assert = require("assert");
const { councilReview, COUNCIL_REVIEWS } = require("../lib/council-review");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const HEALTHY =
  "The convergence loop observes the world, then reasons about what to do next and acts. " +
  "Each stage strengthens the one before it, and nothing is accepted without checking it " +
  "against something real first.";

// Healthy reply, no dissent → low Δ → grounded → answer.
check("healthy + no dissent: grounded, answer", () => {
  const r = councilReview(HEALTHY, { emit: false });
  assert.ok(r.delta < 0.5, `delta=${r.delta}`);
  assert.strictEqual(r.verdict, "grounded");
  assert.strictEqual(r.recommend, "answer");
  assert.strictEqual(r.escalated, false);
});

// Parrot loop trips the collapse axis → Δ_verify high → seam_open (reachable) → escalate.
const LOOP = ("I can help with that. ").repeat(12);
check("collapse axis alone → seam_open, escalate", () => {
  const r = councilReview(LOOP, { emit: false });
  assert.ok(r.deltaVerify >= 0.5, `deltaVerify=${r.deltaVerify}`);
  assert.strictEqual(r.verdict, "seam_open");
  assert.strictEqual(r.recommend, "escalate");
  assert.strictEqual(r.escalated, true);
});

// 42-state (fluent but unanchored) trips groundedness, NOT collapse → still seam_open.
// Proves Δ is a max(): the grounded axis is not diluted by a healthy collapse score.
const CONFIDENT_UNANCHORED =
  "The Treaty of Westphalia was signed in 1648 and ended the Thirty Years War. " +
  "It established the modern principle of state sovereignty across Europe. " +
  "Cardinal Mazarin negotiated the French terms, and the population of Münster was 12000 at the time.";
check("42-state → seam_open via grounded axis (Δ is max, not average)", () => {
  const r = councilReview(CONFIDENT_UNANCHORED, { emit: false });
  assert.strictEqual(r.collapse.collapsed, false, "must look healthy to collapse axis");
  assert.ok(r.grounded.risk >= 0.5, `grounded.risk=${r.grounded.risk}`);
  assert.strictEqual(r.verdict, "seam_open");
});

// PIN: the SAME contested 42-state but with no reachable external referent → name the unknown,
// and DO NOT escalate to a human (they can't ground it either — the Oracle refuses to bluff).
check("contested + unreachable → pin, name_unknown, no escalation", () => {
  const r = councilReview(CONFIDENT_UNANCHORED, { emit: false, reachable: false });
  assert.ok(r.delta >= 0.5, `delta=${r.delta}`);
  assert.strictEqual(r.verdict, "pin");
  assert.strictEqual(r.recommend, "name_unknown");
  assert.strictEqual(r.escalated, false, "a pin must not escalate to the operator");
});

// Reason-face: dissent alone (even on a healthy reply) → seam_open at DISSENT_SCALE.
check("dissent alone → seam_open (reason face)", () => {
  const r = councilReview(HEALTHY, {
    emit: false,
    dissent: [
      "correctness vs risk — off-by-one in the loop bound",
      "risk vs alternative — unsafe default on empty input",
      "correctness vs alternative — wrong API for the retry path",
    ],
  });
  assert.ok(r.deltaReason >= 1, `deltaReason=${r.deltaReason}`);
  assert.strictEqual(r.verdict, "seam_open");
});

// External grounding lowers Δ AND flips the verdict to grounded+anchored → answer (cite).
check("grounding context → grounded + anchored (answer with cite)", () => {
  const bare = councilReview(CONFIDENT_UNANCHORED, { emit: false });
  const grounded = councilReview(CONFIDENT_UNANCHORED, {
    emit: false, groundingContext: "Web search: Peace of Westphalia, 1648, ended the Thirty Years War.",
  });
  assert.ok(grounded.delta < bare.delta, `grounded ${grounded.delta} < bare ${bare.delta}`);
  assert.strictEqual(grounded.verdict, "grounded");
  assert.strictEqual(grounded.anchored, true);
});

// Execution OVERRIDES text: a passing test grounds the answer even when the lenses dissented.
check("execution passed → grounded/answer (overrides dissent)", () => {
  const r = councilReview(HEALTHY, {
    emit: false,
    dissent: ["a vs b — x", "b vs c — y", "a vs c — z"],   // would be seam_open on its own
    execVerdict: { ran: true, passed: true },
  });
  assert.strictEqual(r.verdict, "grounded");
  assert.strictEqual(r.recommend, "answer");
  assert.strictEqual(r.groundedBy, "execution");
});

// A failed test is REFUTED — wrong with proof → retry against the failure, NOT escalate.
check("execution failed → refuted/retry, not escalated", () => {
  const r = councilReview(HEALTHY, {
    emit: false,
    execVerdict: { ran: true, passed: false, output: "AssertionError: f(2) == 5" },
  });
  assert.strictEqual(r.verdict, "refuted");
  assert.strictEqual(r.recommend, "retry");
  assert.strictEqual(r.escalated, false);
  assert.strictEqual(r.groundedBy, "execution");
});

// execVerdict not run → falls back to the text gate (existing behavior preserved).
check("execVerdict {ran:false} → text gate unchanged", () => {
  const r = councilReview(HEALTHY, { emit: false, execVerdict: { ran: false, passed: false } });
  assert.strictEqual(r.verdict, "grounded");
  assert.strictEqual(r.groundedBy, "low_delta");
});

// #1924: a reply that EXPLICITLY disclaims grounding (no access / placeholder / assumption)
// must NOT be stamped grounded, even though hedging keeps its Δ low. Self-consistency between
// the two faces is not evidence — route it to the honest unverified state (seam_open).
const SELF_DISCLAIMED =
  "I don't have direct access to its codebase, so I can't inspect the actual files. " +
  "Based on the name lantern-os, I will create a placeholder entry describing what such a " +
  "project probably contains, and you can correct it once you share the real repository.";
check("self-declared ungrounded (placeholder/assumption) → seam_open, NOT grounded", () => {
  const r = councilReview(SELF_DISCLAIMED, { emit: false });
  assert.ok(r.delta < 0.5, `hedged reply keeps Δ low: delta=${r.delta}`);
  assert.strictEqual(r.grounded.selfUngrounded, true, "canary must flag the self-disclaimer");
  assert.strictEqual(r.verdict, "seam_open", "must not be grounded");
  assert.notStrictEqual(r.groundedBy, "low_delta");
});

// Same self-disclaimed reply, operator unreachable → PIN (still not grounded), no escalation.
check("self-declared ungrounded + unreachable → pin, not grounded", () => {
  const r = councilReview(SELF_DISCLAIMED, { emit: false, reachable: false });
  assert.strictEqual(r.verdict, "pin");
  assert.strictEqual(r.escalated, false);
});

// A genuinely grounded reply with a real anchor is unaffected: the guard is scoped to the
// self-disclaimer, so honest cited answers still earn the green "✓ Σ₀ grounded" badge.
check("anchored reply is still grounded (no over-flagging)", () => {
  const r = councilReview(HEALTHY, {
    emit: false, groundingContext: "Repo README: the convergence loop is Observe→Reason→Act→Verify→Converge.",
  });
  assert.strictEqual(r.verdict, "grounded");
  assert.strictEqual(r.grounded.selfUngrounded, false);
});

// The record path is the canonical convergence sink and points at the council log.
check("council review log path is data/convergence/council-reviews.jsonl", () => {
  assert.ok(/data[\\/]convergence[\\/]council-reviews\.jsonl$/.test(COUNCIL_REVIEWS), COUNCIL_REVIEWS);
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall council answerability-gate checks passed");
