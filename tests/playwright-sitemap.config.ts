import { defineConfig, devices } from '@playwright/test';

/**
 * Sitemap / navigability E2E config — boots the REAL lantern-garage Node server
 * (not the static ../surfaces http.server used by playwright.config.ts) so the
 * spec clicks through the actual shipped pages and their real nav.
 *
 * Run from repo ROOT:
 *   npm run test:sitemap          # headless
 *   npm run test:sitemap:headed   # visible browser, slowed for watchable playback
 *
 * See docs/SITEMAP-NAV-MAP.md for the flowchart and runbook.
 */
const PORT = Number(process.env.SITEMAP_E2E_PORT || 4321);
const TOKEN = 'e2e-sitemap-auth-token-abcdef';
// Set by scripts/run-sitemap-e2e.mjs (`npm run test:sitemap:headed`). This is
// NOT detected from argv: the Playwright CLI reparses argv before the config
// module loads, so `process.argv.includes('--headed')` is always false here.
const HEADED = !!process.env.SITEMAP_E2E_HEADED;

export default defineConfig({
  testDir: './e2e-sitemap',
  timeout: 120_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: HEADED ? 'off' : 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Navigability is a question about a *signed-in* user (#3107). Without this
    // header every nav click bounces to auth.html and the spec would only ever
    // measure the login wall. X-Test-Role names the tier explicitly — a bare
    // token authenticates at guest privilege, which is still gated (#2645).
    extraHTTPHeaders: {
      'X-Test-Auth': TOKEN,
      'X-Test-Role': 'deep_dreamer',
    },
    // Headed runs are for a human to watch, so slow the actions down enough to
    // follow. Headless/CI runs stay at full speed.
    launchOptions: HEADED ? { slowMo: 450 } : {},
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Headed runs use the locally-installed Google Chrome rather than
        // Playwright's bundled headful Chromium. The bundled build fails to
        // start on this host ("side-by-side configuration is incorrect" — a
        // missing MSVC runtime); the headless shell is unaffected, so only the
        // watchable path needs the system channel.
        ...(HEADED ? { channel: 'chrome' as const } : {}),
      },
    },
  ],
  webServer: {
    command: 'node apps/lantern-garage/server.js',
    cwd: '..', // config lives in tests/; run from repo root
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      // LANTERN_GARAGE_PORT (not PORT): PORT flips the server into cloud mode,
      // whose Secure session cookies never get set over plain-http loopback.
      // Same trap documented in playwright-auth.config.ts.
      LANTERN_GARAGE_PORT: String(PORT),
      LANTERN_GARAGE_HOST: '127.0.0.1',
      SESSION_SECRET: 'e2e-loopback-only-secret',
      LANTERN_TEST_AUTH_TOKEN: TOKEN,
      LANTERN_MCP_SERVER: 'false',
      LANTERN_DISABLE_TRADING: '1',
      LANTERN_CLOUDFLARE_TUNNEL: 'false',
    },
  },
});
