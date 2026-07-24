// In-chat review actions for autowork draft PRs (#1503).
//
// Backs POST /api/convergence/pr-action. The autowork panel surfaces Approve / Rework /
// Discard once a run opens a draft PR; Approve and Discard land here (Rework just re-runs
// autowork client-side). Approve = mark ready + squash-merge; Discard = close + delete
// branch. Uses the `gh` CLI (same auth path as issue/PR creation elsewhere).
//
// The pure helpers (parsePrUrl / sanitizeRepo / cleanGhErr) are exported and unit-tested;
// runPrAction shells out to gh and is exercised live, not in CI.
const { execFile } = require("child_process");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_REPO = process.env.GH_REPO || "alex-place/lantern-os";

// owner/repo, conservative charset — rejects anything that isn't a plain slug pair.
function sanitizeRepo(repo) {
  const s = String(repo == null ? "" : repo).trim();
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s) ? s : "";
}

// Pull {repo, number} out of a github.com pull-request URL.
function parsePrUrl(u) {
  const m = String(u == null ? "" : u)
    .match(/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)/);
  return m ? { repo: m[1], number: parseInt(m[2], 10) } : null;
}

// Last meaningful line of gh stderr, length-capped for a chat bubble.
function cleanGhErr(stderr) {
  const lines = String(stderr == null ? "" : stderr)
    .split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 200) : "";
}

function gh(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile("gh", args, { cwd: REPO_ROOT, timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: stdout || "",
        stderr: stderr || "",
      }));
  });
}

// Resolve {repo, pr} from an explicit pair or a prUrl. Returns null if unusable.
function resolveTarget({ prUrl, repo, pr } = {}) {
  if (prUrl) {
    const parsed = parsePrUrl(prUrl);
    if (parsed) return { repo: parsed.repo, pr: parsed.number };
  }
  // Default the repo only when none was supplied; a supplied-but-invalid repo is
  // rejected rather than silently retargeted to the default.
  const provided = String(repo == null ? "" : repo).trim();
  const r = provided ? sanitizeRepo(provided) : DEFAULT_REPO;
  const n = parseInt(pr, 10);
  if (!r || !Number.isInteger(n) || n <= 0) return null;
  return { repo: r, pr: n };
}

async function runPrAction(target, action) {
  const t = resolveTarget(target);
  if (!t) return { ok: false, error: "bad_target" };
  const { repo, pr } = t;

  if (action === "approve") {
    // Best-effort: marking an already-ready PR ready is a harmless no-op error, so the
    // merge is the authoritative step.
    await gh(["pr", "ready", String(pr), "--repo", repo]);
    const m = await gh(["pr", "merge", String(pr), "--repo", repo, "--squash", "--delete-branch"]);
    if (m.code !== 0) return { ok: false, action, pr, error: cleanGhErr(m.stderr) || "merge_failed" };
    return { ok: true, action, pr, message: `PR #${pr} marked ready and squash-merged.` };
  }

  if (action === "discard") {
    const c = await gh(["pr", "close", String(pr), "--repo", repo, "--delete-branch",
      "--comment", "Discarded from chat review (#1503)."]);
    if (c.code !== 0) return { ok: false, action, pr, error: cleanGhErr(c.stderr) || "close_failed" };
    return { ok: true, action, pr, message: `PR #${pr} closed and branch deleted.` };
  }

  return { ok: false, error: "unknown_action" };
}

module.exports = { sanitizeRepo, parsePrUrl, cleanGhErr, resolveTarget, runPrAction, DEFAULT_REPO };
