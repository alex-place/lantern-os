'use strict';
/**
 * entry-tags.js — THE MARKET-CONTEXT TAGS ON EVERY ENTRY (2026-11-02). Journal only: it places no order, refuses no
 * entry and changes no other rule.
 *
 * Three readings the 11-01 research found the design is paid by, none of them a rule (ledger rows):
 *   gamma  options-dealer gamma, SqueezeMetrics' free daily GEX. The leg and C earned 2-10x more a trade when the prior
 *          session's GEX sat in the LOW tercile of its year than in the HIGH (tier0-dealer-gamma-regime-2016-2026; C out
 *          of sample 2012-15, same direction, t 1.24: tier0-dealer-gamma-c-proxy-oos-2012-2015). Every gate failed.
 *   news   Benzinga headline intensity on SPY / QQQ / SMH / DIA / IWM. C's washouts paid most on news-heavy days
 *          (tier0-news-intensity-sleeves-2016-2026); C's "quiet washout" (news not HIGH, gamma not LOW) netted about
 *          nothing (tier0-c-quiet-washout-gate-2016-2026, found in-sample: it needs this forward record).
 *   vix    the VIX change at the entry. C's washouts on days the VIX did not rise netted less than its fear washouts,
 *          in three separate decades but weakly (gate GV: tier0-c-vix-change-quiet-washout-2005-2026,
 *          tier0-c-vix-change-oos2-1993-2004).
 * One entry_tags row per live entry carries all three, measured exactly as the research measured them, so the live
 * record can score them (ledger live-both-gamma-news-vix-tags-2026-11).
 *
 *   gamma  the CSV's (date,price,dix,gex) last row before the entry day, which must be the prior session (the CSV is
 *          updated about 18:00 ET; an older row means not updated yet: null with the reason), ranked against the 252
 *          rows before it (the share strictly lower) -> tercile LOW < 1/3 <= MID <= 2/3 < HIGH, and its sign. The CSV
 *          is fetched once a day: again only while it lacks the prior session, no sooner than an hour apart.
 *   news   OVERNIGHT = headlines per hour from 16:00 ET of the prior session to 09:30 ET; SESSION = headlines per hour
 *          from 09:30 ET to the entry (the history's sessions run 09:30-15:50, C's decision time); each ranked against
 *          the 120 sessions before the entry day (the share strictly lower) -> terciles. A session window under 30
 *          minutes gets no rank. The Alpaca News API needs keys: only the process given the fetch role
 *          (TRADER_ENTRY_TAGS_NEWS_FETCH=1 with the Alpaca server keys: the engine; holding keys alone is not enough)
 *          refreshes the counts — the first pass at or after 09:30 (up to 10 missed past sessions are backfilled
 *          in the same call), hourly (the overnight window is counted again until a refresh 15 minutes past the open has
 *          counted it: a headline can reach the API a little after its created_at), the first pass at or after 15:50
 *          (C's count) and the first at or after 16:05 (the settled 09:30-15:50 count, which joins the history): about
 *          ten calls a session. Every other process (stable) reads the same file and never calls.
 *          The history is seeded from the research's own archive by scripts/entry-tags-news-seed.js, counted by this
 *          module's sessionRow(), the function the live counts use.
 *          THE TYPE OF THE NEWS (2026-11-03, ledger tier0-news-type-sleeves-2016-2026): each headline also goes through
 *          the research's keyword categories (NEWS_RX below, copied verbatim: DATA, FED, TRADE, GEO, POLICY, HEALTH, CORP,
 *          and WRAP = market-reaction content, not news). NEWS = not WRAP, SHOCK = NEWS and TRADE|GEO|POLICY, RATES = NEWS
 *          and DATA|FED; a WRAP headline counts only as WRAP. C's washouts paid on HIGH-SHOCK sessions (+$104 | +$69 a
 *          trade vs about $0 on LOW) and not on HIGH-RATES ones, inside every VIX-change bucket and gamma tercile, in 9 of
 *          11 years; found in-sample, no rule (gate GS passed tier 0: tier0-c-shock-tilt-gate-2016-2026). Each window of the
 *          row carries `types` { NEWS, SHOCK, RATES }: { n, rate, rank, tercile } ranked as above, and `counts` for the rest;
 *          `mix` says which of SHOCK and RATES had more session headlines. A recent history row without type counts (written
 *          before this shipped) is counted again by the next refresh, in the same call.
 *   vix    prior = the prior session's close (the brain's own _vixPriorClose, Yahoo ^VIX daily; when that read fails, the
 *          1m chart's own previous close, labelled prior_src 'chart_meta'); now = the Yahoo ^VIX 1m chart's
 *          meta.regularMarketPrice; as_of = its meta.regularMarketTime (the quote's own time, not the fetch time);
 *          lag_sec = fetch time - as_of (Yahoo's chart meta has no delay field: the lag is measured). chg = now / prior
 *          - 1: QUIET <= 0 < MILD < +8 % <= FEAR. The cut points are gate GV's, fixed in advance: do not tune them. One
 *          quote per scan with entries (the entries of one pass share it), 5 s timeout.
 *
 * The contract: the caller never awaits a tag and a tag never touches an order — its row is written after the order,
 * once its reads are done (a few seconds). A failed source is null with its reason (gamma_why / news_why / vix_why).
 * Rows carry the user 'entry-tags', never entry/exit, so no P&L reader counts them. Only LIVE passes tag: a pass whose
 * clock is more than 10 minutes from the real one (a replay, a dry run's pinned clock) fetches nothing and writes
 * nothing, so a replay can never write the shared files. Every cache here holds one slot; nothing can grow.
 *
 * Enable: TRADER_ENTRY_TAGS=1 (unset or 0 = off). TRADER_ENTRY_TAGS_DIR = the directory of gex.json and news.json,
 * shared by every process that tags (both boxes point at one directory); default <journal dir>/entry-tags.
 * TRADER_ENTRY_TAGS_NEWS_FETCH=1 = this process refreshes news.json (the brain then passes the server keys as `headers`);
 * set it on ONE process (the engine), whose key it spends.
 */
