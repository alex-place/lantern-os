'use strict';

/**
 * #3177 — the generated nav-map must not claim a nav-config-hidden surface is reachable.
 *
 * `scripts/build-nav-map.mjs` counts NAV_LINKS + FOOTER_EXTRA_LINKS from site-chrome.js as
 * click-reachable. But an EXTENSION surface whose gating flag is off is default-hidden by
 * nav-config (feature-flags.getNavMap → /api/nav-config), and auth-gate.js sets display:none
 * on its header/footer link at runtime. #3146 added Create to FOOTER_EXTRA_LINKS, so the map
 * listed /create.html as depth-1 reachable while the shipped nav hid it — sitemap-nav.spec.js
 * (Playwright) failed on it, but that suite isn't wired into CI, so it went latent.
 *
 * This is the fast, node-runnable guard for the same invariant: hidden ⇒ not reachable, and the
 * map's recorded hidden set stays in sync with the runtime source of truth. It does not need a
 * browser, so unlike the Playwright spec it can run in the node test job.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const navMap = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'e2e-sitemap', 'nav-map.json'), 'utf8'));
const { getNavMap } = require('../lib/feature-flags');

const hiddenPaths = () =>
  Object.entries(getNavMap())
    .filter(([, v]) => v && v.hidden)
    .map(([k]) => k.replace(/^\//, ''));

test('no nav-config-hidden surface is claimed reachable in the nav-map (#3177)', () => {
  const reachable = new Set(navMap.reachable);
  const leaked = hiddenPaths().filter((p) => reachable.has(p));
  assert.deepStrictEqual(leaked, [],
    `nav-config hides these, but the map lists them reachable — regenerate with \`npm run navmap\`: ${leaked.join(', ')}`);
});

test('the nav-map records the same hidden set the runtime serves', () => {
  assert.ok(Array.isArray(navMap.navConfigHidden),
    'nav-map.json must carry navConfigHidden (regenerate with `npm run navmap`)');
  assert.deepStrictEqual([...navMap.navConfigHidden].sort(), hiddenPaths().sort(),
    'nav-map.navConfigHidden drifted from feature-flags.getNavMap — regenerate the map');
});

test('create.html: hidden by nav-config, absent from reachable + depth-1 (the #3177 regression)', () => {
  assert.strictEqual(getNavMap()['/create.html'] && getNavMap()['/create.html'].hidden, true,
    'create.html is a default-hidden EXTENSION surface');
  assert.ok(!navMap.reachable.includes('create.html'), 'create.html must not be reachable');
  assert.ok(!(navMap.byDepth['1'] || []).includes('create.html'), 'create.html must not be a depth-1 page');
});
