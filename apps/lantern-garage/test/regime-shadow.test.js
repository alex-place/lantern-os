'use strict';
/**
 * regime-shadow.test.js — the regime reader is a JOURNAL, not a trader (#3389).
 *
 * It exists to answer one measured question: can a capable model, shown the
 * tape a discretionary human uses, call the day's character better than chance?
 * Until the forward journal says yes, the module must be structurally incapable
 * of touching anything — these tests pin that, plus the honesty properties of
 * the prompt (no look-ahead) and the journal (restart-proof dedupe).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regime-')), 'regime.jsonl');
process.env.TRADER_REGIME_LOG = LOG;

const rs = require('../lib/regime-shadow');

const FIXED_CTX = {
  read: 'close', date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
  gapPct: null, vix: 15.1,
  todayBar: { d: 'today', o: 769, h: 771, l: 764, c: 765, ibs: 0.14 },
  spy: [{ d: '2026-08-20', o: 769, h: 771, l: 766, c: 767, ibs: 0.1 }],
  qqq5: [{ d: 'a', c: 100 }, { d: 'b', c: 101 }], iwm5: [{ d: 'a', c: 50 }, { d: 'b', c: 51 }],
};

const withEnv = async (env, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
};
const readLog = () => (fs.existsSync(LOG)
  ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : []);

test('NO ORDER AUTHORITY: the module cannot reach a bridge, broker, or the auto-trader', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'regime-shadow.js'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['placeIBKROrder', 'trading-api-bridge', 'auto-trader', 'alpaca-adapter', 'closeLong']) {
    assert.ok(!code.includes(forbidden), `regime-shadow must not touch ${forbidden}`);
  }
  const requires = [...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(requires, ['fs', 'http', 'https', 'path'],
    `only node built-ins allowed, got: ${requires}`);
});

test('DEFAULT OFF: without the flag, run() does nothing and calls nothing', async () => {
  let called = false;
  const r = await withEnv({ TRADER_REGIME_SHADOW: null }, () =>
    rs.run('open', { fetchImpl: async () => { called = true; return { ok: true }; } }));
  assert.strictEqual(r.skipped, 'disabled');
  assert.strictEqual(called, false);
  assert.strictEqual(readLog().length, 0);
});

test('parseReply: strict fields, clamped conviction, degrades on garbage', () => {
  const good = rs.parseReply('noise {"regime":"trend_down","posture":"inverse","conviction":140,"reason":"lower highs"} tail');
  assert.deepStrictEqual([good.regime, good.posture, good.conviction, good.degraded],
    ['trend_down', 'inverse', 100, false]);
  for (const bad of ['not json', '{"regime":"sideways","posture":"long","conviction":50}',
    '{"regime":"chop","posture":"short","conviction":50}', '{}', '']) {
    assert.strictEqual(rs.parseReply(bad).degraded, true, JSON.stringify(bad.slice(0, 20)));
  }
});

test('OPEN-READ prompt has NO LOOK-AHEAD: today appears only as the gap, never as H/L/C', () => {
  // A synthetic context shaped like buildContext's output, with today's bar
  // deliberately known — the prompt must not leak it on the open read.
  const ctx = {
    read: 'open', date: '2026-08-21', gapPct: -0.42, vix: 15.1, todayBar: null,
    spy: [{ d: '2026-08-20', o: 769, h: 771, l: 766, c: 767, ibs: 0.1 }],
    qqq5: [{ d: 'a', c: 100 }, { d: 'b', c: 101 }], iwm5: [{ d: 'a', c: 50 }, { d: 'b', c: 51 }],
  };
  const p = rs.buildPrompt(ctx);
  assert.match(p, /09:35 ET/);
  assert.match(p, /-0\.42%/, 'the gap is the only thing known about today');
  assert.match(p, /2026-08-20/, 'history ends yesterday');
  assert.ok(!p.includes('2026-08-21  O'), 'no completed bar for today on the open read');
  assert.match(p, /strict JSON/);
});

test('CLOSE-READ prompt carries today’s completed bar and asks about TOMORROW', () => {
  const ctx = {
    read: 'close', date: '2026-08-21', gapPct: null, vix: 15.1,
    todayBar: { d: '2026-08-21', o: 769, h: 771, l: 764, c: 765, ibs: 0.14 },
    spy: [{ d: '2026-08-20', o: 769, h: 771, l: 766, c: 767, ibs: 0.1 }],
    qqq5: [{ d: 'a', c: 100 }, { d: 'b', c: 101 }], iwm5: [{ d: 'a', c: 50 }, { d: 'b', c: 51 }],
  };
  const p = rs.buildPrompt(ctx);
  assert.match(p, /16:00 ET close/);
  assert.match(p, /Call TOMORROW/);
  assert.match(p, /dayIBS 0\.14/, 'the completed bar is shown');
});

test('journal DEDUPE: a (date, read, provider) row fires exactly once, restart included', async () => {
  fs.writeFileSync(LOG, '');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  fs.appendFileSync(LOG, JSON.stringify({ date: today, read: 'open', provider: 'claude' }) + '\n');
  fs.appendFileSync(LOG, JSON.stringify({ date: today, read: 'open', provider: 'local' }) + '\n');
  assert.strictEqual(rs.alreadyLogged(today, 'open', 'claude'), true);
  assert.strictEqual(rs.alreadyLogged(today, 'open', 'local'), true);
  assert.strictEqual(rs.alreadyLogged(today, 'close', 'claude'), false, 'the other read still fires');
  const r = await withEnv({ TRADER_REGIME_SHADOW: '1' }, () =>
    rs.run('open', { ctx: { ...FIXED_CTX, read: 'open' }, fetchImpl: async () => { throw new Error('must not be called'); } }));
  assert.strictEqual(r.skipped, 'already logged');
});

test('a dead local provider degrades to a journalled reason — it can never block', async () => {
  fs.writeFileSync(LOG, '');
  // fetchImpl serves Claude a clean reply and refuses the local endpoint.
  const fetchImpl = async (url) => {
    if (String(url).includes('anthropic')) {
      return { ok: true, json: async () => ({ content: [{ type: 'text',
        text: '{"regime":"chop","posture":"flat","conviction":55,"reason":"range-bound tape"}' }] }) };
    }
    throw new Error('ECONNREFUSED');
  };
  await withEnv({ TRADER_REGIME_SHADOW: '1', ANTHROPIC_API_KEY: 'test-key' }, () =>
    rs.run('close', { ctx: FIXED_CTX, fetchImpl }));
  const rows = readLog();
  const claude = rows.find((r) => r.provider === 'claude');
  const local = rows.find((r) => r.provider === 'local');
  assert.ok(claude && !claude.degraded && claude.posture === 'flat', 'claude row is clean');
  assert.ok(local && local.degraded && /ECONNREFUSED/.test(local.reason), 'local row records why');
});
