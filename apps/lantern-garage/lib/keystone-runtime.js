/**
 * Keystone Kernel Mode — Claude Code Execution Loop
 *
 * Embedded execution engine inside Dream Chat.
 * File-grounded, tool-driven, patch-based workflow.
 *
 * Flow: GROUND → PLAN → ( PATCH → APPLY → VERIFY )↺ → DONE
 *
 * Staff-level contract:
 *   - "success" is returned ONLY when verification actually passes.
 *   - On a failed verification the loop feeds the failure back to the model
 *     and tries again, up to `maxAttempts`.
 *   - If it cannot land green, the working tree is reverted to its pre-run
 *     state (unless `keepOnFailure`), so it never leaves a broken repo.
 *   - Capability/model selection is the caller's job (inject `llm`); this
 *     runtime is model-agnostic so the performance leaderboard can route.
 */

const fs = require("fs").promises;
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);

const { searchRepoFiles, readFileContent } = require("./repo-context");
const { applyPatch, validatePatch, parsePatch, looksLikeSearchReplace, parseSearchReplace } = require("./patch-engine");
const { appendJsonlQueued } = require("./file-queue");

const KEYSTONE_SYSTEM_PROMPT = `You are Keystone Code Kernel inside Lantern OS.
You are a repository-first coding agent modeled after Claude Code.

RULES:
- Always inspect repository files before reasoning.
- Never rely on memory, CSF, or symbolic context.
- Treat filesystem as the only source of truth.
- Output actionable patches, not explanations.
- Prefer minimal diffs over large rewrites.
- Validate changes using available tools when possible.

You operate in a strict loop:
GROUND → PLAN → PATCH → VERIFY

No deviation is allowed.

When you produce code changes, output them as unified diffs.
When you need to create new files, clearly mark the filename and content.
Always verify your work by running tests or checks when relevant.`;

// Default safe pytest subset (mirrors CLAUDE.md) + JS suite.
const PYTEST_SAFE =
  "python -m pytest tests/ -q --tb=short " +
  "--ignore=tests/test_anti_entropy_memory.py " +
  "--ignore=tests/test_audit_chain.py " +
  "--ignore=tests/test_discord_bot.py " +
  "--ignore=tests/test_discord_voice_gate.py";
const JS_SUITE = "npm test --prefix apps/lantern-garage";

/**
 * Run the verification gate against the set of changed files.
 * Returns { ran, success, inconclusive, output, command }.
 * `inconclusive` means no applicable test command was found — which is NOT
 * a pass; the caller decides whether to allow unverified completion.
 */
