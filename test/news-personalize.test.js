/**
 * test/news-personalize.test.js
 *
 * Per-user finance-news relevance (lib/news-personalize.js). The scorer is a
 * pure, transparent weighted sum of named signals — these tests pin the contract
 * that (a) the signals behave monotonically, (b) two users with different
 * watchlists get different orderings, and (c) every ranked item carries its
 * evidence (`relevanceWhy`). Network-free.
 *
 * Run with: npx jest test/news-personalize.test.js
 */

const { rankNewsForUser, scoreOne, DEFAULT_WEIGHTS, _internals } = require("../lib/news-personalize");
const { tickerScore, interestScore, recencyScore } = _internals;

const NOW = Date.parse("2026-06-29T18:00:00Z");
const ctx = (over = {}) => ({
  followed: new Set(["NVDA", "AAPL"]),
  interests: ["earnings"],
  weights: DEFAULT_WEIGHTS,
  sourceScore: () => 0.5,
  nowMs: NOW,
  ...over,
});

describe("signal primitives", () => {
  test("tickerScore: any followed hit ≥0.5, all-hit = 1, none = 0", () => {
    const f = new Set(["NVDA", "AAPL"]);
    expect(tickerScore(["NVDA"], f)).toBeGreaterThanOrEqual(0.5);
    expect(tickerScore(["NVDA", "AAPL"], f)).toBe(1);
    expect(tickerScore(["XYZ"], f)).toBe(0);
    expect(tickerScore([], f)).toBe(0);
    expect(tickerScore(["NVDA"], new Set())).toBe(0); // no watchlist → no signal
  });

  test("recencyScore: decays with age, neutral on unknown date", () => {
    const fresh = recencyScore("2026-06-29T17:00:00Z", NOW);
    const old = recencyScore("2026-06-20T17:00:00Z", NOW);
    expect(fresh).toBeGreaterThan(old);
    expect(recencyScore(null, NOW)).toBe(0.5);
  });

  test("interestScore: keyword overlap, 0 when no interests", () => {
    expect(interestScore("NVDA earnings beat", ["earnings"])).toBeGreaterThan(0);
    expect(interestScore("NVDA earnings beat", [])).toBe(0);
    expect(interestScore("a quiet day", ["earnings"])).toBe(0);
  });
});

describe("scoreOne", () => {
  test("a followed, high-impact, fresh, interest-matching item scores high and explains itself", () => {
    const { relevance, why } = scoreOne(
      { headline: "NVDA earnings beat", source: "benzinga", symbols: ["NVDA"], impact: 80, published: "2026-06-29T16:00:00Z" },
      ctx(),
      NOW,
    );
    expect(relevance).toBeGreaterThan(0.7);
    expect(why.join(" ")).toMatch(/NVDA/);
  });

  test("an unfollowed, low-impact item scores lower than a followed one", () => {
    const hi = scoreOne({ headline: "NVDA earnings beat", symbols: ["NVDA"], impact: 80, published: "2026-06-29T16:00:00Z" }, ctx(), NOW).relevance;
    const lo = scoreOne({ headline: "small cap note", symbols: ["XYZ"], impact: 20, published: "2026-06-29T16:00:00Z" }, ctx(), NOW).relevance;
    expect(hi).toBeGreaterThan(lo);
  });
});

describe("rankNewsForUser", () => {
  const recs = [
    { headline: "NVDA earnings beat", source: "benzinga", symbols: ["NVDA"], impact: 80, published: "2026-06-29T16:00:00Z" },
    { headline: "Random small-cap note", source: "benzinga", symbols: ["XYZ"], impact: 20, published: "2026-06-29T16:00:00Z" },
    { headline: "Bitcoin macro piece", source: "reuters", symbols: ["BTCUSD"], impact: 50, published: "2026-06-29T17:30:00Z" },
  ];

  test("ranks the user's followed ticker to the top", () => {
    const ranked = rankNewsForUser(recs, ctx());
    expect(ranked[0].headline).toMatch(/NVDA/);
    expect(ranked[0].relevanceWhy.length).toBeGreaterThan(0);
  });

  test("two users with different watchlists get different orderings", () => {
    const a = rankNewsForUser(recs, ctx({ followed: new Set(["NVDA"]), interests: [] }));
    const b = rankNewsForUser(recs, ctx({ followed: new Set(["BTCUSD"]), interests: [] }));
    expect(a[0].headline).toMatch(/NVDA/);
    expect(b[0].headline).toMatch(/Bitcoin/);
    expect(a.map((r) => r.headline)).not.toEqual(b.map((r) => r.headline));
  });

  test("does not mutate the input records", () => {
    const snapshot = JSON.parse(JSON.stringify(recs));
    rankNewsForUser(recs, ctx());
    expect(recs).toEqual(snapshot);
  });
});
