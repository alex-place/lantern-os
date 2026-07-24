"use strict";
// Tests for lib/referrals.js (#2554) — refer-a-friend attribution + conversion.
// Framework-free, sequential (shared fixture + ordered writes).

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ref = require("../lib/referrals");

let failures = 0, pending = 6;
let queue = Promise.resolve();
function check(name, fn) {
  queue = queue.then(fn)
    .then(() => console.log(`  ok  - ${name}`))
    .catch((e) => { failures++; console.error(`  FAIL- ${name}\n      ${e.message}`); })
    .finally(() => { if (--pending === 0) {
      if (failures) { console.error(`\n${failures} referrals test(s) failed`); process.exit(1); }
      console.log("\nAll referrals tests passed.");
    } });
}

// ── Fixtures: alice (referrer) + composite-active machinery for the referee ──
const T = fs.mkdtempSync(path.join(os.tmpdir(), "ref-"));
const watchlistsDir = path.join(T, "watchlists");
const convRoot = path.join(T, "conversations", "users");
const tractionFile = path.join(T, "events.jsonl");
fs.mkdirSync(watchlistsDir, { recursive: true });
process.env.REFERRAL_SECRET = "test-secret-referrals";

const PROFILES = [
  { id: "alice", email: "a@x.com" },
  { id: "bob", email: "b@x.com" },
  { id: "cara", email: "c@x.com" },
];
const O = { watchlistsDir, conversationsUsersRoot: convRoot, tractionFile, listProfiles: () => PROFILES };

function makeActive(uid) {
  fs.writeFileSync(path.join(watchlistsDir, uid + ".json"), JSON.stringify(["SPY"]));
  const dir = path.join(convRoot, uid); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "conversations.jsonl"),
    Array.from({ length: 11 }, (_, i) => JSON.stringify({ role: "operator", text: "m" + i })).join("\n") + "\n");
  fs.appendFileSync(tractionFile, JSON.stringify({ ts: new Date().toISOString(), kind: "paper_trade", actor: uid, verified: true }) + "\n");
}

check("codes are deterministic, unforgeable, and resolve back to the user", () => {
  const c = ref.codeFor("alice");
  assert.ok(/^[a-z0-9]{6,16}$/.test(c), "code is share-safe: " + c);
  assert.strictEqual(ref.codeFor("alice"), c, "deterministic");
  assert.notStrictEqual(ref.codeFor("bob"), c, "per-user");
  assert.strictEqual(ref.resolveCode(c, O), "alice");
  assert.strictEqual(ref.resolveCode("notacode", O), null, "forged code resolves to nobody");
});

check("attribution: valid code links referrer→referee, MEASURED", async () => {
  const r = await ref.attributeSignup({ code: ref.codeFor("alice"), refereeId: "bob" }, O);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.event.kind, "referral_signup");
  assert.strictEqual(r.event.verified, true);
  assert.strictEqual(r.event.evidence.referrer, "alice");
  assert.strictEqual(r.event.evidence.referee, "bob");
});

check("no self-referral, no double-attribution, no bad code", async () => {
  assert.strictEqual((await ref.attributeSignup({ code: ref.codeFor("alice"), refereeId: "alice" }, O)).reason, "self_referral");
  assert.strictEqual((await ref.attributeSignup({ code: ref.codeFor("alice"), refereeId: "bob" }, O)).reason, "already_attributed");
  assert.strictEqual((await ref.attributeSignup({ code: "garbage", refereeId: "cara" }, O)).reason, "bad_code");
});

check("anti-gaming: a signup that never gets active does NOT convert", () => {
  const c = ref.conversions(O);
  assert.strictEqual(c.totalSignups, 1, "bob attributed");
  assert.strictEqual(c.totalConverted, 0, "bob isn't active yet → not reward-eligible");
  assert.strictEqual(c.rewardIssuance, "founder_decision", "module never auto-issues comp");
});

check("conversion: once the referee is composite-active, it counts", () => {
  makeActive("bob");
  const c = ref.conversions(O);
  assert.strictEqual(c.totalSignups, 1);
  assert.strictEqual(c.totalConverted, 1, "bob is active → converted");
  const alice = c.referrers.find((r) => r.referrer === "alice");
  assert.strictEqual(alice.signups, 1);
  assert.strictEqual(alice.converted, 1);
  assert.deepStrictEqual(alice.convertedReferees, ["bob"]);
});

check("link carries the code and no PII", () => {
  const link = ref.linkFor("alice", "https://www.unisona.ai");
  assert.ok(link.includes("ref=" + ref.codeFor("alice")));
  assert.ok(!/alice|@/.test(link), "no user id or email in the link");
});
