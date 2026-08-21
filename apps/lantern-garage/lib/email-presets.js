/**
 * Transactional email presets (#3093).
 *
 * Every send site used to hand-roll its own markup inside lib/mailer.js. That made
 * three things drift independently: escaping, the footer's claim, and the visual
 * shell. This module owns all three, and each send site now declares a KIND plus
 * data instead of HTML.
 *
 *   code    — a short secret the user types back (confirmation code)
 *   button  — one primary action behind a link (reset password, confirm a change)
 *   message — prose the user is expected to read, optionally with a CTA (welcome)
 *   info    — a notice about something that already happened; no action expected
 *   ad      — marketing/announcement. NOT transactional; see the gate below.
 *
 * ── Why `ad` is not just another preset ─────────────────────────────────────────
 * Transactional mail is exempt from CAN-SPAM's unsubscribe requirement; marketing
 * is not. An `ad` therefore REQUIRES an unsubscribe URL and is refused without one,
 * and callers must check the recipient's opt-out first (see mayReceiveAd). This is
 * not legal caution for its own sake: marketing complaints degrade the sending
 * domain's reputation, and that domain is the same one delivering confirmation
 * codes — so spam-foldering an ad campaign quietly breaks signup.
 *
 * ── Escaping ────────────────────────────────────────────────────────────────────
 * Display names are user-controlled (the signup form accepts 120 chars verbatim)
 * and previously went raw into the HTML body. Mail clients don't run scripts, but
 * markup injection is still enough to plant arbitrary links inside an email that
 * genuinely comes from unisona.ai. Every interpolated value is escaped here; the
 * only raw HTML is what this module itself composes.
 */

const BRAND = "unisona.ai";
const SITE = "https://unisona.ai";
const ACCENT = "#06b6d4";

// Brand palette for the mail shell. Emails can't share the site's CSS variables (mail
// clients strip <style>/external CSS), so the theme is re-expressed here as inline hex.
const INK = "#0f172a";       // headings
const BODY_INK = "#334155";  // paragraph text
const MUTED = "#64748b";     // secondary / links in footer
const FAINT = "#94a3b8";     // fine print
const BORDER = "#e2e8f0";    // card + divider
const CARD_BG = "#ffffff";
const PAGE_BG = "#eef2f6";   // page behind the card, so the white card lifts
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

const KINDS = ["code", "button", "message", "info", "ad"];

/** Escape a value for interpolation into HTML. Everything user-supplied goes through this. */
function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escape a URL for an href. Rejects anything that isn't http(s) — a `javascript:`
 * or `data:` URL reaching a template would turn our own CTA into the attack.
 */
function escUrl(url) {
  const s = String(url || "");
  if (!/^https?:\/\//i.test(s)) return SITE;
  return esc(s);
}

// Two forms on purpose: the HTML body needs the escaped name, the text/plain body
// needs the raw one. Escaping once and un-escaping for text would be lossy.
function greetingHtml(name) { return `Hi ${esc(name) || "there"}`; }
function greetingText(name) { return `Hi ${String(name || "").trim() || "there"}`; }

/**
 * The footer's claim depends on the kind, and getting it wrong is not cosmetic.
 * "If you didn't request this, you can ignore it" is correct for a code the user
 * asked for — and actively harmful on a password-changed notice, where ignoring it
 * is precisely the wrong response. The old shared footer said it on every email.
 */
function footerFor(kind, opts = {}) {
  const small = `color:${FAINT};font-size:12px;line-height:1.55;margin:0`;
  if (kind === "code" || kind === "button") {
    return `<p style="${small}">If you didn't request this, you can safely ignore this email — nothing will change.</p>`;
  }
  if (kind === "info") {
    return `<p style="${small}">You're receiving this because it affects your ${BRAND} account's security. <strong style="color:${MUTED}">If this wasn't you, secure your account now.</strong></p>`;
  }
  if (kind === "ad") {
    return `<p style="${small}">You're receiving this because you have a ${BRAND} account and haven't opted out of product updates.<br>
      <a href="${escUrl(opts.unsubscribeUrl)}" style="color:${MUTED}">Unsubscribe from product updates</a></p>`;
  }
  return `<p style="${small}">You're receiving this because you have a ${BRAND} account.</p>`;
}

/**
 * The branded email shell. Table-based with inline styles — the only layout mail clients
 * (Gmail/Outlook/Apple Mail) render reliably; divs + external CSS + CSS variables do not
 * survive. A light card floats on a tinted page, headed by the wordmark and an accent
 * rule, so a confirmation email reads like the product rather than a raw console line.
 */
function shell(kind, title, bodyHtml, opts = {}) {
  const t = esc(title);
  // Hidden preheader: the one-line snippet the inbox list shows before the email is
  // opened. Without it clients scrape the first visible words ("Hi there, …").
  const preheader = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:transparent">${t} — ${BRAND}</div>`;
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE_BG};margin:0;padding:0;width:100%">
  <tr><td align="center" style="padding:32px 14px">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px;max-width:100%;font-family:${FONT}">
      <tr><td style="padding:0 6px 18px">
        <span style="font-size:20px;font-weight:800;letter-spacing:-.02em;color:${INK}">unisona<span style="color:${ACCENT}">.ai</span></span>
      </td></tr>
      <tr><td style="background:${CARD_BG};border:1px solid ${BORDER};border-radius:16px;padding:36px 36px 30px">
        <div style="width:44px;height:4px;background:${ACCENT};border-radius:999px;margin:0 0 22px"></div>
        <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;font-weight:700;color:${INK}">${t}</h1>
        <div style="font-size:15px;line-height:1.6;color:${BODY_INK}">${bodyHtml}</div>
      </td></tr>
      <tr><td style="padding:20px 8px 0">
        ${footerFor(kind, opts)}
        <p style="color:${FAINT};font-size:12px;line-height:1.55;margin:12px 0 0">&copy; ${new Date().getFullYear()} ${BRAND} &middot; <a href="${SITE}" style="color:${MUTED};text-decoration:none">unisona.ai</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>`;
}

function ctaButton(href, label) {
  const safe = escUrl(href);
  // A padded anchor on a table cell — the most portable "button". Outlook renders it as a
  // styled link (no rounded corners), every other client as the full button; both work.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 6px">
      <tr><td style="border-radius:12px;background:${ACCENT}"><a href="${safe}" style="display:inline-block;padding:13px 30px;font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:12px">${esc(label)}</a></td></tr>
    </table>
    <p style="color:${MUTED};font-size:13px;line-height:1.5;margin:14px 0 0">Button not working? Copy and paste this link into your browser:</p>
    <p style="margin:4px 0 0"><a href="${safe}" style="color:${ACCENT};font-size:13px;word-break:break-all;text-decoration:none">${safe}</a></p>`;
}

