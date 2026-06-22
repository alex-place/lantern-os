// Σ₀ fast-layer plasticity (#1011) — unit tests for grounding-calibration.
// The per-grounding, replayable trust weights + Brier calibration that update
// every interval with NO neural weight change. The frozen-weights grounding-loop
// spec audit flagged this module had ZERO tests; this is that gate.
//
// Run: node apps/lantern-garage/test/grounding-calibration.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  recordGrounding, trust, calibration, foldKey, summarize, clamp01,
} = require("../lib/grounding-calibration");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// Isolated root so tests never touch the real data/convergence log.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gcal-"));

check("clamp01 bounds to [0,1] and maps NaN -> 0", () => {
  assert.strictEqual(clamp01(-1), 0);
  assert.strictEqual(clamp01(2), 1);
  assert.strictEqual(clamp01(0.42), 0.42);
  assert.strictEqual(clamp01("x"), 0);
});

check("foldKey: trust = Beta posterior mean (1+hits)/(2+n); brier = mean (p-o)^2", () => {
  const evs = [
    { key: "k", predicted: 0.9, outcome: 1 },
    { key: "k", predicted: 0.8, outcome: 1 },
    { key: "k", predicted: 0.7, outcome: 0 },
  ];
  const f = foldKey(evs);
  assert.strictEqual(f.n, 3);
  assert.ok(Math.abs(f.trust - 0.6) < 1e-9, `trust=${f.trust}`);          // (1+2)/(2+3)
  const expected = ((0.1 ** 2) + (0.2 ** 2) + (0.7 ** 2)) / 3;
  assert.ok(Math.abs(f.brier - expected) < 1e-9, `brier=${f.brier}`);
});

check("trust(): 0.5 prior when a key has never been grounded", () => {
  assert.strictEqual(trust("never-seen", root), 0.5);
});

check("recordGrounding appends, returns the updated weight, and moves trust with evidence", () => {
  const key = "unit-src";
  recordGrounding({ key, predicted: 0.9, outcome: 1, ts: "t1" }, root);
  const u = recordGrounding({ key, predicted: 0.9, outcome: 1, ts: "t2" }, root);
  assert.strictEqual(u.n, 2);
  assert.ok(Math.abs(u.trust - 0.75) < 1e-9, `trust=${u.trust}`);          // (1+2)/(2+2)
  assert.ok(trust(key, root) > 0.5, "two hits push trust above the 0.5 prior");
  recordGrounding({ key, predicted: 0.9, outcome: 0, ts: "t3" }, root);     // a miss
  assert.ok(trust(key, root) < 0.75, "a miss pulls trust back down");
});

check("recordGrounding requires a key", () => {
  assert.throws(() => recordGrounding({ predicted: 1, outcome: 1 }, root), /key required/);
});

check("calibration(): global Brier + per-key fold over the whole log", () => {
  const c = calibration(root);
  assert.ok(c.total_events >= 3);
  assert.ok(c.global_brier >= 0 && c.global_brier <= 1, `brier=${c.global_brier}`);
  assert.ok(c.keys["unit-src"], "per-key entry present");
});

check("summarize is a pure, deterministic fold (replayable)", () => {
  const events = [
    { key: "a", predicted: 1, outcome: 1 },
    { key: "a", predicted: 0, outcome: 1 },
    { key: "b", predicted: 0.5, outcome: 0 },
  ];
  assert.deepStrictEqual(summarize(events), summarize(events));
  const s = summarize(events);
  assert.strictEqual(s.total_events, 3);
  assert.strictEqual(s.keys.a.n, 2);
});

try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}

console.log(failures ? `\n${failures} FAILED` : "\nall grounding-calibration tests passed");
process.exit(failures ? 1 : 0);
