'use strict';
/**
 * regime-shadow.js — can a model read the day's character? (#3389)
 *
 * The operator's standing question, sharpened by the −$7,185 week of
 * 2026-08-17: "for a thinking human it would be pretty easy to tell the
 * difference from a negative to a positive day … the algorithm is still
 * missing the thinking aspect." Every RULE version of that claim has now been
 * measured and rejected on the two-window bar (experiments/overnight_carry_lab
 * arms A/B/C). What has NOT been measured is a capable model given the same
 * view of the tape an experienced human uses.
 *
 * It cannot be measured historically: an LLM has MEMORIZED what markets did in
 * 2008 and 2022, so any backtest is look-ahead through pretraining. The only
 * clean test is FORWARD — journal the call before the outcome exists, score
 * later. This module is that journal.
 *
 * TWO READS a day, each a PREDICTION with a scoring window:
 *   open  (~09:35 ET): given the last 10 sessions + today's gap, call TODAY —
 *          scored against today's open→close.
 *   close (~16:05 ET): given today's completed bar, call TOMORROW — scored
 *          against tomorrow's close→close.
 *
 * TWO PROVIDERS per read, same prompt, journaled side by side (the operator's
 * "wouldn't the Σ₀ model be more decisive?" is an empirical question):
 *   claude — TRADER_REGIME_MODEL (default claude-opus-5-5 since v2; one fallback to
 *            claude-opus-5 when the API refuses the id, recorded as the row's model)
 *   local  — the Σ₀/Ouro serve at TRADER_REGIME_LOCAL_URL (ollama-shaped);
 *            absent/down is journaled as degraded, never blocks the other.
 *
 * WHAT IT CANNOT DO: it has no bridge, no broker, no order path, and nothing
 * reads its output — posture is a JOURNALED OPINION. If, after a few weeks,
 * experiments/regime_shadow_score.js shows real hit-rate/rho, wiring it to
 * anything goes through the usual lab bar. Until then it is evidence-gathering
 * at ~$0.15/day.
 *
 * DEFAULT OFF: TRADER_REGIME_SHADOW=1 enables. Dedupe is journal-based (one
 * row per date+read+provider), so restarts cannot double-fire.
 *
 * v2 (2026-10-01, the operator: "give a human trader or an AI all of the info that the
 * trader has and just ask it to find positions … they think and learn"). The OPEN read
 * (09:35) and a new MID read (10:35) now get what the trading system itself sees, not just
 * daily bars: the scan's universe (price, session IBS, the rule engine's read, RSI, news
 * label, sector trend), SPY / QQQ / SMH / IWM so far today against their noise bands
 * (lib/trend-shadow.js noiseBand), the last 18 hours of headlines from the news feed, and
 * the model's OWN recent calls at the same time of day with what then happened (learning
 * in context: no weights change). Besides the regime / posture / conviction of v1 it
 * names a day type and up to three POSITIONS to hold until 15:50 (long only; bearish =
 * an inverse ETF) and up to three to avoid. Rows carry prompt_v 2, the read-time prices
 * of the picks and of the whole universe, so experiments/regime_shadow_score.js scores the
 * picks against the universe's average over the same window. The CLOSE read is v1,
 * unchanged. Still journal-only: nothing reads a pick.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const noise = require('./trend-shadow');   // noiseBand / sessionBars: pure math over bars (fs + path only)

const CLAUDE_MODEL = () => process.env.TRADER_REGIME_MODEL || 'claude-opus-5-5';
const FALLBACK_MODEL = 'claude-opus-5';           // used once if the configured model is refused (400 / 404)
const PROMPT_V = 2;                               // the open and mid reads; the close read stays v1
const INTRADAY_READS = new Set(['open', 'mid']);
const LOCAL_URL = () => process.env.TRADER_REGIME_LOCAL_URL || 'http://127.0.0.1:11434';
const LOCAL_MODEL = () => process.env.TRADER_REGIME_LOCAL_MODEL || process.env.OURO_MODEL || 'ouro:latest';

function enabled() { return process.env.TRADER_REGIME_SHADOW === '1'; }
function timeoutMs() { return Number(process.env.TRADER_REGIME_TIMEOUT_MS) || 45000; }
const tradingDataFile = (name) => require('./app-paths').dataPath('lantern-garage', 'trading', name);
function logFile() {
  return process.env.TRADER_REGIME_LOG
    || tradingDataFile('regime-shadow.jsonl');
}
const etDay = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

function journal(row) {
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    fs.appendFileSync(logFile(), JSON.stringify(row) + '\n');
  } catch (_e) { /* journalling must never affect anything */ }
}

