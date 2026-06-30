// #1438 — learn tutor SM-2 scheduling + retention. The math is pure (takes `now`).
//
// Run: node apps/lantern-garage/test/learn-tutor.test.js
const assert = require("assert");
const lt = require("../lib/learn-tutor");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

const NOW = Date.parse("2026-06-30T00:00:00.000Z");
const DAY = 86_400_000;
const fresh = () => ({ id: "c1", front: "q", back: "a", easeFactor: 2.5, interval: 0, repetitions: 0, lapses: 0, history: [] });
const intervalDays = (card) => Math.round((Date.parse(card.nextReview) - NOW) / DAY);

check("first good review schedules 1 day out", () => {
  const c = lt.reviewCard(fresh(), 4, NOW);
  assert.strictEqual(c.interval, 1);
  assert.strictEqual(c.repetitions, 1);
  assert.strictEqual(intervalDays(c), 1);
});

check("second good review → 6 days", () => {
  let c = lt.reviewCard(fresh(), 4, NOW);
  c = lt.reviewCard(c, 4, NOW);
  assert.strictEqual(c.interval, 6);
  assert.strictEqual(c.repetitions, 2);
});

check("third good review grows by ease factor", () => {
  let c = lt.reviewCard(fresh(), 5, NOW);
  c = lt.reviewCard(c, 5, NOW);
  const before = c.interval;
  const easeBefore = c.easeFactor;          // SM-2 uses the pre-update ease for the interval
  c = lt.reviewCard(c, 5, NOW);
  assert.ok(c.interval > before);
  assert.strictEqual(c.interval, Math.round(before * easeBefore));
});

check("a failed recall resets the streak, drops to 1 day, counts a lapse", () => {
  let c = lt.reviewCard(fresh(), 5, NOW);
  c = lt.reviewCard(c, 5, NOW);   // interval now 6
  c = lt.reviewCard(c, 1, NOW);   // forgot
  assert.strictEqual(c.interval, 1);
  assert.strictEqual(c.repetitions, 0);
  assert.strictEqual(c.lapses, 1);
});

check("ease factor drifts down on hard recalls but floors at 1.3", () => {
  let c = fresh();
  for (let i = 0; i < 12; i++) c = lt.reviewCard(c, 3, NOW);
  assert.ok(c.easeFactor >= 1.3);
});

check("history records each grade (capped)", () => {
  let c = lt.reviewCard(fresh(), 4, NOW);
  c = lt.reviewCard(c, 2, NOW);
  assert.deepStrictEqual(c.history.map((h) => h.grade), [4, 2]);
});

check("isDue: never-reviewed is due; future nextReview is not", () => {
  assert.strictEqual(lt.isDue({ }, NOW), true);
  assert.strictEqual(lt.isDue({ nextReview: new Date(NOW + 5 * DAY).toISOString() }, NOW), false);
  assert.strictEqual(lt.isDue({ nextReview: new Date(NOW - DAY).toISOString() }, NOW), true);
});

check("dueCards prioritizes most-overdue, then struggling (low ease)", () => {
  const cards = [
    { id: "fresh", nextReview: new Date(NOW + DAY).toISOString() },             // not due
    { id: "slightly", nextReview: new Date(NOW - DAY).toISOString(), easeFactor: 2.5 },
    { id: "veryOverdue", nextReview: new Date(NOW - 10 * DAY).toISOString(), easeFactor: 2.5 },
  ];
  const due = lt.dueCards(cards, NOW);
  assert.strictEqual(due.length, 2);
  assert.strictEqual(due[0].id, "veryOverdue");
});

check("isStruggling flags repeated lapses / low ease", () => {
  assert.strictEqual(lt.isStruggling({ lapses: 2 }), true);
  assert.strictEqual(lt.isStruggling({ easeFactor: 1.8 }), true);
  assert.strictEqual(lt.isStruggling({ lapses: 0, easeFactor: 2.5 }), false);
});

check("retentionStats: insufficient_data with no reviews; accuracy after", () => {
  assert.strictEqual(lt.retentionStats([{ history: [] }], NOW).status, "insufficient_data");
  const cards = [{ interval: 30, history: [{ grade: 5 }, { grade: 4 }, { grade: 2 }] }];
  const s = lt.retentionStats(cards, NOW);
  assert.strictEqual(s.status, "ok");
  assert.strictEqual(s.mature, 1);
  assert.ok(Math.abs(s.recentAccuracy - (2 / 3)) < 1e-9);
});

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall learn-tutor checks passed\n");
