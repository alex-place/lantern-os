// #2276 — current-events / news queries were answered with historical Wikipedia
// pages. web-search-client now tries a freshness-first news source (Google News RSS)
// BEFORE the encyclopedic chain for news-intent queries. Deterministic: the real
// news/mcp/fallback network functions are swapped for fakes via the underscore-
// prefixed injection opts, which default to the real impls for every non-test caller.
//
// Run: node test/web-search-news.test.js
const assert = require("assert");
const {
  webSearch, _clearSearchCache, _isNewsQuery, _parseNewsRss, formatGroundingContext,
} = require("../lib/web-search-client");

let failures = 0;
async function check(name, fn) {
  try { await fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.stack || e.message}\n`); }
}

const SAMPLE_RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>Google News</title>
<item>
  <title>Oil prices climb as Strait of Hormuz tensions rise - Reuters</title>
  <link>https://news.google.com/rss/articles/abc123</link>
  <guid>abc123</guid>
  <pubDate>Mon, 13 Jul 2026 09:15:00 GMT</pubDate>
  <description>&lt;a href="x"&gt;Oil prices climb&lt;/a&gt; as shipping through the strait slows.</description>
  <source url="https://reuters.com">Reuters</source>
</item>
<item>
  <title><![CDATA[Tanker traffic drops sharply in the Gulf - Bloomberg]]></title>
  <link>https://news.google.com/rss/articles/def456</link>
  <pubDate>Mon, 13 Jul 2026 07:00:00 GMT</pubDate>
  <source url="https://bloomberg.com">Bloomberg</source>
</item>
</channel></rss>`;

(async () => {
  check("_isNewsQuery: current-events / geopolitical queries are news", () => {
    assert.ok(_isNewsQuery("recent geopolitical news strait of hormuz oil prices"));
    assert.ok(_isNewsQuery("latest headlines on the election"));
    assert.ok(_isNewsQuery("what's happening in the market today"));
    assert.ok(_isNewsQuery("ceasefire updates"));
  });

  check("_isNewsQuery: ordinary factual / how-to queries are NOT news", () => {
    assert.ok(!_isNewsQuery("what is the current node version"));
    assert.ok(!_isNewsQuery("how to install ffmpeg"));
    assert.ok(!_isNewsQuery("explain the strait of hormuz"));
    assert.ok(!_isNewsQuery(""));
  });

  check("_parseNewsRss: extracts dated items with source, decodes CDATA/entities", () => {
    const items = _parseNewsRss(SAMPLE_RSS, 5);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].url, "https://news.google.com/rss/articles/abc123");
    assert.ok(/Oil prices climb/.test(items[0].title));
    assert.strictEqual(items[0].published, "Mon, 13 Jul 2026 09:15:00 GMT");
    assert.strictEqual(items[0].source, "Reuters");
    assert.ok(/Reuters/.test(items[0].snippet), "snippet carries source for recency signal");
    assert.ok(/Bloomberg/.test(items[1].title), "CDATA title decoded");
  });

  check("_parseNewsRss: honors maxResults and skips items with no link", () => {
    assert.strictEqual(_parseNewsRss(SAMPLE_RSS, 1).length, 1);
    assert.strictEqual(_parseNewsRss("<rss><item><title>x</title></item></rss>", 5).length, 0);
  });

  await check("news query: news source is tried FIRST, before mcp/encyclopedic chain", async () => {
    _clearSearchCache();
    const order = [];
    const newsImpl = async () => { order.push("news"); return { success: true, results: [{ title: "fresh", url: "https://n/1", snippet: "s", published: "today" }], source: "news" }; };
    const mcpImpl = async () => { order.push("mcp"); return { success: true, results: [{ title: "wiki", url: "https://w/1" }] }; };
    const r = await webSearch("latest geopolitical news on oil", 5, { retries: 0, _newsImpl: newsImpl, _mcpImpl: mcpImpl, _fallbackImpls: [] });
    assert.strictEqual(r.source, "news");
    assert.deepStrictEqual(order, ["news"], "mcp must not be reached once news succeeds");
  });

  await check("news query: falls through to mcp when the news source fails", async () => {
    _clearSearchCache();
    const order = [];
    const newsImpl = async () => { order.push("news"); return { success: false, error: "news timeout", source: "news" }; };
    const mcpImpl = async () => { order.push("mcp"); return { success: true, results: [{ title: "wiki", url: "https://w/1" }] }; };
    const r = await webSearch("breaking news update", 5, { retries: 0, _newsImpl: newsImpl, _mcpImpl: mcpImpl, _fallbackImpls: [] });
    assert.strictEqual(r.success, true);
    assert.deepStrictEqual(order, ["news", "mcp"], "news tried first, then falls through");
  });

  await check("non-news query: news source is NOT tried (behavior unchanged)", async () => {
    _clearSearchCache();
    let newsCalls = 0;
    const newsImpl = async () => { newsCalls++; return { success: true, results: [{ title: "n", url: "https://n/1" }], source: "news" }; };
    const mcpImpl = async () => ({ success: true, results: [{ title: "doc", url: "https://d/1" }] });
    const r = await webSearch("how to install ffmpeg", 5, { retries: 0, _newsImpl: newsImpl, _mcpImpl: mcpImpl, _fallbackImpls: [] });
    assert.strictEqual(newsCalls, 0, "news source must be skipped for non-news queries");
    assert.strictEqual(r.source, "mcp");
  });

  check("formatGroundingContext: news results (no rank) get positional index + Published line", () => {
    const ctx = formatGroundingContext(_parseNewsRss(SAMPLE_RSS, 5), "hormuz oil");
    assert.ok(/\[1\] Oil prices climb/.test(ctx), "positional index, not [undefined]");
    assert.ok(!/\[undefined\]/.test(ctx));
    assert.ok(/Published: Mon, 13 Jul 2026/.test(ctx), "publish date surfaced to the model");
  });

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nall web-search-news checks passed");
})();
