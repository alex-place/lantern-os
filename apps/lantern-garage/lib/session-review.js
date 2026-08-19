'use strict';
/**
 * session-review.js — one model call at the close, reading a whole session (#3359).
 *
 * WHY THIS SHAPE, when the per-decision analyst measured at rho ~0 (#3358):
 * both hot-path roles were tested and neither paid. Entry review had no signal;
 * exit review had no headroom (holding every signal_exit to the close would have
 * cost -$10,751). What HAS produced results is reading a completed day — the
 * day-P&L carried-basis bug, 1,200 shares of duplicate stops against 80 held,
 * 30.2% beta-adjusted semis nobody could see, `stops_fired: 0` on a day a stop
 * demonstrably filled, and a deploy silently reverting the bar corpus were all
 * found that way. None was a per-tick judgement; every one was a discontinuity
 * visible only across a session and against its predecessors.
 *
 * So the economics invert: instead of a cheap model constantly (406 calls/session,
 * 61 per trade actually taken), this is a capable model once. It costs less AND
 * it is the only role with a track record.
 *
 * WHAT IT CANNOT DO:
 *   - It cannot touch an order. It has no bridge, no broker, no write path to
 *     anything except its own journal. The worst case for a wrong finding is a
 *     false flag a human ignores.
 *   - It cannot run in the trading loop. It is invoked after the close.
 *   - It cannot fail loudly. Any error returns null and journals the reason.
 *
 * DEFAULT OFF (TRADER_SESSION_REVIEW=1). Replay it over past sessions first with
 * experiments/session_review_replay.js — the honest bar is whether it independently
 * surfaces bugs we already found by hand.
 */
const fs = require('fs');
const path = require('path');

const MODEL = process.env.TRADER_REVIEW_MODEL || 'claude-opus-5';
const BASELINE_SESSIONS = 5;

function enabled() { return process.env.TRADER_SESSION_REVIEW === '1'; }
function timeoutMs() { return Number(process.env.TRADER_REVIEW_TIMEOUT_MS) || 120000; }
function logFile() {
  return process.env.TRADER_REVIEW_LOG
    || path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'session-reviews.jsonl');
}
const etDay = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const etHM = (t) => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
const r2 = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : null);

/**
 * Build the digest the reviewer reads. This is the whole design: rich enough to
 * expose a discontinuity, bounded enough to stay one cheap call. Everything here
 * is a NUMBER the model can cite — the prompt forbids findings that don't quote
 * one, because an ungrounded "consider reviewing your risk" is noise, not a flag.
 */
function buildDigest(ledgerText, day) {
  const rows = String(ledgerText || '').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter((x) => x && x.ts);

  const sessions = rows.filter((x) => x.event === 'session');
  const today = sessions.find((s) => s.date === day) || null;
  const priorSessions = sessions.filter((s) => s.date < day).slice(-BASELINE_SESSIONS);

  const todayRows = rows.filter((x) => etDay(x.ts) === day);
  const priorDays = [...new Set(rows.filter((x) => etDay(x.ts) < day).map((x) => etDay(x.ts)))].slice(-BASELINE_SESSIONS);

  // skip-reason distribution, digits normalised so templates group
  const norm = (s) => String(s || '').replace(/[\d.$,]+/g, '#').slice(0, 60);
  const skipCounts = (rs) => {
    const c = {};
    for (const x of rs.filter((y) => y.event === 'skip')) c[norm(x.reason || x.why)] = (c[norm(x.reason || x.why)] || 0) + 1;
    return c;
  };
  const todaySkips = skipCounts(todayRows);
  const baseSkips = {};
  for (const d of priorDays) {
    const c = skipCounts(rows.filter((x) => etDay(x.ts) === d));
    for (const [k, v] of Object.entries(c)) (baseSkips[k] = baseSkips[k] || []).push(v);
  }
  // a reason is NEW if it fired today and on none of the baseline days, and
  // VANISHED if it fired on every baseline day and not today — both are the
  // shape that catches a gate silently turning on or off.
  const newReasons = Object.keys(todaySkips).filter((k) => !baseSkips[k]);
  const goneReasons = Object.keys(baseSkips).filter((k) => !todaySkips[k] && baseSkips[k].length === priorDays.length);

  const entries = todayRows.filter((x) => x.event === 'entry').map((e) => ({
    at: etHM(e.ts), symbol: e.symbol, notional: r2(e.notional), p_win: e.p_win,
    tier: e.tier, stop: e.stop, spy_1d: e.spy_1d, vol_ratio: e.vol_ratio,
  }));
  const exits = todayRows.filter((x) => x.event === 'exit').map((x) => ({
    at: etHM(x.ts), symbol: x.symbol, qty: x.qty, exit: x.exit,
    pnl: r2(x.pnl), reason: String(x.reason || '').slice(0, 60),
  }));

  return {
    date: day,
    session_record: today,
    prior_sessions: priorSessions.map((s) => ({
      date: s.date, equity: r2(s.equity), day_pnl: r2(s.day_pnl),
      entries: s.entries, exits: s.exits, stops_fired: s.stops_fired,
      stops_by_price: s.stops_by_price ?? null, max_slots_used: s.max_slots_used,
      family_beta_exposure: s.family_beta_exposure ? s.family_beta_exposure.max_pct : null,
    })),
    entries, exits,
    skip_distribution_today: todaySkips,
    skip_reasons_new_today: newReasons,
    skip_reasons_absent_today: goneReasons,
    counts: {
      total_rows: todayRows.length,
      by_event: todayRows.reduce((c, x) => { c[x.event] = (c[x.event] || 0) + 1; return c; }, {}),
    },
  };
}

