/**
 * Tests for the JS chat-level collapse canary (#1010).
 * Run: node tests/test_collapse_canary.js
 *
 * Acceptance: a forced repeating reply raises proximity + emits a logged signal;
 * healthy replies are unaffected.
 *
 * NOTE: the collapse canary's public API is `scoreReplyCollapse` (lib/collapse-canary.js),
 * and the serving-path observer is now the unified harness `runCanaries` (lib/canary.js,
 * which runs collapse + groundedness and appends one event stream). This test exercises
 * both: the proximity scorer directly, and the harness as the "observe" acceptance gate.
 */
const assert = require("assert");
const path = require("path");
const { scoreReplyCollapse, antiCollapseSignal } =
  require(path.resolve(__dirname, "..", "apps", "lantern-garage", "lib", "collapse-canary"));
const { runCanaries } =
  require(path.resolve(__dirname, "..", "apps", "lantern-garage", "lib", "canary"));

// The module's default crossing threshold (proximity >= THRESHOLD ⇒ collapsed).
const THRESHOLD = 0.5;

let n = 0;
const ok = (name, fn) => {
  try { fn(); n++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; }
};

console.log("collapse-canary (#1010)");

// ── proximity: n-gram echo / repetition ──────────────────────────────
ok("healthy unique text → low proximity", () => {
  const text = "The quick brown fox jumps over the lazy dog and then runs away into the woods at dawn";
  const { proximity, collapsed } = scoreReplyCollapse(text);
  assert.ok(proximity < 0.2, `expected < 0.2, got ${proximity}`);
  assert.strictEqual(collapsed, false);
});

ok("highly repetitive text → high proximity (collapsed)", () => {
  const phrase = "the cat sat on the mat";
  const repeated = Array(8).fill(phrase).join(" ");
  const { proximity, collapsed } = scoreReplyCollapse(repeated);
  assert.ok(proximity >= THRESHOLD, `expected >= ${THRESHOLD}, got ${proximity}`);
  assert.strictEqual(collapsed, true);
});

ok("short text → proximity 0 (too_short)", () => {
  const r = scoreReplyCollapse("hi");
  assert.strictEqual(r.proximity, 0);
  assert.strictEqual(r.reason, "too_short");
});

// ── echo signal: tail repeats head ───────────────────────────────────
ok("tail repeats head → high n-gram echo signal", () => {
  const head = "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron";
  const { signals } = scoreReplyCollapse(`${head}. ${head}. ${head}`);
  assert.ok(signals.ngramEchoRatio > 0.3, `expected echo > 0.3, got ${signals.ngramEchoRatio}`);
});

ok("novel varied text → low n-gram echo signal", () => {
  const text = "The sky is blue. The grass is green. Water is wet. Fire is hot. Snow is white. " +
    "Mountains are tall. Rivers run long. Birds sing songs. Clouds drift past. Stars glow bright.";
  const { signals } = scoreReplyCollapse(text);
  assert.ok(signals.ngramEchoRatio < 0.3, `expected echo < 0.3, got ${signals.ngramEchoRatio}`);
});

// ── computeProximity equivalent: healthy below, looping above ─────────
ok("healthy varied reply → below threshold", () => {
  const text = [
    "The Convergence Core is a local-first reasoning system that remembers, reasons, acts, and verifies.",
    "It stores experience in append-only logs and improves via retrieval, not weight modification.",
    "The primary interface is dream-chat.html where you can talk to Keystone directly.",
    "External grounding ensures nothing is accepted without evidence from web or codebase sources.",
  ].join(" ");
  const { proximity } = scoreReplyCollapse(text);
  assert.ok(proximity < THRESHOLD, `healthy text should be below ${THRESHOLD}, got ${proximity}`);
});

ok("forced repeating reply → above threshold", () => {
  const loopPhrase = "The answer is yes because the answer is yes because the answer is yes";
  const repeated = Array(5).fill(loopPhrase).join(". ");
  const { proximity } = scoreReplyCollapse(repeated);
  assert.ok(proximity >= THRESHOLD, `looping text should be >= ${THRESHOLD}, got ${proximity}`);
});

// ── harness "observe" acceptance (lib/canary.js) ─────────────────────
ok("observe: short text → collapse axis does not trip, proximity 0", () => {
  const r = runCanaries("hi there", { emit: false });
  assert.ok(!r.tripped.includes("collapse"));
  assert.strictEqual(r.collapse.proximity, 0);
});

