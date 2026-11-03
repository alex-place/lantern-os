'use strict';
/**
 * entry-tags.test.js — the market-context tags journal, and only journal (lib/entry-tags.js, 2026-11-02).
 *
 * These pin: gamma = the prior session's GEX ranked against the 252 sessions before it (terciles at 1/3 and 2/3, the
 * sign; an older row or a short history is a reason, not a number); news = the overnight (prior session 16:00 -> 09:30,
 * across a weekend and the DST change) and session (09:30 -> the entry, the history's 09:30-15:50) rates per hour,
 * ranked against the 120 sessions before (a session window under 30 minutes gets no rank); the refresh schedule of the
 * process with the server keys (the day's first at 09:30 with a missed session backfilled in the same call, the
 * overnight window read again until 15 minutes past the open so a late-arriving headline counts, hourly, 15:50 for C,
 * 16:05 for the settled count that joins the history, a failure retried after ten minutes, pages followed) and none
 * without keys; vix = now / prior - 1 at gate GV's fixed cut points (0 is QUIET, +8 % is FEAR), the
 * quote's own time and the measured lag, a quote from another day refused, the chart's previous close when the daily
 * read fails (labelled); one quote per scan with entries; the CSV once a day; a pass off the real clock writes nothing;
 * every failure is null with its reason; the news types (the research's keywords, WRAP apart, SHOCK and RATES groups, ranks
 * per window, the session mix, no rank without the typed history, the upgrade's recount); and in the brain: off without TRADER_ENTRY_TAGS, and on, the entry places
 * exactly as before while one entry_tags row lands under the user 'entry-tags'; a box that merely holds the Alpaca keys
 * never calls the news API, only the fetch role (TRADER_ENTRY_TAGS_NEWS_FETCH=1) does. The overnight book's hook is
 * pinned in overnight-book.test.js.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const et = require('../lib/entry-tags');
const cal = require('../lib/market-calendar');

const DAY = '2026-11-04';                                    // a Wednesday, EST (ET = UTC-5); prior session 11-03
const at = (day, hh, mm = 0, ss = 0) => et.etMs(day, hh * 60 + mm) + ss * 1000;
const iso = (ms) => new Date(ms).toISOString();
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'entry-tags-'));
const resp = (status, body) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, text: async () => text, json: async () => JSON.parse(text) };
};
const sessionsBefore = (day, n) => { const out = []; for (let d = cal.prevTradingDay(day); out.length < n; d = cal.prevTradingDay(d)) out.unshift(d); return out; };
/** A CSV of `n` sessions ending at `last`, GEX value(i) for the i-th oldest. */
function gexCsv(last, n, value) {
  const days = [last, ...sessionsBefore(last, n - 1).reverse()].reverse();
  return 'date,price,dix,gex\n' + days.map((d, i) => `${d},5000.1,0.41,${value(i, n)}`).join('\n') + '\n';
}
/** A counts history: `n` sessions before `day` whose rates are 1..n headlines over a weeknight (17.5 h) and a session (6 h 20), of every type. */
function history(day, n = 120) {
  return sessionsBefore(day, n).map((d, i) => ({ d, nOn: i + 1, nSe: i + 1, on: (i + 1) / 17.5, se: (i + 1) / (19 / 3), onH: 17.5,
    g: Object.fromEntries(et.TYPES.map((k) => [k, [i + 1, i + 1]])) }));
}
const noTypes = (rows) => rows.map(({ d, nOn, nSe, on, se }) => ({ d, nOn, nSe, on, se }));   // a row from before the types shipped
const zeroTypes = (over = {}) => Object.fromEntries(et.TYPES.map((k) => [k, over[k] || [0, 0]]));
/** A Yahoo ^VIX 1m chart whose meta says `px` at `atMs`, previous close `prev`. */
const vixChart = (px, atMs, prev = null) => ({ chart: { result: [{ meta: { symbol: '^VIX', regularMarketPrice: px, regularMarketTime: Math.floor(atMs / 1000), chartPreviousClose: prev } }] } });

