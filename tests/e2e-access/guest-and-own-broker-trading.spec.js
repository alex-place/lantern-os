// @ts-check
/**
 * guest-and-own-broker-trading.spec.js — the two access rules set on 2026-07-31:
 *
 *   1. A first-time visitor is a GUEST. They are served the page, never bounced
 *      to /auth.html to make an entry choice.
 *   2. Trading is gated on CONNECTING YOUR OWN BROKER, not on paying for Pro.
 *      A signed-in Free user with their own broker connected may place orders.
 *      A guest may not, whatever else is true.
 *
 * Rule 2 is a money path, so the negative cases matter more than the positive
 * one: the tests below check that a guest and an unconnected Free user are both
 * refused BEFORE checking that a connected Free user is allowed.
 *
 *   npm run test:access
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const store = require('../../apps/lantern-garage/lib/alpaca-credentials');

const TOKEN = 'e2e-access-auth-token-abcdef'; // must match playwright-access.config.ts
const FREE = { 'X-Test-Auth': TOKEN, 'X-Test-Role': 'supporter' }; // supporter -> Free plan
// Must match LANTERN_TEST_USER_ID in playwright-access.config.ts. Deliberately
// NOT the shared "test-user", which carries a persisted { trade: true } override
// that would silently satisfy the negative cases below.
const TEST_USER = 'e2e-access-user';

/**
 * Order placement — the actual "can this user trade" question. Note that
 * /api/trading/positions is NOT gated (it answers 200 for an unentitled user),
 * so it cannot stand in for this; an earlier draft of this spec used it and the
 * positive case passed trivially.
 */
const PLACE_ORDER = '/api/trading/orders';
const ORDER_BODY = { symbol: 'AAPL', qty: 1, side: 'buy', type: 'market', time_in_force: 'day' };

const pageName = (url) => new URL(url).pathname.replace(/^\//, '') || 'index.html';

test.describe('access model', () => {
  test.afterEach(() => {
    // Never let seeded broker credentials leak into another test or a later run.
    try { store.remove(TEST_USER); } catch { /* nothing to clean */ }
  });

  // ── Rule 1: first-time visitor is a guest ──────────────────────────────────

  test('a first-time visitor is served the page, not bounced to auth', async ({ page }) => {
    // A fresh context has no session cookie and no ln_guest cookie — the exact
    // state that used to trigger the first-visit gate.
    for (const target of ['/', '/stock-trader.html', '/contest.html', '/chat.html']) {
      await page.goto(target);
      // Let the client-side auth gate run; it redirected here before the change.
      await page.waitForLoadState('networkidle');
      const landed = pageName(page.url());
      expect(landed, `${target} must not bounce a first-time visitor to auth`).not.toBe('auth.html');
    }
  });

  test('the guest still has no session — assumed guest, not silently signed in', async ({ page }) => {
    const session = await page.request.get('/api/auth/session').then((r) => r.json());
    expect(session.authenticated).toBeFalsy();
    expect(session.role).toBe('guest');
  });

  // ── Rule 2, negative cases first ───────────────────────────────────────────

  test('a guest cannot place an order even with broker credentials on disk', async ({ page }) => {
    // Seed credentials for the test account, then call with NO auth header. The
    // guest must still be refused: entitlement resolves from the session, so
    // credentials belonging to someone else must never leak access.
    store.saveKeys(TEST_USER, { keyId: 'PKTESTKEYID0000000', secretKey: 'test-secret-key-value-000', env: 'paper' });

    const res = await page.request.post(PLACE_ORDER, { data: ORDER_BODY, maxRedirects: 0 });
    expect([302, 401, 403], `a guest placed an order and got ${res.status()}`).toContain(res.status());
  });

  /**
   * NOT EXPRESSIBLE VIA TEST-AUTH — deliberately skipped, not quietly deleted.
   *
   * The Free-tier cases below cannot be tested through the test-auth token.
   * lib/test-auth.ensureTestProfile() seeds every test identity with
   * `role: "admin"` and `entitlements: { trade: true }`, and re-asserts admin
   * whenever it drifts. hasEntitlement() resolves on the PERSISTED role, so it
   * short-circuits at `if (role === "admin") return true` for any test-auth
   * session. X-Test-Role changes only the SESSION role, which entitlement checks
   * never consult.
   *
   * The practical consequence is broader than this spec: ANY test that claims to
   * verify entitlement gating through test-auth is vacuous — it is reading the
   * seeded admin grant, not the gate. Writing the profile from the test process
   * to work around it races the server and crashed it outright when tried.
   *
   * Un-skip once test-auth can seed a non-admin identity (e.g. an env-controlled
   * seed role). Until then the own-broker grant in lib/auth-middleware is covered
   * by review only, and that limit is stated rather than papered over.
   */
  test.skip('a signed-in Free user with NO broker connected cannot trade', async () => {});
  test.skip('a signed-in Free user WITH their own broker connected can trade', async () => {});
});
