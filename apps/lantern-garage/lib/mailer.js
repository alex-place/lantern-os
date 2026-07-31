/**
 * Transactional email (ADR-0016 follow-up).
 *
 * Sends account emails (verify address, password reset) via SMTP when configured,
 * and otherwise falls back to logging the message + any action link to the server
 * console AND appending it to data/mail-outbox.jsonl — so the whole verify/reset
 * flow is fully testable locally before real SMTP credentials exist.
 *
 * Configure with env (all required to actually send):
 *   SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS
 *   SMTP_SECURE=1 for implicit TLS (port 465); otherwise STARTTLS
 *   MAIL_FROM="unisona.ai <no-reply@unisona.ai>"   (defaults to SMTP_USER)
 */

const fs = require("fs");
const path = require("path");

let _transport = null;
let _checked = false;

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

// ── Resend (HTTP API) provider ───────────────────────────────────────────────
// One env var (RESEND_API_KEY) instead of four SMTP ones, and HTTPS:443 instead
// of an SMTP port — cloud hosts (incl. GCE) throttle/block SMTP egress, which is
// a classic silent cause of "the confirmation email never arrived". Free tier
// covers transactional volume; MAIL_FROM must be a verified sender/domain in the
// Resend dashboard. Takes precedence over SMTP when both are configured.
function resendConfigured() {
  return !!process.env.RESEND_API_KEY;
}

// Is ANY real mail provider configured? Resend OR SMTP. The email-verification
// gate MUST key on this, not on smtpConfigured() alone — otherwise configuring
// Resend (the intended prod provider) leaves signups on the no-mailer auto-admit
// path and no confirmation email is ever sent, i.e. "the emails aren't wired"
// even though Resend works. (#3021)
function mailerConfigured() {
  return resendConfigured() || smtpConfigured();
}
function sendViaResend({ to, subject, html, text }) {
  const https = require("https");
  const payload = JSON.stringify({
    from: fromAddress(), to: [to], subject,
    ...(html ? { html } : {}), ...(text ? { text } : {}),
  });
  return new Promise((resolve) => {
    const req = https.request({
      host: "api.resend.com", path: "/emails", method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ ok: true });
        // Surface Resend's reason (bad from-domain, invalid key…) — never the key.
        resolve({ ok: false, error: `resend ${res.statusCode}: ${d.slice(0, 200)}` });
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: `resend request failed: ${e.message}` }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, error: "resend timeout" }); });
    req.write(payload); req.end();
  });
}

/** Which transport would a send use right now? For diagnostics/status pages. */
function mailerStatus() {
  return {
    transport: resendConfigured() ? "resend" : smtpConfigured() ? "smtp" : "dev",
    from: fromAddress(),
    resend: resendConfigured(),
    smtp: smtpConfigured(),
    note: resendConfigured() || smtpConfigured() ? null
      : "no mail provider configured — emails go to the server log + data/mail-outbox.jsonl only",
  };
}

function getTransport() {
  if (_checked) return _transport;
  _checked = true;
  if (!smtpConfigured()) return (_transport = null);
  // Lazy-require so the dep is only touched when SMTP is actually configured.
  const nodemailer = require("nodemailer");
  _transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "1" || Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return _transport;
}

function fromAddress() {
  return process.env.MAIL_FROM || process.env.SMTP_USER || "no-reply@unisona.ai";
}

const OUTBOX = path.join(process.cwd(), "data", "mail-outbox.jsonl");

/**
 * Send an email. Returns { ok, transport: 'smtp'|'dev', link? }.
 * Never throws to the caller for a delivery failure — logs and reports ok:false.
 */
// A send that takes longer than this is worth a log line — it's the early warning for
// the failure mode #3094 is about: a provider slowdown turning an interactive form into
// a hang. Measured baseline on a healthy box is ~250ms median (150–338ms, n=5).
const SLOW_SEND_MS = Number(process.env.MAIL_SLOW_MS || 3000);

// How long an INTERACTIVE request may wait for a send before answering "pending".
// Not the same as the 15s provider timeout: that bounds the send, this bounds the
// user's wait. ~10x the measured median, so the fast path still returns a real verdict.
const INTERACTIVE_WAIT_MS = Number(process.env.MAIL_INTERACTIVE_WAIT_MS || 2500);

