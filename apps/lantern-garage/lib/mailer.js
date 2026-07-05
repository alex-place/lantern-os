/**
 * Outbound email transport (ADR-0016 follow-up: email confirmation).
 *
 * Real delivery uses SMTP via nodemailer, configured entirely from env:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE ("1"/"true" for
 *   implicit TLS on 465), and SMTP_FROM (the From: header, e.g.
 *   "Unisona <no-reply@unisona.ai>").
 *
 * When SMTP is NOT configured we fall back to a "logged" transport that prints
 * the message (and any action link) to the server log and appends it to
 * data/mail/outbox.jsonl. This keeps the local-first flow working offline and in
 * tests without silently pretending a real email went out — the return value's
 * `delivery` field tells the caller which path ran.
 */

const fs = require("fs");
const path = require("path");

let _nodemailer = null;
function nodemailer() {
  if (_nodemailer === null) {
    try {
      _nodemailer = require("nodemailer");
    } catch {
      _nodemailer = false; // dependency absent → logged transport only
    }
  }
  return _nodemailer || null;
}

/** True when SMTP env is present AND the nodemailer dependency is installed. */
function mailerConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_FROM && nodemailer());
}

function _from() {
  return process.env.SMTP_FROM || "Unisona <no-reply@localhost>";
}

let _transport = null;
function transport() {
  if (_transport) return _transport;
  const nm = nodemailer();
  if (!nm) return null;
  const secure =
    process.env.SMTP_SECURE === "1" ||
    process.env.SMTP_SECURE === "true" ||
    Number(process.env.SMTP_PORT) === 465;
  _transport = nm.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || (secure ? 465 : 587),
    secure,
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  });
  return _transport;
}

function _logToOutbox(msg) {
  try {
    const dir = path.join(process.cwd(), "data", "mail");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "outbox.jsonl"),
      JSON.stringify({ ...msg, at: new Date().toISOString() }) + "\n"
    );
  } catch (e) {
    console.error("[MAILER] outbox append failed:", e.message);
  }
}

/**
 * Send an email. Returns { ok, delivery: "smtp"|"logged", error? }.
 * Never throws — the caller decides how a delivery failure affects the flow.
 *
 * @param {{to:string, subject:string, text?:string, html?:string, link?:string}} msg
 */
async function sendMail(msg) {
  const { to, subject, text, html, link } = msg || {};
  if (!to || !subject) return { ok: false, delivery: "none", error: "missing_to_or_subject" };

  if (mailerConfigured()) {
    try {
      await transport().sendMail({ from: _from(), to, subject, text, html });
      return { ok: true, delivery: "smtp" };
    } catch (e) {
      console.error("[MAILER] SMTP send failed:", e.message);
      // Fall through to the logged transport so the action link is at least
      // recoverable from the server host, and report the failure to the caller.
      _logToOutbox({ to, subject, text, link, smtpError: e.message });
      return { ok: false, delivery: "logged", error: e.message };
    }
  }

  // No SMTP configured — logged transport.
  _logToOutbox({ to, subject, text, link });
  console.log(
    `[MAILER] (no SMTP configured) email to ${to}: ${subject}` +
      (link ? `\n[MAILER] action link: ${link}` : "")
  );
  return { ok: true, delivery: "logged" };
}

module.exports = { sendMail, mailerConfigured };