test('gamma: the prior session against the 252 before it — terciles, the sign; an older row or a short history is a reason', () => {
  const rows = et.parseGex(gexCsv('2026-11-03', 300, (i) => (i + 1) * 1e6));
  assert.strictEqual(rows.length, 300);
  assert.deepStrictEqual(rows[rows.length - 1], ['2026-11-03', 300e6]);
  const hi = et.gammaReading(rows, DAY);
  assert.deepStrictEqual(hi, { as_of: '2026-11-03', gex: 300e6, rank: 1, tercile: 'HIGH', sign: 1, n: 252 });
  const neg = et.gammaReading(et.parseGex(gexCsv('2026-11-03', 300, (i, n) => (i === n - 1 ? -5e8 : (i + 1) * 1e6))), DAY);
  assert.deepStrictEqual([neg.rank, neg.tercile, neg.sign], [0, 'LOW', -1]);
  // the 252 before the last are i = 47..298, values 48e6..299e6: 125 of them are below 173e6 -> rank 0.496, MID
  const mid = et.gammaReading(et.parseGex(gexCsv('2026-11-03', 300, (i, n) => (i === n - 1 ? 173e6 : (i + 1) * 1e6))), DAY);
  assert.deepStrictEqual([mid.rank, mid.tercile], [0.496, 'MID']);
  const third = et.gammaReading(et.parseGex(gexCsv('2026-11-03', 300, (i, n) => (i === n - 1 ? 132e6 : (i + 1) * 1e6))), DAY);
  assert.deepStrictEqual([third.rank, third.tercile], [0.3333, 'MID'], '84 of 252 below = exactly 1/3 is MID, as in the research');
  assert.match(et.gammaReading(et.parseGex(gexCsv('2026-11-02', 300, (i) => i)), DAY).why, /the prior session 2026-11-03 is not in the CSV yet \(latest 2026-11-02\)/);
  assert.match(et.gammaReading(et.parseGex(gexCsv('2026-11-03', 200, (i) => i)), DAY).why, /short history \(199 of 252/);
  assert.deepStrictEqual(et.parseGex('date,price,dix,gex\n2026-10-29,1,0.4,\nnot,a,row,1\n2026-10-30,1,0.4,1060383967.3\n'), [['2026-10-30', 1060383967.3]]);
});

test('news windows: the prior session s 16:00 to 09:30 across a weekend and the DST change, then 09:30-15:50', () => {
  const w = et.windows('2026-11-02');                       // Monday, the first EST session; the prior session Friday 10-30 (EDT)
  assert.strictEqual(w.prev, '2026-10-30');
  assert.deepStrictEqual([iso(w.from), iso(w.open), iso(w.dec)], ['2026-10-30T20:00:00.000Z', '2026-11-02T14:30:00.000Z', '2026-11-02T20:50:00.000Z']);
  const ts = ['2026-10-30T19:59:59Z', '2026-10-30T20:00:00Z', '2026-11-01T12:00:00Z', '2026-11-02T14:29:59Z', '2026-11-02T14:30:00Z', '2026-11-02T20:49:59Z', '2026-11-02T20:50:00Z'].map(Date.parse);
  const r = et.sessionRow(ts, '2026-11-02');
  assert.deepStrictEqual([r.nOn, r.nSe], [3, 2], 'half-open windows: 16:00 and 09:30 open theirs, 15:50 closes the session');
  assert.ok(Math.abs(r.on - 3 / 66.5) < 1e-12, `66.5 real hours over the weekend (the clocks fell back): ${r.on}`);
  assert.ok(Math.abs(r.se - 2 / (6 + 20 / 60)) < 1e-12);
  const hol = et.windows('2026-11-27');                     // the Friday after Thanksgiving: the prior session is Wednesday
  assert.strictEqual(hol.prev, '2026-11-25');
});

test('news reading: each rate ranked against the 120 sessions before; short history, another day, a short window', () => {
  const w = et.windows(DAY);
  const today = { d: DAY, nOn: 100, nSe: 30, se_to: iso(at(DAY, 12, 30)), final: false, fetched_at: iso(at(DAY, 12, 30)) };
  const rd = et.newsReading({ history: history(DAY), today }, at(DAY, 12, 31));
  assert.strictEqual(rd.day, DAY); assert.strictEqual(rd.history, 120); assert.strictEqual(rd.history_to, '2026-11-03');
  // overnight 100 over 17.5 h against counts 1..120 over 17.5 h: 99 below -> 0.825 HIGH
  assert.deepStrictEqual(rd.overnight, { n: 100, hours: 17.5, rate: 5.714, rank: 0.825, tercile: 'HIGH' });
  // session 30 in 3 h = 10/h; the history s full sessions are 1..120 over 6.333 h: 63 below -> 0.525 MID
  assert.deepStrictEqual(rd.session, { n: 30, hours: 3, to: today.se_to, rate: 10, rank: 0.525, tercile: 'MID' });
  assert.strictEqual(rd.as_of, today.fetched_at);
  assert.ok((w.open - w.from) / 3600e3 === 17.5);
  const early = et.newsReading({ history: history(DAY), today: { ...today, nSe: 2, se_to: iso(at(DAY, 9, 30, 25)) } }, at(DAY, 9, 45));
  assert.strictEqual(early.overnight.tercile, 'HIGH', 'the overnight rank stands');
  assert.deepStrictEqual([early.session.n, early.session.tercile, early.session.why], [2, null, 'under 30 minutes of session']);
  assert.match(et.newsReading({ history: history(DAY, 119), today }, at(DAY, 12, 31)).why, /short history \(119 of 120/);
  assert.match(et.newsReading({ history: history(DAY), today: { ...today, d: '2026-11-03' } }, at(DAY, 12, 31)).why, /no news counts for 2026-11-04 yet/);
  assert.match(et.newsReading(null, at(DAY, 12, 31)).why, /no news counts file/);
});

test('the news types: the research keywords, a WRAP headline counts only as WRAP, SHOCK and RATES are groups of NEWS', () => {
  const cats = (h) => [...et.categorize(h)].sort();
  assert.deepStrictEqual(cats('USA CPI (MoM) For February 0.2%  Vs 0.3% Est.; 0.5% Prior'), ['DATA']);
  assert.deepStrictEqual(cats('Initial Jobless Claims 217K vs 227K Est.'), ['DATA']);
  assert.deepStrictEqual(cats("Fed's Powell Says We Will Continue To Make Decisions Meeting By Meeting"), ['FED']);
  assert.deepStrictEqual(cats('President Trump Says Not Going To Change Mind On April 2 Tariffs'), ['POLICY', 'TRADE']);
  assert.deepStrictEqual(cats("Iran's Deputy FM Says Tehran Ready for Possibility of War with US"), ['GEO']);
  assert.deepStrictEqual(cats('Trade War Escalates As Talks Stall'), ['TRADE'], 'a trade war is not a war');
  assert.deepStrictEqual(cats('CDC Reports 72,045 New Coronavirus Cases Yesterday'), ['HEALTH']);
  assert.deepStrictEqual(cats('The Nvidia Chart Shows The Importance Of Earnings From Tesla'), ['CORP']);
  assert.deepStrictEqual(cats('S&P 500 Index Futures Clinging To Gains'), ['WRAP']);
  assert.deepStrictEqual(cats('Carl Icahn Says Is Shorting The S&P'), []);
  assert.deepStrictEqual(cats(null), []);
  const g = et.groupTimes([{ t: 5, h: 'Stocks Fall Trump Begins China Presser' }, { t: 3, h: 'Trump Says Tariffs Stay' }, { t: 4, h: "Fed's Waller Says Rate Cuts Ahead" }, { t: 2, h: 'Carl Icahn Says Is Shorting The S&P' }, { t: 1, h: 'CPI 3.1% vs 3.0% Est.' }]);
  assert.deepStrictEqual(g.ALL, [1, 2, 3, 4, 5], 'sorted');
  assert.deepStrictEqual(g.WRAP, [5], 'a wrap headline naming Trump is a wrap');
  assert.deepStrictEqual(g.NEWS, [1, 2, 3, 4]);
  assert.deepStrictEqual(g.SHOCK, [3]); assert.deepStrictEqual(g.POLICY, [3]); assert.deepStrictEqual(g.TRADE, [3]);
  assert.deepStrictEqual(g.RATES, [1, 4]); assert.deepStrictEqual(g.DATA, [1]); assert.deepStrictEqual(g.FED, [4]);
  const w = et.windows(DAY);
  const r = et.sessionRow(et.groupTimes([{ t: w.from + 1000, h: 'Trump Says Tariffs Stay' }, { t: w.open + 1000, h: 'Stocks Rise At The Open' }, { t: w.open + 2000, h: "Fed's Powell Speaks" }]), DAY);
  assert.deepStrictEqual([r.nOn, r.nSe, r.onH], [1, 2, 17.5]);
  assert.deepStrictEqual([r.g.SHOCK, r.g.RATES, r.g.WRAP, r.g.NEWS], [[1, 0], [0, 1], [0, 1], [1, 1]]);
  assert.strictEqual(et.sessionRow([w.open + 1], DAY).g, undefined, 'a plain time list has no types');
});

test('the type reading: NEWS, SHOCK and RATES ranked per window, counts for the rest, the session mix; no rank without the history', () => {
  const g = zeroTypes({ NEWS: [100, 33], SHOCK: [100, 30], RATES: [1, 2], WRAP: [7, 8], POLICY: [60, 20], GEO: [40, 10], FED: [1, 2] });
  const today = { d: DAY, nOn: 107, nSe: 41, g, se_to: iso(at(DAY, 12, 30)), final: false, fetched_at: iso(at(DAY, 12, 30)) };
  const rd = et.newsReading({ history: history(DAY), today }, at(DAY, 12, 31));
  assert.deepStrictEqual(rd.overnight.types.SHOCK, { n: 100, rate: 5.714, rank: 0.825, tercile: 'HIGH' }, '100 over 17.5 h against 1..120 over 17.5 h');
  assert.deepStrictEqual(rd.session.types.SHOCK, { n: 30, rate: 10, rank: 0.525, tercile: 'MID' }, '30 in 3 h against the full sessions 1..120 over 6 h 20');
  assert.deepStrictEqual(rd.session.types.RATES, { n: 2, rate: 0.667, rank: 0.033, tercile: 'LOW' });
  assert.strictEqual(rd.overnight.types.NEWS.n, 100);
  assert.deepStrictEqual(rd.session.counts, { DATA: 0, FED: 2, TRADE: 0, GEO: 10, POLICY: 20, HEALTH: 0, CORP: 0, WRAP: 8 });
  assert.strictEqual(rd.mix, 'SHOCK'); assert.strictEqual(rd.types_why, undefined);
  assert.strictEqual(et.newsReading({ history: history(DAY), today: { ...today, g: zeroTypes({ RATES: [0, 3], SHOCK: [0, 2] }) } }, at(DAY, 12, 31)).mix, 'RATES');
  assert.strictEqual(et.newsReading({ history: history(DAY), today: { ...today, g: zeroTypes() } }, at(DAY, 12, 31)).mix, 'TIE');
  // the total's rank is unchanged by the types; a day without type counts reads as before
  const plain = et.newsReading({ history: history(DAY), today: { ...today, g: undefined } }, at(DAY, 12, 31));
  assert.strictEqual(plain.session.types, undefined); assert.strictEqual(plain.mix, null); assert.strictEqual(plain.session.tercile, rd.session.tercile);
  assert.match(plain.types_why, /no type counts for the day/);
  // a history row without types: the counts stay, the ranks go, the total's rank stands
  const hist = history(DAY); hist[50] = noTypes([hist[50]])[0];
  const part = et.newsReading({ history: hist, today }, at(DAY, 12, 31));
  assert.deepStrictEqual(part.session.types.SHOCK, { n: 30, rate: null, rank: null, tercile: null });
  assert.match(part.types_why, /119 of 120 history sessions have type counts/);
  assert.strictEqual(part.session.tercile, 'HIGH', '41 in 3 h: the total still ranks');
  // under 30 minutes of session: no session rank, the overnight ranks stand
  const early = et.newsReading({ history: history(DAY), today: { ...today, se_to: iso(at(DAY, 9, 30, 25)) } }, at(DAY, 9, 45));
  assert.strictEqual(early.session.types.SHOCK.tercile, null); assert.strictEqual(early.overnight.types.SHOCK.tercile, 'HIGH');
});

/** A news server: every headline (created_at) in [start, end], 50 a page, page tokens = offsets. It also serves the CSV
 *  (the pass's kick fetches it on any trading-day pass), which `calls` does not count. */
function newsServer(items, { fail = () => false, visible = () => true } = {}) {
  const calls = [];
  const rows = items.map((x) => (typeof x === 'number' ? { t: x, h: `h${x}` } : x));
  const csv = gexCsv(cal.prevTradingDay(DAY), 300, (i) => i + 1);
  const fetchFn = async (url, opts) => {
    if (url === et.GEX_URL) return resp(200, csv);
    if (!String(url).startsWith(et.NEWS_URL)) return resp(404, 'unknown');
    const u = new URL(url);
    calls.push({ url, start: u.searchParams.get('start'), end: u.searchParams.get('end'), token: u.searchParams.get('page_token'), headers: opts.headers });
    if (fail(calls.length)) return resp(500, 'down');
    const a = Date.parse(u.searchParams.get('start')), b = Date.parse(u.searchParams.get('end'));
    const all = rows.filter((r) => r.t >= a && r.t <= b && visible(r.t)).sort((x, y) => x.t - y.t);
    const off = Number(u.searchParams.get('page_token') || 0);
    return resp(200, { news: all.slice(off, off + 50).map((r) => ({ id: `${r.t}|${r.h}`, created_at: iso(r.t).replace('.000Z', 'Z'), headline: r.h })), next_page_token: off + 50 < all.length ? String(off + 50) : null });
  };
  return { fetchFn, calls };
}
const spread = (n, a, b) => Array.from({ length: n }, (_, i) => Math.round((a + ((i + 0.5) * (b - a)) / n) / 1000) * 1000);   // n whole seconds inside (a, b)

test('the refresh (server keys): 09:30 with a missed session backfilled, the overnight recounted once settled, hourly, 15:50 for C, 16:05 for the history', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'news.json'), JSON.stringify({ v: 1, history: history('2026-11-03'), today: null }));   // ends 11-02: 11-03 is missing
  const w3 = et.windows('2026-11-03'), w4 = et.windows(DAY);
  const headed = (ts, h) => ts.map((t) => ({ t, h }));
  const times = [...spread(4, w3.from, w3.open), ...spread(60, w3.open, w3.dec), ...headed(spread(5, w4.from, at(DAY, 9, 0)), 'Trump Says Tariffs Stay'), { t: at(DAY, 9, 29, 50), h: 'Stocks Fall Before The Open' },
    ...headed(spread(3, w4.open, at(DAY, 10, 0)), "Fed's Powell Says Rates Stay"), ...headed(spread(2, at(DAY, 10, 40), at(DAY, 15, 0)), 'Russia Says Missile Test Done'), at(DAY, 15, 45), at(DAY, 15, 49, 30), at(DAY, 15, 52)];
  let now = at(DAY, 9, 29);
  const srv = newsServer(times, { visible: (t) => t + 60000 <= now });   // the API shows a headline a minute after its created_at
  const c = { dir, headers: { 'APCA-API-KEY-ID': 'k', 'APCA-API-SECRET-KEY': 's' }, fetchFn: srv.fetchFn };
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'news.json'), 'utf8'));
  et._reset({ clock: () => now });
  await et.kick(now, c);
  assert.strictEqual(srv.calls.length, 0, 'no news call before 09:30 (the pre-market pass fetched only the CSV)');
  now = at(DAY, 9, 30, 25);
  await et.kick(now, c);
  assert.strictEqual(srv.calls.length, 2, 'one window, two pages (69 headlines)');
  assert.strictEqual(srv.calls[0].start, '2026-11-02T21:00:00Z', 'from the last seeded session s 16:00: the backfill and today in one call');
  assert.strictEqual(srv.calls[0].end, '2026-11-04T14:30:25Z');
  assert.match(srv.calls[0].url, /symbols=SPY,QQQ,SMH,DIA,IWM/); assert.match(srv.calls[0].url, /include_content=false/); assert.match(srv.calls[0].url, /sort=asc/);
  assert.strictEqual(srv.calls[0].headers['APCA-API-KEY-ID'], 'k');
  let st = read();
  const seedRow = et.sessionRow(et.groupTimes(times.map((x) => (typeof x === 'number' ? { t: x, h: `h${x}` } : x))), '2026-11-03');
  assert.deepStrictEqual(st.history[st.history.length - 1], seedRow, 'the backfill is counted as the seed counts, types included');
  assert.deepStrictEqual(st.backfilled, ['2026-11-03']);
  assert.deepStrictEqual([st.today.d, st.today.nOn, st.today.on_final, st.today.nSe, st.today.final], [DAY, 5, false, 0, false], 'the 09:29:50 headline is not visible yet');
  assert.deepStrictEqual([st.today.g.SHOCK, st.today.g.POLICY, st.today.g.TRADE, st.today.g.WRAP], [[5, 0], [5, 0], [5, 0], [0, 0]], 'the types of the overnight window');
  now = at(DAY, 10, 0); await et.kick(now, c);
  assert.strictEqual(srv.calls.length, 2, 'not due before the hour');
  now = at(DAY, 10, 30, 30); await et.kick(now, c);
  assert.strictEqual(srv.calls.length, 3);
  assert.strictEqual(srv.calls[2].start, '2026-11-03T21:00:00Z', 'the overnight window is read again once the open is 15 minutes old');
  st = read();
  assert.deepStrictEqual([st.today.nOn, st.today.on_final, st.today.nSe], [6, true, 3], 'the late headline is counted, and the overnight count settles');
  assert.deepStrictEqual([st.today.g.WRAP, st.today.g.RATES, st.today.g.FED, st.today.g.NEWS], [[1, 0], [0, 3], [0, 3], [5, 3]], 'the late one is a WRAP; the session s are RATES');
  now = at(DAY, 11, 30, 35); await et.kick(now, c);
  assert.strictEqual(srv.calls[3].start, '2026-11-04T14:30:00Z', 'then the session only');
  st = read();
  assert.deepStrictEqual([st.today.g.SHOCK, st.today.g.WRAP], [[5, 0], [1, 0]], 'the settled overnight types are kept when only the session is read');
  now = at(DAY, 15, 50, 25); await et.kick(now, c);
  st = read();
  assert.strictEqual(srv.calls[srv.calls.length - 1].end, '2026-11-04T20:50:00Z', 'C s count ends at 15:50');
  assert.deepStrictEqual([st.today.nSe, st.today.final], [6, false], 'the 15:49:30 headline is not visible yet');
  assert.strictEqual(st.history[st.history.length - 1].d, '2026-11-03', 'the day is not in the history yet');
  const n = srv.calls.length;
  now = at(DAY, 15, 55); assert.strictEqual(et.kick(now, c), null, 'C s count once');
  now = at(DAY, 16, 5, 30); await et.kick(now, c);
  st = read();
  assert.strictEqual(srv.calls.length, n + 1);
  assert.deepStrictEqual([st.today.nSe, st.today.final], [7, true], 'the settled count has it');
  const last = st.history[st.history.length - 1];
  assert.deepStrictEqual([last.d, last.nOn, last.nSe, last.onH], [DAY, 6, 7, 17.5], 'and the day joins the history');
  assert.deepStrictEqual([last.g.SHOCK, last.g.RATES, last.g.WRAP, last.g.NEWS], [[5, 2], [0, 3], [1, 0], [5, 7]], 'with its types');
  now = at(DAY, 16, 10); assert.strictEqual(et.kick(now, c), null, 'nothing more');
  assert.strictEqual(srv.calls.length, n + 1);
  // a reader without keys (stable) gets the same reading from the same file, and never calls
  const reader = { dir, headers: null, fetchFn: async () => { throw new Error('a reader never fetches'); } };
  et._reset({ clock: () => now });
  assert.strictEqual(et.kick(now, reader), null);
  const rows = [];
  now = at(DAY, 16, 10, 30);
  await et.tag({ symbol: 'SPY', qty: 10, price: 700, now }, { ...reader, log: (r) => rows.push(r) });
  assert.strictEqual(rows[0].news.session.n, 7); assert.strictEqual(rows[0].news.day, DAY);
  assert.deepStrictEqual([rows[0].news.session.types.SHOCK.n, rows[0].news.session.types.SHOCK.tercile, rows[0].news.session.types.RATES.n], [2, 'LOW', 3], 'the row carries the types, ranked');
  assert.deepStrictEqual([rows[0].news.overnight.types.SHOCK.n, rows[0].news.overnight.counts.WRAP, rows[0].news.mix], [5, 1, 'RATES']);
});

