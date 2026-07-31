import { defineConfig, devices } from '@playwright/test';

/**
 * Access-model E2E config — boots the real lantern-garage server with TRADING
 * ENABLED so the specs can exercise the trade gate for real.
 *
 * Deliberately different from playwright-sitemap.config.ts (which sets
 * LANTERN_DISABLE_TRADING=1 because navigability doesn't need the trading stack)
 * and from playwright-auth.config.ts (which sets LANTERN_CHAT_ONLY=1). Neither
 * of those can answer "may this user place an order", which is the whole point
 * here.
 *
 * No default auth headers: these specs opt in per-request, so the same run can
 * cover the guest path and the signed-in path.
 *
 *   npm run test:access
 */
const PORT = Number(process.env.ACCESS_E2E_PORT || 4322);
export const TOKEN = 'e2e-access-auth-token-abcdef';

export default defineConfig({
  testDir: './e2e-access',
  timeout: 90_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node apps/lantern-garage/server.js',
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      // LANTERN_GARAGE_PORT (not PORT): PORT flips the server into cloud mode,
      // whose Secure cookies never set over plain-http loopback.
      LANTERN_GARAGE_PORT: String(PORT),
      LANTERN_GARAGE_HOST: '127.0.0.1',
      SESSION_SECRET: 'e2e-loopback-only-secret',
      LANTERN_TEST_AUTH_TOKEN: TOKEN,
      // A DEDICATED test identity. The shared default ("test-user") carries a
      // persisted per-account entitlement override ({ trade: true }) from earlier
      // dev work, which outranks every tier rule and would make the negative
      // cases in the access spec vacuous.
      LANTERN_TEST_USER_ID: 'e2e-access-user',
      LANTERN_MCP_SERVER: 'false',
      LANTERN_CLOUDFLARE_TUNNEL: 'false',
      TRADING_ENABLED: '1',
    },
  },
});
