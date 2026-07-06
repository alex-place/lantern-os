#!/usr/bin/env node
/**
 * sprawl-tripwire — every NEW public surface must justify itself with a loop stage (#1561).
 *
 * The grade card flagged: "nothing stops scope from silently regrowing after a cleanup."
 * pr-gates.yml (anti-sprawl job) already caps new file / top-level-dir counts; find-orphan-pages.mjs finds
 * unlinked pages. The missing piece is *justification*: a PR that adds a new public page
 * (a new surface) must say which stage of the loop — Observe / Remember / Reason / Act /
 * Verify / Converge — that surface strengthens. A page with no declared loop stage is
 * exactly the unjustified sprawl this catches.
 *
 * A page declares its stage with EITHER:
 *   <meta name="loop-stage" content="verify">           (in <head>)
 *   <!-- loop-stage: verify -->                          (anywhere)
 *
 * Only surfaces ADDED in the PR (vs the base ref) are checked, so existing pages are
 * grandfathered — this prevents regression without a retroactive sweep.
 *
 * Usage:
 *   node scripts/sprawl-tripwire.mjs                 # diff origin/master...HEAD; exit 1 on a violation
 *   node scripts/sprawl-tripwire.mjs --base <ref>    # diff against a different base
 *   node scripts/sprawl-tripwire.mjs --all           # report stages for EVERY page (advisory, exit 0)
 *   node scripts/sprawl-tripwire.mjs --json
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import registry from "../apps/lantern-garage/lib/surface-registry.js";

export const VALID_STAGES = ["observe", "remember", "reason", "act", "verify", "converge"];

// A surface is ALSO justified if surface-registry.js already classifies it as CORE or
// EXTENSION — that registry (with its contract test + sprawl-budget cap) is the
// authoritative Σ₀ boundary, so an already-classified surface is not "silent" sprawl.
// This reconciles the two gates onto one source of truth (ADR-0023). Top-level only,
// matching the registry's scope.
export function isRegistryClassified(relPath) {
  return registry.classify(basename(relPath)) !== null;
}
const PUBLIC_PREFIX = "apps/lantern-garage/public/";

// Pull the declared loop stage out of a page's HTML (meta tag or comment). Returns the
// lowercased stage, or null if none / invalid.
export function extractLoopStage(html) {
  const s = String(html || "");
  let m = s.match(/<meta\s+name=["']loop-stage["']\s+content=["']([a-z]+)["']/i)
       || s.match(/<!--\s*loop-stage:\s*([a-z]+)\s*-->/i);
  const stage = m && m[1].toLowerCase();
  return VALID_STAGES.includes(stage) ? stage : null;
}

// Pure evaluation: given [{path, content}] for the added pages, return violations (no valid
// loop stage) and the accepted ones.
export function evaluateSurfaces(pages) {
  const violations = [], justified = [];
  for (const p of pages || []) {
    const stage = extractLoopStage(p.content);
    if (stage) justified.push({ path: p.path, stage });
    else if (isRegistryClassified(p.path)) justified.push({ path: p.path, stage: "registry" });
    else violations.push({ path: p.path });
  }
  return { ok: violations.length === 0, violations, justified };
}

// Is this added path a public, user-facing HTML surface? (skip partials/components)
export function isPublicSurface(relPath) {
  if (!relPath.startsWith(PUBLIC_PREFIX) || !relPath.endsWith(".html")) return false;
  if (/\/(partials|components|fragments)\//.test(relPath)) return false;
  // Top-level surfaces only — the Σ₀ registry governs public/*.html, not nested
  // bundled mini-apps (e.g. games/2048/index.html), which are gated at the cluster
  // level by their extension module. A nested index.html is a bundle asset, not a
  // first-class loop surface.
  const rest = relPath.slice(PUBLIC_PREFIX.length);
  return !rest.includes("/");
}

// ── CLI shell ───────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const all = args.includes("--all");
  const baseIdx = args.indexOf("--base");
  const base = baseIdx >= 0 ? args[baseIdx + 1] : "origin/master";
  const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
  // Intentional CLI stdout (not debug logging) — keeps the repo's console.log debug gate clean.
  const print = (s) => process.stdout.write(`${s}\n`);

  let paths = [];
  if (all) {
    paths = execSync(`git -C "${repoRoot}" ls-files "${PUBLIC_PREFIX}*.html"`, { encoding: "utf8" })
      .split("\n").map((s) => s.trim()).filter(isPublicSurface);
  } else {
    let added = "";
    try { added = execSync(`git -C "${repoRoot}" diff --name-only --diff-filter=A ${base}...HEAD`, { encoding: "utf8" }); }
    catch (e) { console.error(`[sprawl-tripwire] could not diff against ${base}: ${e.message}`); process.exit(0); }
    paths = added.split("\n").map((s) => s.trim()).filter(isPublicSurface);
  }

  const pages = paths.map((rel) => {
    const full = join(repoRoot, rel);
    return { path: rel, content: existsSync(full) ? readFileSync(full, "utf8") : "" };
  });

  const result = evaluateSurfaces(pages);
  if (json) { print(JSON.stringify(result, null, 2)); process.exit(result.ok ? 0 : 1); }

  if (all) {
    print(`[sprawl-tripwire] ${pages.length} public surfaces; ${result.justified.length} declare a loop stage, ${result.violations.length} do not.`);
    for (const v of result.violations) print(`  (undeclared) ${v.path}`);
    process.exit(0); // advisory in --all mode
  }

  if (!pages.length) { print("[sprawl-tripwire] no new public surfaces in this PR — ok."); process.exit(0); }
  if (result.ok) {
    print(`[sprawl-tripwire] ${pages.length} new surface(s), all justified:`);
    for (const j of result.justified) print(`  ✓ ${j.path} → ${j.stage}`);
    process.exit(0);
  }
  console.error(`[sprawl-tripwire] FAIL — ${result.violations.length} new public surface(s) lack a loop-stage justification:`);
  for (const v of result.violations) console.error(`  ✗ ${v.path}`);
  console.error(`\nEvery new surface must declare which loop stage it strengthens. Add to the page:`);
  console.error(`  <meta name="loop-stage" content="${VALID_STAGES.join("|")}">`);
  console.error(`or a  <!-- loop-stage: <stage> -->  comment. This keeps scope from silently regrowing (#1561).`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