test('the upgrade: recent history rows without type counts are counted again by the next refresh, in the same call', async () => {
  const dir = tmpDir();
  const hist = history(DAY);
  hist[hist.length - 1] = noTypes([hist[hist.length - 1]])[0];                 // 11-03, as the first build wrote it
  fs.writeFileSync(path.join(dir, 'news.json'), JSON.stringify({ v: 1, history: hist, today: null }));
  const w3 = et.windows('2026-11-03'), w4 = et.windows(DAY);
  const items = [{ t: w3.from + 1000, h: 'Trump Says Tariffs Stay' }, { t: w3.open + 1000, h: "Fed's Powell Says Rates Stay" }, { t: w4.from + 1000, h: 'Russia Says Missile Test Done' }];
  const srv = newsServer(items);
  const now = at(DAY, 9, 31);
  et._reset({ clock: () => now });
  await et.kick(now, { dir, headers: { 'APCA-API-KEY-ID': 'k', 'APCA-API-SECRET-KEY': 's' }, fetchFn: srv.fetchFn });
  assert.strictEqual(srv.calls.length, 1, 'one call');
  assert.strictEqual(srv.calls[0].start, iso(w3.from).replace('.000Z', 'Z'), 'from that row s own overnight window');
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'news.json'), 'utf8'));
  const row = st.history.find((h) => h.d === '2026-11-03');
  assert.deepStrictEqual([row.nOn, row.nSe, row.g.SHOCK, row.g.RATES, row.onH], [1, 1, [1, 0], [0, 1], 17.5]);
  assert.strictEqual(st.history.length, hist.length, 'in place, no new row');
  assert.deepStrictEqual(st.backfilled, ['2026-11-03']);
  assert.deepStrictEqual([st.today.nOn, st.today.g.SHOCK], [1, [1, 0]], 'and today s overnight window from the same call');
  // the older ones with no type counts are the seed's job: a refresh does not reach past its backfill window
  const dir2 = tmpDir();
  fs.writeFileSync(path.join(dir2, 'news.json'), JSON.stringify({ v: 1, history: noTypes(history(DAY)), today: null }));
  const srv2 = newsServer([]);
  et._reset({ clock: () => now });
  await et.kick(now, { dir: dir2, headers: { 'APCA-API-KEY-ID': 'k', 'APCA-API-SECRET-KEY': 's' }, fetchFn: srv2.fetchFn });
  const st2 = JSON.parse(fs.readFileSync(path.join(dir2, 'news.json'), 'utf8'));
  assert.strictEqual(st2.history.filter((h) => h.g).length, 10, 'the last ten rows only');
  assert.strictEqual(st2.history.length, 120);
});