function buildPrompt(digest) {
  return [
    'You are reviewing one completed session of an automated intraday trading system.',
    'It trades US equity ETFs, longs only, on a mean-reversion signal, on a PAPER account.',
    '',
    'Your job is to find DISCONTINUITIES: things that changed versus the baseline sessions,',
    'internal contradictions in the numbers, or figures that cannot both be true. You are',
    'not judging whether the trades were good — profit and loss is noise at this sample',
    'size and is not, by itself, a finding.',
    '',
    'Examples of the kind of defect this review exists to catch, all real:',
    '  - a session reporting 0 stop-outs on a day an exit printed at its recorded stop',
    '  - a P&L figure that does not reconcile with the positions that produced it',
    '  - concentration in one family far above every prior session',
    '  - a skip reason that appears or disappears wholesale, implying a gate flipped',
    '  - a metric that moved by an order of magnitude with no matching activity change',
    '',
    'RULES:',
    '  1. Every finding MUST quote a specific number from the data below. A finding',
    '     that cannot cite a figure is not a finding — omit it.',
    '  2. Do not recommend trades, sizing, or strategy changes. You are looking for',
    '     defects in the machine, not opinions about the market.',
    '  3. An unremarkable session is a valid and expected result. Return an empty',
    '     findings array rather than inventing something to say.',
    '  4. Prefer one high-confidence finding to five speculative ones.',
    '',
    'DATA:',
    JSON.stringify(digest, null, 1),
    '',
    'Reply with strict JSON, no prose:',
    '{"summary": "<one sentence on the session>", "findings": [',
    '  {"severity": "high|medium|low", "category": "<short slug>",',
    '   "claim": "<what is wrong, one sentence>",',
    '   "evidence": "<the numbers that show it>",',
    '   "check": "<the one thing a human should look at to confirm>"}]}',
  ].join('\n');
}

function parseResponse(text) {
  try {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return { summary: null, findings: [], degraded: true, reason: 'unparseable' };
    const j = JSON.parse(m[0]);
    const findings = Array.isArray(j.findings) ? j.findings.slice(0, 12).map((f) => ({
      severity: ['high', 'medium', 'low'].includes(String(f.severity)) ? f.severity : 'low',
      category: String(f.category || 'unspecified').slice(0, 40),
      claim: String(f.claim || '').slice(0, 400),
      evidence: String(f.evidence || '').slice(0, 400),
      check: String(f.check || '').slice(0, 300),
    })).filter((f) => f.claim) : [];
    return { summary: String(j.summary || '').slice(0, 300), findings, degraded: false };
  } catch (_e) {
    return { summary: null, findings: [], degraded: true, reason: 'parse error' };
  }
}

function journal(row) {
  try { fs.appendFileSync(logFile(), JSON.stringify(row) + '\n'); } catch (_e) { /* never throws */ }
}

/**
 * Review one session. Returns { summary, findings[], degraded } or a degraded
 * shell — NEVER throws, and never returns anything that could be mistaken for a
 * trading instruction.
 */
async function review({ ledgerText, day, fetchImpl } = {}) {
  const t0 = Date.now();
  const bail = (reason) => {
    const out = { summary: null, findings: [], degraded: true, reason, latency_ms: Date.now() - t0 };
    journal({ ts: new Date().toISOString(), date: day, model: MODEL, ...out });
    return out;
  };
  if (!enabled()) return bail('disabled');
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return bail('no api key');
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return bail('no fetch');

  let digest;
  try { digest = buildDigest(ledgerText, day); } catch (e) { return bail('digest failed: ' + e.message); }
  if (!digest.session_record && !digest.entries.length && !digest.exits.length) return bail('no activity for ' + day);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs());
  let out;
  try {
    const res = await doFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,                       // caps thinking + response together on Opus 5
        output_config: { effort: 'medium' },    // bounded: this is pattern-matching, not deep reasoning
        messages: [{ role: 'user', content: buildPrompt(digest) }],
      }),
    });
    if (!res || !res.ok) { out = { summary: null, findings: [], degraded: true, reason: `http ${res && res.status}` }; }
    else {
      const j = await res.json();
      if (j && j.stop_reason === 'refusal') out = { summary: null, findings: [], degraded: true, reason: 'refusal' };
      else {
        const text = (j && Array.isArray(j.content) ? j.content : [])
          .filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
        out = parseResponse(text);
        out.usage = j && j.usage ? { in: j.usage.input_tokens, out: j.usage.output_tokens } : null;
      }
    }
  } catch (e) {
    out = { summary: null, findings: [], degraded: true, reason: ac.signal.aborted ? `timeout ${timeoutMs()}ms` : String(e && e.message).slice(0, 80) };
  } finally { clearTimeout(timer); }

  out.latency_ms = Date.now() - t0;
  journal({ ts: new Date().toISOString(), date: day, model: MODEL, ...out });
  return out;
}

module.exports = { review, buildDigest, buildPrompt, parseResponse, enabled, MODEL, logFile };
