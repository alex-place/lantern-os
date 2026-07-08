#!/usr/bin/env node
/**
 * WCAG-AA audit across every public/*.html surface, BOTH themes (#2251).
 *
 * Dependency-free (no jsdom): static structural checks per surface + token-level contrast
 * from css/site.css for light AND dark. Emits a per-surface pass/fail report and hard-fails
 * on (a) any contrast failure and (b) any structural issue on a curated CLEAN_SET, so the
 * priority surfaces are gated against regressions while the rest are reported for the backlog.
 *
 * Structural checks: <html lang>, non-empty <title>, exactly one <h1>, every <img> has an
 * alt (or aria-hidden / role=presentation), a <main> (or role=main) landmark. Form-label and
 * focus-visible depth stays with the jsdom suite (scripts/test-a11y.js) + running-page audit.
 */

const fs = require("fs");
const path = require("path");

const PUBLIC = path.join(__dirname, "..", "apps", "lantern-garage", "public");
const SITE_CSS = path.join(PUBLIC, "css", "site.css");
const MIN_AA = 4.5;        // normal text
const MIN_AA_LARGE = 3.0;  // large text / UI

// Surfaces that MUST be structurally clean — regressions here fail CI. The rest are audited
// and reported but not yet gated (backlog). Grow this set as surfaces are remediated.
const CLEAN_SET = new Set([
  "index.html", "pricing.html", "entry.html", "faq.html",
  "knowledgecenter.html", "agent-leaderboard.html", "metrics.html",
]);

// ── contrast math ──────────────────────────────────────────────────────────
const hexToRgb = (h) => {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h);
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
};
const lum = ({ r, g, b }) => {
  const [R, G, B] = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
};
const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

function themeTokens() {
  const css = fs.readFileSync(SITE_CSS, "utf8");
  const grab = (re) => { const m = css.match(re); const out = {}; if (!m) return out;
    for (const kv of m[1].matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) out[kv[1]] = kv[2]; return out; };
  return {
    light: grab(/:root\s*\{([\s\S]*?)\}/),
    dark: grab(/\[data-theme="dark"\]\s*\{([\s\S]*?)\}/),
  };
}

// Text pairs that must meet AA (normal). accent-strong-as-text is the AA-safe link/heading color.
const TEXT_PAIRS = [["text", "bg"], ["text", "surface"], ["text", "surface2"], ["muted", "bg"], ["muted", "surface"], ["accent-strong", "surface"]];
// Filled primary buttons: what color the button text is in each theme (site.css: white in light,
// var(--bg) dark text in dark) sitting on --accent-strong. Must meet AA (4.5) as real text.
const BUTTON_TEXT = { light: "#ffffff", dark: null /* = --bg */ };

function auditContrast() {
  const { light, dark } = themeTokens();
  const fails = [];   // hard gate
  const warns = [];   // reported, not gated
  for (const [theme, tok] of [["light", light], ["dark", dark]]) {
    for (const [fg, bg] of TEXT_PAIRS) {
      if (!tok[fg] || !tok[bg]) continue;
      const r = ratio(hexToRgb(tok[fg]), hexToRgb(tok[bg]));
      if (r < MIN_AA) fails.push(`${theme}: --${fg} (${tok[fg]}) on --${bg} (${tok[bg]}) = ${r.toFixed(2)}:1 < ${MIN_AA}`);
    }
    // Primary filled button composition.
    const btnFg = BUTTON_TEXT[theme] || tok.bg;
    if (tok["accent-strong"] && btnFg) {
      const r = ratio(hexToRgb(btnFg), hexToRgb(tok["accent-strong"]));
      if (r < MIN_AA) fails.push(`${theme}: filled-button text ${btnFg} on --accent-strong (${tok["accent-strong"]}) = ${r.toFixed(2)}:1 < ${MIN_AA}`);
    }
    // Bright --accent as a graphical/border color on --bg (WCAG 1.4.11, 3:1). Fixing this means
    // darkening the global brand accent (site-wide visual change) — reported for the backlog.
    if (tok.accent && tok.bg) {
      const r = ratio(hexToRgb(tok.accent), hexToRgb(tok.bg));
      if (r < MIN_AA_LARGE) warns.push(`${theme}: --accent (${tok.accent}) on --bg (${tok.bg}) = ${r.toFixed(2)}:1 < ${MIN_AA_LARGE} (graphical; needs global accent darkening)`);
    }
  }
  return { fails, warns };
}

// ── structural checks ──────────────────────────────────────────────────────
function auditSurface(file) {
  const html = fs.readFileSync(path.join(PUBLIC, file), "utf8");
  const issues = [];
  if (!/<html[^>]*\blang\s*=/i.test(html)) issues.push("<html> missing lang");
  if (!/<title>\s*\S[\s\S]*?<\/title>/i.test(html)) issues.push("empty or missing <title>");
  const h1 = (html.match(/<h1[\s>]/gi) || []).length;
  if (h1 === 0) issues.push("no <h1>");
  else if (h1 > 1) issues.push(`multiple <h1> (${h1})`);
  if (!/<main[\s>]/i.test(html) && !/role\s*=\s*["']main["']/i.test(html)) issues.push("no <main> landmark");
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    if (!/\balt\s*=/i.test(tag) && !/aria-hidden\s*=\s*["']true["']/i.test(tag) && !/role\s*=\s*["']presentation["']/i.test(tag)) {
      issues.push(`<img> without alt: ${(tag.match(/src\s*=\s*["']([^"']+)/i) || [])[1] || tag.slice(0, 60)}`);
    }
  }
  return issues;
}

// ── run ────────────────────────────────────────────────────────────────────
const files = fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".html")).sort();
const { fails: contrastFails, warns: contrastWarns } = auditContrast();

console.log("── WCAG-AA audit (#2251) ──\n");
console.log("Token contrast (both themes):");
if (contrastFails.length) contrastFails.forEach((f) => console.log("  ✗ " + f));
else console.log("  ✓ text pairs + filled-button composition meet AA in light + dark");
if (contrastWarns.length) { console.log("  reported (backlog, not gated):"); contrastWarns.forEach((w) => console.log("  ⚠ " + w)); }

let cleanSetIssues = 0, totalIssues = 0;
const report = [];
for (const f of files) {
  const issues = auditSurface(f);
  totalIssues += issues.length;
  const gated = CLEAN_SET.has(f);
  if (gated) cleanSetIssues += issues.length;
  report.push({ f, issues, gated });
}

console.log("\nPer-surface structural report (★ = gated clean-set):");
for (const { f, issues, gated } of report) {
  const tag = gated ? "★" : " ";
  if (issues.length) console.log(`  ${tag} ✗ ${f}\n${issues.map((i) => "        - " + i).join("\n")}`);
  else console.log(`  ${tag} ✓ ${f}`);
}

console.log(`\nSummary: ${files.length} surfaces · ${totalIssues} structural issues · ` +
  `${cleanSetIssues} on gated clean-set · ${contrastFails.length} contrast failures`);

if (contrastFails.length || cleanSetIssues) {
  console.log("\n✗ A11Y GATE FAILED (contrast, or a clean-set surface regressed)");
  process.exit(1);
}
console.log("\n✓ A11Y gate passed (contrast AA in both themes; clean-set surfaces structurally sound)");