ok("observe: healthy reply → collapse axis does not trip", () => {
  const text = "Keystone OS is a persistent local-first reasoning system. It uses a convergence loop: " +
    "Observe, Remember, Reason, Act, Verify. The system never fabricates evidence and always " +
    "grounds claims against observable reality. The dream journal is the primary user interface.";
  const r = runCanaries(text, { emit: false, context: { agent: "keystone", provider: "anthropic" } });
  assert.ok(!r.tripped.includes("collapse"), `proximity=${r.collapse.proximity}`);
});

ok("observe: looping reply → collapse axis trips + emits a logged signal (acceptance)", () => {
  const loopPhrase = "The cat sat on the mat and the cat sat on the mat and the cat sat on the mat";
  const text = Array(6).fill(loopPhrase).join(". ");
  const r = runCanaries(text, { emit: false, context: { agent: "keystone", provider: "ollama" } });
  assert.ok(r.tripped.includes("collapse"), `proximity=${r.collapse.proximity} should trip the collapse axis`);
  assert.ok(r.collapse.proximity >= THRESHOLD);
  // the harness stamps the advisory signal that gets logged to the canary event stream
  const sig = antiCollapseSignal(r.collapse);
  assert.strictEqual(sig.event, "canary_collapse");
  assert.ok(r.signaturePatch.canary && r.signaturePatch.canary.action, "logged signal present");
});

// ── #1342: run-on / rambling-collapse detection ─────────────────────
// The repetition signals above miss a lexically-diverse but topically-incoherent
// run-on (the real failure mode observed: hundreds of comma-less words with no
// sentence boundaries). The longestSegmentTokens signal catches it; code blocks and
// bullet lists must NOT trip it (they break on newlines).
ok("run-on rambling (no sentence boundaries) → collapsed", () => {
  const rambling = "a flamingo looks like a tall bird standing upright with thin legs sticking " +
    "out far behind while holding up its roundish head above its slim neck which curves slightly " +
    "downward towards its chest area covered mostly white except around eyes nostrils mouth beak " +
    "bill feet wings tail tip those parts turn bright reddish orange due pigments absorbed diet " +
    "especially shrimp crabs shellfish mollusks fish eggs insects larvae worms small crustaceans " +
    "planktonic organisms zooplankton tiny plants animals microscopic bacteria viruses fungi";
  const r = scoreReplyCollapse(rambling);
  assert.ok(r.collapsed, `run-on should collapse, got proximity=${r.proximity} seg=${r.signals.longestSegmentTokens}`);
  assert.ok(r.signals.longestSegmentTokens >= 70, `expected long unbroken segment, got ${r.signals.longestSegmentTokens}`);
});

ok("code block with long lines → NOT collapsed (breaks on newlines)", () => {
  const code = "Here is the parser:\n\n```python\ndef parse_csv(path):\n    rows = []\n    with open(path) as f:\n        for line in f:\n            rows.append(line.strip().split(\",\"))\n    return rows\n```\n\nThis reads each line and splits on commas to build a list of rows.";
  const r = scoreReplyCollapse(code);
  assert.ok(!r.collapsed, `code should not collapse, got proximity=${r.proximity} seg=${r.signals.longestSegmentTokens}`);
});

ok("bullet list without periods → NOT collapsed (breaks on newlines)", () => {
  const list = "Key points about black holes:\n- The event horizon is the boundary of no return\n" +
    "- Hawking radiation causes black holes to evaporate slowly over time\n" +
    "- Supermassive black holes sit at the centers of most large galaxies\n" +
    "- Stellar black holes form when massive stars exhaust their fuel and collapse";
  const r = scoreReplyCollapse(list);
  assert.ok(!r.collapsed, `list should not collapse, got proximity=${r.proximity} seg=${r.signals.longestSegmentTokens}`);
});

ok("run-on → antiCollapseSignal recommends truncate_output", () => {
  const rambling = Array(90).fill("word").map((w, i) => w + i).join(" "); // 90-token unbroken run
  const r = scoreReplyCollapse(rambling);
  const sig = antiCollapseSignal(r);
  assert.strictEqual(sig.action, "truncate_output", `expected truncate_output, got ${sig.action}`);
});

console.log(`\nPASS — ${n} collapse-canary checks`);
