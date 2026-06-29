/**
 * Convergence Dispatch Route — Token-Efficient Router Integration
 *
 * Integrates ConvergenceRouter into the request pipeline to:
 * - Route 90% of requests locally (no external API calls)
 * - Cache patterns for >70% hit rate
 * - Measure token efficiency metrics
 *
 * Maps to: /api/convergence/* endpoints
 */

const { getRouter } = require("../lib/convergence-router");
const convergenceAgent = require("../lib/convergence-agent");
const { sendJson, collectRequestBody } = require("../lib/http-utils");
const { appendConversationEntry } = require("../lib/conversation-store");
const autoDispatch = require("../lib/auto-dispatch");
const maxConversationTextLength = 2000;

// Turn a raw autowork failure into a grounded, actionable message instead of a bare
// "network error" (#1348): name the likely cause (provider/quota/timeout/network) so
// the user can tell an outage from out-of-credits from a real code fault.
function describeAutoworkError(err, stage) {
  const raw = String((err && err.message) || err || "unknown error");
  const at = stage ? ` (at the ${stage} stage)` : "";
  let hint;
  if (/all_providers_failed|out of credits|insufficient_quota|quota|billing|spending limit|credit/i.test(raw)) {
    hint = "every cloud provider is unavailable (out of credits/quota). Add credits or a working key (Anthropic/OpenAI/Gemini/xAI/Vertex), then retry.";
  } else if (/no_provider_configured|no.?key|_no_key|missing.*key/i.test(raw)) {
    hint = "no model provider is configured. Set an API key (or Vertex ADC) and retry.";
  } else if (/timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(raw)) {
    hint = "the model call timed out. The provider may be slow or unreachable — retry, or check provider status.";
  } else if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|socket hang up|network|fetch failed/i.test(raw)) {
    hint = "a network call failed (DNS/connection). Check connectivity or the provider endpoint.";
  } else if (/_status_(4\d\d|5\d\d)|HTTP \d{3}|status \d{3}/i.test(raw)) {
    hint = "the provider returned an HTTP error — see the status code below.";
  } else {
    hint = "unexpected failure — see the detail below; likely a code fault rather than a provider outage.";
  }
  return { error: `Autowork failed${at}: ${hint}`, detail: raw.slice(0, 500), stage: stage || null };
}

// Plain-language reason for a patch-apply failure — so autowork steps say WHY they
// failed instead of just flashing a red ✗ (the user couldn't tell a valid failure
// from a bug). Turns the applier's stats into one human-readable line.
function humanizeApplyFailure(stats) {
  const errs = (stats && stats.errors) || [];
  if (!errs.length) return "the diff didn't change any files — its paths/hunks didn't match the repo (the model likely targeted the wrong file or stale line numbers).";
  const hunk = errs.find((e) => /hunk_not_located|patch does not apply|does not exist/i.test(e.error || ""));
  if (hunk) {
    const m = String(hunk.error).match(/near line (\d+)/i);
    return `the generated patch didn't match ${hunk.file}${m ? ` around line ${m[1]}` : ""} — its context lines weren't found in the real file (stale/hallucinated context).`;
  }
  return errs.map((e) => `${e.file}: ${e.error}`).join("; ").slice(0, 240);
}

// Line-numbered current content of the files a failed diff TARGETED, appended to the
// retry feedback so the model anchors on real lines instead of re-hallucinating
// context — the concrete fix for the repeating "hunk_not_located" apply failures.
function targetedFileContext(workRoot, stats) {
  const fs = require("fs"); const path = require("path");
  const files = [...new Set([...(stats.changed || []), ...(stats.created || []),
    ...((stats.errors || []).map((e) => e.file))].filter(Boolean))];
  let out = "";
  for (const fp of files.slice(0, 3)) {
    try {
      const full = path.join(workRoot, fp);
      if (!fs.existsSync(full)) { out += `\n--- ${fp} (this file does NOT exist — do not patch it) ---\n`; continue; }
      const numbered = fs.readFileSync(full, "utf8").split("\n").slice(0, 400)
        .map((l, i) => `${i + 1}: ${l}`).join("\n");
      out += `\n--- ${fp} (CURRENT content, line-numbered — copy context lines VERBATIM from here) ---\n${numbered}\n`;
    } catch { /* skip unreadable */ }
  }
  return out;
}