/** Has this (date, read, provider) already been journalled? Restart-proof dedupe. */
function alreadyLogged(date, read, provider) {
  try {
    const txt = fs.readFileSync(logFile(), 'utf8');
    const needle = `"date":"${date}"`;
    if (!txt.includes(needle)) return false;
    return txt.split('\n').some((l) => {
      if (!l.includes(needle)) return false;
      try { const r = JSON.parse(l); return r.read === read && r.provider === provider; }
      catch (_e) { return false; }
    });
  } catch (_e) { return false; }              // no journal yet
}

// ── the tape, as a chart-reading human sees it ──────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const rq = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    rq.on('error', reject);
    rq.setTimeout(15000, () => { rq.destroy(); reject(new Error('timeout')); });
  });
}

async function daily(sym, days, getJson = fetchJson) {
  const p2 = Math.floor(Date.now() / 1000);
  const p1 = p2 - (days + 15) * 86400;
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&period1=${p1}&period2=${p2}`);
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) return [];
  const ts = r.timestamp || [];
  const q = r.indicators.quote[0];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.open[i] == null) continue;
    out.push({ d: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  }
  return out.slice(-days);
}

const dayIbs = (b) => (b.h - b.l > 0 ? (b.c - b.l) / (b.h - b.l) : 0.5);
const etMin = (t) => { const p = new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }).split(':'); return (Number(p[0]) % 24) * 60 + Number(p[1]); };

/**
 * Today's opening print: the open of the 09:30 bar of the INTRADAY chart, or null.
 * Never the daily series: fetched at 09:35, Yahoo's daily bar for today still carries the
 * PREVIOUS session's open, so every open read of 2026-08-21..09-30 was told "SPY opened
 * X% vs yesterday's close" with X = open(D-1) / close(D-1) - 1 — minus yesterday's
 * intraday move, not today's gap (found scoring the journal, 2026-10-01).
 */
async function todayOpen(sym, now, getJson = fetchJson) {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d`);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) return null;
  const ts = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const day = etDay(now);
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i] * 1000;
    if (etDay(t) !== day) continue;
    const m = etMin(t);
    if (m < 570) continue;                       // regular session only
    return m === 570 && q.open && q.open[i] > 0 ? q.open[i] : null;   // the first regular bar must BE the 09:30 bar
  }
  return null;
}

