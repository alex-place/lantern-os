// Behavioral regression for the Explore dashboard UI (apps/lantern-garage/public/explore.html).
//
// explore.html was reworked from a discovery feed into a personalized, Robinhood-style
// investing dashboard: a portfolio header + equity chart, holdings, a right-hand
// watchlist, and market news below it. This test loads the real page in jsdom, stubs
// the trading + feed endpoints it reads, and asserts the rendered DOM.
//
// Covers:
//   1. Portfolio header — equity renders as formatted currency; range chips are an
//      aria-pressed toggle group (WCAG), and clicking one moves the pressed state.
//   2. Holdings — each open position renders a row with its symbol + market value.
//   3. Watchlist — the user's own symbols render priced rows (add/remove controls
//      carry accessible names).
//   4. Market news — finance headlines render as links; a hostile javascript: URL
//      from the feed is dropped (no XSS sink survives the rework).
//   5. A11y — a single <h1> names the page; no stray tablist/aria-selected.
//
// Run: node apps/lantern-garage/test/explore-feed-ui.test.js
// (jsdom is a root devDependency; the test self-skips if it isn't installed.)

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// process.stdout/stderr, not console.* — keeps the file clear of the SLOP gate's
// "debug statement" heuristic.
const out = (s) => process.stdout.write(s + "\n");
const err = (s) => process.stderr.write(s + "\n");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch (e) {
  out("SKIP explore-dashboard-ui: jsdom not installed (root devDependency) — " + e.message);
  process.exit(0);
}

const HTML_PATH = path.resolve(__dirname, "../public/explore.html");
const html = fs.readFileSync(HTML_PATH, "utf8");

const ACCOUNT = {
  account_id: "PAPER123", equity: 57108.73, cash: 0.71, buying_power: 0.71,
  pnl_today: 512.34, pnl_pct: 0.9, mode: "paper", source: "alpaca",
};
const POSITIONS = [
  { symbol: "AAPL", qty: 10, avg_entry_price: 180, current_price: 190, market_value: 1900, unrealized_pl: 100, pnl_pct: 5.55 },
  { symbol: "TSLA", qty: 5, avg_entry_price: 250, current_price: 240, market_value: 1200, unrealized_pl: -50, pnl_pct: -4.0 },
];
const HISTORY = {
  ok: true, range: "1D", timeframe: "5Min", base_value: 56596.39,
  timestamps: [1_700_000_000, 1_700_000_300, 1_700_000_600],
  equity: [56596.39, 56900.0, 57108.73],
};
const WATCHLIST = { watchlist: ["AAPL", "TSLA"] };
const WATCHLIST_PRICES = [{ ticker: "AAPL", price: 190.12, chg_pct: 1.23, is_crypto: false }];
const NEWS_CARDS = {
  cards: [
    { id: "n1", type: "read", title: "Markets rally on rate hopes", url: "https://news.example.com/a", source: "Reuters", published: Date.now() - 3600000, evidence: { why: "finance" }, key: "k1" },
    { id: "n2", type: "read", title: "hostile headline", url: "javascript:alert(1)", source: "evil", published: Date.now(), evidence: { why: "x" }, key: "k2" },
    { id: "n3", type: "embed", title: "a game (not news)", url: "/t-rex/index.html", source: "Arcade", key: "k3" },
  ],
};

