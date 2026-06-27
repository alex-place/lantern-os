/**
 * test/discover-feeds-parse.test.js
 *
 * Feed parsing for the Explore "read" cards: parseFeed() turns an RSS/Atom
 * document into [{title, link, date, summary, image}]. The summary is clean
 * prose (entity-encoded markup decoded, then tags stripped) clipped to a
 * preview length, and the image is a best-effort lead thumbnail. These are pure
 * and network-free.
 *
 * Run with: npx jest test/discover-feeds-parse.test.js
 */

const { parseFeed, htmlToText, clip, firstImage } = require("../routes/discover-feeds");

describe("htmlToText", () => {
  test("decodes entity-encoded markup into prose, not tags", () => {
    expect(htmlToText("&lt;p&gt;Hello &amp; welcome&lt;/p&gt;")).toBe("Hello & welcome");
  });
  test("strips real tags and collapses whitespace", () => {
    expect(htmlToText("<p>One</p>\n\n  <p>two</p>")).toBe("One two");
  });
  test("drops <script>/<style> bodies", () => {
    expect(htmlToText("Hi<script>alert(1)</script> there")).toBe("Hi there");
  });
});

describe("clip", () => {
  test("returns the string unchanged when within the limit", () => {
    expect(clip("short", 200)).toBe("short");
  });
  test("trims to a word boundary and appends an ellipsis", () => {
    const out = clip("the quick brown fox jumps over the lazy dog", 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out).not.toMatch(/\s…$/); // no trailing space before the ellipsis
  });
});

describe("firstImage", () => {
  test("prefers media:thumbnail", () => {
    expect(firstImage('<media:thumbnail url="https://x/y.jpg" />')).toBe("https://x/y.jpg");
  });
  test("falls back to the first inline <img>", () => {
    expect(firstImage('<description>&lt;img src="https://a/b.png"&gt;</description>'))
      .toBe(""); // entity-encoded markup is not a real <img> tag → no image
    expect(firstImage('<content><img src="https://a/b.png"></content>')).toBe("https://a/b.png");
  });
  test("rejects non-http(s) urls", () => {
    expect(firstImage('<img src="javascript:alert(1)">')).toBe("");
  });
});

describe("parseFeed", () => {
  test("parses RSS items with summary + image", () => {
    const xml = `<rss><channel>
      <item>
        <title>Hello World</title>
        <link>https://example.com/post</link>
        <pubDate>Wed, 25 Jun 2026 10:00:00 GMT</pubDate>
        <description>&lt;p&gt;A short &lt;b&gt;intro&lt;/b&gt; to the post.&lt;/p&gt;</description>
        <media:thumbnail url="https://example.com/lead.jpg" />
      </item>
    </channel></rss>`;
    const out = parseFeed(xml);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      title: "Hello World",
      link: "https://example.com/post",
      summary: "A short intro to the post.",
      image: "https://example.com/lead.jpg",
    });
  });

  test("parses Atom entries", () => {
    const xml = `<feed>
      <entry>
        <title>Atom Title</title>
        <link href="https://example.com/atom" />
        <updated>2026-06-25T10:00:00Z</updated>
        <summary>Plain atom summary.</summary>
      </entry>
    </feed>`;
    const out = parseFeed(xml);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Atom Title");
    expect(out[0].link).toBe("https://example.com/atom");
    expect(out[0].summary).toBe("Plain atom summary.");
  });

  test("suppresses Hacker News link-metadata descriptions", () => {
    const xml = `<rss><channel>
      <item>
        <title>HN Story</title>
        <link>https://news.ycombinator.com/item?id=1</link>
        <description>Article URL: https://x.com Comments URL: https://news.ycombinator.com/item?id=1 Points: 42</description>
      </item>
    </channel></rss>`;
    expect(parseFeed(xml)[0].summary).toBe("");
  });

  test("emits empty summary/image when the feed carries neither", () => {
    const xml = `<rss><channel>
      <item><title>Bare</title><link>https://example.com/bare</link></item>
    </channel></rss>`;
    const out = parseFeed(xml);
    expect(out[0].summary).toBe("");
    expect(out[0].image).toBe("");
  });
});