/** A Yahoo chart response as bar rows { timestamp, open, high, low, close } (what lib/trend-shadow reads). */
function chartBars(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) return [];
  const ts = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (!(q.close && q.close[i] > 0)) continue;
    out.push({ timestamp: new Date(ts[i] * 1000).toISOString(), open: q.open && q.open[i], high: q.high && q.high[i], low: q.low && q.low[i], close: q.close[i] });
  }
  return out;
}
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** The four indices so far today: move from the open, session IBS, where they sit against their noise band. */
async function tapeOf(now, getJson = fetchJson) {
  const day = etDay(now);
  const out = [];
  for (const sym of ['SPY', 'QQQ', 'SMH', 'IWM']) {
    let raw = [];
    try { raw = chartBars(await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=5m&range=1mo`)); } catch (_e) { raw = []; }
    const bars = noise.sessionBars(raw, day).filter((b) => b.t + 300000 <= now);   // completed bars only
    if (!bars.length || bars[0].min !== 570) { out.push({ sym, unavailable: true }); continue; }
    const first = raw.find((b) => Date.parse(b.timestamp) === bars[0].t);
    const open = first && first.open > 0 ? first.open : (bars[0].h + bars[0].l) / 2;
    const last = bars[bars.length - 1];
    const hi = Math.max(...bars.map((b) => b.h)), lo = Math.min(...bars.map((b) => b.l));
    const band = noise.noiseBand(raw, day);
    const lim = band.at ? band.at(last.min) : null;
    out.push({ sym, px: last.c, fromOpenPct: +((last.c / open - 1) * 100).toFixed(2), ibs: hi > lo ? +((last.c - lo) / (hi - lo)).toFixed(2) : null,
      rangePct: +((hi / lo - 1) * 100).toFixed(2), band: lim ? (last.c > lim.upper ? 'above' : last.c < lim.lower ? 'below' : 'inside') : null,
      sigmaPct: lim ? +(lim.sigma * 100).toFixed(2) : null, asOf: hhmm(last.min + 5) });
  }
  return out;
}

/** The trading system's own view of its universe, from the scan the caller just ran (no extra fetch). */
function universeOf(scan) {
  const seen = new Map();
  for (const s of (scan && Array.isArray(scan.signals) ? scan.signals : [])) {
    const sym = String((s && (s.symbol || s.ticker)) || '').toUpperCase();
    if (!/^[A-Z.]{1,6}$/.test(sym) || seen.has(sym)) continue;
    const px = Number(s.entry_price != null ? s.entry_price : s.price);
    const dc = s.decision_context || {};
    seen.set(sym, { sym, px: px > 0 ? px : null, ibs: Number.isFinite(dc.ibs) ? dc.ibs : null, read: s.direction || null,
      rsi: Number.isFinite(s.rsi) ? s.rsi : null, news: s.news && s.news.label ? s.news.label : null,
      sector: s.sector && Number.isFinite(s.sector.trend_pct) ? s.sector.trend_pct : null });
  }
  return [...seen.values()].slice(0, 40);
}

// Headline ranking, not filtering: market-wide rows first (the feed tags them inconsistently, so an index tag OR no tag),
// the content-farm list articles last; the model sees the rest too, in time order, and judges relevance itself.
const BROAD_TAGS = new Set(['SPY', 'QQQ', 'DIA', 'DJI', 'IWM', 'VOO', 'IVV', 'VTI', 'CME', '^GSPC', '^DJI', '^IXIC', 'ES=F', 'NQ=F']);
const LIST_SOURCES = /^(StockStory|Motley Fool|Simply Wall St\.|Insider Monkey|Trefis)$/i;

/** The market headlines of the last `hours` from the news feed the server keeps (data/.../news.jsonl), in time order. */
function headlinesOf(now, { limit = 20, hours = 18 } = {}) {
  const file = process.env.TRADER_REGIME_NEWS || tradingDataFile('news.jsonl');
  let text = '';
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const len = Math.min(st.size, 600000);                   // the tail is enough: newest rows are appended last
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch (_e) { return []; }
  const from = now - hours * 3600000;
  const seen = new Set();
  const out = [];
  for (const line of text.split('\n').reverse()) {
    let r; try { r = JSON.parse(line); } catch (_e) { continue; }
    const t = Date.parse(r.published || r.ts || '');
    if (!(t >= from && t <= now) || !r.headline) continue;
    const key = String(r.headline).toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    const symbols = Array.isArray(r.symbols) ? r.symbols.map((x) => String(x).toUpperCase()) : [];
    const rank = (symbols.length === 0 || symbols.some((x) => BROAD_TAGS.has(x)) ? 2 : 0) - (LIST_SOURCES.test(String(r.source || '')) ? 2 : 0);
    out.push({ t, rank, source: r.source || '', headline: String(r.headline).slice(0, 160), symbols: symbols.slice(0, 4) });
  }
  return out.sort((a, b) => b.rank - a.rank || b.t - a.t).slice(0, limit).sort((a, b) => a.t - b.t);
}

/** The model's own last calls at this time of day and what then happened (learning in context). */
async function trackOf(read, now, getJson = fetchJson, n = 10) {
  let rows = [];
  try {
    rows = fs.readFileSync(logFile(), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
      .filter((r) => r && r.read === read && r.provider === 'claude' && r.prompt_v === PROMPT_V && !r.degraded && r.date < etDay(now));
  } catch (_e) { return []; }
  rows = rows.slice(-n);
  const memo = new Map();
  const closeOn = async (sym, d) => {
    if (!memo.has(sym)) memo.set(sym, daily(sym, 25, getJson).catch(() => []));
    const b = (await memo.get(sym)).find((x) => x.d === d);
    return b ? b.c : null;
  };
  const out = [];
  for (const r of rows) {
    const spyClose = await closeOn('SPY', r.date);
    const spyFrom = r.spy_at_read > 0 ? r.spy_at_read : null;
    const picks = [];
    for (const p of r.picks || []) { const c = await closeOn(p.symbol, r.date); picks.push({ symbol: p.symbol, retPct: c && p.px > 0 ? +((c / p.px - 1) * 100).toFixed(2) : null }); }
    out.push({ date: r.date, regime: r.regime, posture: r.posture, conviction: r.conviction, day_type: r.day_type || null,
      spyRetPct: spyClose && spyFrom ? +((spyClose / spyFrom - 1) * 100).toFixed(2) : null, picks });
  }
  return out;
}

/** Everything the prompt gets. Exposed for tests and for the scorer. */
async function buildContext(read, { getJson = fetchJson, now = Date.now(), scan = null } = {}) {
  const [spy, qqq, iwm, vix, open] = await Promise.all([
    daily('SPY', 11, getJson), daily('QQQ', 11, getJson), daily('IWM', 11, getJson), daily('^VIX', 2, getJson),
    todayOpen('SPY', now, getJson).catch(() => null),
  ]);
  if (spy.length < 5) throw new Error('insufficient SPY history');
  // For the OPEN read, today's partial bar (if Yahoo already lists it) must be
  // dropped from the history and used only as the gap reference — the model
  // may not see today's high/low/close before predicting them.
  const today = etDay(now);
  const hist = spy.filter((b) => b.d < today);
  const dailyToday = spy.find((b) => b.d === today) || null;
  // the close read shows today's completed bar: its open from the intraday 09:30 bar too (same staleness)
  const todayBar = dailyToday && open > 0 ? { ...dailyToday, o: open } : dailyToday;
  const ctx = {
    read, date: today, v: INTRADAY_READS.has(read) ? PROMPT_V : 1,
    spy: hist.slice(-10).map((b) => ({ ...b, ibs: +dayIbs(b).toFixed(2) })),
    qqq5: qqq.filter((b) => b.d < today).slice(-5).map((b) => ({ d: b.d, chg: null, c: b.c })),
    iwm5: iwm.filter((b) => b.d < today).slice(-5).map((b) => ({ d: b.d, c: b.c })),
    vix: vix.length ? vix[vix.length - 1].c : null,
    gapPct: INTRADAY_READS.has(read) && open > 0 && hist.length
      ? +(((open / hist[hist.length - 1].c) - 1) * 100).toFixed(2) : null,
    gapSource: INTRADAY_READS.has(read) ? (open > 0 ? 'intraday-0930' : 'unavailable') : null,
    openSource: open > 0 ? 'intraday-0930' : (read === 'close' && dailyToday ? 'daily' : null),
    todayBar: read === 'close' ? (todayBar ? { ...todayBar, ibs: +dayIbs(todayBar).toFixed(2) } : null) : null,
  };
  if (INTRADAY_READS.has(read)) {
    // v2: what the trading system itself sees (none of it reaches past `now`)
    ctx.asOf = hhmm(etMin(now));
    ctx.tape = await tapeOf(now, getJson).catch(() => []);
    ctx.universe = universeOf(scan);
    ctx.headlines = headlinesOf(now);
    ctx.track = await trackOf(read, now, getJson).catch(() => []);
  }
  return ctx;
}

const timeEt = (t) => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
const signed = (x) => (x >= 0 ? '+' : '') + x;

/** The v2 prompt (open and mid reads): the account's whole view, then three decisions. Names no failure mode (#3370). */
function buildPromptV2(ctx) {
  const rows = ctx.spy.map((b) =>
    `  ${b.d}  O ${b.o.toFixed(2)}  H ${b.h.toFixed(2)}  L ${b.l.toFixed(2)}  C ${b.c.toFixed(2)}  dayIBS ${b.ibs}`).join('\n');
  const chg = (a) => (a.length >= 2 ? (((a[a.length - 1].c / a[0].c) - 1) * 100).toFixed(2) + '%' : 'n/a');
  const tape = (ctx.tape || []).map((t) => (t.unavailable ? `  ${t.sym}: no intraday bars yet`
    : `  ${t.sym}  ${signed(t.fromOpenPct)}% from the open (as of ${t.asOf}), session IBS ${t.ibs}, range ${t.rangePct}%, `
      + (t.band ? `${t.band} its noise band (the normal move from the open at this time of day is about ${t.sigmaPct}%)` : 'noise band n/a'))).join('\n');
  const uni = (ctx.universe || []).map((u) => `  ${u.sym.padEnd(5)} ${u.px != null ? u.px.toFixed(2).padStart(9) : '      n/a'}  IBS ${u.ibs != null ? u.ibs.toFixed(2) : 'n/a '}  rule read ${u.read || 'n/a'}`
    + (u.rsi != null ? `  RSI ${u.rsi}` : '') + (u.news ? `  news ${u.news}` : '') + (u.sector != null ? `  sector ${signed(u.sector)}%` : '')).join('\n');
  const news = (ctx.headlines || []).map((h) => `  [${timeEt(h.t)}] ${h.source ? h.source + ': ' : ''}${h.headline}`).join('\n');
  const track = (ctx.track || []).map((r) => `  ${r.date}: called ${r.regime} / ${r.posture} (conviction ${r.conviction})${r.day_type ? ', day type ' + r.day_type : ''}; `
    + `picks ${r.picks.length ? r.picks.map((p) => `${p.symbol} ${p.retPct == null ? 'n/a' : signed(p.retPct) + '%'}`).join(', ') : 'none'}; `
    + `SPY ${r.spyRetPct == null ? 'n/a' : signed(r.spyRetPct) + '%'} from that call to the close`).join('\n');
  return [
    'You are the discretionary trader for an intraday account. It trades only the ETFs listed below, long only',
    '(to be short an index it buys the inverse ETF), opens nothing after 15:30 and is flat by 15:50.',
    `It is ${ctx.asOf} ET on ${ctx.date}. This is everything the account's systems see right now.`,
    '',
    'SPY, last 10 sessions (dayIBS: 1 = closed at the high, 0 = closed at the low):',
    rows,
    `QQQ 5-day change: ${chg(ctx.qqq5)}   IWM 5-day change: ${chg(ctx.iwm5)}   VIX: ${ctx.vix == null ? 'n/a' : ctx.vix.toFixed(1)}`,
    '',
    `Today so far. SPY opened ${ctx.gapPct == null ? 'flat (gap unavailable)' : signed(ctx.gapPct) + '% vs yesterday’s close'}.`,
    tape || '  (no intraday bars)',
    '',
    'The universe now (price, session IBS 0-1, the rule engine’s read, RSI, news label, sector trend):',
    uni || '  (no scan available)',
    '',
    'Headlines, last 18 hours:',
    news || '  (none)',
    '',
    'Your own recent calls at this time of day, and what happened after them:',
    track || '  (none yet: this is your first)',
    '',
    'Decide: (1) how SPY most likely resolves from now to the close; (2) up to 3 names from the universe to hold',
    'from now until 15:50, or none if nothing is worth holding; (3) up to 3 names to avoid today.',
    '',
    'Reply with strict JSON, no prose:',
    '{"regime":"trend_up"|"trend_down"|"chop","posture":"long"|"flat"|"inverse","conviction":<integer 0-100>,',
    ' "day_type":"RALLY"|"DROP"|"V_UP"|"FADE"|"MIXED"|"NARROW","picks":["SYM"],"avoid":["SYM"],"reason":"<max 30 words>"}',
    'day_type is SPY’s whole session: RALLY closes near the high after an early low; DROP closes near the low after an',
    'early high; V_UP recovers in the afternoon from a late low; FADE turns down in the afternoon from a late high;',
    'NARROW is a quiet day; MIXED is anything else. posture is what a disciplined trader holding US index ETFs should be',
    'from now to the close. conviction 50 = no view.',
  ].join('\n');
}

function buildPrompt(ctx) {
  if (ctx.v === PROMPT_V) return buildPromptV2(ctx);
  const rows = ctx.spy.map((b) =>
    `  ${b.d}  O ${b.o.toFixed(2)}  H ${b.h.toFixed(2)}  L ${b.l.toFixed(2)}  C ${b.c.toFixed(2)}  dayIBS ${b.ibs}`).join('\n');
  const chg = (a) => (a.length >= 2 ? (((a[a.length - 1].c / a[0].c) - 1) * 100).toFixed(2) + '%' : 'n/a');
  return [
    'You are an experienced US index trader reading the tape. Judge the market character',
    'the way a discretionary trader would — trend, failed moves, where days CLOSE',
    'relative to their range — not from any single indicator.',
    '',
    'SPY, last 10 sessions (dayIBS: 1 = closed at the high, 0 = closed at the low):',
    rows,
    `QQQ 5-day change: ${chg(ctx.qqq5)}   IWM 5-day change: ${chg(ctx.iwm5)}   VIX: ${ctx.vix == null ? 'n/a' : ctx.vix.toFixed(1)}`,
    ctx.read === 'open'
      ? `\nIt is 09:35 ET on ${ctx.date}. SPY opened ${ctx.gapPct == null ? 'flat (gap unavailable)' : (ctx.gapPct >= 0 ? '+' : '') + ctx.gapPct + '% vs yesterday’s close'}.\nCall TODAY: how does this session most likely resolve open→close?`
      : `\nIt is just after the 16:00 ET close on ${ctx.date}. Today’s completed bar: ${ctx.todayBar ? `O ${ctx.todayBar.o.toFixed(2)} H ${ctx.todayBar.h.toFixed(2)} L ${ctx.todayBar.l.toFixed(2)} C ${ctx.todayBar.c.toFixed(2)} (dayIBS ${ctx.todayBar.ibs})` : 'unavailable'}.\nCall TOMORROW: how does the next session most likely resolve close→close?`,
    '',
    'Reply with strict JSON, no prose:',
    '{"regime":"trend_up"|"trend_down"|"chop","posture":"long"|"flat"|"inverse",',
    ' "conviction":<integer 0-100>,"reason":"<max 20 words>"}',
    'posture is what a disciplined trader holding US index ETFs should be for the',
    'window you were asked about. conviction 50 = no view.',
  ].join('\n');
}

const DAY_TYPES = ['RALLY', 'DROP', 'V_UP', 'FADE', 'MIXED', 'NARROW'];

function parseReply(text, { universe = null } = {}) {
  // #3407: a degraded parse keeps a snippet of what the model actually said —
  // the first live close-read failed 'unparseable' and left nothing to debug.
  const raw = String(text || '').slice(0, 180);
  try {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return { degraded: true, reason: 'unparseable', raw };
    const j = JSON.parse(m[0]);
    const regime = ['trend_up', 'trend_down', 'chop'].includes(j.regime) ? j.regime : null;
    const posture = ['long', 'flat', 'inverse'].includes(j.posture) ? j.posture : null;
    const conviction = Number.isFinite(Number(j.conviction))
      ? Math.max(0, Math.min(100, Math.round(Number(j.conviction)))) : null;
    if (!regime || !posture || conviction == null) return { degraded: true, reason: 'missing fields', raw };
    const out = { regime, posture, conviction, why: String(j.reason || '').slice(0, 200), degraded: false };
    if ('day_type' in j || 'picks' in j || 'avoid' in j) {
      // v2: a pick must be a name the account trades (in the universe shown); anything else is dropped and counted
      const allow = universe && universe.length ? new Set(universe.map((u) => u.sym)) : null;
      const clean = (a) => [...new Set((Array.isArray(a) ? a : []).map((x) => String(x || '').toUpperCase().trim())
        .filter((x) => /^[A-Z.]{1,6}$/.test(x) && (!allow || allow.has(x))))].slice(0, 3);
      out.day_type = DAY_TYPES.includes(j.day_type) ? j.day_type : null;
      out.picks = clean(j.picks);
      out.avoid = clean(j.avoid);
      const offered = Array.isArray(j.picks) ? j.picks.length : 0;
      if (offered > out.picks.length) out.picks_dropped = offered - out.picks.length;
    }
    return out;
  } catch (_e) { return { degraded: true, reason: 'parse error', raw }; }
}

// ── providers ────────────────────────────────────────────────────────────────
async function askClaude(prompt, fetchImpl, { universe = null } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { degraded: true, reason: 'no api key' };
  const doFetch = fetchImpl || globalThis.fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs());
  try {
    const post = (model) => doFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 700,   // #3407: 300 clipped a reply on day one; v2 adds picks
        messages: [{ role: 'user', content: prompt }] }),
    });
    let model = CLAUDE_MODEL();
    let res = await post(model);
    // a model id the API refuses (renamed, not enabled for the key) falls back once, and the row says so
    if (res && (res.status === 400 || res.status === 404) && model !== FALLBACK_MODEL) { model = FALLBACK_MODEL; res = await post(model); }
    if (!res || !res.ok) return { degraded: true, reason: 'http ' + (res && res.status), model_used: model };
    const j = await res.json();
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { ...parseReply(text, { universe }), model_used: model };
  } catch (e) {
    return { degraded: true, reason: ac.signal.aborted ? 'timeout' : String(e && e.message).slice(0, 60) };
  } finally { clearTimeout(timer); }
}

