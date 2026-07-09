#!/usr/bin/env node
// Regenerate the machine-generated flat-RAG dumps on demand.
//
// These two files are large concatenations that used to be tracked in git
// (issue #2313, "Remember" loop stage). They are now gitignored and rebuilt
// from source with this cross-platform script so Windows dev, the Linux
// deploy host, and CI all share one regeneration path (no PowerShell needed):
//
//   node scripts/regen-flat-rag.mjs            # rebuild both dumps
//   node scripts/regen-flat-rag.mjs --internal # internal-house only
//   node scripts/regen-flat-rag.mjs --dollhouse# dollhouse only
//   node scripts/regen-flat-rag.mjs --check    # rebuild + assert both exist (CI)
//
// Or via the wrappers: `npm run regen:rag` / `make regen-rag`.
//
// Outputs:
//   data/internal-rag-house/LANTERN-OS-INTERNAL-HOUSE-RAG.flat.md
//     Source-linked, hash-only index of reviewed repo files. Read at runtime
//     as the MCP resource `rag://house` (mcp-resource-client.js, server.py).
//     Faithful port of scripts/Update-InternalHouseRag.ps1 (hash-only mode).
//   skills/lantern-rag-dollhouse/references/LANTERN-OS-RAG-DOLLHOUSE.flat.md
//     Concatenation of reports/*.md + applications/*.md. Best-effort: the
//     original generator (Sync-RagAndPdf.ps1) and most of its 90 source files
//     are no longer in the repo, so the rebuilt file reflects whatever source
//     markdown currently exists. It has no runtime consumer.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// internal-house: hash-only source index
// ---------------------------------------------------------------------------

// PowerShell -like semantics: `*` matches any run of characters (incl. path
// separators). We normalise paths to forward slashes and treat `*`/`**` alike.
const INCLUDE_GLOBS = [
  "README.md",
  "AGENTS.md",
  "docs/*.md",
  "manifests/*.md",
  "reports/*.md",
  "skills/*/SKILL.md",
  "scripts/*.ps1",
  "data/world-model/*.jsonl",
  "data/arc-reactor/*.json",
  "data/wallet/**/*.json",
  "references/*.md",
  "rag/seeds/*.md",
  "rag/**/*.md",
];

const EXCLUDE_FRAGMENTS = [
  ".git/",
  "node_modules",
  "dist/",
  "build/",
  "coverage/",
  ".env",
  "secrets",
  "private",
  "pii",
];

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
const INCLUDE_RES = INCLUDE_GLOBS.map(globToRegExp);

function isIncluded(relPath) {
  const lower = relPath.toLowerCase();
  if (EXCLUDE_FRAGMENTS.some((frag) => lower.includes(frag))) return false;
  return INCLUDE_RES.some((re) => re.test(relPath));
}

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      walk(full, acc);
    } else if (entry.isFile()) {
      const rel = path.relative(REPO_ROOT, full).split(path.sep).join("/");
      if (isIncluded(rel)) acc.push({ rel, full });
    }
  }
  return acc;
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function buildInternalHouse() {
  const files = walk(REPO_ROOT, []).sort((a, b) => a.rel.localeCompare(b.rel));
  const lines = [
    "# Lantern OS Internal House RAG",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "This flat file is an internal, source-linked RAG house index for Lantern OS. It records file paths, hashes, evidence classes, and optional file bodies. It does not delete or move source files.",
    "",
    "## Boundaries",
    "",
    "- Internal storage only.",
    "- No secrets, .env files, private folders, or raw PIID should be imported.",
    "- Source repositories remain authoritative until a promotion commit is reviewed.",
    "- Moving code means copy/promote with hashes first, then retire old source paths only after validation.",
    "",
    "## Included files",
    "",
  ];
  for (const { rel, full } of files) {
    const st = fs.statSync(full);
    lines.push(`### ${rel}`, "");
    lines.push("- evidenceClass: local_verified");
    lines.push(`- bytes: ${st.size}`);
    lines.push(`- sha256: ${sha256(full)}`);
    lines.push(`- modifiedUtc: ${st.mtime.toISOString()}`);
    lines.push("");
  }
  const out = path.join(REPO_ROOT, "data", "internal-rag-house", "LANTERN-OS-INTERNAL-HOUSE-RAG.flat.md");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join("\n") + "\n", "utf8");
  return { out, count: files.length };
}

// ---------------------------------------------------------------------------
// dollhouse: reports/ + applications/ markdown concatenation
// ---------------------------------------------------------------------------

function collectMarkdown(dirRel) {
  const dir = path.join(REPO_ROOT, dirRel);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.toLowerCase().endsWith(".md"))
    .sort()
    .map((n) => ({ rel: `${dirRel}/${n}`, full: path.join(dir, n) }));
}

function buildDollhouse() {
  const files = [...collectMarkdown("reports"), ...collectMarkdown("applications")];
  const parts = [
    "# Lantern OS RAG Flat File",
    `# Auto-generated by scripts/regen-flat-rag.mjs - ${new Date().toISOString()}`,
    `# Source: ${files.length} .md files from reports/ and applications/`,
    "",
  ];
  for (const { rel, full } of files) {
    const st = fs.statSync(full);
    const modified = st.mtime.toISOString().slice(0, 10);
    const body = fs.readFileSync(full, "utf8").replace(/\s+$/, "");
    parts.push("---", `## SOURCE: ${rel}`, `## MODIFIED: ${modified}`, "", body, "");
  }
  const out = path.join(
    REPO_ROOT,
    "skills",
    "lantern-rag-dollhouse",
    "references",
    "LANTERN-OS-RAG-DOLLHOUSE.flat.md",
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, parts.join("\n") + "\n", "utf8");
  return { out, count: files.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const doCheck = args.has("--check");
const only = args.has("--internal") ? "internal" : args.has("--dollhouse") ? "dollhouse" : "both";

const results = [];
if (only === "both" || only === "internal") results.push(["internal-house", buildInternalHouse()]);
if (only === "both" || only === "dollhouse") results.push(["dollhouse", buildDollhouse()]);

for (const [label, { out, count }] of results) {
  const relOut = path.relative(REPO_ROOT, out).split(path.sep).join("/");
  console.log(`[regen-flat-rag] ${label}: ${count} source(s) -> ${relOut}`);
  if (doCheck && !fs.existsSync(out)) {
    console.error(`[regen-flat-rag] CHECK FAILED: ${relOut} was not created`);
    process.exit(1);
  }
}
