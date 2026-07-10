// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * End-to-end auth flows against the real lantern-garage server with the token-gated
 * test-auth path enabled (see tests/playwright-auth.config.ts). Covers:
 *   1. Guest sees the "Sign in" affordance on the home page.
 *   2. Guest hitting a gated page is NOT shown an empty profile.
 *   3. The X-Test-Auth header authenticates as an emulated role (admin / supporter).
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
    await page.goto('/');
    // site-chrome injects #profile-btn; for a guest, auth-gate repurposes it into a
    // Sign in link (class nav-signin) rather than hiding it.
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

  test('a guest visiting the profile page is never shown the real profile editor', async ({ page }) => {
    await page.goto('/profile.html');
    // Server-side gating serves the "Unlock this feature" interstitial (or a redirect
    // to /auth.html) — never the authenticated Profile editor. Confirm both: the
    // session is a guest, and the real Profile page did not load.
    const s = await page.context().request.get('/api/auth/session').then((r) => r.json());
    expect(s.authenticated).toBeFalsy();
    expect(await page.title()).not.toContain('Profile —');
  });
});

test.describe('auth: header test-auth', () => {
  test('X-Test-Auth header authenticates as admin by default', async ({ request }) => {
    const res = await request.get('/api/auth/session', { headers: { 'X-Test-Auth': TOKEN } });
    const s = await res.json();
    expect(s.authenticated).toBe(true);
    expect(s.role).toBe('admin');
    expect(s.user.id).toBe('test-user');
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
    await page.goto('/auth.html');
    const panel = page.locator('#test-login');
    await expect(panel).toBeVisible();
    await expect(page.locator('#test-role-buttons button')).toHaveCount(5);
  });

  test('picking Admin signs in as the test account', async ({ page }) => {
    await page.goto('/auth.html?returnTo=/profile.html');
    // Assert on the test-login response + the shared context cookies rather than the
    // page, which client-redirects (profile.html re-checks auth) and would race.
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
    await page.goto('/auth.html?returnTo=/profile.html');
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/auth/test-login')),
      page.locator('#test-role-buttons button', { hasText: 'Supporter' }).click(),
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