async function defaultRunVerification(repo, changed, options = {}) {
  const paths = (changed || []).map((c) => c.path || "");
  const py =
    paths.some((p) => /\.py$/.test(p)) || paths.some((p) => /(^|\/)tests?\//.test(p));
  const js = paths.some((p) => /\.(c|m)?js$/.test(p));

  let cmd = options.testCmd || null;
  if (!cmd) {
    if (py) cmd = PYTEST_SAFE;
    else if (js) cmd = JS_SUITE;
  }
  if (!cmd) {
    return {
      ran: false,
      success: false,
      inconclusive: true,
      output: "No applicable test command for the changed files.",
      command: null,
    };
  }

  try {
    const r = await execAsync(cmd, {
      cwd: repo,
      timeout: options.testTimeoutMs || 120000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      ran: true,
      success: true,
      inconclusive: false,
      output: String(r.stdout || "").slice(-2000),
      command: cmd,
    };
  } catch (e) {
    const out = `${e.stdout || ""}\n${e.stderr || e.message || ""}`.slice(-2000);
    return { ran: true, success: false, inconclusive: false, output: out, command: cmd };
  }
}

/** Files a patch will touch (unified-diff targets + newfile blocks). */
function targetsOf(patchText) {
  const targets = new Set();
  try {
    for (const ch of parsePatch(patchText)) if (ch.file) targets.add(ch.file);
  } catch (_) {
    /* ignore parse errors — snapshot is best-effort */
  }
  if (typeof patchText === "string" && patchText.includes("newfile")) {
    for (const block of patchText.split(/(?=^newfile\n)/m)) {
      if (!block.trim().startsWith("newfile")) continue;
      const fp = block.split("\n").find((l) => l && !l.startsWith("newfile"));
      if (fp) targets.add(fp.trim());
    }
  }
  // SEARCH/REPLACE edits aren't unified diffs — pull their target files so the
  // pre-image snapshot (give-up revert) covers them too.
  if (looksLikeSearchReplace(patchText)) {
    try {
      for (const b of parseSearchReplace(patchText)) if (b.file) targets.add(b.file);
    } catch (_) {
      /* best-effort */
    }
  }
  return [...targets];
}

/** Capture pre-images of files a patch will touch (once each, before first apply). */
async function snapshotTargets(patchText, repo, snapshots) {
  for (const rel of targetsOf(patchText)) {
    if (snapshots.has(rel)) continue;
    const abs = path.join(repo, rel);
    try {
      const content = await fs.readFile(abs, "utf-8");
      snapshots.set(rel, { existed: true, content });
    } catch (_) {
      snapshots.set(rel, { existed: false });
    }
  }
}

/** Restore the working tree to the captured pre-images (revert a failed run). */
async function restoreSnapshots(snapshots, repo) {
  for (const [rel, snap] of snapshots) {
    const abs = path.join(repo, rel);
    try {
      if (snap.existed) await fs.writeFile(abs, snap.content, "utf-8");
      else await fs.unlink(abs).catch(() => {});
    } catch (_) {
      /* best-effort restore */
    }
  }
}

/** Ask the model for a patch — initial pass, or a correction given a failure. */
async function generatePatch(llm, ctx) {
  const { planPrompt, plan, patchPrompt, prior, failure } = ctx;
  const messages = [
    { role: "user", content: planPrompt },
    { role: "assistant", content: plan },
    { role: "user", content: patchPrompt },
  ];
  if (prior && failure) {
    messages.push({ role: "assistant", content: prior });
    messages.push({
      role: "user",
      content:
        `Your previous patch did not pass verification.\n\n` +
        `${failure.type === "apply" ? "The patch FAILED TO APPLY" : "Tests FAILED"}` +
        ` (command: ${failure.command || "n/a"}):\n---\n${
          failure.output || failure.error || "(no output)"
        }\n---\n\n` +
        `Produce a CORRECTED unified diff (and/or newfile blocks) that fixes this. ` +
        `Re-inspect the relevant files if needed. Output ONLY diffs/newfiles, no explanation.`,
    });
  }
  const resp = await llm({
    system: "Return ONLY unified diffs and file contents. No explanation or preamble.",
    messages,
  });
  return resp.content || resp;
}

async function keystoneRun(issue, repo, llm, options = {}) {
  const {
    verbose = false,
    maxFiles = 10,
    maxAttempts = 3,
    keepOnFailure = false,
    allowUnverified = false,
  } = options;
  // Injectable tools — defaults are the real ones; tests override these.
  const tools = {
    searchRepoFiles,
    readFileContent,
    applyPatch,
    validatePatch,
    runVerification: defaultRunVerification,
    ...(options.tools || {}),
  };
  const results = [];

  try {
    // PHASE 1: GROUND — Search and read relevant files
    log(verbose, "🔍 PHASE 1: GROUNDING");
    const searchResults = await tools.searchRepoFiles(issue, maxFiles);
    log(verbose, `Found ${searchResults.length} relevant files`);

    const files = [];
    for (const result of searchResults.slice(0, maxFiles)) {
      try {
        const content = await tools.readFileContent(result.path);
        files.push({ path: result.path, content, relevance: result.score });
        log(verbose, `  ✓ ${result.path}`);
      } catch (e) {
        log(verbose, `  ✗ ${result.path} (read error)`);
      }
    }

    if (files.length === 0) {
      return { status: "failed", error: "No relevant files found", phase: "grounding" };
    }

    results.push({
      phase: "ground",
      files: files.map((f) => ({ path: f.path, relevance: f.relevance })),
    });

    const groundingContext = files
      .map((f) => `\n=== ${f.path} ===\n${f.content.slice(0, 2000)}`)
      .join("\n");

    // PHASE 2: PLAN
    log(verbose, "📋 PHASE 2: PLANNING");
    const planPrompt = `
Issue: ${issue}

Repository context:
${groundingContext}

Analyze this issue. What files need to change? What is the minimal fix?
Output a clear, numbered plan. Be specific about line numbers and changes.`;

    const planResponse = await llm({
      system: KEYSTONE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: planPrompt }],
    });
    const plan = planResponse.content || planResponse;
    log(verbose, "Plan generated");
    results.push({ phase: "plan", plan });

    const patchPrompt = `
Based on your plan, generate the EXACT code changes needed.

For each file that changes, output a unified diff:
\`\`\`diff
--- a/path/to/file
+++ b/path/to/file
@@ -start,count +start,count @@
\`\`\`

For new files, output:
\`\`\`newfile
path/to/new/file
content goes here
\`\`\`

Output ONLY the diffs and new files. No explanation.`;

    // PHASES 3-5: PATCH → APPLY → VERIFY, with a relentless fix loop.
    const snapshots = new Map();
    let attempt = 0;
    let feedback = null; // failure carried into the next attempt
    let lastPatch = null;
    let lastApply = null;
    let lastVerify = null;
    let lastError = null;
    let lastPhase = "patch";

    while (attempt < maxAttempts) {
      attempt += 1;
      log(verbose, `🔁 ATTEMPT ${attempt}/${maxAttempts}`);

      // PATCH
      const patchText = await generatePatch(llm, {
        planPrompt,
        plan,
        patchPrompt,
        prior: lastPatch,
        failure: feedback,
      });
      lastPatch = patchText;
      const patchValidation = await tools.validatePatch(patchText);
      if (!patchValidation.valid && patchValidation.type !== "newfile") {
        lastError = `Invalid patch: ${patchValidation.error}`;
        lastPhase = "patch";
        feedback = { type: "apply", error: lastError };
        results.push({ phase: "attempt", attempt, patchValid: false, error: lastError });
        continue;
      }

      // APPLY (snapshot pre-images first so a give-up can revert cleanly)
      await snapshotTargets(patchText, repo, snapshots);
      const applyResult = await tools.applyPatch(patchText, repo);
      if (!applyResult.success) {
        lastError = applyResult.error;
        lastPhase = "apply";
        feedback = { type: "apply", error: applyResult.error };
        results.push({ phase: "attempt", attempt, applied: false, error: applyResult.error });
        continue;
      }
      lastApply = applyResult;

      // VERIFY
      const verify = await tools.runVerification(repo, applyResult.changed, options);
      lastVerify = verify;
      lastPhase = "verify";
      results.push({
        phase: "attempt",
        attempt,
        filesChanged: applyResult.filesChanged,
        verify: { ran: verify.ran, success: verify.success, inconclusive: verify.inconclusive },
      });

      if (verify.ran && verify.success) {
        log(verbose, `✅ Verified green on attempt ${attempt}`);
        const result = {
          status: "success",
          issue,
          plan,
          patch: lastPatch,
          applied: applyResult.changed,
          tests: { success: true, output: verify.output, command: verify.command },
          attempts: attempt,
          verified: true,
          fullResults: results,
        };
        emitConvergenceRecord({ issue, result, confidence: 0.95 }).catch(() => {});
        return result;
      }

      if (verify.inconclusive && allowUnverified) {
        log(verbose, "⚠ No applicable tests — completing unverified (allowed).");
        const result = {
          status: "applied_unverified",
          issue,
          plan,
          patch: lastPatch,
          applied: applyResult.changed,
          tests: { success: false, inconclusive: true, output: verify.output },
          attempts: attempt,
          verified: false,
          fullResults: results,
        };
        emitConvergenceRecord({ issue, result, confidence: 0.5 }).catch(() => {});
        return result;
      }

      // Not green — revert this attempt's changes before trying a fresh fix,
      // so each attempt starts from the same clean baseline.
      await restoreSnapshots(snapshots, repo);
      lastError = verify.inconclusive
        ? "No applicable tests found and unverified completion is not allowed."
        : "Verification failed.";
      feedback = { type: "verify", output: verify.output, command: verify.command };
      log(verbose, `❌ Attempt ${attempt} not green — ${lastError}`);
    }

    // Exhausted attempts without landing green.
    let reverted = false;
    if (!keepOnFailure) {
      await restoreSnapshots(snapshots, repo);
      reverted = true;
    }
    const result = {
      status: "verification_failed",
      issue,
      plan,
      patch: lastPatch,
      applied: keepOnFailure && lastApply ? lastApply.changed : [],
      tests: lastVerify
        ? { success: false, inconclusive: !!lastVerify.inconclusive, output: lastVerify.output }
        : null,
      error: `${lastError || "Could not verify changes"} (after ${attempt} attempt${
        attempt === 1 ? "" : "s"
      }${reverted ? "; working tree reverted" : ""})`,
      phase: lastPhase,
      attempts: attempt,
      verified: false,
      reverted,
      fullResults: results,
    };
    emitConvergenceRecord({ issue, result, confidence: 0.1 }).catch(() => {});
    return result;
  } catch (err) {
    return { status: "error", error: err.message, phase: "unknown", fullResults: results };
  }
}

async function emitConvergenceRecord({ issue, result, confidence }) {
  const record = {
    ts: new Date().toISOString(),
    source: "keystone-kernel",
    hypothesis: `Kernel run resolves issue: ${String(issue).slice(0, 200)}`,
    evidence: {
      status: result.status,
      verified: result.verified,
      attempts: result.attempts,
      applied: Array.isArray(result.applied) ? result.applied : [],
      test_output: result.tests?.output ? String(result.tests.output).slice(0, 500) : null,
    },
    result: result.status,
    confidence,
  };
  await appendJsonlQueued("data/convergence/records.jsonl", record);
}

function log(verbose, message) {
  // Diagnostics go to stderr so stdout / SSE token output stays clean.
  if (verbose) process.stderr.write(`[Keystone] ${message}\n`);
}

module.exports = {
  keystoneRun,
  KEYSTONE_SYSTEM_PROMPT,
  // exported for tests / reuse
  defaultRunVerification,
  targetsOf,
  snapshotTargets,
  restoreSnapshots,
};
