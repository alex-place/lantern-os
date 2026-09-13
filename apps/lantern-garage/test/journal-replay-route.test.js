'use strict';
/**
 * test/journal-replay-route.test.js — #3561.
 *
 * The route's job is to find one trade, hand back the bars around it, and be honest about
 * what it could not get. The rules worth pinning: the id it answers to is the id the
 * trade log minted (a lookup that skipped the scorecard's pipeline could resolve an id the
 * list never showed), the archive is tried before the network, the demo book is refused
 * outright, and nothing here runs until a reader asks for one trade.
 *
 * Run: node --test apps/lantern-garage/test/journal-replay-route.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-route-'));
const LEDGER = path.join(DIR, 'trades.jsonl');
const BARS = path.join(DIR, 'bars');
fs.mkdirSync(BARS);
process.env.TRADER_TRADES_LOG = LEDGER;
process.env.BAR_ARCHIVE_DIR = BARS;
process.env.JOURNAL_REPLAY_LIVE = '0';          // no network in a unit test

const route = require('../routes/journal-replay');
const { buildLog } = require('../lib/trade-log');
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_e) { /* gone */ } });

const T = (s) => Date.parse(s);
const OPEN = '2026-09-09T14:00:00.000Z';
const CLOSE = '2026-09-09T16:00:00.000Z';

function seed() {
  const rows = [
    { ts: OPEN, user: 'u1', event: 'entry', symbol: 'SPY', qty: 10, entry: 700, stop: 686, target1: 714, tier: 'A', p_win: 0.55 },
    { ts: CLOSE, user: 'u1', event: 'exit', symbol: 'SPY', qty: 10, entry: 700, exit: 707,
      pnl: 70, pnl_pct: 1, reason: 'take_profit_R', status: 'filled', order_id: 'ord-1',
      mfe_pct: 1.4, mae_pct: -0.3 },
    { ts: CLOSE, user: 'u1', event: 'exit', symbol: 'NOBARS', qty: 5, entry: 50, exit: 52,
      pnl: 10, pnl_pct: 4, reason: 'signal_exit', status: 'filled', order_id: 'ord-2' },
  ];
  fs.writeFileSync(LEDGER, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // 5m bars bracketing the trade with room either side.
  const t0 = T('2026-09-09T12:00:00.000Z');
  const bars = Array.from({ length: 90 }, (_, i) => ({
    t: new Date(t0 + i * 300000).toISOString(),
    o: 700 + i * 0.05, h: 700 + i * 0.05 + 0.3, l: 700 + i * 0.05 - 0.3, c: 700 + i * 0.05, v: 1000,
  }));
  fs.writeFileSync(path.join(BARS, 'SPY-5m.jsonl'), bars.map((b) => JSON.stringify(b)).join('\n') + '\n');
  require('../lib/bar-window')._clearCache();
}
seed();

function call(qs, { user = 'u1', role = 'supporter' } = {}) {
  const url = new URL('http://x/api/journal/replay' + qs);
  const req = Object.assign(new EventEmitter(), {
    method: 'GET', headers: {}, socket: {}, url: url.pathname + url.search,
  });
  if (user) req.session = { user: { id: user, role } };
  const out = {};
  const res = {
    writeHead: (code, h) => { out.status = code; out.headers = h; return res; },
    end: (b) => { out.raw = b; try { out.json = JSON.parse(b); } catch (_e) { /* not json */ } },
  };
  return route(req, res, url).then((handled) => Object.assign({ handled }, out));
}

const idOf = (sym) => {
  const rows = fs.readFileSync(LEDGER, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const log = buildLog(rows.filter((r) => r.event === 'exit'), { limit: 50 });
  const t = log.trades.find((x) => x.symbol === sym);
  assert.ok(t, 'seeded ' + sym);
  return t.id;
};

test('a non-matching path declines, so other routes still see the request', async () => {
  const url = new URL('http://x/api/journal/notes');
  const r = await route({ method: 'GET', headers: {}, socket: {} }, {}, url);
  assert.strictEqual(r, false);
});

test('no id is a bad request, not an empty chart', async () => {
  const r = await call('');
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error, 'missing_id');
});

test('an id nothing matches is a 404 rather than a blank replay', async () => {
  const r = await call('?id=' + encodeURIComponent('not-a-trade'));
  assert.strictEqual(r.status, 404);
});

test('it answers to the id the TRADE LOG minted', async () => {
  /* The two run the same preparedRows pipeline, which is the only thing that makes this
     true by construction rather than by luck: an id built from the raw ledger could name
     a row the list dropped as a duplicate or a no-fill. */
  const r = await call('?id=' + encodeURIComponent(idOf('SPY')));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.trade.symbol, 'SPY');
  assert.strictEqual(r.json.trade.id, idOf('SPY'));
});

test('the opening is recovered from the entry event the exit row does not carry', async () => {
  const r = await call('?id=' + encodeURIComponent(idOf('SPY')));
  const d = r.json;
  assert.strictEqual(d.opening.recovered, true);
  assert.strictEqual(d.opening.at, OPEN);
  assert.strictEqual(d.marks.stop, 686, 'the stop it was actually opened with');
  assert.strictEqual(d.marks.target1, 714);
  assert.match(d.marks.stopFrom, /placed at entry/);
});

test('the trade is marked on the bars, at both ends', async () => {
  const d = (await call('?id=' + encodeURIComponent(idOf('SPY')))).json;
  assert.strictEqual(d.coverage, 'full');
  assert.strictEqual(d.source, 'archive', 'the archive is tried first — it costs no request');
  assert.ok(d.bars.length > 10);
  assert.ok(d.marks.exitIdx > d.marks.entryIdx);
  assert.ok(d.marks.mfe > d.marks.entry && d.marks.mae < d.marks.entry, 'a long, either side of its entry');
});

test('a symbol we hold no bars for is honest rather than flat', async () => {
  const d = (await call('?id=' + encodeURIComponent(idOf('NOBARS')))).json;
  assert.strictEqual(d.coverage, 'none');
  assert.deepStrictEqual(d.bars, []);
  assert.match(d.why, /no bar history for NOBARS/);
});

test('the demo book is refused — its fills are invented and the bars would be real', async () => {
  /* The champion demo trades real tickers at invented prices. Drawing SPY's actual bars
     under an invented fill is the one dishonesty this whole card exists to avoid. */
  const d = (await call('?id=anything&demo=champion', { user: null })).json;
  assert.strictEqual(d.coverage, 'none');
  assert.strictEqual(d.source, 'demo');
  assert.deepStrictEqual(d.bars, []);
  assert.match(d.why, /simulated/);
});

test('another reader\'s trade is not reachable by id', async () => {
  const r = await call('?id=' + encodeURIComponent(idOf('SPY')), { user: 'someone-else' });
  assert.strictEqual(r.status, 404, 'the ledger is read scoped, so the id simply is not there');
});

test('POST is refused — this reads, it does not write', async () => {
  const url = new URL('http://x/api/journal/replay?id=x');
  const out = {};
  const res = { writeHead: (c) => { out.status = c; return res; }, end: (b) => { out.raw = b; } };
  await route({ method: 'POST', headers: {}, socket: {} }, res, url);
  assert.strictEqual(out.status, 405);
});
