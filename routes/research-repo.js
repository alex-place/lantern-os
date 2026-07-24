/**
 * routes/research-repo.js — Research Team: repo-memory endpoints.
 *
 *   GET  /api/research/repo/status  → truthful coverage (files known, grounded
 *                                     memories, per-language breakdown, last pass)
 *   POST /api/research/repo/learn   → run one bounded learning pass; body: { max }
 *
 * The pass appends grounded repo-knowledge into the ONE Convergence Memory
 * (src/convergence/repo_learn.py → MemoryStore). Plain-handler convention.
 */
const { getRepoLearnStatus, runRepoLearnPass } = require("../lib/repo-learn");

module.exports = async function researchRepoRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, repoRoot } = deps;

  if (url.pathname === "/api/research/repo/status" && req.method === "GET") {
    try {
      sendJson(res, getRepoLearnStatus(repoRoot), 200);
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  if (url.pathname === "/api/research/repo/learn" && req.method === "POST") {
    try {
      let max = 500;
      try {
        const body = await collectRequestBody(req);
        if (body) max = parseInt(JSON.parse(body).max, 10) || 500;
      } catch { /* empty/invalid body → default */ }
      const result = runRepoLearnPass(repoRoot, max);
      sendJson(res, result, 200);
    } catch (err) {
      sendJson(res, { ok: false, error: "repo_learn_failed", message: err.message }, 500);
    }
    return true;
  }

  return false;
};
