// @ts-check
const { test, expect } = require('@playwright/test');
const { TOKEN, STEPS, recordStep, accountTag } = require('./journey.helpers');

/**
 * Greenpath release gate (#2545): provision N demo accounts (default 10) and walk
 * the full signup → paper-trade → chat → Pro journey for each. Every step must be
 * green on every account before the first-50 invite program opens.
 *
 * Steps are keyed s1..s9 per the issue. EXECUTION order runs s6 (the Free→Pro
 * gate) before s4/s5: all /api/trading mutations are server-gated on the "trade"
 * entitlement today, so the Free account meets the upgrade prompt exactly when it
 * first tries to trade. The harness verifies the gate renders, performs the
 * upgrade through the real staff endpoint (simulating the purchase), re-logs-in
 * (role changes invalidate sessions), then finishes the trading steps as Pro.
 *
 * Real-browser rule: signup, the upgrade prompt, and both chat turns are typed/
 * clicked in the page. Data-plane steps (watchlist, wallet, trade, broker status,
 * BYOK, journal) call the same /api endpoints the pages call, through the SAME
 * browser context/session cookie (page.context().request) — no header spoofing,
 * no server-side injection.
 */

const PORT = Number(process.env.GREENPATH_PORT || 4323); // keep in sync with playwright-greenpath.config.ts
const BASE = `http://127.0.0.1:${PORT}`;
const N = Math.max(1, Number(process.env.GREENPATH_ACCOUNTS || 10));

for (let n = 1; n <= N; n++) journeyFor(n);

