/**
 * test/explore-feed-diversity.test.js
 *
 * Explore feed diversity rerank (#1220 — "no single source dominates a batch").
 *
 * The PCSF leaderboard scores every card by its SOURCE key, so all cards from
 * one engaged source inherit the same score and wall the top of the feed (e.g.
 * eight "Flourishing" belief cards in a row). diversityRerank() re-orders the
 * scored list with a rank-based, scale-invariant diversity penalty so a strong
 * source still leads but then yields the next slot to something different.
 *
 * Run with: npx jest test/explore-feed-diversity.test.js
 */

const { diversityRerank } = require("../lib/explore-feed");

// Helper: longest run of consecutive cards sharing a key.
function maxRun(cards, keyFn) {
  let max = 0, cur = 0, prev = Symbol("none");
  for (const c of cards) {
    const k = keyFn(c);
    cur = k === prev ? cur + 1 : 1;
    prev = k;
    if (cur > max) max = cur;
  }
  return max;
}

// A feed already in score order, shaped like production: one runaway source (A,
// e.g. the eight Flourishing belief cards that walled the live feed at score
// 10000) followed by a mix of multi-card sources at the cold prior. This mirrors
// the real /api/explore/feed shape — a heavy source among many others — where
// the wall CAN be interleaved (unlike a degenerate feed that is mostly one
// source, which is information-theoretically impossible to de-cluster).
function walledFeed() {
  const wall = Array.from({ length: 8 }, (_, i) => ({
    id: "a" + i, type: "belief", source: "A", score: 10000,
  }));
  const others = [["B", "embed", 3], ["C", "read", 5], ["D", "build", 5],
                  ["E", "doc", 5], ["F", "watch", 3], ["G", "read", 4], ["H", "embed", 2]];
  const rest = [];
  for (const [src, type, n] of others) {
    for (let i = 0; i < n; i++) rest.push({ id: src + i, type, source: src, score: 0.5 });
  }
  return [...wall, ...rest];
}

describe("diversityRerank", () => {
  test("breaks a single-source wall (no >2 consecutive from one source)", () => {
    const out = diversityRerank(walledFeed());
    expect(maxRun(out, (c) => c.source)).toBeLessThanOrEqual(2);
  });

  test("no single source dominates the top of the batch", () => {
    const out = diversityRerank(walledFeed());
    const head = out.slice(0, 6);
    const fromA = head.filter((c) => c.source === "A").length;
    expect(fromA).toBeLessThanOrEqual(2); // was 6/6 before the pass
  });

  test("the strongest card still leads (exploitation preserved)", () => {
    const out = diversityRerank(walledFeed());
    expect(out[0].source).toBe("A");
  });

  test("is a permutation — no cards added or dropped", () => {
    const input = walledFeed();
    const out = diversityRerank(input);
    expect(out).toHaveLength(input.length);
    expect(out.map((c) => c.id).sort()).toEqual(input.map((c) => c.id).sort());
  });

  test("is scale-invariant — a huge score can't wall the feed", () => {
    // Same shape, but the wall source's score is astronomically larger. Because
    // ranking is by position not magnitude, the output order is identical.
    const normal = walledFeed();
    const huge = walledFeed().map((c) => (c.source === "A" ? { ...c, score: 1e12 } : c));
    expect(diversityRerank(huge).map((c) => c.id))
      .toEqual(diversityRerank(normal).map((c) => c.id));
  });

  test("EXPLORE_DIVERSITY=0 disables the pass (identity)", () => {
    const prev = process.env.EXPLORE_DIVERSITY;
    process.env.EXPLORE_DIVERSITY = "0";
    try {
      const input = walledFeed();
      expect(diversityRerank(input).map((c) => c.id)).toEqual(input.map((c) => c.id));
    } finally {
      if (prev === undefined) delete process.env.EXPLORE_DIVERSITY;
      else process.env.EXPLORE_DIVERSITY = prev;
    }
  });

  test("returns short lists untouched", () => {
    const tiny = [{ id: "x", type: "read", source: "A", score: 1 }];
    expect(diversityRerank(tiny)).toEqual(tiny);
    expect(diversityRerank([])).toEqual([]);
  });
});
