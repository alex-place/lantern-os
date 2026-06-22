"use strict";
/**
 * Rollover observability (#898): GET /api/rollover/status
 *
 * Computes the Keystone-vs-Claude landed-work share + escalation rate from two sources:
 *   1. Convergence records (reasoner="keystone-kernel") — written by autowork when the
 *      kernel actually runs an issue.
 *   2. Git branch attribution — count merged PRs by branch prefix (claude/, auto/issue-*,
 *      gemini/, codex/) for the requested time band. This has real data immediately and
 *      satisfies the "traceable to JSONL/git" requirement.
 *
 * Every number is traceable to its source (returned in `sources`).
 * Read-only aggregation; not operator-gated.
 *
 * Query params:
 *   ?band=24h | 7d | 30d   restrict to the trailing window (default: 30d)
 */
const path = require("path");
const fsSync = require("fs");
const { execFile } = require("child_process");
const { readRolloverShare } = require("../lib/keystone-escalation");
const { RECORDS_REL } = require("../lib/convergence-records");

const LEADERBOARD_REL = "data/eval/leaderboard.jsonl";

function readJsonl(p) {
  try {
    return fsSync.readFileSync(p, "utf8")
      .split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function bandToSince(band) {
  const m = String(band || "").match(/^(\d+)([hd])$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const ms = m[2] === "h" ? n * 3_600_000 : n * 86_400_000;
  return Date.now() - ms;
}

function bandToGitArg(band) {
  const m = String(band || "").match(/^(\d+)([hd])$/);
  if (!m) return "30 days ago";
  const n = Number(m[1]);
  return m[2] === "h" ? `${n} hours ago` : `${n} days ago`;
}

/**
 * Read merged PR branch attribution from git log.
 * Returns counts per agent prefix: { claude, keystone, gemini, codex, grok, openai, human }.
 */
async function gitAttribution(repoRoot, since) {
  return new Promise((resolve) => {
    const args = [
      "log", "--merges",
      `--since=${since}`,
      "--format=%s|%D",
    ];
    execFile("git", args, { cwd: repoRoot, timeout: 5000 }, (err, stdout) => {
      if (err) { resolve({}); return; }
      const counts = { claude: 0, keystone: 0, gemini: 0, codex: 0, grok: 0, openai: 0, human: 0 };
      const total = { prCount: 0 };
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        const [msg = "", refs = ""] = line.split("|");
        // subject: "Merge pull request #N from user/prefix/branch-name"
        const branchMatch = msg.match(/from [^/]+\/([^/]+)\//);
        const branchPrefix = branchMatch ? branchMatch[1].toLowerCase() : "";
        // also check refs for "origin/claude/..." style
        const refPrefix = refs.split(",").map(r => {
          const m = r.trim().match(/(?:origin\/)?([^/]+)\//);
          return m ? m[1].toLowerCase() : "";
        }).find(Boolean) || "";
        const prefix = branchPrefix || refPrefix;
        total.prCount++;
        if (prefix === "claude") counts.claude++;
        else if (prefix === "auto") counts.keystone++;
        else if (prefix === "gemini") counts.gemini++;
        else if (prefix === "codex") counts.codex++;
        else if (prefix === "grok") counts.grok++;
        else if (prefix === "openai") counts.openai++;
        else counts.human++;
      }
      resolve({ ...counts, total: total.prCount });
    });
  });
}

module.exports = async function rolloverRoutes(req, res, url, deps) {
  const { sendJson, repoRoot } = deps;
  if (url.pathname === "/api/rollover/status" && req.method === "GET") {
    try {
      const band = url.searchParams.get("band") || "30d";
      const sinceTs = bandToSince(band);
      const gitSince = bandToGitArg(band);

      const records = readJsonl(path.join(repoRoot, RECORDS_REL));
      const share = readRolloverShare(records, { sinceTs });

      const lb = readJsonl(path.join(repoRoot, LEADERBOARD_REL));
      const lastStageRow = [...lb].reverse().find((r) => r && r.rollover_stage) || null;
      // Last leaderboard entry with accuracy, even if no rollover_stage tag yet
      const lastEvalRow = [...lb].reverse().find((r) => r && typeof r.accuracy === "number") || null;

      const git = await gitAttribution(repoRoot, gitSince);

      sendJson(res, {
        mode: process.env.KEYSTONE_ROLLOVER_MODE || "shadow",
        stage: lastStageRow ? lastStageRow.rollover_stage : null,
        lastGate: lastStageRow
          ? { ts: lastStageRow.ts, label: lastStageRow.label,
              accuracy: lastStageRow.accuracy, bytes_per_correct: lastStageRow.bytes_per_correct }
          : null,
        lastEval: lastEvalRow
          ? { ts: lastEvalRow.ts, label: lastEvalRow.label,
              accuracy: lastEvalRow.accuracy, pass1: lastEvalRow["pass@1"],
              benchmark: lastEvalRow.benchmark }
          : null,
        band: band || "30d",
        // Kernel attribution (from convergence records written by autowork)
        kernel: {
          landed: share.landed,
          keystoneLanded: share.keystoneLanded,
          claudeLanded: share.claudeLanded,
          keystoneShare: share.keystoneShare,
          escalationRate: share.escalationRate,
          escalations: share.escalations,
          exhausted: share.exhausted,
        },
        // Git attribution (from merged PR branch prefixes — always has real data)
        git: git,
        sources: { records: RECORDS_REL, leaderboard: LEADERBOARD_REL, git: "git log --merges" },
      });
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }
  return false;
};
