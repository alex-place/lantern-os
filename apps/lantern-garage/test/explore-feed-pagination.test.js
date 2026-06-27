/**
 * test/explore-feed-pagination.test.js
 *
 * Endless-scroll pagination helper (pickPage) for the Explore feed. Each page is
 * the top unseen cards (exploitation) plus a few exploration slots drawn from
 * deeper in the pool, so an infinite scroll keeps surfacing fresh content while
 * still leading with the highest-ranked cards.
 *
 * Run with: npx jest test/explore-feed-pagination.test.js
 */

const { pickPage } = require("../lib/explore-feed");

// A ranked pool: the first few are "scored" (engaged), the rest cold/unscored.
function pool(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: "c" + i, type: i % 3 === 0 ? "embed" : "read", source: "s" + (i % 4),
    scored: i < 3, score: 1 - i / n,
  }));
}

describe("pickPage", () => {
  test("returns exactly `limit` cards when the pool is larger", () => {
    const page = pickPage(pool(40), 9, 0.22);
    expect(page).toHaveLength(9);
  });

  test("returns the whole pool (no padding) when it is smaller than limit", () => {
    const small = pool(5);
    expect(pickPage(small, 9, 0.22)).toHaveLength(5);
  });

  test("a page has no duplicate cards", () => {
    const page = pickPage(pool(40), 9, 0.22);
    const ids = page.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("leads with the top-ranked (exploitation) card", () => {
    const page = pickPage(pool(40), 9, 0.22);
    expect(page[0].id).toBe("c0");
  });

  test("reserves exploration slots — page is not just the first N in order", () => {
    // With exploration, at least one card comes from beyond the top `limit`.
    const p = pool(40);
    const page = pickPage(p, 9, 0.34);
    const topIds = new Set(p.slice(0, 9).map((c) => c.id));
    const fromBeyond = page.filter((c) => !topIds.has(c.id));
    expect(fromBeyond.length).toBeGreaterThanOrEqual(1);
  });

  test("every returned card is a real member of the pool (no fabrication)", () => {
    const p = pool(40);
    const ids = new Set(p.map((c) => c.id));
    expect(pickPage(p, 9, 0.22).every((c) => ids.has(c.id))).toBe(true);
  });
});
