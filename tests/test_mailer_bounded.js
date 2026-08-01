/**
 * #3094 — an interactive request must never be held hostage by a slow mail provider.
 *
 * Three endpoints (admin set-password, email-change request, email-change resend)
 * report delivery back to the user, so they await the send. Awaiting the RAW send made
 * them inherit the mailer's 15s provider timeout: a Resend stall turned a ~250ms request
 * into a 15-second hang on an interactive form, with no signal to the user.
 *
 * sendMailBounded() caps the WAIT without cancelling the SEND. This pins:
 *
 *   1. Fast provider → the caller gets the real verdict (pending:false, ok:true).
 *   2. Slow provider → the caller is released at waitMs with pending:true and ok:null —
 *      an honest "not heard back yet", never a fabricated success.
 *   3. The send is NOT cancelled by the timeout — it still completes afterwards.
 *   4. Every send carries a measured `ms`, so latency is observable in prod and not
 *      only under a benchmark.
 *
 * Run: node tests/test_mailer_bounded.js
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const https = require("https");
const { EventEmitter } = require("events");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-mailer-bounded-"));
const origCwd = process.cwd();
process.chdir(tmp);
// The data root is resolved from the module tree, not the cwd (#3088) — isolate the
// store with LANTERN_DATA_DIR, set BEFORE any lib require reads it.
process.env.LANTERN_DATA_DIR = path.join(tmp, "data");
process.env.SESSION_SECRET = ["unit", "test", "strong", "secret", "not", "dev", "default"].join("-");
for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"]) delete process.env[k];

const LIB = path.join(__dirname, "..", "apps", "lantern-garage", "lib");
const mailer = require(path.join(LIB, "mailer"));

let passed = 0;
const ok = (n) => { passed++; console.log("  ✓ " + n); };

const realRequest = https.request;

/** Stub Resend's HTTP endpoint with a controllable delay. Returns a settle-tracker. */
function stubResend(delayMs) {
  const state = { settled: false };
  https.request = (_opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.end = () => {
      setTimeout(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        cb(res);
        res.emit("data", '{"id":"stub"}');
        res.emit("end");
        state.settled = true;
      }, delayMs);
    };
    return req;
  };
  return state;
}

async function main() {
  process.env.RESEND_API_KEY = ["re", "stub", "key"].join("_");
  try {
    // ── 1. Fast provider → real verdict, not "pending" ────────────────────────────
    stubResend(10);
    const fast = await mailer.sendMailBounded({ to: "a@ex.com", subject: "s", text: "t" }, 500);
    assert.strictEqual(fast.pending, false, "a fast send must not report pending");
    assert.strictEqual(fast.ok, true, "a fast send reports the real ok verdict");
    assert.ok(typeof fast.ms === "number", "the result carries a measured duration");
    ok("fast provider → caller gets the real verdict, with a measured duration");

    // ── 2. Slow provider → released at waitMs, honestly ───────────────────────────
    const slow = stubResend(400);
    const t0 = Date.now();
    const held = await mailer.sendMailBounded({ to: "b@ex.com", subject: "s", text: "t" }, 60);
    const waited = Date.now() - t0;
    assert.strictEqual(held.pending, true, "a slow send releases the caller as pending");
    assert.strictEqual(held.ok, null, "pending must NOT claim success — ok is null, not true");
    // The whole point: the caller waited ~waitMs, not the provider's 400ms.
    assert.ok(waited < 300, `caller should be released near waitMs, waited ${waited}ms`);
    ok(`slow provider → caller released in ${waited}ms with pending:true, ok:null`);

    // ── 3. The timeout releases the CALLER, it does not cancel the SEND ───────────
    assert.strictEqual(slow.settled, false, "precondition: the slow send hasn't landed yet");
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(slow.settled, true, "the send must still complete after the caller gave up");
    ok("the bounded wait does not cancel the in-flight send");

    // ── 4. A failing provider still reports honestly through the bounded path ─────
    https.request = (_opts, cb) => {
      const req = new EventEmitter();
      req.write = () => {}; req.setTimeout = () => {}; req.destroy = () => {};
      req.end = () => setTimeout(() => {
        const res = new EventEmitter();
        res.statusCode = 422; // e.g. unverified from-domain
        cb(res);
        res.emit("data", '{"message":"domain not verified"}');
        res.emit("end");
      }, 5);
      return req;
    };
    const failed = await mailer.sendMailBounded({ to: "c@ex.com", subject: "s", text: "t" }, 500);
    assert.strictEqual(failed.pending, false);
    assert.strictEqual(failed.ok, false, "a provider rejection is reported as ok:false");
    assert.ok(/422/.test(failed.error || ""), `the provider reason is surfaced, got ${failed.error}`);
    ok("provider rejection → ok:false with the reason, never a silent success");
  } finally {
    https.request = realRequest;
    delete process.env.RESEND_API_KEY;
  }

  console.log(`\nAll ${passed} bounded-mailer assertions passed.`);
}

main()
  .catch((err) => { console.error("\n[FAIL]", (err && err.stack) || err); process.exitCode = 1; })
  .finally(() => {
    process.chdir(origCwd);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
