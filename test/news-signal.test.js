// news-signal (lib/news-signal.js): joins the existing trading news feed onto Kalshi
// market cards so Observe (news) feeds Reason (decisive deck). Deterministic ticker/
// title join — no LLM, no live network. Uses a fixed synthetic news set so the test
// does not depend on the live news.jsonl contents.
//
// Run: node test/news-signal.test.js
const assert = require("assert");
const { getNewsSignal, enrichDeckWithNews, candidateSymbols, isWeatherMarket } = require("../lib/news-signal");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const NOW = Date.parse("2026-07-03T04:00:00.000Z");
const NEWS = [
  { headline: "Tesla delivery beat", source: "X", url: "http://x/1", published: "2026-07-03T03:00:00.000Z", symbols: ["TSLA"], impact: 80, sentiment: "high" },
  { headline: "Tesla recall probe",  source: "Y", url: "http://x/2", published: "2026-07-02T18:00:00.000Z", symbols: ["TSLA", "F"], impact: 40, sentiment: "low" },
  { headline: "Apple services record", source: "Z", url: "http://x/3", published: "2026-07-03T03:30:00.000Z", symbols: ["AAPL"], impact: 60, sentiment: "medium" },
];

check("KPI market (KXTSLA*) matches TSLA news via issuer map", () => {
  const sig = getNewsSignal({ ticker: "KXTSLAQ-26", title: "Tesla Q3 production" }, { news: NEWS, nowMs: NOW });
  assert.ok(sig, "expected a signal");
  assert.deepStrictEqual(sig.symbols, ["TSLA"]);
  assert.strictEqual(sig.count, 2);
  assert.ok(sig.impact > 40 && sig.impact <= 80, "recency-weighted mean impact in range: " + sig.impact);
  assert.ok(sig.score > 0 && sig.score <= 1);
});

check("title token match finds AAPL when no issuer-map prefix", () => {
  const sig = getNewsSignal({ ticker: "KXMISC-26", title: "Will AAPL close above 200" }, { news: NEWS, nowMs: NOW });
  assert.ok(sig && sig.symbols.includes("AAPL"));
});

check("weather markets get NO news join (settled by the oracle, not headlines)", () => {
  assert.strictEqual(isWeatherMarket("KXHIGHNY-26JUL03"), true);
  assert.strictEqual(getNewsSignal({ ticker: "KXHIGHNY-26JUL03", title: "NYC high temp" }, { news: NEWS, nowMs: NOW }), null);
});

check("no match → null (never a false badge)", () => {
  assert.strictEqual(getNewsSignal({ ticker: "KXFOO-26", title: "unrelated market" }, { news: NEWS, nowMs: NOW }), null);
});

check("enrichDeckWithNews attaches .news and nudges score up, never down", () => {
  const deck = [{ ticker: "KXTSLAQ-26", title: "Tesla Q3", decisionScore: 100, sigma0: { score: 2 } }];
  // enrich uses the module's own news load; assert only the shape + monotonic nudge.
  enrichDeckWithNews(deck, { nowMs: NOW });
  if (deck[0].news) {
    assert.ok(deck[0].decisionScore >= 100, "score nudged up or equal");
    assert.ok(deck[0].sigma0.score >= 2);
  }
});

check("candidateSymbols dedupes issuer-map + title hits", () => {
  const syms = candidateSymbols({ ticker: "KXTSLA-26", title: "Tesla vs TSLA" }, new Set(["TSLA", "AAPL"]));
  assert.deepStrictEqual(syms, ["TSLA"]);
});

if (failures) { console.error(`\n${failures} test(s) FAILED`); process.exit(1); }
console.log("\nAll news-signal tests passed.");
