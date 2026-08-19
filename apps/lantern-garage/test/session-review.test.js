'use strict';
/**
 * session-review.test.js — the post-close reviewer is a FLAGGER, not a trader
 * (#3359).
 *
 * Built after both hot-path roles measured out: entry review at rho ~0 (#3358)
 * and exit review with no headroom (holding every signal_exit to the close would
 * have cost -$10,751). What kept working was reading a whole finished session, so
 * that is the only role this module has.
 *
 * These tests pin the SAFETY and DIGEST properties, not the findings themselves
 * (a model's judgement will vary run to run):
 *   - it cannot reach an order, a bridge, or a broker
 *   - it cannot break the close; every failure path returns an empty review
 *   - the digest exposes the discontinuities the role exists to catch
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'srev-')), 'reviews.jsonl');
process.env.TRADER_REVIEW_LOG = LOG;

const sr = require('../lib/session-review');

const row = (o) => JSON.stringify(o);
// A ledger shaped like the real 2026-08-18 session: an exit that printed one tick
// through its recorded stop, while the session claims zero stops fired.
const LEDGER = [
  row({ ts: '2026-08-14T20:00:00Z', event: 'session', date: '2026-08-14', equity: 975569, day_pnl: 627, entries: 4, exits: 2, stops_fired: 0, max_slots_used: 4 }),
  row({ ts: '2026-08-17T20:00:00Z', event: 'session', date: '2026-08-17', equity: 975235, day_pnl: -222, entries: 3, exits: 0, stops_fired: 0, max_slots_used: 3 }),
  row({ ts: '2026-08-17T14:00:00Z', event: 'skip', symbol: 'QQQ', reason: 'already long' }),
  row({ ts: '2026-08-18T13:30:00Z', event: 'entry', symbol: 'SOXL', qty: 433, entry: 134.817, notional: 58376, stop: 130.77, p_win: 0.6843, tier: 'B' }),
  row({ ts: '2026-08-18T13:49:00Z', event: 'exit', symbol: 'SOXL', qty: 433, exit: 130.76, pnl: -2432.84, reason: 'broker fill' }),
  row({ ts: '2026-08-18T14:00:00Z', event: 'skip', symbol: 'SOXL', reason: 'post-stop cooldown: stopped out, no re-entry through 10-30-00' }),
  row({ ts: '2026-08-18T14:05:00Z', event: 'skip', symbol: 'QQQ', reason: 'already long' }),
  row({ ts: '2026-08-18T20:00:00Z', event: 'session', date: '2026-08-18', equity: 967210, day_pnl: -5925.72, entries: 3, exits: 1, stops_fired: 0, stops_pnl: 0, max_slots_used: 5, slot_cap: 5 }),
].join('\n');

const ON = { TRADER_SESSION_REVIEW: '1', ANTHROPIC_API_KEY: 'test-key' };
const withEnv = async (env, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
};
const reply = (obj) => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 100, output_tokens: 50 } }) });

// ── the digest: does it expose what the role exists to catch? ───────────────
test('the digest surfaces the stop contradiction: exit price, stop price, and stops_fired together', () => {
  const d = sr.buildDigest(LEDGER, '2026-08-18');
  assert.strictEqual(d.session_record.stops_fired, 0, 'the claim');
  const exit = d.exits.find((x) => x.symbol === 'SOXL');
  const entry = d.entries.find((x) => x.symbol === 'SOXL');
  assert.strictEqual(exit.exit, 130.76);
  assert.strictEqual(entry.stop, 130.77, 'the contradicting evidence must be in the same payload');
  assert.ok(exit.exit < entry.stop, 'printed through the stop');
});

test('the digest carries prior sessions as a baseline, newest last', () => {
  const d = sr.buildDigest(LEDGER, '2026-08-18');
  assert.strictEqual(d.prior_sessions.length, 2);
  assert.deepStrictEqual(d.prior_sessions.map((s) => s.date), ['2026-08-14', '2026-08-17']);
  assert.ok(d.prior_sessions.every((s) => 'equity' in s && 'stops_fired' in s));
});

test('a skip reason that appears for the first time is flagged as NEW', () => {
  const d = sr.buildDigest(LEDGER, '2026-08-18');
  assert.ok(d.skip_reasons_new_today.some((r) => /post-stop cooldown/.test(r)),
    'a gate firing for the first time is exactly the discontinuity to catch');
  assert.ok(!d.skip_reasons_new_today.some((r) => /already long/.test(r)), 'a reason seen before is not new');
});

test('digit normalisation groups templated reasons instead of splitting them', () => {
  const led = [
    row({ ts: '2026-08-18T14:00:00Z', event: 'skip', symbol: 'A', reason: 'cap: 5 positions open (max 5)' }),
    row({ ts: '2026-08-18T14:05:00Z', event: 'skip', symbol: 'B', reason: 'cap: 4 positions open (max 5)' }),
  ].join('\n');
  const d = sr.buildDigest(led, '2026-08-18');
  assert.strictEqual(Object.keys(d.skip_distribution_today).length, 1, 'same template, one bucket');
  assert.strictEqual(Object.values(d.skip_distribution_today)[0], 2);
});

test('the digest stays small enough to be one cheap call', () => {
  const d = sr.buildDigest(LEDGER, '2026-08-18');
  assert.ok(JSON.stringify(d).length < 60000, 'a session digest must not balloon into a context problem');
});

// ── safety: it cannot trade, and it cannot break the close ─────────────────
test('DEFAULT OFF: without the flag it makes no call at all', async () => {
  let called = false;
  const r = await withEnv({ TRADER_SESSION_REVIEW: null }, () =>
    sr.review({ ledgerText: LEDGER, day: '2026-08-18', fetchImpl: async () => { called = true; return reply({ findings: [] }); } }));
  assert.strictEqual(called, false);
  assert.strictEqual(r.degraded, true);
  assert.deepStrictEqual(r.findings, []);
});

test('every failure path returns an EMPTY review — never a partial or a throw', async () => {
  const modes = {
    'http error': async () => ({ ok: false, status: 500 }),
    'throws': async () => { throw new Error('socket hang up'); },
    'garbage body': async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'I think the session was fine' }] }) }),
    'empty content': async () => ({ ok: true, json: async () => ({}) }),
    'refusal': async () => ({ ok: true, json: async () => ({ stop_reason: 'refusal', content: [] }) }),
  };
  for (const [label, impl] of Object.entries(modes)) {
    const r = await withEnv(ON, () => sr.review({ ledgerText: LEDGER, day: '2026-08-18', fetchImpl: impl }));
    assert.deepStrictEqual(r.findings, [], `${label} must yield no findings`);
    assert.strictEqual(r.degraded, true, `${label} must be flagged degraded`);
  }
});

test('a hung endpoint cannot hold the close open', async () => {
  const t0 = Date.now();
  const r = await withEnv({ ...ON, TRADER_REVIEW_TIMEOUT_MS: '150' }, () =>
    sr.review({ ledgerText: LEDGER, day: '2026-08-18', fetchImpl: (_u, o) => new Promise((_res, rej) => {
      o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }) }));
  assert.strictEqual(r.degraded, true);
  assert.match(r.reason, /timeout/);
  assert.ok(Date.now() - t0 < 1500);
});

test('findings are sanitised and bounded — a runaway reply cannot flood the journal', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ severity: 'catastrophic', category: 'x'.repeat(99), claim: 'c' + i, evidence: 'e'.repeat(999), check: 'k' }));
  const r = await withEnv(ON, () => sr.review({ ledgerText: LEDGER, day: '2026-08-18', fetchImpl: async () => reply({ summary: 's', findings: many }) }));
  assert.ok(r.findings.length <= 12, 'capped');
  assert.ok(r.findings.every((f) => ['high', 'medium', 'low'].includes(f.severity)), 'severity coerced to the known set');
  assert.ok(r.findings.every((f) => f.evidence.length <= 400 && f.category.length <= 40), 'fields truncated');
});

test('a finding with no claim is dropped', async () => {
  const r = await withEnv(ON, () => sr.review({ ledgerText: LEDGER, day: '2026-08-18',
    fetchImpl: async () => reply({ findings: [{ severity: 'high', claim: '' }, { severity: 'low', claim: 'real one' }] }) }));
  assert.strictEqual(r.findings.length, 1);
  assert.strictEqual(r.findings[0].claim, 'real one');
});

test('an unremarkable session returning zero findings is a valid result', async () => {
  const r = await withEnv(ON, () => sr.review({ ledgerText: LEDGER, day: '2026-08-18', fetchImpl: async () => reply({ summary: 'nothing unusual', findings: [] }) }));
  assert.strictEqual(r.degraded, false);
  assert.deepStrictEqual(r.findings, []);
  assert.match(r.summary, /nothing unusual/);
});

test('NO ORDER AUTHORITY: no code path can reach an order', () => {
  // Check the CODE, not the prose — the header comment legitimately contains the
  // words "bridge" and "broker" while stating the module has neither.
  const raw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-review.js'), 'utf8');
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/^\s*\/\/.*$/gm, '');       // line comments
  for (const forbidden of ['placeIBKROrder', 'cancelIBKROrder', 'closeLong', 'getIBKRPositions', 'trading-api-bridge', 'auto-trader']) {
    assert.ok(!code.includes(forbidden), `a reviewer must not call ${forbidden}`);
  }
  // the ONLY module it may pull in is node's own fs/path
  const requires = [...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(requires.sort(), ['fs', 'path'], `unexpected dependency: ${requires}`);
});

test('the prompt forbids ungrounded findings and trading advice', () => {
  const p = sr.buildPrompt(sr.buildDigest(LEDGER, '2026-08-18'));
  assert.match(p, /MUST quote a specific number/i);
  assert.match(p, /Do not recommend trades/i);
  assert.match(p.replace(/\s+/g, ' '), /empty\s*findings array/i, 'a quiet session must be an allowed answer');
  assert.match(p, /paper account/i);
});

test('every call is journalled, including the ones that failed', async () => {
  await withEnv(ON, () => sr.review({ ledgerText: LEDGER, day: '2026-08-18', fetchImpl: async () => ({ ok: false, status: 429 }) }));
  const rows = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const last = rows[rows.length - 1];
  assert.strictEqual(last.date, '2026-08-18');
  assert.strictEqual(last.model, sr.MODEL);
  assert.match(last.reason, /429/);
});

// ── the wiring (#3359). A flag on an uncalled module does nothing; these pin
// that the reviewer is actually invoked at the close, and that it cannot
// interfere with it.
test('WIRED: auto-trader invokes the reviewer at the session-record site', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auto-trader.js'), 'utf8');
  assert.match(src, /require\('\.\/session-review'\)/, 'the reviewer must actually be called');
  const recIdx = src.indexOf('buildSessionRecord');
  const revIdx = src.indexOf("require('./session-review')");
  assert.ok(recIdx > 0 && revIdx > recIdx, 'must run AFTER the session row is written, so it reads it');
});

test('WIRED: the call is fire-and-forget — the close is never awaited on it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auto-trader.js'), 'utf8');
  const seg = src.slice(src.indexOf("require('./session-review')"), src.indexOf("require('./session-review')") + 1600);
  assert.ok(!/await\s+_rev\.review/.test(seg), 'awaiting would let a slow API delay the close');
  assert.match(seg, /\.catch\(/, 'a rejected review must be swallowed');
  assert.match(seg, /_rev\.enabled\(\)/, 'gated on the flag, not run unconditionally');
});

test('WIRED: the reviewer is gated so a disabled flag costs nothing', async () => {
  let called = false;
  await withEnv({ TRADER_SESSION_REVIEW: null }, async () => {
    if (sr.enabled()) { called = true; }
  });
  assert.strictEqual(called, false, 'enabled() is the gate auto-trader checks');
});
