'use strict';
/**
 * test/trader-acct-badge.test.js — the account badge says what the account IS (2026-10-11).
 *
 * It was static markup: "PAPER — simulated money; orders are practice, not real", whatever
 * was connected. Both adapters report the mode (lib/alpaca-adapter: env; lib/ibkr-cpapi: the
 * account id, DU… paper, U… live), and the page threw it away. On a live account that
 * sentence is the most dangerous one on the page. The page's own painter is run here.
 *
 * Run: node --test apps/lantern-garage/test/trader-acct-badge.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const SRC = PAGE.slice(PAGE.indexOf('function _tradePanelOpen(){'), PAGE.indexOf('function initFooterResize(){'));

function page(stored) {
  const cls = new Set(['badge', 'badge-none']);
  const bodyCls = new Set();
  const btn = {
    textContent: 'ACCOUNT', title: '', attrs: {}, dataset: { desc: 'Your account — checking whether it is paper or live.' },
    classList: { add: (c) => cls.add(c), remove: (...cs) => cs.forEach((c) => cls.delete(c)), contains: (c) => cls.has(c) },
    setAttribute(k, v) { this.attrs[k] = v; },
  };
  const store = { ...(stored || {}) };
  const fns = new Function('document', 'localStorage', SRC + '; return { _paintAcctBadge, initTradePanel, ACCT_BADGE };')(
    { body: { classList: { toggle: (c, on) => (on ? bodyCls.add(c) : bodyCls.delete(c)), contains: (c) => bodyCls.has(c) } }, getElementById: () => btn },
    { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } });
  return { fns, btn, cls, store };
}

test('a live account reads LIVE, a paper one PAPER — and neither is guessed', () => {
  const p = page();
  p.fns._paintAcctBadge('live');
  assert.strictEqual(p.btn.textContent, 'LIVE');
  assert.ok(p.cls.has('badge-live') && !p.cls.has('badge-paper'));
  assert.match(p.btn.title, /real-money account; orders execute with real funds/);
  assert.doesNotMatch(p.btn.title, /practice/);
  p.fns._paintAcctBadge('paper');
  assert.strictEqual(p.btn.textContent, 'PAPER');
  assert.ok(p.cls.has('badge-paper') && !p.cls.has('badge-live'));
  assert.match(p.btn.title, /orders are practice, not real/);
  for (const m of [undefined, null, 'unknown', 'margin']) {
    p.fns._paintAcctBadge(m);
    assert.strictEqual(p.btn.textContent, 'ACCOUNT', 'an unreported mode is not called paper: ' + m);
  }
  p.fns._paintAcctBadge('none');
  assert.strictEqual(p.btn.textContent, 'NO BROKER');
});

test('the device remembers the last answer, so a live account never opens as PAPER', () => {
  const p = page();
  p.fns._paintAcctBadge('live');
  assert.strictEqual(p.store['trader.acctMode:'], 'live');
  p.fns._paintAcctBadge(undefined);
  assert.strictEqual(p.store['trader.acctMode:'], 'live', 'an unreported answer does not overwrite a known one');
  const next = page({ 'trader.acctMode:': 'live' });
  next.fns.initTradePanel();
  assert.strictEqual(next.btn.textContent, 'LIVE', 'boot paints the remembered mode');
  const fresh = page();
  fresh.fns.initTradePanel();
  assert.strictEqual(fresh.btn.textContent, 'ACCOUNT', 'a new device starts neutral');
  // remembered per USER: one person's LIVE is not another's badge on a shared device
  assert.match(PAGE, /function _acctModeKey\(\)\{ return 'trader\.acctMode:' \+ \(\(typeof window !== 'undefined' && window\.SESSION_UID\) \|\| ''\); \}/);
  assert.match(PAGE, /window\.SESSION_UID = \(s && s\.user && s\.user\.id\) \|\| null;/);
});

test('every account answer paints it, and the menu heading follows', () => {
  const handler = PAGE.slice(PAGE.indexOf("_brokerOk = true; _refreshTradeGate();"), PAGE.indexOf('_accountFresh(a);'));
  assert.match(handler, /_paintAcctBadge\(a\.mode\);/);
  assert.match(PAGE, /function _accountNoBroker\(\)\{\n  _paintAcctBadge\('none'\);/);
  assert.match(PAGE, /'<div class="pat-menu-group">' \+ \(ACCT_BADGE\[_acctMode\] \|\| ACCT_BADGE\.unknown\)\.menu \+ '<\/div>'/);
  // Its wash is mixed from the tint token, as every wash on the page is (signal-palette.test).
  assert.match(PAGE, /\.badge-live\{background:color-mix\(in srgb, var\(--tint-neg\) 16%, transparent\);color:var\(--red\)/);
});
