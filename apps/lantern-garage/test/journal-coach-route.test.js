'use strict';
/**
 * test/journal-coach-route.test.js — #3560.
 *
 * Two things decide whether this feature is worth shipping: it must be closed to the
 * tier that did not pay for it, and a model must not be able to put a number in a
 * reader's own coaching that nobody computed. Both are pinned here, the second by
 * driving a deliberately lying model through the real route.
 *
 * Run: node --test apps/lantern-garage/test/journal-coach-route.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-route-'));
const LEDGER = path.join(DIR, 'trades.jsonl');
process.env.TRADER_TRADES_LOG = LEDGER;
process.env.TRADE_NOTES_DIR = path.join(DIR, 'notes');

const route = require('../routes/journal-coach');
const verifyLlm = require('../lib/verify-llm');
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_e) { /* gone */ } });

/* A book with a real shape: right often, paid badly — which is the finding that should
   come out the other end without anybody typing it. */
function seed(n = 40) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const win = i % 3 !== 0;                       // ~67% winners
    const pnl = win ? 82 : -140;                   // paid badly
    rows.push({
      ts: new Date(Date.UTC(2026, 8, 1 + (i % 20), 18, 0, 0)).toISOString(),
      user: 'u-pro', event: 'exit', symbol: ['SPY', 'QQQ', 'TSLA'][i % 3],
      qty: 10, entry: 100 + i * 0.01, exit: 100 + i * 0.01 + pnl / 10,
      pnl, pnl_pct: pnl / 10, reason: 'signal_exit', status: 'filled', order_id: 'c' + i,
    });
  }
  fs.writeFileSync(LEDGER, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function call({ role = 'deep_dreamer', qs = '' } = {}) {
  const url = new URL('http://x/api/journal/coach' + qs);
  const req = Object.assign(new EventEmitter(), {
    method: 'GET', headers: {}, socket: {}, url: url.pathname + url.search,
  });
  if (role) req.session = { user: { id: 'u-pro', role } };
  const out = {};
  const res = {
    writeHead: (code, h) => { out.status = code; out.headers = h; return res; },
    end: (b) => { out.raw = b; try { out.json = JSON.parse(b); } catch (_e) { /* not json */ } },
  };
  return route(req, res, url).then((handled) => ({ handled, ...out }));
}

test('a non-matching path declines, so other routes still see the request', async () => {
  const other = new URL('http://x/api/journal/notes');
  const req = Object.assign(new EventEmitter(), { method: 'GET', headers: {}, socket: {} });
  assert.strictEqual(await route(req, {}, other), false);
});

test('Free does not get the coach, and is told why rather than shown a broken card', async () => {
  seed();
  for (const role of ['guest', 'supporter']) {
    const r = await call({ role });
    assert.strictEqual(r.status, 403, role + ' is denied');
    assert.ok(/entitlement|plan|upgrade|Account/i.test(r.raw), role + ' is told what it needs: ' + r.raw);
  }
});

test('Pro gets it, and Pilot and admin do too', async () => {
  seed();
  for (const role of ['deep_dreamer', 'pilot', 'admin']) {
    const r = await call({ role, qs: '?plain=1' });
    assert.strictEqual(r.status, 200, role);
    assert.ok(Array.isArray(r.json.findings), role + ' gets findings');
  }
});

test('the gate is the plan matrix, not a condition written here', () => {
  // Two sources of truth would drift, and the one on the pricing page is the one a
  // customer reads.
  const pm = require('../lib/plan-matrix');
  assert.strictEqual(pm.minPlanForCapability('journal_coach'), 'pro');
  assert.strictEqual(pm.roleHasCapability('supporter', 'journal_coach'), false);
  assert.strictEqual(pm.roleHasCapability('deep_dreamer', 'journal_coach'), true);
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'journal-coach.js'), 'utf8');
  assert.match(src, /requireEntitlement\(req, res, 'journal_coach'\)/);
});

