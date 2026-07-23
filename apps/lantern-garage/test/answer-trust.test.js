"use strict";
// #2764 — the answer-trust signal + verify affordance. The fusion is heuristic (the cheap gates
// are weak), so these tests pin the CONTRACT: the strong probe dominates when present; weak
// grounding lowers trust and triggers the verify offer; grounding-fired + corroboration + good
// per-key history raise it; bands + the affordance string behave.
//
// Run: node apps/lantern-garage/test/answer-trust.test.js
const assert = require("assert");
const { answerTrust, verifyAffordance, HIGH, LOW } = require("../lib/answer-trust");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

check("the hidden-state probe dominates when wired (the ~0.99 signal)", () => {
  const hi = answerTrust({ probe: 0.95, confidence: 0.1 });
  assert.strictEqual(hi.strongSignal, true);
  assert.strictEqual(hi.band, "high");
  assert.strictEqual(hi.offerVerify, false);
  const lo = answerTrust({ probe: 0.2, confidence: 0.9 });
  assert.strictEqual(lo.band, "low");
  assert.strictEqual(lo.offerVerify, true);
});

check("weak grounding ceiling lowers trust and triggers the verify offer", () => {
  const r = answerTrust({ confidence: 0.9, allowedMaxConfidence: 0.4 });
  assert.ok(r.trust <= 0.4 + 1e-9, "confidence clamped to the ceiling");
  assert.strictEqual(r.band, "low");
  assert.strictEqual(r.offerVerify, true);
  assert.ok(r.reasons.some((x) => /ceiling/.test(x)));
});

check("the ceiling only lowers — a high ceiling doesn't inflate a low confidence", () => {
  const r = answerTrust({ confidence: 0.3, allowedMaxConfidence: 0.95 });
  assert.ok(r.trust <= 0.3 + 1e-9);
});

check("external grounding fired → a real lift (measured 0.55→0.20 hallucination)", () => {
  const off = answerTrust({ confidence: 0.5, grounded: false });
  const on = answerTrust({ confidence: 0.5, grounded: true });
  assert.ok(on.trust > off.trust);
  assert.ok(on.reasons.some((x) => /grounded/.test(x)));
});

check("good per-key calibration history pulls trust up; bad history pulls it down", () => {
  const good = answerTrust({ confidence: 0.5, calibrationTrust: 0.95 });
  const bad = answerTrust({ confidence: 0.5, calibrationTrust: 0.1 });
  assert.ok(good.trust > bad.trust);
  assert.ok(bad.offerVerify, "a poorly-calibrated key should offer verification");
});

check("corroborating sources add a small capped bump", () => {
  const none = answerTrust({ confidence: 0.5, corroboration: 0 });
  const some = answerTrust({ confidence: 0.5, corroboration: 3 });
  assert.ok(some.trust > none.trust);
  const capped = answerTrust({ confidence: 0.5, corroboration: 100 });
  assert.ok(capped.trust - none.trust <= 0.1 + 1e-9, "corroboration bump is capped");
});

check("bands: high ≥ 0.7, low < 0.45, and offerVerify tracks the low band", () => {
  assert.strictEqual(answerTrust({ confidence: HIGH }).band, "high");
  assert.strictEqual(answerTrust({ confidence: 0.5 }).band, "medium");
  const low = answerTrust({ confidence: 0.2 });
  assert.strictEqual(low.band, "low");
  assert.strictEqual(low.offerVerify, true);
});

check("verifyAffordance returns text only for low-trust answers", () => {
  assert.strictEqual(verifyAffordance(answerTrust({ confidence: 0.9 })), "");
  assert.ok(verifyAffordance(answerTrust({ confidence: 0.1 })).length > 0);
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
