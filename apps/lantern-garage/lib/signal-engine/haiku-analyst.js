'use strict';
/**
 * haiku-analyst.js — the reasoning layer the trader lost on 2026-07-03 (#3355).
 *
 * PR #1959 ported "Riley" (deterministic TA) from the 9,449-line Python
 * agents.py to Node and deleted everything else, including the Grok/Claude
 * agent layer. `convergence-ev.js` still reserves 9% of the p_win weight for
 * `claude_conf` — its comment reads "was a gate" — but nothing has SET that
 * field since, so it has defaulted to a neutral 50 and contributed exactly
 * nothing for six weeks. Every gate added since compensated for the missing
 * judgement with another hard rule; there are now 34 skip sites in auto-trader.
 *
 * This restores the slot, and ONLY the slot.
 *
 * WHAT IT CANNOT DO, structurally:
 *   - It cannot decide alone. MEASURED: claude_conf 50->0 moves p_win a full
 *     9.00pp, which near P_MIN (0.45) is enough to flip a verdict by itself — so
 *     the raw weight is NOT self-limiting, and an early draft of this file
 *     claimed a 4.5pp bound that did not exist. scan.js therefore caps the
 *     applied swing at TRADER_HAIKU_MAX_SWING_PP (4.5 by default) at the
 *     integration point, where the guarantee does not depend on another module's
 *     internal weighting.
 *   - It cannot force a trade. Every existing gate still runs afterwards.
 *   - It cannot stall the loop. One call, hard timeout, no retries; on ANY
 *     failure it returns 50, which reproduces today's behaviour exactly.
 *
 * DEFAULT OFF (TRADER_HAIKU_ANALYST=1) so it can be replayed against recorded
 * fires before it touches a live decision. Every call is journalled with its
 * conviction, latency and the situation it judged, so "does the 9% earn its
 * place?" is answerable from data rather than opinion.
 *
 * MEASURED 2026-08-19 — IT DOES NOT. STAY OFF (#3358).
 * 25 recorded round trips, context reconstructed from the 5m bar cache at each
 * fire instant. (Ledger rows alone leave IBS/MACD/regime null, and the first
 * replay on those was uninterpretable: every conviction landed 35-42 because the
 * model was correctly answering "I cannot see enough to have a view". Filling the
 * context 5.3/6 is what made the test decidable.)
 *     conviction > 55   n=4    50% WR   -$2,184
 *     45-55             n=3    33% WR   -$1,987
 *     conviction < 45   n=18   61% WR   +$7,998
 *     Spearman rho(conviction, pnl) = 0.007
 * Re-run with an independently worded, debiased prompt: rho = 0.089. Two prompts,
 * both indistinguishable from chance. On the two most consequential trades in the
 * sample it was inverted: 58 on the SOXL that lost $2,433, and 42 — below neutral
 * — on the SOXS that made $6,710.
 *
 * n=25 is far too small to call it ANTI-predictive; the honest claim is NO
 * MEASURABLE SIGNAL. The decision rule set before the test was "if rho is near
 * zero the slot earns nothing and stays neutral", and that is the outcome. The
 * code stays because the harness is reusable and the question is worth re-asking
 * with more data or a different model — not because it is expected to be enabled.
 * Total cost of finding out: about five cents.
 */
const fs = require('fs');
const path = require('path');

const MODEL = process.env.TRADER_HAIKU_MODEL || 'claude-haiku-4-5-20251001';
const NEUTRAL = 50;

function enabled() { return process.env.TRADER_HAIKU_ANALYST === '1'; }
function timeoutMs() { return Number(process.env.TRADER_HAIKU_TIMEOUT_MS) || 4000; }
function logFile() {
  return process.env.TRADER_HAIKU_LOG
    || path.join(__dirname, '..', '..', '..', '..', 'data', 'lantern-garage', 'trading', 'haiku-analyst.jsonl');
}

/**
 * The evidence the analyst may see. Deliberately the SAME facts the
 * deterministic layer already scored — this is a second read of one situation,
 * not a second data source. Anything it cannot verify (no live feed, no order
 * book) is withheld so it cannot invent an edge from it.
 */
