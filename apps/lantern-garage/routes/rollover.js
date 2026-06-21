"use strict";
/**
 * Rollover observability (#898): GET /api/rollover/status
 *
 * Computes the Keystone-vs-Claude landed-work share + escalation rate by streaming
 * the existing append-only JSONL (convergence records from #897 + the gate-tagged
 * leaderboard rows from #895) — no new persistent store. Every number is traceable
 * back to its source file (returned in `sources`), satisfying the External Reality
 * Rule for the dashboard. Read-only aggregation; not operator-gated.
 *
 * Query params:
 *   ?band=24h | 7d | 30d   restrict to the trailing window (default: all-time)
 */
const path = require("path");
const fsSync = require("fs");
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

module.exports = async function rolloverRoutes(req, res, url, deps) {
  const { sendJson, repoRoot } = deps;
  if (url.pathname === "/api/rollover/status" && req.method === "GET") {
    try {
      const band = url.searchParams.get("band") || "";
      const sinceTs = bandToSince(band);

      const records = readJsonl(path.join(repoRoot, RECORDS_REL));
      const share = readRolloverShare(records, { sinceTs });

      const lb = readJsonl(path.join(repoRoot, LEADERBOARD_REL));
      const lastStageRow = [...lb].reverse().find((r) => r && r.rollover_stage) || null;

      sendJson(res, {
        mode: process.env.KEYSTONE_ROLLOVER_MODE || "shadow",
        stage: lastStageRow ? lastStageRow.rollover_stage : null,
        lastGate: lastStageRow
          ? { ts: lastStageRow.ts, label: lastStageRow.label,
              accuracy: lastStageRow.accuracy, bytes_per_correct: lastStageRow.bytes_per_correct }
          : null,
        band: band || "all",
        landed: share.landed,
        keystone: { landed: share.keystoneLanded, share: share.keystoneShare, escalationRate: share.escalationRate },
        claude: { landed: share.claudeLanded },
        escalations: share.escalations,
        exhausted: share.exhausted,
        sources: { records: RECORDS_REL, leaderboard: LEADERBOARD_REL },
      });
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }
  return false;
};
