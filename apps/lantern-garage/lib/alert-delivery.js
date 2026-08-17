'use strict';

/**
 * alert-delivery.js — deliver fired alerts beyond the in-app feed (#3249).
 *
 * v1 channel: EMAIL through the existing mailer (lib/mailer.js — Resend or
 * SMTP, whichever is configured; no new provider). Web-push is deliberately
 * absent: it needs a VAPID dependency + a service worker, which is a
 * dependency decision, not a rider on this change.
 *
 * Guarantees, each enforced here:
 *   - opt-in only (prefs.email, off by default);
 *   - the address must be VERIFIED — see below;
 *   - a single noisy rule can be muted without muting the rest (rule.email);
 *   - silently skips when no mailer is configured or the user has no email —
 *     the in-app feed is always the fallback, and delivery failures must
 *     never break the scan loop (fire-and-forget, fail-soft);
 *   - a rolling-hour rate cap per user (ALERT_EMAIL_HOURLY_CAP, default 6),
 *     consumed BEFORE sending, so a bug can never spam a mailbox.
 *
 * Dependencies are injectable for tests; production callers use the defaults.
 *
 * ── Reconciliation note (#3329 → #3249) ─────────────────────────────────────
 * A parallel branch built a second delivery module with per-RULE opt-OUT and no
 * rate cap. This module's design won on the two that matter for email — opt-IN
 * by default, and a budget consumed before the send — so that branch's module
 * was dropped rather than merged. Three things came across, because each closed
 * a real gap here:
 *   1. verified addresses only. `to.includes('@')` let an UNVERIFIED address be
 *      mailed, so anyone who signed up with a stranger's address could point
 *      alerts at it. This domain also carries signup confirmation codes, so its
 *      reputation is not something to spend on unverified sends.
 *   2. the per-rule mute the email body already promised but nothing implemented.
 *   3. a real link. `link` is passed to sendMail, but neither the Resend nor the
 *      SMTP transport puts it in the message — only the dev outbox logs it — so
 *      the sentence "Manage rules or mute this one from the Alerts tab:" shipped
 *      ending in a colon with nothing after it. The body is now built through
 *      lib/email-presets (the same shell every other account email uses), which
 *      renders a real CTA and escapes what it interpolates.
 */

const store = require('./alert-store');
const { buildEmail, SITE } = require('./email-presets');

const HOURLY_CAP = Math.max(1, Number(process.env.ALERT_EMAIL_HOURLY_CAP) || 6);

function _defaults() {
  const { mailerConfigured, sendMail } = require('./mailer');
  const { getProfile } = require('./user-profiles');
  return { configured: mailerConfigured, send: sendMail, getProfile };
}

/**
 * Deliver one fired alert to one user. Returns a small result descriptor —
 * { sent:true } or { skipped:<reason> } — and NEVER throws.
 */
async function deliver(userId, feedRow, deps = null, nowMs = Date.now()) {
  try {
    const d = deps || _defaults();
    const prefs = store.getPrefs(userId);
    if (!prefs.email) return { skipped: 'pref_off' };
    // Per-rule mute: cheap, local, and checked before anything expensive.
    if (feedRow && feedRow.ruleId) {
      const rule = store.listRules(userId).find((r) => r.id === feedRow.ruleId);
      if (rule && rule.email === false) return { skipped: 'rule_muted' };
    }
    if (!d.configured()) return { skipped: 'mailer_unconfigured' };
    const profile = d.getProfile(userId);
    const to = profile && String(profile.email || '').trim();
    if (!to || !to.includes('@')) return { skipped: 'no_email' };
    // An address nobody proved they own is not one we mail. Signing up with a
    // stranger's address and pointing alerts at it must not turn this domain
    // into the delivery mechanism — and this domain also carries signup codes.
    if (!profile.emailVerified) return { skipped: 'email_unverified' };
    if (!store.tryConsumeEmailBudget(userId, HOURLY_CAP, nowMs)) return { skipped: 'rate_capped' };
    await d.send(buildEmail({
      kind: 'message',
      to,
      name: profile.name,
      title: `${feedRow.symbol} alert`,
      subject: `Alert — ${feedRow.symbol}: ${_what(feedRow.type)}`,
      body: [
        `your ${feedRow.symbol} alert just fired.`,
        feedRow.message || '',
        'This came from your own watchlist alert rules. You can change them, mute this one, or turn alert emails off entirely from the Alerts view.',
      ].filter(Boolean),
      cta: { href: `${SITE}/stock-trader.html#alerts`, label: 'Open your alerts' },
    }));
    return { sent: true };
  } catch (_e) {
    return { skipped: 'send_failed' };   // fail-soft: the feed row already landed
  }
}

function _what(type) {
  return type === 'zone' ? 'price at zone' : type === 'washout' ? 'washout confirmed' : 'signal fired';
}

module.exports = { deliver, HOURLY_CAP };
