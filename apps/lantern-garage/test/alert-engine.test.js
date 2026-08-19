// #3248 — alert rules store + scan-loop evaluation.
//
// Contract: strict rule validation, per-user isolation, a hard rule cap, the
// three v1 predicates (signal / zone-proximity / washout=ENTER verdict),
// cooldown windows, and fail-soft evaluation. ALERTS_DIR points the store at a
// temp dir BEFORE require, so the real code paths run without touching data/.
//
// Run: node apps/lantern-garage/test/alert-engine.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-test-'));
process.env.ALERTS_DIR = TMP;

const store = require('../lib/alert-store');
const { evaluateScan, matchRule } = require('../lib/alert-engine');

let failures = 0;
const check = (name, fn) => {
  try { fn(); process.stdout.write('  ok  - ' + name + '\n'); }
  catch (e) { failures++; process.stderr.write('  FAIL- ' + name + '\n      ' + e.message + '\n'); }
};

check('validation: bad symbols, types, directions, and path-escaping user ids are rejected', () => {
  assert.strictEqual(store.saveRule('u1', { symbol: '../../etc', type: 'signal' }).ok, false);
  assert.strictEqual(store.saveRule('u1', { symbol: 'SPY', type: 'nope' }).ok, false);
  assert.strictEqual(store.saveRule('u1', { symbol: 'SPY', type: 'signal', direction: 'SIDEWAYS' }).ok, false);
  assert.strictEqual(store.saveRule('../evil', { symbol: 'SPY', type: 'signal' }).ok, false);
  assert.strictEqual(store.safeUid('a/b'), null);
});

check('bounds clamp: cooldown and proximity are forced into their ranges', () => {
  const r1 = store.saveRule('u1', { symbol: 'SPY', type: 'zone', zone: 'support', proximityPct: 99, cooldownMin: 1 });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.rule.proximityPct, 5);
  assert.strictEqual(r1.rule.cooldownMin, 5);
  store.deleteRule('u1', r1.rule.id);
});

check('rule cap holds', () => {
  for (let i = 0; i < store.MAX_RULES_PER_USER; i++) {
    assert.strictEqual(store.saveRule('capuser', { symbol: 'SPY', type: 'signal' }).ok, true);
  }
  const over = store.saveRule('capuser', { symbol: 'QQQ', type: 'signal' });
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.error, 'rule_cap');
  fs.rmSync(path.join(TMP, 'capuser'), { recursive: true, force: true });   // don't leak 20 rules into later checks
});

const SIG_BULL = { symbol: 'SPY', direction: 'BULLISH', entry_price: 100, confidence: 0.7, rsi: 28, support: 99.6, resistance: 104, convergence: { decision: 'ENTER', p_win: 0.62 } };
const SIG_FLAT = { symbol: 'QQQ', direction: 'NEUTRAL', entry_price: 500, support: 480, resistance: 505, convergence: { decision: 'SKIP' } };

check('predicates: signal / zone / washout match on the right fields', () => {
  const sig = store.normalizeRule({ symbol: 'SPY', type: 'signal', direction: 'BULLISH' }).rule;
  assert.ok(matchRule(sig, SIG_BULL), 'bullish rule matches bullish signal');
  assert.strictEqual(matchRule(sig, SIG_FLAT), null, 'neutral never fires a signal rule');
  const anyDir = store.normalizeRule({ symbol: 'SPY', type: 'signal', direction: 'ANY' }).rule;
  assert.ok(matchRule(anyDir, SIG_BULL));
  const zone = store.normalizeRule({ symbol: 'SPY', type: 'zone', zone: 'support', proximityPct: 0.5 }).rule;
  assert.ok(matchRule(zone, SIG_BULL), '100 vs support 99.6 is 0.4% — inside 0.5%');
  const zoneTight = store.normalizeRule({ symbol: 'SPY', type: 'zone', zone: 'support', proximityPct: 0.2 }).rule;
  assert.strictEqual(matchRule(zoneTight, SIG_BULL), null, '0.4% away is outside a 0.2% band');
  const wash = store.normalizeRule({ symbol: 'SPY', type: 'washout' }).rule;
  assert.ok(matchRule(wash, SIG_BULL), 'ENTER verdict fires the washout rule');
  const washQ = store.normalizeRule({ symbol: 'QQQ', type: 'washout' }).rule;
  assert.strictEqual(matchRule(washQ, SIG_FLAT), null, 'SKIP verdict does not');
});

check('evaluateScan: fires, appends the feed, stamps cooldown, and respects it', () => {
  const saved = store.saveRule('cooluser', { symbol: 'SPY', type: 'signal', direction: 'BULLISH', cooldownMin: 60 });
  assert.strictEqual(saved.ok, true);
  const t0 = Date.parse('2026-08-11T14:00:00Z');
  assert.strictEqual(evaluateScan({ signals: [SIG_BULL] }, t0), 1, 'first scan fires');
  assert.strictEqual(evaluateScan({ signals: [SIG_BULL] }, t0 + 10 * 60000), 0, '10 min later: quiet window holds');
  assert.strictEqual(evaluateScan({ signals: [SIG_BULL] }, t0 + 61 * 60000), 1, '61 min later: fires again');
  const feed = store.readFeed('cooluser');
  assert.strictEqual(feed.length, 2);
  assert.ok(feed[0].message.includes('SPY'), 'feed rows carry the message');
  assert.ok(feed[0].ts > feed[1].ts, 'feed is newest-first');
});

check('per-user isolation: one user\'s rules and feed never leak to another', () => {
  store.saveRule('alice', { symbol: 'QQQ', type: 'washout' });
  evaluateScan({ signals: [{ ...SIG_FLAT, convergence: { decision: 'ENTER' } }] }, Date.parse('2026-08-11T15:00:00Z'));
  assert.ok(store.readFeed('alice').length >= 1);
  assert.strictEqual(store.readFeed('bob').length, 0);
  assert.strictEqual(store.listRules('bob').length, 0);
});

check('client cannot reset a cooldown by re-saving the rule', () => {
  const r = store.saveRule('sneaky', { symbol: 'SPY', type: 'signal', direction: 'ANY', cooldownMin: 60 });
  evaluateScan({ signals: [SIG_BULL] }, Date.parse('2026-08-11T16:00:00Z'));
  const fired = store.listRules('sneaky')[0];
  assert.ok(fired.lastFiredAt, 'fire stamped');
  store.saveRule('sneaky', { ...r.rule, lastFiredAt: null });   // malicious client edit
  assert.strictEqual(store.listRules('sneaky')[0].lastFiredAt, fired.lastFiredAt, 'server-owned stamp survives');
});

check('fail-soft: garbage scan input never throws', () => {
  assert.strictEqual(evaluateScan(null), 0);
  assert.strictEqual(evaluateScan({}), 0);
  assert.strictEqual(evaluateScan({ signals: 'nope' }), 0);
});

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
