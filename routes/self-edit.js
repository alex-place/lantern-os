/**
 * Self-Edit Routes — bounded coding operator for Dream Chat
 *
 * Endpoints:
 *   POST /api/self-edit/plan  → structured plan
 *   POST /api/self-edit/patch → diff preview (does not apply)
 *   POST /api/self-edit/apply → apply patch + run tests
 *   POST /api/self-edit/pr    → create branch, commit, push, open draft PR
 */

const {
  generatePlan,
  generatePatch,
  applyPatch,
  validateDiff,
  runTests,
  gitCreateBranch,
  gitCommit,
  gitPush,
  gitDiffStat,
  gitAddAll,
  gitCurrentBranch,
  openDraftPr,
  sanitizeBranchName,
  isPathSafe,
} = require("../lib/self-edit-engine");

module.exports = async function selfEditRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, repoRoot } = deps;

  // ── POST /api/self-edit/plan ──────────────────────────────────────────
  if (url.pathname === "/api/self-edit/plan" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw || "{}");
      const userRequest = String(body.request || "").trim();
      if (!userRequest) {
        sendJson(res, { error: "request_required" }, 400);
        return true;
      }
      const scopeFiles = Array.isArray(body.scopeFiles) ? body.scopeFiles : [];
      const history = Array.isArray(body.history) ? body.history : [];

      const plan = await generatePlan(repoRoot, userRequest, scopeFiles, history);
      sendJson(res, { ok: true, plan });
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  // ── POST /api/self-edit/patch ─────────────────────────────────────────
  if (url.pathname === "/api/self-edit/patch" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw || "{}");
      const plan = body.plan;
      if (!plan || !plan.summary) {
        sendJson(res, { error: "plan_required" }, 400);
        return true;
      }

      const { diffText, files } = await generatePatch(repoRoot, plan);
      sendJson(res, {
        ok: true,
        diffText,
        changedFiles: files.map((f) => f.newFile || f.oldFile).filter(Boolean),
        wouldCreate: files.filter((f) => f.oldFile === "/dev/null").map((f) => f.newFile),
        previewOnly: true,
      });
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  // ── POST /api/self-edit/apply ─────────────────────────────────────────
  if (url.pathname === "/api/self-edit/apply" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw || "{}");
      const diffText = String(body.diffText || "");
      const testCommands = Array.isArray(body.testsToRun) ? body.testsToRun : [];
      const dryRun = !!body.dryRun;

      if (!diffText) {
        sendJson(res, { error: "diffText_required" }, 400);
        return true;
      }

      // Validate diff (paths must be safe)
      const files = validateDiff(diffText, repoRoot);
      const changedFiles = files.map((f) => f.newFile || f.oldFile).filter(Boolean);

      if (dryRun) {
        sendJson(res, { ok: true, dryRun: true, changedFiles, wouldApply: true });
        return true;
      }

      const stats = applyPatch(repoRoot, diffText);
      const testResults = runTests(repoRoot, testCommands);
      const allTestsOk = testResults.every((r) => r.ok);

      sendJson(res, {
        ok: true,
        applied: stats,
        tests: testResults,
        allTestsOk,
        diffStat: gitDiffStat(repoRoot),
      });
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  // ── POST /api/self-edit/pr ──────────────────────────────────────────
  if (url.pathname === "/api/self-edit/pr" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw || "{}");
      const branchHint = String(body.branch || body.branchHint || "auto-change");
      const title = String(body.title || "").trim();
      const prBody = String(body.body || "").trim();
      const diffText = String(body.diffText || "");

      if (!title) {
        sendJson(res, { error: "title_required" }, 400);
        return true;
      }

      // Safety: never operate from master
      const currentBranch = gitCurrentBranch(repoRoot);
      if (currentBranch === "master") {
        sendJson(res, { error: "cannot_commit_on_master", hint: "Use a feature branch." }, 403);
        return true;
      }

      // If diffText provided, apply it first (idempotent if already applied)
      if (diffText) {
        validateDiff(diffText, repoRoot);
        applyPatch(repoRoot, diffText);
      }

      // Stage and commit
      gitAddAll(repoRoot);
      gitCommit(repoRoot, title);

      // Push HEAD to auto/ branch — no local rename needed
      const branch = sanitizeBranchName(branchHint);
      gitPush(repoRoot, branch);

      // Open draft PR
      let prUrl = null;
      let prError = null;
      try {
        prUrl = openDraftPr(repoRoot, branch, title, prBody);
      } catch (prErr) {
        prError = prErr.message;
      }

      sendJson(res, {
        ok: true,
        branch,
        pushed: true,
        prUrl,
        prError,
        diffStat: gitDiffStat(repoRoot),
      });
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  // ── GET /api/self-edit/status ───────────────────────────────────────────
  if (url.pathname === "/api/self-edit/status" && req.method === "GET") {
    try {
      const branch = gitCurrentBranch(repoRoot);
      const stat = gitDiffStat(repoRoot);
      sendJson(res, { ok: true, branch, diffStat: stat, isMaster: branch === "master" });
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  return false;
};
