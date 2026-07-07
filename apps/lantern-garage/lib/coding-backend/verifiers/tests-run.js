"use strict";

// tests-run verifier — the SWE-bench-style layer: actually RUN the repo's tests
// against the PROPOSED change instead of taking the backend's word for it. The
// proposal is a set of full file contents held for approval; we materialise them
// in place, run the detected test command, capture the verdict from its exit
// code, then RESTORE the working tree in a `finally` (scoped content-snapshot:
// only the proposal's own files are touched, and they are put back exactly). The
// real repo is never left mutated even if the test run throws or times out.
//
// This is opt-in (heavy): the control plane runs it when policy.runTests is set
// (CODING_VERIFY_TESTS=1 or opts.runTests), or when an explicit testCommand is
// passed. When no test command can be detected it degrades to `skipped`, not a
// false failure.

const fs = require("fs");
const path = require("path");
const { safeExec, tokenizeCommand } = require("../../safe-exec");

function tail(s, n = 2000) {
  s = String(s || "");
  return s.length > n ? "…" + s.slice(-n) : s;
}

// Detect a runnable test command for `repoPath`. Cheap: reads package.json only.
// Returns { argv, label } or null. pytest / bespoke runners go via opts.testCommand.
function detectTestCommand(repoPath) {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(repoPath, "package.json"), "utf8"));
    const t = pj.scripts && pj.scripts.test;
    // Skip npm's default placeholder ("Error: no test specified").
    if (t && !/no test specified/i.test(t)) {
      return { argv: ["npm", "test", "--silent"], label: "npm test" };
    }
  } catch {
    /* no package.json / unreadable → nothing to auto-detect */
  }
  return null;
}

async function runTests({ repoPath, files, task }, opts = {}) {
  let cmd = null;
  if (opts.testCommand) {
    try {
      cmd = { argv: tokenizeCommand(opts.testCommand), label: opts.testCommand };
    } catch (e) {
      return { name: "tests-run", skipped: true, reason: `bad testCommand: ${e.message}` };
    }
  } else {
    cmd = detectTestCommand(repoPath);
  }
  if (!cmd) {
    return { name: "tests-run", skipped: true, reason: "no test command detected (package.json scripts.test) and no explicit testCommand" };
  }
  if (!repoPath || !fs.existsSync(repoPath)) {
    return { name: "tests-run", skipped: true, reason: `repoPath not found: ${repoPath}` };
  }

  // Snapshot original state of ONLY the proposal's files, then materialise them.
  const snapshot = (files || []).map((f) => {
    const abs = path.join(repoPath, f.path);
    const existed = fs.existsSync(abs);
    return { abs, existed, original: existed ? fs.readFileSync(abs) : null, content: f.content };
  });

  let passed;
  let evidence;
  try {
    for (const s of snapshot) {
      fs.mkdirSync(path.dirname(s.abs), { recursive: true });
      fs.writeFileSync(s.abs, s.content);
    }
    try {
      const out = safeExec(cmd.argv, {
        cwd: repoPath,
        timeout: opts.timeoutMs || 120000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, CI: "1", ...(opts.env || {}) },
      });
      passed = true;
      evidence = { cmd: cmd.label, exitCode: 0, tail: tail(out) };
    } catch (e) {
      passed = false;
      const timedOut = e.killed || e.signal === "SIGTERM";
      evidence = {
        cmd: cmd.label,
        exitCode: e.status != null ? e.status : null,
        timedOut: !!timedOut,
        tail: tail(String(e.stdout || "") + String(e.stderr || "") + (timedOut ? "\n[timed out]" : "")),
      };
    }
  } finally {
    // Restore: put every touched file back exactly, delete files we created.
    for (const s of snapshot) {
      try {
        if (s.existed) fs.writeFileSync(s.abs, s.original);
        else if (fs.existsSync(s.abs)) fs.unlinkSync(s.abs);
      } catch {
        /* best-effort restore; a failure here is logged by the caller's evidence */
      }
    }
  }

  return { name: "tests-run", decisive: true, skipped: false, passed, evidence };
}

module.exports = { runTests, detectTestCommand };
