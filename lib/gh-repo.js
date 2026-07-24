/**
 * Resolve the GitHub `owner/repo` the GitHub-facing tools should target (#2759).
 *
 * The GitHub tools used to hardcode `alex-place/lantern-os` as the fallback, so a
 * clone/fork with a different origin pointed its issue/PR lookups at the upstream
 * project instead of the user's own repo. Resolution order (first hit wins):
 *
 *   1. process.env.GH_REPO            — explicit operator/workspace override
 *   2. `git remote get-url origin`    — auto-detect owner/repo from the checkout
 *   3. DEFAULT_REPO                    — last-resort literal (this project's repo)
 *
 * The git probe runs once and is memoised; a repo can't change origin mid-process,
 * and the tools call this on every invocation.
 */

const { execFileSync } = require("child_process");
const path = require("path");

const DEFAULT_REPO = "alex-place/lantern-os";
const REPO_ROOT = path.resolve(__dirname, "..");

// Parse `owner/repo` out of any git remote URL form:
//   https://github.com/owner/repo.git
//   git@github.com:owner/repo.git
//   ssh://git@github.com/owner/repo
function parseOwnerRepo(remoteUrl) {
  const m = String(remoteUrl || "").match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

let _detected; // undefined = not probed yet, null = probed & unavailable

function detectFromGit() {
  if (_detected !== undefined) return _detected;
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    _detected = parseOwnerRepo(out.trim());
  } catch {
    _detected = null; // not a git checkout / no origin / git absent
  }
  return _detected;
}

/**
 * @returns {string} `owner/repo` for the GitHub tools to target.
 */
function resolveRepo() {
  const env = (process.env.GH_REPO || "").trim();
  if (env) return env;
  return detectFromGit() || DEFAULT_REPO;
}

module.exports = { resolveRepo, parseOwnerRepo, DEFAULT_REPO };
