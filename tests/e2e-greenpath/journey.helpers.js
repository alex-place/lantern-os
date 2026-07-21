// @ts-check
/**
 * Shared plumbing for the greenpath release-gate harness (#2545).
 *
 * Every journey step records a {account, step, status, ms, detail} row into a
 * temp JSONL file as it runs; write-report.js (globalTeardown) folds those rows
 * into one run record appended to data/greenpath-runs.jsonl and prints the
 * per-account × per-step matrix. Steps that never ran (serial-mode skip after an
 * earlier failure) are filled in as "skipped" by the teardown.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep in sync with tests/playwright-greenpath.config.ts (webServer env + metadata).
const TOKEN = 'greenpath-e2e-test-token';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// Step rows accumulate OUTSIDE the repo tree (os.tmpdir is stable across the
// worker + teardown processes): a crashed run must never leave an untracked file
// for the main checkout's auto-commit loop to pick up. Keyed by port so parallel
// runs on different ports can't cross-contaminate.
const STEPS_TMP = path.join(os.tmpdir(),
  `greenpath-steps-${process.env.GREENPATH_PORT || 4323}.jsonl`);
const RUNS_FILE = path.join(REPO_ROOT, 'data', 'greenpath-runs.jsonl');

// The 9 journey steps from issue #2545, keyed by issue numbering. EXECUTION order
// differs (s6 runs before s4/s5): every /api/trading mutation is server-gated on
// the "trade" entitlement (Pro) today, so the Free account hits the upgrade gate
// (step 6) exactly when it first tries to trade — the harness verifies the gate
// there, performs the upgrade, then completes the trading steps as Pro.
const STEPS = {
  s1: 'signup (email+password, hard email gate)',
  s2: 'paper-trading account',
  s3: 'watchlist',
  s4: 'place a paper trade',
  s5: 'chat remembers the trade',
  s6: 'Free→Pro upgrade gate + upgrade',
  s7: 'connect test broker (Alpaca paper)',
  s8: 'BYOK provider keys (#2505)',
  s9: 'trade journal + tag',
};

/** Append one step-result row to the temp JSONL (read by write-report.js). */
function recordStep(account, stepKey, status, ms, detail) {
  const row = { account, step: stepKey, status, ms, detail: detail || '' };
  fs.mkdirSync(path.dirname(STEPS_TMP), { recursive: true });
  fs.appendFileSync(STEPS_TMP, JSON.stringify(row) + '\n');
}

function accountTag(n) {
  return 'a' + String(n).padStart(2, '0');
}

module.exports = { TOKEN, REPO_ROOT, STEPS_TMP, RUNS_FILE, STEPS, recordStep, accountTag };