test('it finds the thing the record actually says, with the figures attached', async () => {
  seed();
  const r = await call({ qs: '?plain=1' });
  const payoff = r.json.findings.find((f) => f.id === 'payoff');
  assert.ok(payoff, 'expected the payoff finding from a right-often-paid-badly book');
  assert.match(r.json.text, /right more often than you are paid for it/);
  assert.ok(payoff.evidence.some((e) => e.label === 'Win rate'));
  assert.strictEqual(r.json.source, 'computed');
});

test('a thin record refuses, and refuses alone', async () => {
  seed(6);
  const r = await call();
  assert.strictEqual(r.json.findings.length, 1);
  assert.strictEqual(r.json.findings[0].kind, 'refusal');
  assert.match(r.json.text, /Not enough closed trades/);
  assert.strictEqual(r.json.source, 'computed', 'and no model is asked to dress it up');
});

test('a model that keeps to the figures is allowed to do the talking', async () => {
  seed();
  const plain = await call({ qs: '?plain=1' });
  const ev = plain.json.findings.flatMap((f) => f.evidence.map((e) => e.value));
  verifyLlm._setVerifyTransport(async () => ({ status: 200, body: '' }));
  const real = verifyLlm.callVerifyModel;
  verifyLlm.callVerifyModel = async () => ({
    text: 'You win ' + ev.find((v) => v.endsWith('%')) + ' of the time and it still is not paying you.',
    provider: 'test-provider',
  });
  try {
    const r = await call();
    assert.strictEqual(r.json.source, 'model');
    assert.strictEqual(r.json.model, 'test-provider');
    assert.match(r.json.text, /not paying you/);
    assert.strictEqual(r.json.rejected, null);
  } finally { verifyLlm.callVerifyModel = real; verifyLlm._resetVerifyTransport(); }
});

test('a model that invents a figure does not get to speak (#3560)', async () => {
  // The whole reason this feature is safe to sell: fluent, plausible, in the reader's
  // own voice, and containing a number from nowhere.
  seed();
  const real = verifyLlm.callVerifyModel;
  verifyLlm.callVerifyModel = async () => ({
    text: 'You are down $9,412.00 this month and your win rate has slipped to 31.7%.',
    provider: 'lying-provider',
  });
  try {
    const r = await call();
    assert.strictEqual(r.json.source, 'computed', 'the computed wording stands');
    assert.strictEqual(r.json.model, null);
    assert.doesNotMatch(r.json.text, /9,412/, 'the invented figure never reaches the reader');
    assert.ok(r.json.rejected.some((t) => t.includes('9,412')), 'and the rejection is reported, not hidden');
  } finally { verifyLlm.callVerifyModel = real; }
});

test('no provider configured is a wording difference, not a failure', async () => {
  seed();
  const real = verifyLlm.callVerifyModel;
  verifyLlm.callVerifyModel = async () => null;
  try {
    const r = await call();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.source, 'computed');
    assert.ok(r.json.text.length > 0, 'there is still something true to read');
  } finally { verifyLlm.callVerifyModel = real; }
});

test('a provider that throws is the same: the reader still gets their record', async () => {
  seed();
  const real = verifyLlm.callVerifyModel;
  verifyLlm.callVerifyModel = async () => { throw new Error('502 from the model'); };
  try {
    const r = await call();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.source, 'computed');
  } finally { verifyLlm.callVerifyModel = real; }
});

test('?plain=1 never calls a model at all', async () => {
  seed();
  let called = false;
  const real = verifyLlm.callVerifyModel;
  verifyLlm.callVerifyModel = async () => { called = true; return null; };
  try {
    await call({ qs: '?plain=1' });
    assert.strictEqual(called, false);
  } finally { verifyLlm.callVerifyModel = real; }
});

test('the reader is never named by the request', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'journal-coach.js'), 'utf8');
  assert.doesNotMatch(src, /searchParams\.get\(['"](user|userId|account)/);
  assert.match(src, /getEffectiveUserId\(req\)/);
});
