#!/usr/bin/env node
/**
 * Markdown link checker (#2532) — fail CI on dead RELATIVE links before they rot.
 *
 * The 2026-07-16 README audit found 7+ dead internal links had accumulated in the
 * root README alone (AUTONOMOUS-REPAIR-GUIDE.md, docs/TROUBLESHOOTING.md, …).
 * This gate keeps that class of rot from re-accumulating.
 *
 * Scope: README.md + every root *.md + docs/** — the reader-facing doc surface.
 * Checked: inline [text](target) and image ![alt](target) RELATIVE targets.
 * Ignored: absolute URLs (http/https/mailto/tel), pure #anchors, and code fences.
 * External URLs are deliberately NOT fetched (flake); anchors are not resolved
 * (heading slugs move too often to gate on).
 *
 * Ratchet: the ROOT tier (README.md + root *.md) BLOCKS — it started clean.
 * docs/** starts as WARN-only (124 pre-existing dead links at introduction —
 * tracked for burn-down; see the follow-up issue) and flips to blocking with
 * --strict once the backlog is cleared. New rot in the root tier can't land.
 *
 * Usage: node scripts/check-md-links.mjs [--quiet] [--strict]
 * Exit:  0 = blocking tier clean · 1 = dead links in the blocking tier
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUIET = process.argv.includes("--quiet");

function listFiles() {
  const files = [];
  for (const f of fs.readdirSync(ROOT)) {
    if (f.toLowerCase().endsWith(".md")) files.push(path.join(ROOT, f));
  }
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith(".md")) files.push(p);
    }
  };
  const docs = path.join(ROOT, "docs");
  if (fs.existsSync(docs)) walk(docs);
  return files;
}

// Strip fenced + inline code so example links (```[x](y)```) don't false-flag.
function stripCode(md) {
  return md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

const LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function isExternal(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target); // http:, https:, mailto:, tel:, protocol-relative
}

const STRICT = process.argv.includes("--strict");
const dead = [];
let checked = 0;
for (const file of listFiles()) {
  const md = stripCode(fs.readFileSync(file, "utf8"));
  const rel = path.relative(ROOT, file);
  const blocking = STRICT || !rel.replace(/\\/g, "/").startsWith("docs/");
  for (const m of md.matchAll(LINK_RE)) {
    let target = m[1].trim();
    if (!target || target.startsWith("#") || isExternal(target)) continue;
    target = decodeURIComponent(target.split("#")[0].split("?")[0]);
    if (!target) continue;
    // Root-absolute (/x) targets are app ROUTES (served by the app), not repo files —
    // the Site Audit gate owns those. Only repo-relative paths are checked here.
    if (target.startsWith("/")) continue;
    const resolved = path.resolve(path.dirname(file), target);
    checked++;
    if (!fs.existsSync(resolved)) {
      dead.push({ file: rel, target, blocking });
    }
  }
}

const blockers = dead.filter((d) => d.blocking);
const warns = dead.filter((d) => !d.blocking);
if (warns.length && !QUIET) {
  console.warn(`⚠ ${warns.length} dead link(s) in docs/** (warn-only until the pre-existing backlog is burned down — run with --strict to gate):`);
  for (const d of warns.slice(0, 15)) console.warn(`  ${d.file} → ${d.target}`);
  if (warns.length > 15) console.warn(`  … and ${warns.length - 15} more`);
}
if (blockers.length) {
  console.error(`\n✗ ${blockers.length} dead relative markdown link(s) in the blocking tier (checked ${checked} total):`);
  for (const d of blockers) console.error(`  ${d.file} → ${d.target}`);
  console.error("\nFix the link or remove it. External URLs and #anchors are not checked.");
  process.exit(1);
}
if (!QUIET) console.log(`✓ markdown links OK — blocking tier clean (${checked} relative links checked, ${warns.length} warn-tier dead in docs/**)`);
