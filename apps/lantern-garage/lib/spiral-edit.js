"use strict";

/**
 * Spiral edits — search/replace with exact-match verification (#2975).
 *
 * WHY THIS EXISTS. Of our 5 graded SWE-bench Lite predictions, ONE failed to apply at all
 * (`astropy__astropy-14995`, hallucinated hunk context). That is 20% of the run lost to
 * patch *format*, not to reasoning. A unified diff asks the model to reproduce exact
 * surrounding lines and correct @@ line numbers from memory; small models cannot, and our
 * own HumanEval runs show the same underlying weakness from a different angle (no-parse
 * counts of 111-138 out of 164 — format-following collapse is the dominant failure mode,
 * not reasoning).
 *
 * So the model never writes a diff. It writes what it wants changed:
 *
 *     <<<<<<< SEARCH path/to/file.py
 *     the exact text to find
 *     =======
 *     what it becomes
 *     >>>>>>> REPLACE
 *
 * We find that text ourselves, and the line numbers are our problem, not the model's.
 *
 * THE EXACT-MATCH RULE IS THE WHOLE POINT. If the SEARCH text is not found, or is found
 * more than once, we apply NOTHING and hand the failure back as an observation. Fuzzy
 * matching would "succeed" at editing the wrong place, and a patch that lands in the wrong
 * function is worse than one that doesn't land — it burns the turn AND poisons the
 * verifier's signal. A miss is cheap; a wrong hit is not. This is the same ratchet
 * discipline as the rest of the Spiral: nothing commits unless reality confirms it.
 *
 * Whitespace is the one accommodation: a model that reproduces the right code with the
 * wrong indentation is right about the thing that is hard and wrong about the thing that
 * is mechanical. We retry once on a whitespace-normalized basis, but ONLY when that match
 * is still unique, and we splice using the file's real text.
 */

const fs = require("fs");
const path = require("path");

const BLOCK = /<{5,}\s*SEARCH\s*(.*?)\r?\n([\s\S]*?)\r?\n={5,}\r?\n([\s\S]*?)\r?\n>{5,}\s*REPLACE/g;

/**
 * Parse SEARCH/REPLACE blocks out of a model reply. Prose around the blocks is ignored —
 * a small model will narrate no matter what the prompt says, and failing the whole turn
 * over a stray sentence is a format tax we already know we cannot afford.
 *
 * @returns {Array<{file:string, search:string, replace:string}>}
 */