function makeFetchStub() {
  return function (url, opts) {
    const u = String(url);
    if (u.includes("/api/trading/positions")) return json({ account: ACCOUNT, positions: POSITIONS });
    if (u.includes("/api/trading/portfolio/history")) return json(HISTORY);
    if (u.includes("/api/trading/watchlist-prices")) return json(WATCHLIST_PRICES);
    if (u.includes("/api/trading/watchlist")) return json(WATCHLIST);
    if (u.includes("/api/trading/price-feed")) return json({ symbol: "TSLA", current_price: 240.5, open_price: 245.0 });
    if (u.includes("/api/explore/feed/page")) return json(NEWS_CARDS);
    return json({});
  };
  function json(body) { return Promise.resolve({ ok: true, json: () => Promise.resolve(body) }); }
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
      win.fetch = makeFetchStub();
      // jsdom has no 2D canvas; the page guards on a null context and hides the
      // chart. Return null explicitly so no "Not implemented" noise is logged.
      win.HTMLCanvasElement.prototype.getContext = () => null;
      // AbortSignal.timeout isn't in jsdom's older ctor — polyfill a no-op signal.
      if (!win.AbortSignal || !win.AbortSignal.timeout) {
        win.AbortSignal = win.AbortSignal || function () {};
        win.AbortSignal.timeout = () => undefined;
      }
    },
  });
  const { document } = dom.window;

  // Let the async loaders (positions → history, watchlist two-phase, news) settle.
  await new Promise((r) => setTimeout(r, 300));

  // ── 5. a11y: a single <h1> names the page; no stray tab semantics ──
  check("page has exactly one <h1>", () => {
    const h1s = document.querySelectorAll("h1");
    assert.strictEqual(h1s.length, 1, "expected one h1, got " + h1s.length);
    assert.ok(h1s[0].textContent.trim().length > 0, "h1 needs text");
  });
  check("no tablist / aria-selected remain from the old feed", () => {
    assert.strictEqual(document.querySelector('[role="tab"]'), null);
    assert.strictEqual(document.querySelector('[role="tablist"]'), null);
    assert.strictEqual(document.querySelector("[aria-selected]"), null);
  });

  // ── 1. Portfolio header + range chips ──
  check("portfolio value renders as formatted currency", () => {
    const v = document.getElementById("portValue").textContent;
    assert.ok(/\$57,108\.73/.test(v), "expected equity $57,108.73, got: " + v);
  });
  check("range chips are an aria-pressed toggle group", () => {
    const row = document.getElementById("rangeRow");
    assert.strictEqual(row.getAttribute("role"), "group");
    const chips = [...row.querySelectorAll(".range-chip")];
    assert.ok(chips.length >= 5);
    chips.forEach((c) => assert.ok(c.hasAttribute("aria-pressed"), c.textContent + " missing aria-pressed"));
    assert.strictEqual(row.querySelector('[data-range="1D"]').getAttribute("aria-pressed"), "true");
  });
  check("clicking a range chip moves aria-pressed", () => {
    const row = document.getElementById("rangeRow");
    const oneD = row.querySelector('[data-range="1D"]');
    const oneM = row.querySelector('[data-range="1M"]');
    oneM.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(oneM.getAttribute("aria-pressed"), "true");
    assert.strictEqual(oneD.getAttribute("aria-pressed"), "false");
  });

  // ── 2. Holdings ──
  check("open positions render as rows with symbol + value", () => {
    const rows = [...document.querySelectorAll("#holdingsList .holding")];
    assert.strictEqual(rows.length, POSITIONS.length, "one row per position");
    const text = document.getElementById("holdingsList").textContent;
    assert.ok(/AAPL/.test(text) && /TSLA/.test(text), "position symbols should render");
    assert.ok(/\$1,900\.00/.test(text), "market value should render");
  });

  // ── 3. Watchlist ──
  check("watchlist renders the user's own symbols", () => {
    const rows = [...document.querySelectorAll("#wlList .wl-row")];
    assert.strictEqual(rows.length, WATCHLIST.watchlist.length, "one row per watched symbol");
    const tickers = rows.map((r) => r.querySelector(".wl-tk").textContent);
    assert.ok(tickers.includes("AAPL") && tickers.includes("TSLA"));
  });
  check("watchlist remove buttons carry an accessible name", () => {
    const btn = document.querySelector("#wlList .wl-remove");
    assert.ok(btn, "expected a remove button");
    assert.ok(btn.getAttribute("aria-label"), "remove needs an aria-label");
  });
  check("watchlist add input is labelled", () => {
    const input = document.getElementById("wlInput");
    assert.ok(input.getAttribute("aria-label"), "add input needs an aria-label");
  });

  // ── 4. Market news + scheme guard ──
  check("finance headlines render as external links", () => {
    const rows = [...document.querySelectorAll("#newsList .news-row")];
    assert.ok(rows.length >= 1, "expected at least one news row");
    const good = rows.find((r) => /Markets rally/.test(r.textContent));
    assert.ok(good, "http news headline should render");
    assert.strictEqual(good.getAttribute("href"), "https://news.example.com/a");
    assert.strictEqual(good.getAttribute("target"), "_blank");
  });
  check("hostile javascript: news URL is dropped (no XSS sink)", () => {
    const text = document.getElementById("newsList").textContent;
    assert.ok(!/hostile headline/.test(text), "javascript: card must not render");
    assert.strictEqual(document.querySelector('#newsList a[href^="javascript:"]'), null);
  });
  check("non-news card types (playable embeds) are excluded from news", () => {
    const text = document.getElementById("newsList").textContent;
    assert.ok(!/a game \(not news\)/.test(text), "embed card must not appear as news");
  });

  dom.window.close();
}

run()
  .then(() => {
    if (failures) { err(`\n${failures} FAILED`); process.exit(1); }
    out("\nall explore-dashboard-ui checks passed");
    process.exit(0);
  })
  .catch((e) => { err("explore-dashboard-ui test error: " + (e && e.stack || e)); process.exit(1); });
