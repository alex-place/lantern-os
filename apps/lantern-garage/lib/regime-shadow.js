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
 *   claude — TRADER_REGIME_MODEL (default claude-opus-5)
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
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const CLAUDE_MODEL = () => process.env.TRADER_REGIME_MODEL || 'claude-opus-5';
const LOCAL_URL = () => process.env.TRADER_REGIME_LOCAL_URL || 'http://127.0.0.1:11434';
const LOCAL_MODEL = () => process.env.TRADER_REGIME_LOCAL_MODEL || process.env.OURO_MODEL || 'ouro:latest';

function enabled() { return process.env.TRADER_REGIME_SHADOW === '1'; }
function timeoutMs() { return Number(process.env.TRADER_REGIME_TIMEOUT_MS) || 45000; }
function logFile() {
  return process.env.TRADER_REGIME_LOG
    || path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'regime-shadow.jsonl');
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

async function daily(sym, days) {
  const p2 = Math.floor(Date.now() / 1000);
  const p1 = p2 - (days + 15) * 86400;
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&period1=${p1}&period2=${p2}`);
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

/** Everything the prompt gets. Exposed for tests and for the scorer. */
async function buildContext(read) {
  const [spy, qqq, iwm, vix] = await Promise.all([
    daily('SPY', 11), daily('QQQ', 11), daily('IWM', 11), daily('^VIX', 2),
  ]);
  if (spy.length < 5) throw new Error('insufficient SPY history');
  // For the OPEN read, today's partial bar (if Yahoo already lists it) must be
  // dropped from the history and used only as the gap reference — the model
  // may not see today's high/low/close before predicting them.
  const today = etDay(Date.now());
  const hist = spy.filter((b) => b.d < today);
  const todayBar = spy.find((b) => b.d === today) || null;
  return {
    read, date: today,
    spy: hist.slice(-10).map((b) => ({ ...b, ibs: +dayIbs(b).toFixed(2) })),
    qqq5: qqq.filter((b) => b.d < today).slice(-5).map((b) => ({ d: b.d, chg: null, c: b.c })),
    iwm5: iwm.filter((b) => b.d < today).slice(-5).map((b) => ({ d: b.d, c: b.c })),
    vix: vix.length ? vix[vix.length - 1].c : null,
    gapPct: read === 'open' && todayBar && hist.length
      ? +(((todayBar.o / hist[hist.length - 1].c) - 1) * 100).toFixed(2) : null,
    todayBar: read === 'close' ? (todayBar ? { ...todayBar, ibs: +dayIbs(todayBar).toFixed(2) } : null) : null,
  };
}

function buildPrompt(ctx) {
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

function parseReply(text) {
  try {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return { degraded: true, reason: 'unparseable' };
    const j = JSON.parse(m[0]);
    const regime = ['trend_up', 'trend_down', 'chop'].includes(j.regime) ? j.regime : null;
    const posture = ['long', 'flat', 'inverse'].includes(j.posture) ? j.posture : null;
    const conviction = Number.isFinite(Number(j.conviction))
      ? Math.max(0, Math.min(100, Math.round(Number(j.conviction)))) : null;
    if (!regime || !posture || conviction == null) return { degraded: true, reason: 'missing fields' };
    return { regime, posture, conviction, why: String(j.reason || '').slice(0, 160), degraded: false };
  } catch (_e) { return { degraded: true, reason: 'parse error' }; }
}

// ── providers ────────────────────────────────────────────────────────────────
async function askClaude(prompt, fetchImpl) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { degraded: true, reason: 'no api key' };
  const doFetch = fetchImpl || globalThis.fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs());
  try {
    const res = await doFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL(), max_tokens: 300,
        messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res || !res.ok) return { degraded: true, reason: 'http ' + (res && res.status) };
    const j = await res.json();
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return parseReply(text);
  } catch (e) {
    return { degraded: true, reason: ac.signal.aborted ? 'timeout' : String(e && e.message).slice(0, 60) };
  } finally { clearTimeout(timer); }
}

async function askLocal(prompt, fetchImpl) {
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
    return parseReply(text);
  } catch (e) {
    return { degraded: true, reason: ac.signal.aborted ? 'timeout' : String(e && e.message).slice(0, 60) };
  } finally { clearTimeout(timer); }
}

/**
 * Fire one read ('open' | 'close') for both providers, once per day each.
 * Fire-and-forget from the caller; never throws; journal-only.
 */
async function run(read, { fetchImpl, now = Date.now(), ctx: injectedCtx } = {}) {
  if (!enabled()) return { skipped: 'disabled' };
  const date = etDay(now);
  const providers = [['claude', askClaude], ['local', askLocal]]
    .filter(([name]) => !alreadyLogged(date, read, name));
  if (!providers.length) return { skipped: 'already logged' };

  let ctx, prompt;
  // injectedCtx: tests must not depend on a live quote feed
  try { ctx = injectedCtx || await buildContext(read); prompt = buildPrompt(ctx); }
  catch (e) {
    for (const [name] of providers) {
      journal({ ts: new Date(now).toISOString(), date, read, provider: name,
        degraded: true, reason: 'context: ' + String(e.message).slice(0, 60) });
    }
    return { skipped: 'context failed' };
  }

  const out = [];
  for (const [name, ask] of providers) {
    const t0 = Date.now();
    const r = await ask(prompt, fetchImpl);
    const row = { ts: new Date(now).toISOString(), date, read, provider: name,
      model: name === 'claude' ? CLAUDE_MODEL() : LOCAL_MODEL(),
      latency_ms: Date.now() - t0,
      // the exact tape shown, so the scorer can verify no look-ahead
      gap_pct: ctx.gapPct, vix: ctx.vix, last_close: ctx.spy[ctx.spy.length - 1].c,
      ...r };
    journal(row);
    out.push(row);
  }
  return { logged: out.length };
}

module.exports = { run, enabled, buildContext, buildPrompt, parseReply, alreadyLogged, logFile };