function codeBlock(code) {
  const spaced = esc(String(code).split("").join(" ")); // easier to read/transcribe
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0"><tr>
      <td align="center" style="background:#f1f5f9;border:1px solid ${BORDER};border-radius:12px;padding:18px 20px;font-family:${MONO};font-size:30px;font-weight:700;letter-spacing:8px;color:${INK}">${spaced}</td>
    </tr></table>`;
}

function paragraphs(bodyLines) {
  return (Array.isArray(bodyLines) ? bodyLines : [bodyLines])
    .filter(Boolean)
    .map((line) => `<p>${esc(line)}</p>`)
    .join("\n       ");
}

/**
 * Is this profile allowed to receive an `ad`? Transactional mail ignores this —
 * a user who opted out of marketing must still get their confirmation code.
 */
function mayReceiveAd(profile) {
  return !!profile && profile.preferences?.emailNotifications !== false;
}

/**
 * Build a mail payload from a preset. Returns { to, subject, text, html, link }
 * ready for sendMail()/sendMailBounded() — never sends anything itself.
 *
 * Throws for a malformed call (unknown kind, `ad` without an unsubscribe URL)
 * rather than silently emitting a non-compliant email.
 */
function buildEmail(spec) {
  const { kind, to, name, title, subject, body, code, cta, expiresIn, unsubscribeUrl } = spec || {};
  if (!KINDS.includes(kind)) throw new Error(`unknown email preset: ${kind}`);
  if (!to) throw new Error("email preset requires a recipient");
  if (kind === "ad" && !/^https?:\/\//i.test(String(unsubscribeUrl || ""))) {
    // Refusing here is the point: a marketing email without a working opt-out is
    // the one failure mode that damages deliverability for every other email.
    throw new Error("the 'ad' preset requires an http(s) unsubscribeUrl");
  }

  const lines = Array.isArray(body) ? body : body ? [body] : [];
  const hi = greetingHtml(name);
  const hiText = greetingText(name);

  if (kind === "code") {
    const mins = expiresIn || "15 minutes";
    return {
      to,
      link: `code: ${code}`, // what the dev outbox records when no provider is configured
      subject: subject || `Your ${BRAND} confirmation code: ${code}`,
      text: `${hiText}, your ${BRAND} confirmation code is ${code}. It expires in ${mins}.`,
      html: shell("code", title || "Confirm your email",
        `<p>${hi}, ${esc(lines[0] || `enter this code to finish setting up your ${BRAND} account:`)}</p>
       ${codeBlock(code)}
       <p style="color:#64748b;font-size:13px">This code expires in ${esc(mins)} and can only be used once. We'll never ask you for it by phone, email, or chat.</p>`),
    };
  }

  if (kind === "button") {
    return {
      to,
      link: cta && cta.href,
      subject,
      text: `${hiText}, ${lines.join(" ")} ${cta ? cta.href : ""}`.trim(),
      html: shell("button", title,
        `<p>${hi}, ${esc(lines[0] || "")}</p>${cta ? ctaButton(cta.href, cta.label) : ""}`),
    };
  }

  // message | info | ad share a body shape; they differ in footer and in whether a
  // CTA is expected. Keeping them one branch keeps the rendering identical.
  const html = shell(kind, title,
    `<p>${hi}, ${esc(lines[0] || "")}</p>
       ${paragraphs(lines.slice(1))}${cta ? ctaButton(cta.href, cta.label) : ""}`,
    { unsubscribeUrl });
  return {
    to,
    link: cta && cta.href,
    subject,
    text: `${hi}, ${lines.join(" ")}${cta ? ` ${cta.href}` : ""}${kind === "ad" ? `\n\nUnsubscribe: ${unsubscribeUrl}` : ""}`,
    html,
  };
}

module.exports = { buildEmail, mayReceiveAd, KINDS, esc, escUrl, BRAND, SITE };
