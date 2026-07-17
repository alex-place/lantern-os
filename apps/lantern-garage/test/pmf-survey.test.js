"use strict";
// Tests for lib/pmf-survey.js (#2551) — the Sean Ellis fit-check.
// Framework-free, temp-tree fixtures (same style as active-user-metric.test.js).

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const pmf = require("../lib/pmf-survey");

let failures = 0, pending = 6;
let queue = Promise.resolve(); // SEQUENTIAL: these checks share fixtures and depend on order
function check(name, fn) {
  queue = queue
    .then(fn)
    .then(() => console.log(`  ok  - ${name}`))
    .catch((e) => { failures++; console.error(`  FAIL- ${name}\n      ${e.message}`); })
    .finally(() => { if (--pending === 0) finish(); });
}
function finish() {
  if (failures) { console.error(`\n${failures} pmf-survey test(s) failed`); process.exit(1); }
  console.log("\nAll pmf-survey tests passed.");
}

// ── Fixtures: an ACTIVE user (alice) per the composite definition ────────────
const T = fs.mkdtempSync(path.join(os.tmpdir(), "pmf-"));
const watchlistsDir = path.join(T, "watchlists");
const convRoot = path.join(T, "conversations", "users");
const tractionFile = path.join(T, "events.jsonl");
fs.mkdirSync(watchlistsDir, { recursive: true });

function mkActive(uid) {
  fs.writeFileSync(path.join(watchlistsDir, uid + ".json"), JSON.stringify(["SPY"]));
  const dir = path.join(convRoot, uid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "conversations.jsonl"),
    Array.from({ length: 11 }, (_, i) => JSON.stringify({ role: "operator", text: "m" + i })).join("\n") + "\n");
  fs.appendFileSync(tractionFile, JSON.stringify({ ts: new Date().toISOString(), kind: "paper_trade", actor: uid, verified: true }) + "\n");
}
mkActive("alice");
mkActive("bob");
mkActive("alex-place"); // operator — must never be surveyed
// carol chats but is NOT composite-active (no watchlist/trade)
fs.mkdirSync(path.join(convRoot, "carol"), { recursive: true });
fs.writeFileSync(path.join(convRoot, "carol", "conversations.jsonl"),
  Array.from({ length: 20 }, () => JSON.stringify({ role: "operator", text: "hi" })).join("\n") + "\n");

const O = { watchlistsDir, conversationsUsersRoot: convRoot, tractionFile };

check("eligibility: active+never-asked yes; inactive no; operator no", () => {
  assert.strictEqual(pmf.eligibility("alice", O).eligible, true);
  assert.strictEqual(pmf.eligibility("carol", O).eligible, false);
  assert.strictEqual(pmf.eligibility("carol", O).reason, "not_active");
  assert.strictEqual(pmf.eligibility("alex-place", O).eligible, false);
  assert.strictEqual(pmf.eligibility("alex-place", O).reason, "operator_or_unknown");
});

check("prompt-once: second prompt no-ops with an auditable reason", async () => {
  const r1 = await pmf.recordPrompted("alice", O);
  assert.strictEqual(r1.ok, true);
  const r2 = await pmf.recordPrompted("alice", O);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, "already_prompted");
  const prompted = fs.readFileSync(tractionFile, "utf8").split("\n").filter((l) => l.includes("pmf_prompted"));
  assert.strictEqual(prompted.length, 1, "exactly one pmf_prompted event");
});

check("response: valid feeling required; one per user ever", async () => {
  const bad = await pmf.recordResponse("alice", { feeling: "meh" }, O);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, "invalid_feeling");
  const r1 = await pmf.recordResponse("alice", { feeling: "very_disappointed", benefit: "it remembers me" }, O);
  assert.strictEqual(r1.ok, true);
  const r2 = await pmf.recordResponse("alice", { feeling: "not_disappointed" }, O);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, "already_answered");
});

check("after answering, eligibility is permanently false", async () => {
  const e = pmf.eligibility("alice", O);
  assert.strictEqual(e.eligible, false);
  assert.strictEqual(e.reason, "already_answered");
});

check("tally: dedup by user, rate vs the 40% bar, free-text carried", async () => {
  await pmf.recordResponse("bob", { feeling: "not_disappointed", alternative: "spreadsheets" }, O);
  const t = pmf.tally(O);
  assert.strictEqual(t.n, 2);
  assert.strictEqual(t.counts.very_disappointed, 1);
  assert.strictEqual(t.counts.not_disappointed, 1);
  assert.ok(Math.abs(t.pctVeryDisappointed - 0.5) < 1e-9);
  assert.strictEqual(t.pass, true, "50% >= 40% bar");
  assert.ok(t.freeText.some((f) => f.benefit === "it remembers me"));
  assert.ok(t.freeText.some((f) => f.alternative === "spreadsheets"));
});

check("empty log: rate is null and the check does NOT pass", () => {
  const empty = path.join(T, "empty.jsonl");
  fs.writeFileSync(empty, "");
  const t = pmf.tally({ tractionFile: empty });
  assert.strictEqual(t.n, 0);
  assert.strictEqual(t.pctVeryDisappointed, null);
  assert.strictEqual(t.pass, false, "unmeasured never passes the gate");
});
