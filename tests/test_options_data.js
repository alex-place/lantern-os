/**
 * Options DATA layer unit tests (#2580): lib/options-data.js — the Alpha
 * Vantage HISTORICAL_OPTIONS chain/IV client behind
 * GET /api/trading/options/chain.
 *
 * Fully offline: upstream payloads are FIXTURES injected via the exported
 * _parseChain seam and the getOptionsChain({ fetchFn }) seam — no network.
 * Covers: normalization of a realistic Alpha Vantage payload, keyless
 * degradation shape, 15-minute cache hits, malformed payloads → honest
 * errors, and the 5-req/min free-tier refusal.
 *
 * Run: node tests/test_options_data.js
 */

const assert = require("assert");
const path = require("path");

const od = require(path.join(__dirname, "..", "apps", "lantern-garage", "lib", "options-data"));

// ── fixtures (field-for-field the live Alpha Vantage shape: all strings) ──────

const CHAIN_FIXTURE = {
  endpoint: "Historical Options",
  message: "success",
  data: [
    {
      contractID: "IBM260717C00115000", symbol: "IBM", expiration: "2026-07-17",
      strike: "115.00", type: "call", last: "96.44", mark: "96.50",
      bid: "94.70", bid_size: "12", ask: "98.30", ask_size: "3",
      volume: "27", open_interest: "27", date: "2026-07-15",
      implied_volatility: "3.88795", delta: "0.98799", gamma: "0.00051",
      theta: "-0.48620", vega: "0.00489", rho: "0.00615",
    },
    {
      contractID: "IBM260717P00115000", symbol: "IBM", expiration: "2026-07-17",
      strike: "115.00", type: "put", last: "0.00", mark: "0.01",
      bid: "0.00", bid_size: "0", ask: "0.01", ask_size: "3",
      volume: "0", open_interest: "18", date: "2026-07-15",
      implied_volatility: "2.69774", delta: "-0.00083", gamma: "0.00007",
      theta: "-0.02993", vega: "0.00044", rho: "-0.00001",
    },
    // a row with no greeks and blank volume — greeks must stay absent, not fabricated
    {
      contractID: "IBM260717C00120000", symbol: "IBM", expiration: "2026-07-17",
      strike: "120.00", type: "call", last: "91.10", mark: "91.20",
      bid: "89.00", ask: "93.40", volume: "", open_interest: "5",
      date: "2026-07-15", implied_volatility: "3.10000",
    },
    // junk row (no contract identity) — must be dropped, not normalized
    { symbol: "IBM", type: "call" },
  ],
};

const KEYLESS_UPSTREAM_FIXTURE = {
  "Error Message": "the parameter apikey is invalid or missing. Please claim your free API key on (https://www.alphavantage.co/support/#api-key). It should take less than 20 seconds.",
};

