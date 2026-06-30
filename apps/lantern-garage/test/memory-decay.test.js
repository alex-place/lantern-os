// #1422 — confidence-decay memory. The forgetting-curve math is pure and takes `now`
// explicitly, so it's deterministic; JSONL persistence is thin I/O.
//
// Run: node apps/lantern-garage/test/memory-decay.test.js
const assert = require("assert");
const md = require("../lib/memory-decay");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const days = (n) => T0 + n * md.DAY_MS;
const mem = (over) => ({ baseConfidence: 0.8, halfLifeDays: 14, reinforcements: 0, lastGroundedAt: "2026-01-01T00:00:00.000Z", ...over });

check("fresh memory keeps its base confidence at t=0", () =>
  assert.ok(Math.abs(md.decayedConfidence(mem(), T0) - 0.8) < 1e-9));

check("confidence halves after one half-life", () =>
  assert.ok(Math.abs(md.decayedConfidence(mem(), days(14)) - 0.4) < 1e-9));

check("confidence quarters after two half-lives", () =>
  assert.ok(Math.abs(md.decayedConfidence(mem(), days(28)) - 0.2) < 1e-9));

check("decay is monotonic over time", () => {
  const a = md.decayedConfidence(mem(), days(5));
  const b = md.decayedConfidence(mem(), days(20));
  assert.ok(a > b);
});

check("reinforcement extends the effective half-life (spaced repetition)", () => {
  assert.strictEqual(md.effectiveHalfLifeDays(mem({ reinforcements: 0 })), 14);
  assert.strictEqual(md.effectiveHalfLifeDays(mem({ reinforcements: 2 })), 14 * 2); // 14*(1+2*0.5)
});

check("staleness bands", () => {
  assert.strictEqual(md.staleness(0.9), "fresh");
  assert.strictEqual(md.staleness(0.5), "aging");
  assert.strictEqual(md.staleness(0.1), "stale");
});

check("reinforce resets the clock and lifts base confidence", () => {
  const before = mem({ baseConfidence: 0.6, reinforcements: 1 });
  const after = md.reinforceMemory(before, "2026-02-01T00:00:00.000Z");
  assert.strictEqual(after.lastGroundedAt, "2026-02-01T00:00:00.000Z");
  assert.strictEqual(after.reinforcements, 2);
  assert.ok(after.baseConfidence > 0.6 && after.baseConfidence <= 1);
});

check("re-grounding restores a faded memory toward full confidence", () => {
  const faded = mem();
  assert.ok(md.decayedConfidence(faded, days(28)) < 0.25);     // decayed
  const reground = md.reinforceMemory(faded, new Date(days(28)).toISOString());
  assert.ok(md.decayedConfidence(reground, days(28)) > 0.8);   // fresh again at re-ground time
});

check("rankMemories down-ranks stale facts and applies a floor", () => {
  const fresh = mem({ lastGroundedAt: new Date(days(27)).toISOString() });   // ~1 day old at days(28)
  const stale = mem({ lastGroundedAt: "2026-01-01T00:00:00.000Z" });          // 28 days old
  const ranked = md.rankMemories([stale, fresh], days(28), { floor: 0 });
  assert.strictEqual(ranked[0].lastGroundedAt, fresh.lastGroundedAt);          // fresher first
  const floored = md.rankMemories([stale, fresh], days(28), { floor: 0.3 });
  assert.strictEqual(floored.length, 1);                                       // stale dropped under floor
});

check("scoreMemory annotates confidence + staleness", () => {
  const s = md.scoreMemory(mem(), days(14));
  assert.ok(Math.abs(s.confidence - 0.4) < 1e-9);
  assert.strictEqual(s.staleness, "aging");
});

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall memory-decay checks passed\n");
