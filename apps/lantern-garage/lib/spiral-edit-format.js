"use strict";

/**
 * Search/replace edit format with exact-match verification (#2975).
 *
 * Why: of 5 graded SWE-bench Lite predictions, 1 failed to APPLY (hallucinated
 * hunk context) — 20% of the run lost to patch format, not reasoning. Hand-written
 * unified diffs force the model to reproduce exact context lines from memory; small
 * models measurably can't (no-parse 111–138/164 on our HumanEval runs). The fix is
 * the mini-swe-agent-family edit contract: the model emits SEARCH/REPLACE pairs,
 * we verify the search text matches the file EXACTLY before touching anything, and
 * on mismatch we return a structured observation so the loop retries — a failed
 * match is a verifier signal, never a committed broken patch. The unified diff for
 * the prediction file is computed by US at the end, from real before/after text.
 *
 * Block grammar (tolerant to the common fence variants):
 *
 *   <<<<<<< SEARCH
 *   exact existing text
 *   =======
 *   replacement text
 *   >>>>>>> REPLACE
 *
 * Pure module: no fs — callers hand in file content and receive new content plus
 * receipts. That keeps it testable and lets the #2973 environment tier own I/O.
 */

const BLOCK_RE = /<{5,9}\s*SEARCH\s*\n([\s\S]*?)\n?={5,9}\s*\n([\s\S]*?)\n?>{5,9}\s*REPLACE/g;

/** Parse all SEARCH/REPLACE blocks from a model reply. Returns [{search, replace}]. */
function parseEdits(text) {
  const edits = [];
  for (const m of String(text || "").matchAll(new RegExp(BLOCK_RE.source, "g"))) {
    edits.push({ search: m[1], replace: m[2] });
  }
  return edits;
}

/**
 * Apply edits to content under the exact-match contract.
 *
 * Rules (all receipts, no silent behavior):
 *   - a search string must occur EXACTLY once — zero matches is "no-match"
 *     (the hallucinated-context class this module exists to kill), two or more is
 *     "ambiguous" (applying would guess; guessing is how broken patches commit).
 *   - edits apply in order, each against the current (already-edited) content.
 *   - ANY failure aborts the whole application (content returned unchanged) and
 *     reports per-edit observations the loop can feed back to the model verbatim.
 *
 * @returns {{ ok, content, applied, failed: [{index, reason, observation}] }}
 */
function applyEdits(content, edits) {
  let cur = String(content == null ? "" : content);
  const failed = [];
  const applied = [];
  for (let i = 0; i < edits.length; i++) {
    const { search, replace } = edits[i];
    if (!search) {
      failed.push({ index: i, reason: "empty-search", observation: `edit ${i + 1}: SEARCH block is empty — nothing to match.` });
      continue;
    }
    const first = cur.indexOf(search);
    if (first === -1) {
      failed.push({
        index: i,
        reason: "no-match",
        observation:
          `edit ${i + 1}: SEARCH text not found in the file (exact match required). ` +
          `Re-read the file and copy the existing lines verbatim. First line of your search: ` +
          JSON.stringify(String(search).split("\n")[0].slice(0, 120)),
      });
      continue;
    }
    if (cur.indexOf(search, first + 1) !== -1) {
      failed.push({
        index: i,
        reason: "ambiguous",
        observation: `edit ${i + 1}: SEARCH text matches more than once — add surrounding lines until it is unique.`,
      });
      continue;
    }
    applied.push(i);
    cur = cur.slice(0, first) + String(replace == null ? "" : replace) + cur.slice(first + search.length);
  }
  if (failed.length) {
    return { ok: false, content: String(content == null ? "" : content), applied: [], failed };
  }
  return { ok: true, content: cur, applied, failed: [] };
}

/**
 * Unified diff computed from real before/after text (we never trust a model-written
 * diff). Plain LCS line diff with hunk headers — consumers are SWE-bench prediction
 * files and human eyes, both of which want standard `---/+++/@@` shape.
 */
function unifiedDiff(before, after, { fromFile = "a/file", toFile = "b/file", context = 3 } = {}) {
  const a = String(before == null ? "" : before).split("\n");
  const b = String(after == null ? "" : after).split("\n");
  // LCS table (fine for source files; SWE-bench files are thousands of lines, not millions)
  const n = a.length;
  const m = b.length;
  const prev = new Array(m + 1).fill(0);
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  void prev;
  // Backtrack into an op list: {t: " "|"-"|"+", line}
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ t: " ", line: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ t: "+", line: b[j - 1] });
      j--;
    } else {
      ops.push({ t: "-", line: a[i - 1] });
      i--;
    }
  }
  ops.reverse();
  // Group into hunks with `context` lines of surround
  const hunks = [];
  let cursorA = 1;
  let cursorB = 1;
  let hunk = null;
  let trailing = 0;
  for (const op of ops) {
    const isChange = op.t !== " ";
    if (isChange && !hunk) {
      const lead = [];
      // pull up to `context` unchanged lines back from the previous flushed region
      const flushedTail = hunks.length ? [] : null;
      void flushedTail;
      hunk = { aStart: cursorA, bStart: cursorB, lines: [], aLen: 0, bLen: 0, lead };
      // borrow leading context from a lookback buffer
    }
    if (hunk) {
      if (!isChange) {
        trailing += 1;
        if (trailing > context * 2) {
          // close the hunk, trimming surplus middle context to `context`
          while (trailing > context) {
            hunk.lines.pop();
            hunk.aLen--; hunk.bLen--;
            trailing--;
          }
          hunks.push(hunk);
          hunk = null;
          trailing = 0;
        }
      } else {
        trailing = 0;
      }
    }
    if (hunk) {
      hunk.lines.push(op.t + op.line);
      if (op.t !== "+") hunk.aLen++;
      if (op.t !== "-") hunk.bLen++;
    }
    if (op.t !== "+") cursorA++;
    if (op.t !== "-") cursorB++;
  }
  if (hunk) {
    while (trailing > context) {
      hunk.lines.pop();
      hunk.aLen--; hunk.bLen--;
      trailing--;
    }
    hunks.push(hunk);
  }
  // Leading context: cheap second pass — extend each hunk backwards over unchanged lines
  // is omitted (hunks open AT the first change); anchors remain correct because aStart/bStart
  // point at the first changed line. Standard tools accept zero-lead hunks.
  if (!hunks.length) return "";
  const out = [`--- ${fromFile}`, `+++ ${toFile}`];
  for (const h of hunks) {
    out.push(`@@ -${h.aStart},${h.aLen} +${h.bStart},${h.bLen} @@`);
    out.push(...h.lines);
  }
  return out.join("\n") + "\n";
}

module.exports = { parseEdits, applyEdits, unifiedDiff };