function buildPrompt(sig) {
  const f = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? 'n/a' : Number(v).toFixed(d));
  const lev = Number(sig.leverage) > 1 ? ` (${sig.leverage}x leveraged)` : '';
  const inv = Number(sig.sign) < 0
    ? ` — INVERSE: a long here is economically a SHORT of ${sig.family || 'its underlying'}`
    : '';
  return [
    `Instrument: ${sig.symbol}${lev}${inv}`,
    `Proposed: LONG at ${f(sig.price)}   stop ${f(sig.stop)}   target ${f(sig.target)}`,
    `Deterministic read: p_win ${f(sig.p_win, 3)}, EV ${f(sig.ev_r, 2)}R, direction ${sig.direction}`,
    '',
    'Evidence already scored:',
    `  session IBS ${f(sig.ibs, 3)} (0 = at session low, the mean-reversion trigger)`,
    `  underlying ${sig.underlying || sig.symbol} session move today ${f(sig.underlying_tape)}%`,
    `  SPY today ${f(sig.spy_tape)}%   30-min momentum ${f(sig.spy_mom30)}%`,
    `  market regime ${sig.regime || 'unknown'}   volume ratio ${f(sig.volume_ratio)}`,
    `  MACD histogram ${f(sig.macd_hist, 4)}   news sentiment ${f(sig.news_sentiment, 2)}`,
    `  sector trend ${f(sig.sector_trend, 3)}   at S/R zone: ${sig.in_zone ? 'yes' : 'no'}`,
    `  time ${sig.et_time || 'n/a'} ET`,
    '',
    'The strategy is intraday mean-reversion on US equity ETFs, longs only.',
    'It buys instruments that have washed out within the session and sells the bounce.',
    // NAMING THE FAILURE MODE BIASED IT (#3358). This block used to read "its
    // known failure mode is buying continuation instead of reversion" and asked
    // the model to judge "reversion candidate or falling knife". It then hunted
    // that one failure across every setup and never used the upper half of the
    // scale: 25 of 25 convictions came back below 45, with near-identical
    // reasoning ("IBS extreme but MACD negative"). A washout co-occurs with
    // negative momentum by construction, so that framing condemns the strategy's
    // own core signal. Asking symmetrically restored the range to 38-62 — though
    // the correlation with outcome stayed ~0 either way; see the header.
    '',
    'The deterministic score already accounts for this evidence. Your job is only',
    'to say whether THIS setup is better or worse than that score suggests. Some',
    'setups are better than the numbers imply; some are worse; most are neither.',
    'Use the full range. If nothing distinguishes this setup, answer exactly 50.',
    'Do not consider position sizing or portfolio risk — other layers own those.',
    '',
    'Reply with strict JSON, no prose: {"conviction": <integer 0-100>, "reason": "<max 14 words>"}',
    'conviction 50 = no view. >50 = better than the deterministic read. <50 = worse.',
  ].join('\n');
}

/** Parse a model reply into a bounded conviction. Never throws. */
function parseResponse(text) {
  try {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return { conviction: NEUTRAL, reason: 'unparseable', degraded: true };
    const j = JSON.parse(m[0]);
    const c = Number(j.conviction);
    if (!Number.isFinite(c)) return { conviction: NEUTRAL, reason: 'no conviction field', degraded: true };
    return {
      conviction: Math.max(0, Math.min(100, Math.round(c))),
      reason: String(j.reason || '').slice(0, 120),
      degraded: false,
    };
  } catch (_e) {
    return { conviction: NEUTRAL, reason: 'parse error', degraded: true };
  }
}

function journal(row) {
  try {
    fs.appendFileSync(logFile(), JSON.stringify(row) + '\n');
  } catch (_e) { /* journalling must never affect a trade */ }
}

/**
 * One bounded call. Returns { conviction, reason, degraded, latency_ms }.
 * NEVER throws; never returns anything but a number in [0,100].
 * `fetchImpl` is injectable so tests and the offline replay drive it without network.
 */
async function analyze(sig, { fetchImpl } = {}) {
  const t0 = Date.now();
  const neutral = (reason) => ({ conviction: NEUTRAL, reason, degraded: true, latency_ms: Date.now() - t0 });
  if (!enabled()) return neutral('disabled');
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return neutral('no api key');

  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return neutral('no fetch');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs());
  let out;
  try {
    const res = await doFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 120,
        messages: [{ role: 'user', content: buildPrompt(sig) }],
      }),
    });
    if (!res || !res.ok) {
      out = neutral(`http ${res && res.status}`);
    } else {
      const j = await res.json();
      const text = (j && Array.isArray(j.content) && j.content[0] && j.content[0].text) || '';
      out = { ...parseResponse(text), latency_ms: Date.now() - t0 };
    }
  } catch (e) {
    out = neutral(ac.signal.aborted ? `timeout ${timeoutMs()}ms` : String(e && e.message).slice(0, 60));
  } finally {
    clearTimeout(timer);
  }

  journal({
    ts: new Date().toISOString(), symbol: sig.symbol, model: MODEL,
    conviction: out.conviction, reason: out.reason, degraded: !!out.degraded,
    latency_ms: out.latency_ms,
    // the situation it judged, so the counterfactual is reconstructable later
    p_win_before: sig.p_win == null ? null : sig.p_win,
    ibs: sig.ibs == null ? null : sig.ibs,
    underlying_tape: sig.underlying_tape == null ? null : sig.underlying_tape,
    spy_tape: sig.spy_tape == null ? null : sig.spy_tape,
    et_time: sig.et_time || null,
    sign: sig.sign == null ? 1 : sig.sign,
    leverage: sig.leverage == null ? 1 : sig.leverage,
  });
  return out;
}

module.exports = { analyze, buildPrompt, parseResponse, enabled, MODEL, NEUTRAL, logFile };
