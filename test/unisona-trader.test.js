"use strict";
// Tests for lib/unisona-trader.js (#2556) — the evidence-cited research partner.
// Framework-free. Injects a fake loopback fetcher so the brief is built from known
// data and the receipt/citation contract can be asserted deterministically.

const assert = require("assert");
const ut = require("../lib/unisona-trader");

let failures = 0, pending = 6;
let queue = Promise.resolve();
function check(name, fn) {
  queue = queue.then(fn)
    .then(() => console.log(`  ok  - ${name}`))
    .catch((e) => { failures++; console.error(`  FAIL- ${name}\n      ${e.message}`); })
    .finally(() => { if (--pending === 0) {
      if (failures) { console.error(`\n${failures} unisona-trader test(s) failed`); process.exit(1); }
      console.log("\nAll unisona-trader tests passed.");
    } });
}

// Fake loopback: returns canned data per endpoint. records what was called.
function fakeGet(calls) {
  return async (pathAndQuery) => {
    calls.push(pathAndQuery);
    if (pathAndQuery.includes("/symbol-stats")) {
      return { ticker: "SPY", price: 512.34, returns: { "1d": 0.42, "5d": -1.1, "30d": 4.2, "90d": 8.9 }, ytd: 12.3, sma50: 500, avgVol: 74000000, available: true };
    }
    if (pathAndQuery.includes("/symbol-info")) return { name: "SPDR S&P 500 ETF", exchange: "NYSE Arca", asset_class: "etf" };
    if (pathAndQuery.includes("/market-status")) return { vix: 14.2, regime: "calm", spy_trend: "up", market_open: true, session: "open" };
    if (pathAndQuery.includes("/news/recent")) return [{ headline: "S&P 500 edges higher", source: "MT Newswires", sentiment: "neutral", url: "https://x" }];
    return null;
  };
}

check("invalid symbol is refused, no fetches", async () => {
  const calls = [];
  const r = await ut.researchBrief("not a ticker", { get: fakeGet(calls) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "invalid_symbol");
  assert.strictEqual(calls.length, 0);
});

check("brief has the expected sections + a disclaimer", async () => {
  const r = await ut.researchBrief("SPY", { get: fakeGet([]), now: "2026-07-17T00:00:00Z" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.symbol, "SPY");
  assert.ok(r.disclaimer && /not a licensed/i.test(r.disclaimer));
  const titles = r.sections.map((s) => s.title);
  for (const t of ["Price & trend", "Identity", "Market context", "Recent news", "Options"]) {
    assert.ok(titles.includes(t), `missing section ${t}`);
  }
});

check("EVERY quantitative claim traces to a successful receipt (acceptance #2)", async () => {
  const r = await ut.researchBrief("SPY", { get: fakeGet([]) });
  const claims = r.sections.flatMap((s) => s.claims || []);
  assert.ok(claims.length >= 6, "expected several quantitative claims");
  for (const c of claims) {
    assert.ok(c.source, `claim "${c.claim}" has no source`);
    const rec = r.receipts.find((x) => x.id === c.source);
    assert.ok(rec && rec.ok, `claim "${c.claim}" source ${c.source} not a successful receipt`);
  }
  assert.strictEqual(r.citation.fullyCited, true);
  assert.strictEqual(r.citation.backedByReceipt, r.citation.quantitativeClaims);
});

check("NO advice imperatives anywhere in the brief (research partner, not advisor)", async () => {
  const r = await ut.researchBrief("SPY", { get: fakeGet([]) });
  const text = JSON.stringify(r).toLowerCase();
  // No recommendation/imperative language. (Data words like "up"/"above"/"trend" are fine.)
  const banned = [
    /\byou should (buy|sell|hold|short)\b/, /\bwe recommend\b/, /\brecommendation\b/,
    /\bbuy now\b/, /\bsell now\b/, /\bstrong buy\b/, /\bstrong sell\b/, /\bprice target\b/,
    /\bshould buy\b/, /\bshould sell\b/,
  ];
  for (const re of banned) assert.ok(!re.test(text), `brief contains advice language: ${re}`);
  // the disclaimer explicitly disclaims advice
  assert.ok(/does not tell you to buy, sell, or hold/i.test(r.disclaimer));
});

check("options are honestly marked unavailable, never fabricated", async () => {
  const r = await ut.researchBrief("SPY", { get: fakeGet([]) });
  const opt = r.sections.find((s) => s.title === "Options");
  assert.strictEqual(opt.available, false);
  assert.ok(/not yet wired/i.test(opt.note));
  assert.ok(!opt.claims, "options section carries no fabricated quantitative claims");
  assert.deepStrictEqual(r.dataGaps, ["options_chain"]);
});

check("a failed data call drops its claims but the brief still returns", async () => {
  const partialGet = async (p) => (p.includes("symbol-stats") ? null : (p.includes("market-status") ? { vix: 14 } : null));
  const r = await ut.researchBrief("SPY", { get: partialGet });
  assert.strictEqual(r.ok, true);
  assert.ok(!r.sections.some((s) => s.title === "Price & trend"), "no price section when stats failed");
  assert.ok(r.sections.some((s) => s.title === "Market context"), "market context still present");
  // whatever claims survive are still fully cited
  assert.strictEqual(r.citation.fullyCited, true);
});
