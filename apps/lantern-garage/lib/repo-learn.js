// Repo-learn bridge — the Research Team's repo-memory pass, surfaced for the
// orchestration dashboard. Drives src/convergence/repo_learn.py (which appends
// grounded repo-knowledge into the ONE Convergence Memory) and reports only what
// actually landed on disk. No fabricated coverage: if the manifest is empty it
// says 0.
"use strict";

const fs = require("fs");
const path = require("path");

const MANIFEST_REL = path.join("data", "research", "repo-learn-manifest.json");
const RECORDS_REL = path.join("data", "convergence-records.jsonl");

function readManifest(repoRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, MANIFEST_REL), "utf8"));
  } catch {
    return {};
  }
}

// Count grounded repo-knowledge records actually persisted to the trusted log.
function countRepoMemories(repoRoot) {
  try {
    const txt = fs.readFileSync(path.join(repoRoot, RECORDS_REL), "utf8");
    let n = 0;
    for (const line of txt.split("\n")) {
      if (line.includes('"source": "repo-learn"') || line.includes('"source":"repo-learn"')) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/** Truthful status read — manifest coverage + on-disk memory count. */
function getRepoLearnStatus(repoRoot) {
  const manifest = readManifest(repoRoot);
  const entries = Object.entries(manifest);
  const byLang = {};
  let lastLearned = null;
  for (const [rel, meta] of entries) {
    const ext = (rel.split(".").pop() || "?").toLowerCase();
    byLang[ext] = (byLang[ext] || 0) + 1;
    if (meta && meta.learned_at && (!lastLearned || meta.learned_at > lastLearned)) {
      lastLearned = meta.learned_at;
    }
  }
  return {
    ok: true,
    filesKnown: entries.length,
    memoriesGrounded: countRepoMemories(repoRoot),
    byLang,
    lastLearnedAt: lastLearned,
  };
}

/**
 * Run one learning pass (bounded). Returns the Python driver's JSON summary.
 * Synchronous spawn via safe-exec (shell-free); a pass over the whole repo is
 * ~1s, well under the route timeout.
 */
function runRepoLearnPass(repoRoot, maxFiles = 500) {
  const { safeExec } = require(path.join(repoRoot, "apps", "lantern-garage", "lib", "safe-exec"));
  const script = path.join("src", "convergence", "repo_learn.py");
  const out = safeExec(
    ["python", script, "--json", "--max", String(Math.max(1, Math.min(2000, maxFiles)))],
    { cwd: repoRoot, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }
  );
  return JSON.parse(out || "{}");
}

module.exports = { getRepoLearnStatus, runRepoLearnPass };
