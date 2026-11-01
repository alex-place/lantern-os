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
  // the ONLY modules it may pull in are node's own fs/path and the data-root path helper
  // ./app-paths is the data-root path helper (node's os/path/fs only, asserted in
  // test/trading-state-root.test.js), so it adds no order authority (ADR-0035 step 1).
  const requires = [...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(requires.sort(), ['./app-paths', 'fs', 'path'], `unexpected dependency: ${requires}`);
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

// ── MACHINE CHECKS (2026-10-15) ──────────────────────────────────────────────
// From 2026-09-24 every review failed on the API account's balance, and three defects sat
// unflagged: a 100-share USO SHORT in a long-only book from 10-08, an SLV stop fill of
// -$8,132 found on 10-14 but stamped with its order's 10-12 placement time (the 10-14
// session row said realized +$196 and stops_fired 0), and every AI read failing. None needs
// judgement, so code finds them before the model is called and journals them regardless.
// The fixture below is the real 2026-10-14 shape.
const OCT14 = [
  row({ ts: '2026-10-12T16:07:13.000Z', discovered_at: '2026-10-14T13:30:25.438Z', event: 'exit', symbol: 'SLV', qty: 2607, entry: 54.445, exit: 51.325669, pnl: -8132.1, reason: 'broker fill', order_type: 'Stop', source: 'fill' }),
  row({ ts: '2026-10-14T14:10:00Z', event: 'entry', symbol: 'GDX', qty: 1770, entry: 83.47, notional: 147742, stop: 81, tier: 'A' }),
  row({ ts: '2026-10-14T15:30:00Z', discovered_at: '2026-10-14T15:31:00Z', event: 'exit', symbol: 'GLD', qty: 100, exit: 400.1, pnl: 195.95, reason: 'signal_exit' }),
  row({ ts: '2026-10-14T20:01:26.493Z', event: 'session', date: '2026-10-14', equity: 979952.44, day_pnl: -3325.66, realized_today: 195.95, entries: 3, exits: 1, stops_fired: 0,
    carried_out: [{ symbol: 'GDX', qty: 1770, mark: 83.21, unrealized: -455.11 }, { symbol: 'SOXS', qty: 0.8, mark: 42.37, unrealized: 8.95 },
      { symbol: 'USO', qty: -100, mark: 153.57, unrealized: -649.3 }] }),
].join('\n');
const SHADOW_OCT14 = [
  { date: '2026-10-14', read: 'open', provider: 'claude', degraded: true, reason: 'http 400', ts: '2026-10-14T13:36:00Z' },
  { date: '2026-10-14', read: 'open', provider: 'local', degraded: true, reason: 'fetch failed', ts: '2026-10-14T13:36:00Z' },
  { date: '2026-10-14', read: 'mid', provider: 'claude', degraded: true, reason: 'http 400', ts: '2026-10-14T14:35:00Z' },
  { date: '2026-10-13', read: 'close', provider: 'claude', degraded: true, reason: 'http 400', ts: '2026-10-13T20:05:00Z' },
].map((r) => JSON.stringify(r)).join('\n');
const REVIEWS_BEFORE = [
  { date: '2026-09-23', degraded: false, findings: [] },
  { date: '2026-10-09', degraded: true, reason: 'http 400' },
  { date: '2026-10-12', degraded: true, reason: 'http 400' },
  { date: '2026-10-12', degraded: true, reason: 'disabled' },
  { date: '2026-10-13', degraded: true, reason: 'http 400' },
].map((r) => JSON.stringify(r)).join('\n');
const byCat = (checks) => Object.fromEntries(checks.map((c) => [c.category, c]));

test('machine checks: a short in a long-only book is HIGH, a fractional leftover is low, a long is nothing', () => {
  const c = byCat(sr.buildChecks(OCT14, '2026-10-14'));
  assert.strictEqual(c.negative_position.severity, 'high');
  assert.match(c.negative_position.claim, /USO is held SHORT \(-100 shares\)/);
  assert.match(c.negative_position.evidence, /unrealized -649\.3/);
  assert.strictEqual(c.dust_position.severity, 'low');
  assert.match(c.dust_position.claim, /SOXS holds a fractional 0\.8 share/);
  assert.ok(!sr.buildChecks(OCT14, '2026-10-14').some((x) => /GDX/.test(x.claim)), 'a normal long is not a finding');
});

test('machine checks: the other books at the close (partition_out) are long-only too', () => {
  const text = [
    row({ ts: '2026-10-29T15:00:00Z', event: 'entry', symbol: 'TLT', qty: 719, entry: 81.2, notional: 58383, tier: 'A' }),
    row({ ts: '2026-10-29T20:00:09Z', event: 'session', date: '2026-10-29', equity: 978000, entries: 1, exits: 0,
      carried_out: [{ symbol: 'TLT', qty: 719, mark: 80.9, unrealized: -215.7 }],
      partition_out: [{ symbol: 'BOXX', qty: 2285, mark: 118.76, unrealized: -22.85 }, { symbol: 'SMH', qty: -94, mark: 567.2, unrealized: 1.3 }] }),
  ].join('\n');
  const c = byCat(sr.buildChecks(text, '2026-10-29'));
  assert.strictEqual(c.negative_position.severity, 'high');
  assert.match(c.negative_position.claim, /SMH is held SHORT \(-94 shares\)/);
  assert.match(c.negative_position.evidence, /^session partition_out SMH qty -94/);
  assert.ok(!sr.buildChecks(text, '2026-10-29').some((x) => /BOXX|TLT/.test(x.claim)), 'the fund and the trader\'s long are not findings');
});

test('machine checks: an exit found today but booked to an earlier day is HIGH, on the day it was found only', () => {
  const c = byCat(sr.buildChecks(OCT14, '2026-10-14'));
  assert.strictEqual(c.backdated_fill.severity, 'high');
  assert.match(c.backdated_fill.claim, /SLV exit found today \(-8132\.1\) was booked to 2026-10-12/);
  assert.match(c.backdated_fill.evidence, /discovered 2026-10-14 09:30 ET/);
  assert.match(c.backdated_fill.evidence, /realized_today 195\.95, stops_fired 0/, 'the session figures it contradicts');
  assert.ok(!sr.buildChecks(OCT14, '2026-10-12').some((x) => x.category === 'backdated_fill'), 'not on the day it was stamped');
  assert.ok(!sr.buildChecks(OCT14, '2026-10-15').some((x) => x.category === 'backdated_fill'), 'not the day after');
  const d = sr.buildDigest(OCT14, '2026-10-14');
  const slv = d.exits.find((x) => x.symbol === 'SLV');
  assert.ok(slv, 'the reviewer sees the back-dated exit on the day it was found');
  assert.deepStrictEqual([slv.booked_to, slv.discovered, slv.pnl], ['2026-10-12', '2026-10-14 09:30', -8132.1]);
  assert.ok(!('booked_to' in d.exits.find((x) => x.symbol === 'GLD')), 'a same-day exit carries no back-dating mark');
});

test('machine checks: today\'s failed AI reads, and the reviewer\'s own failure streak (which it cannot report while failing)', () => {
  const c = byCat(sr.buildChecks(OCT14, '2026-10-14', { shadowText: SHADOW_OCT14, reviewText: REVIEWS_BEFORE }));
  assert.strictEqual(c.ai_reads_failed.severity, 'medium', 'all of today\'s claude reads failed');
  assert.match(c.ai_reads_failed.claim, /2 of 2 of today's AI reads failed \(http 400\)/, 'the local model and other days are not counted');
  assert.match(c.ai_reads_failed.check, /account balance/);
  assert.strictEqual(c.review_failing.severity, 'medium');
  assert.match(c.review_failing.claim, /the last 3 session reviews failed \(http 400\)/, 'a disabled day neither counts nor breaks the streak');
  const one = sr.buildChecks(OCT14, '2026-10-14', { reviewText: REVIEWS_BEFORE.split('\n').slice(0, 2).join('\n') });
  assert.ok(!one.some((x) => x.category === 'review_failing'), 'one failure is not a streak');
});

test('machine checks: a clean session has none', () => {
  assert.deepStrictEqual(sr.buildChecks(LEDGER, '2026-08-18', { shadowText: '', reviewText: '' }), []);
});

test('machine checks survive the model failing: an http 400 review still journals and returns them', async () => {
  const r = await withEnv(ON, () => sr.review({ ledgerText: OCT14, day: '2026-10-14', shadowText: SHADOW_OCT14, reviewText: '',
    fetchImpl: async () => ({ ok: false, status: 400 }) }));
  assert.strictEqual(r.degraded, true);
  assert.deepStrictEqual(r.findings, []);
  assert.deepStrictEqual(r.checks.map((x) => x.category).sort(), ['ai_reads_failed', 'backdated_fill', 'dust_position', 'negative_position']);
  const rows = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const last = rows[rows.length - 1];
  assert.match(last.reason, /400/);
  assert.strictEqual(last.checks.length, 4, 'journalled with the failed review');
  const noKey = await withEnv({ ...ON, ANTHROPIC_API_KEY: null }, () => sr.review({ ledgerText: OCT14, day: '2026-10-14', shadowText: '', reviewText: '' }));
  assert.strictEqual(noKey.reason, 'no api key');
  assert.ok(noKey.checks.some((x) => x.category === 'negative_position'), 'no key, still checked');
});

test('the model gets the machine checks as context and is told not to repeat them', async () => {
  let prompt = null;
  await withEnv(ON, () => sr.review({ ledgerText: OCT14, day: '2026-10-14', shadowText: '', reviewText: '',
    fetchImpl: async (_u, o) => { prompt = JSON.parse(o.body).messages[0].content; return reply({ summary: 's', findings: [] }); } }));
  assert.match(prompt, /MACHINE CHECKS \(computed by code/);
  assert.match(prompt, /do not repeat them/);
  assert.match(prompt, /USO is held SHORT/);
  const dataPart = prompt.slice(prompt.indexOf('DATA:'), prompt.indexOf('MACHINE CHECKS'));
  assert.ok(!dataPart.includes('machine_checks'), 'the checks travel apart from the DATA');
  const quiet = sr.buildPrompt(sr.buildDigest(LEDGER, '2026-08-18'));
  assert.ok(!quiet.includes('MACHINE CHECKS'), 'no section when nothing fired');
});

test('pointer row: machine checks reach the trade ledger even when the model failed; nothing to point at = no row', () => {
  const failed = { degraded: true, reason: 'http 400', findings: [], checks: sr.buildChecks(OCT14, '2026-10-14') };
  const p = sr.pointerRow(failed, { ts: 't', user: 'u', date: '2026-10-14' });
  assert.deepStrictEqual([p.event, p.findings, p.checks, p.checks_high, p.review_degraded], ['session_review', 0, 3, 2, 'http 400']);
  assert.deepStrictEqual(p.check_categories.sort(), ['backdated_fill', 'dust_position', 'negative_position']);
  assert.match(p.summary, /USO is held SHORT/, 'with no model summary the first check speaks');
  const ok = sr.pointerRow({ degraded: false, summary: 'quiet', findings: [{ severity: 'high', category: 'x', claim: 'c' }], checks: [] }, { date: 'd' });
  assert.deepStrictEqual([ok.findings, ok.high, ok.checks, ok.summary, 'review_degraded' in ok], [1, 1, 0, 'quiet', false]);
  assert.strictEqual(sr.pointerRow({ degraded: false, findings: [], checks: [] }, {}), null);
  assert.strictEqual(sr.pointerRow(null, {}), null);
});

test('WIRED: the close writes the pointer through pointerRow, so failed reviews with checks still leave a row', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auto-trader.js'), 'utf8');
  const seg = src.slice(src.indexOf("require('./session-review')"), src.indexOf("require('./session-review')") + 1600);
  assert.match(seg, /_rev\.pointerRow\(r, \{/);
  assert.match(seg, /if \(_ptr\) logTrade\(_ptr\)/);
  assert.ok(!/!r\.degraded && r\.findings\.length/.test(seg), 'the old findings-only condition is gone');
});
