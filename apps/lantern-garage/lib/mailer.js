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
async function sendMail({ to, subject, html, text, link }) {
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

async function sendVerificationEmail(to, name, link) {
  return sendMail({
    to, link,
    subject: `Confirm your email for ${BRAND}`,
    text: `Hi ${name || "there"}, confirm your email: ${link}`,
    html: shell("Confirm your email",
      `<p>Hi ${name || "there"}, please confirm this email address to finish securing your ${BRAND} account.</p>${button(link, "Confirm email")}`),
  });
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
  smtpConfigured,
  resendConfigured,
  mailerConfigured,
  mailerStatus,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendNewSignInEmail,
  sendWelcomeEmail,
  sendPasswordChangedEmail,
};