const fs = require('fs');
const path = require('path');
const cal = require('./market-calendar');

const GEX_URL = 'https://squeezemetrics.com/monitor/static/DIX.csv';
const NEWS_URL = 'https://data.alpaca.markets/v1beta1/news';
const NEWS_SYMBOLS = 'SPY,QQQ,SMH,DIA,IWM';
const VIX_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1m&range=1d';
const UA = 'Mozilla/5.0';
const GEX_N = 252;                   // the GEX rank's window, sessions
const NEWS_N = 120;                  // the news ranks' window, sessions
const VIX_FEAR = 0.08;               // QUIET <= 0 < MILD < 0.08 <= FEAR (gate GV's cut points)
const OPEN_MIN = 570;                // 09:30 ET
const PRIOR_CLOSE_MIN = 960;         // 16:00 ET of the prior session: the overnight window opens
const DECIDE_MIN = 950;              // 15:50 ET: the history's session window ends (C's decision)
const SESSION_MIN_HOURS = 0.5;       // a shorter session window gets no rank
const SESSION_HOURS = (DECIDE_MIN - OPEN_MIN) / 60;   // the history's session window, 09:30-15:50
const LIVE_MS = 10 * 60000;          // a pass further than this from the real clock is not live
const GEX_RETRY_MS = 60 * 60000;     // the CSV is asked again no sooner than an hour after a try
const GEX_KEEP = 400;                // CSV rows kept (the rank needs 253)
const NEWS_EVERY_MS = 60 * 60000;    // the session count's refresh, during the session
const NEWS_GRACE_MS = 15 * 60000;    // a window is counted for good this long after it closes (late-arriving headlines)
const NEWS_RETRY_MS = 10 * 60000;    // after a failed refresh
const NEWS_BACKFILL = 10;            // missed past sessions one refresh fills
const NEWS_KEEP = 200;               // sessions the history keeps
const WAIT_MS = 10000;               // how long a tag waits for a refresh in flight
const FETCH_MS = 15000;              // the CSV and news timeouts
const VIX_MS = 5000;
const PAGE_MAX = 40;                 // news pages one refresh may read (50 headlines each)

const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const iso = (ms) => new Date(ms).toISOString();
const isoS = (ms) => iso(ms).replace(/\.\d{3}Z$/, 'Z');
const msg = (e) => String((e && e.message) || e).slice(0, 160);
const tercile = (p) => (p < 1 / 3 ? 'LOW' : p > 2 / 3 ? 'HIGH' : 'MID');
let _clock = () => Date.now();

/** The UTC instant of ET minute `min` on `day` (DST-safe: whichever of UTC-4 / UTC-5 reads back as that wall time). */
function etMs(day, min) {
  for (const off of [4, 5]) {
    const t = Date.parse(`${day}T00:00:00Z`) + (min + off * 60) * 60000;
    const e = cal.etOf(t);
    if (e.day === day && e.min === min) return t;
  }
  return null;
}
/** A session day's news windows: overnight [prior session 16:00, 09:30), session [09:30, 15:50). */
function windows(day) {
  const prev = cal.prevTradingDay(day);
  return { day, prev, from: etMs(prev, PRIOR_CLOSE_MIN), open: etMs(day, OPEN_MIN), dec: etMs(day, DECIDE_MIN) };
}
function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
const countIn = (sorted, a, b) => lowerBound(sorted, b) - lowerBound(sorted, a);
/**
 * The keyword categories of the Benzinga index-tagged headlines (multi-label, on the lower-cased text), verbatim from the
 * research (fixed 2026-11-02 from the headline text alone, before any trade split).
 */
