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
 *   - silently skips when no mailer is configured or the user has no email —
 *     the in-app feed is always the fallback, and delivery failures must
 *     never break the scan loop (fire-and-forget, fail-soft);
 *   - a rolling-hour rate cap per user (ALERT_EMAIL_HOURLY_CAP, default 6),
 *     consumed BEFORE sending, so a bug can never spam a mailbox.
 *
 * Dependencies are injectable for tests; production callers use the defaults.
 */

const store = require('./alert-store');

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
    if (!d.configured()) return { skipped: 'mailer_unconfigured' };
    const profile = d.getProfile(userId);
    const to = profile && String(profile.email || '').trim();
    if (!to || !to.includes('@')) return { skipped: 'no_email' };
    if (!store.tryConsumeEmailBudget(userId, HOURLY_CAP, nowMs)) return { skipped: 'rate_capped' };
    await d.send({
      to,
      subject: `Alert — ${feedRow.symbol}: ${feedRow.type === 'zone' ? 'price at zone' : feedRow.type === 'washout' ? 'washout confirmed' : 'signal fired'}`,
      text: `${feedRow.message}\n\nFrom your watchlist alert rules. Manage rules or mute this one from the Alerts tab:\n`,
      link: '/stock-trader.html#alerts',
    });
    return { sent: true };
  } catch (_e) {
    return { skipped: 'send_failed' };   // fail-soft: the feed row already landed
  }
}

module.exports = { deliver, HOURLY_CAP };
