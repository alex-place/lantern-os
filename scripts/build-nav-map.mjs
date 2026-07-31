#!/usr/bin/env node
/**
 * build-nav-map.mjs — derive the site's navigation graph from the shipped HTML.
 *
 * Parses every page under apps/lantern-garage/public/, extracts same-site
 * <a href="*.html"> edges, computes click-reachability from index.html, and
 * diffs that against sitemap.xml. Emits tests/e2e-sitemap/nav-map.json, which
 * is the data the sitemap-nav Playwright spec drives itself from.
 *
 * The map is generated, never hand-edited — regenerate it after any nav change
 * so the spec tests the site as it actually is:
 *
 *   npm run navmap
 *
 * Related: docs/SITEMAP-NAV-MAP.md (flowchart + runbook), issues #3107 / #3109.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'apps', 'lantern-garage', 'public');
const OUT_FILE = path.join(REPO_ROOT, 'tests', 'e2e-sitemap', 'nav-map.json');
const ROOT_PAGE = 'index.html';

/**
 * Links we deliberately do not treat as navigation.
 *
 * chat.html's Knowledge Center link lives inside a post-upload confirmation
 * string ("Added to your Knowledge Center — view & search"). It only renders
 * after a successful PDF upload, so counting it would make KC look one click
 * closer to the home page than a user can actually get. See #3107.
 */
const NON_NAV_EDGES = [{ from: 'chat.html', to: 'knowledgecenter.html' }];

const isExcluded = (from, to) =>
  NON_NAV_EDGES.some((e) => e.from === from && e.to === to);

/**
 * Strip <script>/<style> bodies so hrefs inside JS strings don't count as nav.
 *
 * Scanned rather than regex-matched. A regex of the shape
 * `/<script\b[^>]*>[\s\S]*?<\/script>/` is what CodeQL's js/bad-tag-filter warns
 * about: the variants it misses (`</script >`, odd casing) make it UNDER-match,
 * which here would leak script bodies into the link scan and invent nav edges
 * that no user can click. Walking the string handles those cases directly, and
 * an unclosed tag drops the remainder rather than silently keeping it.
 */
function stripCode(html) {
  for (const tag of ['script', 'style']) {
    let out = '';
    let rest = html;
    for (;;) {
      const lower = rest.toLowerCase();
      const open = lower.indexOf(`<${tag}`);
      // Must be a real tag boundary, not a prefix like <scriptish>.
      if (open === -1 || !/[\s>/]/.test(rest[open + tag.length + 1] || '')) { out += rest; break; }
      const bodyStart = rest.indexOf('>', open);
      if (bodyStart === -1) { out += rest.slice(0, open); break; } // malformed → drop the tail
      const close = lower.indexOf(`</${tag}`, bodyStart);
      out += `${rest.slice(0, open)} `;
      if (close === -1) break; // unclosed → everything after it is code
      const closeEnd = rest.indexOf('>', close);
      if (closeEnd === -1) break;
      rest = rest.slice(closeEnd + 1);
    }
    html = out;
  }
  return html;
}

/**
 * The shared top nav is injected at runtime by js/site-chrome.js from its
 * NAV_LINKS array, so it never appears in a page's static markup. Ignoring it
 * would understate reachability badly — every page carrying the script really
 * does render those links, and a browser can click them.
 *
 * Returns the NAV_LINKS hrefs so buildGraph can attribute them to each page
 * that loads site-chrome.js.
 */
function sharedNavTargets() {
  const file = path.join(PUBLIC_DIR, 'js', 'site-chrome.js');
  if (!fs.existsSync(file)) return [];
  const src = fs.readFileSync(file, 'utf8');
  const block = src.match(/NAV_LINKS\s*=\s*\[([\s\S]*?)\]/);
  if (!block) return [];
  return [...block[1].matchAll(/href:\s*"\/?([a-zA-Z0-9_-]+\.html)"/g)].map((m) => m[1]);
}

const SHARED_NAV = sharedNavTargets();

