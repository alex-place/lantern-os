import { defineConfig, devices } from '@playwright/test';

/**
 * Auth-flow E2E config — boots the REAL lantern-garage Node server (not the static
 * ../surfaces http.server used by playwright.config.ts) with the token-gated
 * test-auth path enabled, so specs can exercise guest → picker → authed → logout
 * end-to-end against the actual auth routes.
 *
 * Run from apps/lantern-garage:  npm run test:auth
 *   (which invokes: npx playwright test --config ../../tests/playwright-auth.config.ts)
 */
const PORT = Number(process.env.AUTH_E2E_PORT || 4319);
const TOKEN = 'e2e-test-auth-token-abcdef';

export default defineConfig({
  testDir: './e2e-auth',
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Not set globally — specs opt into the header per-context so we can also test
    // the guest (no-header) path in the same run.
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  metadata: { testAuthToken: TOKEN },
  webServer: {
    command: 'node apps/lantern-garage/server.js',
    cwd: '..', // config lives in tests/; run from repo root
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      // LANTERN_GARAGE_PORT (not PORT): PORT flips the server into cloud mode,
      // whose Secure session cookies never get set over plain-http loopback — the
      // test-login 200s but no Set-Cookie arrives (same trap documented in
      // playwright-greenpath.config.ts).
      LANTERN_GARAGE_PORT: String(PORT),
      LANTERN_GARAGE_HOST: '127.0.0.1',
      SESSION_SECRET: 'e2e-loopback-only-secret',
      LANTERN_TEST_AUTH_TOKEN: TOKEN,
      LANTERN_CHAT_ONLY: '1',
      LANTERN_MCP_SERVER: 'false',
      LANTERN_DISABLE_TRADING: '1',
      LANTERN_CLOUDFLARE_TUNNEL: 'false',
    },
  },
});