function parseEdits(text) {
  const s = String(text == null ? "" : text);
  const out = [];
  // matchAll (not a lastIndex loop) so the shared /g regex can't carry state between calls.
  for (const m of s.matchAll(BLOCK)) {
    const file = String(m[1] || "").trim().replace(/^["'`]|["'`]$/g, "");
    out.push({ file, search: m[2], replace: m[3] });
  }
  return out;
}

/** Collapse runs of whitespace so indentation drift alone can't fail a match. */
const _norm = (s) => String(s).replace(/[ \t]+/g, " ").replace(/[ \t]*\r?\n[ \t]*/g, "\n").trim();

/** Locate `search` in `text`. Returns {start,end} or a reason it could not be used. */
function locate(text, search) {
  if (!search) return { error: "empty SEARCH block" };
  const exact = _allIndexes(text, search);
  if (exact.length === 1) return { start: exact[0], end: exact[0] + search.length, mode: "exact" };
  if (exact.length > 1) return { error: `SEARCH text appears ${exact.length} times — ambiguous, refusing to guess` };

  // Whitespace-tolerant retry, still requiring uniqueness. We walk real line boundaries so
  // the splice uses the file's actual bytes, never the model's reconstruction of them.
  const target = _norm(search);
  if (!target) return { error: "SEARCH block is only whitespace" };
  const lines = text.split(/(?<=\n)/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    let acc = "";
    let off = 0;
    for (let j = i; j < lines.length; j++) {
      acc += lines[j];
      off += lines[j].length;
      const n = _norm(acc);
      if (n === target) {
        const start = lines.slice(0, i).reduce((a, l) => a + l.length, 0);
        // Tighten the span to the matched CONTENT. Line-boundary accumulation overshoots
        // by the leading indent and the trailing newline; splicing those away with the
        // match would delete file whitespace the model never asked to touch (and silently
        // eat the file's final newline).
        hits.push(_tighten(text, start, start + off));
        break;
      }
      if (n.length > target.length) break;
    }
  }
  if (hits.length === 1) return { ...hits[0], mode: "whitespace-normalized" };
  if (hits.length > 1) return { error: `SEARCH text matches ${hits.length} places ignoring whitespace — ambiguous` };
  return { error: "SEARCH text not found in file" };
}

/** Shrink [start,end) past surrounding whitespace so only matched content is replaced. */
function _tighten(text, start, end) {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return { start: s, end: e };
}

function _allIndexes(hay, needle) {
  const out = [];
  let i = hay.indexOf(needle);
  while (i !== -1 && out.length < 50) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

/** Reject paths that climb out of the repo. Same posture as the command jail. */
function _resolveInRepo(repoDir, file) {
  if (!file) return { error: "no file path on the SEARCH block" };
  const abs = path.resolve(repoDir, file);
  const root = path.resolve(repoDir);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { error: `path escapes the repo: ${file}` };
  return { abs };
}

/**
 * Apply a set of edits ALL-OR-NOTHING.
 *
 * Every block is located and spliced in memory first; only if all of them resolve do we
 * touch the disk. A half-applied edit set leaves the tree in a state neither the model nor
 * the verifier can reason about — the model believes it made one change, the tests see
 * another, and the Fix-Rate signal for that turn is garbage. Better to write nothing and
 * say why.
 *
 * @returns {{ok:boolean, applied:Array, failures:Array, files:Array<string>, observation:string}}
 */
function applyEdits(repoDir, editsOrText) {
  const edits = typeof editsOrText === "string" ? parseEdits(editsOrText) : editsOrText || [];
  if (!edits.length) {
    return {
      ok: false,
      applied: [],
      failures: [{ reason: "no SEARCH/REPLACE block found in the reply" }],
      files: [],
      observation:
        "[edit] no SEARCH/REPLACE block found. Format:\n<<<<<<< SEARCH path/to/file\n<exact existing text>\n=======\n<replacement>\n>>>>>>> REPLACE",
    };
  }

  const staged = new Map(); // abs path → pending content (so 2 edits to one file compose)
  const applied = [];
  const failures = [];

  for (const e of edits) {
    const r = _resolveInRepo(repoDir, e.file);
    if (r.error) { failures.push({ file: e.file, reason: r.error }); continue; }
    let content;
    if (staged.has(r.abs)) content = staged.get(r.abs);
    else {
      try { content = fs.readFileSync(r.abs, "utf8"); }
      catch { failures.push({ file: e.file, reason: "file does not exist" }); continue; }
    }
    const loc = locate(content, e.search);
    if (loc.error) { failures.push({ file: e.file, reason: loc.error }); continue; }
    staged.set(r.abs, content.slice(0, loc.start) + e.replace + content.slice(loc.end));
    applied.push({ file: e.file, mode: loc.mode });
  }

  if (failures.length) {
    return {
      ok: false,
      applied: [],
      failures,
      files: [],
      observation:
        `[edit] applied nothing — ${failures.length} of ${edits.length} block(s) did not match exactly:\n` +
        failures.map((f) => `- ${f.file || "(no path)"}: ${f.reason}`).join("\n") +
        "\nRe-read the file and copy the target text verbatim.",
    };
  }

  const files = [];
  for (const [abs, content] of staged) {
    // Skip a no-op write (replace text identical to search text). Touching a file whose
    // bytes didn't change would make the tree look mutated to anything watching mtimes,
    // and the loop would score a turn that did nothing as a real step.
    let current = null;
    try { current = fs.readFileSync(abs, "utf8"); } catch { /* re-read failure → just write */ }
    if (current === content) continue;
    fs.writeFileSync(abs, content, "utf8");
    files.push(path.relative(path.resolve(repoDir), abs).split(path.sep).join("/"));
  }

  return {
    ok: true,
    applied,
    failures: [],
    files,
    observation: files.length
      ? `[edit] applied ${applied.length} block(s) to ${files.length} file(s): ${files.join(", ")}`
      : `[edit] ${applied.length} block(s) matched but changed nothing — the replacement is identical to the original`,
  };
}

/**
 * The unified diff for the prediction file — produced by git from what is actually on
 * disk, never authored by the model. This is the inversion that kills the apply-failure
 * class: the diff is a rendering of a verified edit, not a thing anyone had to get right.
 */
function toUnifiedDiff(repoDir) {
  const { spawnSync } = require("child_process");
  const r = spawnSync("git", ["diff", "--no-color"], { cwd: repoDir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (r.error || r.status !== 0) return "";
  return String(r.stdout || "");
}

/** The prompt fragment that teaches the format. Kept next to the parser so they can't drift. */
const EDIT_FORMAT_HELP = [
  "To change code, emit one or more blocks in EXACTLY this format:",
  "<<<<<<< SEARCH path/to/file.py",
  "<text copied verbatim from the file, unique enough to appear once>",
  "=======",
  "<what it should become>",
  ">>>>>>> REPLACE",
  "The SEARCH text must match the file exactly and appear only once, or nothing is applied.",
  "Never write a unified diff and never invent line numbers.",
].join("\n");

module.exports = { parseEdits, applyEdits, locate, toUnifiedDiff, EDIT_FORMAT_HELP };
