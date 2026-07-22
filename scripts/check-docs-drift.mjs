#!/usr/bin/env node
/**
 * check-docs-drift — fail when a canonical entry doc references a public surface
 * that no longer exists as a real page.
 *
 * The mirror of the sprawl tripwire (find-orphan-pages.mjs): that gate fails on NEW
 * undeclared surfaces; this one fails on REMOVED/RENAMED ones still cited in the docs
 * a new operator reads first. Motivating incident (#2811): the chat.html rename (#2751)
 * left eleven stale `dream-chat.html` references across README/CLAUDE/QUICKSTART/AGENTS
 * for a week — including the testing charter targeting the redirect stub.
 *
 * A reference is DRIFT when the surface it names either:
 *   - does not exist under apps/lantern-garage/public/  (removed surface), or
 *   - exists only as a redirect stub                    (renamed surface — the doc
 *     points at the stub, not the live page).
 * A reference is EXEMPT when its line is an explicitly-marked legacy note (mentions
 * legacy / redirect / renamed / former / moved / deprecated, or carries an inline
 * `<!-- drift-ok -->` marker) — so "legacy `dream-chat.html` redirects" is fine.
 *
 * What counts as a surface reference (kept tight to avoid false positives on unrelated
 * `.html` mentions like coverage reports): a `.html` token whose path is root-absolute
 * (`/foo.html`), lives under `public/`, or whose basename already exists as a page or
 * stub under public/. External URLs are stripped first, so `https://x.com/a.html` never
 * counts.
 *
 * Usage:
 *   node scripts/check-docs-drift.mjs           # scan the four canonical docs; exit 1 on drift
 *   node scripts/check-docs-drift.mjs --json
 *
 * Importable for tests: `import { scanDocs } from "./check-docs-drift.mjs"`.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");

// The four canonical entry docs — the surfaces a new operator/agent reads first, and
// where the #2811 incident happened. Scoped deliberately: historical docs/, ADRs and
// changelog fragments legitimately name old surfaces in past tense.
export const CANONICAL_DOCS = ["README.md", "CLAUDE.md", "AGENTS.md", "QUICKSTART.md"];

const LEGACY_MARKER =
  /\b(legacy|redirect(s|ed|ing)?|renamed|former(ly)?|old path|moved to|deprecated)\b|<!--\s*drift-ok/i;

// Any `.html` token with an optional leading path. Group 1 = full path, group 2 = name.
const HTML_REF = /((?:\/|[\w.-]+\/)*)([\w-]+\.html)\b/g;

// Match every HTML reference on a line (String.matchAll, not a stateful .exec loop).
function htmlRefs(line) {
  return [...line.matchAll(HTML_REF)].map((m) => ({ prefix: m[1] || "", name: m[2] }));
}

function isRedirectStub(html) {
  // The canonical stub carries a meta-refresh; a tiny location.replace() body is the
  // JS-only variant. Full content pages have neither (a large page that happens to call
  // location.replace for a feature is excluded by the size floor).
  if (/<meta[^>]+http-equiv=["']?refresh["']?[^>]*\burl=/i.test(html)) return true;
  if (/location\.replace\(/i.test(html) && html.length < 1500) return true;
  return false;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] repository root (defaults to this file's repo)
 * @param {string} [opts.publicDir] absolute path to the public surface dir
 * @param {string[]} [opts.docs]    doc paths relative to repoRoot
 * @returns {{doc:string, line:number, ref:string, surface:string, reason:'missing'|'stub'}[]}
 */
export function scanDocs(opts = {}) {
  const repoRoot = opts.repoRoot || REPO_ROOT;
  const publicDir = opts.publicDir || join(repoRoot, "apps", "lantern-garage", "public");
  const docs = opts.docs || CANONICAL_DOCS;

  const surfacePath = (name) => join(publicDir, basename(name));
  const surfaceExists = (name) => {
    const p = surfacePath(name);
    try { return statSync(p).isFile(); } catch { return false; }
  };

  const findings = [];
  for (const doc of docs) {
    const abs = join(repoRoot, doc);
    if (!existsSync(abs)) continue;
    const lines = readFileSync(abs, "utf8").split(/\r?\n/);
    lines.forEach((raw, i) => {
      // Strip external URLs so their path segments never look like local surfaces.
      const line = raw.replace(/https?:\/\/\S+/g, "");
      const exempt = LEGACY_MARKER.test(raw);
      for (const { prefix, name } of htmlRefs(line)) {
        const rootAbsolute = prefix.startsWith("/");
        const underPublic = /(^|\/)public\//.test(prefix);
        const known = surfaceExists(name);
        // Only treat it as a surface reference if we're confident it names one.
        if (!rootAbsolute && !underPublic && !known) continue;
        if (exempt) continue;
        if (!known) {
          findings.push({ doc, line: i + 1, ref: prefix + name, surface: name, reason: "missing" });
        } else if (isRedirectStub(readFileSync(surfacePath(name), "utf8"))) {
          findings.push({ doc, line: i + 1, ref: prefix + name, surface: name, reason: "stub" });
        }
      }
    });
  }
  return findings;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function run() {
  const json = process.argv.includes("--json");
  const findings = scanDocs();
  if (json) {
    console.log(JSON.stringify({ findings, drift: findings.length }, null, 2));
    process.exit(findings.length ? 1 : 0);
  }
  if (findings.length === 0) {
    console.log(`✓ docs-drift: every public-surface reference in ${CANONICAL_DOCS.join(", ")} resolves to a live page.`);
    process.exit(0);
  }
  console.log(`⚠ docs-drift: ${findings.length} reference(s) point at a removed or renamed surface:\n`);
  for (const f of findings) {
    const why = f.reason === "stub"
      ? "is only a redirect stub (renamed) — point at the live page"
      : "does not exist under apps/lantern-garage/public/ (removed)";
    console.log(`  ${f.doc}:${f.line}  ${f.ref}  →  ${f.surface} ${why}`);
  }
  console.log(
    "\nFix the reference to the live surface, or — if it is a deliberate historical note —\n" +
    "mark the line as legacy (mention legacy/redirect/renamed, or add <!-- drift-ok -->).\n"
  );
  process.exit(1);
}

// Run only when invoked directly (not when imported by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run();
}
