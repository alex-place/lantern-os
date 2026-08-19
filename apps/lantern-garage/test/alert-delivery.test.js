// #3249 — email delivery for fired alerts: opt-in, self-skipping, rate-capped.
//
// Contract: delivery is opt-in (off by default), silently skips when the mailer
// is unconfigured or the user has no email, consumes a rolling-hour budget
// BEFORE sending, and never throws. Dependencies are injected; no real mail.
//
// Run: node apps/lantern-garage/test/alert-delivery.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-delivery-'));
process.env.ALERTS_DIR = TMP;

const store = require('../lib/alert-store');
const { deliver, HOURLY_CAP } = require('../lib/alert-delivery');

let failures = 0;
const check = (name, fn) => {
  const p = fn();
  const done = (e) => {
    if (e) { failures++; process.stderr.write('  FAIL- ' + name + '\n      ' + e.message + '\n'); }
    else process.stdout.write('  ok  - ' + name + '\n');
  };
  return p.then(() => done(), done);
};

const ROW = { ts: '2026-08-12T14:00:00Z', ruleId: 'al123456', symbol: 'SPY', type: 'signal', message: 'SPY: bullish signal fired at $600.00' };
const sentBox = [];
const deps = (over = {}) => ({
  configured: () => true,
  // emailVerified is REQUIRED for a send now (#3329 reconciled onto #3249) — the
  // fixture previously modelled a profile delivery accepted but should not have.
  getProfile: () => ({ email: 'kris@example.com', emailVerified: true, name: 'Kris' }),
  send: async (m) => { sentBox.push(m); },
  ...over,
});