const NEWS_RX = {
  DATA: /\b(cpi|ppi|pce|non-?farm|payrolls?|jobless claims|initial claims|continuing claims|unemployment rate|jolts|adp|gdp|ism|pmi|retail sales|durable goods|industrial production|housing starts|building permits|new home sales|existing home sales|pending home sales|consumer (confidence|sentiment)|michigan|empire state|philly fed|philadelphia fed|chicago pmi|trade balance|factory orders|wholesale (trade|inventories|sales)|business inventories|average hourly earnings|unit labor|import prices|export prices|personal (income|spending)|crude (oil )?(stock|inventor\w*)|api crude|eia|mom\b|yoy\b)|\bvs\.? [^,;]*\b(est|estimate|expected|consensus)\b/,
  FED: /\b(fed|fed's|feds|fomc|powell|bernanke|warsh|federal reserve|rate (hike|hikes|cut|cuts|increase|decrease)s?|basis points?|bps|dot plot|beige book|quantitative|taper\w*|williams|bullard|kashkari|waller|brainard|clarida|mester|daly|bostic|logan|musalem|barkin|goolsbee|harker|kaplan|evans|rosengren|esther george|jefferson|lisa cook|barr|bowman|hammack|schmid|kugler|miran|lagarde|draghi|ecb|boj|kuroda|ueda|boe|central bank\w*)\b/,
  TRADE: /\b(tariffs?|trade (war|deal|talks|agreement|negotiat\w*|truce|tensions?|dispute|team|representative)|section (232|301)|lighthizer|navarro|greer|export controls?|import duties|retaliat\w*|usmca|nafta)\b/,
  GEO: /\b(russia\w*|ukrain\w*|putin|zelensk\w*|kremlin|iran\w*|israel\w*|gaza|hamas|hezbollah|houthi\w*|north korea\w*|kim jong\w*|missiles?|military|troops|invasion|airstrikes?|nato|taiwan|south china sea|syria\w*|venezuela\w*|hormuz|terror\w*|nuclear|ceasefire)\b|(?<!trade |price |currency )\bwar\b/,
  POLICY: /\b(trump\w*|biden\w*|obama|harris|white house|congress\w*|senate|senator\w*|speaker|pelosi|mcconnell|schumer|mccarthy|shutdown|debt (ceiling|limit)|stimulus|infrastructure|tax (cut|cuts|bill|reform|plan)|election\w*|impeach\w*|supreme court|treasury secretary|mnuchin|bessent|yellen|executive order|doge|reconciliation)\b/,
  HEALTH: /\b(coronavirus|covid\w*|pandemic|vaccine\w*|virus|lockdowns?|omicron|infections?|outbreak)\b/,
  CORP: /\b(earnings|eps|revenue|guidance|quarterly|beats? (estimates|expectations)|misses (estimates|expectations)|buybacks?|ipo|merger|acquisition)\b/,
  WRAP: /\b(stock market today|stocks? (rise|rises|fall|falls|rally|rallies|slide|slides|tumble|tumbles|surge|surges|climb|climbs|drop|drops|jump|jumps|sink|sinks|edge|edges|open|opens|close|closes|end|ends|finish|finishes|trade|trading|higher|lower|mixed)|futures (trading|rise|fall|higher|lower|point|are|edge|slip|gain|drop)|imbalance|technical alert|how to trade|check out|what'?s going on|why (is|are|the)|midday|mid-day|movers|market (update|wrap|recap|summary|clubhouse)|pre-?market|after-?hours|index futures|(dow|nasdaq|s&p( 500)?|russell 2000) (up|down|rises|falls|gains|loses|jumps|drops|tops|closes|ends|opens|surges|tumbles|slides|futures)|options activity|unusual options|whale|etf)\b/,
};
const CATS = Object.keys(NEWS_RX);
const HEADLINE_MAX = 600;            // the regexes read at most this much (the 84k archived headlines end by 512)
const TYPES = ['NEWS', 'WRAP', 'SHOCK', 'RATES', 'DATA', 'FED', 'TRADE', 'GEO', 'POLICY', 'HEALTH', 'CORP'];
const RANKED_TYPES = ['NEWS', 'SHOCK', 'RATES'];
const SUB_TYPES = ['DATA', 'FED', 'TRADE', 'GEO', 'POLICY', 'HEALTH', 'CORP'];
/** The categories of one headline, a Set. */
function categorize(h) {
  const s = String(h || '').slice(0, HEADLINE_MAX).toLowerCase();
  const out = new Set();
  for (const k of CATS) if (NEWS_RX[k].test(s)) out.add(k);
  return out;
}
/** Sorted headline times (ms) of ALL and of each of TYPES, from [{ t, h }]; a WRAP headline counts only as ALL and WRAP. */
function groupTimes(items) {
  const g = { ALL: [] };
  for (const k of TYPES) g[k] = [];
  for (const it of items) {
    const c = categorize(it.h);
    g.ALL.push(it.t);
    if (c.has('WRAP')) { g.WRAP.push(it.t); continue; }
    g.NEWS.push(it.t);
    if (c.has('TRADE') || c.has('GEO') || c.has('POLICY')) g.SHOCK.push(it.t);
    if (c.has('DATA') || c.has('FED')) g.RATES.push(it.t);
    for (const k of SUB_TYPES) if (c.has(k)) g[k].push(it.t);
  }
  for (const k of Object.keys(g)) g[k].sort((a, b) => a - b);
  return g;
}
/**
 * One session's history row, as the research counted it: counts and per-hour rates of all headlines (d, nOn, nSe, on, se),
 * the overnight hours (onH) and, from groupTimes() output, each type's [overnight, session] counts (g). A plain sorted
 * array of times gives the row without g.
 */
function sessionRow(groups, day) {
  const typed = !Array.isArray(groups);
  const all = typed ? groups.ALL : groups;
  const w = windows(day);
  const onH = (w.open - w.from) / 3600e3;
  const nOn = countIn(all, w.from, w.open), nSe = countIn(all, w.open, w.dec);
  const row = { d: day, nOn, nSe, on: nOn / onH, se: nSe / ((w.dec - w.open) / 3600e3), onH };
  if (typed) { row.g = {}; for (const k of TYPES) row.g[k] = [countIn(groups[k], w.from, w.open), countIn(groups[k], w.open, w.dec)]; }
  return row;
}
/** The share of `sample` strictly below `v`. */
function rankOf(v, sample) { let lt = 0; for (const x of sample) if (x < v) lt++; return lt / sample.length; }

// ---- I/O seams ----------------------------------------------------------------------------------------------------
async function timedFetch(fetchFn, url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetchFn(url, { ...opts, signal: ctl.signal }); return { status: r.status, text: await r.text() }; }
  finally { clearTimeout(t); }
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { return null; } }
function mtimeOf(file) { try { return fs.statSync(file).mtimeMs; } catch (_e) { return 0; } }
function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = JSON.stringify(obj);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    try { fs.renameSync(tmp, file); } catch (_e) { fs.writeFileSync(file, body); try { fs.unlinkSync(tmp); } catch (_e2) { /* gone */ } }
  } catch (_e) { /* journal only: a cache write never breaks a pass */ }
}
/** The Alpaca server keys as request headers, or null (the spellings lib/alpaca-adapter.js _serverKeys accepts). */
function serverNewsHeaders(env = process.env) {
  const id = env.ALPACA_API_KEY_ID || env.ALPACA_API_KEY || env.APCA_API_KEY_ID || '';
  const secret = env.ALPACA_API_SECRET_KEY || env.ALPACA_API_SECRET || env.ALPACA_SECRET_KEY || env.APCA_API_SECRET_KEY || '';
  return id && secret ? { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': secret } : null;
}

// ---- gamma -----------------------------------------------------------------------------------------------------------
/** The CSV's [date, gex] rows, oldest first; the header and any non-numeric GEX dropped. */
function parseGex(text) {
  const out = [];
  for (const line of String(text || '').trim().split(/\r?\n/).slice(1)) {
    const c = line.split(',');
    const g = Number(c[3]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(c[0]) && c[3] !== undefined && c[3].trim() !== '' && Number.isFinite(g)) out.push([c[0], g]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
/** The prior session's GEX reading for an entry on `day`: { as_of, gex, rank, tercile, sign, n } or { why }. */
function gammaReading(rows, day) {
  const prev = cal.prevTradingDay(day);
  let i = -1;
  for (let k = (rows || []).length - 1; k >= 0; k--) if (rows[k][0] < day) { i = k; break; }
  if (i < 0) return { why: 'no CSV row before the entry day' };
  if (rows[i][0] !== prev) return { why: `the prior session ${prev} is not in the CSV yet (latest ${rows[i][0]})` };
  if (i < GEX_N) return { why: `short history (${i} of ${GEX_N} sessions before ${prev})` };
  let lt = 0;
  for (let k = i - GEX_N; k < i; k++) if (rows[k][1] < rows[i][1]) lt++;
  const p = lt / GEX_N;
  return { as_of: rows[i][0], gex: rows[i][1], rank: round(p, 4), tercile: tercile(p), sign: Math.sign(rows[i][1]), n: GEX_N };
}
let _g = null;   // { dir, rows, mtime, triedAt, err, p }: one slot
function gexSlot(dir) { if (!_g || _g.dir !== dir) _g = { dir, rows: null, mtime: 0, triedAt: 0, err: null, p: null }; return _g; }
const hasRow = (rows, d) => Array.isArray(rows) && rows.length > 0 && rows.some((r) => r[0] === d);
function loadGexFile(s) {
  const file = path.join(s.dir, 'gex.json');
  const m = mtimeOf(file);
  if (!m || m === s.mtime) return;
  const j = readJson(file);
  if (j && Array.isArray(j.rows) && j.rows.length) { s.rows = j.rows; s.mtime = m; }
}
async function fetchGex(s, now, fetchFn) {
  s.triedAt = now;
  try {
    const r = await timedFetch(fetchFn, GEX_URL, { headers: { 'User-Agent': UA } }, FETCH_MS);
    if (r.status !== 200) { s.err = `HTTP ${r.status}`; return; }
    const rows = parseGex(r.text);
    if (rows.length <= GEX_N) { s.err = `the CSV has ${rows.length} rows`; return; }
    s.rows = rows.slice(-GEX_KEEP); s.err = null;
    writeJson(path.join(s.dir, 'gex.json'), { fetched_at: iso(now), latest: s.rows[s.rows.length - 1][0], rows: s.rows });
    s.mtime = mtimeOf(path.join(s.dir, 'gex.json'));
  } catch (e) { s.err = msg(e); }
}
/** Make sure the day's prior session is in hand (file, then fetch, rate-limited); resolves when any fetch is done. */
function gammaEnsure(c, now) {
  const s = gexSlot(c.dir);
  const day = cal.etOf(now).day, prev = cal.prevTradingDay(day);
  if (hasRow(s.rows, prev)) return null;
  loadGexFile(s);   // another process may have fetched it
  if (!hasRow(s.rows, prev) && !s.p && now - s.triedAt >= GEX_RETRY_MS) {
    s.p = fetchGex(s, now, c.fetchFn || globalThis.fetch).finally(() => { s.p = null; });
  }
  return s.p;
}
async function gammaFor(c, now) {
  const p = gammaEnsure(c, now);
  if (p) await p;
  const s = gexSlot(c.dir);
  if (!s.rows) return { why: s.err ? `CSV fetch failed (${s.err})` : 'no CSV yet' };
  const rd = gammaReading(s.rows, cal.etOf(now).day);
  if (rd.why && s.err) rd.why += ` (last fetch: ${s.err})`;
  return rd;
}

// ---- news ------------------------------------------------------------------------------------------------------------
let _n = null;   // { dir, st, mtime, p, failedAt, err }: one slot
function newsSlot(dir) { if (!_n || _n.dir !== dir) _n = { dir, st: null, mtime: 0, p: null, failedAt: 0, err: null }; return _n; }
function loadNewsFile(s) {
  const file = path.join(s.dir, 'news.json');
  const m = mtimeOf(file);
  if (!m || m === s.mtime) return;
  const j = readJson(file);
  if (j && Array.isArray(j.history)) { s.st = j; s.mtime = m; }
}
/**
 * Is a refresh due at `now`? The day's first at/after 09:30, hourly, one at/after 15:50 (C's count), and one at/after
 * 16:05 (the settled 09:30-15:50 count, which joins the history); none after that.
 */
function newsDue(s, now) {
  const e = cal.etOf(now);
  if (!cal.isTradingDay(e.day) || e.min < OPEN_MIN) return false;
  if (s.failedAt && now - s.failedAt < NEWS_RETRY_MS) return false;
  const t = s.st && s.st.today && s.st.today.d === e.day ? s.st.today : null;
  if (!t) return true;
  if (t.final) return false;
  const w = windows(e.day);
  if (now >= w.dec + NEWS_GRACE_MS) return true;
  if (now >= w.dec) return Date.parse(t.se_to) < w.dec;
  return now - Date.parse(t.fetched_at) >= NEWS_EVERY_MS;
}
/** Every headline [{ t, h }] tagged with the five index funds in [startMs, endMs]; throws on any failed page. */
async function fetchNewsItems(startMs, endMs, headers, fetchFn) {
  const seen = new Map();
  let token = null, pages = 0;
  do {
    const u = `${NEWS_URL}?start=${isoS(startMs)}&end=${isoS(endMs)}&limit=50&sort=asc&include_content=false&symbols=${NEWS_SYMBOLS}`
      + (token ? `&page_token=${encodeURIComponent(token)}` : '');
    const r = await timedFetch(fetchFn, u, { headers: { ...headers, Accept: 'application/json' } }, FETCH_MS);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const j = JSON.parse(r.text);
    for (const n of (j && j.news) || []) {
      const t = Date.parse(n && n.created_at);
      if (Number.isFinite(t)) seen.set(n.id != null ? `#${n.id}` : `${n.created_at}|${n.headline}`, { t, h: n.headline });
    }
    token = j && j.next_page_token; pages++;
  } while (token && pages < PAGE_MAX);
  if (token) throw new Error(`more than ${PAGE_MAX} pages`);
  return [...seen.values()];
}
async function refreshNews(s, now, headers, fetchFn) {
  try {
    loadNewsFile(s);
    const st = s.st || { v: 1, history: [], today: null };
    const hist = Array.isArray(st.history) ? st.history.slice() : [];
    const day = cal.etOf(now).day, w = windows(day);
    const last = hist.length ? hist[hist.length - 1].d : null;
    const missing = [];
    if (last) for (let d = cal.nextTradingDay(last); d && d < day && missing.length <= NEWS_BACKFILL; d = cal.nextTradingDay(d)) missing.push(d);
    const backfill = missing.length <= NEWS_BACKFILL ? missing : [];   // a longer gap stays a gap
    const heal = hist.slice(-NEWS_BACKFILL).filter((h) => !h.g && h.d < day).map((h) => h.d);   // rows from before the types
    const redo = [...heal, ...backfill];
    // The overnight count is read again until a refresh 15 minutes past the open has counted it (a headline can reach
    // the API a little after its created_at); after that only the session is read.
    const onSettled = !!(st.today && st.today.d === day && st.today.on_final && st.today.g);
    const end = Math.min(now, w.dec);
    const start = redo.length ? windows(redo[0]).from : (onSettled ? w.open : w.from);
    const g = groupTimes(await fetchNewsItems(start, end, headers, fetchFn));
    for (const d of heal) hist[hist.findIndex((h) => h.d === d)] = sessionRow(g, d);
    for (const d of backfill) hist.push(sessionRow(g, d));
    const nOn = onSettled ? st.today.nOn : countIn(g.ALL, w.from, w.open);
    const nSe = countIn(g.ALL, w.open, end);
    const tg = {};
    for (const k of TYPES) tg[k] = [onSettled ? st.today.g[k][0] : countIn(g[k], w.from, w.open), countIn(g[k], w.open, end)];
    const final = now >= w.dec + NEWS_GRACE_MS;   // the settled 09:30-15:50 count: the day joins the history
    st.today = { d: day, nOn, on_final: onSettled || now >= w.open + NEWS_GRACE_MS, nSe, g: tg, se_to: iso(end), final, fetched_at: iso(now) };
    if (final && !(hist.length && hist[hist.length - 1].d === day)) {
      const onH = (w.open - w.from) / 3600e3;
      hist.push({ d: day, nOn, nSe, on: nOn / onH, se: nSe / SESSION_HOURS, onH, g: tg });
    }
    st.history = hist.slice(-NEWS_KEEP);
    st.v = 1;
    st.backfilled = redo.length ? redo : undefined;
    st.gap = missing.length > NEWS_BACKFILL ? `${missing.length}+ sessions after ${last} not backfilled` : undefined;
    s.st = st; s.failedAt = 0; s.err = null;
    writeJson(path.join(s.dir, 'news.json'), st);
    s.mtime = mtimeOf(path.join(s.dir, 'news.json'));
  } catch (e) { s.failedAt = now; s.err = msg(e); }
}
function newsEnsure(c, now) {
  if (!c.headers) return null;   // not the fetch role: this process only reads the shared file
  const s = newsSlot(c.dir);
  loadNewsFile(s);               // a cheap stat: another refresher's write (or a re-seed) is seen before deciding
  if (!s.p && newsDue(s, now)) s.p = refreshNews(s, now, c.headers, c.fetchFn || globalThis.fetch).finally(() => { s.p = null; });
  return s.p;
}
/** A window's type readings: `types` { NEWS, SHOCK, RATES } with ranks against `hist` when `ok`, `counts` for the sub-types. */
function typeFields(t, hist, idx, hours, ok) {
  if (!t.g) return {};
  const types = {}, counts = {};
  for (const k of SUB_TYPES) counts[k] = t.g[k][idx];
  counts.WRAP = t.g.WRAP[idx];
  for (const k of RANKED_TYPES) {
    const n = t.g[k][idx];
    if (!ok) { types[k] = { n, rate: null, rank: null, tercile: null }; continue; }
    const rate = n / hours, p = rankOf(rate, hist.map((h) => h.g[k][idx] / (idx === 0 ? h.onH : SESSION_HOURS)));
    types[k] = { n, rate: round(rate, 3), rank: round(p, 3), tercile: tercile(p) };
  }
  return { types, counts };
}
/** The news reading for an entry at `now` from the counts file: { day, as_of, overnight, session, ... } or { why }. */
function newsReading(st, now) {
  const day = cal.etOf(now).day;
  if (!st) return { why: 'no news counts file' };
  const t = st.today && st.today.d === day ? st.today : null;
  if (!t) return { why: `no news counts for ${day} yet` + (st.today && st.today.fetched_at ? ` (last refresh ${st.today.fetched_at})` : '') };
  const hist = (st.history || []).filter((h) => h.d < day).slice(-NEWS_N);
  if (hist.length < NEWS_N) return { why: `short history (${hist.length} of ${NEWS_N} sessions)` };
  const w = windows(day);
  const onH = (w.open - w.from) / 3600e3;
  const on = t.nOn / onH, pOn = rankOf(on, hist.map((h) => h.on));
  const seH = (Date.parse(t.se_to) - w.open) / 3600e3;
  const session = { n: t.nSe, hours: round(seH, 2), to: t.se_to };
  if (seH >= SESSION_MIN_HOURS) {
    const se = t.nSe / seH, pSe = rankOf(se, hist.map((h) => h.se));
    Object.assign(session, { rate: round(se, 3), rank: round(pSe, 3), tercile: tercile(pSe) });
  } else Object.assign(session, { rate: null, rank: null, tercile: null, why: `under ${SESSION_MIN_HOURS * 60} minutes of session` });
  const typed = hist.filter((h) => h.g).length;
  const histOk = typed === NEWS_N;
  const overnight = { n: t.nOn, hours: round(onH, 2), rate: round(on, 3), rank: round(pOn, 3), tercile: tercile(pOn) };
  Object.assign(overnight, typeFields(t, hist, 0, onH, histOk));
  Object.assign(session, typeFields(t, hist, 1, seH, histOk && seH >= SESSION_MIN_HOURS));
  const sh = t.g ? t.g.SHOCK[1] : null, ra = t.g ? t.g.RATES[1] : null;
  return { day, as_of: t.fetched_at, history: NEWS_N, history_to: hist[hist.length - 1].d, overnight, session,
    mix: t.g ? (sh > ra ? 'SHOCK' : ra > sh ? 'RATES' : 'TIE') : null,
    ...(t.g ? {} : { types_why: 'no type counts for the day yet' }),
    ...(t.g && !histOk ? { types_why: `${typed} of ${NEWS_N} history sessions have type counts` } : {}) };
}
/**
 * The gamma and news readings for a decision at `now`, from the shared files alone: no fetch, the scan's read (lib/two-sleeve/closeibs-scan.js).
 * Each is shaped as gammaReading / newsReading return it ({ why } when missing).
 */
function readContext(dir, now) {
  const gex = readJson(path.join(dir, 'gex.json'));
  return { gamma: gammaReading(gex && gex.rows, cal.etOf(now).day), news: newsReading(readJson(path.join(dir, 'news.json')), now) };
}
async function newsFor(c, now) {
  const p = newsEnsure(c, now);
  if (p) await Promise.race([p, new Promise((r) => setTimeout(r, WAIT_MS).unref())]);
  const s = newsSlot(c.dir);
  loadNewsFile(s);
  const rd = newsReading(s.st, now);
  if (rd.why && s.err) rd.why += ` (last refresh failed: ${s.err})`;
  return rd;
}

// ---- vix -------------------------------------------------------------------------------------------------------------
let _v = { key: null, p: null };   // the quote of the last scan that had entries: one slot
function vixQuote(key, fetchFn) {
  if (_v.key === key && _v.p) return _v.p;
  const p = (async () => {
    const r = await timedFetch(fetchFn, VIX_URL, { headers: { 'User-Agent': UA } }, VIX_MS);
    const fetchedAt = _clock();
    if (r.status !== 200) return { why: `quote HTTP ${r.status}` };
    const j = JSON.parse(r.text);
    const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
    const px = Number(m && m.regularMarketPrice), at = Number(m && m.regularMarketTime) * 1000;
    if (!(px > 0) || !(at > 0)) return { why: 'no regularMarketPrice / regularMarketTime in the chart meta' };
    const pc = Number(m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose);
    return { px, at, fetchedAt, prevClose: pc > 0 ? pc : null };
  })().catch((e) => ({ why: `quote failed (${msg(e)})` }));
  _v = { key, p };
  return p;
}
/** The VIX reading at an entry: { prior, prior_src, prior_meta, now, chg, bucket, as_of, lag_sec } or { why }. */
function vixReading(now, q, priorDaily) {
  if (!q || q.why) return { why: (q && q.why) || 'no quote' };
  const day = cal.etOf(now).day, qDay = cal.etOf(q.at).day;
  if (qDay !== day) return { why: `the quote is from ${qDay} (${iso(q.at)}), not the entry day` };
  let prior = Number(priorDaily), src = 'daily';
  if (!(prior > 0)) { prior = Number(q.prevClose); src = 'chart_meta'; }
  if (!(prior > 0)) return { why: 'no prior close' };
  const chg = q.px / prior - 1;
  return { prior: round(prior, 4), prior_src: src, prior_meta: q.prevClose == null ? null : round(Number(q.prevClose), 4), now: round(q.px, 4), chg: round(chg, 4),
    bucket: chg <= 0 ? 'QUIET' : chg < VIX_FEAR ? 'MILD' : 'FEAR', as_of: iso(q.at), lag_sec: Math.round((q.fetchedAt - q.at) / 1000) };
}
async function vixFor(c, now) {
  const [q, prior] = await Promise.all([
    vixQuote(now, c.fetchFn || globalThis.fetch),
    Promise.resolve().then(() => (typeof c.vixPrior === 'function' ? c.vixPrior(now) : null)).catch(() => null),
  ]);
  return vixReading(now, q, prior);
}

// ---- the two calls -------------------------------------------------------------------------------------------------
const isLive = (now) => Number.isFinite(now) && Math.abs(_clock() - now) <= LIVE_MS;

/**
 * Every pass: the day's CSV once the prior session is due in it, and (with the server keys) the news refresh when due.
 * Never awaited by the caller; a non-live pass and a closed day do nothing.
 */
function kick(now, c) {
  if (!c || !c.dir || !isLive(now) || !cal.isTradingDay(cal.etOf(now).day)) return null;
  const ps = [gammaEnsure(c, now), newsEnsure(c, now)].filter(Boolean);
  return ps.length ? Promise.all(ps).then(() => undefined) : null;
}

/** One entry_tags row for one placed entry. Never awaited by the caller; resolves after the row is written. */
async function tag(entry, c) {
  const now = Number(entry && entry.now);
  if (!c || !c.dir || typeof c.log !== 'function' || !isLive(now)) return;
  const sym = String((entry && entry.symbol) || '').trim().toUpperCase();
  if (!sym) return;
  const safe = (p) => p.catch((e) => ({ why: `error (${msg(e)})` }));
  const [g, n, v] = await Promise.all([safe(gammaFor(c, now)), safe(newsFor(c, now)), safe(vixFor(c, now))]);
  const qty = Number(entry.qty), px = Number(entry.price);
  const part = (x) => (x && !x.why ? x : null);
  c.log({ event: 'entry_tags', symbol: sym, account: entry.account || null, source: entry.source || 'trader',
    qty: qty > 0 ? qty : null, entry_px: round(px, 4), notional: qty > 0 && px > 0 ? Math.round(qty * px) : null,
    order_id: entry.order_id != null ? String(entry.order_id) : null, entry_at: iso(now),
    gamma: part(g), news: part(n), vix: part(v),
    ...(part(g) ? {} : { gamma_why: (g && g.why) || 'no reading' }),
    ...(part(n) ? {} : { news_why: (n && n.why) || 'no reading' }),
    ...(part(v) ? {} : { vix_why: (v && v.why) || 'no reading' }),
    shadow: true });
}

/** Tests only: the real clock, the caches emptied. */
function _reset({ clock } = {}) { _clock = clock || (() => Date.now()); _g = null; _n = null; _v = { key: null, p: null }; }

module.exports = {
  kick, tag, serverNewsHeaders, readContext,
  parseGex, gammaReading, sessionRow, windows, etMs, newsReading, newsDue, vixReading, rankOf, tercile, categorize, groupTimes,
  GEX_N, NEWS_N, VIX_FEAR, GEX_URL, NEWS_URL, VIX_URL, NEWS_SYMBOLS, NEWS_RX, TYPES, _reset,
};
