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

/**
 * Parse only the TAIL of an append-only JSONL file: its last `maxLines` records,
 * oldest first, memoised until the file's mtime/size changes. Reads backwards in
 * growing chunks (256 KiB, doubling, at most `maxBytes`), so the cost follows what
 * the caller asked for, not how large the file has grown. readJsonlCached parses
 * the WHOLE file again after every append: on the stable box (2026-10-25) that was
 * a 430 MB agent-log.jsonl parsed to answer "the last 100 rows" and a 470 MB CSF
 * registry parsed to answer "the last 50 trading records". When the file holds more
 * than `maxBytes`, the records inside that window are all that is returned.
 * Same read-only contract as readJsonlCached: copy before mutating.
 * @param {string} filePath absolute path
 * @param {number} maxLines how many records (from the end) the caller needs
 * @param {{maxBytes?: number}} [opts]
 * @returns {object[]}
 */
function readJsonlTail(filePath, maxLines, { maxBytes = 32 * 1024 * 1024 } = {}) {
  const n = Math.max(0, Math.floor(Number(maxLines) || 0));
  if (!n) return [];
  let st;
  try { st = fs.statSync(filePath); } catch { return []; }
  const cacheKey = `tail:${n}:${maxBytes}:${filePath}`;
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = _cache.get(cacheKey);
  if (hit && hit.key === key) return hit.value;

  let value = [];
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    let want = Math.min(st.size, 256 * 1024, maxBytes);
    for (;;) {
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, st.size - want);
      const lines = buf.toString("utf8").split(/\r?\n/);
      if (want < st.size) lines.shift(); // the window's first line may start mid-record
      const parsed = [];
      for (const l of lines) {
        if (!l) continue;
        try { parsed.push(JSON.parse(l)); } catch { /* bad line: skipped, as readJsonlCached does */ }
      }
      value = parsed.slice(-n);
      if (parsed.length >= n || want >= st.size || want >= maxBytes) break;
      want = Math.min(st.size, maxBytes, want * 2);
    }
  } catch {
    value = [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
  _cache.set(cacheKey, { key, value });
  return value;
}

/** Drop a cached entry (e.g. after a synchronous rewrite). */
function invalidate(filePath) {
  _cache.delete(filePath);
  for (const k of [..._cache.keys()]) if (k.startsWith("tail:") && k.endsWith(`:${filePath}`)) _cache.delete(k);
}

module.exports = { readJsonlCached, readJsonCached, readJsonlTail, invalidate };
