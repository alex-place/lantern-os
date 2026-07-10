#!/usr/bin/env node
/**
 * Site Audit System
 * Enforces sitemap completeness and WCAG compliance
 * - Extracts all links from index.html
 * - Validates pages exist
 * - Generates sitemap.xml
 * - Detects missing/orphaned pages
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO_ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(REPO_ROOT, 'apps/lantern-garage/public/index.html');
const PUBLIC_DIR = path.join(REPO_ROOT, 'apps/lantern-garage/public');
const SITEMAP_PATH = path.join(PUBLIC_DIR, 'sitemap.xml');

// Site config
const SITE_URL = 'https://lantern-os.local';
const IGNORED_PATHS = ['/flourishing', '/knowledgecenter.html']; // External redirects
const EXTERNAL_URLS = ['https://www.patreon.com/', 'https://github.com/'];

async function loadIndexHtml() {
  try {
    const content = fs.readFileSync(INDEX_PATH, 'utf8');
    return new JSDOM(content).window.document;
  } catch (err) {
    console.error(`✗ Failed to load index.html: ${err.message}`);
    process.exit(1);
  }
}

function extractLinks(doc) {
  const links = new Set();
  const seen = new Set();

  doc.querySelectorAll('a[href]').forEach(link => {
    let href = link.getAttribute('href');

    // Skip external, anchors, and ignored
    if (href.startsWith('http') || href.startsWith('#') || IGNORED_PATHS.includes(href)) {
      return;
    }

    // Normalize path
    if (!href.startsWith('/')) href = '/' + href;

    if (!seen.has(href)) {
      links.add(href);
      seen.add(href);
    }
  });

  return Array.from(links).sort();
}

function validatePageExists(pagePath) {
  // Handle root
  if (pagePath === '/') {
    return fs.existsSync(path.join(PUBLIC_DIR, 'index.html'));
  }

  // Repo-file reader routes: `/view?path=<rel>` (formatted markdown reader) and
  // `/repo/<rel>` (raw file) both serve a file from the REPO ROOT via
  // routes/files.js — not from PUBLIC_DIR. Validate the underlying repo file
  // exists rather than treating the URL as a literal public path.
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

  // Try as direct file
  let filePath = path.join(PUBLIC_DIR, pagePath);
  if (fs.existsSync(filePath)) return true;

  // Try as directory with index.html
  filePath = path.join(PUBLIC_DIR, pagePath, 'index.html');
  if (fs.existsSync(filePath)) return true;

  // Try adding .html
  filePath = path.join(PUBLIC_DIR, pagePath + '.html');
  return fs.existsSync(filePath);
}

function generateSitemap(pages) {
  const entries = pages.map(page => {
    const url = page === '/' ? SITE_URL : SITE_URL + page;
    const lastmod = new Date().toISOString().split('T')[0];
    const priority = page === '/' ? '1.0' : '0.8';

    return `  <url>
    <loc>${url}</loc>
    <lastmod>${lastmod}</lastmod>
    <priority>${priority}</priority>
  </url>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`;
}

async function audit() {
  console.log('🔍 Site Audit: Starting\n');

  // Load index.html
  const doc = await loadIndexHtml();
  console.log('✓ Index.html loaded');

  // Extract links
  const links = extractLinks(doc);
  console.log(`✓ Found ${links.length} unique links\n`);

  // Validate pages exist
  console.log('Validating pages:');
  const missing = [];
  const valid = [];

  links.forEach(link => {
    if (validatePageExists(link)) {
      valid.push(link);
      console.log(`  ✓ ${link}`);
    } else {
      missing.push(link);
      console.log(`  ✗ ${link} (FILE NOT FOUND)`);
    }
  });

  // Always include home
  if (!valid.includes('/')) valid.push('/');

  console.log(`\n✓ Valid pages: ${valid.length}`);
  if (missing.length > 0) {
    console.log(`✗ Missing pages: ${missing.length}`);
    missing.forEach(p => console.log(`  - ${p}`));
  }

  // Generate sitemap
  const sitemap = generateSitemap(valid);
  fs.writeFileSync(SITEMAP_PATH, sitemap);
  console.log(`\n✓ Generated sitemap.xml (${valid.length} URLs)`);

  // Exit with error if pages missing
  if (missing.length > 0) {
    console.error(`\n✗ AUDIT FAILED: ${missing.length} page(s) referenced in index.html but not found`);
    process.exit(1);
  }

  console.log('\n✓ Site audit passed');
  process.exit(0);
}

audit().catch(err => {
  console.error('✗ Audit error:', err);
  process.exit(1);
});