function journeyFor(n) {
  const tag = accountTag(n);

  test.describe.serial(`greenpath ${tag}`, () => {
    /** @type {import('@playwright/test').BrowserContext} */ let context;
    /** @type {import('@playwright/test').Page} */ let page;
    /** @type {import('@playwright/test').APIRequestContext} */ let admin;

    // Run id is stamped by global-setup; resolve per-account identity lazily so
    // the value is read inside the worker process.
    const runId = () => process.env.GREENPATH_RUN_ID || 'adhoc';
    const email = () => `greenpath-${runId()}-${tag}@greenpath.test`;
    const password = () => `Greenpath-${runId()}-pw1`;
    const ticker = () => `GREENPATH-${runId().toUpperCase()}-${tag.toUpperCase()}`;
    const state = { userId: '', positionId: '' };

    test.beforeAll(async ({ browser, playwright }) => {
      context = await browser.newContext({ baseURL: BASE });
      page = await context.newPage();
      admin = await playwright.request.newContext({
        baseURL: BASE,
        // Role must be named explicitly: an absent X-Test-Role is fail-closed to
        // guest (#2645), and the staff endpoints need admin.
        extraHTTPHeaders: { 'X-Test-Auth': TOKEN, 'X-Test-Role': 'admin' },
      });
    });

    test.afterAll(async () => {
      // Best-effort cleanup: archive the demo account (soft delete) unless the
      // operator wants to inspect the run. Runs even when a step failed.
      try {
        if (state.userId && process.env.GREENPATH_KEEP_ACCOUNTS !== '1') {
          await admin.post('/api/accounts/delete', { data: { id: state.userId } });
        }
      } catch { /* cleanup is best-effort */ }
      await admin?.dispose().catch(() => {});
      await context?.close().catch(() => {});
    });

    /** Declare one journey step as a Playwright test that records its outcome. */
    function step(key, fn, opts = {}) {
      test(`${tag} ${key} — ${STEPS[key]}`, async () => {
        if (opts.timeout) test.setTimeout(opts.timeout);
        const t0 = Date.now();
        try {
          const detail = await fn();
          recordStep(tag, key, 'pass', Date.now() - t0, detail || '');
        } catch (e) {
          recordStep(tag, key, 'fail', Date.now() - t0, String((e && e.message) || e).slice(0, 400));
          throw e;
        }
      });
    }

    const session = async () => (await context.request.get('/api/auth/session')).json();

    // ── s1: sign up in the real form, clear the hard email gate, log in ────────
    step('s1', async () => {
      await page.goto('/auth.html');
      await page.locator('#local-toggle').click(); // login → "Create account" mode
      await page.locator('#local-name').fill(`Greenpath ${tag}`);
      await page.locator('#local-email').fill(email());
      await page.locator('#local-password').fill(password());
      await page.locator('#local-confirm').fill(password());
      await page.locator('#tos-agree').check();
      const [reg] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/auth/local/register')),
        page.locator('#local-submit').click(),
      ]);
      expect(reg.status(), 'register should 202 into the pending-verification state').toBe(202);
      const regBody = await reg.json();
      expect(regBody.pendingVerification).toBe(true);

      // Hard email gate: the emailed CODE must be entered before login works. On
      // loopback with no mail provider the page surfaces the dev code; anywhere else
      // this fails — the gate host must run without a mailer configured (see the doc).
      const devCode = page.locator('#verify-dev-code');
      await expect(devCode, 'dev verify code missing — a mail provider is configured on this ' +
        'host; unset RESEND_API_KEY/SMTP_* in .env.local for the greenpath run ' +
        '(docs/GREENPATH-GATE.md)').toBeVisible();
      const code = (await devCode.locator('strong').textContent() || '').trim();
      expect(code, 'dev code should be 6 digits').toMatch(/^\d{6}$/);
      // Typing the 6th digit auto-submits, so wait on the verify-code response rather
      // than a navigation — confirming a code never leaves the page.
      // Type into the segmented row exactly as a user would — focus box 1 and let
      // auto-advance carry the rest. fill() would only populate a single box.
      await page.locator('#verify-code-boxes .code-box').first().focus();
      const [confirmed] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/auth/verify-code')),
        page.keyboard.type(code),
      ]);
      expect(confirmed.status(), 'the emailed code should confirm the address').toBe(200);

      // Now the real email+password login, typed into the form.
      await page.locator('#local-email').fill(email());
      await page.locator('#local-password').fill(password());
      const [login] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/auth/local/login')),
        page.locator('#local-submit').click(),
      ]);
      expect(login.status(), 'verified account should log in').toBe(200);

      const s = await session();
      expect(s.authenticated).toBe(true);
      expect(s.user.email).toBe(email());
      state.userId = s.user.id;
      return `registered+verified+logged in as ${email()} (role ${s.role}, id ${s.user.id})`;
    });

    // ── s2: the Free paper-trading account view ────────────────────────────────
    step('s2', async () => {
      const res = await context.request.get('/api/trading/positions?demo=champion');
      expect(res.ok(), 'demo paper account view should render for a Free account').toBe(true);
      const body = await res.json();
      expect(Array.isArray(body.positions)).toBe(true);
      return `demo paper account renders (${body.positions.length} positions). ` +
        'NOTE: per-user auto-provisioned paper accounts are not implemented yet ' +
        '(#2545 dependency) — Free sees the champion demo; the shared Kalshi paper wallet unlocks at Pro.';
    });

    // ── s3: per-user watchlist ─────────────────────────────────────────────────
    step('s3', async () => {
      const add = await context.request.post('/api/trading/watchlist', { data: { ticker: 'NVDA' } });
      expect(add.ok(), 'watchlist add should be allowed for a signed-in Free account').toBe(true);
      const listed = await (await context.request.get('/api/trading/watchlist')).json();
      expect(listed.watchlist).toContain('NVDA');
      return `watchlist persisted for ${tag}: [${listed.watchlist.join(', ')}]`;
    });

    // ── s6: the Free→Pro gate renders, then the upgrade happens for real ───────
    step('s6', async () => {
      // (a) UI upgrade prompt: signed-in Free on the stock trader sees the tier CTA.
      //
      // Arrive the way a Free user actually does. Since #3039 ("route Free users to
      // Watch"), a NON-deliberate landing on /stock-trader.html redirects to
      // /watch.html?from=trader — so a bare goto() never renders the CTA and this step
      // failed on a behaviour change, not a defect. A deliberate arrival (the in-page
      // Trade tab, a pricing link, or a referrer from watch/options/pricing) still gets
      // the explanatory CTA, which is the journey being validated here.
      await page.goto('/watch.html');
      await page.goto('/stock-trader.html?stay=1');
      const cta = page.locator('#signinCta');
      await expect(cta, 'Free account should see the upgrade CTA on stock-trader').toBeVisible();
      await expect(cta).toHaveText(/Upgrade to trade/);

      // (b) API gate: trading data plane answers 403 with the entitlement named.
      const walletGate = await context.request.get('/api/trading/kalshi/paper-wallet');
      expect(walletGate.status(), 'trade API must be server-gated for Free').toBe(403);
      expect((await walletGate.json()).entitlement).toBe('trade');

      // (c) Page gate: the entitlement-gated terminal serves the unlock page.
      const gatePage = await (await context.request.get('/kalshi-terminal.html')).text();
      expect(gatePage).toContain('needs an upgrade');

      // (d) Upgrade — the real staff endpoint stands in for the purchase webhook.
      // A `reason` is REQUIRED to grant a paid tier by hand since #3100 (it is recorded
      // on the account so a comp is distinguishable from a real subscription); without
      // it the endpoint answers 400 reason_required.
      const up = await admin.post('/api/accounts/role', {
        data: { id: state.userId, role: 'deep_dreamer', reason: 'greenpath release gate — simulated purchase' },
      });
      expect(up.ok(), 'staff role upgrade should succeed').toBe(true);
      const upBody = await up.json();

      // (e) Role changes invalidate live sessions — log back in like a real user.
      const relogin = await context.request.post('/api/auth/local/login', {
        data: { email: email(), password: password() },
      });
      expect(relogin.status()).toBe(200);
      const s = await session();
      expect(s.role).toBe('deep_dreamer');
      const wallet = await context.request.get('/api/trading/kalshi/paper-wallet');
      expect(wallet.status(), 'trade API should open up after the upgrade').toBe(200);
      return `gate verified (CTA + API 403 + unlock page); upgraded to deep_dreamer ` +
        `(sessions invalidated: ${upBody.sessionsInvalidated}); re-login OK, trade API open`;
    });

    // ── s4: place a paper trade on the Kalshi paper ledger ─────────────────────
    step('s4', async () => {
      const wallet = await (await context.request.get('/api/trading/kalshi/paper-wallet')).json();
      expect(wallet.cashCents, 'paper wallet should have cash for a 5¢ entry').toBeGreaterThanOrEqual(5);
      const res = await context.request.post('/api/trading/kalshi/paper-trade', {
        data: { ticker: ticker(), side: 'yes', limitCents: 5, qty: 1, source: 'greenpath-e2e' },
      });
      expect(res.status(), 'paper trade should be accepted').toBe(201);
      const body = await res.json();
      expect(body.id).toBeTruthy();
      state.positionId = body.id;
      return `bought 1 YES ${ticker()} @5¢ (position ${body.id}); ` +
        `wallet cash ${body.wallet.cashCents}¢ / invested ${body.wallet.investedCents}¢`;
    });

    // ── s5: chat about the trade in the real UI; the reply must recall it ──────
    step('s5', async () => {
      await page.goto('/chat.html');
      const first = await sendChat(page,
        `I just placed a paper trade on the Kalshi paper ledger: bought 1 YES contract of ` +
        `${ticker()} at 5 cents. Please acknowledge you noted it.`);
      const second = await sendChat(page,
        'Which ticker did I just tell you I paper-traded? Reply with the ticker symbol only.');
      expect(second.toUpperCase(), 'chat should recall the traded ticker from the conversation')
        .toContain(ticker().toUpperCase());
      return `chat acknowledged the trade (${first.length} chars) and recalled the ticker in turn 2`;
    }, { timeout: 360_000 });

    // ── s8: BYOK provider keys persist server-side (#2505) ─────────────────────
    step('s8', async () => {
      const dummy = ['sk', 'greenpath', 'x'.repeat(24)].join('-'); // inert placeholder-shaped value
      const set = await context.request.post('/api/providers/set-key', {
        data: { provider: 'openai', key: dummy },
      });
      expect(set.ok(), 'BYOK set-key should persist').toBe(true);
      const masked = (await set.json()).masked;
      const listed = await (await context.request.get('/api/providers/set-key')).json();
      const mine = (listed.keys || []).find((k) => k.provider === 'openai');
      expect(mine && mine.set, 'saved key should list as set for this account').toBe(true);
      const clear = await context.request.delete('/api/providers/set-key', { data: { provider: 'openai' } });
      expect(clear.ok()).toBe(true);
      const after = await (await context.request.get('/api/providers/set-key')).json();
      const gone = (after.keys || []).find((k) => k.provider === 'openai');
      expect(!gone || gone.set === false, 'cleared key should no longer list as set').toBe(true);
      return `BYOK set (${masked}) → listed → cleared, server-side per-account store`;
    });

    // ── s9: the trade journal shows the trade; tag it on close ─────────────────
    step('s9', async () => {
      const hist = await (await context.request.get('/api/trading/kalshi/paper-history?limit=100')).json();
      const mine = (hist.trades || []).find((t) => t.id === state.positionId);
      expect(mine, 'journal should show the paper trade from s4').toBeTruthy();
      expect(mine.status).toBe('open');
      const close = await context.request.post('/api/trading/kalshi/paper-close', {
        data: { id: state.positionId, exitTag: 'GREENPATH-TAGGED', exitPriceCents: 5, pnlPct: 0 },
      });
      expect(close.ok(), 'tagging the trade on close should succeed').toBe(true);
      const after = await (await context.request.get('/api/trading/kalshi/paper-history?limit=100')).json();
      const tagged = (after.trades || []).find((t) => t.id === state.positionId);
      expect(tagged.status).toBe('closed');
      expect(tagged.exitTag).toBe('GREENPATH-TAGGED');
      return `journal listed ${state.positionId}; tagged GREENPATH-TAGGED on close (flat exit, wallet restored)`;
    });

    // ── s7: Pro broker connect surface (Alpaca paper) ──────────────────────────
    // Declared LAST deliberately: s7 is the only step that depends on host-side
    // broker config, so when it's the missing piece the run still reports the
    // true state of s8/s9 instead of serial-skipping them.
    step('s7', async () => {
      const res = await context.request.get('/api/broker/alpaca/status');
      expect(res.status(), 'alpaca status should be reachable for Pro').toBe(200);
      const body = await res.json();
      // Owner/OAuth boxes: already connected → surface is live, done.
      if (body.connected === true) {
        return `alpaca connected (via ${body.via || 'oauth'}, env ${body.env || 'paper'})`;
      }
      // Signed-in users get NO shared server account (#2546 — pooling was a privacy
      // bug), so the REAL journey is bring-your-own-keys. Exercise that actual flow:
      // paste keys → status connected via 'keys' → disconnect (cleanup, so the demo
      // account is never left broker-linked). Test material: the host's own paper
      // keys, read from the repo-root .env.local (the server validates them against
      // Alpaca before storing — a dead key fails loudly here, which is the point).
      const fs = require('fs');
      const path = require('path');
      let keyId = '', secretKey = '';
      try {
        const envTxt = fs.readFileSync(path.resolve(__dirname, '..', '..', '.env.local'), 'utf8');
        keyId = (envTxt.match(/^ALPACA_API_KEY(?:_ID)?=(.*)$/m) || [])[1] || '';
        secretKey = (envTxt.match(/^ALPACA_(?:API_)?SECRET(?:_KEY)?=(.*)$/m) || [])[1] || '';
      } catch { /* no .env.local on this host */ }
      if (!keyId || !secretKey) {
        throw new Error('Alpaca test broker not available on this host — no connected account, ' +
          'no OAuth app, and no paper keys in .env.local to exercise the BYOK connect flow. ' +
          'Status: ' + JSON.stringify(body).slice(0, 200));
      }
      const conn = await context.request.post('/api/broker/alpaca/connect-keys', {
        data: { keyId: keyId.trim(), secretKey: secretKey.trim(), env: 'paper' },
      });
      expect(conn.ok(), 'BYOK connect-keys should validate and store: ' +
        (await conn.text()).slice(0, 200)).toBe(true);
      const after = await (await context.request.get('/api/broker/alpaca/status')).json();
      expect(after.connected, 'status should show connected after BYOK').toBe(true);
      expect(after.via, 'BYOK connection reports via=keys').toBe('keys');
      expect(after.env, 'BYOK defaults to the paper account').toBe('paper');
      const off = await context.request.post('/api/broker/alpaca/disconnect');
      expect(off.ok(), 'disconnect should remove the stored keys').toBe(true);
      const final = await (await context.request.get('/api/broker/alpaca/status')).json();
      expect(final.connected, 'demo account must not stay broker-linked').toBe(false);
      return `alpaca BYOK journey: connect-keys → connected (via keys, paper, acct ${after.accountNumber || '?'}) → disconnected`;
    });
  });
}