test('a failed refresh is retried after ten minutes; no keys, no call; a pass off the real clock does nothing', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'news.json'), JSON.stringify({ v: 1, history: history(DAY), today: null }));
  const srv = newsServer([], { fail: (k) => k === 1 });
  const c = { dir, headers: { 'APCA-API-KEY-ID': 'k', 'APCA-API-SECRET-KEY': 's' }, fetchFn: srv.fetchFn };
  let now = at(DAY, 9, 31);
  et._reset({ clock: () => now });
  await et.kick(now, c);
  assert.strictEqual(srv.calls.length, 1);
  now = at(DAY, 9, 36); assert.strictEqual(et.kick(now, c), null, 'inside the ten minutes');
  now = at(DAY, 9, 41, 30); await et.kick(now, c);
  assert.strictEqual(srv.calls.length, 2);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'news.json'), 'utf8')).today.d, DAY);
  et._reset({ clock: () => at(DAY, 11) });
  assert.strictEqual(et.kick(at(DAY, 11), { ...c, headers: null }), null, 'no keys: no refresh');
  et._reset({ clock: () => at(DAY, 11) + 3600e3 });
  assert.strictEqual(et.kick(at(DAY, 11), c), null, 'a replay s clock: nothing');
  const rows = [];
  await et.tag({ symbol: 'SPY', qty: 1, price: 1, now: at(DAY, 11) }, { ...c, log: (r) => rows.push(r) });
  assert.strictEqual(rows.length, 0, 'and no row');
  assert.strictEqual(srv.calls.length, 2);
  et._reset({ clock: () => at('2026-11-07', 11) });          // a Saturday
  assert.strictEqual(et.kick(at('2026-11-07', 11), c), null);
});