async function askLocal(prompt, fetchImpl, { universe = null } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs());
  try {
    const res = await doFetch(LOCAL_URL().replace(/\/$/, '') + '/api/chat', {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: LOCAL_MODEL(), stream: false,
        messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res || !res.ok) return { degraded: true, reason: 'http ' + (res && res.status) };
    const j = await res.json();
    const text = (j.message && j.message.content) || j.response || '';
    return parseReply(text, { universe });
  } catch (e) {
    return { degraded: true, reason: ac.signal.aborted ? 'timeout' : String(e && e.message).slice(0, 60) };
  } finally { clearTimeout(timer); }
}

/**
 * Fire one read ('open' | 'mid' | 'close') for both providers, once per day each.
 * `scan` = the scan the caller just ran (the universe the v2 reads show and pick from).
 * Fire-and-forget from the caller; never throws; journal-only.
 */
async function run(read, { fetchImpl, now = Date.now(), ctx: injectedCtx, scan = null, getJson } = {}) {
  if (!enabled()) return { skipped: 'disabled' };
  const date = etDay(now);
  const providers = [['claude', askClaude], ['local', askLocal]]
    .filter(([name]) => !alreadyLogged(date, read, name));
  if (!providers.length) return { skipped: 'already logged' };

  let ctx, prompt;
  // injectedCtx: tests must not depend on a live quote feed
  try { ctx = injectedCtx || await buildContext(read, { now, scan, ...(getJson ? { getJson } : {}) }); prompt = buildPrompt(ctx); }
  catch (e) {
    for (const [name] of providers) {
      journal({ ts: new Date(now).toISOString(), date, read, provider: name,
        degraded: true, reason: 'context: ' + String(e.message).slice(0, 60) });
    }
    return { skipped: 'context failed' };
  }

  const universe = ctx.universe || [];
  const pxOf = (sym) => { const u = universe.find((x) => x.sym === sym); return u && u.px > 0 ? u.px : null; };
  const spyTape = (ctx.tape || []).find((t) => t.sym === 'SPY' && !t.unavailable);
  const out = [];
  for (const [name, ask] of providers) {
    const t0 = Date.now();
    const { model_used: modelUsed, picks, ...r } = await ask(prompt, fetchImpl, { universe });
    const row = { ts: new Date(now).toISOString(), date, read, provider: name,
      model: modelUsed || (name === 'claude' ? CLAUDE_MODEL() : LOCAL_MODEL()),
      prompt_v: ctx.v || 1,
      latency_ms: Date.now() - t0,
      // the exact tape shown, so the scorer can verify no look-ahead
      gap_pct: ctx.gapPct, gap_source: ctx.gapSource || null, open_source: ctx.openSource || null, vix: ctx.vix, last_close: ctx.spy[ctx.spy.length - 1].c,
      ...r };
    if (ctx.v === PROMPT_V) {
      // what the scorer needs to grade the picks against the universe over the same window
      row.read_min = etMin(now);
      row.spy_at_read = spyTape ? spyTape.px : pxOf('SPY');
      row.picks = (picks || []).map((s) => ({ symbol: s, px: pxOf(s) }));
      row.universe_px = Object.fromEntries(universe.filter((u) => u.px > 0).map((u) => [u.sym, u.px]));
      // the rule engine's own candidates at the same moment: the like-for-like comparison for the picks
      row.rule_bullish = universe.filter((u) => u.read === 'BULLISH' && u.px > 0).map((u) => u.sym);
      row.inputs = { tape: (ctx.tape || []).length, universe: universe.length, headlines: (ctx.headlines || []).length, track: (ctx.track || []).length };
    }
    journal(row);
    out.push(row);
  }
  return { logged: out.length };
}

module.exports = { run, enabled, buildContext, buildPrompt, parseReply, alreadyLogged, logFile, todayOpen,
  tapeOf, universeOf, headlinesOf, trackOf, PROMPT_V };
