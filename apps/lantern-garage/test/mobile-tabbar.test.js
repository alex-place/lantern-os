"use strict";
/**
 * mobile-tabbar.test.js — the phone shell of the trader pages (2026-09-19).
 *
 * On a 375px screen the trader used to stack four toolbars above a chart sliver and open the
 * watchlist as a sheet over it; the view switch still pointed at a `.sidebar` that the dock
 * redesign (#3355) had removed, so "Tickers" showed the order ticket. The shell is now
 * TradingView's shape: a bottom tab bar (Watchlist · Chart · Positions · Journal · More) that
 * /js/mobile-tabbar.js injects on phones, and four full-screen views over the page's REAL
 * regions. These tests pin the contracts without a browser: the shared script, the page's
 * phone CSS block and view switch, the deep-link vocabulary, and the two pages that carry the bar.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const PUB = path.join(__dirname, "..", "public");
const read = (f) => fs.readFileSync(path.join(PUB, f), "utf8");
const TRADER = read("stock-trader.html");
const BAR = read("js/mobile-tabbar.js");

test("the shared tab bar script parses, is phone-only, and carries the five tabs in TradingView's order", () => {
  assert.doesNotThrow(() => new vm.Script(BAR));
  assert.match(BAR, /max-width:580px/);
  assert.match(BAR, /var VIEWS = \['watchlist', 'chart', 'positions', 'journal', 'more'\]/);
  for (const label of ["Watchlist", "Chart", "Positions", "Journal", "More"]) assert.ok(BAR.includes(`'${label}'`), label);
  assert.match(BAR, /env\(safe-area-inset-bottom,0px\)/, "the bar and the More sheet respect the home-indicator inset");
  assert.match(BAR, /window\.MobileTabbar = \{ setActive: setActive, openSheet: openSheet, closeSheet: closeSheet, isPhone: isPhone \}/);
  // desktop never sees it: the bar is built only when the media query matches, and torn down when it stops
  assert.match(BAR, /function sync\(\) \{ if \(isPhone\(\)\) build\(\); else teardown\(\); \}/);
});

test("the trader page carries the phone CSS block, the four views, and the shared script", () => {
  assert.match(TRADER, /<style id="mtab-phone">[\s\S]*@media \(max-width:580px\)\{[\s\S]*<\/style>\r?\n<\/head>/, "phone block is the last thing in <head> so it wins");
  assert.match(TRADER, /const MOBILE_VIEWS = \['watchlist', 'chart', 'trade', 'positions'\];/);
  for (const v of ["watchlist", "chart", "trade", "positions"]) assert.ok(TRADER.includes(`.layout.mv-${v}`), `mv-${v} rules`);
  assert.match(TRADER, /\.mobile-view-tabs\{ display:none !important; \}/, "the old segmented control is retired on phones");
  assert.match(TRADER, /<script src="\/js\/mobile-tabbar\.js" defer><\/script>/);
  // the views are the page's real regions, not the pre-#3355 sidebar
  assert.match(TRADER, /\.layout\.mv-watchlist #dockR[^{]*\{ display:flex !important; position:static !important;/);
  assert.match(TRADER, /\.layout\.mv-trade #ticketDock[^{]*\{ display:flex !important; position:static !important;/);
  assert.match(TRADER, /\.layout\.mv-positions \.footer\{ display:flex !important;/);
  // the watchlist row reads like a watchlist app: logo · symbol over $-change · price over %-change
  assert.match(TRADER, /grid-template-areas:"logo sym price ai" "logo sub chg ai";/);
});

test("setMobileView keeps its old vocabulary and the paper-corner contract, and mirrors the bar", () => {
  assert.match(TRADER, /var alias = \{ tickers: 'watchlist' \};/, "'tickers' still resolves");
  assert.match(TRADER, /layout\.classList\.toggle\('mobile-tickers',\s+view === 'watchlist'\);/, "legacy classes stay for the older phone rules");
  assert.match(TRADER, /layout\.classList\.toggle\('mobile-positions', view === 'positions'\);/);
  assert.match(TRADER, /if \(window\.MobileTabbar\) window\.MobileTabbar\.setActive\(view === 'trade' \? 'chart' : view\);/);
  assert.match(TRADER, /setMobileView\('positions'\); return; \}/, "the paper badge still opens the Positions view on phones");
  // phone entry points: a watchlist row opens the chart; SELL/BUY and the ticket toggle open the ticket view
  assert.match(TRADER, /window\.focusTicker = function \(t\) \{[^\n]*setMobileView\('chart'\)/);
  assert.match(TRADER, /window\.openOrderTicket = function \(\) \{[^\n]*setMobileView\('trade'\)/);
  assert.match(TRADER, /window\.toggleTicketDock = function \(\) \{ if \(_isPhone\(\)\) \{ setMobileView\(document\.querySelector\('\.layout\.mv-trade'\) \? 'chart' : 'trade'\); return; \}/);
  // deep links + the remembered view; watchlist is the phone's home, like TradingView
  assert.match(TRADER, /setMobileView\(fromHash\(\) \|\| saved \|\| 'watchlist'\);/);
  assert.match(TRADER, /window\.addEventListener\('hashchange'/);
});

test("the chart view on a phone is one full-height chart of the selected symbol, rebuilt after the switch", () => {
  assert.match(TRADER, /if \(typeof setSlotCount === 'function' && \(!sel \|\| sel\.value !== '1'\)\) setSlotCount\(1\);/);
  assert.match(TRADER, /chartSlots\[0\] !== activeTicker\) \{ chartSlots = \[activeTicker\];/);
  assert.match(TRADER, /if \(typeof lastCardOrder !== 'undefined'\) lastCardOrder = '';/, "a full rebuild — renderChart skips a 0x0 canvas, so the cards must be rebuilt once visible");
});

test("the journal and transparency pages carry the same bar", () => {
  for (const f of ["journal.html", "transparency.html"]) {
    const s = read(f);
    assert.match(s, /<script src="\/js\/site-chrome\.js"[^>]*><\/script>\r?\n<script src="\/js\/mobile-tabbar\.js" defer><\/script>/, f);
  }
});

test("the CRLF page stayed CRLF (the sed trap)", () => {
  const crlf = (TRADER.match(/\r\n/g) || []).length, lf = (TRADER.match(/[^\r]\n/g) || []).length;
  assert.ok(crlf > 10000 && lf < 5, `crlf=${crlf} lf=${lf}`);
});
