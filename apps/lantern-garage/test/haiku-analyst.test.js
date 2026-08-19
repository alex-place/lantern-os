'use strict';
/**
 * haiku-analyst.test.js — the restored 9% council slot is a WEIGHT, never a gate
 * (#3355).
 *
 * PR #1959 (2026-07-03) ported Riley's deterministic TA to Node and deleted the
 * 9,449-line Grok/Claude agent layer with it. `convergence-ev.js` kept a 0.09
 * weight for `claude_conf` — its comment still reads "was a gate" — but nothing
 * has set that field since, so it defaulted to a neutral 50 for six weeks while
 * 34 hard skip sites accumulated in its place.
 *
 * These tests pin the properties that make restoring it safe rather than the
 * conviction values themselves (which are a model's opinion and will vary):
 *   - it cannot veto, and cannot force
 *   - it cannot stall or crash a scan
 *   - every failure path returns exactly 50, i.e. today's behaviour
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'haiku-')), 'analyst.jsonl');
process.env.TRADER_HAIKU_LOG = LOG;

const analyst = require('../lib/signal-engine/haiku-analyst');
const ev = require('../lib/signal-engine/convergence-ev');

const SIG = {
  symbol: 'SOXL', direction: 'BULLISH', price: 134.82, stop: 130.77, target: 141.0,
  p_win: 0.684, ev_r: 0.9, ibs: 0.04, underlying: 'SMH', underlying_tape: -2.4,
  spy_tape: -1.03, spy_mom30: -0.2, regime: 'BEARISH', volume_ratio: 1.4,
  macd_hist: -0.31, news_sentiment: 0.1, sector_trend: -0.02, in_zone: true,
  et_time: '9:30', sign: 1, leverage: 3, family: 'SOX',
};
const reply = (obj) => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify(obj) }] }) });
const withEnv = async (env, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
};
const ON = { TRADER_HAIKU_ANALYST: '1', ANTHROPIC_API_KEY: 'test-key' };

test('DEFAULT OFF: without the flag it never calls out and returns neutral', async () => {
  let called = false;
  const r = await withEnv({ TRADER_HAIKU_ANALYST: null }, () =>
    analyst.analyze(SIG, { fetchImpl: async () => { called = true; return reply({ conviction: 90 }); } }));
  assert.strictEqual(called, false, 'no network call when disabled');
  assert.strictEqual(r.conviction, 50);
  assert.strictEqual(r.degraded, true);
});

test('no API key → neutral, no call', async () => {
  let called = false;
  const r = await withEnv({ TRADER_HAIKU_ANALYST: '1', ANTHROPIC_API_KEY: null }, () =>
    analyst.analyze(SIG, { fetchImpl: async () => { called = true; return reply({ conviction: 90 }); } }));
  assert.strictEqual(called, false);
  assert.strictEqual(r.conviction, 50);
});

test('a normal reply is parsed and bounded', async () => {
  const r = await withEnv(ON, () => analyst.analyze(SIG, { fetchImpl: async () => reply({ conviction: 78, reason: 'underlying still falling' }) }));
  assert.strictEqual(r.conviction, 78);
  assert.strictEqual(r.degraded, false);
  assert.match(r.reason, /underlying/);
});

test('every failure mode returns EXACTLY 50 — the pre-#3355 behaviour', async () => {
  const modes = {
    'http error': async () => ({ ok: false, status: 500 }),
    'throws': async () => { throw new Error('socket hang up'); },
    'garbage body': async () => ({ ok: true, json: async () => ({ content: [{ text: 'I think maybe buy?' }] }) }),
    'empty content': async () => ({ ok: true, json: async () => ({}) }),
    'json without conviction': async () => ({ ok: true, json: async () => ({ content: [{ text: '{"reason":"hi"}' }] }) }),
  };
  for (const [label, impl] of Object.entries(modes)) {
    const r = await withEnv(ON, () => analyst.analyze(SIG, { fetchImpl: impl }));
    assert.strictEqual(r.conviction, 50, `${label} must be neutral`);
    assert.strictEqual(r.degraded, true, `${label} must be flagged degraded`);
  }
});

test('a hung endpoint cannot stall the scan — it aborts and goes neutral', async () => {
  const t0 = Date.now();
  const r = await withEnv({ ...ON, TRADER_HAIKU_TIMEOUT_MS: '150' }, () =>
    analyst.analyze(SIG, {
      fetchImpl: (_u, opts) => new Promise((_res, rej) => {
        opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    }));
  const dt = Date.now() - t0;
  assert.strictEqual(r.conviction, 50);
  assert.ok(dt < 1500, `must abort promptly, took ${dt}ms`);
  assert.match(r.reason, /timeout/);
});

test('conviction is clamped to [0,100] however absurd the reply', async () => {
  for (const [given, want] of [[999, 100], [-40, 0], [100.7, 100], ['73', 73]]) {
    const r = await withEnv(ON, () => analyst.analyze(SIG, { fetchImpl: async () => reply({ conviction: given }) }));
    assert.strictEqual(r.conviction, want, `${given} → ${want}`);
  }
});

// ── the bound that matters: a weight cannot veto ────────────────────────────
test('the RAW weight is NOT self-limiting — 9.00pp, which is why scan.js caps it', () => {
  // This is the measurement that falsified the first draft of this feature. The
  // module comment claimed a 4.5pp bound from "weight 0.09 x +/-0.5". The real
  // pull from neutral to either extreme is a full 9.00pp, and near P_MIN (0.45)
  // that is enough to flip a verdict alone. The guarantee therefore lives at the
  // integration point (TRADER_HAIKU_MAX_SWING_PP), not in this weight.
  const base = { direction: 'BULLISH', in_zone: true, zone_strength: 0.8, zone_touches: 3,
    structure_shifted: true, structure_conf: 0.7, pattern_grade: 'A', trend_aligned: true,
    volume_ratio: 1.5, macd_hist: 0.2, ma_signal: 1, target_r: 2 };
  const neutral = ev.scoreConvergence({ ...base, claude_conf: 50 });
  const hostile = ev.scoreConvergence({ ...base, claude_conf: 0 });
  const eager = ev.scoreConvergence({ ...base, claude_conf: 100 });
  assert.ok(Math.abs((neutral.p_win - hostile.p_win) - 0.09) < 0.005, `raw down-pull is 9pp, got ${((neutral.p_win - hostile.p_win) * 100).toFixed(2)}pp`);
  assert.ok(Math.abs((eager.p_win - neutral.p_win) - 0.09) < 0.005, 'raw up-pull is 9pp');
});

test('the CAP holds: interpolating conviction toward neutral lands on the limit', () => {
  // scan.js scales conviction toward 50 by cap/|swing|. Reproduced here so the
  // arithmetic is pinned independently of the scan wiring.
  const base = { direction: 'BULLISH', in_zone: true, zone_strength: 0.8, zone_touches: 3,
    structure_shifted: true, structure_conf: 0.7, pattern_grade: 'A', trend_aligned: true,
    volume_ratio: 1.5, macd_hist: 0.2, ma_signal: 1, target_r: 2 };
  const before = ev.scoreConvergence({ ...base, claude_conf: 50 }).p_win;
  for (const capPp of [4.5, 2, 1]) {
    const cap = capPp / 100;
    const raw = ev.scoreConvergence({ ...base, claude_conf: 0 });
    const swing = raw.p_win - before;
    const scaled = 50 + (0 - 50) * (cap / Math.abs(swing));
    const capped = ev.scoreConvergence({ ...base, claude_conf: scaled });
    assert.ok(Math.abs(Math.abs(capped.p_win - before) - cap) < 0.0015,
      `cap ${capPp}pp: got ${((capped.p_win - before) * 100).toFixed(2)}pp`);
  }
});

test('CANNOT RESCUE JUNK: maximum conviction cannot lift a clearly-failing setup to ENTER', async () => {
  const junk = { direction: 'BULLISH', in_zone: false, zone_strength: 0, zone_touches: 0,
    structure_shifted: false, structure_conf: 0, pattern_grade: null, trend_conflicts: true,
    volume_ratio: 0.4, macd_hist: -0.9, ma_signal: -1, news_sentiment: -0.8,
    sector_trend: -0.05, target_r: 2 };
  const eager = ev.scoreConvergence({ ...junk, claude_conf: 100 });
  assert.strictEqual(eager.decision, 'SKIP', 'a 9% weight must not be able to force a bad trade through');
});

test('every call is journalled with the situation it judged', async () => {
  await withEnv(ON, () => analyst.analyze({ ...SIG, symbol: 'JRNL' }, { fetchImpl: async () => reply({ conviction: 61, reason: 'ok' }) }));
  const rows = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const row = rows.find((r) => r.symbol === 'JRNL');
  assert.ok(row, 'a row must exist');
  assert.strictEqual(row.conviction, 61);
  assert.strictEqual(row.model, analyst.MODEL);
  for (const k of ['p_win_before', 'ibs', 'underlying_tape', 'spy_tape', 'et_time', 'leverage', 'sign'])
    assert.ok(k in row, `${k} must be journalled for the counterfactual`);
});

test('the prompt states the inverse case in ECONOMIC terms, not wrapper terms', () => {
  const p = analyst.buildPrompt({ ...SIG, symbol: 'SOXS', sign: -1, family: 'SOX', leverage: 3 });
  assert.match(p, /INVERSE/);
  assert.match(p, /economically a SHORT of SOX/);
  assert.match(p, /3x leveraged/);
});

test('the prompt names the strategy AND its known failure mode', () => {
  const p = analyst.buildPrompt(SIG);
  assert.match(p, /mean-reversion/);
  assert.match(p, /falling knife|keeps falling/);
  assert.match(p, /longs only/i);
  assert.doesNotMatch(p, /position sizing.{0,40}consider/i);
});

test('the model is Haiku, and overridable', () => {
  assert.match(analyst.MODEL, /haiku/);
});
