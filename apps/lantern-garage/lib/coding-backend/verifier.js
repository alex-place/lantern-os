"use strict";

// verification-decides layer (#2174) — a VERIFIER, not a model vote, decides
// whether a proposed coding action may apply.
//
// The OSS-BASELINE audit found the blank space: every OSS verifier checks a
// model's *text*; none gates an agent's *action*. A council/arena without
// objective verification is theater. This composes two local checks over the
// held proposal (full file contents, not applied yet):
//
//   • entailment.patch-consistency — the stated diff is grounded in the actual
//     output (always on, dependency-free; a FAILURE is decisive).
//   • entailment.minicheck        — ~770M source-entailment model (optional,
//     runs local; a real score is decisive).
//   • tests-run                   — SWE-bench-style: actually run the repo's
//     tests against the proposal (opt-in / heavy; the result is decisive).
//
// The verdict is `{ passed, decisive, checks, evidence }` and is written to
// `receipt.test`, which the #2175 router already reads as the authoritative
// outcome ("verifier wins"). Discipline: `passed` is a boolean ONLY when a
// decisive check ran; otherwise it is null (undecisive) so a cheap always-on
// guard never fabricates a success/failure before the change is even resolved.
//
// Policy (apply-blocking) is configurable:
//   enforce  — block apply on a decisive failure   (opts.enforce ?? CODING_VERIFY_ENFORCE=1, default off)
//   runTests — run the heavy tests-run layer        (opts.runTests ?? CODING_VERIFY_TESTS=1,   default off)

const entailment = require("./verifiers/entailment");
const testsRun = require("./verifiers/tests-run");

function resolvePolicy(opts = {}) {
  const enforce = opts.enforce != null ? !!opts.enforce : process.env.CODING_VERIFY_ENFORCE === "1";
  const runTests = opts.runTests != null ? !!opts.runTests : process.env.CODING_VERIFY_TESTS === "1";
  return { enforce, runTests };
}

// Run the applicable checks over a held proposal. Returns the verdict object
// that goes into receipt.test. Never throws (each adapter degrades to skipped).
async function verifyProposal({ repoPath, files, task, taskType, patchPreview, backend } = {}, opts = {}) {
  const policy = resolvePolicy(opts);
  const checks = [];

  // (1) always-on, cheap, dependency-free guard
  checks.push(entailment.patchConsistency({ files, patchPreview }));

  // (2) optional entailment model — only when an endpoint is configured
  if (entailment.minicheckAvailable(opts)) {
    checks.push(await entailment.minicheck({ files, task, patchPreview }, opts));
  }

  // (3) opt-in real test execution (the SWE-bench-style, decisive layer)
  if (policy.runTests) {
    checks.push(await testsRun.runTests({ repoPath, files, task }, opts));
  }

  const ran = checks.filter((c) => !c.skipped);
  const hardFails = ran.filter((c) => c.passed === false);
  // A check counts toward a POSITIVE verdict only if it is decisive (real test
  // execution or a model score) — a passing cheap guard is not proof it works.
  const decisivePositives = ran.filter((c) => c.passed === true && c.decisive === true);

  let passed;
  let decisive;
  if (hardFails.length > 0) {
    passed = false; // any decisive-or-guard failure blocks
    decisive = true;
  } else if (decisivePositives.length > 0) {
    passed = true;
    decisive = true;
  } else {
    passed = null; // only cheap guards ran and all passed → not enough to claim success
    decisive = false;
  }

  return {
    passed,
    decisive,
    enforce: policy.enforce,
    backend: backend || null,
    taskType: taskType || null,
    ranAt: new Date().toISOString(),
    checks,
    evidence: {
      ran: ran.map((c) => c.name),
      skipped: checks.filter((c) => c.skipped).map((c) => ({ name: c.name, reason: c.reason })),
      failed: hardFails.map((c) => c.name),
    },
  };
}

// Would applying this proposal be BLOCKED by policy? True only for an enforced,
// decisive failure. Callers pass `overrideVerification` to apply anyway.
function isBlocked(verdict) {
  return !!(verdict && verdict.enforce && verdict.decisive && verdict.passed === false);
}

module.exports = { verifyProposal, resolvePolicy, isBlocked };
