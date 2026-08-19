'use strict';
/**
 * veto_arbiter_replay.js — can a model decide WHEN a gate should not have fired?
 *
 * ⚠ THE FIRST RUN OF THIS HARNESS WAS VOID. Read this before believing its
 * output. On 2026-08-19 it returned a clean, significant, entirely wrong answer:
 * Haiku's overturn set averaged -0.942 edge against a -0.318 pool, Sonnet's
 * -0.961 at p=0.0299. Written up as-is that reads "AI veto-arbitration actively
 * destroys value".
 *
 * It measured nothing of the kind. Every one of Sonnet's ten overturns gave the
 * same reason — "MACD histogram is positive, not negative/deepening; rule
 * doesn't apply" — and Haiku independently overturned the same ten. They were
 * not judging trades. They were reporting that the data contradicted the rule,
 * and they were right: isFallingKnife() runs on 5m closes, while context()
 * below rebuilt MACD from prior-session 5m closes spliced onto today's 15m bars.
 * Eleven rows got a wrong sign; the models flagged ten of them.
 *
 * Reconstruction cannot close that gap. Replaying the gate's own predicate
 * against the stored bar corpus reproduces `histogram < 0` on 91% of known fires
 * but `deepening` — a difference between two adjacent MACD reads — on only 72%,
 * because the engine decides on live Yahoo bars fetched at scan time and a
 * one-bar offset flips the term. Overall the predicate reproduces on 70%.
 *
 * SO THIS TEST IS NOT DECIDABLE UNTIL THE ENGINE LOGS WHAT IT DECIDED ON.
 * Stamp ibs / macd_hist / spy_tape / regime into the skip row in auto-trader,
 * let a few sessions accumulate, feed those recorded features in place of
 * context(), and the question becomes answerable. Until then this file is a
 * harness with a known-bad input, kept because the harness itself is sound —
 * the prompt, the scoring, and the permutation test all survived review; only
 * the reconstruction did not.
 *
 * A cheap regression guard for whoever picks this up: replay the gate's
 * predicate on your reconstructed series and confirm it reproduces the recorded
 * decision. If it does not reproduce at ~100%, the model is being asked about a
 * situation that never happened.
 *
 * The measurement half (experiments/veto_replay.js) established the conditions that make
 * this a fair test:
 *   - the yardstick has resolution: rho(edge, real % return) = 0.505 on the 81
 *     trades whose outcome we know
 *   - there is headroom: 95/171 blocked candidates scored better than the
 *     average trade the engine actually took; a perfect selector moves the pool
 *     from -0.318 to +0.279
 *   - the engine cannot already do this: rho(p_win, edge) = -0.186, i.e. its
 *     own confidence score is mildly ANTI-predictive of the opportunity
 *
 * So the question is narrow and answerable: shown the same situation the engine
 * saw, plus which gate fired, can the model pick the blocks worth overturning?
 *
 * FAIRNESS CONSTRAINTS:
 *   - context is rebuilt from bars AT the veto instant only. Nothing after it.
 *   - the prompt does not hint that gates are suspected of being too strict.
 *     Naming a failure mode makes the model hunt for it (measured on the Haiku
 *     analyst: 25/25 convictions collapsed below 45 when the prompt named the
 *     failure it was looking for).
 *   - the model never sees the outcome, the P&L, or the other candidates.
 *   - scored against a SHUFFLE of its own verdicts, so "it overturned a lot and
 *     the pool happened to be fine" cannot pass as skill.
 *
 *   ARBITER=1 node experiments/veto_arbiter_replay.js          # ~171 Haiku calls, a few cents
 *   LIMIT=30 ARBITER=1 node experiments/veto_arbiter_replay.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.LANTERN_ROOT || path.join(__dirname, '..');
const BARS = path.join(ROOT, 'data/lantern-garage/trading/bars');
const CANDIDATES = process.env.VETO_CANDIDATES || path.join(os.tmpdir(), 'veto-candidates.json');
const RESULTS = process.env.ARBITER_RESULTS || path.join(os.tmpdir(), 'veto-arbiter-results.json');
const MODEL = process.env.ARBITER_MODEL || 'claude-haiku-4-5-20251001';
const LIMIT = Number(process.env.LIMIT) || 0;
const CONC = Number(process.env.CONC) || 4;
const TAKEN_BASELINE = -0.068;          // mean edge of trades the engine took

// key from the trader's own env file
let KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  try {
    const m = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').match(/^ANTHROPIC_API_KEY=(.+)$/m);
    if (m) KEY = m[1].trim();
  } catch (_e) { /* handled below */ }
}

