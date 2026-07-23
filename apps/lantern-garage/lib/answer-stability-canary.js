"use strict";

/**
 * Answer-stability canary (#2859 item 2) — determinism as a MEASURED property.
 *
 * Re-ask K canonical questions on a cadence; on converged items expected
 * stability ≈ 1.0. The alarm condition is the M1 invariant in product form:
 * an answer that moved WITHOUT an evidence delta is drift — a new M3 canary
 * axis (feeds #2856). A change WITH an evidence delta is legitimate and
 * receipted (that is how answers are supposed to change).
 *
 * Pure comparison logic: the serve function and prior state are injected, so
 * this is unit-testable with no filesystem. The thin runner is
 * scripts/answer_stability_canary.js (cron-ready: nonzero exit on alarm).
 *
 * Per-question statuses:
 *   baseline          first sighting (or no prior state) — nothing to compare
 *   stable            covered, answer hash unchanged
 *   changed-evidence  answer changed AND the serving records changed (receipt)
 *   unstable          answer changed, records did NOT — ALARM (drift / serve bug)
 *   coverage-lost     previously served, now a miss — ALARM (fell back to RNG)
 *   coverage-gained   newly served (a question converged) — fine
 *   uncovered         miss now and before — not comparable
 */

const { serveFromLedger } = require("./ledger-serve");

/**
 * @param {object} args
 *   questions  string[]           the canonical question set
 *   priorRows  Array|null         the previous run's `rows` (by question key)
 *   serve      function(question) injected server (default: real serveFromLedger)
 *   ledgerFile string             passed to the default server
 *   now        function           ms clock (injectable)
 * @returns {{ ts, rows, comparable, stable, stability, alarms }}
 */
function runCanary({ questions = [], priorRows = null, serve = null, ledgerFile = undefined, now = () => Date.now() } = {}) {
  const serveFn = serve || ((q) => serveFromLedger(q, ledgerFile ? { file: ledgerFile } : {}));
  const prior = new Map((priorRows || []).map((r) => [r.key || r.question, r]));

  const rows = questions.map((question) => {
    const served = serveFn(question);
    const key = served ? served.key : require("./ledger-serve").normalizeQuestion(question);
    const row = {
      question,
      key,
      covered: !!served,
      answerHash: served ? served.answerHash : null,
      recordHash: served ? served.recordHash : null,
      recordCount: served ? served.provenance.recordCount : 0,
    };
    const p = prior.get(key);
    if (!p) row.status = row.covered ? "baseline" : "uncovered";
    else if (p.covered && !row.covered) row.status = "coverage-lost";
    else if (!p.covered && row.covered) row.status = "coverage-gained";
    else if (!p.covered && !row.covered) row.status = "uncovered";
    else if (p.answerHash === row.answerHash) row.status = "stable";
    else if (p.recordHash !== row.recordHash) row.status = "changed-evidence";
    else row.status = "unstable";
    return row;
  });

  const comparable = rows.filter((r) => r.status === "stable" || r.status === "unstable" || r.status === "changed-evidence" || r.status === "coverage-lost");
  const stable = rows.filter((r) => r.status === "stable");
  const alarms = rows.filter((r) => r.status === "unstable" || r.status === "coverage-lost");
  return {
    ts: new Date(now()).toISOString(),
    rows,
    comparable: comparable.length,
    stable: stable.length,
    // No comparable pairs (first run) is vacuous stability 1, not 0/0 panic.
    stability: comparable.length ? stable.length / comparable.length : 1,
    alarms,
  };
}

module.exports = { runCanary };
