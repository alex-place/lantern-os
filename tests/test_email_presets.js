/**
 * #3093 — transactional email presets (lib/email-presets.js).
 *
 * Twelve send sites used to hand-roll their own markup, which let three things drift
 * independently. Each is pinned here because each was actually wrong before:
 *
 *   1. ESCAPING. Display names are user-controlled (the signup form takes 120 chars
 *      verbatim) and went raw into the HTML body. Mail clients don't run scripts, but
 *      markup injection still plants arbitrary links inside an email that genuinely
 *      comes from unisona.ai.
 *   2. THE FOOTER'S CLAIM. Every email said "if you didn't request this, ignore it" —
 *      including the password-CHANGED notice, where ignoring it is exactly the wrong
 *      advice. The footer now varies by kind.
 *   3. `ad` COMPLIANCE. Marketing isn't CAN-SPAM exempt the way transactional is, and
 *      it shares sending reputation with confirmation codes. An ad without a working
 *      unsubscribe is refused outright.
 *
 * Run: node tests/test_email_presets.js
 */
const assert = require("assert");
const path = require("path");

const LIB = path.join(__dirname, "..", "apps", "lantern-garage", "lib");
const { buildEmail, mayReceiveAd, KINDS } = require(path.join(LIB, "email-presets"));

let passed = 0;
const ok = (n) => { passed++; console.log("  ✓ " + n); };

function main() {
  // ── 1. User-controlled names cannot inject markup ──────────────────────────────
  const evil = '<img src=x onerror=alert(1)>Click <a href="http://evil.test">here</a>';
  for (const kind of ["code", "button", "message", "info"]) {
    const m = buildEmail({
      kind, to: "a@b.co", name: evil, code: "123456",
      title: "T", subject: "S", body: "b", cta: { href: "https://ok.test", label: "Go" },
    });
    assert.ok(!/<img/.test(m.html), `${kind}: raw <img> must not survive into the body`);
    assert.ok(!/href="http:\/\/evil\.test"/.test(m.html), `${kind}: injected anchor must not survive`);
    assert.ok(/&lt;img/.test(m.html), `${kind}: the name should appear escaped, not dropped`);
  }
  ok("a hostile display name is escaped in every preset, not rendered as markup");

  // The title is interpolated too, and is operator-supplied but not always trusted.
  const t = buildEmail({ kind: "message", to: "a@b.co", name: "x", title: "<b>bold</b>", subject: "S", body: "b" });
  assert.ok(!/<b>bold<\/b>/.test(t.html), "the title must be escaped as well");
  ok("the title is escaped too");

  // ── 2. Only http(s) survives into an href ──────────────────────────────────────
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "vbscript:x"]) {
    const m = buildEmail({
      kind: "button", to: "a@b.co", name: "x", title: "T", subject: "S", body: "b",
      cta: { href: bad, label: "Go" },
    });
    assert.ok(!m.html.includes(bad), `dangerous scheme must not reach an href: ${bad}`);
  }
  const good = buildEmail({
    kind: "button", to: "a@b.co", name: "x", title: "T", subject: "S", body: "b",
    cta: { href: "https://unisona.ai/reset?token=abc", label: "Go" },
  });
  assert.ok(good.html.includes("https://unisona.ai/reset?token=abc"), "a legitimate https link is preserved");
  ok("only http(s) URLs reach an href; a real link is preserved intact");

  // ── 3. The footer's claim depends on the kind ──────────────────────────────────
  const codeMail = buildEmail({ kind: "code", to: "a@b.co", name: "x", code: "123456" });
  assert.ok(/didn't request this/.test(codeMail.html), "a code the user asked for CAN be ignored");
  const infoMail = buildEmail({ kind: "info", to: "a@b.co", name: "x", title: "Password changed", subject: "S", body: "b" });
  assert.ok(!/you can safely ignore/.test(infoMail.html),
    "a security notice must NOT tell the user to ignore it");
  assert.ok(/secure your account/i.test(infoMail.html),
    "a security notice tells the user to act if it wasn't them");
  ok("footer matches the kind — 'ignore it' never lands on a security notice");

  // ── 4. `ad` is refused without a working unsubscribe ───────────────────────────
  assert.throws(
    () => buildEmail({ kind: "ad", to: "a@b.co", name: "x", title: "T", subject: "S", body: "b" }),
    /unsubscribeUrl/, "an ad with no unsubscribe URL must be refused");
  assert.throws(
    () => buildEmail({ kind: "ad", to: "a@b.co", name: "x", title: "T", subject: "S", body: "b", unsubscribeUrl: "not-a-url" }),
    /unsubscribeUrl/, "an ad with a non-http unsubscribe URL must be refused");
  const adMail = buildEmail({
    kind: "ad", to: "a@b.co", name: "x", title: "T", subject: "S", body: "b",
    unsubscribeUrl: "https://unisona.ai/settings.html",
  });
  assert.ok(/Unsubscribe/i.test(adMail.html), "a valid ad carries a visible unsubscribe link");
  assert.ok(/Unsubscribe: https:\/\/unisona\.ai\/settings\.html/.test(adMail.text),
    "the text/plain part carries the unsubscribe URL too — some clients only render text");
  ok("`ad` is refused without a working unsubscribe, and carries it in both parts");

  // ── 5. The opt-out gates ads ONLY, never transactional mail ────────────────────
  assert.strictEqual(mayReceiveAd({ preferences: { emailNotifications: true } }), true);
  assert.strictEqual(mayReceiveAd({ preferences: { emailNotifications: false } }), false);
  assert.strictEqual(mayReceiveAd({}), true, "absent preference defaults to allowed");
  assert.strictEqual(mayReceiveAd(null), false, "no profile → not eligible");
  // The point of the separation: an opted-out user must STILL get their code.
  const optedOut = { email: "a@b.co", name: "x", preferences: { emailNotifications: false } };
  const stillGetsCode = buildEmail({ kind: "code", to: optedOut.email, name: optedOut.name, code: "654321" });
  assert.ok(stillGetsCode.html.includes("6 5 4 3 2 1"), "a marketing opt-out must not block a confirmation code");
  ok("opt-out blocks ads only — transactional mail is unaffected");

  // ── 6. Malformed calls fail loudly rather than emitting a broken email ─────────
  assert.throws(() => buildEmail({ kind: "nope", to: "a@b.co" }), /unknown email preset/);
  assert.throws(() => buildEmail({ kind: "message", name: "x" }), /recipient/);
  ok("unknown kind and missing recipient throw instead of silently sending");

  // ── 7. Every preset produces both parts ────────────────────────────────────────
  for (const kind of KINDS) {
    const m = buildEmail({
      kind, to: "a@b.co", name: "x", code: "123456", title: "T", subject: "S", body: "b",
      unsubscribeUrl: "https://unisona.ai/settings.html",
    });
    assert.ok(m.html && m.html.length > 50, `${kind}: produces an html part`);
    assert.ok(m.text && m.text.length > 5, `${kind}: produces a text part`);
    assert.strictEqual(m.to, "a@b.co");
  }
  ok(`all ${KINDS.length} presets produce both an html and a text part`);

  console.log(`\nAll ${passed} email-preset assertions passed.`);
}

try {
  main();
} catch (err) {
  console.error("\n[FAIL]", (err && err.stack) || err);
  process.exitCode = 1;
}
