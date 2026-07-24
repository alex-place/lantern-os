'use strict';

const test = require('node:test');
const assert = require('node:assert');

const SCH = require.resolve('../lib/sigma-scheduler');
const SIG = require.resolve('../lib/sigma-trader');

// Load the scheduler against a stubbed sigma-trader so _tick's decisions are testable
// without touching a broker. Returns { sched, calls } where calls.rebalance counts
// how many times rebalanceNow ran.
function load({ plan, rebalanceResult = { results: [{ status: 'placed' }], gross: 1, account: 'ACCT' } }) {
  const calls = { rebalance: 0 };
  require.cache[SIG] = { id: SIG, filename: SIG, loaded: true, exports: {
    plan: async () => plan,
    rebalanceNow: async () => { calls.rebalance += 1; return rebalanceResult; },
  } };
  delete require.cache[SCH];
  return { sched: require(SCH), calls };
}

const OPEN = () => true;   // we override _marketOpen per test via env-free monkeypatch

test.afterEach(() => { delete require.cache[SCH]; delete require.cache[SIG]; delete process.env.SIGMA_SCHEDULE; delete process.env.SIGMA_ARM; });

test('_tick: schedule OFF → never rebalances', async () => {
  const { sched, calls } = load({ plan: { ok: true, account: 'A', orders: [{}] } });
  delete process.env.SIGMA_SCHEDULE;
  sched._marketOpen = OPEN;
  await sched._tick(); sched.stop();
  assert.strictEqual(calls.rebalance, 0);
  assert.match(sched.getStatus().last.action, /schedule off/);
});

test('_tick: armed + drift + market open → rebalances', async () => {
  const { sched, calls } = load({ plan: { ok: true, account: 'A', orders: [{ symbol: 'SPY' }, { symbol: 'TLT' }], gross: 1 } });
  process.env.SIGMA_SCHEDULE = '1'; process.env.SIGMA_ARM = '1';
  sched._marketOpen = () => true;
  await sched._tick(); sched.stop();
  assert.strictEqual(calls.rebalance, 1, 'placed a rebalance');
  assert.match(sched.getStatus().last.action, /rebalanced/);
});

test('_tick: enabled but NOT armed → plan-only, never trades', async () => {
  const { sched, calls } = load({ plan: { ok: true, account: 'A', orders: [{}, {}], gross: 1 } });
  process.env.SIGMA_SCHEDULE = '1'; delete process.env.SIGMA_ARM;
  sched._marketOpen = () => true;
  await sched._tick(); sched.stop();
  assert.strictEqual(calls.rebalance, 0);
  assert.match(sched.getStatus().last.action, /plan-only/);
});

test('_tick: armed but market CLOSED → idles (orders would only queue)', async () => {
  const { sched, calls } = load({ plan: { ok: true, account: 'A', orders: [{}], gross: 1 } });
  process.env.SIGMA_SCHEDULE = '1'; process.env.SIGMA_ARM = '1';
  sched._marketOpen = () => false;
  await sched._tick(); sched.stop();
  assert.strictEqual(calls.rebalance, 0);
  assert.match(sched.getStatus().last.action, /market closed/);
});

test('_tick: no dedicated Sigma account → does not trade, tells you to configure it', async () => {
  const { sched, calls } = load({ plan: { ok: true, account: 'not_configured', orders: [], gross: 1 } });
  process.env.SIGMA_SCHEDULE = '1'; process.env.SIGMA_ARM = '1';
  sched._marketOpen = () => true;
  await sched._tick(); sched.stop();
  assert.strictEqual(calls.rebalance, 0);
  assert.match(sched.getStatus().last.action, /no dedicated Sigma account/);
});

test('_tick: armed + on-target (no orders) → nothing to do', async () => {
  const { sched, calls } = load({ plan: { ok: true, account: 'A', orders: [], gross: 1 } });
  process.env.SIGMA_SCHEDULE = '1'; process.env.SIGMA_ARM = '1';
  sched._marketOpen = () => true;
  await sched._tick(); sched.stop();
  assert.strictEqual(calls.rebalance, 0);
  assert.match(sched.getStatus().last.action, /on-target/);
});

test('_marketOpen: weekend is closed', () => {
  const { sched } = load({ plan: { ok: true, account: 'A', orders: [] } });
  // 2026-07-18 is a Saturday.
  assert.strictEqual(sched._marketOpen(new Date('2026-07-18T15:00:00-04:00')), false);
  sched.stop();
});