test('vix: now / prior - 1 at the fixed cut points; the quote s own time and the measured lag; another day refused', () => {
  const now = at(DAY, 15, 50, 30), qAt = at(DAY, 15, 50, 2);
  const q = (px, prevClose = 19.5) => ({ px, at: qAt, fetchedAt: now, prevClose });
  const b = (px) => et.vixReading(now, q(px), 20).bucket;
  assert.deepStrictEqual([b(20), b(19), b(21.598), b(21.6), b(25)], ['QUIET', 'QUIET', 'MILD', 'FEAR', 'FEAR'], 'unchanged is QUIET, +8 % is FEAR');
  const r = et.vixReading(now, q(21.28), 19.42);
  assert.deepStrictEqual(r, { prior: 19.42, prior_src: 'daily', prior_meta: 19.5, now: 21.28, chg: 0.0958, bucket: 'FEAR', as_of: iso(qAt), lag_sec: 28 });
  const meta = et.vixReading(now, q(21.28, 19.42), null);
  assert.deepStrictEqual([meta.prior, meta.prior_src, meta.bucket], [19.42, 'chart_meta', 'FEAR'], 'the chart s previous close when the daily read fails, labelled');
  assert.match(et.vixReading(now, q(21.28, null), null).why, /no prior close/);
  assert.match(et.vixReading(now, { ...q(21.28), at: at('2026-11-03', 16, 14) }, 19.42).why, /the quote is from 2026-11-03/);
  assert.match(et.vixReading(now, { why: 'quote HTTP 503' }, 19.42).why, /HTTP 503/);
});

