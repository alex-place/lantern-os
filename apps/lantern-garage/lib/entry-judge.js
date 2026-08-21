'use strict';
/**
 * entry-judge.js — a second opinion on every entry, in SHADOW (#3390).
 *
 * Operator direction 2026-08-20: "the algorithm finds signals and entries and
 * the AI reviews them to say yes or no — and if on a negative day it's looking
 * for a SPY long, the AI should tell it that's a bad idea and take the inverse
 * ETF position instead."
 *
 * WHY SHADOW: the last per-signal AI layer was measured at rho 0.007 against
 * outcomes (#3358) — indistinguishable from noise. That measurement gates this
 * one: the judge journals a verdict on every REAL entry at the moment the
 * engine commits, and experiments/entry_judge_score.js grades it later —
 * including the redirect counterfactual, priced from the inverse wrapper's own
 * bars over the identical holding window. Only a judge that SEPARATES (approved
 * entries beat rejected ones; redirects beat the longs they'd replace) earns a
 * live veto, and that wiring would be its own gated change.
 *
 * VERDICTS: approve | reject | redirect_inverse — the third only offered when
 * the symbol's family has an inverse wrapper in our universe (direction-lock
 * FAMILY): SPY→SPXS, QQQ→SQQQ, IWM→TZA, DIA→SDOW, SOX→SOXS. XLK/GLD/TLT longs
 * get approve/reject only.
 *
 * PROMPT DISCIPLINE (the #3370 lesson): the prompt names NO suspected failure
 * mode — naming one makes the model hunt it (measured: 25/25 convictions
 * collapsed when the prompt said "falling knife"). It gets the evidence the
 * engine acted on, the three options, and nothing leading.
 *
 * TWO PROVIDERS, same prompt, side by side (same contract as regime-shadow):
 * claude (TRADER_JUDGE_MODEL, default claude-opus-5) and the local Σ₀ serve.
 *
 * WHAT IT CANNOT DO: no bridge, no broker, no order path — pinned by test to
 * fs/path/direction-lock requires only. Fire-and-forget from the entry site;
 * any failure journals a degraded row and the entry proceeds untouched.
 * DEFAULT OFF: TRADER_ENTRY_JUDGE=1.
 */
const fs = require('fs');
const path = require('path');
const { FAMILY, instrumentSign, leverageOf } = require('./direction-lock');

const CLAUDE_MODEL = () => process.env.TRADER_JUDGE_MODEL || 'claude-opus-5';
const LOCAL_URL = () => process.env.TRADER_JUDGE_LOCAL_URL || process.env.TRADER_REGIME_LOCAL_URL || 'http://127.0.0.1:11434';
const LOCAL_MODEL = () => process.env.TRADER_JUDGE_LOCAL_MODEL || process.env.OURO_MODEL || 'ouro:latest';

function enabled() { return process.env.TRADER_ENTRY_JUDGE === '1'; }
function timeoutMs() { return Number(process.env.TRADER_JUDGE_TIMEOUT_MS) || 30000; }
function logFile() {
  return process.env.TRADER_JUDGE_LOG
    || path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'entry-judge.jsonl');
}

function journal(row) {
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    fs.appendFileSync(logFile(), JSON.stringify(row) + '\n');
  } catch (_e) { /* journalling must never affect a trade */ }
}

/** The family's inverse wrapper in our universe, or null — the HIGHEST-leverage
 *  one (SPXS over SH), because that is the wrapper the trader actually uses and
 *  the one whose bars the scorer can price the counterfactual from. */
function inverseFor(sym) {
  const { family, sign } = instrumentSign(sym);
  if (!family || sign !== 1) return null;               // only long entries get a redirect option
  let best = null, bestLev = 0;
  for (const [k, v] of Object.entries(FAMILY)) {
    if (v[0] !== family || v[1] !== -1) continue;
    const lev = leverageOf(k) || 1;
    if (lev > bestLev) { best = k; bestLev = lev; }
  }
  return best;
}

