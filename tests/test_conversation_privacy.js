// test_conversation_privacy.js — #770 redact-at-rest + operator-only global access.
// Run: node tests/test_conversation_privacy.js
const assert = require("node:assert");
const { redactPII } = require("../apps/lantern-garage/lib/redact");
const { isOperatorRequest } = require("../apps/lantern-garage/lib/request-auth");
const { normalizeConversationEntry } = require("../apps/lantern-garage/lib/conversation-store");

let n = 0;
const ok = (name) => { n += 1; console.log("  ok -", name); };

// ── redactPII ──────────────────────────────────────────────────────────────
function red(s) { return redactPII(s); }
assert.strictEqual(red("email me at alex.place.7@gmail.com please"), "email me at [redacted-email] please");
assert.ok(red("key sk-ant-api03-AbCdEf12345678 done").includes("[redacted-key]"));
assert.ok(red("aws AKIAIOSFODNN7EXAMPLE here").includes("[redacted-key]"));
assert.ok(red("ghp_abcdefghijklmnopqrstuvwxyz0123 x").includes("[redacted-key]"));
assert.ok(red("tok eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM.SflKxwRJSMeKK x").includes("[redacted-jwt]"));
assert.strictEqual(red("auth: Bearer abcdef0123456789xyz"), "auth: Bearer [redacted-token]");
assert.strictEqual(red("ssn 123-45-6789 ok"), "ssn [redacted-ssn] ok");
assert.strictEqual(red("card 4111 1111 1111 1111 end"), "card [redacted-cc] end");
assert.strictEqual(red("call (415) 555-1234 now"), "call [redacted-phone] now");
ok("redacts emails, keys, jwt, bearer, ssn, card, phone");

assert.strictEqual(red("the answer is 42 and we have 7 items"), "the answer is 42 and we have 7 items");
assert.strictEqual(red(""), "");
assert.strictEqual(red(null), null);
ok("leaves ordinary text + non-strings untouched");

// ── redact at rest in the conversation store ────────────────────────────────
const entry = normalizeConversationEntry({ role: "operator", text: "reach me at a@b.com or 415-555-9999" });
assert.ok(!entry.text.includes("a@b.com"), "email must be redacted at rest");
assert.ok(entry.text.includes("[redacted-email]"));
assert.ok(!entry.text.includes("415-555-9999"), "phone must be redacted at rest");
ok("normalizeConversationEntry redacts PII before storage");

// ── operator-request gate ───────────────────────────────────────────────────
const reqFrom = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });
for (const lo of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
  assert.strictEqual(isOperatorRequest(reqFrom(lo), {}), true, `${lo} is operator`);
}
assert.strictEqual(isOperatorRequest(reqFrom("203.0.113.5"), {}), false, "remote w/o token is NOT operator");
assert.strictEqual(
  isOperatorRequest(reqFrom("203.0.113.5", { "x-operator-token": "s3cret" }), { OPERATOR_TOKEN: "s3cret" }),
  true, "remote with matching token is operator");
assert.strictEqual(
  isOperatorRequest(reqFrom("203.0.113.5", { "x-operator-token": "wrong" }), { OPERATOR_TOKEN: "s3cret" }),
  false, "remote with wrong token is NOT operator");
assert.strictEqual(
  isOperatorRequest(reqFrom("203.0.113.5", { "x-operator-token": "s3cret" }), {}),
  false, "no token configured → remote untrusted");
ok("operator gate: loopback or matching OPERATOR_TOKEN only");

console.log(`\nPASS — ${n} conversation-privacy checks`);
