/**
 * Unit tests for the fast-layer per-grounding weight updater (#1011).
 *   - apps/lantern-garage/lib/grounding-calibration.js
 *
 * Pure-core + temp-file tests — no network, no server. Run:
 *   node tests/test_grounding_calibration.js
 *
 * The property under test is the thesis-safe one: the trust weight updates in
 * real time on each grounding, yet is a PURE FUNCTION of an append-only log
 * (replayable / reversible — unlike an irreversible gradient step).
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const mod = require(path.resolve(
  __dirname, "..", "apps", "lantern-garage", "lib", "grounding-calibration.js"));
const { recordGrounding, trust, calibration, foldKey, readEvents } = mod;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  -", name); passed++; }
  catch (e) { console.log("  FAIL-", name, "::", e.message); failed++; }
}
function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "calib-"));
}

// ── Pure core ────────────────────────────────────────────────────────────────
test("empty key → uninformative prior (trust 0.5, no brier)", () => {
  const f = foldKey([]);
  assert.strictEqual(f.trust, 0.5);
  assert.strictEqual(f.brier, null);
});

test("brier math: confident-and-right is low, confident-and-wrong is high", () => {
  const right = foldKey([{ key: "x", predicted: 0.8, outcome: 1 }]);
  const wrong = foldKey([{ key: "x", predicted: 0.8, outcome: 0 }]);
  assert.ok(Math.abs(right.brier - 0.04) < 1e-9, "0.8 vs 1 → 0.04");
  assert.ok(Math.abs(wrong.brier - 0.64) < 1e-9, "0.8 vs 0 → 0.64");
});

test("trust moves toward empirical correctness", () => {
  const good = foldKey(Array.from({ length: 9 }, () => ({ key: "g", predicted: 0.9, outcome: 1 }))
    .concat([{ key: "g", predicted: 0.9, outcome: 0 }]));     // 9/10 right
  assert.ok(good.trust > 0.8, `9/10 right → trust ${good.trust} > 0.8`);
  const bad = foldKey(Array.from({ length: 10 }, () => ({ key: "b", predicted: 0.9, outcome: 0 })));
  assert.ok(bad.trust < 0.15, `0/10 right → trust ${bad.trust} < 0.15`);
});

// ── Real-time, per-grounding update ──────────────────────────────────────────
test("each grounding updates the weight immediately (real time, per loop)", () => {
  const root = tmpRoot();
  const t0 = trust("gemini", root);                          // unseen → 0.5
  assert.strictEqual(t0, 0.5);
  const a = recordGrounding({ key: "gemini", predicted: 0.7, outcome: 1, ts: "t1" }, root);
  assert.ok(a.trust > t0, `after a right grounding, trust ${a.trust} > ${t0}`);
  const b = recordGrounding({ key: "gemini", predicted: 0.7, outcome: 0, ts: "t2" }, root);
  assert.ok(b.trust < a.trust, `after a wrong grounding, trust ${b.trust} < ${a.trust}`);
  assert.strictEqual(b.n, 2, "two groundings logged");
});

// ── Reversible / replayable (the thesis-safe property) ───────────────────────
test("weight is a pure fold of the append-only log (reversible, not destructive)", () => {
  const root = tmpRoot();
  recordGrounding({ key: "k", predicted: 0.6, outcome: 1, ts: "t1" }, root);
  recordGrounding({ key: "k", predicted: 0.6, outcome: 1, ts: "t2" }, root);
  const live = trust("k", root);
  // Independently replay the raw log → identical weight (no hidden mutable state).
  const replayed = foldKey(readEvents(root).filter((e) => e.key === "k")).trust;
  assert.strictEqual(live, replayed, "replay reproduces the weight exactly");
  // And it is the fold of a prefix — i.e. you can reconstruct any past weight.
  const afterFirst = foldKey(readEvents(root).filter((e) => e.key === "k").slice(0, 1)).trust;
  assert.ok(afterFirst !== live, "earlier weight is recoverable from the log prefix");
});

test("calibration() reports global brier + per-key weights", () => {
  const root = tmpRoot();
  recordGrounding({ key: "anthropic", predicted: 0.9, outcome: 1, ts: "t1" }, root);
  recordGrounding({ key: "ollama", predicted: 0.9, outcome: 0, ts: "t2" }, root);
  const c = calibration(root);
  assert.strictEqual(c.total_events, 2);
  assert.ok(c.keys.anthropic.trust > c.keys.ollama.trust, "right-source out-trusts wrong-source");
  assert.ok(c.global_brier > 0, "global brier reflects the one miss");
});

console.log(`\ngrounding-calibration: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
