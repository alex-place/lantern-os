#!/usr/bin/env node
/**
 * no-keyword-intent-routing — ban deterministic KEYWORD intent-routing from the chat surface.
 *
 * The chat used to catch keywords/regex BEFORE the model ran and return canned responses
 * ("world news" → "Now playing — Super Mario World"). Those pre-LLM intercepts + the
 * keyword intent classifiers were removed: every message now flows to the LLM, which
 * decides capabilities via native tool calls (tool-runner.js). This guard stops the
 * pattern from silently regrowing.
 *
 * It scans ONLY the lines a PR ADDS under  (excluding test/), so
 * existing/allowlisted code is never retroactively flagged. It bans:
 *   • re-import of the deleted keyword routers (intent-router, convergance-os/model-router,
 *     task-detector)
 *   • a keyword `classifyIntent(` call/def, or an `INTENT_PATTERNS` keyword table
 *   • a `triggers: [ /regex/ , … ]` capability-trigger array (intent-router shape)
 *   • new pre-LLM message intercepts in the chat UI: `function parse*Request(` /
 *     `function detect*Intent(` / `function detectEmbed*(`
 *
 * It explicitly ALLOWS the legitimate MODEL-based / measured routers — these are the
 * frontier "model separation", not keyword catching:
 *   • ouro-router.js         (classifyIntentOuro — a real model call)
 *   • provider-router.js     (measured PCSF ordering)
 *   • local-model-registry.js(capability / VRAM / verified gating)
 *   • route-contract.js      (deterministic policy on an already-computed intent)
 * and it never matches `classifyIntentOuro(` (the model router).
 *
 * Usage:
 *   node scripts/no-keyword-intent-routing.mjs                 # diff origin/master...HEAD; exit 1 on a violation
 *   node scripts/no-keyword-intent-routing.mjs --base <ref>    # diff against a different base
 *   node scripts/no-keyword-intent-routing.mjs --json
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE = ".";
// Files where these tokens are legitimate (model/measured routers, or this guard's own docs).
export const ALLOWLIST = [
  "lib/ouro-router.js",
  "lib/provider-router.js",
  "lib/local-model-registry.js",
  "lib/route-contract.js",
];
// Test dirs are excluded (they assert the ban and name the banned modules).
const isExcluded = (file) =>
  ALLOWLIST.includes(file) ||
  /\/(test|tests|__tests__)\//.test(file) ||
  /\.test\.(js|mjs)$/.test(file);

// Each rule: a label + a regex matched against a single ADDED line.
export const RULES = [
  {
    id: "keyword-router-import",
    re: /require\(\s*['"][^'"]*(?:intent-router|convergance-os\/model-router|task-detector)['"]\s*\)/,
    msg: "imports a deleted KEYWORD intent router (intent-router / model-router / task-detector).",
  },
  {
    // classifyIntent(  — but NOT classifyIntentOuro( (the model-based router, allowed).
    id: "classify-intent-call",
    re: /\bclassifyIntent(?!Ouro)\w*\s*\(/,
    msg: "calls/defines a keyword `classifyIntent(` — route on the model + tools, not message keywords.",
  },
  {
    id: "intent-patterns-table",
    re: /\bINTENT_PATTERNS\b/,
    msg: "declares an `INTENT_PATTERNS` keyword table — keyword intent classification is banned.",
  },
  {
    id: "capability-triggers-array",
    re: /\btriggers\s*:\s*\[/,
    msg: "declares a `triggers: [ /regex/ ]` capability array (intent-router shape).",
  },
  {
    id: "pre-llm-intercept-fn",
    re: /function\s+(?:parse\w*Request|detectEmbed\w*|detect\w*Intent)\s*\(/,
    msg: "defines a pre-LLM message intercept (parse*Request / detect*Intent / detectEmbed*) — the model decides capabilities via tools.",
  },
];

// Pure evaluation: given [{ file, line, text }] added lines, return violations.
export function evaluateAddedLines(added) {
  const violations = [];
  for (const a of added || []) {
    if (isExcluded(a.file)) continue;
    for (const rule of RULES) {
      if (rule.re.test(a.text)) violations.push({ file: a.file, line: a.line, rule: rule.id, msg: rule.msg, text: a.text.trim().slice(0, 160) });
    }
  }
  return { ok: violations.length === 0, violations };
}

// Parse a `git diff --unified=0` into added lines with file + new-line-number.
export function parseAddedLines(diff) {
  const out = [];
  let file = null, newLine = 0;
  for (const raw of String(diff || "").split("\n")) {
    if (raw.startsWith("+++ b/")) { file = raw.slice(6).trim(); continue; }
    const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { newLine = parseInt(h[1], 10); continue; }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (file && file.startsWith(SCOPE + "/")) out.push({ file, line: newLine, text: raw.slice(1) });
      newLine++;
    } else if (!raw.startsWith("-") && !raw.startsWith("\\")) {
      newLine++;
    }
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const baseIdx = args.indexOf("--base");
  const base = baseIdx >= 0 ? args[baseIdx + 1] : "origin/master";
  const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
  const print = (s) => process.stdout.write(`${s}\n`);

  let diff = "";
  try {
    diff = execSync(`git -C "${repoRoot}" diff --unified=0 ${base}...HEAD -- ${SCOPE}`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    console.error(`[no-keyword-intent-routing] could not diff against ${base}: ${e.message}`);
    process.exit(0); // never block on a diff failure (e.g. shallow clone)
  }

  const result = evaluateAddedLines(parseAddedLines(diff));
  if (json) { print(JSON.stringify(result, null, 2)); process.exit(result.ok ? 0 : 1); }

  if (result.ok) { print("[no-keyword-intent-routing] ok — no deterministic keyword intent-routing added."); process.exit(0); }

  console.error(`[no-keyword-intent-routing] FAIL — ${result.violations.length} keyword intent-routing pattern(s) added:`);
  for (const v of result.violations) console.error(`  ✗ ${v.file}:${v.line} [${v.rule}] ${v.msg}\n      ${v.text}`);
  console.error(`\nThe chat routes capabilities through the model's native tool calls, not message keywords.`);
  console.error(`If this is a legitimate MODEL-based / measured router, add its file to ALLOWLIST in`);
  console.error(`scripts/no-keyword-intent-routing.mjs. Bypass (last resort): SKIP_INTENT_ROUTING_CHECK=1.`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
