// @ts-check
/**
 * Greenpath globalTeardown — folds the per-step rows recorded during the run into
 * ONE run record appended to data/greenpath-runs.jsonl (the persisted pass/fail
 * report per account per step required by #2545), prints the matrix, and states
 * the gate verdict. The Playwright exit code is the machine-readable gate (any
 * red step fails the run); this file is the human/audit trail.
 */
const fs = require('fs');
const path = require('path');
const { STEPS_TMP, RUNS_FILE, STEPS, accountTag } = require('./journey.helpers');

module.exports = async (config) => {
  const accounts = Math.max(1, Number(process.env.GREENPATH_ACCOUNTS || 10));
  const runId = process.env.GREENPATH_RUN_ID || 'unknown';
  const t0 = Number(process.env.GREENPATH_RUN_T0 || Date.now());
  const baseURL = (config && config.projects && config.projects[0]?.use?.baseURL) || '';

  // Read recorded rows; a step can appear twice only if a spec bug re-records —
  // last write wins (matches "what actually happened last").
  const rows = [];
  try {
    for (const line of fs.readFileSync(STEPS_TMP, 'utf8').trim().split('\n')) {
      if (!line) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip corrupt row */ }
    }
  } catch { /* no rows at all — everything reports as skipped below */ }

  const stepKeys = Object.keys(STEPS);
  const matrix = {};
  for (let n = 1; n <= accounts; n++) {
    const tag = accountTag(n);
    matrix[tag] = {};
    for (const k of stepKeys) matrix[tag][k] = { status: 'skipped', ms: 0, detail: 'not reached' };
  }
  for (const r of rows) {
    if (matrix[r.account] && matrix[r.account][r.step]) {
      matrix[r.account][r.step] = { status: r.status, ms: r.ms, detail: r.detail };
    }
  }

  const failures = [];
  let passed = 0, failed = 0, skipped = 0, greenAccounts = 0;
  for (const tag of Object.keys(matrix)) {
    let allGreen = true;
    for (const k of stepKeys) {
      const s = matrix[tag][k];
      if (s.status === 'pass') passed++;
      else {
        allGreen = false;
        if (s.status === 'fail') { failed++; failures.push({ account: tag, step: k, detail: s.detail }); }
        else skipped++;
      }
    }
    if (allGreen) greenAccounts++;
  }
  const gate = greenAccounts === accounts ? 'GREEN' : 'RED';

  const record = {
    ts: new Date().toISOString(),
    runId,
    kind: 'greenpath-gate',
    issue: 2545,
    baseURL,
    accounts,
    durationMs: Date.now() - t0,
    gate,
    greenAccounts,
    totalSteps: accounts * stepKeys.length,
    passed, failed, skipped,
    steps: matrix,
    failures,
  };
  fs.mkdirSync(path.dirname(RUNS_FILE), { recursive: true });
  fs.appendFileSync(RUNS_FILE, JSON.stringify(record) + '\n');
  try { fs.unlinkSync(STEPS_TMP); } catch { /* already gone */ }

  // Human-readable matrix (console.* is the intended interface in tests/).
  const mark = (s) => (s === 'pass' ? ' ✓ ' : s === 'fail' ? ' ✗ ' : ' – ');
  console.log('\n━━━ Greenpath gate (#2545) — run ' + runId + ' ━━━');
  console.log('acct  ' + stepKeys.map((k) => k.padEnd(4)).join(''));
  for (const tag of Object.keys(matrix)) {
    console.log(tag.padEnd(6) + stepKeys.map((k) => mark(matrix[tag][k].status).padEnd(4)).join(''));
  }
  for (const f of failures) {
    console.log(`  ✗ ${f.account} ${f.step} (${STEPS[f.step]}): ${String(f.detail).slice(0, 200)}`);
  }
  console.log(`Gate: ${gate} — ${greenAccounts}/${accounts} accounts fully green, ` +
    `${passed} pass / ${failed} fail / ${skipped} skipped. Record → data/greenpath-runs.jsonl`);
  if (gate !== 'GREEN') {
    console.log('RED gate: do NOT invite the first-50 cohort until every step is green (docs/GREENPATH-GATE.md).');
  }
};
