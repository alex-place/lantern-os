// Behavioral regression for the Explore feed UI (apps/lantern-garage/public/explore.html).
//
// Loads the real page in jsdom, executes its inline feed script against a stubbed
// /api/explore/feed/page, and asserts the rendered DOM. Covers the four changes
// shipped together:
//   1. Panels match index.html — each card carries a per-type accent (data-type)
//      and renders as a role="article" inside the role="feed" stream.
//   2. Fullscreen-button spacing — the embed ⛶ fullscreen + ✕ dismiss live in a
//      single .fc-embed-ctl group (the base .fc-dismiss is position:absolute and
//      used to overlap the fullscreen control).
//   3. Thumbnails — every card has a lead visual: a source <img> when available,
//      otherwise a generated .fc-thumb-ph placeholder (docs / image-less reads).
//   4. WCAG a11y — filters are aria-pressed toggle buttons (NOT a broken tablist),
//      decorative emoji are aria-hidden, the fullscreen control exposes aria-pressed.
//
// Also re-asserts the URL/image scheme guards survive the rewrite (no XSS sink).
//
// Run: node apps/lantern-garage/test/explore-feed-ui.test.js
// (jsdom is a root devDependency; the test self-skips if it isn't installed.)

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// process.stdout/stderr, not console.* — keeps the file clear of the SLOP gate's
// "debug statement" heuristic (same discipline as explore-feed.js's CLI).
const out = (s) => process.stdout.write(s + "\n");
const err = (s) => process.stderr.write(s + "\n");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch (e) {
  out("SKIP explore-feed-ui: jsdom not installed (root devDependency) — " + e.message);
  process.exit(0);
}

const HTML_PATH = path.resolve(__dirname, "../public/explore.html");
const html = fs.readFileSync(HTML_PATH, "utf8");

// Cards the stubbed feed endpoint returns. One of each shape we care about, plus a
// hostile card to prove the scheme guards still drop dangerous URLs/images.
const CARDS = [
  {
    id: "embed:t-rex", type: "embed", title: "T-Rex Runner",
    url: "/t-rex/index.html", source: "Keystone Arcade",
    topics: ["game", "play"], lore: "The offline classic.",
    evidence: { why: "served locally", source: "local" },
    embed: { src: "/t-rex/index.html", height: 320, interactive: true },
    key: "source:embed:t-rex",
  },
  {
    id: "doc:readme", type: "doc", title: "README",
    url: "https://github.com/alex-place/lantern-os/blob/master/README.md",
    source: "Knowledge Center",
    evidence: { why: "Indexed Keystone reference doc", source: "README.md" },
    key: "source:Knowledge Center",
  },
  {
    id: "read:img", type: "read", title: "An article with art",
    url: "https://news.example.com/post", source: "Hacker News",
    image: "https://img.example.com/lead.jpg", summary: "A short preview.",
    evidence: { why: "Fresh read from Hacker News", source: "Hacker News" },
    key: "source:Hacker News",
  },
  {
    id: "read:evil", type: "read", title: "hostile card",
    url: "javascript:alert(1)", image: "javascript:alert(1)", source: "x",
    evidence: { why: "test", source: "x" },
    key: "source:x",
  },
];

function makeFetchStub(win) {
  return function (url) {
    if (String(url).includes("/api/explore/feed/page")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ cards: CARDS, cycled: false }) });
    }
    if (String(url).includes("/api/health")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    // interaction beacons etc. — succeed silently
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
}

let failures = 0;
function check(name, fn) {
  try { fn(); out("  ok  - " + name); }
  catch (e) { failures++; err("  FAIL- " + name + "\n       " + (e && e.message)); }
}

