"use strict";

/**
 * Spiral failure-mode cache (#2869) — pre-subtract the repeatable error.
 *
 * Precedent: Marvell's RRO servo (US8094405B1) separates REPEATABLE error from
 * random error and pre-corrects the repeatable part before the head moves. The
 * spiral's analog: when a run on some problem ends unsolved, the approaches that
 * verifiably FAILED are repeatable error for that task signature — cache them,
 * and inject them as avoid-constraints BEFORE the cheap tier proposes next time,
 * so the user's recurring work stops hitting the same wall twice.
 *
 * Honest boundaries:
 *   - Only VERIFIED failures are cached (candidates the exec verifier actually
 *     scored and refused to advance) — never vibes, never dup-skips alone.
 *   - The cache stores approach SNIPPETS + failing-test names as guidance for the
 *     proposer; it never blocks a candidate outright (the verifier stays the only
 *     judge — a cached "failure" could succeed after an environment change, and
 *     the ratchet will happily accept it if it verifies).
 *   - Retrieval-into-tiny-models is measured HARMFUL when it carries solutions
 *     (6/6→2/6, SIGMA0 design §8.6): this cache injects only NEGATIVE space
 *     ("do not repeat X"), deliberately never example solutions.
 *   - Append-only JSONL under data/spiral/, mtime-cached reads, never throws.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

let _repoRoot;
try {
  _repoRoot = require("./app-paths").repoRoot;
} catch {
  _repoRoot = path.resolve(__dirname, "..", "..", "..");
}

const DEFAULT_FILE = path.join(_repoRoot, "data", "spiral", "failure-modes.jsonl");
const SNIPPET_LEN = 220;
const MAX_AVOID = 4; // small on purpose: negative-space hints, not a corpus dump

/** Task signature: stable id for "the same kind of ask" (normalized prompt hash). */
function signatureOf(problem) {
  const basis = String((problem && (problem.prompt || problem.id)) || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return crypto.createHash("sha1").update(basis).digest("hex").slice(0, 16);
}

/**
 * Record a finished-but-unsolved run's verified failures. `stalledCandidates` is
 * [{text, failingTests?}] — only candidates the verifier really scored. No-op on
 * solved runs and empty inputs. Never throws.
 */
function recordFailures({ problem, haltReason, stalledCandidates = [] }, { file = DEFAULT_FILE } = {}) {
  try {
    if (!problem || !Array.isArray(stalledCandidates) || stalledCandidates.length === 0) return null;
    const row = {
      signature: signatureOf(problem),
      problemId: problem.id || null,
      haltReason: String(haltReason || "unsolved"),
      failures: stalledCandidates.slice(0, 8).map((c) => ({
        approachHash: crypto.createHash("sha1").update(String(c.text || "")).digest("hex").slice(0, 16),
        snippet: String(c.text || "").slice(0, SNIPPET_LEN),
        failingTests: Array.isArray(c.failingTests) ? c.failingTests.slice(0, 6).map(String) : [],
      })),
      ts: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
    return row;
  } catch (e) {
    console.error("[spiral-failure-cache] record failed (non-fatal):", e && e.message);
    return null;
  }
}

// mtime+size cached signature → most-recent failure rows (newest wins per hash).
let _cache = null;
function _index(file) {
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    /* absent cache → empty */
  }
  const sig = stat ? `${file}|${stat.mtimeMs}|${stat.size}` : `${file}|absent`;
  if (_cache && _cache.sig === sig) return _cache.bySig;
  const bySig = new Map();
  if (stat) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue; // torn tail line
      }
      if (!r || !r.signature || !Array.isArray(r.failures)) continue;
      const bucket = bySig.get(r.signature) || new Map();
      for (const f of r.failures) if (f && f.approachHash) bucket.set(f.approachHash, f);
      bySig.set(r.signature, bucket);
    }
  }
  _cache = { sig, bySig };
  return bySig;
}

/**
 * The avoid-constraints for a problem: up to MAX_AVOID known-failed approaches
 * (newest first), or [] when the signature has no history. Read-only, cached.
 */
function avoidFor(problem, { file = DEFAULT_FILE, max = MAX_AVOID } = {}) {
  try {
    const bucket = _index(file).get(signatureOf(problem));
    if (!bucket) return [];
    return [...bucket.values()].slice(-max).reverse();
  } catch (e) {
    console.error("[spiral-failure-cache] read failed (non-fatal):", e && e.message);
    return [];
  }
}

/** Render avoid-constraints as the prompt block the tiers inject (negative space only). */
function renderAvoid(avoid) {
  if (!Array.isArray(avoid) || avoid.length === 0) return "";
  const lines = avoid.map((f) => {
    const tests = f.failingTests && f.failingTests.length ? ` (failed: ${f.failingTests.join(", ")})` : "";
    return `- ${String(f.snippet || "").split("\n")[0].slice(0, 120)}${tests}`;
  });
  return `Known FAILED approaches for this task — do NOT repeat them:\n${lines.join("\n")}`;
}

/** Test hook. */
function _resetForTests() {
  _cache = null;
}

module.exports = { signatureOf, recordFailures, avoidFor, renderAvoid, DEFAULT_FILE, _resetForTests };