const scan = require(path.join(ROOT, 'apps/lantern-garage/lib/signal-engine/scan'));
const dl = require(path.join(ROOT, 'apps/lantern-garage/lib/direction-lock'));
const { macd } = require(path.join(ROOT, 'apps/lantern-garage/lib/signal-engine/indicators'));

const eD = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const _bars = {};
function bars5(sym) {
  if (_bars[sym]) return _bars[sym];
  try {
    _bars[sym] = fs.readFileSync(path.join(BARS, sym + '-5m.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean)
      .map((b) => ({ timestamp: b.t || b.ts, open: +b.o, high: +b.h, low: +b.l, close: +b.c, volume: +b.v }))
      .filter((b) => b.timestamp && b.close > 0)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  } catch (e) { _bars[sym] = []; }
  return _bars[sym];
}
/** 5m -> 15m, only bars at or before the veto instant. No look-ahead. */
function upTo(sym, day, atMs) {
  const s = bars5(sym).filter((b) => eD(b.timestamp) === day && Date.parse(b.timestamp) <= atMs);
  const out = [];
  for (let i = 0; i < s.length; i += 3) {
    const g = s.slice(i, i + 3);
    if (!g.length) break;
    out.push({ timestamp: g[0].timestamp, open: g[0].open,
      high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)),
      close: g[g.length - 1].close });
  }
  return out;
}

// Each gate stated as its RULE, neutrally. No editorialising about whether the
// rule is good — that is what the model is being asked to judge.
const GATE_RULE = {
  falling_knife: 'the signal fires while MACD histogram is negative and deepening, so the engine waits for momentum to turn before buying a washed-out instrument',
  persistence: 'the engine requires N consecutive scans agreeing on the direction before acting, to avoid single-scan noise',
  cooldown: 'this symbol traded recently and the engine enforces a quiet period before re-entering it',
  post_stop_cooldown: 'this symbol stopped out earlier today and the engine blocks re-entry for a fixed window',
  sup_entry: 'the engine only buys within a set distance of an identified support zone; this signal is further above support than that',
  direction_conflict: 'the book already holds exposure that this position would offset, so the engine declines to hold both sides',
  concurrent_cap: 'the maximum number of simultaneous positions is already open',
  slot_reserve: 'the last open slot is reserved for signals above a confidence threshold and this one is below it',
};

function buildPrompt(c, ctx) {
  const f = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? 'n/a' : Number(v).toFixed(d));
  const inv = Number(ctx.sign) < 0
    ? '  NOTE: inverse instrument — a long here is economically a short of ' + (ctx.family || 'its underlying') + '\n' : '';
  return [
    'An automated intraday system trades US equity ETFs, long only, on a mean-reversion',
    'signal: it buys instruments that have washed out within the session and sells the bounce.',
    '',
    'A buy signal fired on ' + c.sym + ' at ' + c.hm + ' ET and a rule prevented it from being taken.',
    '',
    'THE SITUATION AT THAT MOMENT:',
    '  price ' + f(ctx.price) + (Number(ctx.leverage) > 1 ? '   (' + ctx.leverage + 'x leveraged)' : ''),
    inv +
    '  session IBS ' + f(ctx.ibs, 3) + '  (0 = at the session low, the mean-reversion trigger)',
    '  ' + c.sym + ' session move ' + f(ctx.own_tape) + '%',
    '  underlying ' + (ctx.underlying || 'n/a') + ' session move ' + f(ctx.underlying_tape) + '%',
    '  SPY session move ' + f(ctx.spy_tape) + '%   SPY last 30 min ' + f(ctx.spy_mom30) + '%',
    '  market regime ' + (ctx.regime || 'unknown') + '   MACD histogram ' + f(ctx.macd_hist, 4),
    '  the system rated this signal p_win ' + f(c.p_win, 3),
    '  positions currently open: ' + c.open_at_fire + ' of ' + c.cap,
    '',
    'THE RULE THAT BLOCKED IT:',
    '  ' + (GATE_RULE[c.gate] || c.reason),
    '',
    'Judge whether that rule should apply to THIS specific setup, or whether this is',
    'a case the rule was not built for. Consider only the evidence above.',
    '',
    'Reply with strict JSON, no prose:',
    '{"verdict":"uphold"|"overturn","confidence":<integer 0-100>,"reason":"<max 14 words>"}',
    'confidence is how sure you are of your verdict, not how attractive the trade is.',
  ].join('\n');
}

