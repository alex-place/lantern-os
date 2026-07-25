// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * End-to-end auth flows against the real lantern-garage server with the token-gated
 * test-auth path enabled (see tests/playwright-auth.config.ts). Covers:
 *   1. Guest sees the "Sign in" affordance on the home page.
 *   2. Guest hitting a gated page is NOT shown an empty profile.
 *   3. The X-Test-Auth header authenticates least-privilege by default (#2645);
 *      admin is reachable only by naming it via X-Test-Role.
 *   4. A proxy/tunnel header makes the token inert (never bypassable from the net).
 *   5. The auth-page role picker signs in as the seeded test account.
 *   6. Logout returns to guest.
 *   7. The seeded account can log in with email + password.
 */

const TOKEN = 'e2e-test-auth-token-abcdef'; // must match playwright-auth.config.ts
const TEST_EMAIL = 'test@unisona.local';
const TEST_PASSWORD = 'test-account-1234';

test.describe('auth: guest experience', () => {
  test('home page shows a Sign in affordance for a guest', async ({ page }) => {
    // First visit, no entry choice recorded: the first-visit gate (auth-gate.js)
    // sends an undecided guest to /auth.html ONCE to decide — signed-out-and-asked,
    // never silently signed in.
    await page.goto('/');
    await page.waitForURL(/\/auth\.html/);
    const guestBtn = page.locator('#continue-guest');
    await expect(guestBtn).toBeVisible();
    // "Continue without an account" records ln_guest and returns home…
    await guestBtn.click();
    await page.waitForURL((url) => !url.pathname.startsWith('/auth'));
    // …where site-chrome's #profile-btn is repurposed by auth-gate into a Sign in
    // link (class nav-signin) rather than hidden — the guest is never stranded.
    const signin = page.locator('#profile-btn.nav-signin, a.nav-signin');
    await expect(signin.first()).toBeVisible();
    const href = await signin.first().getAttribute('href');
    expect(href || '').toContain('/auth.html');
  });

  test('guest session endpoint reports unauthenticated + testMode', async ({ request }) => {
    const res = await request.get('/api/auth/session');
    expect(res.ok()).toBeTruthy();
    const s = await res.json();
    expect(s.authenticated).toBeFalsy();
    expect(s.role).toBe('guest');
    expect(s.testMode).toBe(true);
    expect(Array.isArray(s.testRoles)).toBe(true);
  });

  test('a guest visiting the settings page is never shown the real account editor', async ({ page }) => {
    await page.goto('/settings.html');
    // Server-side gating serves the "Unlock this feature" interstitial (or a redirect
    // to /auth.html) — never the authenticated account editor. Confirm both: the
    // session is a guest, and the real Profile page did not load.
    const s = await page.context().request.get('/api/auth/session').then((r) => r.json());
    expect(s.authenticated).toBeFalsy();
    expect(await page.title()).not.toContain('Settings —');
  });
});

test.describe('auth: header test-auth', () => {
  test('X-Test-Auth header authenticates least-privilege by default, admin only explicitly', async ({ request }) => {
    // #2645: a bare token is NOT admin — defaulting to admin was fail-open. The
    // token authenticates as the seeded account at guest privilege; operator roles
    // must be named via X-Test-Role (a deliberate act).
    const res = await request.get('/api/auth/session', { headers: { 'X-Test-Auth': TOKEN } });
    const s = await res.json();
    expect(s.authenticated).toBe(true);
    expect(s.role).toBe('guest');
    expect(s.user.id).toBe('test-user');

    const admin = await request.get('/api/auth/session', {
      headers: { 'X-Test-Auth': TOKEN, 'X-Test-Role': 'admin' },
    });
    const a = await admin.json();
    expect(a.authenticated).toBe(true);
    expect(a.role).toBe('admin');
  });

  test('X-Test-Role downgrades the emulated role', async ({ request }) => {
    const res = await request.get('/api/auth/session', {
      headers: { 'X-Test-Auth': TOKEN, 'X-Test-Role': 'supporter' },
    });
    const s = await res.json();
    expect(s.authenticated).toBe(true);
    expect(s.role).toBe('supporter');
  });

  test('wrong token is rejected', async ({ request }) => {
    const res = await request.get('/api/auth/session', { headers: { 'X-Test-Auth': 'nope' } });
    const s = await res.json();
    expect(s.authenticated).toBeFalsy();
  });

  test('a proxy header makes the token inert (no bypass from behind a proxy)', async ({ request }) => {
    const res = await request.get('/api/auth/session', {
      headers: { 'X-Test-Auth': TOKEN, 'X-Forwarded-For': '203.0.113.9' },
    });
    const s = await res.json();
    expect(s.authenticated).toBeFalsy();
  });
});

test.describe('auth: role picker + session', () => {
  test('the auth page renders the dev role picker', async ({ page }) => {
    // One button per server-reported test role (don't hardcode the roster: it
    // grew from 5 to 6 when tech_support was added and will drift again).
    const session = await page.request.get('/api/auth/session').then((r) => r.json());
    expect(Array.isArray(session.testRoles)).toBe(true);
    expect(session.testRoles.length).toBeGreaterThanOrEqual(5);
    await page.goto('/auth.html');
    const panel = page.locator('#test-login');
    await expect(panel).toBeVisible();
    await expect(page.locator('#test-role-buttons button')).toHaveCount(session.testRoles.length);
  });

  test('picking Admin signs in as the test account', async ({ page }) => {
    await page.goto('/auth.html?returnTo=/settings.html');
    // Assert on the test-login response + the shared context cookies rather than the
    // page, which client-redirects (settings.html re-checks auth) and would race.
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/auth/test-login')),
      page.locator('#test-role-buttons button', { hasText: 'Admin' }).click(),
    ]);
    expect(resp.status()).toBe(200);
    const s = await page.context().request.get('/api/auth/session').then((r) => r.json());
    expect(s.authenticated).toBe(true);
    expect(s.role).toBe('admin');
    expect(s.user.id).toBe('test-user');
  });

  test('logout returns to guest', async ({ page }) => {
    await page.goto('/auth.html?returnTo=/settings.html');
    // The picker labels tiers, not role slugs: supporter renders as "Free". Wait for
    // the post-login navigation to LAND (not just the test-login response) so the
    // logout below isn't racing an in-flight page load. (Logout durability against
    // that race is locked separately by test/session-store-logout.test.js.)
    await Promise.all([
      // Match on the PATHNAME: a bare /settings\.html/ regex also matches the
      // CURRENT url's ?returnTo=/settings.html query and resolves before login.
      page.waitForURL((url) => url.pathname === '/settings.html'),
      page.locator('#test-role-buttons button', { hasText: 'Free' }).click(),
    ]);
    // Signed in now (shared context cookie).
    let s = await page.context().request.get('/api/auth/session').then((r) => r.json());
    expect(s.authenticated).toBe(true);
    // Log out through the same context, then confirm guest.
    await page.context().request.post('/api/auth/logout');
    s = await page.context().request.get('/api/auth/session').then((r) => r.json());
    expect(s.authenticated).toBeFalsy();
  });
});

test.describe('auth: seeded account email+password login', () => {
  test('the seeded test account can log in with email + password', async ({ request }) => {
    const res = await request.post('/api/auth/local/login', {
      data: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user.id).toBe('test-user');
    expect(body.user.emailVerified).toBe(true);
  });
});