(async () => {
  await check('opt-in: pref off (the default) skips without touching the mailer', async () => {
    const r = await deliver('u1', ROW, deps());
    assert.strictEqual(r.skipped, 'pref_off');
    assert.strictEqual(sentBox.length, 0);
  });

  await check('mailer unconfigured skips even when opted in', async () => {
    store.setPrefs('u1', { email: true });
    const r = await deliver('u1', ROW, deps({ configured: () => false }));
    assert.strictEqual(r.skipped, 'mailer_unconfigured');
  });

  await check('no email on the profile skips', async () => {
    const r = await deliver('u1', ROW, deps({ getProfile: () => ({ email: '' }) }));
    assert.strictEqual(r.skipped, 'no_email');
  });

  await check('happy path: sends to the profile address with the alert message + manage link', async () => {
    const r = await deliver('u1', ROW, deps());
    assert.strictEqual(r.sent, true);
    assert.strictEqual(sentBox.length, 1);
    assert.strictEqual(sentBox[0].to, 'kris@example.com');
    assert.ok(sentBox[0].subject.includes('SPY'));
    assert.ok(sentBox[0].text.includes(ROW.message));
    assert.ok(sentBox[0].link.includes('#alerts'), 'manage link points at the Alerts tab');
  });

  await check('rate cap: consumes the rolling-hour budget, then blocks, then resets next hour', async () => {
    const t0 = Date.parse('2026-08-12T15:00:00Z');
    store.setPrefs('u2', { email: true });
    for (let i = 0; i < HOURLY_CAP - 0; i++) {
      const r = await deliver('u2', ROW, deps(), t0 + i * 60000);
      assert.strictEqual(r.sent, true, 'send ' + (i + 1) + ' within cap');
    }
    const blocked = await deliver('u2', ROW, deps(), t0 + 30 * 60000);
    assert.strictEqual(blocked.skipped, 'rate_capped');
    const nextHour = await deliver('u2', ROW, deps(), t0 + 61 * 60000);
    assert.strictEqual(nextHour.sent, true, 'budget resets after the hour');
  });

  await check('a throwing sender is swallowed — the feed row already landed', async () => {
    store.setPrefs('u3', { email: true });
    const r = await deliver('u3', ROW, deps({ send: async () => { throw new Error('smtp down'); } }));
    assert.strictEqual(r.skipped, 'send_failed');
  });

  await check('prefs round-trip and stay boolean-strict', async () => {
    assert.deepStrictEqual(store.setPrefs('u4', { email: 'yes' }).prefs, { email: false }, 'only literal true opts in');
    assert.deepStrictEqual(store.getPrefs('u4'), { email: false });
    store.setPrefs('u4', { email: true });
    assert.deepStrictEqual(store.getPrefs('u4'), { email: true });
  });

  // ── #3329 reconciled onto #3249 ───────────────────────────────────────────
  await check('an UNVERIFIED address is never mailed', async () => {
    store.setPrefs('v1', { email: true });
    const r = await deliver('v1', ROW, deps({ getProfile: () => ({ email: 'stranger@example.com', emailVerified: false }) }));
    assert.strictEqual(r.skipped, 'email_unverified', 'signing up with someone else\'s address must not mail them');
    const r2 = await deliver('v1', ROW, deps({ getProfile: () => ({ email: 'x@example.com' }) }));
    assert.strictEqual(r2.skipped, 'email_unverified', 'a missing flag is not a verified address');
  });

  await check('a muted RULE is skipped while the rest of the account keeps emailing', async () => {
    store.setPrefs('m1', { email: true });
    const muted = store.saveRule('m1', { symbol: 'SPY', type: 'signal', direction: 'ANY', email: false });
    const loud  = store.saveRule('m1', { symbol: 'QQQ', type: 'signal', direction: 'ANY' });
    assert.strictEqual(muted.rule.email, false);
    assert.strictEqual(loud.rule.email, true, 'not muted is the default');

    const a = await deliver('m1', { ...ROW, ruleId: muted.rule.id }, deps());
    assert.strictEqual(a.skipped, 'rule_muted');
    const b = await deliver('m1', { ...ROW, ruleId: loud.rule.id, symbol: 'QQQ' }, deps());
    assert.strictEqual(b.sent, true, 'muting one rule must not mute the account');
  });

  await check('the mute is checked BEFORE the rate budget is spent', async () => {
    store.setPrefs('m2', { email: true });
    const muted = store.saveRule('m2', { symbol: 'SPY', type: 'signal', direction: 'ANY', email: false });
    for (let i = 0; i < HOURLY_CAP + 3; i++) {
      await deliver('m2', { ...ROW, ruleId: muted.rule.id }, deps());
    }
    // If the mute ran after the cap, the budget would be exhausted and a live
    // rule would now be wrongly rate-capped.
    const loud = store.saveRule('m2', { symbol: 'QQQ', type: 'signal', direction: 'ANY' });
    const r = await deliver('m2', { ...ROW, ruleId: loud.rule.id, symbol: 'QQQ' }, deps());
    assert.strictEqual(r.sent, true, 'muted fires must not consume the mailbox budget');
  });

  await check('the email carries a real, absolute link — not a dangling sentence', async () => {
    store.setPrefs('L1', { email: true });
    sentBox.length = 0;
    const r = await deliver('L1', ROW, deps());
    assert.strictEqual(r.sent, true);
    const msg = sentBox[sentBox.length - 1];
    assert.ok(msg.html, 'a branded HTML body, like every other account email');
    assert.ok(/https?:\/\/[^\s"']*stock-trader\.html#alerts/.test(msg.html), 'CTA points at the alerts view');
    assert.ok(/https?:\/\//.test(msg.text), 'the plain-text fallback carries the URL too');
    assert.ok(!/tab:\s*$/.test(msg.text), 'no sentence ending in a colon with nothing after it');
  });

  await check('a hostile display name cannot inject markup into the email', async () => {
    store.setPrefs('L2', { email: true });
    sentBox.length = 0;
    await deliver('L2', ROW, deps({ getProfile: () => ({ email: 'a@b.co', emailVerified: true, name: '<script>alert(1)</script>' }) }));
    const msg = sentBox[sentBox.length - 1];
    assert.ok(!msg.html.includes('<script>'), 'display names are escaped by the shared preset');
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})();
