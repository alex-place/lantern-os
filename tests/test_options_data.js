/**
 * Options DATA layer unit tests (#2580, reworked for the no-new-keys provider
 * chain): lib/options-data.js — alpaca → yahoo → alphavantage behind
 * GET /api/trading/options/chain.
 *
 * Fully offline: upstream payloads are FIXTURES injected via the exported
 * parser seams (_parseChain / _parseAlpacaSnapshots / _parseYahooChain) and a
 * URL-routed getOptionsChain({ fetchFn, alpacaAuthFn }) transport — no network.
 * Covers: Yahoo v7 parsing (epoch→ISO, NO provider greeks, labeled BS-from-IV
 * delta, underlying-price passthrough), Alpaca snapshot parsing (OCC symbols,
 * provider-labeled greeks), Alpha Vantage parsing (the original fixtures),
 * provider fall-through ORDER with collected reasons, the all-fail honesty
 * shape, cache hits, dated-session routing, input validation, and the AV
 * 5-req/min refusal.
 *
 * Run: node tests/test_options_data.js
 */

const assert = require("assert");
const path = require("path");

const od = require(path.join(__dirname, "..", "apps", "lantern-garage", "lib", "options-data"));

// ── transport helpers: URL-routed fixture fetch ──────────────────────────────

const raw = (obj, status = 200, headers = {}) => ({
  status,
  headers,
  body: typeof obj === "string" ? obj : JSON.stringify(obj),
});

/** mkFetch([[/regex/, responder], ...]) → fetchFn that also counts hits per pattern. */
function mkFetch(routes) {
  const counts = new Map();
  const fn = async (url) => {
    for (const [re, responder] of routes) {
      if (re.test(url)) {
        counts.set(re, (counts.get(re) || 0) + 1);
        return typeof responder === "function" ? responder(url) : responder;
      }
    }
    throw new Error(`unrouted test URL: ${url}`);
  };
  fn.count = (re) => counts.get(re) || 0;
  return fn;
}

const YAHOO_COOKIE_ROUTE = [/fc\.yahoo\.com/, raw("not found", 404, { "set-cookie": ["A3=d=abc123; Path=/; Domain=.yahoo.com", "B=tst; Path=/"] })];
const YAHOO_CRUMB_ROUTE = [/getcrumb/, raw("testCrumb42")];

// ── Alpha Vantage fixtures (field-for-field the live shape: all strings) ─────

