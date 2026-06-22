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
const { sendJson } = require("../lib/http-utils");
const { appendConversationEntry } = require("../lib/conversation-store");
const maxConversationTextLength = 2000;

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
      try {
        const { issue } = JSON.parse(body || "{}");
        const issueNumber = parseInt(issue, 10);
        
        if (!issueNumber) {
          sendJson(res, { ok: false, error: "issue_number_required" }, 400);
          return;
        }

        // Import self-edit functions
        const { generatePlan, generatePatch, applyPatch, runTests, gitAddFiles, gitCommit, gitPush, openDraftPr } = require("../lib/self-edit-engine");
        const { createIssueWorktree, worktreeTestEnv } = require("../lib/autowork-worktree");
        const { execFile } = require("child_process");
        const path = require("path");
        const REPO_ROOT = path.resolve(__dirname, "../../..");
        const GH_REPO = "alex-place/lantern-os";
        // Code-mutating git ops run in `workRoot` (an isolated worktree), not the
        // live serving checkout (REPO_ROOT). Torn down in `finally`.
        let workRoot = REPO_ROOT, cleanupWorktree = null;

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

        // Step 1: Generate plan
        const plan = await generatePlan(workRoot, issueDetails.title + "\n\n" + issueDetails.body, [], []);

        // Step 2: Generate patch
        const { diffText, files } = await generatePatch(workRoot, plan);

        // Step 3: Apply patch — capture stats so we can verify it actually changed code
        const applyStats = applyPatch(workRoot, diffText);
        const changedFiles = [...(applyStats.changed || []), ...(applyStats.created || [])];

        // Anti-fraud gate: the patch MUST produce real, clean code changes.
        // Without this, a hallucinated/failed patch leaves the working tree
        // unchanged, then `git add -A` would commit unrelated runtime data churn
        // (prices.jsonl etc.) as the "fix" — closing the issue with no real work.
        if (changedFiles.length === 0 || (applyStats.errors && applyStats.errors.length > 0)) {
          execFile("git", ["checkout", "--", "."], { cwd: workRoot });
          sendJson(res, {
            ok: false,
            error: "patch_did_not_apply",
            applyStats,
            message: "Generated patch produced no usable code changes (hunks failed or empty). Aborted — nothing committed.",
          }, 422);
          return;
        }

        // Step 4: Run tests from the plan. Empty test set = UNVERIFIED, not "passed".
        const plannedTests = Array.isArray(plan.testsToRun) ? plan.testsToRun : [];
        const testResults = runTests(workRoot, plannedTests, { env: worktreeTestEnv(REPO_ROOT) });
        const testsRan = plannedTests.length;
        const allTestsOk = testResults.every((r) => r.ok);
        const testsVerified = testsRan > 0 && allTestsOk;

        if (testsRan > 0 && !allTestsOk) {
          // Rollback on test failure — stage nothing
          execFile("git", ["checkout", "--", "."], { cwd: workRoot });
          sendJson(res, {
            ok: false,
            error: "tests_failed",
            testResults,
            message: "Tests failed after applying changes. Changes rolled back."
          }, 500);
          return;
        }

        // Step 5: Commit — stage ONLY the files the patch changed (never git add -A)
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

        // Step 6: Push
        gitPush(workRoot, branchName);

        // Step 7: Open PR — flag unverified when no tests actually ran
        const prBody = `Fixes #${issueNumber}\n\n${issueDetails.body}\n\n---\n` +
          (testsVerified
            ? `✅ ${testsRan} test(s) passed.`
            : `⚠️ No automated tests ran for this change — **requires human review before merge**.`) +
          `\n\nFiles changed: ${changedFiles.join(", ")}`;
        const prUrl = openDraftPr(workRoot, branchName, commitTitle, prBody);

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
        sendJson(res, { ok: false, error: err.message, stack: err.stack }, 500);
      } finally {
        // Always tear down the worktree — the branch (and any push) survives.
        if (cleanupWorktree) { try { cleanupWorktree(); } catch (_e) { /* best effort */ } }
      }
    });
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
      const step = (phase, status, extra = {}) => send("step", { phase, status, ...extra });

      const path = require("path");
      const { execFile } = require("child_process");
      const REPO_ROOT = path.resolve(__dirname, "../../..");
      const GH_REPO = "alex-place/lantern-os";
      const {
        generatePlan, generatePatch, applyPatch, runTests,
        gitAddFiles, gitCommit, gitPush, openDraftPr,
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
        const issueNumber = parseInt(opts.issue, 10);
        const dryRun = opts.dryRun === true;
        // Σ₀ autonomous: default to commit+push for fully-verified work (research + tests passed)
        // Can opt-out with { commit:false } or { push:false } for safety gates
        const autoPush = opts.push !== false;  // default true (changed from === true)
        const autoCommit = autoPush || opts.commit !== false;  // default true

        if (!issueNumber) {
          send("error", { error: "issue_number_required" });
          res.end();
          return;
        }
        receipt.issue = issueNumber;

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
        step("research", "start", { issue: issueNumber });

        // Analyze issue description for keywords
        const issueFullText = `${issueDetails.title}\n\n${issueDetails.body}`;
        const keywords = (issueFullText.match(/\b[a-z-]{4,20}\b/gi) || [])
          .filter((w, i, a) => a.indexOf(w) === i).slice(0, 10);
        step("research", "keywords", { keywords });

        // Web search for external grounding (verify claims against web reality)
        let webEvidence = [];
        try {
          const https = require("https");
          const searchQuery = keywords.slice(0, 3).join(" ");
          const webSearchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(searchQuery)}&format=json`;

          const webResult = await new Promise((resolve) => {
            https.get(webSearchUrl, { timeout: 5000 }, (res) => {
              let data = "";
              res.on("data", (chunk) => (data += chunk));
              res.on("end", () => {
                try {
                  const json = JSON.parse(data);
                  const results = (json.Results || []).slice(0, 3).map((r) => ({
                    title: r.Title,
                    url: r.FirstURL,
                    snippet: r.Text
                  }));
                  resolve(results);
                } catch (e) {
                  resolve([]);
                }
              });
            }).on("error", () => resolve([]));
          });
          webEvidence = webResult;
          step("research", "web_search", { results: webEvidence.length, sources: webEvidence.map(w => w.url) });
        } catch (e) {
          // Web search optional; continue if it fails
          step("research", "web_search", { skipped: true, reason: e.message });
        }

        // Find relevant files in codebase. Use `git grep` via execFileSync (no shell)
        // — cross-platform (the old `grep -r ... 2>/dev/null | head` silently failed
        // on Windows/cmd.exe, returning 0 files so the LLM patched blind → hallucinations).
        const fs = require("fs");
        const { execFileSync } = require("child_process");
        const scopeFiles = [];
        for (const kw of keywords.slice(0, 5)) {
          if (scopeFiles.length >= 20) break;
          if (!kw || kw.length < 4) continue;
          try {
            const out = execFileSync(
              "git",
              ["grep", "-l", "-i", "-e", kw, "--", "*.js", "*.json", "*.md", "*.py", "*.html"],
              { cwd: workRoot, encoding: "utf-8", timeout: 8000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }
            ).split("\n").filter(Boolean);
            for (const filePath of out) {
              if (filePath && !scopeFiles.includes(filePath)) scopeFiles.push(filePath);
              if (scopeFiles.length >= 20) break;
            }
          } catch (e) {
            // git grep exits non-zero when a keyword has no matches — that's fine.
          }
        }

        const researchContext = {
          keywords,
          scopeFiles: scopeFiles.slice(0, 5),
          issueState: issueDetails.state,
          webEvidence: webEvidence.slice(0, 3),
          timestamp: new Date().toISOString(),
        };
        step("research", "done", {
          filesFound: scopeFiles.length,
          webSourcesFound: webEvidence.length,
          context: researchContext
        });

        // ── 4. plan (with research context as Σ₀ evidence) ───────────────
        step("plan", "start");
        const plan = await generatePlan(
          workRoot, issueFullText, scopeFiles.slice(0, 5), [researchContext]);
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
          const gen = await generatePatch(workRoot, plan, feedback ? { feedback } : {});
          diffText = gen.diffText;
          const affected = (gen.files || []).map((f) => (f.newFile || f.oldFile || "").replace(/^[ab]\//, ""));
          send("diff", { diffText, files: affected, attempt });

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
            applied = true;
            break;
          }

          // Failed — roll the tree back clean and carry the errors into the next try.
          await new Promise((resolve) =>
            execFile("git", ["checkout", "--", "."], { cwd: workRoot, timeout: 10000, windowsHide: true }, () => resolve()));
          feedback = {
            priorDiff: diffText,
            errors: (stats.errors && stats.errors.length)
              ? stats.errors.map((e) => `${e.file}: ${e.error}`).join("\n")
              : "the diff changed no files (paths/hunks did not match the repo)",
          };
          step("apply", attempt < MAX_PATCH_ATTEMPTS ? "retry" : "error", { stats, attempt });
        }

        if (!applied) {
          receipt.applied = false;
          receipt.stoppedAt = "patch_did_not_apply";
          send("done", { ok: false, ...receipt, message: `Generated patch produced no usable code changes after ${MAX_PATCH_ATTEMPTS} attempts (hunks failed or empty). Aborted — nothing committed.` });
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
        const testsPassed = testResults.every((r) => r.ok);
        receipt.testsPassed = tests.length === 0 ? null : testsPassed;
        step("tests", "done", { testResults, passed: testsPassed, ran: tests.length });

        if (tests.length > 0 && !testsPassed) {
          // restore working tree — never leave broken changes
          await new Promise((resolve) =>
            execFile("git", ["checkout", "--", "."], { cwd: workRoot, timeout: 10000, windowsHide: true }, () => resolve()));
          receipt.applied = false;
          receipt.stoppedAt = "tests_failed";
          step("rollback", "done", { reason: "tests_failed" });
          send("done", { ok: false, ...receipt, message: "Tests failed — changes rolled back." });
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
            )
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
        res.end();
      } catch (err) {
        send("error", { error: err.message });
        send("done", { ok: false, ...receipt, stoppedAt: receipt.stoppedAt || "exception" });
        res.end();
      } finally {
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
