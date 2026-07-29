/**
 * test/web-search-snippet-quality.test.js
 *
 * Grounding is only as good as what the model actually receives. _stripTags used to
 * strip-then-decode, which is a no-op on any feed that ENTITY-ENCODES its markup (Google
 * News encodes descriptions as `&lt;a href=…&gt;`): nothing was stripped, then the decode
 * step re-created live HTML. Snippets arrived as ~400 chars of anchor markup wrapping a
 * base64 redirect URL — with the only real content, the headline, duplicated from `title`.
 * A grounded search turn therefore had almost nothing to ground ON, and answered with a
 * fluent, made-up summary instead of the actual top story.
 *
 * These tests pin the contract: what reaches the model is clean, non-redundant text.
 *
 * Run with: npx jest test/web-search-snippet-quality.test.js
 */
const { _parseNewsRss, _isNewsQuery, _isPrivateHostname, _enrichWithOgImages } = require("../lib/web-search-client");

// Shaped exactly like a real Google News RSS item: entity-encoded HTML in <description>,
// a base64 redirect <link>, and a description that just repeats the headline.
const RSS = `<rss><channel>
<item>
  <title>NASA fuels its next-gen Roman Space Telescope for August launch - Space</title>
  <link>https://news.google.com/rss/articles/CBMiogFBVV95cUxQZTBMTEZaLTdIbk9paXlBWGtodmdQ?oc=5</link>
  <pubDate>Tue, 28 Jul 2026 21:00:00 GMT</pubDate>
  <source url="https://space.com">Space</source>
  <description>&lt;a href="https://news.google.com/rss/articles/CBMiogFBVV95cUxQZTBMTEZaLTdIbk9paXlBWGtodmdQ?oc=5" target="_blank"&gt;NASA fuels its next-gen Roman Space Telescope for August launch&lt;/a&gt;&nbsp;&lt;font color="#6f6f6f"&gt;Space&lt;/font&gt;</description>
</item>
<item>
  <title>Second story with a real summary</title>
  <link>https://news.google.com/rss/articles/DIFFERENT?oc=5</link>
  <pubDate>Wed, 29 Jul 2026 10:00:00 GMT</pubDate>
  <source url="https://example.com">Example</source>
  <description>&lt;p&gt;An actual description that adds information beyond the headline.&lt;/p&gt;</description>
</item>
</channel></rss>`;

describe("news snippets reaching the model", () => {
  const results = _parseNewsRss(RSS, 5);

  test("parses both items with title, url and date", () => {
    expect(results).toHaveLength(2);
    expect(results[0].title).toMatch(/Roman Space Telescope/);
    expect(results[0].url).toMatch(/^https:\/\/news\.google\.com/);
    expect(results[0].published).toBe("Tue, 28 Jul 2026 21:00:00 GMT");
  });

  test("NO markup survives into any snippet (the regression that caused made-up answers)", () => {
    for (const r of results) {
      expect(r.snippet).not.toMatch(/<[a-z/][^>]*>/i);   // no live tags
      expect(r.snippet).not.toMatch(/&lt;|&gt;|&amp;|&nbsp;/); // no leftover entities
      expect(r.snippet).not.toMatch(/href=|target=|font color/i);
    }
  });

  test("the base64 redirect URL is never dumped into the snippet body", () => {
    // It belongs in `url`, not spent as ~200 chars of the model's context.
    expect(results[0].snippet).not.toMatch(/CBMiogFBVV95cUxQ/);
    expect(results[0].url).toMatch(/CBMiogFBVV95cUxQ/);
  });

  test("a description that merely repeats the headline is dropped, not duplicated", () => {
    expect(results[0].snippet).toBe("Tue, 28 Jul 2026 21:00:00 GMT · Space");
  });

  test("a description that ADDS information is kept", () => {
    expect(results[1].snippet).toMatch(/An actual description that adds information/);
    expect(results[1].snippet).toMatch(/Wed, 29 Jul 2026/);
  });

  test("every snippet carries the date so the model can see the article is recent", () => {
    for (const r of results) expect(r.snippet).toMatch(/\d{4}/);
  });
});

describe("citable metadata (so the model can attribute, not just assert)", () => {
  const results = _parseNewsRss(RSS, 5);

  test("the publisher's REAL domain is captured from the <source url> attribute", () => {
    // <link> is an opaque base64 Google redirect, so without this the model has no citable
    // domain and ends up writing "per Space" with no link.
    expect(results[0].publisherUrl).toBe("https://space.com");
    expect(results[0].publisher).toBe("Space");
  });

  test("the redirect link is still preserved as the result url", () => {
    expect(results[0].url).toMatch(/^https:\/\/news\.google\.com\/rss\/articles\//);
  });

  test("a missing source url degrades to null rather than a broken link", () => {
    const noSrc = `<rss><channel><item>
      <title>No source attr</title>
      <link>https://example.com/a</link>
      <pubDate>Wed, 29 Jul 2026 10:00:00 GMT</pubDate>
      <description>Body text.</description>
    </item></channel></rss>`;
    const r = _parseNewsRss(noSrc, 1)[0];
    expect(r.publisherUrl).toBeNull();
    expect(r.url).toBe("https://example.com/a");
  });
});

describe("og:image enrichment guards", () => {
  // Result URLs come from an external feed, so the fetcher must never be pointed at the
  // local network. (The live fetch path itself is exercised against real article pages;
  // it can't be tested against a local server precisely BECAUSE of this guard.)
  test.each(["localhost", "127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0"])(
    "refuses private/loopback host: %s", (h) => expect(_isPrivateHostname(h)).toBe(true));

  test.each(["space.com", "en.wikipedia.org", "8.8.8.8"])(
    "allows public host: %s", (h) => expect(_isPrivateHostname(h)).toBe(false));

  test("limit 0 disables enrichment entirely (no requests attempted)", async () => {
    const rows = [{ url: "https://example.com/a" }];
    await _enrichWithOgImages(rows, 0);
    expect(rows[0].image).toBeUndefined();
  });

  test("results that already carry an image are skipped", async () => {
    const rows = [{ url: "https://example.com/a", image: "https://cdn/x.png" }];
    await _enrichWithOgImages(rows, 3);
    expect(rows[0].image).toBe("https://cdn/x.png");   // untouched, no refetch
  });

  test("empty / malformed input never throws", async () => {
    await expect(_enrichWithOgImages([], 3)).resolves.toEqual([]);
    await expect(_enrichWithOgImages(null, 3)).resolves.toBeNull();
    await expect(_enrichWithOgImages([{}, null], 0)).resolves.toBeTruthy();
  });
});

describe("freshness routing (_isNewsQuery)", () => {
  test.each([
    "latest news about NASA",
    "who won the game last night",
    "what happened yesterday",
    "recent geopolitical news strait of hormuz oil prices",
  ])("routes to fresh news: %s", (q) => expect(_isNewsQuery(q)).toBe(true));

  // Ordinary factual/how-to grounding must stay on the existing chain.
  test.each([
    "how to install node",
    "what is a black hole",
    "current node version",
    "explain recursion",
  ])("stays on the reference chain: %s", (q) => expect(_isNewsQuery(q)).toBe(false));
});
