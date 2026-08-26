'use strict';
/**
 * entry-judge.test.js — the second opinion is a JOURNAL, not a veto (#3390).
 *
 * Pinned properties:
 *   - no order authority: requires are fs/path/direction-lock only
 *   - default OFF, degrades silently, never throws into the entry path
 *   - the redirect option exists exactly when the family has an inverse
 *   - the prompt is NEUTRAL: evidence + options, no named failure modes
 *     (the #3370 lesson: naming one collapses the model onto it)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'judge-')), 'judge.jsonl');
process.env.TRADER_JUDGE_LOG = LOG;

const ej = require('../lib/entry-judge');

const withEnv = async (env, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
};
const readLog = () => (fs.existsSync(LOG)
  ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : []);
const ENTRY = { symbol: 'SPY', price: 769.06, stop: 746, notional: 59000, p_win: 0.61,
  ibs: 0.08, spy_tape: -0.62, spy_mom30: -0.11, regime: 'BEARISH', macd_hist: -0.02, in_zone: true, et_time: '9:41' };

test('NO ORDER AUTHORITY: requires are fs/path/direction-lock only', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'entry-judge.js'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['placeIBKROrder', 'trading-api-bridge', 'auto-trader', 'alpaca-adapter', 'closeLong', 'cancelIBKROrder']) {
    assert.ok(!code.includes(forbidden), `entry-judge must not touch ${forbidden}`);
  }
  const requires = [...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(requires, ['./direction-lock', 'fs', 'path'], `unexpected requires: ${requires}`);
});

test('DEFAULT OFF: judge() is a no-op without the flag', async () => {
  let called = false;
  const r = await withEnv({ TRADER_ENTRY_JUDGE: null }, () =>
    ej.judge(ENTRY, { fetchImpl: async () => { called = true; return { ok: true }; } }));
  assert.strictEqual(r.skipped, 'disabled');
  assert.strictEqual(called, false);
  assert.strictEqual(readLog().length, 0);
});

test('inverseFor: every long family maps to its inverse; inverse-less and inverse symbols get none', () => {
  assert.strictEqual(ej.inverseFor('SPY') && require('../lib/direction-lock').instrumentSign(ej.inverseFor('SPY')).sign, -1);
  for (const [sym, family] of [['SPY', 'SPY'], ['QQQ', 'QQQ'], ['IWM', 'IWM'], ['DIA', 'DIA'], ['SMH', 'SOX']]) {
    const inv = ej.inverseFor(sym);
    assert.ok(inv, sym + ' must have an inverse');
    const s = require('../lib/direction-lock').instrumentSign(inv);
    assert.strictEqual(s.family, family);
    assert.strictEqual(s.sign, -1);
  }
  assert.strictEqual(ej.inverseFor('XLK'), null, 'XLK has no inverse in the universe');
  assert.strictEqual(ej.inverseFor('SOXS'), null, 'an inverse entry gets no redirect option');
});

test('the PROMPT is neutral: evidence and options, no leading language', () => {
  const p = ej.buildPrompt({ ...ENTRY, leverage: 1, inverse: 'SPXS' });
  assert.match(p, /BUY SPY/);
  assert.match(p, /redirect_inverse/, 'the redirect option is offered');
  assert.match(p, /SPXS/, 'the concrete inverse is named');
  assert.match(p, /session IBS 0\.080/);
  assert.match(p, /SPY today -0\.62%/);
  // the #3370 discipline: no named failure modes, no editorial nudges
  for (const leading of ['falling knife', 'bad idea', 'negative day', 'mistake', 'wrong', 'careful', 'risky']) {
    assert.ok(!p.toLowerCase().includes(leading), `prompt must not contain leading phrase "${leading}"`);
  }
});

test('a family without an inverse offers approve/reject only, and parse enforces it', () => {
  const p = ej.buildPrompt({ ...ENTRY, symbol: 'XLK', leverage: 1, inverse: null });
  assert.ok(!p.includes('redirect_inverse'), 'no redirect option without an inverse');
  const r = ej.parseReply('{"verdict":"redirect_inverse","conviction":80,"reason":"x"}', false);
  assert.strictEqual(r.degraded, true, 'an un-offered verdict is rejected, not accepted');
});

test('verdicts journal side by side; a dead local provider degrades without blocking', async () => {
  fs.writeFileSync(LOG, '');
  const fetchImpl = async (url) => {
    if (String(url).includes('anthropic')) {
      return { ok: true, json: async () => ({ content: [{ type: 'text',
        text: '{"verdict":"redirect_inverse","conviction":72,"reason":"tape one-way lower"}' }] }) };
    }
    throw new Error('ECONNREFUSED');
  };
  const r = await withEnv({ TRADER_ENTRY_JUDGE: '1', ANTHROPIC_API_KEY: 'test-key' }, () =>
    ej.judge(ENTRY, { fetchImpl }));
  assert.strictEqual(r.logged, 2);
  const rows = readLog();
  const claude = rows.find((x) => x.provider === 'claude');
  const local = rows.find((x) => x.provider === 'local');
  assert.strictEqual(claude.verdict, 'redirect_inverse');
  assert.strictEqual(claude.inverse, 'SPXS', 'the row records WHICH inverse the redirect means');
  assert.strictEqual(claude.symbol, 'SPY');
  assert.ok(local.degraded && /ECONNREFUSED/.test(local.reason));
});

test('judge() never throws, even on a poisoned entry', async () => {
  await withEnv({ TRADER_ENTRY_JUDGE: '1' }, async () => {
    const r = await ej.judge(null, { fetchImpl: async () => { throw new Error('boom'); } });
    assert.ok(r.skipped || r.logged != null, 'returns a shape, never throws');
  });
});

test('newsContext: last-24h items for the family and the market, highest impact first, journaled and in the prompt (2026-08-23)', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'news-')), 'news.jsonl');
  const now = Date.parse('2026-08-24T14:00:00Z');
  const row = (h, syms, direction, impact, hoursAgo) => JSON.stringify({ headline: h, symbols: syms, direction, impact, published: new Date(now - hoursAgo * 3600e3).toISOString() });
  fs.writeFileSync(f, [
    row('Chipmakers slide as export rules tighten', ['SMH', 'NVDA'], 'bearish', 80, 3),
    row('Fed holds, signals patience', ['SPY'], 'neutral', 70, 20),
    row('Semis rally on AI orders', ['SOXL'], 'bullish', 60, 5),
    row('Old story from last week', ['SOXL'], 'bearish', 95, 90),        // outside the window
    row('Energy ETF comparison', ['XLE'], 'neutral', 35, 1),             // another family, not market
    row('Chipmakers slide as export rules tighten', ['SMH'], 'bearish', 80, 4),   // duplicate headline
  ].join('\n') + '\n');
  const n = ej.newsContext('SOXL', now, { file: f });
  assert.deepStrictEqual(n.items.map((x) => x.headline), ['Chipmakers slide as export rules tighten', 'Fed holds, signals patience', 'Semis rally on AI orders']);
  assert.deepStrictEqual(n.items.map((x) => x.scope), ['symbol', 'market', 'symbol']);
  assert.strictEqual(n.bearish, 1); assert.strictEqual(n.bullish, 1); assert.strictEqual(n.topImpact, 80);
  const prompt = ej.buildPrompt({ symbol: 'SOXL', price: 20, stop: 19.4, notional: 10000, news: n });
  assert.ok(/NEWS IN THE LAST 24H/.test(prompt) && /Chipmakers slide/.test(prompt) && /\[bearish, 80, symbol, 3h\]/.test(prompt), prompt);
  assert.ok(/none on file/.test(ej.buildPrompt({ symbol: 'SOXL', price: 20, news: { items: [] } })), 'empty feed is stated, not omitted');
  assert.deepStrictEqual(ej.newsContext('SOXL', now, { file: f + '.missing' }).items, [], 'missing feed -> empty, never throws');
});

// ---------------------------------------------------------------------------
// THE JUDGE WAS UNREADABLE HALF THE TIME (2026-08-26). 18 journaled rows, 14
// degraded; the claude provider scored 4x "unparseable" against 4 real verdicts.
// "unparseable" means no {...} was found AT ALL — a reply cut off before its
// closing brace, not a model refusing the format. max_tokens was 200 and the
// verdicts that landed used 17-19 of the prompt's 20 allowed words: it was
// clipping its own answers. After the fix, a live replay of all 9 real journaled
// entries returned 9 verdicts for 9 attempts.
// ---------------------------------------------------------------------------
const OBJ = String.fromCharCode(123) + '"verdict":"reject","conviction":72,"reason":"tape one-way lower"' + String.fromCharCode(125);

test('a complete object parses — the ordinary case must not regress', () => {
  const r = ej.parseReply(OBJ, true);
  assert.strictEqual(r.degraded, false);
  assert.strictEqual(r.verdict, 'reject');
  assert.strictEqual(r.conviction, 72);
});

test('a fenced block parses — models wrap JSON in markdown unprompted', () => {
  const r = ej.parseReply('```json\n' + OBJ + '\n```', true);
  assert.strictEqual(r.degraded, false);
  assert.strictEqual(r.verdict, 'reject');
});

test('a reply CLIPPED mid-reason still yields its verdict', () => {
  // the exact shape that produced 4 "unparseable" rows: cut off inside the reason
  const clipped = OBJ.slice(0, OBJ.indexOf('lower'));
  const r = ej.parseReply(clipped, true);
  assert.strictEqual(r.degraded, false, 'a truncated reason must not discard the verdict');
  assert.strictEqual(r.verdict, 'reject');
  assert.strictEqual(r.conviction, 72);
});

test('an object missing its opening brace parses', () => {
  const r = ej.parseReply(OBJ.slice(1), true);
  assert.strictEqual(r.degraded, false);
  assert.strictEqual(r.verdict, 'reject');
});

test('genuine refusals are still degraded, not invented into a verdict', () => {
  assert.strictEqual(ej.parseReply('I cannot answer that.', true).degraded, true);
  assert.strictEqual(ej.parseReply('', true).degraded, true);
  assert.strictEqual(ej.parseReply(null, true).degraded, true);
});

test('a bad verdict word is still refused', () => {
  const bad = String.fromCharCode(123) + '"verdict":"maybe","conviction":50' + String.fromCharCode(125);
  assert.strictEqual(ej.parseReply(bad, true).reason, 'bad verdict');
});

test('redirect_inverse is refused when the family has no inverse', () => {
  assert.strictEqual(ej.parseReply(OBJ.replace('reject', 'redirect_inverse'), false).reason, 'bad verdict');
});

test('the claude request carries token headroom and NO assistant prefill', async () => {
  // this model returns HTTP 400 on prefill ("does not support assistant message
  // prefill"), which only a live call revealed. Pin both facts.
  let seen = null;
  const fetchImpl = async (url, opts) => {
    // BOTH providers are called; capture only the anthropic request or this reads the
    // local body, which carries no max_tokens and silently passes a weaker assertion.
    if (String(url).includes('anthropic')) seen = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: OBJ }] }) };
  };
  await withEnv({ TRADER_ENTRY_JUDGE: '1', ANTHROPIC_API_KEY: 'test-key' }, () => ej.judge(ENTRY, { fetchImpl }));
  assert.ok(seen, 'the request was built');
  assert.ok(seen.max_tokens >= 512, `max_tokens ${seen.max_tokens} leaves no room for a 20-word reason`);
  assert.strictEqual(seen.messages.length, 1, 'no assistant prefill — the API rejects it on this model');
  assert.strictEqual(seen.messages[0].role, 'user');
});
