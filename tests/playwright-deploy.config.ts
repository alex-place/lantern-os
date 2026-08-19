import { defineConfig, devices } from '@playwright/test';

/**
 * playwright-deploy.config.ts — verify a RUNNING deployment.
 *
 * Every other suite here boots its own server with test-shaped env (see the
 * `webServer` block in playwright-auth/access/sitemap configs). That is the
 * right way to test CODE — and it is structurally incapable of catching a
 * broken DEPLOYMENT, because the environment under test is freshly built and
 * therefore never has production's configuration.
 *
 * That blind spot shipped a real outage: the GCE host ran with ZERO providers
 * configured, so chat had no model at all, and nothing in CI could have known.
 * This config deliberately has NO webServer — it points at whatever is already
 * serving and asks whether the product actually works there.
 *
 *   npm run test:deploy                                  # local :8080
 *   DEPLOY_BASE_URL=https://unisona.ai npm run test:deploy
 *   DEPLOY_EXPECT_LIVE=1 DEPLOY_BASE_URL=... npm run test:deploy   # + serving assertions
 *
 * DEPLOY_EXPECT_LIVE gates the assertions that only make sense against a real
 * deployment (at least one provider actually usable). Structural checks — the
 * ones that catch a misreporting registry — run everywhere, including CI where
 * no API keys exist.
 */
const BASE_URL = process.env.DEPLOY_BASE_URL || 'http://127.0.0.1:8080';

export default defineConfig({
  testDir: './e2e-deploy',
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // A deployment check must be decisive: retrying a real outage until it passes
  // is how a red signal becomes a flake. One retry absorbs network noise only.
  retries: 1,
  workers: 4,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    ignoreHTTPSErrors: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