/** Yahoo + SqueezeMetrics, routed by URL; counts every call. */
function market({ csv, vix = null, vixStatus = 200, csvStatus = 200 } = {}) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url === et.GEX_URL) return resp(csvStatus, csv);
    if (url === et.VIX_URL) { if (vix instanceof Error) throw vix; return resp(vixStatus, vix); }
    return resp(404, 'unknown');
  };
  return { fetchFn, calls, count: (u) => calls.filter((x) => x === u).length };
}

test('the row: gamma, news and vix for an entry; one quote per scan with entries, the CSV once a day', async () => {
  const dir = tmpDir();
  let now = at(DAY, 15, 50, 25);
  const today = { d: DAY, nOn: 100, nSe: 60, se_to: iso(at(DAY, 15, 50)), final: true, fetched_at: iso(at(DAY, 15, 50, 26)) };
  fs.writeFileSync(path.join(dir, 'news.json'), JSON.stringify({ v: 1, history: history(DAY), today }));
  const m = market({ csv: gexCsv('2026-11-03', 300, (i) => (i + 1) * 1e6), vix: vixChart(21.28, at(DAY, 15, 50, 1), 19.42) });
  const rows = [];
  const c = { dir, headers: null, fetchFn: m.fetchFn, log: (r) => rows.push(r), vixPrior: async () => 19.42 };
  et._reset({ clock: () => now + 1500 });
  await Promise.all([
    et.tag({ symbol: 'qqq', account: 'local-owner', qty: 50, price: 600.123456, now, order_id: 77, source: 'trader' }, c),
    et.tag({ symbol: 'SPY', account: 'local-owner', qty: 10, price: 700, now }, c),
  ]);
  assert.strictEqual(rows.length, 2);
  const r = rows.find((x) => x.symbol === 'QQQ');
  assert.deepStrictEqual(Object.keys(r), ['event', 'symbol', 'account', 'source', 'qty', 'entry_px', 'notional', 'order_id', 'entry_at', 'gamma', 'news', 'vix', 'shadow']);
  assert.deepStrictEqual([r.event, r.account, r.source, r.qty, r.entry_px, r.notional, r.order_id, r.entry_at, r.shadow],
    ['entry_tags', 'local-owner', 'trader', 50, 600.1235, 30006, '77', iso(now), true]);
  assert.deepStrictEqual(r.gamma, { as_of: '2026-11-03', gex: 300e6, rank: 1, tercile: 'HIGH', sign: 1, n: 252 });
  assert.deepStrictEqual([r.news.overnight.tercile, r.news.session.n, r.news.session.to], ['HIGH', 60, today.se_to]);
  assert.deepStrictEqual([r.vix.bucket, r.vix.prior_src, r.vix.lag_sec], ['FEAR', 'daily', 26]);
  assert.strictEqual(rows.find((x) => x.symbol === 'SPY').source, 'trader', 'the default source');
  assert.strictEqual(m.count(et.VIX_URL), 1, 'the entries of one pass share one quote');
  assert.strictEqual(m.count(et.GEX_URL), 1);
  assert.ok(fs.existsSync(path.join(dir, 'gex.json')), 'the CSV is cached for the other processes');
  now = at(DAY, 15, 55, 25);
  await et.tag({ symbol: 'SMH', qty: 5, price: 300, now }, c);
  assert.strictEqual(m.count(et.VIX_URL), 2, 'a new scan with entries asks again');
  assert.strictEqual(m.count(et.GEX_URL), 1, 'the CSV once a day');
  // another process reads the cached CSV without fetching it
  et._reset({ clock: () => now + 1500 });
  const other = market({ csv: 'never', vix: vixChart(21.3, at(DAY, 15, 55), 19.42) });
  await et.tag({ symbol: 'IWM', qty: 5, price: 200, now }, { ...c, fetchFn: other.fetchFn });
  assert.strictEqual(other.count(et.GEX_URL), 0);
  assert.strictEqual(rows[rows.length - 1].gamma.tercile, 'HIGH');
});

