/* mobile-tabbar.js — the phone navigation shell for the trader pages (TradingView's shape).
 *
 * On screens up to 580px wide this injects a fixed bottom tab bar — Watchlist · Chart ·
 * Positions · Journal · More — and a "More" sheet for the secondary surfaces (order
 * ticket, alerts, assistant chat, drawing tools, transparency, guide, settings, theme).
 * Nothing renders above 580px, so desktop layouts are untouched.
 *
 * Pages: stock-trader.html (the tabs switch views in place through window.setMobileView),
 * journal.html and transparency.html (the tabs navigate; the trader views deep-link as
 * /stock-trader.html#watchlist etc.). Load with <script src="/js/mobile-tabbar.js" defer>.
 *
 * API: window.MobileTabbar = { setActive(view), openSheet(), closeSheet(), isPhone() }.
 */
(function () {
  'use strict';
  var MQ = '(max-width:580px)';
  var VIEWS = ['watchlist', 'chart', 'positions', 'journal', 'more'];
  var ICONS = {
    watchlist: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    chart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3v4M7 17v4M17 5v3M17 16v3"/><rect x="4.5" y="7" width="5" height="10" rx="1"/><rect x="14.5" y="8" width="5" height="8" rx="1"/></svg>',
    positions: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18"/></svg>',
    journal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h11l3 3v13H5z"/><path d="M8 10h8M8 14h8M8 18h5"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>'
  };
  var LABELS = { watchlist: 'Watchlist', chart: 'Chart', positions: 'Positions', journal: 'Journal', more: 'More' };
  var CSS = [
    '.mtabbar{position:fixed;left:0;right:0;bottom:0;z-index:1300;display:flex;background:var(--bg1,#0e1116);',
    '  border-top:1px solid var(--border,#232a35);padding-bottom:env(safe-area-inset-bottom,0px)}',
    '.mtabbar button{flex:1 1 0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:56px;',
    '  background:none;border:none;color:var(--text2,#8a93a6);font:600 10px/1 var(--sans,system-ui,sans-serif);letter-spacing:.02em;',
    '  cursor:pointer;-webkit-tap-highlight-color:transparent;padding:0}',
    '.mtabbar button svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
    '.mtabbar button.active{color:var(--accent,#3b82f6)}',
    '.mtabbar button:focus-visible{outline:2px solid var(--accent,#3b82f6);outline-offset:-2px;border-radius:8px}',
    'body.has-mtabbar{padding-bottom:calc(56px + env(safe-area-inset-bottom,0px))}',
    '.mtab-sheet-bg{position:fixed;inset:0;z-index:1310;background:rgba(0,0,0,.5);display:none}',
    '.mtab-sheet-bg.open{display:block}',
    '.mtab-sheet{position:fixed;left:0;right:0;bottom:0;z-index:1320;background:var(--bg1,#0e1116);border-top:1px solid var(--border,#232a35);',
    '  border-radius:14px 14px 0 0;padding:6px 8px calc(10px + env(safe-area-inset-bottom,0px));box-shadow:0 -10px 28px rgba(0,0,0,.45);',
    '  transform:translateY(100%);transition:transform .2s ease;max-height:80vh;overflow-y:auto}',
    '.mtab-sheet.open{transform:translateY(0)}',
    '.mtab-sheet .mtab-grip{width:36px;height:4px;border-radius:2px;background:var(--border,#232a35);margin:6px auto 8px}',
    '.mtab-sheet a,.mtab-sheet button{display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;padding:13px 12px;border:none;',
    '  background:none;color:var(--text0,#e6e9ef);font:500 15px/1.2 var(--sans,system-ui,sans-serif);text-align:left;text-decoration:none;',
    '  border-radius:10px;cursor:pointer;-webkit-tap-highlight-color:transparent}',
    '.mtab-sheet a:active,.mtab-sheet button:active{background:var(--bg2,#151a22)}',
    '.mtab-sheet .mtab-sub{margin-left:auto;font-size:12px;color:var(--text2,#8a93a6)}',
    '.mtab-sheet svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;color:var(--text1,#b6bdc9)}',
    '.mtab-sheet .mtab-sep{height:1px;background:var(--border,#232a35);margin:4px 8px}',
    '@media (prefers-reduced-motion:reduce){.mtab-sheet{transition:none}}'
  ].join('\n');

  var onTrader = /\/stock-trader\.html$/.test(location.pathname);
  var onJournal = /\/journal\.html$/.test(location.pathname);
  var bar = null, sheet = null, sheetBg = null, styleEl = null, active = null;

  function isPhone() { try { return window.matchMedia(MQ).matches; } catch (e) { return false; } }

  // The trader page switches views in place; every other page deep-links into it.
  function go(view) {
    if (view === 'more') { openSheet(); return; }
    if (view === 'journal') { if (!onJournal) location.href = '/journal.html'; return; }
    if (onTrader && typeof window.setMobileView === 'function') { window.setMobileView(view); return; }
    location.href = '/stock-trader.html#' + view;
  }
  function traderAction(fn, hash) {
    return function () { closeSheet(); if (onTrader && typeof fn === 'function') fn(); else location.href = '/stock-trader.html#' + hash; };
  }

  function sheetItems() {
    var items = [];
    var add = function (label, icon, onClick, href, sub) {
      var el = document.createElement(href ? 'a' : 'button');
      if (href) el.href = href; else el.type = 'button';
      el.innerHTML = icon + '<span>' + label + '</span>' + (sub ? '<span class="mtab-sub">' + sub + '</span>' : '');
      if (onClick) el.addEventListener('click', onClick);
      items.push(el);
    };
    var I = {
      ticket: '<svg viewBox="0 0 24 24"><path d="M7 17l-4-4 4-4M3 13h11M17 7l4 4-4 4M21 11H10"/></svg>',
      bell: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0"/></svg>',
      chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H8l-4 4z"/></svg>',
      pen: '<svg viewBox="0 0 24 24"><path d="M4 20l4-1 11-11-3-3L5 16zM13 7l3 3"/></svg>',
      eye: '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
      book: '<svg viewBox="0 0 24 24"><path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/></svg>',
      gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3.9a7 7 0 0 0-1.7-1L14.5 3h-5l-.4 2.4a7 7 0 0 0-1.7 1l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 1.7 1l.4 2.4h5l.4-2.4a7 7 0 0 0 1.7-1l2.3.9 2-3.4-2-1.5c.1-.3.1-.7.1-1z"/></svg>',
      sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
    };
    add('Order ticket', I.ticket, traderAction(function () { window.setMobileView && window.setMobileView('trade'); }, 'trade'), null, 'buy / sell');
    // view first, then the panel: the watchlist view resets the dock to its resting panel
    add('Alerts', I.bell, traderAction(function () { window.setMobileView && window.setMobileView('watchlist'); if (typeof window.setRightWidget === 'function') window.setRightWidget('alerts'); }, 'alerts'));
    add('Ask Unisona', I.chat, traderAction(function () { if (typeof window.dcToggle === 'function') window.dcToggle(true); }, 'chat'), null, 'assistant');
    add('Drawing tools', I.pen, traderAction(function () { document.body.classList.toggle('mv-draw'); window.setMobileView && window.setMobileView('chart'); }, 'chart'), null, 'show / hide');
    var sep = document.createElement('div'); sep.className = 'mtab-sep'; items.push(sep);
    add('Transparency', I.eye, function () { closeSheet(); }, '/transparency.html');
    add('Trader guide', I.book, function () { closeSheet(); }, '/trader-guide.html');
    add('Settings', I.gear, function () { closeSheet(); }, '/settings.html');
    add('Light / dark', I.sun, function () { closeSheet(); var b = document.getElementById('theme-toggle'); if (b) b.click(); });
    return items;
  }

  function build() {
    if (bar) return;
    styleEl = document.createElement('style'); styleEl.id = 'mtabbar-css'; styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
    bar = document.createElement('nav'); bar.className = 'mtabbar'; bar.setAttribute('aria-label', 'Trader navigation');
    VIEWS.forEach(function (v) {
      var b = document.createElement('button'); b.type = 'button'; b.setAttribute('data-view', v);
      b.innerHTML = ICONS[v] + '<span>' + LABELS[v] + '</span>';
      b.setAttribute('aria-label', LABELS[v]);
      if (v === 'more') b.setAttribute('aria-haspopup', 'dialog');
      b.addEventListener('click', function () { go(v); });
      bar.appendChild(b);
    });
    sheetBg = document.createElement('div'); sheetBg.className = 'mtab-sheet-bg'; sheetBg.addEventListener('click', closeSheet);
    sheet = document.createElement('div'); sheet.className = 'mtab-sheet'; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-label', 'More');
    var grip = document.createElement('div'); grip.className = 'mtab-grip'; sheet.appendChild(grip);
    sheetItems().forEach(function (el) { sheet.appendChild(el); });
    document.body.appendChild(sheetBg); document.body.appendChild(sheet); document.body.appendChild(bar);
    document.body.classList.add('has-mtabbar');
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
    // The trader page may have chosen its view before this deferred script built the bar:
    // read the view off the layout so the lit tab matches what is on screen.
    var current = null;
    if (onTrader) { var lay = document.querySelector('.layout'); var m = lay && String(lay.className).match(/\bmv-(watchlist|chart|trade|positions)\b/); current = m ? (m[1] === 'trade' ? 'chart' : m[1]) : 'chart'; }
    setActive(active || (onJournal ? 'journal' : current));
  }
  function teardown() {
    if (!bar) return;
    [bar, sheet, sheetBg, styleEl].forEach(function (el) { if (el && el.parentNode) el.parentNode.removeChild(el); });
    bar = sheet = sheetBg = styleEl = null;
    document.body.classList.remove('has-mtabbar');
  }
  function setActive(view) {
    active = view;
    if (!bar) return;
    bar.querySelectorAll('button').forEach(function (b) {
      var on = b.getAttribute('data-view') === view;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }
  function openSheet() { if (!sheet) return; sheet.classList.add('open'); sheetBg.classList.add('open'); }
  function closeSheet() { if (!sheet) return; sheet.classList.remove('open'); sheetBg.classList.remove('open'); }

  function sync() { if (isPhone()) build(); else teardown(); }
  window.MobileTabbar = { setActive: setActive, openSheet: openSheet, closeSheet: closeSheet, isPhone: isPhone };
  if (document.body) sync(); else document.addEventListener('DOMContentLoaded', sync);
  try { var mql = window.matchMedia(MQ); (mql.addEventListener ? mql.addEventListener('change', sync) : mql.addListener(sync)); } catch (e) { /* no matchMedia → desktop */ }
})();