function buildPrompt(e) {
  const f = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? 'n/a' : Number(v).toFixed(d));
  const inv = e.inverse;
  const opts = inv
    ? `"approve" (take this entry), "reject" (skip it), or "redirect_inverse" (the better position right now is ${inv}, the family's inverse ETF)`
    : '"approve" (take this entry) or "reject" (skip it)';
  return [
    'An automated intraday system trades US equity ETFs, long only, on a mean-reversion',
    'signal. It has just decided to BUY and you are the second opinion, judging as an',
    'experienced discretionary trader reading the same tape.',
    '',
    `THE ENTRY, about to be placed:`,
    `  BUY ${e.symbol}${Number(e.leverage) > 1 ? ` (${e.leverage}x leveraged)` : ''} at ${f(e.price)}   stop ${f(e.stop)}   size ${f(e.notional, 0)} USD`,
    '',
    'THE EVIDENCE THE SYSTEM ACTED ON (same numbers it scored):',
    `  its own p_win ${f(e.p_win, 3)}   session IBS ${f(e.ibs, 3)} (0 = at session low)`,
    `  SPY today ${f(e.spy_tape)}%   SPY last 30 min ${f(e.spy_mom30)}%   regime ${e.regime || 'unknown'}`,
    `  MACD histogram ${f(e.macd_hist, 4)}   at S/R zone: ${e.in_zone == null ? 'n/a' : e.in_zone ? 'yes' : 'no'}   time ${e.et_time || 'n/a'} ET`,
    '',
    `Your options: ${opts}.`,
    '',
    'Reply with strict JSON, no prose:',
    `{"verdict":${inv ? '"approve"|"reject"|"redirect_inverse"' : '"approve"|"reject"'},"conviction":<integer 0-100>,"reason":"<max 20 words>"}`,
    'conviction is how sure you are of your verdict. 50 = no view.',
  ].join('\n');
}

function parseReply(text, allowRedirect) {
  try {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return { degraded: true, reason: 'unparseable' };
    const j = JSON.parse(m[0]);
    const allowed = allowRedirect ? ['approve', 'reject', 'redirect_inverse'] : ['approve', 'reject'];
    if (!allowed.includes(j.verdict)) return { degraded: true, reason: 'bad verdict' };
    const conviction = Number.isFinite(Number(j.conviction))
      ? Math.max(0, Math.min(100, Math.round(Number(j.conviction)))) : null;
    if (conviction == null) return { degraded: true, reason: 'no conviction' };
    return { verdict: j.verdict, conviction, why: String(j.reason || '').slice(0, 160), degraded: false };
  } catch (_e) { return { degraded: true, reason: 'parse error' }; }
}

async function askClaude(prompt, allowRedirect, fetchImpl) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { degraded: true, reason: 'no api key' };
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return { degraded: true, reason: 'no fetch' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs());
  try {
    const res = await doFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL(), max_tokens: 200,
        messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res || !res.ok) return { degraded: true, reason: 'http ' + (res && res.status) };
    const j = await res.json();
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return parseReply(text, allowRedirect);
  } catch (e) {
    return { degraded: true, reason: ac.signal.aborted ? 'timeout' : String(e && e.message).slice(0, 60) };
  } finally { clearTimeout(timer); }
}

async function askLocal(prompt, allowRedirect, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return { degraded: true, reason: 'no fetch' };
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
    return parseReply(text, allowRedirect);
  } catch (e) {
    return { degraded: true, reason: ac.signal.aborted ? 'timeout' : String(e && e.message).slice(0, 60) };
  } finally { clearTimeout(timer); }
}

/**
 * Judge one entry the engine has COMMITTED to. Fire-and-forget; never throws;
 * journal-only. `entry` carries symbol/price/stop/notional + the decision_context
 * evidence fields the engine recorded (#3384).
 */
async function judge(entry, { fetchImpl, now = Date.now() } = {}) {
  if (!enabled()) return { skipped: 'disabled' };
  try {
    const e = { ...entry, leverage: leverageOf(entry.symbol), inverse: inverseFor(entry.symbol) };
    const prompt = buildPrompt(e);
    const base = {
      ts: new Date(now).toISOString(),
      date: new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
      symbol: e.symbol, price: e.price ?? null, stop: e.stop ?? null,
      notional: e.notional ?? null, inverse: e.inverse,
      p_win: e.p_win ?? null, ibs: e.ibs ?? null, spy_tape: e.spy_tape ?? null,
      regime: e.regime ?? null,
    };
    for (const [provider, ask] of [['claude', askClaude], ['local', askLocal]]) {
      const t0 = Date.now();
      const r = await ask(prompt, !!e.inverse, fetchImpl);
      journal({ ...base, provider,
        model: provider === 'claude' ? CLAUDE_MODEL() : LOCAL_MODEL(),
        latency_ms: Date.now() - t0, ...r });
    }
    return { logged: 2 };
  } catch (e2) {
    journal({ ts: new Date(now).toISOString(), symbol: entry && entry.symbol,
      degraded: true, reason: 'judge: ' + String(e2 && e2.message).slice(0, 60) });
    return { skipped: 'error' };
  }
}

module.exports = { judge, enabled, buildPrompt, parseReply, inverseFor, logFile };
