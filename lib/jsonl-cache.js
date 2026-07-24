"use strict";
/**
 * mtime+size keyed parse cache for append-only JSONL/JSON files (perf #1889/#1890).
 *
 * Several read-only endpoints (trading dashboard, kalshi-stats, convergence
 * status, CSF trade records) re-read and re-parse an entire growing JSONL file
 * on *every* request even when the file has not changed since the last call.
 * These files are append-only and only mutate via file-queue appends, so a
 * cache keyed on (mtimeMs, size) is always correct: any append bumps both, and
 * a stale key falls through to a fresh read. statSync is a single cheap syscall
 * versus reading+JSON.parsing megabytes of lines.
 *
 * Callers MUST treat the returned array/value as read-only (do not sort/reverse
 * it in place) — it is shared across callers until the file changes. All current
 * consumers copy via .map/.filter/.slice before mutating.
 */

const fs = require("fs");

const _cache = new Map(); // absolute path -> { key, value }

function _statKey(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null; // missing file
  }
}

/**
 * Read + parse a JSONL file into an array of objects (bad/blank lines skipped),
 * memoised until the file's mtime/size changes. Returns [] if the file is
 * missing or unreadable.
 * @param {string} filePath absolute path
 * @returns {object[]}
 */
function readJsonlCached(filePath) {
  const key = _statKey(filePath);
  if (key === null) return [];
  const hit = _cache.get(filePath);
  if (hit && hit.key === key) return hit.value;

  let value = [];
  try {
    value = fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    value = [];
  }
  _cache.set(filePath, { key, value });
  return value;
}

/**
 * Read + parse a single-object JSON file, memoised until mtime/size changes.
 * @param {string} filePath absolute path
 * @param {*} fallback returned when the file is missing/unreadable/invalid
 */
function readJsonCached(filePath, fallback = {}) {
  const key = _statKey(filePath);
  if (key === null) return fallback;
  const hit = _cache.get(filePath);
  if (hit && hit.key === key) return hit.value;

  let value = fallback;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8") || "null") ?? fallback;
  } catch {
    value = fallback;
  }
  _cache.set(filePath, { key, value });
  return value;
}

/** Drop a cached entry (e.g. after a synchronous rewrite). */
function invalidate(filePath) { _cache.delete(filePath); }

module.exports = { readJsonlCached, readJsonCached, invalidate };
