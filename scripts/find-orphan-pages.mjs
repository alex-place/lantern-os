#!/usr/bin/env node
/**
 * find-orphan-pages — report public HTML pages NOT reachable from index.html.
 *
 * Builds a link graph over apps/lantern-garage/public and BFS's from index.html.
 * A page is an edge target if it is referenced by an href/src or a quoted "*.html"
 * string in either (a) the page's own HTML (covers inline <script> nav) or (b) any
 * local <script src> the page loads (covers shared nav: site-chrome.js,
 * common-layout.js, auth-gate.js, …). Extensionless hrefs (/explore) resolve to a
 * file (explore.html) only when that file exists, so API paths never create edges.
 *
 * Anything not reached from index.html (directly or transitively) is an orphan.
 *
 * Usage:
 *   node scripts/find-orphan-pages.mjs           # report; exit 1 if orphans exist
 *   node scripts/find-orphan-pages.mjs --json
 *
 * Limitations (reported, not deleted): pages reachable only via a server route or
 * redirect, or via a JS link built by string concatenation, can't be seen here and
 * will show as orphans — that is correct for "linked back to index", but verify
 * before deleting.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, sep, posix, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const PUBLIC = join(REPO_ROOT, "apps", "lantern-garage", "public");
const START = "index.html";

const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const allFiles = walk(PUBLIC);
const toRel = (abs) => relative(PUBLIC, abs).split(sep).join("/");
const htmlFiles = new Set(allFiles.filter((f) => f.toLowerCase().endsWith(".html")).map(toRel));
const fileText = (rel) => {
  try { return readFileSync(join(PUBLIC, rel), "utf8"); } catch { return ""; }
};

// Resolve a referenced path to an existing HTML node rel-path, or null.
function resolveRef(ref, fromRel) {
  let r = ref.trim().split("#")[0].split("?")[0];
  if (!r || /^(https?:)?\/\//i.test(r) || /^(mailto|tel|javascript|data):/i.test(r)) return null;
  let p = r.startsWith("/") ? r.slice(1) : posix.normalize(posix.join(posix.dirname(fromRel), r));
  p = p.replace(/^\/+/, "");
  const candidates = [];
  if (/\.html$/i.test(p)) candidates.push(p);
  else {
    if (p === "" ) candidates.push("index.html");
    candidates.push(p + ".html");
    candidates.push((p.replace(/\/$/, "") + "/index.html").replace(/^\//, ""));
  }
  return candidates.find((c) => htmlFiles.has(c)) || null;
}

const ATTR_RE = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
const HTML_STR_RE = /["']([^"'\n]*?\.html(?:[#?][^"'\n]*)?)["']/gi;
const SCRIPT_SRC_RE = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

function refsFromText(text, re, group = 1) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) out.push(m[group]);
  return out;
}

// Outgoing edges for an HTML page: its own href/src + quoted *.html (inline scripts),
// plus quoted *.html from every local <script src> it loads (shared nav).
function edgesOf(rel) {
  const html = fileText(rel);
  const refs = [...refsFromText(html, ATTR_RE), ...refsFromText(html, HTML_STR_RE)];
  for (const src of refsFromText(html, SCRIPT_SRC_RE)) {
    const jsRel = resolveLocalAsset(src, rel);
    if (jsRel) refs.push(...refsFromText(fileText(jsRel), HTML_STR_RE));
  }
  const targets = new Set();
  for (const ref of refs) {
    const node = resolveRef(ref, rel);
    if (node) targets.add(node);
  }
  return targets;
}

// Resolve a <script src> to a rel path of an existing file under public/.
function resolveLocalAsset(src, fromRel) {
  let r = src.trim().split("#")[0].split("?")[0];
  if (!r || /^(https?:)?\/\//i.test(r)) return null;
  let p = r.startsWith("/") ? r.slice(1) : posix.normalize(posix.join(posix.dirname(fromRel), r));
  p = p.replace(/^\/+/, "");
  try { statSync(join(PUBLIC, p)); return p; } catch { return null; }
}

// BFS from index.html
const reached = new Set([START]);
const queue = [START];
while (queue.length) {
  const cur = queue.shift();
  for (const next of edgesOf(cur)) {
    if (!reached.has(next)) { reached.add(next); queue.push(next); }
  }
}

const orphans = [...htmlFiles].filter((f) => !reached.has(f)).sort();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ total: htmlFiles.size, reachable: reached.size, orphans }, null, 2));
  process.exit(orphans.length ? 1 : 0);
}

console.log(`Scanned ${htmlFiles.size} HTML pages under public/ — ${reached.size} reachable from index.html.\n`);
if (orphans.length === 0) {
  console.log("✓ No orphan pages: every page is linked back to index.html (directly or indirectly).");
  process.exit(0);
}
console.log(`⚠ ${orphans.length} page(s) NOT linked back to index.html:\n`);
for (const o of orphans) console.log(`  ${o}`);
console.log(
  "\nNote: a page may still be reachable via a server route/redirect or a JS-built link\n" +
  "(this graph only follows static href/src + quoted *.html). Verify before deleting.\n"
);
process.exit(1);
