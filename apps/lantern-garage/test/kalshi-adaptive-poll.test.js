// kalshi-adaptive-poll.test.js — send-on-delta cadence math (lib/kalshi-adaptive-poll.js).
// Pure-module tests: EWMA variance tracking, dt = beta/sigma²_max with clamps, hot prior
// for unseen markets, spike reset, idle cadences, pruning, env parsing.
// Run: node apps/lantern-garage/test/kalshi-adaptive-poll.test.js
"use strict";

const assert = require("assert");
const { createScheduler, parseEnvConfig, midCents, DEFAULTS } = require("../lib/kalshi-adaptive-poll");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const T0 = 1_000_000_000_000;
const mkt = (ticker, bid, ask) => ({ ticker, yes_bid: bid, yes_ask: ask });

check("midCents: mid of bid/ask, last_price fallback, null when unpriceable", () => {
  assert.strictEqual(midCents({ yes_bid: 40, yes_ask: 44 }), 42);
  assert.strictEqual(midCents({ yes_bid: 0, yes_ask: 0, last_price: 55 }), 55);
  assert.strictEqual(midCents({ yes_bid: 0, yes_ask: 0, last_price: 0 }), null);
  assert.strictEqual(midCents({ yes_bid: 50, yes_ask: 40, last_price: 45 }), 45); // crossed book -> last
});

check("unseen market gets the hot prior => floor cadence", () => {
  const s = createScheduler();
  const res = s.observe([mkt("A", 40, 44)], T0);
  assert.strictEqual(res.intervalMs, DEFAULTS.floorMs);
  assert.strictEqual(res.tracked, 1);
});

check("quiet market decays toward the cap", () => {
  const s = createScheduler();
  let now = T0;
  let res = s.observe([mkt("A", 40, 44)], now);
  // No price movement for 40 minutes of 6s polls: sigma² decays toward 0.
  for (let i = 0; i < 400; i++) {
    now += 6000;
    res = s.observe([mkt("A", 40, 44)], now);
  }
  assert.strictEqual(res.intervalMs, DEFAULTS.capMs, `expected cap, got ${res.intervalMs} (${res.reason})`);
  assert.strictEqual(res.reason, "quiet-cap");
});

check("hot market pins the floor and is reported as driver", () => {
  const s = createScheduler();
  let now = T0;
  let price = 40;
  let res = s.observe([mkt("HOT", price, price + 2), mkt("COLD", 60, 62)], now);
  for (let i = 0; i < 20; i++) {
    now += 6000;
    price += (i % 2 === 0 ? 1 : -1) * 2; // ±2 cents every 6s — well above sigmaRef
    res = s.observe([mkt("HOT", price, price + 2), mkt("COLD", 60, 62)], now);
  }
  assert.strictEqual(res.intervalMs, DEFAULTS.floorMs);
  assert.strictEqual(res.driver, "HOT");
});

check("interval scales between floor and cap for intermediate variance", () => {
  // sigmaRef/4 => raw = floor * 4 = 24s (between 6s floor and 60s cap).
  const s = createScheduler({ halfLifeMs: 1 }); // near-instant EWMA: latest rate dominates
  let res = s.observe([mkt("A", 40, 44)], T0);
  // 1-cent move over 100s => rate = 0.01 cents²/s = sigmaRef/4.
  res = s.observe([mkt("A", 41, 45)], T0 + 100_000);
  assert.ok(res.intervalMs > DEFAULTS.floorMs && res.intervalMs < DEFAULTS.capMs,
    `expected scaled interval, got ${res.intervalMs} (${res.reason})`);
  assert.strictEqual(res.reason, "scaled");
  assert.ok(Math.abs(res.intervalMs - 24000) < 1500, `expected ≈24000, got ${res.intervalMs}`);
});

check("a ≥3-cent single move resets to the floor as a spike", () => {
  const s = createScheduler();
  let now = T0;
  let res = s.observe([mkt("A", 40, 44)], now);
  for (let i = 0; i < 400; i++) { now += 6000; res = s.observe([mkt("A", 40, 44)], now); }
  assert.strictEqual(res.intervalMs, DEFAULTS.capMs); // quiet by now
  now += 6000;
  res = s.observe([mkt("A", 44, 48)], now); // +4 cents in one observation
  assert.strictEqual(res.intervalMs, DEFAULTS.floorMs);
  assert.strictEqual(res.reason, "spike");
  assert.strictEqual(res.spikeTicker, "A");
});

check("idle cadences: closed / empty / error", () => {
  const s = createScheduler();
  assert.strictEqual(s.idle("closed").intervalMs, DEFAULTS.idleClosedMs);
  assert.strictEqual(s.idle("empty").intervalMs, DEFAULTS.idleEmptyMs);
  assert.strictEqual(s.idle("error").intervalMs, DEFAULTS.floorMs);
});

check("stale tickers are pruned after the TTL", () => {
  const s = createScheduler();
  s.observe([mkt("GONE", 40, 44)], T0);
  const res = s.observe([mkt("HERE", 50, 54)], T0 + DEFAULTS.staleTtlMs + 1);
  assert.strictEqual(res.tracked, 1);
});

check("parseEnvConfig: defaults, overrides, garbage rejected", () => {
  const d = parseEnvConfig({});
  assert.strictEqual(d.floorMs, DEFAULTS.floorMs);
  const o = parseEnvConfig({ KALSHI_POLL_FLOOR_MS: "3000", KALSHI_POLL_SIGMA_REF: "0.1" });
  assert.strictEqual(o.floorMs, 3000);
  assert.strictEqual(o.sigmaRefCents2PerSec, 0.1);
  const g = parseEnvConfig({ KALSHI_POLL_CAP_MS: "-5", KALSHI_POLL_HALFLIFE_MS: "banana" });
  assert.strictEqual(g.capMs, DEFAULTS.capMs);
  assert.strictEqual(g.halfLifeMs, DEFAULTS.halfLifeMs);
});

check("longer gaps weight fresh evidence more (irregular EWMA)", () => {
  const short = createScheduler();
  short.observe([mkt("A", 40, 44)], T0);
  const rShort = short.observe([mkt("A", 41, 45)], T0 + 6000);       // 1 cent over 6s
  const long = createScheduler();
  long.observe([mkt("A", 40, 44)], T0);
  const rLong = long.observe([mkt("A", 41, 45)], T0 + 300_000);      // 1 cent over 5 min
  // Same total move: the short-gap observation implies a much higher rate.
  assert.ok(rShort.sigma2Max > rLong.sigma2Max,
    `expected short-gap sigma² (${rShort.sigma2Max}) > long-gap (${rLong.sigma2Max})`);
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nall kalshi-adaptive-poll tests passed");