test('failures are null with their reasons; an unrefreshed CSV is asked again only after an hour', async () => {
  const dir = tmpDir();
  let now = at(DAY, 10, 0);
  const m = market({ csv: gexCsv('2026-11-02', 300, (i) => i + 1), vix: new Error('socket hang up') });
  const rows = [];
  const c = { dir, headers: null, fetchFn: m.fetchFn, log: (r) => rows.push(r), vixPrior: async () => { throw new Error('daily read failed'); } };
  et._reset({ clock: () => now });
  await et.tag({ symbol: 'SPY', qty: 1, price: 700, now }, c);
  const r = rows[0];
  assert.deepStrictEqual([r.gamma, r.news, r.vix], [null, null, null]);
  assert.match(r.gamma_why, /the prior session 2026-11-03 is not in the CSV yet \(latest 2026-11-02\)/);
  assert.match(r.news_why, /no news counts file/);
  assert.match(r.vix_why, /quote failed \(socket hang up\)/);
  now = at(DAY, 10, 30); await et.tag({ symbol: 'SPY', qty: 1, price: 700, now }, c);
  assert.strictEqual(m.count(et.GEX_URL), 1, 'not again inside the hour');
  now = at(DAY, 11, 0, 1); await et.tag({ symbol: 'SPY', qty: 1, price: 700, now }, c);
  assert.strictEqual(m.count(et.GEX_URL), 2, 'again after it');
  const down = market({ csv: 'x', csvStatus: 503, vix: vixChart(18, at(DAY, 11, 0), 19), vixStatus: 200 });
  et._reset({ clock: () => now });
  await et.tag({ symbol: 'SPY', qty: 1, price: 700, now }, { ...c, dir: tmpDir(), fetchFn: down.fetchFn });
  const d = rows[rows.length - 1];
  assert.match(d.gamma_why, /CSV fetch failed \(HTTP 503\)/);
  assert.deepStrictEqual([d.vix.bucket, d.vix.prior_src], ['QUIET', 'chart_meta'], 'the daily read failed: the chart s previous close, labelled');
});