async function main() {
  const savedKey = process.env.ALPHAVANTAGE_API_KEY;

  // 1) normalization of a realistic payload
  const p = od._parseChain(CHAIN_FIXTURE);
  assert.strictEqual(p.ok, true, `fixture must parse: ${p.reason}`);
  assert.strictEqual(p.rows.length, 3, "3 real contracts kept, 1 junk row dropped");
  const call = p.rows[0];
  assert.deepStrictEqual(
    { contract: call.contract, type: call.type, strike: call.strike, expiration: call.expiration },
    { contract: "IBM260717C00115000", type: "call", strike: 115, expiration: "2026-07-17" });
  assert.strictEqual(call.bid, 94.7);
  assert.strictEqual(call.ask, 98.3);
  assert.strictEqual(call.last, 96.44);
  assert.strictEqual(call.volume, 27);
  assert.strictEqual(call.open_interest, 27);
  assert.strictEqual(call.implied_volatility, 3.88795);
  assert.strictEqual(call.delta, 0.98799);
  assert.strictEqual(call.theta, -0.4862);
  const put = p.rows[1];
  assert.strictEqual(put.type, "put");
  assert.strictEqual(put.delta, -0.00083);
  const bare = p.rows[2];
  assert.strictEqual(bare.volume, null, "blank volume → null, not 0 or NaN");
  assert.ok(!("delta" in bare) && !("vega" in bare), "absent greeks stay absent — never invented");
  console.log("ok - normalization: realistic Alpha Vantage payload → typed rows, junk dropped, greeks only when present");

  // 2) keyless degradation shape (env unset → honest refusal, no throw, no fetch)
  delete process.env.ALPHAVANTAGE_API_KEY;
  od._resetForTests();
  let fetched = 0;
  const keyless = await od.getOptionsChain("SPY", { fetchFn: async () => { fetched++; return CHAIN_FIXTURE; } });
  assert.deepStrictEqual(keyless, { available: false, reason: "ALPHAVANTAGE_API_KEY not configured" });
  assert.strictEqual(fetched, 0, "keyless call must never hit the network");
  console.log("ok - keyless degradation: exact { available:false, reason } shape, zero fetches");

  // 3) cache hit: same symbol+date served from the 15-min cache (one upstream fetch)
  process.env.ALPHAVANTAGE_API_KEY = "test.key.1"; // dotted placeholder — not a real credential
  od._resetForTests();
  let calls = 0;
  const fetchFn = async () => { calls++; return CHAIN_FIXTURE; };
  const first = await od.getOptionsChain("IBM", { date: "2026-07-15", fetchFn });
  assert.strictEqual(first.available, true, `live-shaped call must succeed: ${first.reason}`);
  assert.strictEqual(first.cached, false);
  assert.strictEqual(first.count, 3);
  assert.strictEqual(first.symbol, "IBM");
  assert.strictEqual(first.date, "2026-07-15");
  assert.strictEqual(first.session, "2026-07-15");
  assert.strictEqual(first.source, "alphavantage:HISTORICAL_OPTIONS");
  const second = await od.getOptionsChain("IBM", { date: "2026-07-15", fetchFn });
  assert.strictEqual(second.cached, true, "second identical call must be a cache hit");
  assert.strictEqual(second.count, 3);
  assert.strictEqual(calls, 1, "cache hit must not re-fetch");
  const otherDate = await od.getOptionsChain("IBM", { date: "2026-07-14", fetchFn });
  assert.strictEqual(otherDate.cached, false, "different date = different cache entry");
  assert.strictEqual(calls, 2);
  console.log("ok - cache: symbol+date hit skips upstream; different date fetches fresh");

  // 4) malformed payloads → honest { available:false, reason }, never a throw
  od._resetForTests();
  const cases = [
    [KEYLESS_UPSTREAM_FIXTURE, /Alpha Vantage: the parameter apikey/],
    [{ Note: "API call frequency is 5 calls per minute" }, /Alpha Vantage: API call frequency/],
    [{ endpoint: "Historical Options" }, /no data array/],
    ["not even json-object", /not a JSON object/],
    [null, /not a JSON object/],
    [{ data: [{ symbol: "SPY" }] }, /no parseable contract rows/],
  ];
  for (const [payload, re] of cases) {
    od._resetForTests();
    const r = await od.getOptionsChain("SPY", { fetchFn: async () => payload });
    assert.strictEqual(r.available, false, `malformed payload must degrade: ${JSON.stringify(payload).slice(0, 60)}`);
    assert.ok(re.test(r.reason), `reason '${r.reason}' should match ${re}`);
  }
  // transport failure is also honest, not thrown
  od._resetForTests();
  const boom = await od.getOptionsChain("SPY", { fetchFn: async () => { throw new Error("timeout"); } });
  assert.deepStrictEqual(boom, { available: false, reason: "Alpha Vantage request failed (timeout)" });
  // and empty-chain success is a success with count 0, not an error
  od._resetForTests();
  const empty = await od.getOptionsChain("SPY", { fetchFn: async () => ({ data: [] }) });
  assert.strictEqual(empty.available, true);
  assert.strictEqual(empty.count, 0);
  console.log("ok - malformed payloads: upstream notices surfaced verbatim, structural junk named, transport errors caught");

  // 5) invalid inputs refused before any fetch
  od._resetForTests();
  for (const badSym of ["", "TOO_LONG_SYMBOL_XX", "spy;drop", null]) {
    const r = await od.getOptionsChain(badSym, { fetchFn: async () => CHAIN_FIXTURE });
    assert.strictEqual(r.available, false, `symbol ${JSON.stringify(badSym)} must be refused`);
    assert.ok(/invalid symbol/.test(r.reason));
  }
  const badDate = await od.getOptionsChain("SPY", { date: "07/15/2026", fetchFn: async () => CHAIN_FIXTURE });
  assert.strictEqual(badDate.available, false);
  assert.ok(/invalid date/.test(badDate.reason));
  console.log("ok - input validation: bad symbols and non-ISO dates refused honestly");

  // 6) free-tier rate limit: 6th distinct upstream request in a minute is refused
  od._resetForTests();
  let upstream = 0;
  const count6 = async () => { upstream++; return CHAIN_FIXTURE; };
  for (let i = 0; i < od.RATE_MAX_PER_WINDOW; i++) {
    const r = await od.getOptionsChain(`SYM${i}`, { fetchFn: count6 });
    assert.strictEqual(r.available, true, `request ${i + 1} within the window must pass`);
  }
  const refused = await od.getOptionsChain("SYM99", { fetchFn: count6 });
  assert.strictEqual(refused.available, false, "6th request in the window must be refused");
  assert.ok(/rate limited/.test(refused.reason), `honest rate-limit reason (got '${refused.reason}')`);
  assert.ok(refused.retry_after_s >= 1, "refusal carries retry_after_s");
  assert.strictEqual(upstream, od.RATE_MAX_PER_WINDOW, "the refused call must not hit upstream");
  // cached results still flow while rate-limited
  const cachedWhileLimited = await od.getOptionsChain("SYM0", { fetchFn: count6 });
  assert.strictEqual(cachedWhileLimited.cached, true, "cache serves even when the window is exhausted");
  assert.strictEqual(upstream, od.RATE_MAX_PER_WINDOW);
  console.log("ok - rate limit: 5/min honored, 6th refused with retry_after_s, cache still serves");

  // restore env
  od._resetForTests();
  if (savedKey === undefined) delete process.env.ALPHAVANTAGE_API_KEY;
  else process.env.ALPHAVANTAGE_API_KEY = savedKey;

  console.log("ok - options-data: all offline suites passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
