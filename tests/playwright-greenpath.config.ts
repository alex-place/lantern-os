import { defineConfig, devices } from '@playwright/test';

/**
 * Greenpath release-gate E2E config (#2545) — boots the REAL lantern-garage server
 * and walks the full signup → paper-trade → chat → Pro journey for N demo accounts
 * (default 10). This is the release gate for the first-50 invite program: every
 * step must be green on every account. See docs/GREENPATH-GATE.md.
 *
 * Run from repo root:  npm run test:greenpath
 *   GREENPATH_ACCOUNTS=2 npm run test:greenpath   # smoke run with fewer accounts
 *
 * Environment notes (details in docs/GREENPATH-GATE.md):
 *   - RESEND_API_KEY + SMTP_* are force-blanked so signup uses the loopback
 *     devVerifyCode flow (the hard email gate stays exercised: register →
 *     enter emailed code → login).
 *     CAVEAT: a repo-root .env.local sets env with override:true at server boot,
 *     so a checkout whose .env.local configures a mailer will break step 1 — run the
 *     gate from a checkout without SMTP in .env.local.
 *   - Chat (step 5) needs a working LLM provider key in the host env.
 *   - Broker status (step 7) needs Alpaca paper server keys or an OAuth app.
 *   - LANTERN_CHAT_ONLY=1 skips market collectors/loops but keeps every route —
 *     the paper ledger, watchlist and demo endpoints are all file/sim-backed.
 */
const PORT = Number(process.env.GREENPATH_PORT || 4323);
const TOKEN = 'greenpath-e2e-test-token'; // must match e2e-greenpath/journey.helpers.js

export default defineConfig({
  testDir: './e2e-greenpath',
  timeout: 120_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Never retry: retries would double-spend the per-IP auth budget (40 writes/15min
  // in local-auth.js) and re-run paper trades; a gate run must be one clean pass.
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  globalSetup: './e2e-greenpath/global-setup.js',
  globalTeardown: './e2e-greenpath/write-report.js',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  metadata: { testAuthToken: TOKEN },
  webServer: {
    command: 'node apps/lantern-garage/server.js',
    cwd: '..', // config lives in tests/; run from repo root (data/ stores are cwd-relative)
    url: `http://127.0.0.1:${PORT}/api/health`,
    // Always a fresh server: the auth throttle maps are per-process, and a reused
    // server from another config would carry the wrong env (e.g. trading disabled).
    reuseExistingServer: false,
    timeout: 90_000,
    env: {
      // LANTERN_GARAGE_PORT (not PORT): PORT flips the server into cloud mode
      // (0.0.0.0 bind); the dev recipe is LANTERN_GARAGE_PORT + loopback host.
      LANTERN_GARAGE_PORT: String(PORT),
      LANTERN_GARAGE_HOST: '127.0.0.1',
      SESSION_SECRET: 'greenpath-loopback-only-secret',
      // Token-gated test auth: used ONLY for the staff upgrade call (simulating the
      // Free → Pro purchase via POST /api/accounts/role) and account cleanup. The
      // journey itself signs up + logs in as real local accounts.
      LANTERN_TEST_AUTH_TOKEN: TOKEN,
      // Force the loopback no-mailer signup path (devVerifyCode) even if the shell
      // env carries provider creds. mailerConfigured() is resend OR smtp, so BOTH
      // must be blanked — blanking SMTP alone leaves Resend live and the dev code
      // is (correctly) never returned, which fails s1 with a confusing "code missing".
      RESEND_API_KEY: '',
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      // Keep the boot quiet + hermetic: no market collectors/convergence loops
      // (routes stay mounted — the paper ledger/watchlist/demo are file-backed),
      // no MCP sidecar, no tunnel, no PR watcher, no autoscan.
      LANTERN_CHAT_ONLY: '1',
      LANTERN_MCP_SERVER: 'false',
      LANTERN_CLOUDFLARE_TUNNEL: 'false',
      PR_WATCHER_ENABLED: '0',
      TRADER_AUTOSCAN: '0',
    },
  },
});