/**
 * Type a message into the dream-chat composer, send it, and wait for the agent's
 * streamed reply to finish. Returns the reply text; throws on an error bubble.
 */
async function sendChat(page, text) {
  const agentMsgs = page.locator('.message.agent');
  const before = await agentMsgs.count();
  const sendBtn = page.locator('#send-btn');
  // Composer ready: while a stream is in flight the Send button is display:none,
  // swapped for the transient #stop-btn (#930) — wait for it to be back + enabled.
  await expect(sendBtn, 'chat composer should be ready to send').toBeVisible({ timeout: 60_000 });
  await expect(sendBtn).toBeEnabled({ timeout: 60_000 });
  await page.locator('#input').fill(text);
  await sendBtn.click();
  await expect(agentMsgs, 'an agent reply should appear').toHaveCount(before + 1, { timeout: 150_000 });
  // Stream done: the Stop control goes away and Send is restored (#930). Only then
  // is the bubble's text the final reply rather than the "Researching…" status.
  await expect(page.locator('#stop-btn')).toBeHidden({ timeout: 150_000 });
  await expect(sendBtn).toBeVisible({ timeout: 60_000 });
  const last = agentMsgs.last();
  const isError = await last.evaluate((el) => el.classList.contains('error'));
  const reply = (await last.innerText()).trim();
  if (isError) throw new Error('chat replied with an error bubble: ' + reply.slice(0, 250));
  if (!reply) throw new Error('chat reply was empty after the stream finished');
  return reply;
}
