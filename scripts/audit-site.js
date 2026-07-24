#!/usr/bin/env node
/**
 * Site Audit System
 * - Generates sitemap.xml over the real PUBLIC pages (public/*.html minus the
 *   non-public denylist), at the production domain.
 * - Audits index.html's own links for broken references (CI gate).
 *
 * Why enumerate public/*.html instead of scraping index.html's <a href>: the nav +
 * footer are injected at runtime by site-chrome.js, so a static parse of index.html
 * misses every primary page (chat/trader/explore/pricing/…) and only sees a few
 * legacy hardcoded links. The sitemap must list what users can actually reach.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(REPO_ROOT, 'public/index.html');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const SITEMAP_PATH = path.join(PUBLIC_DIR, 'sitemap.xml');

// Production origin (canonical). Was 'https://lantern-os.local' — a local dev host
// crawlers can't reach; every generated URL was unreachable.
const SITE_URL = 'https://www.unisona.ai';

// Pages that are NOT indexable public content — excluded from the sitemap:
//   auth/session · admin & operator diagnostics · personal config · superseded dupes.
// Everything else in public/*.html is treated as a public page and included.
const NON_PUBLIC = new Set([
  // auth / session / personal
  'auth.html', 'reset-password.html', 'entry.html', 'accounts.html', 'profile.html', 'settings.html',
  // admin / operator / dev diagnostics
  'admin-flags.html', 'agent-leaderboard.html', 'agent-status.html', 'calibration.html', 'drift.html',
  'metrics.html', 'systems.html', 'grounding-diff.html', 'replay.html', 'factcheck.html', 'demo.html',
  'fallout-radio.html', 'wide-search.html', 'rag-house.html',
  // personal broker/config surfaces
  'ibkr-connect.html', 'ibkr-setup-guide.html', 'kalshi-screener.html',
  // operator surfaces hidden from guests (app functionality, not indexable content)
  'orchestration.html', 'work.html',
  // superseded / duplicate
  'dream-chat.html',
]);

// Priority by page (default 0.6). Marketing highest, then primary product, then
// content/transparency, then legal.
const PRIORITY = {
  '/': '1.0',
  '/pricing.html': '0.9', '/welcome.html': '0.9',
  '/chat.html': '0.8', '/stock-trader.html': '0.8', '/explore.html': '0.8',
  '/kalshi-terminal.html': '0.6', '/create.html': '0.6', '/faq.html': '0.6',
  '/proof.html': '0.6', '/knowledgecenter.html': '0.6',
  '/changelog.html': '0.5', '/whats-new.html': '0.5',
  '/terms.html': '0.3',
};

function publicPages() {
  const pages = ['/'];
  for (const f of fs.readdirSync(PUBLIC_DIR)) {
    if (f.endsWith('.html') && f !== 'index.html' && !NON_PUBLIC.has(f)) {
      pages.push('/' + f);
    }
  }
  return Array.from(new Set(pages)).sort();
}

// Internal links hardcoded in index.html (for the broken-reference check only).
// Regex extraction — no DOM parser dependency (the page is static markup here).
function extractIndexLinks() {
  let html = '';
  try {
    html = fs.readFileSync(INDEX_PATH, 'utf8');
  } catch (err) {
    console.error(`✗ Failed to load index.html: ${err.message}`);
    process.exit(1);
  }
  const links = new Set();
  for (const m of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    let href = m[1].trim();
    if (/^(https?:|#|mailto:|tel:|data:|javascript:)/i.test(href) || href === '') continue;
    if (!href.startsWith('/')) href = '/' + href;
    href = href.split('#')[0];
    // strip a cache-bust/query param for STATIC paths (`/chat.html?q=`, `/js/x.js?v=2`
    // resolve to real files); keep it for the /view + /repo/ reader routes, whose
    // validator needs the ?path=… to resolve the underlying repo file.
    if (!href.startsWith('/view') && !href.startsWith('/repo/')) href = href.split('?')[0];
    if (href) links.add(href);
  }
  return Array.from(links).sort();
}

function validatePageExists(pagePath) {
  if (pagePath === '/') return fs.existsSync(path.join(PUBLIC_DIR, 'index.html'));
  // /view?path=… and /repo/… serve a repo-root file via routes/files.js.
  if (pagePath.startsWith('/view') || pagePath.startsWith('/repo/')) {
    let rel = null;
    const qIdx = pagePath.indexOf('?');
    if (pagePath.startsWith('/view') && qIdx !== -1) {
      rel = new URLSearchParams(pagePath.slice(qIdx + 1)).get('path');
    } else if (pagePath.startsWith('/repo/')) {
      rel = decodeURIComponent(pagePath.slice('/repo/'.length).split('?')[0]);
    }
    if (rel) return fs.existsSync(path.join(REPO_ROOT, rel));
  }
  if (fs.existsSync(path.join(PUBLIC_DIR, pagePath))) return true;
  if (fs.existsSync(path.join(PUBLIC_DIR, pagePath, 'index.html'))) return true;
  return fs.existsSync(path.join(PUBLIC_DIR, pagePath + '.html'));
}

function generateSitemap(pages) {
  const lastmod = new Date().toISOString().split('T')[0];
  const entries = pages.map(page => {
    const url = page === '/' ? SITE_URL + '/' : SITE_URL + page;
    const priority = PRIORITY[page] || '0.6';
    return `  <url>\n    <loc>${url}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <priority>${priority}</priority>\n  </url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

function audit() {
  console.log('🔍 Site Audit: Starting\n');

  // 1. Generate the sitemap over the real public pages.
  const pages = publicPages();
  fs.writeFileSync(SITEMAP_PATH, generateSitemap(pages));
  console.log(`✓ Generated sitemap.xml — ${pages.length} public URLs @ ${SITE_URL}`);

  // 2. Broken-reference check on index.html's own links (CI gate).
  const links = extractIndexLinks();
  const missing = links.filter(l => !validatePageExists(l));
  console.log(`\nindex.html: ${links.length} internal links, ${missing.length} missing`);
  if (missing.length) {
    missing.forEach(p => console.log(`  ✗ ${p} (FILE NOT FOUND)`));
    console.error(`\n✗ AUDIT FAILED: ${missing.length} link(s) in index.html point to missing pages`);
    process.exit(1);
  }
  console.log('\n✓ Site audit passed');
  process.exit(0);
}

audit();
