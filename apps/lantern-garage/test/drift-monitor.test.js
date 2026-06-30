// #1428 — drift monitor aggregation. assessDrift() is pure (takes events + now), so the
// windowing / trend / alert logic is deterministic and locked here.
//
// Run: node apps/lantern-garage/test/drift-monitor.test.js
const assert = require("assert");
const dm = require("../lib/drift-monitor");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

const NOW = Date.parse("2026-06-30T12:00:00.000Z");
const H = 3_600_000;
const evt = (hoursAgo, tripped, over) => ({ ts: new Date(NOW - hoursAgo * H).toISOString(), tripped, ...over });

check("no events → insufficient_data, ok alert", () => {
  const d = dm.assessDrift([], { nowMs: NOW });
  assert.strictEqual(d.status, "insufficient_data");
  assert.strictEqual(d.alert, "ok");
  assert.strictEqual(d.recentTotal, 0);
});

check("quiet window → ok, both axes flat", () => {
  const d = dm.assessDrift([evt(100, ["collapse"])], { nowMs: NOW });   // outside 24h window
  assert.strictEqual(d.recentTotal, 0);
  assert.strictEqual(d.alert, "ok");
});

check("splits recent vs prior 24h windows per axis", () => {
  const events = [
    evt(2, ["collapse"]), evt(5, ["grounded"]), evt(10, ["collapse"]),   // recent (<24h)
    evt(30, ["collapse"]), evt(40, ["grounded"]),                          // prior (24–48h)
  ];
  const d = dm.assessDrift(events, { nowMs: NOW });
  assert.strictEqual(d.axes.collapse.recent, 2);
  assert.strictEqual(d.axes.collapse.prior, 1);
  assert.strictEqual(d.axes.grounded.recent, 1);
  assert.strictEqual(d.recentTotal, 3);
});

check("rising trend triggers a warn alert", () => {
  // recent 5 collapse, prior 1 → ratio 5 ≥ 1.5 → rising
  const events = [];
  for (let i = 0; i < 5; i++) events.push(evt(1 + i, ["collapse"]));
  events.push(evt(30, ["collapse"]));
  const d = dm.assessDrift(events, { nowMs: NOW });
  assert.strictEqual(d.axes.collapse.trend, "rising");
  assert.strictEqual(d.alert, "warn");
});

check("falling trend detected", () => {
  const events = [evt(2, ["collapse"])];
  for (let i = 0; i < 5; i++) events.push(evt(30 + i, ["collapse"]));   // prior heavy
  const d = dm.assessDrift(events, { nowMs: NOW });
  assert.strictEqual(d.axes.collapse.trend, "falling");
});

check("high absolute volume escalates to alert", () => {
  const events = [];
  for (let i = 0; i < 45; i++) events.push(evt(1 + i * 0.1, ["grounded"]));   // 45 in-window
  const d = dm.assessDrift(events, { nowMs: NOW });
  assert.strictEqual(d.alert, "alert");
});

check("top contributors by provider/agent", () => {
  const events = [
    evt(1, ["collapse"], { provider: "ollama", agent: "keystone" }),
    evt(2, ["collapse"], { provider: "ollama", agent: "lantern" }),
    evt(3, ["grounded"], { provider: "gemini", agent: "keystone" }),
  ];
  const d = dm.assessDrift(events, { nowMs: NOW });
  assert.strictEqual(d.byProvider[0].value, "ollama");
  assert.strictEqual(d.byProvider[0].count, 2);
  assert.strictEqual(d.byAgent[0].value, "keystone");
});

check("timeline buckets cover the window and sum to recent trips", () => {
  const events = [evt(1, ["collapse"]), evt(2, ["grounded"]), evt(23, ["collapse"])];
  const d = dm.assessDrift(events, { nowMs: NOW, buckets: 12 });
  assert.strictEqual(d.timeline.length, 12);
  const summed = d.timeline.reduce((a, b) => a + b.collapse + b.grounded, 0);
  assert.strictEqual(summed, 3);
});

check("trend() helper edge cases", () => {
  assert.strictEqual(dm.trend(0, 0), "flat");
  assert.strictEqual(dm.trend(3, 0), "rising");
  assert.strictEqual(dm.trend(2, 2), "stable");
});

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall drift-monitor checks passed\n");
