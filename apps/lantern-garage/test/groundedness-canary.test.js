// Σ₀ groundedness canary (42-state guardrail) on the chat serving path.
// A confident reply with no external anchor must raise risk (the 42-state); the
// SAME claims, once anchored (grounding context or in-text source) OR honestly
// hedged, must drop below threshold.
//
// Run: node apps/lantern-garage/test/groundedness-canary.test.js
const assert = require("assert");
const { scoreReplyGroundedness, ungroundedSignal } = require("../lib/groundedness-canary");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// Confident, fluent, NON-repeating (collapse canary reads it as healthy) — yet it
// asserts hard facts with no source. This is the 42-state the degeneration canary misses.
const CONFIDENT_UNANCHORED =
  "The Treaty of Westphalia was signed in 1648 and ended the Thirty Years War. " +
  "It established the modern principle of state sovereignty across Europe. " +
  "Cardinal Mazarin negotiated the French terms, and the population of Münster was 12000 at the time.";

const confident = scoreReplyGroundedness(CONFIDENT_UNANCHORED);
check("confident + unanchored: flagged as 42-state", () => {
  assert.strictEqual(confident.ungrounded, true, `risk=${confident.risk}`);
  assert.ok(confident.risk >= 0.5, `expected high risk, got ${confident.risk}`);
  assert.strictEqual(confident.anchored, false);
});

// SAME claims, now grounded by upstream context that actually fired → not a 42-state.
const grounded = scoreReplyGroundedness(CONFIDENT_UNANCHORED, {
  groundingContext: "Web search: Peace of Westphalia, 1648, Münster/Osnabrück treaties ...",
});
check("same claims + external grounding: not flagged", () => {
  assert.strictEqual(grounded.ungrounded, false, `risk=${grounded.risk}`);
  assert.strictEqual(grounded.anchored, true);
  assert.ok(grounded.risk < confident.risk, "grounding must lower risk");
});

// SAME confidence, anchored by an in-text source link → not a 42-state.
const linked = scoreReplyGroundedness(
  CONFIDENT_UNANCHORED + " See [history](https://example.org/westphalia).");
check("same claims + in-text source link: not flagged", () => {
  assert.strictEqual(linked.ungrounded, false, `risk=${linked.risk}`);
  assert.strictEqual(linked.anchored, true);
});

// file:line citation counts as an anchor (the Keystone code-grounding case).
const fileCite = scoreReplyGroundedness(
  "The handler validates the request and returns a boolean. " +
  "It is wired in apps/lantern-garage/lib/stream-chat.js:716 and runs on every turn. " +
  "The router prefers the Anthropic chain when novelty is high.");
check("file:line citation: anchored", () => {
  assert.strictEqual(fileCite.anchored, true, `risk=${fileCite.risk}`);
  assert.strictEqual(fileCite.ungrounded, false);
});

// Honest hedging is NOT a 42-state even with no anchor — the reply isn't claiming
// certainty it can't back.
const HEDGED =
  "I'm not certain about the exact date, but I think the treaty was somewhere in the " +
  "mid-1600s. I don't have a source for the population figure, so I might be wrong about " +
  "the details — it's possible the negotiator was someone else entirely.";
const hedged = scoreReplyGroundedness(HEDGED);
check("honest hedging: not flagged despite no anchor", () => {
  assert.strictEqual(hedged.ungrounded, false, `risk=${hedged.risk}`);
  assert.ok(hedged.risk < confident.risk, "hedging must lower risk vs confident");
});

// The thesis-aligned healthy reply (loop description) is reflective, not a hard
// factual assertion dump → should not false-positive.
const HEALTHY =
  "The convergence loop observes the world, then reasons about what to do next and acts. " +
  "Each stage strengthens the one before it, and the idea is that nothing should be " +
  "accepted without checking it against something real.";
const healthy = scoreReplyGroundedness(HEALTHY);
check("reflective healthy reply: not flagged", () => {
  assert.strictEqual(healthy.ungrounded, false, `risk=${healthy.risk}`);
});

// Short replies don't false-positive.
const short = scoreReplyGroundedness("Yes, that's right.");
check("short reply: no signal (too_short)", () => {
  assert.strictEqual(short.ungrounded, false);
  assert.strictEqual(short.reason, "too_short");
});

// Advisory signal payload is usable.
check("ungroundedSignal emits a canary event + action", () => {
  const sig = ungroundedSignal(confident);
  assert.strictEqual(sig.event, "canary_ungrounded");
  assert.strictEqual(sig.action, "ground_or_flag");
  assert.ok(sig.risk >= 0.5);
});

// ── model-internal surprise (token-surprise.js) sharpening — #1260 enhancement ──
// Backward-compat: no tokenSurprise → identical score, modelUncertainty 0.
check("no tokenSurprise: behavior identical, modelUncertainty=0", () => {
  const a = scoreReplyGroundedness(CONFIDENT_UNANCHORED);
  assert.strictEqual(a.signals.modelUncertainty, 0);
  assert.strictEqual(a.risk, confident.risk); // unchanged from the text-only baseline
});

// A BORDERLINE confident+unanchored reply (2/5 assertive, risk ~0.4 < threshold) that the
// model was internally UNSURE about (high surprise) tips over into the 42-state.
const BORDERLINE =
  "The system works well in practice. The Treaty was signed in 1648. " +
  "It changed many things over time. Cardinal Mazarin led the talks. " +
  "The approach is generally sound and reliable.";
const borderlineBase = scoreReplyGroundedness(BORDERLINE);
check("borderline reply alone: not flagged", () => {
  assert.strictEqual(borderlineBase.ungrounded, false, `risk=${borderlineBase.risk}`);
  assert.ok(borderlineBase.risk < 0.5);
});
check("borderline + high model uncertainty: sharpened over threshold", () => {
  const s = scoreReplyGroundedness(BORDERLINE, { tokenSurprise: 0.9 });
  assert.ok(s.risk > borderlineBase.risk, `expected raise, ${s.risk} vs ${borderlineBase.risk}`);
  assert.strictEqual(s.ungrounded, true, `risk=${s.risk}`);
  assert.ok(s.signals.modelUncertainty > 0.8);
});
// RAISE-ONLY: internal confidence (low surprise) never LOWERS the text-only risk.
check("borderline + low model uncertainty: risk unchanged (raise-only)", () => {
  const s = scoreReplyGroundedness(BORDERLINE, { tokenSurprise: 0.0 });
  assert.strictEqual(s.risk, borderlineBase.risk);
});
// Surprise must NOT override an anchor — an anchored reply stays grounded even if the
// model was internally unsure (the source is what matters, per the External Reality Rule).
check("anchored reply + high model uncertainty: still not flagged", () => {
  const s = scoreReplyGroundedness(
    BORDERLINE + " See [src](https://example.org/x).", { tokenSurprise: 0.95 });
  assert.strictEqual(s.anchored, true);
  assert.strictEqual(s.ungrounded, false, `risk=${s.risk}`);
});
// Surprise must NOT manufacture risk from a reflective/non-assertive reply.
check("reflective reply + high model uncertainty: still healthy", () => {
  const s = scoreReplyGroundedness(HEALTHY, { tokenSurprise: 0.95 });
  assert.strictEqual(s.ungrounded, false, `risk=${s.risk}`);
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall groundedness-canary checks passed");
