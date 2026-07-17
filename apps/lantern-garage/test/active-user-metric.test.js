"use strict";
// Tests for lib/active-user-metric.js (#2547) — the composite active-user
// instrument. Framework-free (same style as deployment-profile.test.js):
// fabricate real artifacts in a temp tree, assert the MEASURED math.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const metric = require("../lib/active-user-metric");

let failures = 0;
function check(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  - ${name}`))
    .catch((e) => { failures++; console.error(`  FAIL- ${name}\n      ${e.message}`); })
    .finally(() => { if (--pending === 0) finish(); });
}
function finish() {
  if (failures) { console.error(`\n${failures} active-user-metric test(s) failed`); process.exit(1); }
  console.log("\nAll active-user-metric tests passed.");
}

// ── Fixture tree ────────────────────────────────────────────────────────────
const T = fs.mkdtempSync(path.join(os.tmpdir(), "aum-"));
const watchlistsDir = path.join(T, "watchlists");
const convRoot = path.join(T, "conversations", "users");
const tractionFile = path.join(T, "events.jsonl");
fs.mkdirSync(watchlistsDir, { recursive: true });

function seedUser(uid, { watchlist = false, chats = 0, trades = 0, unverifiedTrades = 0 } = {}) {
  if (watchlist) fs.writeFileSync(path.join(watchlistsDir, encodeURIComponent(uid) + ".json"), JSON.stringify(["SPY", "NVDA"]));
  if (chats > 0) {
    const dir = path.join(convRoot, uid);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [];
    for (let i = 0; i < chats; i++) lines.push(JSON.stringify({ role: "operator", text: `msg ${i}` }));
    lines.push(JSON.stringify({ role: "lantern", text: "reply" })); // assistant turns never count
    fs.writeFileSync(path.join(dir, "conversations.jsonl"), lines.join("\n") + "\n");
  }
  const ev = [];
  for (let i = 0; i < trades; i++) ev.push(JSON.stringify({ ts: new Date().toISOString(), kind: "paper_trade", actor: uid, verified: true }));
  for (let i = 0; i < unverifiedTrades; i++) ev.push(JSON.stringify({ ts: new Date().toISOString(), kind: "paper_trade", actor: uid, verified: false, source: "operator-reported" }));
  if (ev.length) fs.appendFileSync(tractionFile, ev.join("\n") + "\n");
}

function seedDailyActive(uid, daysAgoList, now) {
  const base = now.getTime();
  const ev = daysAgoList.map((d) => JSON.stringify({
    ts: new Date(base - d * 86400000).toISOString(), kind: "daily_active", actor: uid, verified: true,
  }));
  fs.appendFileSync(tractionFile, ev.join("\n") + "\n");
}

const O = { watchlistsDir, conversationsUsersRoot: convRoot, tractionFile };

// alice qualifies on every leg; bob misses chats; cara misses the watchlist;
// dave's only trade is OPERATOR_REPORTED (must not count); the operator has
// everything and must be excluded entirely.
seedUser("alice", { watchlist: true, chats: 12, trades: 2 });
seedUser("bob", { watchlist: true, chats: 3, trades: 1 });
seedUser("cara", { chats: 15, trades: 1 });
seedUser("dave", { watchlist: true, chats: 11, unverifiedTrades: 1 });
seedUser("alex-place", { watchlist: true, chats: 40, trades: 5 });

const NOW = new Date("2026-07-16T12:00:00Z");
seedDailyActive("retained-ria", [30, 29, 2], NOW);   // first 30d ago, active day 1 + day 28 after first → retained
seedDailyActive("lapsed-lou", [31, 30], NOW);        // first 31d ago, nothing in the 28–35 window → churned
seedDailyActive("young-yui", [5, 1], NOW);           // too young for an M1 verdict → excluded from cohort

let pending = 7;

check("composite: only the all-three user is active, with per-user evidence", () => {
  const { users, actives } = metric.evaluateActiveUsers(O);
  assert.strictEqual(actives.length, 1, `expected 1 active, got ${actives.length}`);
  assert.strictEqual(actives[0].userId, "alice");
  assert.ok(actives[0].evidence.watchlist && actives[0].evidence.conversations, "alice must carry artifact evidence");
  const byId = Object.fromEntries(users.map((u) => [u.userId, u]));
  assert.strictEqual(byId.bob.active, false, "bob (3 chats) must not be active");
  assert.strictEqual(byId.cara.active, false, "cara (no watchlist) must not be active");
});

check("OPERATOR_REPORTED paper trades never count (acceptance criterion)", () => {
  const { users } = metric.evaluateActiveUsers(O);
  const dave = users.find((u) => u.userId === "dave");
  assert.ok(dave, "dave is a known user (watchlist+chats)");
  assert.strictEqual(dave.paperTrades, 0, "unverified trade must not count");
  assert.strictEqual(dave.active, false);
});

check("operator identities are excluded from every count", () => {
  const { users } = metric.evaluateActiveUsers(O);
  assert.ok(!users.some((u) => u.userId === "alex-place"), "operator must not appear at all");
});

check("M1 retention: retained/lapsed cohort math, young users excluded, honest rate", () => {
  const r = metric.m1Retention({ ...O, now: NOW });
  assert.strictEqual(r.cohortSize, 2, `cohort should be 2 (ria+lou), got ${r.cohortSize}`);
  assert.strictEqual(r.retained, 1, "only ria retained");
  assert.ok(Math.abs(r.rate - 0.5) < 1e-9, "rate = 1/2");
  assert.ok(!r.cohort.some((c) => c.userId === "young-yui"), "5-day-old user has no M1 verdict");
});

check("M1 retention rate is null (not 0) with an empty cohort", () => {
  const empty = path.join(T, "empty.jsonl");
  fs.writeFileSync(empty, "");
  const r = metric.m1Retention({ ...O, tractionFile: empty });
  assert.strictEqual(r.cohortSize, 0);
  assert.strictEqual(r.rate, null, "unmeasurable ≠ zero");
});

check("level1Snapshot carries targets + MEASURED provenance and no self-reported numbers", () => {
  const s = metric.level1Snapshot(O);
  assert.deepStrictEqual(s.targets, { active: 50, paying: 15, m1Retention: 0.4 });
  assert.strictEqual(s.provenance, "MEASURED");
  assert.strictEqual(s.actives.count, 1);
  assert.ok(Array.isArray(s.actives.users) && s.actives.users[0].evidence, "headline count carries per-user evidence");
});

check("weekly rollup appends once per ISO week (idempotent), MEASURED + verified", async () => {
  const r1 = await metric.runWeeklyRollup({ ...O, now: NOW });
  assert.strictEqual(r1.skipped, false, "first run appends");
  const r2 = await metric.runWeeklyRollup({ ...O, now: NOW });
  assert.strictEqual(r2.skipped, true, "same-week rerun no-ops");
  const rollups = fs.readFileSync(tractionFile, "utf8").split("\n").filter((l) => l.includes('"weekly_rollup"'));
  assert.strictEqual(rollups.length, 1, `exactly one rollup event, got ${rollups.length}`);
  const ev = JSON.parse(rollups[0]);
  assert.strictEqual(ev.verified, true);
  assert.strictEqual(ev.evidence.actives, 1);
  assert.strictEqual(ev.evidence.week, metric.isoWeek(NOW));
});