const AV_CHAIN_FIXTURE = {
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

// ── Yahoo v7 fixture (realistic optionChain shape) ───────────────────────────
// Expirations are RELATIVE to the real clock because the horizon filter in
// _fetchYahooChain compares against Date.now() — hard-coded dates would rot.

const DAY_S = 86400;
const NOW_MS = Date.now();
const NOW_S = Math.floor(NOW_MS / 1000);
const EXP1_S = NOW_S + 36 * DAY_S;    // inside the default 70d horizon
const EXP2_S = NOW_S + 64 * DAY_S;    // inside
const EXP_FAR_S = NOW_S + 183 * DAY_S; // beyond the horizon
const iso = (s) => new Date(s * 1000).toISOString().slice(0, 10);
const SESSION_S = NOW_S - 3600;

function yahooPayload(expEpoch, calls, puts) {
  return {
    optionChain: {
      result: [{
        underlyingSymbol: "SPY",
        expirationDates: [EXP1_S, EXP2_S, EXP_FAR_S],
        strikes: [95, 100, 105],
        hasMiniOptions: false,
        quote: {
          symbol: "SPY", regularMarketPrice: 100,
          regularMarketTime: SESSION_S,
        },
        options: [{ expirationDate: expEpoch, hasMiniOptions: false, calls, puts }],
      }],
      error: null,
    },
  };
}

const YAHOO_PAGE_1 = yahooPayload(EXP1_S, [
  {
    contractSymbol: "SPY260821C00105000", strike: 105, currency: "USD",
    lastPrice: 2.0, change: 0.1, percentChange: 5.2, volume: 1200, openInterest: 8000,
    bid: 1.9, ask: 2.1, contractSize: "REGULAR", expiration: EXP1_S,
    lastTradeDate: EXP1_S - 86400, impliedVolatility: 0.25, inTheMoney: false,
  },
  // zero-IV row: BS delta must NOT be computed from unusable IV
  {
    contractSymbol: "SPY260821C00110000", strike: 110, lastPrice: 0.9,
    bid: 0.8, ask: 1.0, expiration: EXP1_S, impliedVolatility: 0.00001, inTheMoney: false,
  },
  // junk row (no contractSymbol) — dropped
  { strike: 115, bid: 0.1, ask: 0.2, expiration: EXP1_S },
], [
  {
    contractSymbol: "SPY260821P00095000", strike: 95, lastPrice: 1.4,
    volume: 300, openInterest: 5000, bid: 1.3, ask: 1.5,
    expiration: EXP1_S, impliedVolatility: 0.28, inTheMoney: false,
  },
]);

const YAHOO_PAGE_2 = yahooPayload(EXP2_S, [
  {
    contractSymbol: "SPY260918C00105000", strike: 105, lastPrice: 3.1,
    bid: 3.0, ask: 3.2, expiration: EXP2_S, impliedVolatility: 0.24, inTheMoney: false,
  },
], []);

// ── Alpaca v1beta1 snapshots fixture ─────────────────────────────────────────

const ALPACA_FIXTURE = {
  snapshots: {
    "SPY260821C00105000": {
      latestQuote: { bp: 1.9, ap: 2.1, bs: 10, as: 12, t: "2026-07-16T15:59:59Z" },
      latestTrade: { p: 2.0, t: "2026-07-16T15:58:00Z" },
      impliedVolatility: 0.25,
      greeks: { delta: 0.31, gamma: 0.02, theta: -0.03, vega: 0.11, rho: 0.05 },
      dailyBar: { v: 1200 },
    },
    "SPY260821P00095000": {
      latestQuote: { bp: 1.3, ap: 1.5, t: "2026-07-16T15:59:59Z" },
      latestTrade: { p: 1.4 },
      impliedVolatility: 0.28,
      greeks: { delta: -0.25, gamma: 0.02, theta: -0.02, vega: 0.1, rho: -0.04 },
    },
    // no greeks, no quote timestamps — fields stay null/absent
    "SPY260918C00110000": {
      latestQuote: { bp: 0.8, ap: 1.0 },
    },
    // junk key — not an OCC symbol; dropped
    "NOT_AN_OCC_SYMBOL": { latestQuote: { bp: 1, ap: 2 } },
  },
  next_page_token: null,
};

async function main() {
  const savedKey = process.env.ALPHAVANTAGE_API_KEY;
  delete process.env.ALPHAVANTAGE_API_KEY;

  // 1) Yahoo parser: normalization, epoch→ISO, labeled BS-from-IV delta
  {
    const p = od._parseYahooChain(YAHOO_PAGE_1, { now: NOW_MS });
    assert.strictEqual(p.ok, true, `yahoo fixture must parse: ${p.reason}`);
    assert.strictEqual(p.rows.length, 3, "2 real calls + 1 put kept, junk row dropped");
    assert.strictEqual(p.underlyingPrice, 100, "underlying price passes through from the quote");
    assert.strictEqual(p.session, iso(SESSION_S), "session date from regularMarketTime");
    assert.deepStrictEqual(p.expirationDates, [EXP1_S, EXP2_S, EXP_FAR_S]);
    const call = p.rows[0];
    assert.strictEqual(call.contract, "SPY260821C00105000");
    assert.strictEqual(call.type, "call");
    assert.strictEqual(call.strike, 105);
    assert.strictEqual(call.expiration, iso(EXP1_S), "epoch expiration → ISO date");
    assert.strictEqual(call.bid, 1.9);
    assert.strictEqual(call.ask, 2.1);
    assert.strictEqual(call.mark, 2.0);
    assert.strictEqual(call.last, 2.0);
    assert.strictEqual(call.volume, 1200);
    assert.strictEqual(call.open_interest, 8000);
    assert.strictEqual(call.implied_volatility, 0.25);
    // Yahoo has NO greeks — delta is model-derived and MUST say so
    assert.ok(Number.isFinite(call.delta), "BS-from-IV delta computed for selection");
    assert.strictEqual(call.delta_source, "model(bs-from-iv)", "model delta is labeled, never passed off as provider data");
    assert.ok(call.delta > 0 && call.delta < 0.5, `105C on S=100 is OTM: 0 < delta < 0.5 (got ${call.delta})`);
    assert.ok(!("gamma" in call) && !("theta" in call) && !("vega" in call), "only delta is modeled — other greeks stay absent");
    const put = p.rows[2];
    assert.strictEqual(put.type, "put");
    assert.ok(put.delta < 0 && put.delta > -0.5, `95P on S=100 is OTM: -0.5 < delta < 0 (got ${put.delta})`);
    assert.strictEqual(put.delta_source, "model(bs-from-iv)");
    const dustIv = p.rows[1];
    assert.ok(!("delta" in dustIv), "unusable IV (1e-5) → no delta, never invented");
    console.log("ok - yahoo parser: v7 rows normalized, epoch→ISO, underlying price through, BS delta labeled model(bs-from-iv)");

    // malformed / error yahoo payloads
    assert.strictEqual(od._parseYahooChain(null).ok, false);
    assert.strictEqual(od._parseYahooChain({}).ok, false);
    const err = od._parseYahooChain({ optionChain: { result: [], error: { code: "Not Found", description: "Quote not found for ticker symbol: NOPE" } } });
    assert.strictEqual(err.ok, false);
    assert.ok(/Quote not found/.test(err.reason), "yahoo error description surfaced verbatim");
    const emptyRes = od._parseYahooChain({ optionChain: { result: [], error: null } });
    assert.strictEqual(emptyRes.ok, false);
    assert.ok(/not be optionable/.test(emptyRes.reason));
    console.log("ok - yahoo parser: malformed payloads and upstream errors named honestly");
  }

  // 2) Alpaca snapshots parser: OCC symbols, provider-labeled greeks
  {
    const p = od._parseAlpacaSnapshots(ALPACA_FIXTURE, "SPY");
    assert.strictEqual(p.ok, true, `alpaca fixture must parse: ${p.reason}`);
    assert.strictEqual(p.rows.length, 3, "3 OCC contracts kept, junk key dropped");
    const call = p.rows.find((r) => r.contract === "SPY260821C00105000");
    assert.deepStrictEqual(
      { type: call.type, strike: call.strike, expiration: call.expiration },
      { type: "call", strike: 105, expiration: "2026-08-21" },
      "OCC symbol → type/strike/expiration");
    assert.strictEqual(call.bid, 1.9);
    assert.strictEqual(call.ask, 2.1);
    assert.strictEqual(call.mark, 2.0);
    assert.strictEqual(call.last, 2.0);
    assert.strictEqual(call.volume, 1200);
    assert.strictEqual(call.implied_volatility, 0.25);
    assert.strictEqual(call.delta, 0.31);
    assert.strictEqual(call.delta_source, "provider", "real feed greeks are labeled provider");
    assert.strictEqual(call.date, "2026-07-16");
    const put = p.rows.find((r) => r.contract === "SPY260821P00095000");
    assert.strictEqual(put.type, "put");
    assert.strictEqual(put.delta, -0.25);
    const bare = p.rows.find((r) => r.contract === "SPY260918C00110000");
    assert.ok(!("delta" in bare), "no greeks in the snapshot → none on the row");
    assert.strictEqual(bare.volume, null);
    assert.strictEqual(bare.date, null);
    assert.strictEqual(od._parseAlpacaSnapshots({ snapshots: { JUNK: {} } }, "SPY").ok, false, "all-junk snapshots refused");
    assert.strictEqual(od._parseAlpacaSnapshots({}, "SPY").ok, false, "no snapshots object refused");
    console.log("ok - alpaca parser: OCC identity decoded, quotes/IV mapped, greeks labeled provider, junk dropped");
  }

  // 3) Alpha Vantage parser (original fixtures — provider 3)
  {
    const p = od._parseChain(AV_CHAIN_FIXTURE);
    assert.strictEqual(p.ok, true, `AV fixture must parse: ${p.reason}`);
    assert.strictEqual(p.rows.length, 3, "3 real contracts kept, 1 junk row dropped");
    const call = p.rows[0];
    assert.deepStrictEqual(
      { contract: call.contract, type: call.type, strike: call.strike, expiration: call.expiration },
      { contract: "IBM260717C00115000", type: "call", strike: 115, expiration: "2026-07-17" });
    assert.strictEqual(call.bid, 94.7);
    assert.strictEqual(call.ask, 98.3);
    assert.strictEqual(call.implied_volatility, 3.88795);
    assert.strictEqual(call.delta, 0.98799);
    assert.strictEqual(call.delta_source, "provider");
    assert.strictEqual(call.theta, -0.4862);
    const bare = p.rows[2];
    assert.strictEqual(bare.volume, null, "blank volume → null, not 0 or NaN");
    assert.ok(!("delta" in bare) && !("vega" in bare), "absent greeks stay absent — never invented");
    for (const [payload, re] of [
      [{ "Error Message": "the parameter apikey is invalid or missing." }, /Alpha Vantage: the parameter apikey/],
      [{ Note: "API call frequency is 5 calls per minute" }, /Alpha Vantage: API call frequency/],
      [{ endpoint: "Historical Options" }, /no data array/],
      ["not even json-object", /not a JSON object/],
      [null, /not a JSON object/],
      [{ data: [{ symbol: "SPY" }] }, /no parseable contract rows/],
    ]) {
      const r = od._parseChain(payload);
      assert.strictEqual(r.ok, false);
      assert.ok(re.test(r.reason), `reason '${r.reason}' should match ${re}`);
    }
    console.log("ok - alphavantage parser: original fixtures still normalize; delta labeled provider; malformed payloads named");
  }

  // 4) provider order: alpaca first when auth resolves
  {
    od._resetForTests();
    const fetchFn = mkFetch([
      [/data\.alpaca\.markets/, raw(ALPACA_FIXTURE)],
      YAHOO_COOKIE_ROUTE, YAHOO_CRUMB_ROUTE,
      [/query2.*options/, raw(YAHOO_PAGE_1)],
    ]);
    const r = await od.getOptionsChain("SPY", {
      fetchFn, userId: "u1", alpacaAuthFn: () => ({ headers: { Authorization: "Bearer test.token.1" } }),
    });
    assert.strictEqual(r.available, true, `alpaca-first call must succeed: ${r.reason}`);
    assert.strictEqual(r.source, "alpaca");
    assert.strictEqual(r.count, 3);
    assert.strictEqual(r.underlying_price, null, "alpaca snapshots carry no underlying quote — null, not invented");
    assert.strictEqual(r.providers_skipped, undefined, "nothing was skipped");
    assert.strictEqual(fetchFn.count(/query2.*options/), 0, "yahoo never touched when alpaca serves");
    console.log("ok - provider order: connected alpaca account serves first; yahoo untouched");
  }

  // 5) fall-through: alpaca fails → yahoo serves (multi-expiry within horizon)
  {
    od._resetForTests();
    const optionsRe = /query2\.finance\.yahoo\.com\/v7\/finance\/options\/SPY/;
    const fetchFn = mkFetch([
      [/data\.alpaca\.markets/, raw({ message: "internal error" }, 500)],
      YAHOO_COOKIE_ROUTE, YAHOO_CRUMB_ROUTE,
      [optionsRe, (url) => (url.includes(`date=${EXP2_S}`) ? raw(YAHOO_PAGE_2) : raw(YAHOO_PAGE_1))],
    ]);
    const r = await od.getOptionsChain("SPY", {
      fetchFn, userId: "u1", alpacaAuthFn: () => ({ headers: { Authorization: "Bearer test.token.1" } }),
    });
    assert.strictEqual(r.available, true, `yahoo fallback must succeed: ${r.reason}`);
    assert.strictEqual(r.source, "yahoo");
    assert.strictEqual(r.underlying_price, 100, "yahoo passes the real underlying price through");
    assert.ok(r.providers_skipped.some((s) => /^alpaca: HTTP 500/.test(s)), `alpaca failure reason collected (got ${JSON.stringify(r.providers_skipped)})`);
    assert.strictEqual(r.count, 4, "first expiry (3 rows) + second expiry within horizon (1 row) merged");
    assert.ok(r.contracts.some((c) => c.expiration === iso(EXP2_S)), "second expiration fetched via &date=");
    assert.ok(!r.contracts.some((c) => c.expiration === iso(EXP_FAR_S)), "far expiration beyond horizon NOT fetched");
    // 3 = first chain call + 1 extra expiry... plus none for the far one
    assert.strictEqual(fetchFn.count(optionsRe), 2, "one base call + one in-horizon expiry call");
    console.log("ok - fall-through: alpaca 500 → yahoo serves with reasons collected; expiries merged within horizon only");
  }

  // 5b) windowed expiry picking: daily-expiry symbols must not starve the DTE window
  {
    // 30 DAILY expirations (like SPY) + weeklies out to 90d; first page = tomorrow.
    const daily = [];
    for (let d = 1; d <= 30; d++) daily.push(NOW_S + d * DAY_S);
    const weeklies = [NOW_S + 38 * DAY_S, NOW_S + 45 * DAY_S, NOW_S + 52 * DAY_S, NOW_S + 59 * DAY_S, NOW_S + 66 * DAY_S, NOW_S + 90 * DAY_S];
    const all = [...daily, ...weeklies];
    const picks = od._pickYahooExpiries(all, daily[0], Date.now(), 21, 70);
    assert.ok(picks.length <= od.YAHOO_MAX_EXPIRY_FETCHES, "cap respected");
    assert.ok(picks.length >= 2, "multiple in-window expiries picked");
    const dtes = picks.map((e) => Math.ceil((e * 1000 - Date.now()) / (DAY_S * 1000)));
    assert.ok(dtes.every((d) => d >= 21 && d <= 70), `all picks inside the 21-70d window (got ${dtes})`);
    assert.ok(Math.max(...dtes) >= 59, `picks SPREAD across the window, not clustered at the front (got ${dtes})`);
    // without a min-days floor, near expiries are eligible (old behavior preserved)
    const noFloor = od._pickYahooExpiries(all, daily[0], Date.now(), 0, 70);
    assert.ok(noFloor.length <= od.YAHOO_MAX_EXPIRY_FETCHES);
    console.log("ok - expiry picking: daily-expiry chains spread evenly across the requested DTE window");
  }

  // 6) fall-through to Alpha Vantage when yahoo also fails (key already set)
  {
    od._resetForTests();
    process.env.ALPHAVANTAGE_API_KEY = "test.key.1"; // dotted placeholder — not a real credential
    const fetchFn = mkFetch([
      [/fc\.yahoo\.com/, raw("nope", 404, {})], // NO set-cookie → handshake fails
      [/alphavantage/, raw(AV_CHAIN_FIXTURE)],
    ]);
    const r = await od.getOptionsChain("IBM", { fetchFn }); // no userId → no alpaca
    assert.strictEqual(r.available, true, `AV last resort must serve: ${r.reason}`);
    assert.strictEqual(r.source, "alphavantage");
    assert.strictEqual(r.count, 3);
    assert.strictEqual(r.session, "2026-07-15");
    assert.ok(r.providers_skipped.some((s) => /^alpaca: no connected Alpaca account/.test(s)));
    assert.ok(r.providers_skipped.some((s) => /^yahoo: no Set-Cookie/.test(s)));
    delete process.env.ALPHAVANTAGE_API_KEY;
    console.log("ok - last resort: yahoo handshake failure falls through to the already-configured AV key");
  }

  // 7) ALL-fail honesty shape: every provider's reason, joined
  {
    od._resetForTests();
    const fetchFn = mkFetch([
      [/fc\.yahoo\.com/, () => { throw new Error("ENOTFOUND fc.yahoo.com"); }],
    ]);
    const r = await od.getOptionsChain("SPY", { fetchFn }); // no alpaca, yahoo throws, no AV key
    assert.strictEqual(r.available, false, "all providers failing must degrade, not throw");
    assert.ok(/alpaca: no connected Alpaca account/.test(r.reason), `reason names alpaca (got '${r.reason}')`);
    assert.ok(/yahoo: ENOTFOUND/.test(r.reason), "reason names yahoo's transport error");
    assert.ok(/alphavantage: ALPHAVANTAGE_API_KEY not configured/.test(r.reason), "reason names the missing AV key");
    assert.ok(r.reason.split(";").length >= 3, "reasons joined in provider order");
    console.log("ok - all-fail: { available:false, reason } carries every provider's honest reason");
  }

  // 8) cache: second call served from the 15-min cache (zero new fetches)
  {
    od._resetForTests();
    const optionsRe = /query2\.finance\.yahoo\.com/;
    const fetchFn = mkFetch([
      YAHOO_COOKIE_ROUTE, YAHOO_CRUMB_ROUTE,
      [optionsRe, raw(yahooPayload(EXP1_S, YAHOO_PAGE_1.optionChain.result[0].options[0].calls, []))],
    ]);
    const first = await od.getOptionsChain("SPY", { fetchFn });
    assert.strictEqual(first.available, true, `yahoo call must succeed: ${first.reason}`);
    assert.strictEqual(first.cached, false);
    const callsAfterFirst = fetchFn.count(optionsRe);
    const second = await od.getOptionsChain("SPY", { fetchFn });
    assert.strictEqual(second.cached, true, "second identical call must be a cache hit");
    assert.strictEqual(second.source, "yahoo");
    assert.strictEqual(fetchFn.count(optionsRe), callsAfterFirst, "cache hit must not re-fetch");
    console.log("ok - cache: symbol-level 15-min cache serves repeats without new upstream requests");
  }

  // 9) dated (historical) sessions: only AV can serve; live providers say why
  {
    od._resetForTests();
    const noKey = await od.getOptionsChain("IBM", { date: "2026-07-10", fetchFn: mkFetch([]) });
    assert.strictEqual(noKey.available, false);
    assert.ok(/alpaca: live snapshots only/.test(noKey.reason));
    assert.ok(/yahoo: live chain only/.test(noKey.reason));
    assert.ok(/ALPHAVANTAGE_API_KEY not configured/.test(noKey.reason));

    process.env.ALPHAVANTAGE_API_KEY = "test.key.1"; // dotted placeholder — not a real credential
    od._resetForTests();
    const avRe = /alphavantage.*date=2026-07-10/;
    const fetchFn = mkFetch([[avRe, raw(AV_CHAIN_FIXTURE)]]);
    const dated = await od.getOptionsChain("IBM", { date: "2026-07-10", fetchFn });
    assert.strictEqual(dated.available, true, `dated call must succeed: ${dated.reason}`);
    assert.strictEqual(dated.source, "alphavantage");
    assert.strictEqual(dated.date, "2026-07-10");
    assert.strictEqual(fetchFn.count(avRe), 1, "dated request carries &date= to AV only");
    delete process.env.ALPHAVANTAGE_API_KEY;
    console.log("ok - dated sessions: live providers skipped with reasons; AV serves history when its key exists");
  }

  // 10) input validation refused before any fetch
  {
    od._resetForTests();
    let fetched = 0;
    const spy = async () => { fetched++; return raw({}); };
    for (const badSym of ["", "TOO_LONG_SYMBOL_XX", "spy;drop", null]) {
      const r = await od.getOptionsChain(badSym, { fetchFn: spy });
      assert.strictEqual(r.available, false, `symbol ${JSON.stringify(badSym)} must be refused`);
      assert.ok(/invalid symbol/.test(r.reason));
    }
    const badDate = await od.getOptionsChain("SPY", { date: "07/15/2026", fetchFn: spy });
    assert.strictEqual(badDate.available, false);
    assert.ok(/invalid date/.test(badDate.reason));
    assert.strictEqual(fetched, 0, "invalid inputs never hit any provider");
    console.log("ok - input validation: bad symbols and non-ISO dates refused before any fetch");
  }

  // 11) AV free-tier rate limit still honored on the last-resort path
  {
    od._resetForTests();
    process.env.ALPHAVANTAGE_API_KEY = "test.key.1"; // dotted placeholder — not a real credential
    let avHits = 0;
    const fetchFn = mkFetch([
      [/fc\.yahoo\.com/, raw("nope", 404, {})], // yahoo unusable → AV each time
      [/alphavantage/, () => { avHits++; return raw(AV_CHAIN_FIXTURE); }],
    ]);
    for (let i = 0; i < od.RATE_MAX_PER_WINDOW; i++) {
      const r = await od.getOptionsChain(`SYM${i}`, { fetchFn });
      assert.strictEqual(r.available, true, `request ${i + 1} within the window must pass: ${r.reason}`);
      assert.strictEqual(r.source, "alphavantage");
    }
    const refused = await od.getOptionsChain("SYM99", { fetchFn });
    assert.strictEqual(refused.available, false, "6th AV request in the window must be refused");
    assert.ok(/rate limited/.test(refused.reason), `honest rate-limit reason (got '${refused.reason}')`);
    assert.strictEqual(avHits, od.RATE_MAX_PER_WINDOW, "the refused call must not hit AV upstream");
    const cachedWhileLimited = await od.getOptionsChain("SYM0", { fetchFn });
    assert.strictEqual(cachedWhileLimited.cached, true, "cache serves even when the window is exhausted");
    delete process.env.ALPHAVANTAGE_API_KEY;
    console.log("ok - AV rate limit: 5/min honored on the last-resort path, 6th refused, cache still serves");
  }

  // restore env
  od._resetForTests();
  if (savedKey === undefined) delete process.env.ALPHAVANTAGE_API_KEY;
  else process.env.ALPHAVANTAGE_API_KEY = savedKey;

  console.log("ok - options-data: all offline provider-chain suites passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