/**
 * Send, but never hold an interactive response longer than `waitMs`.
 *
 * Three of the twelve send sites await delivery because they report the outcome back to
 * the user (an admin needs to know the password email went out). Awaiting the raw send
 * meant those endpoints inherited the 15s provider timeout, so a Resend stall turned a
 * 250ms request into a 15-second hang on a form (#3094).
 *
 * On timeout the send is NOT cancelled — it keeps running and its real outcome is
 * logged. The caller just stops waiting and gets { pending: true }, so the honest answer
 * is "we haven't heard back yet", never a fabricated success.
 */
async function sendMailBounded(opts, waitMs = INTERACTIVE_WAIT_MS) {
  const PENDING = Symbol("pending");
  let timer = null;
  const inflight = sendMail(opts);
  // Attach a handler now so a late rejection can never surface as an unhandled rejection
  // after we've stopped awaiting it.
  inflight.catch(() => {});
  const winner = await Promise.race([
    inflight,
    new Promise((resolve) => { timer = setTimeout(() => resolve(PENDING), waitMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (winner !== PENDING) return { ...winner, pending: false };

  console.warn(`[mailer] send to ${opts && opts.to} exceeded ${waitMs}ms — responding pending; the send continues`);
  inflight.then((r) => {
    console.info(`[mailer] late send to ${opts && opts.to} settled: ok=${r.ok} transport=${r.transport}${r.error ? " error=" + r.error : ""}`);
  }).catch(() => {});
  return { ok: null, pending: true, transport: mailerStatus().transport, waitedMs: waitMs };
}

async function sendMail({ to, subject, html, text, link }) {
  const startedAt = Date.now();
  const done = (result) => {
    const ms = Date.now() - startedAt;
    // Latency is otherwise only visible under a benchmark; surface the slow ones in the
    // same log an operator already reads for delivery failures.
    if (ms >= SLOW_SEND_MS) console.warn(`[mailer] slow send to ${to}: ${ms}ms (transport ${result.transport})`);
    return { ...result, ms };
  };
  return done(await _sendMailInner({ to, subject, html, text, link }));
}

async function _sendMailInner({ to, subject, html, text, link }) {
  // Provider chain: Resend (HTTP) → SMTP → dev outbox. On a provider failure the
  // result is reported honestly (ok:false + reason) — never silently swallowed.
  if (resendConfigured()) {
    const r = await sendViaResend({ to, subject, html, text });
    if (r.ok) return { ok: true, transport: "resend" };
    console.error(`[mailer] resend send failed to ${to}: ${r.error}`);
    // Fall through to SMTP if that's also configured; otherwise report the failure.
    if (!smtpConfigured()) return { ok: false, transport: "resend", error: r.error };
  }
  const transport = getTransport();
  if (!transport) {
    // Dev fallback — make the action link impossible to miss in the logs, and
    // persist it so a test harness can read it back.
    console.log(
      `\n📧 [mailer:dev] no SMTP configured — email NOT sent.\n` +
      `   to:      ${to}\n   subject: ${subject}\n` +
      (link ? `   link:    ${link}\n` : "")
    );
    try {
      fs.appendFileSync(
        OUTBOX,
        JSON.stringify({ to, subject, link: link || null, at: new Date().toISOString() }) + "\n"
      );
    } catch (_) { /* best-effort */ }
    return { ok: true, transport: "dev", link };
  }
  try {
    await transport.sendMail({ from: fromAddress(), to, subject, html, text: text || undefined });
    return { ok: true, transport: "smtp" };
  } catch (err) {
    console.error(`[mailer] send failed to ${to}:`, err.message);
    return { ok: false, transport: "smtp", error: err.message };
  }
}

// ── Templates ────────────────────────────────────────────────────────────────
const BRAND = "unisona.ai";
function shell(title, bodyHtml) {
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0f172a">
    <h2 style="color:#06b6d4;margin:0 0 16px">${BRAND}</h2>
    <h3 style="margin:0 0 12px">${title}</h3>
    ${bodyHtml}
    <p style="color:#94a3b8;font-size:12px;margin-top:24px">If you didn't request this, you can ignore this email.</p>
  </div>`;
}
function button(href, label) {
  return `<p style="margin:20px 0"><a href="${href}" style="background:#06b6d4;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600;display:inline-block">${label}</a></p>
    <p style="color:#64748b;font-size:12px;word-break:break-all">Or paste this link: ${href}</p>`;
}

// Signup confirmation is a typed CODE, not a clicked link — the user may read mail on
// a phone and be signing up on a desktop, and a code crosses that gap where a link
// can't. The email-CHANGE flow below still uses a link (see sendVerificationEmail).
// `link` is deliberately absent: sendMail()'s dev fallback logs whatever it is given,
// and there is no link to log here — the code itself goes to the outbox instead.
async function sendVerificationCodeEmail(to, name, code) {
  const spaced = String(code).split("").join(" "); // easier to read/transcribe
  return sendMail({
    to,
    link: `code: ${code}`, // what the dev outbox records when no provider is configured
    subject: `Your ${BRAND} confirmation code: ${code}`,
    text: `Hi ${name || "there"}, your ${BRAND} confirmation code is ${code}. It expires in 15 minutes.`,
    html: shell("Confirm your email",
      `<p>Hi ${name || "there"}, enter this code to finish setting up your ${BRAND} account:</p>
       <p style="margin:24px 0"><span style="display:inline-block;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:10px;padding:14px 22px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:28px;font-weight:700;letter-spacing:6px;color:#0f172a">${spaced}</span></p>
       <p style="color:#64748b;font-size:13px">This code expires in 15 minutes and can only be used once. We'll never ask you for it by phone, email, or chat.</p>`),
  });
}

// Payload builder split out from the sender so a caller that needs a BOUNDED wait
// (#3094) can reuse the exact same template instead of re-authoring the markup.
function verificationEmailPayload(to, name, link) {
  return {
    to, link,
    subject: `Confirm your email for ${BRAND}`,
    text: `Hi ${name || "there"}, confirm your email: ${link}`,
    html: shell("Confirm your email",
      `<p>Hi ${name || "there"}, please confirm this email address to finish securing your ${BRAND} account.</p>${button(link, "Confirm email")}`),
  };
}

async function sendVerificationEmail(to, name, link) {
  return sendMail(verificationEmailPayload(to, name, link));
}

async function sendPasswordResetEmail(to, name, link) {
  return sendMail({
    to, link,
    subject: `Reset your ${BRAND} password`,
    text: `Reset your password: ${link}`,
    html: shell("Reset your password",
      `<p>Hi ${name || "there"}, use the button below to set a new password. This link expires in 1 hour.</p>${button(link, "Reset password")}`),
  });
}

async function sendNewSignInEmail(to, name, provider) {
  return sendMail({
    to,
    subject: `New sign-in method added to your ${BRAND} account`,
    text: `A new sign-in method (${provider}) was added to your account.`,
    html: shell("New sign-in method added",
      `<p>Hi ${name || "there"}, <strong>${provider}</strong> was just connected to your ${BRAND} account. If this was you, no action is needed.</p>`),
  });
}

async function sendWelcomeEmail(to, name) {
  return sendMail({
    to,
    subject: `Welcome to ${BRAND}`,
    text: `Hi ${name || "there"}, your email is confirmed — welcome aboard. Start at https://unisona.ai`,
    html: shell("You're in",
      `<p>Hi ${name || "there"}, your email is confirmed and your ${BRAND} account is ready.</p>
       <p>Start with the chat, watch the markets, or connect a paper-trading broker.</p>${button("https://unisona.ai", "Open " + BRAND)}`),
  });
}

async function sendPasswordChangedEmail(to, name) {
  return sendMail({
    to,
    subject: `Your ${BRAND} password was changed`,
    text: `Hi ${name || "there"}, your password was just changed. If this wasn't you, reset it immediately.`,
    html: shell("Password changed",
      `<p>Hi ${name || "there"}, your ${BRAND} password was just changed.</p>
       <p><strong>If this wasn't you</strong>, reset your password immediately and consider signing in with Google instead.</p>${button("https://unisona.ai/auth.html", "Review your account")}`),
  });
}

module.exports = {
  sendMail,
  sendMailBounded,
  smtpConfigured,
  resendConfigured,
  mailerConfigured,
  mailerStatus,
  sendVerificationEmail,
  verificationEmailPayload,
  sendVerificationCodeEmail,
  sendPasswordResetEmail,
  sendNewSignInEmail,
  sendWelcomeEmail,
  sendPasswordChangedEmail,
};
