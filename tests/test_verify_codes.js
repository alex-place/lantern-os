/**
 * Signup confirmation CODES (lib/verify-codes.js).
 *
 * A 6-digit code is only 10^6 possibilities, so unlike the HMAC action tokens it is
 * NOT safe on entropy alone — its security rests entirely on the properties pinned
 * here. Each of these is load-bearing:
 *
 *   1. The plaintext code is never stored, and the stored form is a SALTED SCRYPT hash
 *      — not a fast keyed digest, which 10^6 candidates would fall to instantly if the
 *      store and the server secret both leaked (CodeQL js/insufficient-password-hash).
 *   2. A code is single-use — a replay after success fails.
 *   3. Wrong guesses are counted and the code dies at MAX_ATTEMPTS. This, not the TTL,
 *      is what makes a 6-digit secret defensible: without it, 10^6 guesses inside the
 *      15-minute window is trivial.
 *   4. Expiry is enforced.
 *   5. Issuing supersedes the previous code, so "resend" invalidates the old email
 *      and a user can't bank several live codes.
 *   6. A code is bound to its profile — it cannot confirm a different account.
 *
 * Isolation: the store path resolves from process.cwd() at call time, so we chdir
 * into a temp dir before requiring the module.
 *
 * Run: node tests/test_verify_codes.js
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-verify-codes-"));
const origCwd = process.cwd();
process.chdir(tmp);
// The data root is resolved from the module tree, not the cwd (#3088) — isolate the
// store with UNISONA_STATE_DIR, set BEFORE any lib require reads it.
process.env.UNISONA_STATE_DIR = tmp;
process.env.SESSION_SECRET = ["unit", "test", "strong", "secret", "not", "dev", "default"].join("-");

const LIB = path.join(__dirname, "..", "apps", "lantern-garage", "lib");
const vc = require(path.join(LIB, "verify-codes"));

let passed = 0;
const ok = (n) => { passed++; console.log("  ✓ " + n); };

async function main() {
  // ── 1. Shape + the plaintext is never persisted ────────────────────────────────
  const code = await vc.issueCode("prof-1", "a@ex.com");
  assert.ok(/^\d{6}$/.test(code), `expected 6 digits, got ${code}`);
  const raw = fs.readFileSync(vc.storePath(), "utf8");
  assert.ok(!raw.includes(code), "the store must NOT contain the plaintext code");
  assert.ok(raw.includes("prof-1"), "the store does record the profile it belongs to");
  const lastRecord = () =>
    JSON.parse(fs.readFileSync(vc.storePath(), "utf8").trim().split(/\r?\n/).pop());
  assert.ok(lastRecord().salt && lastRecord().salt.length >= 16, "each record carries its own salt");
  // Two codes must not share a salt, or the store becomes precomputable across records.
  const salts = new Set();
  for (let i = 0; i < 3; i++) {
    await vc.issueCode("salt-probe", null);
    salts.add(lastRecord().salt);
  }
  assert.strictEqual(salts.size, 3, "every issued code gets a fresh salt");
  ok("issueCode returns 6 digits and stores only a per-record salted hash");

  // ── 2. Correct code succeeds exactly once ──────────────────────────────────────
  assert.strictEqual((await vc.checkCode("prof-1", code)).ok, true, "correct code should verify");
  const replay = await vc.checkCode("prof-1", code);
  assert.strictEqual(replay.ok, false, "a spent code must not verify again");
  assert.strictEqual(replay.reason, "used");
  ok("correct code verifies once, then is single-use (replay → used)");

  // ── 3. Wrong guesses are counted and the code dies at MAX_ATTEMPTS ─────────────
  const c2 = await vc.issueCode("prof-2", "b@ex.com");
  const wrong = c2 === "000000" ? "111111" : "000000";
  for (let i = 1; i < vc.MAX_ATTEMPTS; i++) {
    const r = await vc.checkCode("prof-2", wrong);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "invalid", `attempt ${i} should be 'invalid', got ${r.reason}`);
  }
  // The attempt that reaches the cap reports the lockout, so the UI can tell the user
  // to request a new code rather than keep typing into a dead one.
  const capped = await vc.checkCode("prof-2", wrong);
  assert.strictEqual(capped.reason, "locked", `attempt ${vc.MAX_ATTEMPTS} should lock`);
  // …and the RIGHT code no longer works either — that's the whole point.
  assert.strictEqual((await vc.checkCode("prof-2", c2)).reason, "locked",
    "after lockout even the correct code must fail");
  ok(`wrong guesses are bounded — code dies at ${vc.MAX_ATTEMPTS} attempts, correct code included`);

  // ── 4. Expiry is enforced ──────────────────────────────────────────────────────
  const c3 = await vc.issueCode("prof-3", "c@ex.com");
  // Rewrite the record's exp into the past, then force a reload from disk.
  const lines = fs.readFileSync(vc.storePath(), "utf8").trim().split("\n");
  const idx = lines.map((l) => JSON.parse(l)).findLastIndex((r) => r.sub === "prof-3");
  const rec = JSON.parse(lines[idx]);
  fs.appendFileSync(vc.storePath(), JSON.stringify({ ...rec, exp: Date.now() - 1000 }) + "\n");
  delete require.cache[require.resolve(path.join(LIB, "verify-codes"))];
  const vc2 = require(path.join(LIB, "verify-codes"));
  const expired = await vc2.checkCode("prof-3", c3);
  assert.strictEqual(expired.ok, false, "an expired code must not verify");
  assert.ok(expired.reason === "expired" || expired.reason === "none",
    `expected expired/none, got ${expired.reason}`);
  ok("expired code is rejected (and pruned on reload)");

  // ── 5. Issuing supersedes the previous code (this is what "resend" relies on) ───
  const first = await vc2.issueCode("prof-4", "d@ex.com");
  const second = await vc2.issueCode("prof-4", "d@ex.com");
  assert.notStrictEqual(first, second, "a resend must produce a different code");
  assert.strictEqual((await vc2.checkCode("prof-4", first)).ok, false, "the superseded code must be dead");
  assert.strictEqual((await vc2.checkCode("prof-4", second)).ok, true, "the newest code verifies");
  ok("issuing a new code supersedes the old one (resend invalidates the prior email)");

  // ── 6. A code is bound to its profile ──────────────────────────────────────────
  const mine = await vc2.issueCode("prof-5", "e@ex.com");
  await vc2.issueCode("prof-6", "f@ex.com");
  assert.strictEqual((await vc2.checkCode("prof-6", mine)).ok, false,
    "profile-5's code must not confirm profile-6");
  ok("a code cannot confirm a different account");

  // ── 7. Unknown profile → 'none', never a crash ─────────────────────────────────
  assert.strictEqual((await vc2.checkCode("no-such-profile", "123456")).reason, "none");
  ok("unknown profile → reason 'none'");

  console.log(`\nAll ${passed} verify-code assertions passed.`);
}

// main() is async: it MUST be awaited via the promise chain. A synchronous
// try/catch around it would neither catch a rejection (so a failing assertion would
// leave exitCode 0 and CI would go green on a broken test) nor keep the temp dir
// alive — the finally would chdir and rm it while the test was still running.
main()
  .catch((err) => { console.error("\n[FAIL]", (err && err.stack) || err); process.exitCode = 1; })
  .finally(() => {
    process.chdir(origCwd);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
