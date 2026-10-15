'use strict';
/**
 * regime-shadow.test.js — the regime reader is a JOURNAL, not a trader (#3389).
 *
 * It exists to answer one measured question: can a capable model, shown the
 * tape a discretionary human uses, call the day's character better than chance?
 * Until the forward journal says yes, the module must be structurally incapable
 * of touching anything — these tests pin that, plus the honesty properties of
 * the prompt (no look-ahead) and the journal (restart-proof dedupe).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regime-')), 'regime.jsonl');
process.env.TRADER_REGIME_LOG = LOG;
const NEWS = path.join(path.dirname(LOG), 'news.jsonl');   // the v2 headlines come from here in tests, never the real feed
process.env.TRADER_REGIME_NEWS = NEWS;

const rs = require('../lib/regime-shadow');

const FIXED_CTX = {
  read: 'close', date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
  gapPct: null, vix: 15.1,
  todayBar: { d: 'today', o: 769, h: 771, l: 764, c: 765, ibs: 0.14 },
  spy: [{ d: '2026-08-20', o: 769, h: 771, l: 766, c: 767, ibs: 0.1 }],
  qqq5: [{ d: 'a', c: 100 }, { d: 'b', c: 101 }], iwm5: [{ d: 'a', c: 50 }, { d: 'b', c: 51 }],
};

const withEnv = async (env, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
};
const readLog = () => (fs.existsSync(LOG)
  ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : []);

test('NO ORDER AUTHORITY: the module cannot reach a bridge, broker, or the auto-trader', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'regime-shadow.js'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['placeIBKROrder', 'trading-api-bridge', 'auto-trader', 'alpaca-adapter', 'closeLong']) {
    assert.ok(!code.includes(forbidden), `regime-shadow must not touch ${forbidden}`);
  }
  const requires = [...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort();
  // ./app-paths is the data-root path helper (node's os/path/fs only, asserted in
  // test/trading-state-root.test.js), so it adds no order authority (ADR-0035 step 1).
  // ./trend-shadow (v2, 2026-10-01) supplies the noise-band math over bars; it is pinned
  // below to fs + path, so the guarantee holds through it.
  assert.deepStrictEqual(requires, ['./app-paths', './trend-shadow', 'fs', 'http', 'https', 'path'],
    `only node built-ins allowed, got: ${requires}`);
  const ts = fs.readFileSync(path.join(__dirname, '..', 'lib', 'trend-shadow.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.deepStrictEqual([...ts.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort(), ['fs', 'path'],
    'lib/trend-shadow.js must stay pure bar math (fs + path only)');
});

test('DEFAULT OFF: without the flag, run() does nothing and calls nothing', async () => {
  let called = false;
  const r = await withEnv({ TRADER_REGIME_SHADOW: null }, () =>
    rs.run('open', { fetchImpl: async () => { called = true; return { ok: true }; } }));
  assert.strictEqual(r.skipped, 'disabled');
  assert.strictEqual(called, false);
  assert.strictEqual(readLog().length, 0);
});

test('parseReply: strict fields, clamped conviction, degrades on garbage', () => {
  const good = rs.parseReply('noise {"regime":"trend_down","posture":"inverse","conviction":140,"reason":"lower highs"} tail');
  assert.deepStrictEqual([good.regime, good.posture, good.conviction, good.degraded],
    ['trend_down', 'inverse', 100, false]);
  for (const bad of ['not json', '{"regime":"sideways","posture":"long","conviction":50}',
    '{"regime":"chop","posture":"short","conviction":50}', '{}', '']) {
    assert.strictEqual(rs.parseReply(bad).degraded, true, JSON.stringify(bad.slice(0, 20)));
  }
});

test('OPEN-READ prompt has NO LOOK-AHEAD: today appears only as the gap, never as H/L/C', () => {
  // A synthetic context shaped like buildContext's output, with today's bar
  // deliberately known — the prompt must not leak it on the open read.
  const ctx = {
    read: 'open', date: '2026-08-21', gapPct: -0.42, vix: 15.1, todayBar: null,
    spy: [{ d: '2026-08-20', o: 769, h: 771, l: 766, c: 767, ibs: 0.1 }],
    qqq5: [{ d: 'a', c: 100 }, { d: 'b', c: 101 }], iwm5: [{ d: 'a', c: 50 }, { d: 'b', c: 51 }],
  };
  const p = rs.buildPrompt(ctx);
  assert.match(p, /09:35 ET/);
  assert.match(p, /-0\.42%/, 'the gap is the only thing known about today');
  assert.match(p, /2026-08-20/, 'history ends yesterday');
  assert.ok(!p.includes('2026-08-21  O'), 'no completed bar for today on the open read');
  assert.match(p, /strict JSON/);
});

test('CLOSE-READ prompt carries today’s completed bar and asks about TOMORROW', () => {
  const ctx = {
    read: 'close', date: '2026-08-21', gapPct: null, vix: 15.1,
    todayBar: { d: '2026-08-21', o: 769, h: 771, l: 764, c: 765, ibs: 0.14 },
    spy: [{ d: '2026-08-20', o: 769, h: 771, l: 766, c: 767, ibs: 0.1 }],
    qqq5: [{ d: 'a', c: 100 }, { d: 'b', c: 101 }], iwm5: [{ d: 'a', c: 50 }, { d: 'b', c: 51 }],
  };
  const p = rs.buildPrompt(ctx);
  assert.match(p, /16:00 ET close/);
  assert.match(p, /Call TOMORROW/);
  assert.match(p, /dayIBS 0\.14/, 'the completed bar is shown');
});

test('journal DEDUPE: a (date, read, provider) row fires exactly once, restart included', async () => {
  fs.writeFileSync(LOG, '');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  fs.appendFileSync(LOG, JSON.stringify({ date: today, read: 'open', provider: 'claude' }) + '\n');
  fs.appendFileSync(LOG, JSON.stringify({ date: today, read: 'open', provider: 'local' }) + '\n');
  assert.strictEqual(rs.alreadyLogged(today, 'open', 'claude'), true);
  assert.strictEqual(rs.alreadyLogged(today, 'open', 'local'), true);
  assert.strictEqual(rs.alreadyLogged(today, 'close', 'claude'), false, 'the other read still fires');
  const r = await withEnv({ TRADER_REGIME_SHADOW: '1' }, () =>
    rs.run('open', { ctx: { ...FIXED_CTX, read: 'open' }, fetchImpl: async () => { throw new Error('must not be called'); } }));
  assert.strictEqual(r.skipped, 'already logged');
});

test('a dead local provider degrades to a journalled reason — it can never block', async () => {
  fs.writeFileSync(LOG, '');
  // fetchImpl serves Claude a clean reply and refuses the local endpoint.
  const fetchImpl = async (url) => {
    if (String(url).includes('anthropic')) {
      return { ok: true, json: async () => ({ content: [{ type: 'text',
        text: '{"regime":"chop","posture":"flat","conviction":55,"reason":"range-bound tape"}' }] }) };
    }
    throw new Error('ECONNREFUSED');
  };
  await withEnv({ TRADER_REGIME_SHADOW: '1', ANTHROPIC_API_KEY: 'test-key' }, () =>
    rs.run('close', { ctx: FIXED_CTX, fetchImpl }));
  const rows = readLog();
  const claude = rows.find((r) => r.provider === 'claude');
  const local = rows.find((r) => r.provider === 'local');
  assert.ok(claude && !claude.degraded && claude.posture === 'flat', 'claude row is clean');
  assert.ok(local && local.degraded && /ECONNREFUSED/.test(local.reason), 'local row records why');
});

// ── the opening gap (2026-10-01) ─────────────────────────────────────────────
// Fetched at 09:35, Yahoo's DAILY bar for today still carried the previous
// session's open, so every open read of 08-21..09-30 was told a "gap" equal to
// open(D-1) / close(D-1) - 1. The open now comes from the intraday 09:30 bar.
function yahooChart(bars) {
  return { chart: { result: [{ timestamp: bars.map((b) => b.t),
    indicators: { quote: [{ open: bars.map((b) => b.o), high: bars.map((b) => b.h), low: bars.map((b) => b.l), close: bars.map((b) => b.c) }] } }] } };
}
function fakeYahoo({ intradayFirstMin = 570 } = {}) {
  // 12 sessions ending Mon 2026-08-31 (weekdays), then TODAY (Tue 09-01) as Yahoo's daily series shows it at 09:35:
  // a bar dated today that still carries yesterday's open.
  const days = [];
  for (let t = Date.parse('2026-08-14T13:30:00Z'); days.length < 12; t += 86400000) { const d = new Date(t); if (d.getUTCDay() % 6) days.push(t); }
  const daily = days.map((t, i) => ({ t: t / 1000, o: 760 + i, h: 763 + i, l: 758 + i, c: 761 + i }));
  const yesterday = daily[daily.length - 1];
  daily.push({ t: Date.parse('2026-09-01T13:30:00Z') / 1000, o: yesterday.o, h: yesterday.h, l: yesterday.l, c: 770 });   // stale open
  const first = Date.parse('2026-09-01T13:30:00Z') / 1000 + (intradayFirstMin - 570) * 60;
  const intraday = [{ t: first, o: 766.5, h: 767, l: 766, c: 766.8 }, { t: first + 300, o: 766.8, h: 767.5, l: 766.4, c: 767.2 }];
  return { yesterday, getJson: async (url) => (url.includes('interval=5m') ? yahooChart(intraday) : yahooChart(daily)) };
}
const NOW_0935 = Date.parse('2026-09-01T13:35:00Z');   // 09:35 ET

test('the open read: the gap is today\'s 09:30 print against yesterday\'s close, never the daily bar\'s stale open', async () => {
  const y = fakeYahoo();
  const ctx = await rs.buildContext('open', { getJson: y.getJson, now: NOW_0935 });
  assert.strictEqual(ctx.gapSource, 'intraday-0930');
  assert.strictEqual(ctx.gapPct, +(((766.5 / y.yesterday.c) - 1) * 100).toFixed(2));
  assert.notStrictEqual(ctx.gapPct, +(((y.yesterday.o / y.yesterday.c) - 1) * 100).toFixed(2), 'the bug: minus yesterday\'s intraday move');
  assert.ok(ctx.spy.every((b) => b.d < '2026-09-01'), 'today\'s bar stays out of the history');
});

test('the open read: no 09:30 bar yet means the gap is unavailable, not guessed', async () => {
  const y = fakeYahoo({ intradayFirstMin: 575 });
  const ctx = await rs.buildContext('open', { getJson: y.getJson, now: NOW_0935 });
  assert.strictEqual(ctx.gapPct, null);
  assert.strictEqual(ctx.gapSource, 'unavailable');
  assert.match(rs.buildPrompt(ctx), /flat \(gap unavailable\)/);
});

test('the close read: today\'s completed bar carries the intraday open', async () => {
  const y = fakeYahoo();
  const ctx = await rs.buildContext('close', { getJson: y.getJson, now: Date.parse('2026-09-01T20:05:00Z') });
  assert.strictEqual(ctx.todayBar.o, 766.5);
  assert.strictEqual(ctx.todayBar.c, 770);
  assert.strictEqual(ctx.openSource, 'intraday-0930');
});

// ── v2 (2026-10-01): the account's whole view, and positions ─────────────────
// The operator: "give a human trader or an AI all of the info that the trader has and
// just ask it to find positions". The open read and a new 10:35 mid read now carry the
// scan's universe, the indices against their noise bands, the headlines and the model's
// own track record, and answer with picks, which the journal prices for the scorer.
const SCAN = { signals: [
  { symbol: 'SPY', direction: 'NEUTRAL', entry_price: 767.2, decision_context: { ibs: 0.62 }, rsi: 55, news: { label: 'neutral' }, sector: null },
  { symbol: 'SOXL', direction: 'BULLISH', entry_price: 151.4, decision_context: { ibs: 0.12 }, rsi: 38, news: { label: 'bullish' }, sector: { etf: 'SMH', trend_pct: -0.8 } },
  { symbol: 'SQQQ', direction: 'BEARISH', entry_price: 33.1, decision_context: { ibs: 0.71 }, rsi: 61 },
  { symbol: 'soxl', direction: 'BULLISH', entry_price: 999 },                  // a duplicate: the first one stands
  { symbol: 'not a ticker!', entry_price: 1 },
] };

test('v2 universe: the scan as the system sees it, one row a name, nothing fetched', () => {
  const u = rs.universeOf(SCAN);
  assert.deepStrictEqual(u.map((x) => x.sym), ['SPY', 'SOXL', 'SQQQ']);
  assert.deepStrictEqual(u[1], { sym: 'SOXL', px: 151.4, ibs: 0.12, read: 'BULLISH', rsi: 38, news: 'bullish', sector: -0.8 });
  assert.deepStrictEqual(rs.universeOf(null), []);
});

test('v2 headlines: in time order, deduplicated, only the last 18 hours, never anything after now', () => {
  const now = Date.parse('2026-09-01T14:35:00Z');   // 10:35 ET
  const row = (minsAgo, headline, source = 'Reuters', symbols = ['SPY']) => JSON.stringify({ headline, source, published: new Date(now - minsAgo * 60000).toISOString(), symbols });
  fs.writeFileSync(NEWS, [row(20 * 60, 'too old'), row(300, 'Stocks steady ahead of the jobs report'), row(120, 'Chip stocks slide'),
    row(60, 'Chip stocks slide'), row(-30, 'FROM THE FUTURE'), 'not json'].join('\n') + '\n');
  const h = rs.headlinesOf(now);
  assert.deepStrictEqual(h.map((x) => x.headline), ['Stocks steady ahead of the jobs report', 'Chip stocks slide']);
  assert.ok(!h.some((x) => x.headline === 'FROM THE FUTURE'), 'no look-ahead');
});

test('v2 headlines: when there are more than fit, market-wide rows outrank single-stock list articles', () => {
  const now = Date.parse('2026-09-01T14:35:00Z');
  const row = (minsAgo, headline, source, symbols) => JSON.stringify({ headline, source, published: new Date(now - minsAgo * 60000).toISOString(), symbols });
  fs.writeFileSync(NEWS, [row(200, 'Futures slip ahead of the jobs report', 'Reuters', ['CME']), row(150, 'Yields jump', 'Bloomberg', []),
    row(30, '3 Reasons to Sell XYZ', 'StockStory', ['XYZ']), row(20, 'Why ABC Is a Buy', 'Motley Fool', ['ABC'])].join('\n') + '\n');
  assert.deepStrictEqual(rs.headlinesOf(now, { limit: 2 }).map((x) => x.headline), ['Futures slip ahead of the jobs report', 'Yields jump']);
});

test('v2 prompt: everything the account sees, the three decisions, and no bar of today beyond the reads', async () => {
  const y = fakeYahoo();
  fs.writeFileSync(NEWS, JSON.stringify({ headline: 'Chip stocks slide', source: 'Reuters', published: '2026-09-01T13:00:00Z' }) + '\n');
  fs.writeFileSync(LOG, '');
  const ctx = await rs.buildContext('mid', { getJson: y.getJson, now: Date.parse('2026-09-01T14:35:00Z'), scan: SCAN });
  assert.strictEqual(ctx.v, rs.PROMPT_V);
  assert.strictEqual(ctx.asOf, '10:35');
  assert.strictEqual(ctx.gapSource, 'intraday-0930', 'the mid read gets the fixed gap too');
  const p = rs.buildPrompt(ctx);
  for (const want of [/10:35 ET on 2026-09-01/, /SOXL\s+151\.40\s+IBS 0\.12\s+rule read BULLISH/, /Chip stocks slide/, /none yet: this is your first/,
    /"picks":\["SYM"\]/, /up to 3 names from the universe to hold/, /SPY\s+\+[\d.]+% from the open/]) assert.match(p, want);
  assert.ok(!p.includes('2026-09-01  O'), 'today is never a completed bar on an intraday read');
});

test('v2 replies: picks must be names in the universe, counted when dropped; v1 replies parse as before', () => {
  const u = rs.universeOf(SCAN);
  const r = rs.parseReply('{"regime":"trend_down","posture":"inverse","conviction":64,"day_type":"DROP","picks":["sqqq","NVDA","SQQQ","SOXL"],"avoid":["SOXL"],"reason":"x"}', { universe: u });
  assert.deepStrictEqual([r.day_type, r.picks, r.avoid, r.picks_dropped], ['DROP', ['SQQQ', 'SOXL'], ['SOXL'], 2]);
  const bad = rs.parseReply('{"regime":"chop","posture":"flat","conviction":50,"day_type":"SIDEWAYS","picks":"SOXL"}', { universe: u });
  assert.deepStrictEqual([bad.degraded, bad.day_type, bad.picks], [false, null, []]);
  const v1 = rs.parseReply('{"regime":"chop","posture":"flat","conviction":50,"reason":"r"}');
  assert.ok(!('picks' in v1) && !('day_type' in v1), 'a v1 reply carries no v2 fields');
});

test('v2 run: the journal prices the picks and the universe at the read, and a refused model falls back once', async () => {
  fs.writeFileSync(LOG, '');
  fs.writeFileSync(NEWS, '');
  const y = fakeYahoo();
  const models = [];
  const fetchImpl = async (url, opts) => {
    if (!String(url).includes('anthropic')) throw new Error('ECONNREFUSED');
    const model = JSON.parse(opts.body).model; models.push(model);
    if (model !== 'claude-opus-5') return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"regime":"trend_up","posture":"long","conviction":61,"day_type":"RALLY","picks":["SOXL"],"avoid":["SQQQ"],"reason":"semis lead"}' }] }) };
  };
  const now = Date.parse('2026-09-01T14:35:00Z');
  await withEnv({ TRADER_REGIME_SHADOW: '1', ANTHROPIC_API_KEY: 'test-key', TRADER_REGIME_MODEL: null }, () =>
    rs.run('mid', { scan: SCAN, getJson: y.getJson, now, fetchImpl }));
  const row = readLog().find((r) => r.provider === 'claude');
  assert.deepStrictEqual(models, ['claude-opus-5-5', 'claude-opus-5']);
  assert.strictEqual(row.model, 'claude-opus-5');
  assert.strictEqual(row.prompt_v, rs.PROMPT_V);
  assert.strictEqual(row.read, 'mid');
  assert.deepStrictEqual(row.picks, [{ symbol: 'SOXL', px: 151.4 }]);
  assert.deepStrictEqual(row.universe_px, { SPY: 767.2, SOXL: 151.4, SQQQ: 33.1 });
  assert.strictEqual(row.read_min, 635);
  assert.ok(row.spy_at_read > 0);
  assert.strictEqual(row.day_type, 'RALLY');
  const local = readLog().find((r) => r.provider === 'local');
  assert.ok(local.degraded && local.prompt_v === rs.PROMPT_V, 'the local model degrades, the row still says which prompt it was');
});

test('v2 track record: its own earlier calls with what followed, read from the journal (learning in context)', async () => {
  fs.writeFileSync(LOG, [
    { date: '2026-08-31', read: 'mid', provider: 'claude', prompt_v: 2, degraded: false, regime: 'trend_up', posture: 'long', conviction: 60, day_type: 'RALLY', spy_at_read: 770, picks: [{ symbol: 'SPY', px: 770 }] },
    { date: '2026-08-31', read: 'open', provider: 'claude', prompt_v: 2, degraded: false, regime: 'chop', posture: 'flat', conviction: 50, picks: [] },
    { date: '2026-08-31', read: 'mid', provider: 'local', prompt_v: 2, degraded: true },
    { date: '2026-09-01', read: 'mid', provider: 'claude', prompt_v: 2, degraded: false, regime: 'chop', posture: 'flat', conviction: 50, picks: [] },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const y = fakeYahoo();
  const t = await rs.trackOf('mid', Date.parse('2026-09-01T14:35:00Z'), y.getJson);
  assert.strictEqual(t.length, 1, 'same read, claude, v2, before today only');
  assert.strictEqual(t[0].date, '2026-08-31');
  assert.strictEqual(t[0].spyRetPct, +((y.yesterday.c / 770 - 1) * 100).toFixed(2));
  assert.deepStrictEqual(t[0].picks.map((p) => p.symbol), ['SPY']);
});

// ── v3 (2026-10-15): the pre-open read sets SIZE, from what a trader has before the bell ──
// The operator: "add the missing brain: news, earnings calls, the judgment a human uses".
// Every direction call measured at chance, so this read answers normal / half / stand aside
// for the day's new entries, from the pre-market, the futures, the headlines since the close
// and its own earlier calls with how the ACCOUNT then did. Still journal-only.
const NOW_0915 = Date.parse('2026-09-01T13:15:00Z');   // Tue 09:15 ET
function fakePreopenYahoo() {
  const y = fakeYahoo();
  const ymd = (h, m) => Date.parse(`2026-09-01T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`) / 1000;
  const pre = [
    { t: ymd(12, 0), o: 764.8, h: 765.2, l: 764.5, c: 765.0 },     // 08:00 ET
    { t: ymd(13, 5), o: 765.9, h: 766.2, l: 765.8, c: 766.0 },     // 09:05 ET
    { t: ymd(13, 10), o: 766.0, h: 766.5, l: 765.9, c: 766.4 },    // 09:10 ET: completes at 09:15, the last one shown
    { t: ymd(13, 30), o: 770, h: 771, l: 769, c: 770.5 },          // 09:30 ET: a regular-session bar must never appear
  ];
  const futures = { chart: { result: [{ meta: { regularMarketPrice: 6000, chartPreviousClose: 6030 }, timestamp: [], indicators: { quote: [{}] } }] } };
  return { yesterday: y.yesterday, getJson: async (url) => {
    if (url.includes('%3DF')) return futures;
    if (url.includes('includePrePost=true')) return yahooChart(pre);
    return y.getJson(url);
  } };
}

test('v3 pre-open context: the pre-market and the futures against the last close, never a regular-session print', async () => {
  fs.writeFileSync(LOG, '');
  fs.writeFileSync(NEWS, '');
  const y = fakePreopenYahoo();
  const ctx = await rs.buildContext('preopen', { getJson: y.getJson, now: NOW_0915 });
  assert.strictEqual(ctx.v, rs.PREOPEN_V);
  assert.strictEqual(ctx.asOf, '09:15');
  assert.deepStrictEqual(ctx.premarket[0], { sym: 'SPY', px: 766.4, chgPct: +((766.4 / y.yesterday.c - 1) * 100).toFixed(2), asOf: '09:15' });
  assert.deepStrictEqual(ctx.futures.map((f) => [f.sym, f.chgPct]), [['ES=F', -0.5], ['NQ=F', -0.5]]);
  assert.strictEqual(ctx.gapPct, null, 'no 09:30 print exists at 09:15');
  assert.ok(ctx.spy.every((b) => b.d < '2026-09-01'), 'history ends yesterday');
  assert.strictEqual(ctx.newsHours, 17, 'headlines since Monday 16:00, 17.25 hours');
  const p = rs.buildPrompt(ctx);
  for (const want of [/09:15 ET on 2026-09-01/, /Pre-market now:/, /SPY\s+766\.40\s+[+-][\d.]+% vs yesterday’s close \(as of 09:15\)/,
    /S&P 500 \(ES\) -0\.5%/, /"stance":"normal"\|"half"\|"stand_aside"/, /none yet: this is your first/]) assert.match(p, want);
  assert.ok(!p.includes('770.5') && !p.includes('2026-09-01  O'), 'nothing from the regular session of today');
  assert.ok(!/falling|knife|trap|crash/i.test(p), 'the prompt names no failure mode (#3370)');
});

test('v3 headline window: everything since the last close, never anything after now', async () => {
  fs.writeFileSync(LOG, '');
  const row = (iso, headline) => JSON.stringify({ headline, source: 'Reuters', published: iso, symbols: [] });
  fs.writeFileSync(NEWS, [row('2026-08-31T19:30:00Z', 'before the close'), row('2026-08-31T20:30:00Z', 'Chip stocks slide after hours'),
    row('2026-09-01T12:31:00Z', 'Futures slip after the jobs report'), row('2026-09-01T13:40:00Z', 'FROM THE FUTURE')].join('\n') + '\n');
  const ctx = await rs.buildContext('preopen', { getJson: fakePreopenYahoo().getJson, now: NOW_0915 });
  const shown = ctx.headlines.map((h) => h.headline);
  assert.deepStrictEqual(shown, ['Chip stocks slide after hours', 'Futures slip after the jobs report'],
    'since the 16:00 close (17.25 h), not the 15:30 row before it');
  assert.ok(!shown.includes('FROM THE FUTURE'), 'no look-ahead');
});

test('v3 replies: stance + conviction required, the rest bounded; garbage degrades', () => {
  const longEvent = 'x' + 'y'.repeat(200);
  const reply = JSON.stringify({ stance: 'stand_aside', range: 'huge', regime: 'trend_down', conviction: 140,
    events: ['CPI 08:30', longEvent, '', 'a', 'b', 'c', 'd', 'e', 'f'], reason: 'CPI day' });
  const good = rs.parsePreopen('ok ' + reply + ' tail');
  assert.deepStrictEqual([good.stance, good.range, good.regime, good.conviction, good.degraded], ['stand_aside', null, 'trend_down', 100, false]);
  assert.strictEqual(good.events.length, 6, 'at most six events');
  assert.ok(good.events.every((e) => e.length <= 80), 'each event bounded');
  for (const bad of ['not json', '{"stance":"short","conviction":50}', '{"stance":"half"}', '{}', '']) {
    assert.strictEqual(rs.parsePreopen(bad).degraded, true, JSON.stringify(bad.slice(0, 30)));
  }
  assert.strictEqual(rs.preopenEnabled(), process.env.TRADER_REGIME_PREOPEN !== '0', 'on with the shadow unless opted out');
});

test('v3 run: journals the stance, what it was shown, and the tokens it cost; the local model degrades', async () => {
  fs.writeFileSync(LOG, '');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const ctx = { read: 'preopen', v: rs.PREOPEN_V, date: today, asOf: '09:15', vix: 15.1, gapPct: null,
    spy: [{ d: '2026-08-31', o: 771, h: 774, l: 769, c: 772, ibs: 0.6 }], qqq5: [], iwm5: [],
    premarket: [{ sym: 'SPY', px: 766.4, chgPct: 0.3, asOf: '09:15' }, { sym: 'QQQ', unavailable: true }],
    futures: [{ sym: 'ES=F', name: 'S&P 500 (ES)', chgPct: -0.5 }, { sym: 'NQ=F', name: 'Nasdaq 100 (NQ)', unavailable: true }],
    headlines: [], track: [], newsHours: 17 };
  let body = null;
  const fetchImpl = async (url, opts) => {
    if (!String(url).includes('anthropic')) throw new Error('ECONNREFUSED');
    body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ usage: { input_tokens: 2100, output_tokens: 90 }, content: [{ type: 'text',
      text: '{"stance":"half","range":"wide","regime":"chop","conviction":62,"events":["CPI 08:30 ET"],"reason":"hot CPI, futures lower"}' }] }) };
  };
  await withEnv({ TRADER_REGIME_SHADOW: '1', ANTHROPIC_API_KEY: 'test-key', TRADER_REGIME_MODEL: null }, () =>
    rs.run('preopen', { ctx, fetchImpl }));
  const rows = readLog();
  const row = rows.find((r) => r.provider === 'claude');
  assert.match(body.messages[0].content, /pre-open risk desk/);
  assert.deepStrictEqual([row.read, row.prompt_v, row.stance, row.range, row.conviction], ['preopen', rs.PREOPEN_V, 'half', 'wide', 62]);
  assert.deepStrictEqual(row.events, ['CPI 08:30 ET']);
  assert.deepStrictEqual(row.usage, { in: 2100, out: 90 });
  assert.deepStrictEqual(row.premarket, { SPY: 0.3 });
  assert.deepStrictEqual(row.futures, { 'ES=F': -0.5 });
  assert.strictEqual(row.inputs.news_hours, 17);
  assert.ok(!('posture' in row) && !('picks' in row), 'a size call, not a direction or a pick');
  const local = rows.find((r) => r.provider === 'local');
  assert.ok(local.degraded && local.prompt_v === rs.PREOPEN_V);
  const again = await withEnv({ TRADER_REGIME_SHADOW: '1', ANTHROPIC_API_KEY: 'test-key' }, () =>
    rs.run('preopen', { ctx, fetchImpl: async () => { throw new Error('must not be called'); } }));
  assert.strictEqual(again.skipped, 'already logged', 'once a day, restarts included');
});

test('v3 track record: its own earlier pre-open calls with SPY\'s day and the account\'s day that followed', async () => {
  const LEDGER_FILE = path.join(path.dirname(LOG), 'ledger.jsonl');
  fs.writeFileSync(LEDGER_FILE, [
    { ts: '2026-08-31T20:00:00Z', event: 'entry', symbol: 'SPY' },
    { ts: '2026-08-31T20:01:00Z', event: 'session', date: '2026-08-31', equity: 101000, day_pnl: 1000 },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(LOG, [
    { date: '2026-08-31', read: 'preopen', provider: 'claude', prompt_v: 3, degraded: false, stance: 'half', range: 'wide', conviction: 60 },
    { date: '2026-08-31', read: 'preopen', provider: 'local', prompt_v: 3, degraded: true },
    { date: '2026-08-31', read: 'open', provider: 'claude', prompt_v: 2, degraded: false, regime: 'chop', posture: 'flat', conviction: 50 },
    { date: '2026-09-01', read: 'preopen', provider: 'claude', prompt_v: 3, degraded: false, stance: 'normal', conviction: 50 },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const t = await withEnv({ TRADER_REGIME_LEDGER: LEDGER_FILE }, () => rs.preopenTrackOf(NOW_0915, fakeYahoo().getJson));
  assert.strictEqual(t.length, 1, 'claude pre-open reads before today only');
  // fakeYahoo's 2026-08-31 bar: O 771 H 774 L 769 C 772; the session: +1,000 on 100,000 at the open
  assert.deepStrictEqual(t[0], { date: '2026-08-31', stance: 'half', range: 'wide', conviction: 60,
    spyOcPct: +((772 / 771 - 1) * 100).toFixed(2), spyRangePct: +((5 / 771) * 100).toFixed(2), acctPct: 1 });
  assert.match(rs.buildPrompt({ read: 'preopen', v: rs.PREOPEN_V, date: '2026-09-01', asOf: '09:15', spy: [], qqq5: [], iwm5: [], vix: null, track: t }),
    /2026-08-31: stance half, range wide \(conviction 60\); SPY then \+0\.13% open to close on a 0\.65% range; the account \+1% on the day/);
});

test('v3 clock: ET wall time to epoch across both offsets', () => {
  assert.strictEqual(rs.etWallMs('2026-09-01', 960), Date.parse('2026-09-01T20:00:00Z'), 'EDT');
  assert.strictEqual(rs.etWallMs('2026-12-01', 960), Date.parse('2026-12-01T21:00:00Z'), 'EST');
});

test('WIRED: the pre-open read fires from the scan loop ABOVE the market-hours gate, flag-gated and fire-and-forget', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'trading.js'), 'utf8');
  const fire = src.indexOf("_rs.run('preopen')");
  const gate = src.indexOf('if (marketHours || extNow || extManageNow)');
  assert.ok(fire > 0 && gate > 0 && fire < gate, 'before the bell the loop is idle below the gate, so the read must sit above it');
  const seg = src.slice(src.lastIndexOf('try {', fire), fire + 200);
  assert.match(seg, /_rs\.enabled\(\) && _rs\.preopenEnabled\(\)/);
  assert.match(seg, /_m >= 550 && _m < 570/, '09:10-09:29 ET');
  assert.match(seg, /\.catch\(/, 'never awaited, never throws into the loop');
});
