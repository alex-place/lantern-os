/**
 * test/knowledge-center.test.js — the Knowledge Center's publication invariants.
 *
 * Every assertion here corresponds to something that was actually live on
 * unisona.ai/knowledgecenter.html before the rework:
 *   - operator runbooks published, including one naming the origin IP behind Cloudflare
 *   - an unconditional A→Z re-sort that discarded the generator's ranking, putting ten
 *     hex-named PDFs and "8495630 (1)" above the FAQ
 *   - /api/pdfs rendered verbatim: third-party copyrighted PDFs and an internal
 *     revenue report on a public page
 *   - 87 dated lab notes each claiming a card
 *   - a hero card advertising version 1.8 while the app shipped 1.14.1
 *
 * Run: node --test apps/lantern-garage/test/knowledge-center.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const HTML = fs.readFileSync(path.join(REPO, 'apps', 'lantern-garage', 'public', 'knowledgecenter.html'), 'utf8');
const CATALOG = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'knowledge', 'doc-catalog.json'), 'utf8'));

const cards = [...HTML.matchAll(/<a class="doc-card"([^>]*)>/g)].map((m) => m[1]);
const attr = (card, name) => (card.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] || '';

test('no audience:internal doc is published', () => {
  const hrefs = new Set(cards.map((c) => attr(c, 'href')));
  const leaked = CATALOG
    .filter((e) => e.audience === 'internal')
    .filter((e) => hrefs.has('/repo/' + e.path));
  assert.deepStrictEqual(leaked.map((e) => e.path), [],
    'internal docs must never render a card');
});

test('the GCE runbook — which names the live origin IP — is internal', () => {
  const gce = CATALOG.find((e) => e.path === 'docs/ops/gce-cloud-deploy-runbook.md');
  assert.ok(gce, 'the runbook is still catalogued');
  assert.strictEqual(gce.audience, 'internal');
});

test('no audience:public doc contains a routable IP address', () => {
  const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  const PRIVATE = /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
  const offenders = [];
  for (const e of CATALOG) {
    if (e.audience !== 'public' || e.action !== 'keep') continue;
    let body;
    try { body = fs.readFileSync(path.join(REPO, e.path), 'utf8'); } catch { continue; }
    const hits = (body.match(IPV4) || []).filter((ip) => !PRIVATE.test(ip));
    if (hits.length) offenders.push(`${e.path}: ${hits[0]}`);
  }
  assert.deepStrictEqual(offenders, []);
});

test('every card carries the metadata the sort control needs', () => {
  assert.ok(cards.length > 100, `expected a populated library, got ${cards.length}`);
  for (const c of cards) {
    assert.match(attr(c, 'data-rank'), /^\d{4}$/, 'data-rank is a sortable fixed-width int');
    assert.match(attr(c, 'data-updated'), /^\d{4}-\d{2}-\d{2}$/, 'data-updated is an ISO date');
    assert.ok(['public', 'builder', 'internal'].includes(attr(c, 'data-audience')));
  }
});

test('the default order is the generator ranking, not alphabetical', () => {
  // The regression: sortGrid() used to re-sort by title unconditionally on load.
  assert.match(HTML, /activeSort = 'curated'/, 'curated is the default sort');
  assert.ok(!/function sortGrid\(\)\s*\{\s*cards\(\)\s*\.sort\(\(a, b\) => collator/.test(HTML),
    'the unconditional alphabetical re-sort must be gone');
  const ranks = cards.map((c) => attr(c, 'data-rank'));
  assert.deepStrictEqual(ranks, [...ranks].sort(), 'cards are emitted in rank order');
});

test('public PDFs are allowlisted, and the allowlist fails closed', () => {
  assert.match(HTML, /report-manifest/, 'the page consults the report manifest');
  assert.match(HTML, /let allowed = new Set\(\);/,
    'the allowlist starts empty so a fetch failure publishes nothing');
  assert.ok(!/allowed\s*=\s*null/.test(HTML), 'no null sentinel that means "allow all"');
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'knowledge', 'report-manifest.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.reports), 'manifest exposes a reports array');
});

test('dated research notes roll up into one card plus a generated index', () => {
  const dated = CATALOG.filter((e) => /^docs\/research\/\d{4}-\d{2}-\d{2}-/.test(e.path));
  assert.ok(dated.length > 50, `expected the journal to be catalogued, got ${dated.length}`);
  const individually = cards.filter((c) => /^\/repo\/docs\/research\/\d{4}-\d{2}-\d{2}-/.test(attr(c, 'href')));
  assert.deepStrictEqual(individually, [], 'no dated note gets its own card');
  assert.ok(cards.some((c) => attr(c, 'href') === '/repo/docs/research/INDEX.md'), 'the rollup card exists');
  assert.strictEqual(
    cards.filter((c) => attr(c, 'href') === '/repo/docs/research/INDEX.md').length, 1,
    'exactly one rollup card — the generated index must not also be catalogued');
  assert.ok(fs.existsSync(path.join(REPO, 'docs', 'research', 'INDEX.md')), 'the index is generated');
});

test('the Human Flourishing Frameworks cards are gone', () => {
  assert.ok(!/data-cat="hff"/.test(HTML), 'no HFF cards');
  assert.ok(!/Convergence \(HFF\)/.test(HTML), 'no HFF filter chip');
});

test('the hero does not hard-code a version that goes stale', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'apps', 'lantern-garage', 'package.json'), 'utf8'));
  // Only the hero — a doc CARD legitimately titled "Unisona 1.8 — …" is a historical
  // release note, not a stale claim about the current version.
  const hero = HTML.slice(HTML.indexOf('link-grid essentials'), HTML.indexOf('id="documents"'));
  const claimed = hero.match(/Unisona (\d+\.\d+(?:\.\d+)?)/g) || [];
  for (const c of claimed) {
    const v = c.replace('Unisona ', '');
    assert.ok(pkg.version.startsWith(v) || v === pkg.version,
      `hero names version ${v} but the app ships ${pkg.version}`);
  }
});

test('every filter chip matches a category the generator emits', () => {
  const chipCats = [...HTML.matchAll(/<button class="chip[^"]*" data-cat="([^"]+)"/g)].map((m) => m[1]);
  const cardCats = new Set(cards.map((c) => attr(c, 'data-cat')));
  for (const cat of chipCats) {
    if (cat === 'all') continue;
    assert.ok(cardCats.has(cat), `chip "${cat}" matches no card — a dead filter`);
  }
});
