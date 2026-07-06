#!/usr/bin/env node
/**
 * lint-adr-registry — mechanical enforcement of docs/adr/ numbering + index.
 *
 * ADR number collisions have happened three times: three files claimed 0001
 * (#1813, fixed #1834), two claimed 0008 (#1126/#1144, fixed #1834), two
 * claimed 0023 (#2147/#2158, fixed #2164). Root cause: concurrent PRs each
 * pick the "next free number" against a stale base, and nothing mechanical
 * catches the collision at merge. This lint (suggested as a follow-up in
 * ADR-0001's review) fails when:
 *
 *   1. Two files in docs/adr/ share the same 4-digit number prefix.
 *   2. An ADR file (excluding 0000-template.md) has no row in README.md's
 *      index table — plus the inverse rots: a row that links to a missing
 *      file, a row whose displayed number doesn't match the filename prefix,
 *      or two rows for the same file/number.
 *   3. An index row's status cell contradicts the file's own status. The
 *      file's status is read from YAML frontmatter `status:` first, else a
 *      `- Status:` bullet in the metadata block, else the first line under a
 *      `## Status` heading (frontmatter wins when both exist — e.g. 0001's
 *      `## Status` section is stale). Statuses compare by leading keyword
 *      (Proposed / Accepted / Superseded / Deprecated / Rejected), so
 *      "Accepted (Alex Place, 2026-07-02)" matches `status: Accepted`.
 *
 * Dependency-free, runs in well under a second.
 *
 * Usage:  node scripts/lint-adr-registry.mjs
 * Exit codes: 0 = clean, 1 = violations found, 2 = registry unreadable.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const ADR_DIR = join(REPO_ROOT, "docs", "adr");
const README = join(ADR_DIR, "README.md");
const TEMPLATE = "0000-template.md";
const STATUS_KEYWORDS = new Set([
  "proposed",
  "accepted",
  "superseded",
  "deprecated",
  "rejected",
]);

function fatal(msg) {
  console.error(`lint-adr-registry: ${msg}`);
  process.exit(2);
}

/** Leading status keyword of a status string, or null if unrecognisable. */
function statusKeyword(raw) {
  if (!raw) return null;
  const m = raw.replace(/[*_`]/g, "").trim().match(/^([A-Za-z]+)/);
  if (!m) return null;
  const kw = m[1].toLowerCase();
  return STATUS_KEYWORDS.has(kw) ? kw : null;
}

/**
 * Extract an ADR file's own status declaration.
 * Precedence: frontmatter `status:` → `- Status:` metadata bullet (searched
 * only before the first `## ` heading, so body lists can't false-positive) →
 * first non-empty line under a `## Status` heading.
 */
function fileStatus(text) {
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const m = text.slice(0, end).match(/^status:[ \t]*(.+)$/m);
      if (m) return { raw: m[1].trim(), source: "frontmatter status:" };
    }
  }
  const firstHeading = text.search(/^## /m);
  const metaBlock = firstHeading === -1 ? text : text.slice(0, firstHeading);
  const bullet = metaBlock.match(/^[-*][ \t]*\*{0,2}Status\*{0,2}[ \t]*:[ \t]*(.+)$/m);
  if (bullet) return { raw: bullet[1].trim(), source: "'- Status:' bullet" };

  const lines = text.split("\n");
  const idx = lines.findIndex((l) => /^##[ \t]+Status[ \t]*$/.test(l.trim()));
  if (idx !== -1) {
    for (let i = idx + 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      if (l.startsWith("#")) break;
      return { raw: l, source: "'## Status' section" };
    }
  }
  return null;
}

const errors = [];

// ── collect ADR files ──────────────────────────────────────────────────────
let adrFiles;
try {
  adrFiles = readdirSync(ADR_DIR)
    .filter((f) => /^\d{4}-.+\.md$/.test(f))
    .sort();
} catch (e) {
  fatal(`cannot read ${ADR_DIR}: ${e.message}`);
}

// (1) duplicate 4-digit number prefixes
const byNumber = new Map();
for (const f of adrFiles) {
  const num = f.slice(0, 4);
  if (!byNumber.has(num)) byNumber.set(num, []);
  byNumber.get(num).push(f);
}
for (const [num, files] of byNumber) {
  if (files.length > 1) {
    errors.push(
      `duplicate ADR number ${num}: ${files.join(", ")} — ` +
        `renumber the later file to the next free number and update its README index row`
    );
  }
}

// ── parse the README index table ───────────────────────────────────────────
let readmeText;
try {
  readmeText = readFileSync(README, "utf8").replace(/\r\n/g, "\n");
} catch (e) {
  fatal(`cannot read ${README}: ${e.message}`);
}
const readmeLines = readmeText.split("\n");
const indexAt = readmeLines.findIndex((l) => /^##[ \t]+Index[ \t]*$/.test(l.trim()));
if (indexAt === -1) fatal("docs/adr/README.md has no '## Index' heading");

const ROW_RE = /^\|\s*\[(\d{4})\]\(([^)#]+?)\)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/;
const rows = [];
for (let i = indexAt + 1; i < readmeLines.length; i++) {
  const line = readmeLines[i];
  if (/^##[ \t]/.test(line)) break; // next section
  const m = line.match(ROW_RE);
  if (m) rows.push({ num: m[1], target: m[2].replace(/^\.\//, ""), statusCell: m[4], line: i + 1 });
}
if (rows.length === 0) fatal("no ADR rows found in README.md's '## Index' table");

// (2) file ↔ index membership, both directions
const fileSet = new Set(adrFiles);
const rowsByTarget = new Map();
for (const row of rows) {
  if (rowsByTarget.has(row.target)) {
    errors.push(`README.md:${row.line}: duplicate index row for ${row.target}`);
  }
  rowsByTarget.set(row.target, row);
  if (!fileSet.has(row.target)) {
    errors.push(`README.md:${row.line}: index row [${row.num}] links to missing file ${row.target}`);
  }
  if (!row.target.startsWith(`${row.num}-`)) {
    errors.push(
      `README.md:${row.line}: index row displays [${row.num}] but links to ${row.target} — number and filename disagree`
    );
  }
}
for (const f of adrFiles) {
  if (f === TEMPLATE) continue;
  if (!rowsByTarget.has(f)) {
    errors.push(`docs/adr/${f} has no row in README.md's index table — add one under '## Index'`);
  }
}

// (3) index status cell vs the file's own status
for (const f of adrFiles) {
  if (f === TEMPLATE) continue;
  const row = rowsByTarget.get(f);
  if (!row) continue; // already reported above
  const declared = fileStatus(readFileSync(join(ADR_DIR, f), "utf8").replace(/\r\n/g, "\n"));
  if (!declared) {
    errors.push(
      `docs/adr/${f}: no status found (need frontmatter 'status:', a '- Status:' bullet, or a '## Status' section)`
    );
    continue;
  }
  const fileKw = statusKeyword(declared.raw);
  const rowKw = statusKeyword(row.statusCell);
  if (!fileKw) {
    errors.push(
      `docs/adr/${f}: unrecognised status "${declared.raw}" in ${declared.source} ` +
        `(expected it to start with Proposed/Accepted/Superseded/Deprecated/Rejected)`
    );
  }
  if (!rowKw) {
    errors.push(
      `README.md:${row.line}: unrecognised status cell "${row.statusCell}" for ${f} ` +
        `(expected it to start with Proposed/Accepted/Superseded/Deprecated/Rejected)`
    );
  }
  if (fileKw && rowKw && fileKw !== rowKw) {
    errors.push(
      `status mismatch for ${f}: index row says "${row.statusCell}" (README.md:${row.line}) ` +
        `but the file's ${declared.source} says "${declared.raw}"`
    );
  }
}

// ── report ─────────────────────────────────────────────────────────────────
if (errors.length) {
  console.error(`ADR registry lint: ${errors.length} violation(s)\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(
    "\nRules: unique 4-digit numbers; every docs/adr/NNNN-*.md (except the template) has a\n" +
      "README.md index row; the row's status matches the file's own status declaration.\n" +
      "See docs/adr/README.md ('How to write an ADR')."
  );
  process.exit(1);
}
console.log(
  `ADR registry lint: OK — ${adrFiles.length - 1} ADRs + template: numbers unique, ` +
    `index complete, statuses consistent.`
);
