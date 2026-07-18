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
import { execFileSync } from "node:child_process";
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

// ── New-.py wiring gate (#2542) ─────────────────────────────────────────────────
// The Python scripts audit found 116 orphan .py files — 97 from ONE bulk import
// that nothing ever wired up. This gate stops the orphan count from regrowing:
// a NEWLY ADDED .py outside tests/ + experiments/ must be referenced by at least
// one ANCHOR surface — server JS (apps/), the MCP server, a CI workflow, Makefile,
// package.json, scripts/hooks/, a tracked .ps1/.sh launcher, the SCRIPTS.md ops
// registry (#2537) — or be imported by an ALREADY-EXISTING .py module. Two new
// orphans can't vouch for each other. Existing files are grandfathered.
// Escape hatch (same as the surface gate): SKIP_SPRAWL_CHECK=1 git push …

const PY_EXEMPT = [/^tests\//, /^experiments\//];
// Non-python anchor surfaces, as git pathspecs. A reference here = wired.
const PY_ANCHOR_PATHSPECS = [
  "apps", "src/mcp_server", ".github/workflows", "scripts/hooks",
  "Makefile", "package.json", "apps/lantern-garage/package.json",
  "SCRIPTS.md", "*.ps1", "*.sh",
];

export function isCheckedPy(relPath) {
  const p = String(relPath || "").replace(/\\/g, "/");
  if (!p.endsWith(".py")) return false;
  if (PY_EXEMPT.some((re) => re.test(p))) return false;
  if (basename(p) === "__init__.py") return false; // package markers carry no logic to wire
  return true;
}

function gitGrepFiles(repoRoot, args) {
  try {
    return execFileSync("git", ["-C", repoRoot, "grep", "-l", ...args], { encoding: "utf8" })
      .split("\n").map((s) => s.trim().replace(/\\/g, "/")).filter(Boolean);
  } catch {
    return []; // git grep exits 1 on no matches
  }
}

/** Which anchor (if any) wires this new .py? Returns a human-readable anchor path or null. */
export function pyAnchorFor(relPath, addedSet, repoRoot) {
  const p = relPath.replace(/\\/g, "/");
  const file = basename(p);                       // e.g. foo_bar.py
  const mod = file.slice(0, -3);                  // e.g. foo_bar
  // 1. Any anchor surface mentioning the filename (or its repo path).
  const surfaceHits = gitGrepFiles(repoRoot, ["-F", file, "--", ...PY_ANCHOR_PATHSPECS])
    .filter((f) => f !== p && !addedSet.has(f));
  if (surfaceHits.length) return surfaceHits[0];
  // 2. A python import from a module that already existed before this PR.
  //    POSIX ERE (git grep -E): match `import x[.y…].<mod>` / `from x.<mod> import …`
  //    with non-word boundaries (\b is not ERE).
  const importRe = `(from|import)[ \t]+([A-Za-z0-9_.]+\\.)?${mod}([^A-Za-z0-9_]|$)`;
  const importHits = gitGrepFiles(repoRoot, ["-E", importRe, "--", "*.py"])
    .filter((f) => f !== p && !addedSet.has(f) && !PY_EXEMPT.some((re) => re.test(f)));
  if (importHits.length) return importHits[0];
  return null;
}

/** Pure-ish evaluation over the PR's added .py files. */
export function evaluateNewPy(pyPaths, repoRoot) {
  const addedSet = new Set(pyPaths.map((s) => s.replace(/\\/g, "/")));
  const violations = [], wired = [];
  for (const p of pyPaths) {
    const anchor = pyAnchorFor(p, addedSet, repoRoot);
    if (anchor) wired.push({ path: p, anchor });
    else violations.push({ path: p });
  }
  return { ok: violations.length === 0, violations, wired };
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
  let addedPy = [];
  if (all) {
    // Arg-array exec (no shell interpolation) — same convention as gitGrepFiles.
    paths = execFileSync("git", ["-C", repoRoot, "ls-files", `${PUBLIC_PREFIX}*.html`], { encoding: "utf8" })
      .split("\n").map((s) => s.trim()).filter(isPublicSurface);
  } else {
    let added = "";
    try { added = execFileSync("git", ["-C", repoRoot, "diff", "--name-only", "--diff-filter=A", `${base}...HEAD`], { encoding: "utf8" }); }
    catch (e) { console.error(`[sprawl-tripwire] could not diff against ${base}: ${e.message}`); process.exit(0); }
    const addedList = added.split("\n").map((s) => s.trim()).filter(Boolean);
    paths = addedList.filter(isPublicSurface);
    addedPy = addedList.filter(isCheckedPy);
  }

  const pages = paths.map((rel) => {
    const full = join(repoRoot, rel);
    return { path: rel, content: existsSync(full) ? readFileSync(full, "utf8") : "" };
  });

  const result = evaluateSurfaces(pages);
  const pyResult = all ? { ok: true, violations: [], wired: [] } : evaluateNewPy(addedPy, repoRoot);
  if (json) {
    print(JSON.stringify({ ...result, py: pyResult }, null, 2));
    process.exit(result.ok && pyResult.ok ? 0 : 1);
  }

  if (all) {
    print(`[sprawl-tripwire] ${pages.length} public surfaces; ${result.justified.length} declare a loop stage, ${result.violations.length} do not.`);
    for (const v of result.violations) print(`  (undeclared) ${v.path}`);
    process.exit(0); // advisory in --all mode
  }

  // ── surface gate report ──
  if (!pages.length) print("[sprawl-tripwire] no new public surfaces in this PR — ok.");
  else if (result.ok) {
    print(`[sprawl-tripwire] ${pages.length} new surface(s), all justified:`);
    for (const j of result.justified) print(`  ✓ ${j.path} → ${j.stage}`);
  } else {
    console.error(`[sprawl-tripwire] FAIL — ${result.violations.length} new public surface(s) lack a loop-stage justification:`);
    for (const v of result.violations) console.error(`  ✗ ${v.path}`);
    console.error(`\nEvery new surface must declare which loop stage it strengthens. Add to the page:`);
    console.error(`  <meta name="loop-stage" content="${VALID_STAGES.join("|")}">`);
    console.error(`or a  <!-- loop-stage: <stage> -->  comment. This keeps scope from silently regrowing (#1561).`);
  }

  // ── new-.py wiring gate report (#2542) ──
  if (!addedPy.length) print("[sprawl-tripwire] no new checked .py files in this PR — ok.");
  else if (pyResult.ok) {
    print(`[sprawl-tripwire] ${addedPy.length} new .py file(s), all wired:`);
    for (const w of pyResult.wired) print(`  ✓ ${w.path} ← ${w.anchor}`);
  } else {
    console.error(`[sprawl-tripwire] FAIL — ${pyResult.violations.length} new .py file(s) are wired to nothing (#2542):`);
    for (const v of pyResult.violations) console.error(`  ✗ ${v.path}`);
    console.error(`\nA new .py outside tests/ + experiments/ must be referenced by an anchor —`);
    console.error(`server JS (apps/), the MCP server, a CI workflow, Makefile, package.json,`);
    console.error(`scripts/hooks/, a tracked .ps1/.sh launcher, SCRIPTS.md — or imported by an`);
    console.error(`already-existing .py. 97 of the audit's 116 orphans came from one unwired bulk`);
    console.error(`import (docs/PYTHON-SCRIPTS-AUDIT-2026-07-16.md); this keeps that from recurring.`);
  }

  process.exit(result.ok && pyResult.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