function buildGraph(pages) {
  const graph = {};
  for (const page of pages) {
    const raw = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8');
    const markup = stripCode(raw);
    const hrefs = [...markup.matchAll(/href="\/?([a-zA-Z0-9_-]+\.html)"/g)].map((m) => m[1]);
    // Pages that load site-chrome.js also render the shared nav at runtime.
    const injected = /src="[^"]*site-chrome\.js"/.test(raw) ? SHARED_NAV : [];
    graph[page] = [...new Set([...hrefs, ...injected])].filter(
      (target) => target !== page && pages.includes(target) && !isExcluded(page, target),
    ).sort();
  }
  return graph;
}

/** BFS from the home page — depth is literal click count for a real user. */
function reachability(graph, root) {
  const depth = { [root]: 0 };
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    for (const next of graph[current] || []) {
      if (depth[next] === undefined) {
        depth[next] = depth[current] + 1;
        queue.push(next);
      }
    }
  }
  return depth;
}

/** First shortest click path root -> target, as a list of page names. */
function shortestPath(graph, depth, root, target) {
  if (depth[target] === undefined) return null;
  const path = [target];
  let cursor = target;
  while (cursor !== root) {
    const parent = Object.keys(graph).find(
      (p) => depth[p] === depth[cursor] - 1 && (graph[p] || []).includes(cursor),
    );
    if (!parent) return null;
    path.unshift(parent);
    cursor = parent;
  }
  return path;
}

function readSitemap() {
  const file = path.join(PUBLIC_DIR, 'sitemap.xml');
  if (!fs.existsSync(file)) return [];
  const xml = fs.readFileSync(file, 'utf8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1].replace(/^https?:\/\/[^/]+\//, ''))
    .map((slug) => (slug === '' ? ROOT_PAGE : slug))
    .filter((slug) => slug.endsWith('.html'));
}

const pages = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html')).sort();
const graph = buildGraph(pages);
const depth = reachability(graph, ROOT_PAGE);

const reachable = pages.filter((p) => depth[p] !== undefined).sort();
const orphaned = pages.filter((p) => depth[p] === undefined).sort();
const sitemap = readSitemap();

const byDepth = {};
for (const page of reachable) {
  (byDepth[depth[page]] = byDepth[depth[page]] || []).push(page);
}

const map = {
  generatedBy: 'scripts/build-nav-map.mjs',
  note: 'Generated file — do not hand-edit. Run `npm run navmap` after any nav change.',
  root: ROOT_PAGE,
  totals: {
    pages: pages.length,
    reachable: reachable.length,
    orphaned: orphaned.length,
    inSitemap: sitemap.length,
  },
  graph,
  depth,
  byDepth,
  reachable,
  orphaned,
  sitemap,
  // A page users can click to but crawlers are not told about.
  reachableNotInSitemap: reachable.filter((p) => !sitemap.includes(p)),
  // Worse: advertised to crawlers but unreachable by clicking. Dead-end SEO.
  inSitemapNotReachable: sitemap.filter((p) => !reachable.includes(p)),
  // The click path the spec walks to prove Knowledge Center is reachable (#3107).
  knowledgeCenterPath: shortestPath(graph, depth, ROOT_PAGE, 'knowledgecenter.html'),
  excludedEdges: NON_NAV_EDGES,
  sharedNavTargets: SHARED_NAV,
};

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, `${JSON.stringify(map, null, 2)}\n`);

process.stdout.write(
  [
    `nav-map -> ${path.relative(REPO_ROOT, OUT_FILE)}`,
    `  pages ${map.totals.pages} | reachable ${map.totals.reachable} | orphaned ${map.totals.orphaned}`,
    `  sitemap ${map.totals.inSitemap} | reachable-not-in-sitemap ${map.reachableNotInSitemap.length} | in-sitemap-not-reachable ${map.inSitemapNotReachable.length}`,
    `  knowledge center: ${map.knowledgeCenterPath ? map.knowledgeCenterPath.join(' -> ') : 'UNREACHABLE'}`,
    '',
  ].join('\n'),
);