function context(c) {
  const day = c.day, at = c.at;
  const sign = dl.instrumentSign(c.sym);
  const proxy = dl.underlyingProxy(c.sym);
  const own15 = upTo(c.sym, day, at);
  const u15 = proxy && proxy !== c.sym ? upTo(proxy, day, at) : null;
  const spy15 = upTo('SPY', day, at);

  const prior = bars5(c.sym).filter((b) => eD(b.timestamp) < day && Date.parse(b.timestamp) > at - 5 * 864e5).map((b) => b.close);
  const closes = prior.concat(own15.map((b) => b.close));
  let mh = null;
  try { const m = macd(closes); mh = m && Number.isFinite(m.histogram) ? m.histogram : null; } catch (_e) { /* n/a */ }

  const spyTape = spy15.length ? scan.sessionDrawdownPct(spy15) : null;
  return {
    price: own15.length ? own15[own15.length - 1].close : null,
    ibs: own15.length ? scan.sessionIbs(own15) : null,
    own_tape: own15.length ? scan.sessionDrawdownPct(own15) : null,
    underlying: proxy, underlying_tape: u15 && u15.length ? scan.sessionDrawdownPct(u15) : null,
    spy_tape: spyTape,
    spy_mom30: spy15.length >= 3 ? ((spy15[spy15.length - 1].close - spy15[spy15.length - 3].close) / spy15[spy15.length - 3].close) * 100 : null,
    regime: spyTape == null ? null : (spyTape > 0.25 ? 'BULLISH' : spyTape < -0.25 ? 'BEARISH' : 'NEUTRAL'),
    macd_hist: mh, sign: sign.sign, family: sign.family, leverage: dl.leverageOf(c.sym),
  };
}

async function ask(prompt) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 150, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) return { err: 'http ' + res.status };
    const j = await res.json();
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { err: 'unparseable' };
    const o = JSON.parse(m[0]);
    const v = String(o.verdict || '').toLowerCase();
    if (v !== 'uphold' && v !== 'overturn') return { err: 'bad verdict' };
    return { verdict: v, confidence: Math.max(0, Math.min(100, Number(o.confidence) || 0)),
      reason: String(o.reason || '').slice(0, 80), usage: j.usage };
  } catch (e) {
    return { err: ac.signal.aborted ? 'timeout' : String(e.message).slice(0, 50) };
  } finally { clearTimeout(timer); }
}

const mean = (a, f) => (a.length ? a.reduce((t, x) => t + f(x), 0) / a.length : NaN);

