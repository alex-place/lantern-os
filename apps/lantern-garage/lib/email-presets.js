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
  const small = "color:#94a3b8;font-size:12px;margin-top:24px";
  if (kind === "code" || kind === "button") {
    return `<p style="${small}">If you didn't request this, you can safely ignore this email — nothing will change.</p>`;
  }
  if (kind === "info") {
    return `<p style="${small}">You're receiving this because it affects your ${BRAND} account's security. <strong>If this wasn't you, secure your account now.</strong></p>`;
  }
  if (kind === "ad") {
    return `<p style="${small}">You're receiving this because you have a ${BRAND} account and haven't opted out of product updates.<br>
      <a href="${escUrl(opts.unsubscribeUrl)}" style="color:#94a3b8">Unsubscribe from product updates</a></p>`;
  }
  return `<p style="${small}">You're receiving this because you have a ${BRAND} account.</p>`;
}

function shell(kind, title, bodyHtml, opts = {}) {
  // The charset meta is belt-and-braces. Resend sends UTF-8 and most clients honour
  // the MIME header, but these templates contain em-dashes and curly apostrophes, and
  // a client that guesses latin-1 renders them as "â€" mojibake in the middle of a
  // security notice. One tag is cheaper than restricting the copy to ASCII.
  return `<meta charset="utf-8">
  <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0f172a">
    <h2 style="color:${ACCENT};margin:0 0 16px">${BRAND}</h2>
    <h3 style="margin:0 0 12px">${esc(title)}</h3>
    ${bodyHtml}
    ${footerFor(kind, opts)}
  </div>`;
}

function ctaButton(href, label) {
  const safe = escUrl(href);
  return `<p style="margin:20px 0"><a href="${safe}" style="background:${ACCENT};color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600;display:inline-block">${esc(label)}</a></p>
    <p style="color:#64748b;font-size:12px;word-break:break-all">Or paste this link: ${safe}</p>`;
}

function codeBlock(code) {
  const spaced = esc(String(code).split("").join(" ")); // easier to read/transcribe
  return `<p style="margin:24px 0"><span style="display:inline-block;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:10px;padding:14px 22px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:28px;font-weight:700;letter-spacing:6px;color:#0f172a">${spaced}</span></p>`;
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