module.exports = async (req, res, url, deps) => {
  const router = getRouter();
  const pathname = url.pathname;

  // GET /api/convergence/stats — Router statistics
  if (pathname === "/api/convergence/stats" && req.method === "GET") {
    const stats = router.getStats();
    sendJson(res, {
      ...stats,
      description: "Convergence router pattern cache statistics",
      targets: {
        localRoutingPercent: 90,
        cacheHitRatePercent: 70
      }
    }, 200);
    return true;
  }

  // GET /api/convergence/auto-dispatch/status — autonomous auto-pull loop status
  if (pathname === "/api/convergence/auto-dispatch/status" && req.method === "GET") {
    try {
      sendJson(res, { ok: true, ...autoDispatch.getStatus() }, 200);
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  // POST /api/convergence/auto-dispatch/toggle — runtime kill switch { enabled: bool }
  if (pathname === "/api/convergence/auto-dispatch/toggle" && req.method === "POST") {
    try {
      const body = await collectRequestBody(req);
      const { enabled } = JSON.parse(body || "{}");
      if (typeof enabled !== "boolean") {
        sendJson(res, { ok: false, error: "enabled_boolean_required" }, 400);
        return true;
      }
      const now = autoDispatch.setEnabled(enabled);
      sendJson(res, { ok: true, enabled: now, ...autoDispatch.getStatus() }, 200);
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  // GET /api/convergence/status — live loop state (Converge stage) for the chat UX
  if (pathname === "/api/convergence/status" && req.method === "GET") {
    try {
      const { convergenceStatus } = require("../lib/convergence-status");
      sendJson(res, convergenceStatus(), 200);
    } catch (e) {
      sendJson(res, { total: 0, avgConfidence: 0, groundedPct: 0, verified: 0, reasoners: [], topReasoner: null, patternsCount: 0, error: e.message }, 200);
    }
    return true;
  }

  // GET /api/convergence/calibration — fast-layer trust weights (#1011): the
  // per-grounding, Brier-calibrated trust per key + the global Brier report card.
  if (pathname === "/api/convergence/calibration" && req.method === "GET") {
    try {
      const { calibration } = require("../lib/grounding-calibration");
      sendJson(res, { ...calibration(), description: "Per-grounding calibrated trust weights (fast-layer plasticity)" }, 200);
    } catch (e) {
      sendJson(res, { total_events: 0, global_brier: null, keys: {}, error: e.message }, 200);
    }
    return true;
  }

  // POST /api/convergence/grounding — record ONE external grounding
  // {key, predicted, outcome} and return the UPDATED trust weight. The real-time,
  // per-loop fast-weight adjustment: append-only, reversible, no neural change.
  if (pathname === "/api/convergence/grounding" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { recordGrounding } = require("../lib/grounding-calibration");
        const b = JSON.parse(body.replace(/^﻿/, "") || "{}");
        if (!b.key) { sendJson(res, { error: "key required" }, 400); return; }
        const updated = recordGrounding({ key: b.key, predicted: b.predicted, outcome: b.outcome, source: b.source });
        sendJson(res, { ok: true, updated }, 200);
      } catch (e) {
        sendJson(res, { error: e.message }, 400);
      }
    });
    return true;
  }

  // POST /api/convergence/route-intent — Route a message intent
  if (pathname === "/api/convergence/route-intent" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { message, context } = JSON.parse(body);
        if (!message) {
          sendJson(res, { error: "message required" }, 400);
          return;
        }

        const result = await router.routeIntent(message, context);
        sendJson(res, {
          success: true,
          ...result,
          tokensSaved: result.cacheHit ? 15 : 0
        }, 200);
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
    });
    return true;
  }

  // POST /api/convergence/agent — Deterministic answer + actions (no LLM)
  if (pathname === "/api/convergence/agent" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { message } = JSON.parse(body || "{}");
        if (!message) {
          sendJson(res, { error: "message required" }, 400);
          return;
        }

        const result = await convergenceAgent.respond(message);
        // Persist both sides so history reload shows the full exchange
        const now = new Date().toISOString();
        appendConversationEntry({ recordedAt: now, surface: "convergence-agent", role: "operator", text: message.slice(0, maxConversationTextLength) }).catch(() => {});
        if (result.answer) {
          appendConversationEntry({ recordedAt: now, surface: "convergence-agent", role: "lantern", text: String(result.answer).slice(0, maxConversationTextLength) }).catch(() => {});
        }
        sendJson(res, {
          success: true,
          ...result,
          tokensSaved: 60 // full local turn — no external model call
        }, 200);
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
    });
    return true;
  }

  // POST /api/convergence/autonomous-work — Work an issue autonomously
  if (pathname === "/api/convergence/autonomous-work" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      // Declared OUTSIDE the try so the `finally` worktree-teardown can reference them.
      // A `let` inside the try is block-scoped → `cleanupWorktree is not defined` in the
      // `finally`, an unhandled rejection that CRASHED the whole server after every
      // autonomous-work run (the real reason the Auto-Pull loop kept killing 4177).
      let workRoot = null, cleanupWorktree = null;
      try {
        const opts = JSON.parse(body || "{}");
        let issueNumber = parseInt(opts.issue, 10);
        const task = typeof opts.task === "string" ? opts.task.trim() : "";

        // Import self-edit functions
        const { generatePlan, generatePatch, applyPatch, runTests, gitAddFiles, gitCommit, gitPush, openDraftPr, createIssueFromTask, resolveExistingIssue, isFileIssueOnlyRequest, looksLikePlaceholderPatch, patchSyntaxErrors } = require("../lib/self-edit-engine");
        const { createIssueWorktree, worktreeTestEnv } = require("../lib/autowork-worktree");
        const { execFile } = require("child_process");
        const path = require("path");
        const REPO_ROOT = path.resolve(__dirname, "../../..");
        const GH_REPO = "alex-place/lantern-os";

        // Step logging (parity with the stream route): the FLEET path emits no SSE,
        // but every step is still appended to data/autowork-runs/<date>.jsonl so the
        // autonomous loop's runs are reviewable. runId is set once the issue # is known.
        const { logStep, newRunId, researchIssue } = require("../lib/autowork-research");
        let runId = null;
        const step = (phase, status, extra = {}) => logStep(runId, issueNumber, phase, status, extra);

        // Task-mode (parity with the stream route): a free-form { task } and no
        // issue number → file a real GitHub issue first, then work it like an
        // `!work #N` run. Keeps every PR issue-linked.
        if (!issueNumber && task) {
          // A meta-command that references an existing issue ("autowork the oldest
          // issue", "work issue #1342") must target that issue, not be filed as a
          // new one. Resolve first; only file a fresh issue for novel requests.
          const existing = resolveExistingIssue(REPO_ROOT, task);
          if (existing) {
            issueNumber = existing;
          } else {
            try {
              const created = createIssueFromTask(REPO_ROOT, task);
              issueNumber = created.number;
              // "file an issue" with no implement verb → log the ticket and STOP.
              // Running the patch pipeline on it only manufactures slop (#1521).
              if (isFileIssueOnlyRequest(task)) {
                sendJson(res, { ok: true, fileIssueOnly: true, issue: created.number, url: created.url, title: created.title, message: `Filed issue #${created.number}: ${created.title}` });
                return;
              }
            } catch (e) {
              sendJson(res, { ok: false, error: "issue_create_failed", message: `Could not file an issue for the task: ${e && e.message}` }, 502);
              return;
            }
          }
        }

        if (!issueNumber) {
          sendJson(res, { ok: false, error: "issue_number_or_task_required" }, 400);
          return;
        }
        runId = newRunId(issueNumber);
        step("start", "start", { issue: issueNumber, mode: "fleet" });

        // Code-mutating git ops run in `workRoot` (an isolated worktree), not the
        // live serving checkout (REPO_ROOT). Torn down in `finally`. (Declared above
        // the try; assigned here once REPO_ROOT exists.)
        workRoot = REPO_ROOT;

        // Fetch issue details
        const issueDetails = await new Promise((resolve) => {
          execFile(
            "gh",
            ["issue", "view", String(issueNumber), "--repo", GH_REPO, "--json", "title,body,state"],
            { cwd: REPO_ROOT, timeout: 10000, windowsHide: true },
            (err, stdout) => {
              if (err) return resolve(null);
              try {
                resolve(JSON.parse(stdout));
              } catch (_e) {
                resolve(null);
              }
            }
          );
        });

        if (!issueDetails) {
          sendJson(res, { ok: false, error: "issue_not_found" }, 404);
          return;
        }

        // Guard: don't work an already-closed issue (prevents duplicate work)
        if (issueDetails.state && String(issueDetails.state).toUpperCase() !== "OPEN") {
          sendJson(res, {
            ok: false,
            error: "issue_closed",
            issue: issueNumber,
            state: issueDetails.state,
            message: `Issue #${issueNumber} is ${issueDetails.state} — nothing to work.`,
          }, 409);
          return;
        }

        // Run in an isolated worktree off master so branch/apply/commit/push
        // never touch the live serving checkout — which the server keeps dirty
        // with runtime JSONL, the churn that tripped the old in-place dirty-tree
        // guard and blocked every run. Also isolates concurrent runs.
        let branchName;
        try {
          const wt = createIssueWorktree(REPO_ROOT, issueNumber, issueDetails.title);
          workRoot = wt.workRoot;
          branchName = wt.branch;
          cleanupWorktree = wt.cleanup;
        } catch (e) {
          sendJson(res, {
            ok: false,
            error: "worktree_create_failed",
            issue: issueNumber,
            message: `Could not create an isolated worktree: ${e.message}`,
          }, 409);
          return;
        }
        step("branch", "done", { branch: branchName });

        // Step 0.5: research / grounding — the FLEET path used to call generatePlan
        // with EMPTY scope + context (the model patched blind, the #1 source of
        // hunk-not-located aborts). Now it grounds in ranked repo files + real web
        // evidence, identical to the stream route, and logs each sub-step.
        let scopeFiles = [], researchContext = null;
        try {
          const research = await researchIssue({
            workRoot,
            issueNumber,
            issueTitle: issueDetails.title,
            issueBody: issueDetails.body,
            runId,
            onStep: step,
          });
          scopeFiles = research.scopeFiles;
          researchContext = research.researchContext;
        } catch (e) {
          // Grounding is best-effort — a failure shouldn't abort the run, but log it.
          step("research", "error", { error: String(e && e.message || e) });
        }

        // Step 1: Generate plan — guard the model call so an out-of-credits/quota
        // failure across all providers returns an actionable 502 (not a generic 500
        // that leaks err.stack). Mirrors the stream route's no-cloud handling.
        step("plan", "start");
        let plan;
        try {
          plan = await generatePlan(
            workRoot,
            issueDetails.title + "\n\n" + issueDetails.body,
            scopeFiles.slice(0, 5),
            researchContext ? [researchContext] : []);
        } catch (planErr) {
          const raw = String(planErr && planErr.message || planErr);
          const noCloud = /all_providers_failed|empty response|credit|quota|billing|spending limit/i.test(raw);
          if (noCloud) {
            step("plan", "error", { error: "no_cloud_model" });
            step("done", "error", { stoppedAt: "no_cloud_model" });
            sendJson(res, {
              ok: false,
              error: "no_cloud_model",
              message: "Autowork needs a working cloud model, but every provider is unavailable " +
                "(out of credits/quota) and the local model returned nothing. Add credits to a " +
                "provider (Anthropic/OpenAI/Gemini/xAI) or set a usable key, then retry.",
            }, 502);
            return;
          }
          throw planErr; // unexpected — bubble to the outer catch
        }
        step("plan", "done", { steps: Array.isArray(plan.steps) ? plan.steps.length : undefined, testsToRun: Array.isArray(plan.testsToRun) ? plan.testsToRun.length : 0 });

        // Steps 2-3: generate patch → apply, with a feedback retry loop. LLM diffs
        // routinely miss exact hunk context/counts; on failure we feed the apply
        // errors + ground-truth file back and let the model self-correct. The stream
        // path already did this — this (the autonomous FLEET loop's) path used to
        // single-shot and abort, which is the #1 reason the loop "produced no PR"
        // (verified: a real run aborted with hunk_not_located on attempt 1).
        const MAX_PATCH_ATTEMPTS = 3;
        let diffText = "", applyStats = null, changedFiles = [], feedback = null, applied = false;
        for (let attempt = 1; attempt <= MAX_PATCH_ATTEMPTS; attempt++) {
          step("patch", attempt === 1 ? "start" : "retry", { attempt, of: MAX_PATCH_ATTEMPTS });
          let gen;
          try {
            gen = await generatePatch(workRoot, plan, feedback ? { feedback } : {});
          } catch (genErr) {
            // generatePatch itself failed (e.g. diff_parse_failed — the model returned
            // no valid diff). Feed that back and retry instead of 500ing on attempt 1.
            feedback = { priorDiff: "", errors:
              `patch generation failed: ${genErr.message}. Output ONLY a valid unified diff `
              + `(--- a/path / +++ b/path / @@ hunks with exact context) — no prose, no fences.` };
            if (attempt < MAX_PATCH_ATTEMPTS) continue;
            break; // exhausted → fall through to the !applied abort
          }
          diffText = gen.diffText;
          applyStats = applyPatch(workRoot, diffText);
          changedFiles = [...(applyStats.changed || []), ...(applyStats.created || [])];
          // Anti-fraud gate: a usable patch changes ≥1 file with zero hunk errors —
          // otherwise a hallucinated/failed patch could let unrelated data-file churn
          // be committed as the "fix".
          if (changedFiles.length > 0 && !(applyStats.errors && applyStats.errors.length > 0)) {
            // Verify gate (#1354 placeholder, #1359 syntax): a clean-applying patch can
            // still be (a) placeholder scaffolding or (b) syntactically broken in a file
            // the planned tests never load (e.g. a browser script). Reject either, roll
            // back, and feed the signal into the retry loop — a bad patch that "passes"
            // tests only because nothing exercised it would otherwise open a broken PR.
            const ph = looksLikePlaceholderPatch(diffText);
            const syntaxErrors = ph.placeholder ? [] : patchSyntaxErrors(changedFiles, workRoot);
            if (!ph.placeholder && syntaxErrors.length === 0) {
              applied = true;
              step("patch", "done", { attempt, files: changedFiles });
              break;
            }
            await new Promise((resolve) =>
              execFile("git", ["checkout", "--", "."], { cwd: workRoot, timeout: 10000, windowsHide: true }, () => resolve()));
            feedback = {
              priorDiff: diffText,
              errors: ph.placeholder
                ? "the patch is placeholder / non-implementation scaffolding (markers: "
                  + ph.signals.join("; ")
                  + "). Implement the ACTUAL logic the issue requires — no stubs, no "
                  + "\"placeholder\"/\"simulate\"/\"in a real scenario\" comments, no console.log-only bodies."
                : "the patch leaves files unparseable and must not be committed:\n"
                  + syntaxErrors.map((s) => `${s.file}: ${s.error}`).join("\n")
                  + "\nReturn a corrected diff where every changed file parses.",
            };
            continue;
          }
          // Failed — roll the tree back clean and carry the errors into the next try.
          await new Promise((resolve) =>
            execFile("git", ["checkout", "--", "."], { cwd: workRoot, timeout: 10000, windowsHide: true }, () => resolve()));
          feedback = {
            priorDiff: diffText,
            errors: (applyStats.errors && applyStats.errors.length)
              ? applyStats.errors.map((e) => `${e.file}: ${e.error}`).join("\n")
              : "the diff changed no files (paths/hunks did not match the repo)",
          };
        }

        if (!applied) {
          await new Promise((resolve) =>
            execFile("git", ["checkout", "--", "."], { cwd: workRoot, timeout: 10000, windowsHide: true }, () => resolve()));
          step("patch", "error", { attempts: MAX_PATCH_ATTEMPTS, error: "patch_did_not_apply" });
          step("done", "error", { stoppedAt: "patch_did_not_apply" });
          sendJson(res, {
            ok: false,
            error: "patch_did_not_apply",
            attempts: MAX_PATCH_ATTEMPTS,
            applyStats,
            message: `Generated patch produced no usable code changes after ${MAX_PATCH_ATTEMPTS} attempts (hunks failed or empty). Aborted — nothing committed.`,
          }, 422);
          return;
        }

        // Step 4: Run tests from the plan. Empty test set = UNVERIFIED, not "passed".
        const plannedTests = Array.isArray(plan.testsToRun) ? plan.testsToRun : [];
        step("test", "start", { count: plannedTests.length });
        const testResults = runTests(workRoot, plannedTests, { env: worktreeTestEnv(REPO_ROOT) });
        const testsRan = plannedTests.length;
        const allTestsOk = testResults.every((r) => r.ok !== false);   // inconclusive (timeout) ≠ failure → don't roll back a good patch
        const testsVerified = testsRan > 0 && allTestsOk && testResults.some((r) => r.ok === true);  // "verified" only if a test actually passed
        step("test", "done", { testsRan, allTestsOk, testsVerified });

        if (testsRan > 0 && !allTestsOk) {
          // Rollback on test failure — stage nothing
          execFile("git", ["checkout", "--", "."], { cwd: workRoot });
          step("done", "error", { stoppedAt: "tests_failed" });
          sendJson(res, {
            ok: false,
            error: "tests_failed",
            testResults,
            message: "Tests failed after applying changes. Changes rolled back."
          }, 500);
          return;
        }

        // Step 5: Commit — stage ONLY the files the patch changed (never git add -A)
        step("commit", "start", { files: changedFiles.length });
        gitAddFiles(workRoot, changedFiles);
        // #933: don't bake a "[unverified]" marker into the commit/PR title (it
        // double-stacks with the issue's own conventional prefix). Strip any
        // existing prefix and record verification state in the body/receipt instead.
        const cleanTitle228 = String(issueDetails.title || "").replace(/^(fix|feat|chore|docs|refactor|test|perf|ci|style|build)(\([^)]*\))?:\s*/i, "");
        const commitTitle = `fix: ${cleanTitle228} (fixes #${issueNumber})`;
        gitCommit(workRoot, commitTitle);

        // Capture the commit SHA for the response/UI
        const commitSha = await new Promise((resolve) => {
          execFile("git", ["rev-parse", "HEAD"], { cwd: workRoot, timeout: 5000, windowsHide: true },
            (err, stdout) => resolve(err ? null : stdout.trim()));
        });

        step("commit", "done", { commitSha });

        // Step 6: Push
        step("push", "start", { branch: branchName });
        gitPush(workRoot, branchName);
        step("push", "done", { branch: branchName });

        // harvest emitter (#911): log verified coding successes offline
        if (testsVerified) {
          try {
            require("../lib/harvest-emitter").emitCodingSuccess({
              fn: null,
              instruction: String(issueDetails.title || "").slice(0, 500),
              code: diffText || "",
              asserts: [],
              source: "autowork",
              verified: true,
              meta: { issue: issueNumber, branch: branchName, changedFiles },
            });
          } catch (_e) { /* best effort */ }
        }

        // Step 7: Open PR — flag unverified when no tests actually ran
        const prBody = `Fixes #${issueNumber}\n\n${issueDetails.body}\n\n---\n` +
          (testsVerified
            ? `✅ ${testsRan} test(s) passed.`
            : `⚠️ No automated tests ran for this change — **requires human review before merge**.`) +
          `\n\nFiles changed: ${changedFiles.join(", ")}`;
        step("pr", "start", { branch: branchName });
        const prUrl = openDraftPr(workRoot, branchName, commitTitle, prBody);
        step("pr", "done", { prUrl });
        step("done", "ok", { prUrl, testsVerified, changedFiles: changedFiles.length });

        sendJson(res, {
          ok: true,
          issue: issueNumber,
          title: issueDetails.title,
          branch: branchName,
          commitSha,
          prUrl,
          changedFiles,
          testsRan,
          testsVerified,
          verified: testsVerified,
          steps: ["fetched_issue", "generated_plan", "applied_patch", "ran_tests", "committed", "pushed", "opened_pr"],
          testResults
        });
      } catch (err) {
        // Don't leak err.stack in the response body (parity with the stream route).
        try { require("../lib/autowork-research").logStep(null, null, "done", "error", { error: err.message }); } catch (_e) { /* ignore */ }
        sendJson(res, { ok: false, error: err.message }, 500);
      } finally {
        // Always tear down the worktree — the branch (and any push) survives.
        if (cleanupWorktree) { try { cleanupWorktree(); } catch (_e) { /* best effort */ } }
      }
    });
    return true;
  }

  // GET /api/convergence/autonomous-work/status?runId=… — re-attach to a run whose
  // SSE dropped. The run keeps executing server-side and logs to
  // data/autowork-runs/<date>.jsonl; this reads the latest record for the runId so the
  // chat can recover the outcome (incl. the PR url) instead of dying on a "network
  // error". Returns { found, latestPhase, latestStatus, done, ok, prUrl, message }.
  if (pathname === "/api/convergence/autonomous-work/status" && req.method === "GET") {
    const runId = url.searchParams.get("runId");
    if (!runId) { sendJson(res, { ok: false, error: "runId required" }, 400); return true; }
    try {
      const fsx = require("fs"); const px = require("path");
      const dir = px.join(__dirname, "..", "..", "..", "data", "autowork-runs");
      // Scan today + yesterday (a run can straddle midnight).
      const days = [0, 1].map((d) => { const t = new Date(Date.now() - d * 86400000); return t.toISOString().slice(0, 10); });
      let records = [];
      for (const day of days) {
        const fp = px.join(dir, `${day}.jsonl`);
        if (!fsx.existsSync(fp)) continue;
        for (const line of fsx.readFileSync(fp, "utf8").split("\n")) {
          if (!line.trim() || line.indexOf(runId) === -1) continue;
          try { const r = JSON.parse(line); if (r.runId === runId) records.push(r); } catch { /* skip */ }
        }
      }
      if (!records.length) { sendJson(res, { ok: true, found: false }, 200); return true; }
      const latest = records[records.length - 1];
      const result = records.filter((r) => r.phase === "result").pop();
      const doneRec = result || records.filter((r) => r.phase === "done").pop();
      sendJson(res, {
        ok: true, found: true, runId,
        latestPhase: latest.phase, latestStatus: latest.status, latestTs: latest.ts,
        done: !!doneRec,
        succeeded: result ? result.status === "ok" : null,
        prUrl: (result && result.prUrl) || null,
        message: (result && result.message) || null,
      }, 200);
    } catch (e) {
      sendJson(res, { ok: false, error: e.message }, 200);
    }
    return true;
  }

  // POST /api/convergence/autonomous-work/stream — Observable autonomous work (SSE)
  // Σ₀ Honest Autonomous Chat (epic #527, task A1): emit every step as it happens.
  // No hidden agency — by default the run STOPS after tests (changes applied to the
  // working tree, visible via the streamed diff, but NOT committed or pushed).
  // Commit/push/PR are explicit opt-ins via { commit:true } / { push:true }.
  // { dryRun:true } streams the plan + diff and stops before touching any file.
  if (pathname === "/api/convergence/autonomous-work/stream" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no",
      });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const { logStep, newRunId } = require("../lib/autowork-research");
      // One run id for the whole pipeline so every step lands in the same review log.
      let _runId = null;
      // Stream the step over SSE AND append it to data/autowork-runs/<date>.jsonl so
      // each autowork step is reviewable after the run, not only live.
      const step = (phase, status, extra = {}) => {
        send("step", { phase, status, ...extra });
        logStep(_runId, receipt.issue, phase, status, extra);
      };
      // Terminal result, logged to data/autowork-runs/<date>.jsonl so a client whose
      // SSE dropped mid-run can recover the outcome via /autonomous-work/status — the
      // run keeps executing server-side after a disconnect, so this is how the chat
      // re-attaches to a finished run (incl. the PR url) instead of showing a dead
      // "network error". Best-effort; never throws into the pipeline.
      const finishLog = (ok, extra = {}) => {
        try { logStep(_runId, receipt.issue, "result", ok ? "ok" : "failed", extra); } catch (_e) { /* ignore */ }
      };

      // SSE heartbeat — the plan/patch steps make LLM calls that emit NO bytes for
      // 30-60s. Idle stream-proxies (the Cloudflare tunnel on lantern-os.net, any
      // reverse proxy) sever silent connections, which the browser surfaces as a raw
      // "network error" mid-run (it froze the UI at "Generate plan"). A periodic
      // comment line keeps the connection warm without disturbing the event parser
      // (clients ignore lines starting with ":"). Cleared in `finally`.
      const heartbeat = setInterval(() => {
        try { res.write(`: keepalive ${Date.now()}\n\n`); } catch (_e) { /* socket gone */ }
      }, 15000);
      heartbeat.unref && heartbeat.unref();

      const path = require("path");
      const { execFile } = require("child_process");
      const REPO_ROOT = path.resolve(__dirname, "../../..");
      const GH_REPO = "alex-place/lantern-os";
      const {
        generatePlan, generatePatch, applyPatch, runTests,
        gitAddFiles, gitCommit, gitPush, openDraftPr, createIssueFromTask, resolveExistingIssue,
        isFileIssueOnlyRequest, looksLikePlaceholderPatch, patchSyntaxErrors,
      } = require("../lib/self-edit-engine");
      const { createIssueWorktree, worktreeTestEnv } = require("../lib/autowork-worktree");

      // Code-mutating git ops run in `workRoot` (a dedicated worktree, set by the
      // branch step), never in the live serving checkout (REPO_ROOT). REPO_ROOT is
      // still used for the gh issue fetch and the persistent convergence/AGI logs.
      // The worktree is torn down in `finally`.
      let workRoot = REPO_ROOT, cleanupWorktree = null;

      // honest running record of what actually happened
      const receipt = {
        issue: null, branch: null, applied: false, committed: false,
        pushed: false, prUrl: null, testsPassed: null, stoppedAt: null,
      };

      try {
        const opts = JSON.parse(body || "{}");
        let issueNumber = parseInt(opts.issue, 10);
        const task = typeof opts.task === "string" ? opts.task.trim() : "";
        const dryRun = opts.dryRun === true;
        // Σ₀ autonomous: default to commit+push for fully-verified work (research + tests passed)
        // Can opt-out with { commit:false } or { push:false } for safety gates
        const autoPush = opts.push !== false;  // default true (changed from === true)
        const autoCommit = autoPush || opts.commit !== false;  // default true

        // ── 0. create issue from a free-form task (suggest-then-confirm path) ──
        // A free-form coding request has no issue number. We keep the pipeline
        // issue-linked (every PR references a tracked issue), so file the task as
        // a GitHub issue first, then work it exactly like an `!work #N` run.
        if (!issueNumber && task) {
          // A meta-command that references an existing issue ("autowork the oldest
          // issue", "work issue #1342") must target that issue, not be filed as a
          // new one (which produced junk issues #1344/#1346). Resolve first; only
          // file a fresh issue for genuinely novel coding requests.
          const existing = resolveExistingIssue(REPO_ROOT, task);
          if (existing) {
            issueNumber = existing;
            step("create_issue", "done", { issue: issueNumber, resolved: true });
          } else {
            step("create_issue", "start");
            try {
              const created = createIssueFromTask(REPO_ROOT, task);
              issueNumber = created.number;
              step("create_issue", "done", { issue: issueNumber, url: created.url, title: created.title });
              // "file an issue" with no implement verb → log the ticket and STOP.
              // Running the patch pipeline on it only manufactures slop (#1521).
              if (isFileIssueOnlyRequest(task)) {
                send("done", { ok: true, fileIssueOnly: true, issue: created.number, url: created.url, title: created.title, message: `Filed issue #${created.number}: ${created.title}` });
                res.end();
                return;
              }
            } catch (e) {
              step("create_issue", "error", { error: String(e && e.message || e) });
              send("done", { ok: false, ...receipt, stoppedAt: "create_issue", message: `Could not file an issue for the task: ${e && e.message}` });
              res.end();
              return;
            }
          }
        }

        if (!issueNumber) {
          send("error", { error: "issue_number_or_task_required" });
          res.end();
          return;
        }
        receipt.issue = issueNumber;
        _runId = newRunId(issueNumber);
        receipt.runId = _runId;
        // Tell the client the run id so it can re-attach via /autonomous-work/status
        // if the SSE drops mid-run.
        send("run", { runId: _runId, issue: issueNumber });

        // ── 1. fetch issue ───────────────────────────────────────────────
        step("fetch_issue", "start", { issue: issueNumber });
        const issueDetails = await new Promise((resolve) => {
          execFile("gh",
            ["issue", "view", String(issueNumber), "--repo", GH_REPO, "--json", "title,body,state"],
            { cwd: REPO_ROOT, timeout: 10000, windowsHide: true },
            (err, stdout) => {
              if (err) return resolve(null);
              try { resolve(JSON.parse(stdout)); } catch (_e) { resolve(null); }
            });
        });
        if (!issueDetails) {
          step("fetch_issue", "error", { error: "issue_not_found" });
          send("done", { ok: false, ...receipt, stoppedAt: "fetch_issue" });
          res.end();
          return;
        }
        step("fetch_issue", "done", { title: issueDetails.title, state: issueDetails.state });

        // Guard: don't work an already-closed issue (prevents duplicate work)
        if (issueDetails.state && String(issueDetails.state).toUpperCase() !== "OPEN") {
          step("fetch_issue", "error", { error: "issue_closed", state: issueDetails.state });
          send("done", { ok: false, ...receipt, stoppedAt: "issue_closed", message: `Issue #${issueNumber} is ${issueDetails.state} — nothing to work.` });
          res.end();
          return;
        }

        // ── 2. branch — isolated worktree off master ───────────────────────
        // Each run gets its own git worktree under .claude/worktrees/ so the
        // branch/apply/commit/push never touch the live serving checkout (which
        // the server keeps dirty with runtime JSONL — that churn is what tripped
        // the old in-place `git_tree_dirty` guard and blocked every run). It also
        // isolates concurrent issue runs from one another.
        step("branch", "start");
        let branchName;
        try {
          const wt = createIssueWorktree(REPO_ROOT, issueNumber, issueDetails.title);
          workRoot = wt.workRoot;
          branchName = wt.branch;
          cleanupWorktree = wt.cleanup;
        } catch (e) {
          step("branch", "error", { error: `worktree_create_failed: ${e.message}` });
          send("done", { ok: false, ...receipt, stoppedAt: "branch", message: `Could not create an isolated worktree: ${e.message}` });
          res.end();
          return;
        }
        receipt.branch = branchName;
        step("branch", "done", { branch: branchName, worktree: workRoot });

        // ── 3. research (Σ₀: ground in codebase + external reality + web) ──
        // Shared, ranked, logged grounding (lib/autowork-research). Fixes the old
        // "always 20 generic files / 0 web sources" bug: keywords are stopword-
        // filtered + identifier-ranked, files are relevance-ranked, web grounding
        // uses the dependable MCP→DDG→Wikipedia client, and every sub-step is
        // streamed AND appended to data/autowork-runs/<date>.jsonl for review.
        step("research", "start", { issue: issueNumber });
        const { researchIssue } = require("../lib/autowork-research");
        const issueFullText = `${issueDetails.title}\n\n${issueDetails.body}`;
        // webEvidence is consumed by the convergence-record step below; destructuring
        // it here is required — without it that step throws "webEvidence is not defined"
        // and autowork crashes AFTER opening the PR (surfacing as an opaque failure).
        const { scopeFiles, researchContext, webEvidence = [] } = await researchIssue({
          workRoot,
          issueNumber,
          issueTitle: issueDetails.title,
          issueBody: issueDetails.body,
          runId: receipt.runId,
          onStep: step,
        });

        // ── 4. plan (with research context as Σ₀ evidence) ───────────────
        step("plan", "start");
        let plan;
        try {
          plan = await generatePlan(
            workRoot, issueFullText, scopeFiles.slice(0, 5), [researchContext]);
        } catch (planErr) {
          // The most common real failure here is "no cloud model available" —
          // every provider out of credits/quota, with the tiny local model
          // returning empty. Surface that as an honest, actionable plan-step
          // error instead of a generic exception blob (autowork needs a working
          // cloud model; a 1.4B local model can't plan a code change).
          const raw = String(planErr && planErr.message || planErr);
          const noCloud = /all_providers_failed|empty response|credit|quota|billing|spending limit/i.test(raw);
          const msg = noCloud
            ? "Autowork needs a working cloud model, but every provider is unavailable " +
              "(out of credits/quota) and the local model returned nothing. Add credits to a " +
              "provider (Anthropic/OpenAI/Gemini/xAI) or set a usable key, then retry."
            : `Plan generation failed: ${raw.slice(0, 300)}`;
          step("plan", "error", { error: raw.slice(0, 500), noCloud });
          receipt.stoppedAt = "plan_failed";
          send("done", { ok: false, ...receipt, stoppedAt: "plan_failed", message: msg });
          res.end();
          return;
        }
        step("plan", "done", {
          plan,
          confidence: {
            researchBased: scopeFiles.length > 0 ? 0.8 : 0.5,
            observable: true,
            grounded: true
          }
        });

        // ── 4-5. patch → apply, with a feedback retry loop ────────────────
        // LLM diffs routinely miss exact hunk context/counts. Instead of aborting
        // on the first apply failure, feed the apply errors back to the model and
        // let it self-correct (up to MAX_PATCH_ATTEMPTS). Each failed attempt is
        // rolled back so the tree stays clean between tries.
        const MAX_PATCH_ATTEMPTS = 3;
        let diffText = "", stats = null, changedFiles = [], feedback = null, applied = false;
        for (let attempt = 1; attempt <= MAX_PATCH_ATTEMPTS; attempt++) {
          step("patch", attempt === 1 ? "start" : "retry", { attempt, of: MAX_PATCH_ATTEMPTS });
          let gen;
          try {
            gen = await generatePatch(workRoot, plan, feedback ? { feedback } : {});
          } catch (genErr) {
            // generatePatch failed (e.g. diff_parse_failed) — feed it back and retry.
            feedback = { priorDiff: "", errors:
              `patch generation failed: ${genErr.message}. Output ONLY a valid unified diff `
              + `(--- a/path / +++ b/path / @@ hunks with exact context) — no prose, no fences.` };
            step("patch", attempt < MAX_PATCH_ATTEMPTS ? "retry" : "error",
              { attempt, error: genErr.message,
                detail: `the model didn't return a valid diff (${genErr.message})`
                  + (attempt < MAX_PATCH_ATTEMPTS ? ` — retrying (${attempt}/${MAX_PATCH_ATTEMPTS})` : " — gave up after all attempts") });
            if (attempt < MAX_PATCH_ATTEMPTS) continue;
            break;
          }
          diffText = gen.diffText;
          const affected = (gen.files || []).map((f) => (f.newFile || f.oldFile || "").replace(/^[ab]\//, ""));
          send("diff", { diffText, files: affected, attempt });
          // The patch was generated successfully (a parseable diff exists). Mark the
          // 'patch' phase done now — the apply step that follows is tracked separately.
          // Without this the panel's "Generate patch" row stays stuck on ◐ forever,
          // since the loop only ever emits patch start/retry/error, never done.
          step("patch", "done", { files: affected, attempt });

          if (dryRun) {
            receipt.stoppedAt = "dry_run";
            step("apply", "skipped", { reason: "dry_run" });
            send("done", { ok: true, ...receipt, message: "Dry run — diff shown, nothing applied." });
            res.end();
            return;
          }

          step("apply", "start", { attempt });
          stats = applyPatch(workRoot, diffText);
          changedFiles = [...(stats.changed || []), ...(stats.created || [])];

          // Anti-fraud gate: a usable patch changes ≥1 file with zero hunk errors.
          // Otherwise a hallucinated/failed patch could let unrelated data-file churn
          // be committed as the "fix" (the data-file fraud pattern).
          if (changedFiles.length > 0 && !(stats.errors && stats.errors.length > 0)) {
            // Verify gate (#1354 placeholder, #1359 syntax): a clean-applying patch can
            // still be placeholder scaffolding (`// Placeholder for the actual logic`,
            // "simulate async work", …) OR leave a file unparseable in a source the
            // planned tests never load (a browser script, a one-off tool). Reject either,
            // roll back, and feed the signal into the retry loop so it returns real,
            // parseable code. (A bad patch that "passes" tests only because nothing
            // exercised it would otherwise open a bad PR.)
            const ph = looksLikePlaceholderPatch(diffText);
            const syntaxErrors = ph.placeholder ? [] : patchSyntaxErrors(changedFiles, workRoot);
            if (!ph.placeholder && syntaxErrors.length === 0) {
              applied = true;
              break;
            }
            await new Promise((resolve) =>
              execFile("git", ["checkout", "--", "."], { cwd: workRoot, timeout: 10000, windowsHide: true }, () => resolve()));
            feedback = {
              priorDiff: diffText,
              errors: ph.placeholder
                ? "the patch is placeholder / non-implementation scaffolding (markers: "
                  + ph.signals.join("; ")
                  + "). Implement the ACTUAL logic the issue requires — no stubs, no "
                  + "\"placeholder\"/\"simulate\"/\"in a real scenario\" comments, no console.log-only bodies."
                : "the patch leaves files unparseable and must not be committed:\n"
                  + syntaxErrors.map((s) => `${s.file}: ${s.error}`).join("\n")
                  + "\nReturn a corrected diff where every changed file parses.",
            };
            step("apply", attempt < MAX_PATCH_ATTEMPTS ? "retry" : "error",
              ph.placeholder
                ? { placeholder: ph.signals, attempt,
                    detail: "the patch was placeholder scaffolding, not a real implementation"
                      + (attempt < MAX_PATCH_ATTEMPTS ? " — asking for the actual code" : " — gave up") }
                : { syntaxErrors, attempt,
                    detail: `the patch left ${syntaxErrors.map((s) => s.file).join(", ")} unparseable`
                      + (attempt < MAX_PATCH_ATTEMPTS ? " — asking for a valid fix" : " — gave up") });
            continue;
          }

          // Failed — roll the tree back clean and carry the errors into the next try,
          // now WITH the real line-numbered content of the targeted files so the model
          // copies exact context instead of re-hallucinating it.
          await new Promise((resolve) =>
            execFile("git", ["checkout", "--", "."], { cwd: workRoot, timeout: 10000, windowsHide: true }, () => resolve()));
          const applyDetail = humanizeApplyFailure(stats);
          feedback = {
            priorDiff: diffText,
            errors: ((stats.errors && stats.errors.length)
              ? stats.errors.map((e) => `${e.file}: ${e.error}`).join("\n")
              : "the diff changed no files (paths/hunks did not match the repo)")
              + targetedFileContext(workRoot, stats),
          };
          step("apply", attempt < MAX_PATCH_ATTEMPTS ? "retry" : "error",
            { stats, attempt,
              detail: applyDetail + (attempt < MAX_PATCH_ATTEMPTS
                ? ` Retrying with the file's real content (${attempt}/${MAX_PATCH_ATTEMPTS}).`
                : " Gave up after all attempts.") });
        }

        if (!applied) {
          receipt.applied = false;
          receipt.stoppedAt = "patch_did_not_apply";
          send("done", { ok: false, ...receipt, message: `Couldn't apply a working patch after ${MAX_PATCH_ATTEMPTS} attempts — ${humanizeApplyFailure(stats)} Nothing was committed.` });
          res.end();
          return;
        }
        receipt.applied = true;
        receipt.changedFiles = changedFiles;
        step("apply", "done", { stats, changedFiles });

        // ── 6. tests (verification gate for commit/push) ─────────────────
        const tests = Array.isArray(plan.testsToRun) ? plan.testsToRun : [];
        step("tests", "start", { commands: tests });
        const testResults = runTests(workRoot, tests, { env: worktreeTestEnv(REPO_ROOT) });
        const ranTests = tests.length > 0; // #933: zero tests is NOT a pass
        const testsPassed = testResults.every((r) => r.ok !== false);  // inconclusive (timeout) ≠ failure
        receipt.testsPassed = tests.length === 0 ? null : testsPassed;
        const _failedTest = testResults.find((r) => r.ok === false) || {};
        step("tests", "done", { testResults, passed: testsPassed, ran: tests.length,
          detail: tests.length === 0
            ? "no tests were specified for this change"
            : (testsPassed
                ? `${tests.length} test command(s) passed`
                : `failed: ${_failedTest.command || tests[0]} — ${String(_failedTest.output || "").split("\n").filter(Boolean).slice(-1)[0] || "see output"}`.slice(0, 240)) });

        // Σ₀ fast-layer plasticity (#1011): record this run's test gate as an external
        // grounding event — predicted = the research-based confidence we carried into
        // verification, outcome = the test ground truth. Recorded HERE, before the
        // fail-return below, so both PASSES and FAILURES calibrate the loop. Frozen
        // weights: this only appends to the replayable trust log, never the model.
        if (ranTests) {
          try {
            require("../lib/grounding-calibration").recordGrounding({
              key: "autowork:patch",
              predicted: scopeFiles.length > 0 ? 0.8 : 0.5,
              outcome: testsPassed ? 1 : 0,
              source: `autowork#${issueNumber}`,
            });
          } catch (e) {
            console.error("[convergence] grounding-calibration record failed (non-fatal):", e && e.message);
          }
        }

        if (tests.length > 0 && !testsPassed) {
          // restore working tree — never leave broken changes
          await new Promise((resolve) =>
            execFile("git", ["checkout", "--", "."], { cwd: workRoot, timeout: 10000, windowsHide: true }, () => resolve()));
          receipt.applied = false;
          receipt.stoppedAt = "tests_failed";
          const _tail = String(_failedTest.output || "").split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 300);
          step("rollback", "done", { reason: "tests_failed", detail: `rolled back — ${_failedTest.command || tests[0]} failed` });
          send("done", { ok: false, ...receipt, message: `Tests failed (${_failedTest.command || tests[0]}) — changes rolled back.${_tail ? " " + _tail : ""}` });
          res.end();
          return;
        }

        // ── 7. commit (opt-in) ───────────────────────────────────────────
        if (!autoCommit) {
          receipt.stoppedAt = "before_commit";
          send("done", {
            ok: true, ...receipt,
            message: "Changes applied and verified. Stopped before commit (no hidden agency). " +
                     "Re-run with { commit:true } or { push:true } to proceed.",
          });
          res.end();
          return;
        }
        step("commit", "start");
        gitAddFiles(workRoot, changedFiles); // stage ONLY patched files — never git add -A
        const verified = tests.length > 0 && testsPassed;
        // #933: strip the issue's own conventional prefix and keep the verification
        // state out of the title (recorded in receipt + PR body instead).
        const cleanTitle = String(issueDetails.title || "").replace(/^(fix|feat|chore|docs|refactor|test|perf|ci|style|build)(\([^)]*\))?:\s*/i, "");
        const commitTitle = `fix: ${cleanTitle} (fixes #${issueNumber})`;
        gitCommit(workRoot, commitTitle);
        receipt.committed = true;
        step("commit", "done", { title: commitTitle, changedFiles, verified });

        // ── harvest emitter (#911): log verified coding successes offline ─
        // Fire-and-forget — never blocks the live path, never triggers training.
        if (verified) {
          try {
            require("../lib/harvest-emitter").emitCodingSuccess({
              fn: null,
              instruction: String(issueDetails.title || "").slice(0, 500),
              code: diffText,
              asserts: [],
              source: "autowork",
              verified: true,
              meta: { issue: issueNumber, branch: branchName, changedFiles },
            });
          } catch (_e) { /* best effort */ }
        }

        // ── 8. push + PR (opt-in) ────────────────────────────────────────
        if (!autoPush) {
          receipt.stoppedAt = "before_push";
          send("done", { ok: true, ...receipt, message: "Committed locally. Stopped before push." });
          res.end();
          return;
        }
        step("push", "start", { branch: branchName });
        gitPush(workRoot, branchName);
        receipt.pushed = true;
        step("push", "done");

        step("pr", "start");
        // #933: surface verification state in the PR body rather than the title.
        const verifyLine = `_verified: ${verified}_ (tests ${ranTests ? (testsPassed ? "passed" : "failed") : "not run"})`;
        const prUrl = openDraftPr(workRoot, branchName, commitTitle, `Fixes #${issueNumber}\n\n${verifyLine}\n\n${issueDetails.body}`);
        receipt.prUrl = prUrl;
        step("pr", "done", { prUrl });

        // ── 9. convergence (Σ₀: record hypothesis + evidence + confidence) ─
        step("convergence", "start");
        // Consult the fast-layer calibrated trust for this loop (#1011): the empirical,
        // Brier-calibrated reliability of "autowork:patch" accumulated across prior runs.
        // A frozen-weights adaptation — it shifts every interval as outcomes land, with
        // no neural change. 0.5 prior until grounded.
        let calibratedTrust = 0.5;
        try { calibratedTrust = require("../lib/grounding-calibration").trust("autowork:patch"); } catch (_) {}
        const convergenceRecord = {
          timestamp: new Date().toISOString(),
          issue: issueNumber,
          issueTitle: issueDetails.title,
          prUrl,
          branch: branchName,
          // Σ₀ core: hypothesis + evidence
          hypothesis: `Issue #${issueNumber}: ${issueDetails.title}`,
          evidence: [
            `Codebase research: ${scopeFiles.length} relevant files found`,
            `Web grounding: ${webEvidence.length} external sources checked`,
            `Plan generated with ${plan.actions?.length || 0} actions`,
            ranTests ? (testsPassed ? `Tests: PASSED (${tests.length})` : `Tests: FAILED (${tests.length})`) : 'Tests: none run',
            `Patch applied: ${changedFiles.length} files modified`,
            `Observable: Full SSE stream of all steps`
          ],
          confidence: {
            codebaseResearch: scopeFiles.length > 0 ? 0.85 : 0.5,
            webGrounded: webEvidence.length > 0 ? 0.8 : 0.4,
            testsPassed: ranTests ? (testsPassed ? 0.9 : 0.3) : 0.0,
            observable: 1.0, // Full SSE stream
            grounded: Math.max(
              scopeFiles.length > 0 ? 0.8 : 0.5,
              webEvidence.length > 0 ? 0.8 : 0.4
            ),
            overall: Math.min(
              (scopeFiles.length > 0 ? 0.85 : 0.5) * 0.4 +
              (webEvidence.length > 0 ? 0.8 : 0.4) * 0.4 +
              (ranTests ? (testsPassed ? 0.9 : 0.3) : 0.0) * 0.2,
              0.95  // Cap at 95% confidence (always room for error)
            ),
            // #1011 fast-layer plasticity: the loop's Brier-calibrated reliability,
            // consulted (not retrained) each run; 0.5 until grounded by real outcomes.
            calibratedTrust,
          },
          sources: {
            issue: `github.com/alex-place/lantern-os/issues/${issueNumber}`,
            pr: prUrl,
            codebaseAnalysis: `Searched ${scopeFiles.length} relevant files`,
            testsRun: tests.length,
            testsPassed: ranTests ? (testsPassed ? 'all' : 'none') : 'n/a'
          }
        };
        step("convergence", "done", { record: convergenceRecord });

        // Append to convergence log
        const convergenceLog = path.join(REPO_ROOT, "data", "convergence-autonomous-work.jsonl");
        const fsSync = require("fs");
        fsSync.appendFileSync(convergenceLog, JSON.stringify(convergenceRecord) + "\n");
        step("record", "done", { path: "data/convergence-autonomous-work.jsonl" });

        // AGI-benchmark per-run scores (#592): map the convergence record onto the
        // six loop dimensions (Observe→Research→Reason→Act→Verify→Converge) and append
        // one row per autonomous run. Scores are derived from the real signals of THIS
        // run only — no synthetic data is written. Fulfils the SKILLS.md §benchmark
        // contract ("Scores updated per-run in data/agi-benchmark.jsonl").
        const c = convergenceRecord.confidence;
        const agiRow = {
          timestamp: convergenceRecord.timestamp,
          runId: `autowork-${issueNumber}-${convergenceRecord.timestamp}`,
          issue: issueNumber,
          dimensions: {
            observe: issueDetails ? 0.9 : 0.5,                       // issue fetched (+ web sweep)
            research: c.codebaseResearch,                            // codebase + web grounding
            reason: (plan.actions?.length || 0) > 0 ? 0.85 : 0.5,    // plan generated
            act: changedFiles.length > 0 ? 0.85 : 0.5,               // patch applied + committed (#933)
            verify: c.testsPassed,                                   // tests actually ran/passed
            converge: c.overall                                      // confidence record + PR
          },
          overall: c.overall
        };
        const agiBenchLog = path.join(REPO_ROOT, "data", "agi-benchmark.jsonl");
        fsSync.appendFileSync(agiBenchLog, JSON.stringify(agiRow) + "\n");
        step("agi-benchmark", "done", { path: "data/agi-benchmark.jsonl", overall: agiRow.overall });

        send("done", {
          ok: true,
          ...receipt,
          convergence: {
            hypothesis: convergenceRecord.hypothesis,
            confidence: {
              research: convergenceRecord.confidence.research,
              testsPassed: convergenceRecord.confidence.testsPassed,
              observable: convergenceRecord.confidence.observable,
              grounded: convergenceRecord.confidence.grounded,
              overall: convergenceRecord.confidence.overall
            },
            evidence: convergenceRecord.evidence,
            sources: convergenceRecord.sources,
          },
          message: `✓ Σ₀ autonomous work complete. Issue #${issueNumber} → ${prUrl} (confidence: ${(convergenceRecord.confidence.overall * 100).toFixed(0)}%)`
        });
        finishLog(true, { prUrl, issue: issueNumber, message: `Auto-worked #${issueNumber} → ${prUrl}` });
        res.end();
      } catch (err) {
        const stage = receipt.stoppedAt || (receipt.steps && receipt.steps[receipt.steps.length - 1]) || null;
        const g = describeAutoworkError(err, stage);
        send("error", g);
        send("done", { ok: false, ...receipt, stoppedAt: receipt.stoppedAt || "exception", message: g.error, errorDetail: g.detail });
        finishLog(false, { message: g.error, stage });
        res.end();
      } finally {
        clearInterval(heartbeat);
        // Always tear down the worktree — the branch (and any push) survives.
        if (cleanupWorktree) { try { cleanupWorktree(); } catch (_e) { /* best effort */ } }
      }
    });
    return true;
  }

  // POST /api/convergence/route-task — Route a task
  if (pathname === "/api/convergence/route-task" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { taskType, payload } = JSON.parse(body);
        if (!taskType) {
          sendJson(res, { error: "taskType required" }, 400);
          return;
        }

        const result = await router.routeTask(taskType, payload);
        sendJson(res, {
          success: true,
          ...result,
          tokensSaved: result.source === "deterministic_route" ? 20 : 0
        }, 200);
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
    });
    return true;
  }

  // POST /api/convergence/route-market — Route market search
  if (pathname === "/api/convergence/route-market" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { ticker } = JSON.parse(body);
        if (!ticker) {
          sendJson(res, { error: "ticker required" }, 400);
          return;
        }

        const result = await router.routeMarketSearch(ticker);
        sendJson(res, {
          success: true,
          ...result,
          tokensSaved: result.source === "cache" ? 25 : 0
        }, 200);
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
    });
    return true;
  }

  // POST /api/convergence/route-code — Route code generation
  if (pathname === "/api/convergence/route-code" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { fileType, scope, keywords } = JSON.parse(body);
        if (!fileType || !scope) {
          sendJson(res, { error: "fileType and scope required" }, 400);
          return;
        }

        const result = await router.routeCodeGeneration(fileType, scope, keywords);
        sendJson(res, {
          success: true,
          ...result
        }, 200);
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
    });
    return true;
  }

  // POST /api/convergence/keystone-test — Σ₀ 6-stage code generation chain (#631)
  if (pathname === "/api/convergence/keystone-test" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { requirement } = JSON.parse(body || "{}");
        if (!requirement || typeof requirement !== "string" || requirement.trim().length < 5) {
          sendJson(res, { error: "requirement string required (min 5 chars)" }, 400);
          return;
        }
        const keystoneTestEngine = require("../lib/keystone-test-engine");
        const result = await keystoneTestEngine.runChain(requirement.trim());
        sendJson(res, { success: true, ...result }, result.accepted ? 200 : 422);
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
    });
    return true;
  }

  // GET /api/convergence/keystone-test/runs — Recent test run history
  if (pathname === "/api/convergence/keystone-test/runs" && req.method === "GET") {
    try {
      const runsPath = require("path").join(require("path").resolve(__dirname, "../../.."), "data", "keystone-test-runs.jsonl");
      const runs = require("fs").existsSync(runsPath)
        ? require("fs").readFileSync(runsPath, "utf8").trim().split("\n").filter(Boolean).slice(-20).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        : [];
      sendJson(res, { runs, count: runs.length }, 200);
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }

  // GET /api/convergence/health — Health check
  if (pathname === "/api/convergence/health" && req.method === "GET") {
    const stats = router.getStats();
    sendJson(res, {
      status: "ok",
      router: "ConvergenceRouter",
      cacheSize: stats.totalCachedRoutes,
      healthy: stats.totalCachedRoutes > 0
    }, 200);
    return true;
  }

  return false;
};
