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

module.exports = {
  sendMail,
  smtpConfigured,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendNewSignInEmail,
};