(async () => {
  let cands = JSON.parse(fs.readFileSync(CANDIDATES, 'utf8')).filter((c) => c.m);
  if (LIMIT) cands = cands.slice(0, LIMIT);
  console.log('arbiter: ' + MODEL + ' over ' + cands.length + ' blocked signals');
  console.log('pool mean edge ' + mean(cands, (x) => x.m.edge).toFixed(3) +
    ' | taken-trade baseline ' + TAKEN_BASELINE + ' | perfect-selector ceiling +0.279\n');

  if (process.env.ARBITER !== '1') { console.log('DRY RUN (set ARBITER=1 to spend calls)'); console.log(buildPrompt(cands[0], context(cands[0]))); return; }
  if (!KEY) { console.log('no ANTHROPIC_API_KEY found'); return; }

  const out = [];
  let tokIn = 0, tokOut = 0, errs = 0;
  for (let i = 0; i < cands.length; i += CONC) {
    const batch = cands.slice(i, i + CONC);
    const rs = await Promise.all(batch.map((c) => ask(buildPrompt(c, context(c)))));
    batch.forEach((c, k) => {
      const r = rs[k];
      if (r.err) { errs++; return; }
      if (r.usage) { tokIn += r.usage.input_tokens || 0; tokOut += r.usage.output_tokens || 0; }
      out.push({ ...c, verdict: r.verdict, confidence: r.confidence, why: r.reason });
    });
    process.stdout.write('\r  scored ' + out.length + '/' + cands.length + (errs ? '  (' + errs + ' failed)' : '') + '   ');
  }
  console.log('\n');

  const over = out.filter((x) => x.verdict === 'overturn');
  const up = out.filter((x) => x.verdict === 'uphold');
  console.log('VERDICTS: overturn ' + over.length + ' / uphold ' + up.length + ' of ' + out.length);
  if (!over.length || !up.length) { console.log('  degenerate — it answered one way for everything; no selection to measure.'); return; }

  console.log('\nDID IT SELECT?');
  console.log('  set               n     mean edge');
  console.log('  overturned '.padEnd(18) + String(over.length).padStart(4) + mean(over, (x) => x.m.edge).toFixed(3).padStart(11));
  console.log('  upheld     '.padEnd(18) + String(up.length).padStart(4) + mean(up, (x) => x.m.edge).toFixed(3).padStart(11));
  console.log('  whole pool '.padEnd(18) + String(out.length).padStart(4) + mean(out, (x) => x.m.edge).toFixed(3).padStart(11));
  console.log('  taken trades (live baseline)      ' + TAKEN_BASELINE.toFixed(3));

  // permutation: shuffle the verdicts, keep the counts
  const obs = mean(over, (x) => x.m.edge) - mean(up, (x) => x.m.edge);
  const edges = out.map((x) => x.m.edge);
  let s = 987654321;
  const rnd = () => (s = (1103515245 * s + 12345) % 2147483648) / 2147483648;
  let ge = 0;
  const ITER = 20000;
  for (let it = 0; it < ITER; it++) {
    const p = [...edges];
    for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    const d = mean(p.slice(0, over.length).map((v) => ({ v })), (x) => x.v) - mean(p.slice(over.length).map((v) => ({ v })), (x) => x.v);
    if (Math.abs(d) >= Math.abs(obs)) ge++;
  }
  const pv = ge / ITER;
  console.log('\n  separation (overturn - uphold) = ' + obs.toFixed(3) + '   permutation p = ' + pv.toFixed(4));

  const rk = (a, f) => { const q = [...a].sort((x, y) => f(x) - f(y)); const m = new Map(); q.forEach((v, i) => m.set(v, i + 1)); return m; };
  const r1 = rk(out, (x) => (x.verdict === 'overturn' ? 1 : -1) * x.confidence), r2 = rk(out, (x) => x.m.edge);
  let d2 = 0; for (const x of out) d2 += Math.pow(r1.get(x) - r2.get(x), 2);
  const rho = 1 - (6 * d2) / (out.length * (out.length * out.length - 1));
  console.log('  rho(signed confidence, edge) = ' + rho.toFixed(3));

  console.log('\n  VERDICT: ' + (
    pv < 0.05 && mean(over, (x) => x.m.edge) > TAKEN_BASELINE
      ? 'THE ARBITER SELECTS. Its overturn set beats both the pool and the live baseline.'
      : pv < 0.05 ? 'It separates the pool, but its picks do not beat the trades already being taken.'
      : 'NO SELECTION. Indistinguishable from overturning at random.'));

  console.log('\n  by gate:  gate                over/total   mean edge of overturned');
  for (const g of [...new Set(out.map((x) => x.gate))]) {
    const a = out.filter((x) => x.gate === g), o = a.filter((x) => x.verdict === 'overturn');
    console.log('            ' + g.padEnd(20) + (o.length + '/' + a.length).padStart(8) +
      (o.length ? mean(o, (x) => x.m.edge).toFixed(3).padStart(14) : '             —'));
  }

  const cost = (tokIn * 1 + tokOut * 5) / 1e6;
  console.log('\n  ' + out.length + ' calls, ' + tokIn + ' in / ' + tokOut + ' out, ~$' + cost.toFixed(3) + (errs ? '  (' + errs + ' failed)' : ''));
  fs.writeFileSync(RESULTS, JSON.stringify(out, null, 1));
  console.log('  wrote ' + RESULTS);
})();