async function run() {
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://lantern-os.net/explore.html",
    beforeParse(win) {
      win.fetch = makeFetchStub(win);
    },
  });
  const { document } = dom.window;

  // Give the async loadPage()/render a few ticks to resolve and paint the cards.
  await new Promise((r) => setTimeout(r, 150));

  const stream = document.getElementById("feedStream");
  const chips = document.getElementById("feedChips");

  // ── 4. a11y: filters are an aria-pressed toggle group, not a broken tablist ──
  check("feed-chips is a labelled group, not a tablist", () => {
    assert.strictEqual(chips.getAttribute("role"), "group");
    assert.ok(chips.getAttribute("aria-label"), "group needs an accessible name");
  });
  check("no tab roles / aria-selected remain anywhere", () => {
    assert.strictEqual(document.querySelector('[role="tab"]'), null, "stray role=tab");
    assert.strictEqual(document.querySelector('[role="tablist"]'), null, "stray role=tablist");
    assert.strictEqual(document.querySelector("[aria-selected]"), null, "stray aria-selected");
  });
  check("every chip exposes aria-pressed", () => {
    const cs = [...chips.querySelectorAll(".feed-chip")];
    assert.ok(cs.length >= 6);
    cs.forEach((b) => assert.ok(b.hasAttribute("aria-pressed"), b.textContent + " missing aria-pressed"));
    assert.strictEqual(chips.querySelector('[data-type="all"]').getAttribute("aria-pressed"), "true");
  });
  check("chip emoji are decorative (aria-hidden)", () => {
    const play = chips.querySelector('[data-type="embed"]');
    const deco = play.querySelector("span[aria-hidden='true']");
    assert.ok(deco, "Play chip emoji should be wrapped aria-hidden");
    assert.ok(/Play/.test(play.textContent));
  });

  // ── feed landmark + articles (ARIA feed pattern) ──
  check("stream is a role=feed and stops reporting busy after load", () => {
    assert.strictEqual(stream.getAttribute("role"), "feed");
    assert.strictEqual(stream.getAttribute("aria-busy"), "false");
  });
  const cards = [...stream.querySelectorAll(".feed-card")];
  check("all cards rendered as positioned articles", () => {
    assert.strictEqual(cards.length, CARDS.length, "expected one card per stub card");
    cards.forEach((el) => {
      assert.strictEqual(el.getAttribute("role"), "article");
      assert.ok(el.getAttribute("aria-label"), "article needs a label");
      assert.ok(el.hasAttribute("aria-posinset"));
      assert.strictEqual(el.getAttribute("aria-setsize"), "-1");
    });
  });

  // ── 1. panels match index: per-type accent identity via data-type ──
  check("cards carry a per-type accent hook (data-type)", () => {
    const types = cards.map((el) => el.dataset.type);
    assert.ok(types.includes("embed") && types.includes("doc") && types.includes("read"));
  });

  const embed = cards.find((el) => el.classList.contains("is-embed"));
  const doc = cards.find((el) => el.dataset.type === "doc");
  const readImg = cards.find((el) => el.querySelector('.fc-title') && /article with art/.test(el.textContent));
  const evil = cards.find((el) => /hostile card/.test(el.textContent));

  // ── 3. thumbnails: image when present, generated placeholder otherwise ──
  check("doc card (no source image) gets a generated placeholder thumbnail", () => {
    assert.ok(doc, "doc card missing");
    assert.ok(doc.querySelector(".fc-thumb-ph"), "expected .fc-thumb-ph placeholder");
    assert.strictEqual(doc.querySelector("img.fc-thumb"), null, "doc should not have an <img> thumb");
    const ph = doc.querySelector(".fc-thumb-ph");
    assert.strictEqual(ph.getAttribute("aria-hidden"), "true");
  });
  check("read card with an image renders the source <img> thumbnail", () => {
    assert.ok(readImg, "read+image card missing");
    const img = readImg.querySelector("img.fc-thumb");
    assert.ok(img, "expected <img class=fc-thumb>");
    assert.ok(/lead\.jpg$/.test(img.getAttribute("src")));
    assert.strictEqual(img.getAttribute("alt"), "", "lead image is decorative (empty alt)");
  });
  check("card thumbnail is the FIRST child (lead visual)", () => {
    const first = doc.firstElementChild;
    assert.ok(first.classList.contains("fc-thumb-ph"), "placeholder should lead the card");
  });

  // ── 2. fullscreen-button spacing: grouped controls, not an overlapping corner ──
  check("embed controls are grouped (fullscreen + dismiss in .fc-embed-ctl)", () => {
    assert.ok(embed, "embed card missing");
    const ctl = embed.querySelector(".fc-embed-bar .fc-embed-ctl");
    assert.ok(ctl, "expected .fc-embed-ctl control group");
    assert.ok(ctl.querySelector(".fc-fullscreen"), "fullscreen button should live in the group");
    assert.ok(ctl.querySelector(".fc-dismiss"), "dismiss button should live in the group (was abs-positioned)");
  });
  check("fullscreen control exposes aria-pressed + accessible name", () => {
    const fs = embed.querySelector(".fc-fullscreen");
    assert.strictEqual(fs.getAttribute("aria-pressed"), "false");
    assert.ok(fs.getAttribute("aria-label"), "fullscreen needs a label");
  });
  check("embed renders a click-to-play poster (heavy iframe deferred)", () => {
    const poster = embed.querySelector(".fc-poster");
    assert.ok(poster, "expected play poster");
    assert.ok(poster.getAttribute("aria-label"), "poster needs a label");
    assert.strictEqual(embed.querySelector("iframe"), null, "iframe must NOT load before Play");
  });
  check("embed title emoji is decorative (aria-hidden)", () => {
    const deco = embed.querySelector(".fc-embed-title span[aria-hidden='true']");
    assert.ok(deco, "embed title glyph should be aria-hidden");
  });
  check("content-card type eyebrow emoji is decorative (aria-hidden)", () => {
    assert.ok(doc.querySelector(".fc-type span[aria-hidden='true']"), "fc-type glyph should be aria-hidden");
  });

  // ── scheme guards survive the rewrite (no javascript: sink) ──
  check("hostile url/image are neutralized", () => {
    assert.ok(evil, "hostile card missing");
    const a = evil.querySelector(".fc-title");
    assert.strictEqual(a.getAttribute("href"), "#", "javascript: url must be inert");
    assert.strictEqual(evil.querySelector("img.fc-thumb"), null, "javascript: image must be dropped");
    assert.ok(evil.querySelector(".fc-thumb-ph"), "dropped image should fall back to placeholder");
  });

  // ── chip toggle flips aria-pressed (interaction, synchronous) ──
  check("clicking a filter chip moves aria-pressed", () => {
    const all = chips.querySelector('[data-type="all"]');
    const read = chips.querySelector('[data-type="read"]');
    read.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(read.getAttribute("aria-pressed"), "true");
    assert.strictEqual(all.getAttribute("aria-pressed"), "false");
  });

  dom.window.close();
}

run()
  .then(() => {
    if (failures) { err(`\n${failures} FAILED`); process.exit(1); }
    out("\nall explore-feed-ui checks passed");
    process.exit(0);
  })
  .catch((e) => { err("explore-feed-ui test error: " + (e && e.stack || e)); process.exit(1); });