test('the brain: off without TRADER_ENTRY_TAGS; on, the entry places as before and one entry_tags row carries the user entry-tags', async () => {
  const BDAY = '2026-09-22';                                // a Tuesday, EDT
  const NOW = et.etMs(BDAY, 15 * 60);
  const dir = tmpDir(), tags = tmpDir();
  const log = path.join(dir, 'trades.jsonl');
  fs.writeFileSync(path.join(tags, 'news.json'), JSON.stringify({ v: 1, history: history(BDAY),
    today: { d: BDAY, nOn: 100, nSe: 50, se_to: iso(et.etMs(BDAY, 14 * 60 + 30)), final: false, fetched_at: iso(et.etMs(BDAY, 14 * 60 + 30)) } }));
  Object.assign(process.env, {
    TRADER_TRADES_LOG: log, TRADER_STATE_FILE: path.join(dir, 'state.json'), TRADER_AUTO_EXECUTE: '1', TRADER_REQUIRE_PERSIST: '0',
    TRADER_ENTRY_KNIFE_FILTER: '0', TRADER_SUP_ENTRY: '0', TRADER_STRESS_MULT: '1', TRADER_ENTRY_CONFIRM: '0', TRADER_ENTRY_CADENCE_MIN: '0',
    TRADER_MOMENTUM_EXIT: '0', TRADER_ZONE_EXIT: '0', TRADER_TAKE_PROFIT_R: '0', TRADER_EXIT_MIN_PWIN: '0', TRADER_EOD_DECARRY: '0', TRADER_LIMIT_SHADOW: '0',
  });
  for (const k of ['TRADER_MANAGE_EXITS', 'TRADER_ENTRY_REQUOTE', 'TRADER_TREND_SHADOW', 'TRADER_NOISE_SHADOW', 'TRADER_RISE_SHADOW', 'TRADER_ENTRY_TAGS', 'TRADER_ENTRY_TAGS_DIR',
    'ALPACA_API_KEY_ID', 'ALPACA_API_KEY', 'APCA_API_KEY_ID', 'ALPACA_API_SECRET_KEY', 'ALPACA_API_SECRET', 'ALPACA_SECRET_KEY', 'APCA_API_SECRET_KEY']) delete process.env[k];
  // the market-data module is replaced before the brain loads it, and fetch is routed: no network in a test
  const mdPath = require.resolve('../lib/market-data-yahoo');
  require.cache[mdPath] = { id: mdPath, filename: mdPath, loaded: true, exports: {
    getQuotes: async (tickers) => tickers.map((t) => ({ ticker: t, price: 500, chg_pct: 0 })),
    getBars: async () => ({ bars: [] }), getBarsMulti: async () => ({ bars: {} }), getSessionBars15m: async () => ({ bars: [] }),
    getBarsWindow: async () => ({ bars: [] }), getMarketStatus: async () => ({}), isUsEquityMarketOpen: () => true } };
  const fetched = [], newsCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    fetched.push(String(url));
    if (String(url).startsWith(et.NEWS_URL)) { newsCalls.push({ url, key: opts && opts.headers && opts.headers['APCA-API-KEY-ID'] }); return resp(200, { news: [], next_page_token: null }); }
    if (url === et.GEX_URL) return resp(200, gexCsv('2026-09-21', 300, (i) => (300 - i) * 1e6));   // the prior session is the year s lowest
    if (url === et.VIX_URL) return resp(200, vixChart(16.2, NOW - 20000, 16.9));
    if (/chart\/%5EVIX\?interval=1d/.test(url)) {                                                  // the brain s _vixPriorClose
      const d = sessionsBefore(BDAY, 3).map((x) => et.etMs(x, 16 * 60 + 15));
      return resp(200, { chart: { result: [{ timestamp: d.map((t) => t / 1000), indicators: { quote: [{ close: [17.5, 17.1, 16.9] }] } }] } });
    }
    return resp(404, 'no network in a test');
  };
  try {
    et._reset({ clock: () => NOW + 2000 });
    const brain = require('../lib/auto-trader');
    const rows = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
    const signal = { symbol: 'QQQ', direction: 'BULLISH', entry_price: 500, decision_context: { ibs: 0.1 }, convergence: { decision: 'ENTER', p_win: 0.8 } };
    const bridge = () => {
      const placed = [];
      return { placed, getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }), getIBKRPositions: async () => [], getIBKROpenOrders: async () => [], getIBKRDayPnl: async () => 0,
        placeIBKROrder: async (_u, o) => { placed.push(o); return { status: 'placed', order_id: String(placed.length) }; }, cancelIBKROrder: async () => ({ ok: true }) };
    };
    const off = bridge();
    await brain.runAutoTrade({ signals: [signal] }, { bridge: off, userId: 'local-owner', now: NOW });
    await new Promise((r) => setTimeout(r, 50));
    const offBuys = off.placed.filter((o) => o.side === 'buy' && o.ticker === 'QQQ');
    assert.strictEqual(offBuys.length, 1, 'the trader buys QQQ');
    assert.ok(!rows().some((r) => r.event === 'entry_tags'), 'off by default: no rows');
    assert.deepStrictEqual(fetched, [], 'off by default: no fetch');

    brain._resetCooldowns(); fs.unlinkSync(log);
    // the box holds the Alpaca server keys (stable's env carries the engine's), but has no fetch role
    Object.assign(process.env, { TRADER_ENTRY_TAGS: '1', TRADER_ENTRY_TAGS_DIR: tags, ALPACA_API_KEY: 'kid', ALPACA_SECRET_KEY: 'sec' });
    const on = bridge();
    await brain.runAutoTrade({ signals: [signal] }, { bridge: on, userId: 'local-owner', now: NOW });
    const onBuys = on.placed.filter((o) => o.side === 'buy' && o.ticker === 'QQQ');
    assert.deepStrictEqual(onBuys, offBuys, 'the entry is the same order, tags on or off');
    for (let i = 0; i < 80 && !rows().some((r) => r.event === 'entry_tags'); i++) await new Promise((r) => setTimeout(r, 25));
    const t = rows().filter((r) => r.event === 'entry_tags');
    assert.strictEqual(t.length, 1);
    const e = t[0];
    assert.deepStrictEqual([e.user, e.symbol, e.account, e.source, e.qty, e.order_id], ['entry-tags', 'QQQ', 'local-owner', 'trader', onBuys[0].qty, '1']);
    assert.deepStrictEqual([e.gamma.as_of, e.gamma.tercile, e.gamma.rank], ['2026-09-21', 'LOW', 0]);
    assert.deepStrictEqual([e.news.overnight.tercile, e.news.session.tercile, e.news.history_to], ['HIGH', 'MID', '2026-09-21']);
    assert.deepStrictEqual([e.vix.prior, e.vix.prior_src, e.vix.now, e.vix.bucket], [16.9, 'daily', 16.2, 'QUIET']);
    const real = rows().find((r) => r.event === 'entry');
    assert.ok(real && real.user === 'local-owner' && real.gamma === undefined && real.vix === undefined, 'the entry row itself is untouched');
    assert.strictEqual(fetched.filter((u) => u === et.GEX_URL).length, 1, 'the CSV once (the pass s kick and the tag share it)');
    assert.strictEqual(fetched.filter((u) => u === et.VIX_URL).length, 1);
    assert.ok(fs.existsSync(path.join(tags, 'gex.json')));
    assert.deepStrictEqual(newsCalls, [], 'holding the keys is not the fetch role: no news call');
    // the fetch role (the engine): the same keys and TRADER_ENTRY_TAGS_NEWS_FETCH=1 refresh the counts; at 15:50 C s count is due
    process.env.TRADER_ENTRY_TAGS_NEWS_FETCH = '1';
    const LATE = et.etMs(BDAY, 15 * 60 + 50) + 25000;
    et._reset({ clock: () => LATE + 1000 });
    brain.tagEntry({ symbol: 'QQQ', account: 'local-owner', qty: 1, price: 500, now: LATE, source: 'trader' });
    for (let i = 0; i < 80 && rows().filter((r) => r.event === 'entry_tags').length < 2; i++) await new Promise((r) => setTimeout(r, 25));
    assert.strictEqual(newsCalls.length, 1, 'one refresh');
    assert.strictEqual(newsCalls[0].key, 'kid', 'with the server keys');
    assert.match(newsCalls[0].url, /end=2026-09-22T19:50:00Z/, 'C s count ends at 15:50');
    const late = rows().filter((r) => r.event === 'entry_tags')[1];
    assert.deepStrictEqual([late.news.session.n, late.news.session.to], [0, '2026-09-22T19:50:00.000Z'], 'the row reads the refreshed count');
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ['TRADER_ENTRY_TAGS', 'TRADER_ENTRY_TAGS_DIR', 'TRADER_ENTRY_TAGS_NEWS_FETCH', 'ALPACA_API_KEY', 'ALPACA_SECRET_KEY']) delete process.env[k];
  }
});
