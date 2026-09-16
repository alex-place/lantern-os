'use strict';
/**
 * test/trader-one-page.test.js — the Watch page is gone (operator, 2026-09-13).
 *
 * One trader for everyone: a visitor without the trade entitlement gets the same charts,
 * watchlist and signals without the account panel (no demo portfolio stands in for it,
 * no Pro overlay, no bounce to another page). The page's list is the WATCHLIST with the
 * AI trader's list marked on it: every row has an AI toggle, tracking a symbol needs no
 * warning, putting it on the AI list gets the once-per-session one.
 *
 * Run: node --test apps/lantern-garage/test/trader-one-page.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(APP, ...p), 'utf8').replace(/\r\n/g, '\n');
const PAGE = read('public', 'stock-trader.html');
const slice = (from, to) => { const i = PAGE.indexOf(from); assert.ok(i !== -1, 'missing: ' + from); const j = PAGE.indexOf(to, i); assert.ok(j !== -1, 'missing end: ' + to); return PAGE.slice(i, j); };

test('the Watch page is gone and old links land on the trader', () => {
  assert.ok(!fs.existsSync(path.join(APP, 'public', 'watch.html')), 'watch.html still exists');
  const pages = read('routes', 'pages.js');
  assert.doesNotMatch(pages, /"\/watch\.html":\s*"watch\.html"/, 'pages.js still serves it');
  assert.match(pages, /"\/watch\.html": "\/stock-trader\.html"/, 'no redirect for the old links');
  assert.doesNotMatch(read('lib', 'surface-registry.js'), /"watch\.html"/, 'the surface registry still lists it');
  assert.doesNotMatch(read('public', 'js', 'auth-gate.js'), /'\/watch\.html'/, 'the auth gate still lists it as public');
  assert.ok(!PAGE.includes('watch.html'), 'the trader page still names it');
  assert.ok(!fs.existsSync(path.join(APP, 'test', 'card-renderer-parity.test.js')), 'the twin-parity test outlived the twin');
});

test('Trade and Journal are header entries, once each, and there is no Pro overlay or tier bounce', () => {
  // The switch used to be a pair of tabs inside the trader's own toolbar: the journal had
  // no way back, and from the rest of the site the journal was unnamed (founder, 2026-09-15).
  const chrome = read('public', 'js', 'site-chrome.js');
  const nav = chrome.slice(chrome.indexOf('var NAV_LINKS = ['), chrome.indexOf('];', chrome.indexOf('var NAV_LINKS = [')));
  assert.match(nav, /\{ href: "\/stock-trader\.html", label: "Trader" \}/);
  assert.match(nav, /\{ href: "\/journal\.html", label: "Journal" \}/);
  assert.ok(nav.indexOf('/journal.html') > nav.indexOf('/stock-trader.html'), 'the journal sits beside the trader, after it');
  assert.doesNotMatch(nav, />Watch</);
  // and the toolbar's copy is gone, CSS and all
  assert.ok(!PAGE.includes('class="page-tabs"'), 'the trader toolbar still carries its own switcher');
  assert.ok(!PAGE.includes('.page-tabs{'), 'dead .page-tabs CSS left in the trader page');
  assert.ok(!PAGE.includes('class="pt'), 'a leftover .pt tab in the trader page');
  assert.ok(!PAGE.includes('id="tradeLock"'), 'the Pro overlay is still in the page');
  assert.ok(!PAGE.includes('applyTierGate'), 'the tier gate is still in the page');
  assert.ok(!PAGE.includes('stay=1'), 'the escape hatch for the bounce is still in the page');
  assert.match(PAGE, /function startDashboard\(\)\{\s*_restoreBarsCache\(\);/);
});

test('view-only: no account panel, no demo portfolio, the range strip stays', () => {
  assert.ok(!PAGE.includes('DEMO_ACCT'), 'the demo account flag survives');
  assert.ok(!PAGE.includes("classList.add('demo')"), 'the demo class survives');
  assert.ok(!PAGE.includes('demo=champion'), 'the demo fetch survives');
  assert.ok(!PAGE.includes('badge-demo'), 'the demo badge survives');
  assert.match(PAGE, /body\.guest \.footer,\s*body\.guest \.acct-corner,\s*body\.guest \.wl-ai,[^\n]*\n\s*body\.guest \.hstat\.acct\{ display:none !important; \}/);
  // Three rows for a view-only layout: header, charts, the range strip -- never a zero-height strip.
  assert.match(PAGE, /body\.guest \.layout\{ grid-template-rows:52px minmax\(0,1fr\) auto; \}/);
  assert.doesNotMatch(PAGE, /body\.guest:not\(\.demo\)/);
  assert.match(PAGE, /async function loadPortfolio\(\)\{[\s\S]*?if\(window\.GUEST\) return;\s*try\{\s*const r  = await fetch\('\/api\/trading\/positions'\);/);
});

test('the page list is the watchlist with the AI list marked on it', () => {
  assert.match(PAGE, /const LIST_API='\/api\/trading\/watchlist'; const LIST_KEY='watchlist';/);
  assert.match(PAGE, /const AI_LIST_API='\/api\/trading\/tradelist'; const AI_LIST_KEY='tradelist';/);
  const src = slice('let MY_LIST=null, AI_LIST=new Set(), WL_LIST=new Set();', '// ── Watchlist add/remove');
  const calls = [];
  const fetchStub = (url) => { calls.push(url); return Promise.resolve({ json: () => Promise.resolve(url.endsWith('watchlist') ? { watchlist: ['spy', 'AAPL'] } : { tradelist: ['SPY', 'SOXL'] }) }); };
  const fns = new Function('fetch', 'LIST_API', 'LIST_KEY', 'AI_LIST_API', 'AI_LIST_KEY', src + '; return { loadMyList, lists: () => ({ MY_LIST, AI_LIST, WL_LIST }) };')(
    fetchStub, '/api/trading/watchlist', 'watchlist', '/api/trading/tradelist', 'tradelist');
  return fns.loadMyList(true).then((ml) => {
    assert.deepStrictEqual([...ml].sort(), ['AAPL', 'SOXL', 'SPY'], 'the union, upper-cased');
    assert.deepStrictEqual([...fns.lists().AI_LIST].sort(), ['SOXL', 'SPY']);
    assert.deepStrictEqual([...fns.lists().WL_LIST].sort(), ['AAPL', 'SPY'], 'the plain watchlist is kept apart');
    assert.deepStrictEqual(calls.sort(), ['/api/trading/tradelist', '/api/trading/watchlist']);
  });
});

test('every row has an AI toggle; tracking needs no warning, the AI list gets one', () => {
  assert.match(PAGE, /const ai = AI_LIST\.has\(String\(t\.ticker\)\.toUpperCase\(\)\);/);
  assert.match(PAGE, /<button class="wl-ai\$\{ai\?' on':''\}" aria-pressed="\$\{ai\}" aria-label="AI trader \$\{ai\?'on':'off'\} for \$\{t\.ticker\}"/);
  assert.match(PAGE, /onclick="toggleAiTicker\('\$\{t\.ticker\}',event\)">AI<\/button>/);
  // The rail is 340px (12px padding each side): fixed tracks plus gaps must leave the
  // symbol its width. 18+62+56+56+20+16 = 228, six 6px gaps = 36, so a 305px row keeps
  // ~41px for the ticker; the old 302px of tracks left it 3px (operator, 2026-09-13).
  assert.strictEqual((PAGE.match(/grid-template-columns:18px minmax\(0,1fr\) 62px 56px 56px 20px 16px;align-items:center;gap:6px;/g) || []).length, 2, 'the row and the header grids');
  assert.match(PAGE, /\.wl-ai\{grid-column:6;/);
  assert.match(PAGE, /\.wl-remove\{grid-column:7;/);
  assert.doesNotMatch(PAGE, /<span class="wl-sym">\$\{t\.ticker\}<\/span>\s*<span><\/span>/, 'the empty spacer cell is back');
  // Adding to the watchlist asks nothing; the slot editor adds to the watchlist too.
  const add = slice('async function addWatchlistTicker(){', 'async function addWatchlistSymbol(sym){');
  assert.ok(!add.includes('_tradelistEditGuard'), 'tracking a symbol still gets the AI warning');
  const addSym = slice('async function addWatchlistSymbol(sym){', '/* The AI toggle on a watchlist row');
  assert.ok(!addSym.includes('_tradelistEditGuard'), 'the symbol picker still gets the AI warning');
  const slot = slice('async function commitSlotSymbol(oldTicker, sym){', '// ── Symbol-search popup');
  assert.ok(!slot.includes('_tradelistEditGuard'), 'charting a symbol still gets the AI warning');
  // Removing asks only when the symbol is on the AI list, and then leaves both lists.
  assert.match(PAGE, /if\(AI_LIST\.has\(_t\) && !_tradelistEditGuard\(\)\) return;/);
  assert.match(PAGE, /if\(AI_LIST\.has\(_t\)\) await fetch\(AI_LIST_API\+'\/'\+encodeURIComponent\(_t\), \{ method: 'DELETE' \}\)/);
});

test('the toggle posts to the AI list when off and deletes when on, warning only on the way in', () => {
  const src = slice('async function toggleAiTicker(ticker, evt){', '// #3514: chart slots persist');
  const run = (aiOn, guardOk, guest, watched) => {
    const calls = [], toasts = []; let guards = 0, rendered = 0, reloaded = 0;
    const fns = new Function('fetch', 'AI_LIST', 'WL_LIST', 'AI_LIST_API', 'LIST_API', '_tradelistEditGuard', 'loadMyList', 'renderWatchlist', '_alertToast', 'window',
      src + '; return toggleAiTicker;')(
      (url, opts) => { calls.push((opts && opts.method) + ' ' + url); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); },
      new Set(aiOn ? ['SPY'] : []), new Set(watched ? ['SPY'] : []), '/api/trading/tradelist', '/api/trading/watchlist', () => { guards++; return guardOk; }, () => { reloaded++; return Promise.resolve(); }, () => { rendered++; }, (m) => toasts.push(m), { GUEST: !!guest });
    return fns('spy', { stopPropagation() {} }).then(() => ({ calls, toasts, guards, rendered, reloaded }));
  };
  return Promise.all([run(false, true), run(true, true, false, true), run(false, false), run(false, true, true), run(true, true, false, false)]).then(([addIt, dropIt, declined, viewer, dropOnlyAi]) => {
    assert.deepStrictEqual(addIt.calls, ['POST /api/trading/tradelist']);
    assert.strictEqual(addIt.guards, 1);
    assert.strictEqual(addIt.reloaded, 1); assert.strictEqual(addIt.rendered, 1);
    assert.match(addIt.toasts[0], /may now trade SPY/);
    assert.deepStrictEqual(dropIt.calls, ['DELETE /api/trading/tradelist/SPY']);
    assert.strictEqual(dropIt.guards, 0, 'taking a symbol off never warns');
    // Only on the AI list: it goes on the watchlist first, so the row stays on the page.
    assert.deepStrictEqual(dropOnlyAi.calls, ['POST /api/trading/watchlist', 'DELETE /api/trading/tradelist/SPY']);
    assert.match(dropIt.toasts[0], /off the AI trader/);
    assert.deepStrictEqual(declined.calls, [], 'a declined warning changes nothing');
    assert.deepStrictEqual(viewer.calls, [], 'a view-only visitor cannot edit the AI list');
  });
});
