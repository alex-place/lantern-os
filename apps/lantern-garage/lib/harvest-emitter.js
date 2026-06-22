"use strict";
/**
 * harvest-emitter.js — fire-and-forget log of verified coding successes (#911).
 *
 * Appends to data/harvest/live-coding-successes.jsonl so the offline
 * continual-training pipeline (`scripts/harvest_coding_corpus.py --source-jsonl`)
 * can ingest real verified coding work without any live retraining.
 *
 * CONTRACT (non-negotiable per CLAUDE.md North Star):
 *   - NEVER triggers a training run from the live request path.
 *   - NEVER blocks the caller — always fire-and-forget.
 *   - NEVER throws — swallows every error silently.
 *   - Append-only: one JSONL row per verified success.
 *
 * Row format mirrors the harvest_coding_corpus.py --source-jsonl schema:
 *   fn          string | null  — top-level function name (null if not a pure fn task)
 *   instruction string         — task description (issue title / chat prompt)
 *   code        string         — the verified code (diff, snippet, or full function)
 *   asserts     string[]       — executable assertions (empty if not extracted yet)
 *   source      string         — "autowork" | "chat" | "tool-exec"
 *   ts          string         — ISO timestamp
 *   verified    bool           — true = execution-verified (tests passed / returncode 0)
 *   meta        object         — extra context (issue #, branch, provider, etc.)
 *
 * The harvest script normalises incomplete rows (no fn → extract from code via AST;
 * no asserts → skip or derive). Rows with `verified: false` are filtered by default.
 */
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..", "..");
const OUT_REL = "data/harvest/live-coding-successes.jsonl";
const OUT_PATH = path.join(REPO, OUT_REL);

/**
 * Emit one verified coding success to the harvest JSONL.
 * Fire-and-forget: returns immediately; never throws.
 *
 * @param {{
 *   fn?: string|null,
 *   instruction: string,
 *   code: string,
 *   asserts?: string[],
 *   source?: string,
 *   verified?: boolean,
 *   meta?: object
 * }} row
 */
function emitCodingSuccess(row) {
  try {
    if (!row || !row.instruction || !row.code) return;
    const entry = JSON.stringify({
      fn: row.fn ?? null,
      instruction: String(row.instruction).slice(0, 2000),
      code: String(row.code).slice(0, 8000),
      asserts: Array.isArray(row.asserts) ? row.asserts.slice(0, 20) : [],
      source: String(row.source || "unknown"),
      ts: new Date().toISOString(),
      verified: row.verified !== false,
      meta: row.meta || {},
    });
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.appendFileSync(OUT_PATH, entry + "\n");
  } catch (_e) { /* best effort — never block the live path */ }
}

module.exports = { emitCodingSuccess, OUT_REL };
