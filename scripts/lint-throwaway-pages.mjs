#!/usr/bin/env node
/**
 * lint-throwaway-pages — flag throwaway / standalone HTML pages.
 *
 * Standing rule: no throwaway or standalone test/demo/scratch pages live in the
 * repo. Verify changes against the real running app, not a one-off harness page.
 *
 * What it flags (HTML files only):
 *   1. Name patterns: a basename segment that is a throwaway token
 *      (test, demo, scratch, tmp, temp, mock, harness, draft, wip, backup,
 *       sandbox, untitled, example, sample, playground, poc, throwaway, copy,
 *       old, foo/bar/baz/qux, asdf, deleteme), or a version-dup suffix (-v2),
 *      or a literal " copy" / "(1)" duplicate marker.
 *   2. Content markers: an explicit harness marker in the file
 *      (DO NOT SHIP, throwaway, scratch page, test harness, mock data only,
 *       "what you'd see").
 *
 * Usage:
 *   node scripts/lint-throwaway-pages.mjs            # report; exit 1 if any found
 *   node scripts/lint-throwaway-pages.mjs --delete   # delete flagged files, then exit 0
 *   node scripts/lint-throwaway-pages.mjs --json      # machine-readable report
 *
 * Exit codes: 0 = clean (or deleted), 1 = throwaway pages found (report mode).
 */
import { readdirSync, statSync, readFileSync, rmSync } from "node:fs";
import { join, basename, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");

// Directories never scanned (deps, VCS, build output, venvs, sibling worktrees).
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "coverage", "venv",
  ".next", "out", "vendor", "__pycache__", "site-packages",
]);
// Skip rule: explicit names above, any dot-directory (.git, .claude, .venv-train,
// .dev-worktree), any *venv* dir, or any *-worktree dir — none hold product pages.
function skipDir(name) {
  return (
    SKIP_DIRS.has(name) ||
    name.startsWith(".") ||
    name.toLowerCase().includes("venv") ||
    name.toLowerCase().endsWith("-worktree")
  );
}

// Throwaway tokens — matched only as a WHOLE segment of the basename
// (segments split on - _ . and space), so "trading-news" never matches "new".
const TOKENS = new Set([
  "test", "tests", "demo", "demos", "scratch", "sandbox", "tmp", "temp",
  "mock", "mocks", "harness", "draft", "wip", "backup", "bak", "untitled",
  "example", "sample", "playground", "poc", "throwaway", "copy", "old",
  "foo", "bar", "baz", "qux", "asdf", "deleteme", "todelete", "scrap",
]);

// Content markers (case-insensitive substring) that betray a harness/mockup.
const CONTENT_MARKERS = [
  "do not ship", "throwaway", "scratch page", "test harness",
  "mock data only", "what you'd see", "what you would see", "placeholder page",
];

const VERSION_DUP = /-v\d+$/i;            // dream-chat-v1
const COPY_DUP = /\bcopy\b|\(\d+\)$| - copy$/i; // "page copy", "page (1)"

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (skipDir(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (name.toLowerCase().endsWith(".html")) out.push(full);
  }
  return out;
}

function nameReason(file) {
  const stem = basename(file).replace(/\.html$/i, "");
  const segments = stem.split(/[-_. ]+/).map((s) => s.toLowerCase()).filter(Boolean);
  const hit = segments.find((s) => TOKENS.has(s));
  if (hit) return `name contains throwaway token "${hit}"`;
  if (VERSION_DUP.test(stem)) return `versioned duplicate (${stem.match(VERSION_DUP)[0]})`;
  if (COPY_DUP.test(stem)) return "duplicate-copy name";
  return null;
}

function contentReason(file) {
  let head;
  try { head = readFileSync(file, "utf8").slice(0, 4000).toLowerCase(); } catch { return null; }
  const hit = CONTENT_MARKERS.find((m) => head.includes(m));
  return hit ? `content marker "${hit}"` : null;
}

const args = new Set(process.argv.slice(2));
const DELETE = args.has("--delete");
const JSON_OUT = args.has("--json");

const findings = [];
for (const file of walk(REPO_ROOT)) {
  const reason = nameReason(file) || contentReason(file);
  if (reason) findings.push({ path: relative(REPO_ROOT, file).split(sep).join("/"), reason });
}
findings.sort((a, b) => a.path.localeCompare(b.path));

if (JSON_OUT) {
  console.log(JSON.stringify({ count: findings.length, findings }, null, 2));
  process.exit(findings.length && !DELETE ? 1 : 0);
}

if (findings.length === 0) {
  console.log("✓ lint-throwaway-pages: no throwaway/standalone HTML pages found.");
  process.exit(0);
}

console.log(`\n⚠ lint-throwaway-pages: ${findings.length} throwaway/standalone page(s) found:\n`);
for (const f of findings) console.log(`  ${f.path}\n      ↳ ${f.reason}`);

if (DELETE) {
  console.log("\nDeleting flagged files...");
  for (const f of findings) {
    rmSync(join(REPO_ROOT, f.path));
    console.log(`  deleted ${f.path}`);
  }
  console.log(`\n✓ Deleted ${findings.length} file(s). Commit the removals.`);
  process.exit(0);
}

console.log(
  "\nThese should not live in the repo (standing rule: no throwaway/standalone pages).\n" +
  "Remove them with:  node scripts/lint-throwaway-pages.mjs --delete\n" +
  "Or, if a file is a real product page, rename it so it no longer matches.\n"
);
process.exit(1);
