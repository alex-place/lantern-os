/**
 * Explore feed aggregator (Observe stage).
 *
 * A THIN aggregator — not a recommender subsystem. It fans out to the feed
 * producers we already run, normalizes every item to one card shape, then ranks
 * the merged set through the SAME PCSF leaderboard used for model routing
 * (`rankCandidates(cards, "explore", opts)` from lib/model-leaderboard.js). Cold
 * start falls back to the editorial order declared in data/pcsf/explore.pcsf.json,
 * then card freshness.
 *
 *   const { rankedFeed } = require("./lib/explore-feed");
 *   const { cards } = await rankedFeed();
 *
 * CLI:  node apps/lantern-garage/lib/explore-feed.js   → prints the merged list.
 *
 * Card shape: { id, type, title, url, source, published, topics:[], evidence, key }
 *   - key = "source:<source>"  → the leaderboard agentId (see explore.pcsf.json).
 *   - evidence carries the [why, source] the Verify rule requires; no card ships
 *     without a source.
 *
 * Design: docs/research/explore-content-machine.md §8.
 */

const fs = require("fs");
const path = require("path");

const discover = require("../routes/discover-feeds");
const youtube = require("../routes/youtube");
const github = require("../routes/github-activity");
const flourishing = require("./flourishing-feeds");
const tradingNews = require("./trading-news");
const { rankCandidates } = require("./model-leaderboard");
const { rankNewsForUser } = require("./news-personalize");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PCSF_FILE = path.join(REPO_ROOT, "data", "pcsf", "explore.pcsf.json");
const KNOWLEDGE_META = path.join(REPO_ROOT, "data", "knowledge", "index.meta.json");
const EMBEDS_FILE = path.join(REPO_ROOT, "data", "explore", "embeds.json");
const KOH_MANIFEST = path.join(REPO_ROOT, "apps", "lantern-garage", "public", "assets", "content", "koh", "manifest.json");
const GAGE_FILE = path.join(REPO_ROOT, "data", "explore", "gage.json");
const REPO_BLOB = "https://github.com/alex-place/lantern-os/blob/master/";

const PER_SOURCE_TIMEOUT_MS = 8000;

function keyForSource(source) {
  return "source:" + String(source || "unknown");
}

// Same-origin generated cover (lib/explore-thumb.js via /api/explore/thumb.svg).
// Used as the lead image for cards with no natural cover, and as the onerror
// fallback for external covers — so every card shows a real thumbnail.
function genThumb(type, title, source) {
  const q = new URLSearchParams({ type: type || "", title: (title || "").slice(0, 200), source: source || "" });
  return "/api/explore/thumb.svg?" + q.toString();
}

// archive.org item cover/screenshot from an /embed/<identifier> URL.
function archiveThumb(embedSrc) {
  const m = /archive\.org\/embed\/([^/?#]+)/i.exec(embedSrc || "");
  return m ? "https://archive.org/services/img/" + m[1] : "";
}

function publishedTs(published) {
  if (!published) return 0;
  if (typeof published === "number") return published > 1e12 ? published : published * 1000;
  const t = Date.parse(published);
  return Number.isNaN(t) ? 0 : t;
}

// Run a producer with a timeout so one slow/hung source never blocks the feed.
function withTimeout(promise, ms, label) {
  return Promise.race([
    Promise.resolve().then(() => promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + " timeout")), ms)),
  ]);
}

// ── Editorial cold-start order (from the PCSF declaration) ───────────────────
let _editorial = null;
function editorialOrder() {
  if (_editorial) return _editorial;
  try {
    const decl = JSON.parse(fs.readFileSync(PCSF_FILE, "utf8"));
    _editorial = Array.isArray(decl.default_priority) ? decl.default_priority : [];
  } catch {
    _editorial = [];
  }
  return _editorial;
}

// ── Per-type producers → normalized cards ────────────────────────────────────

async function readCards() {
  const data = await discover.load();
  return (data.items || [])
    .filter((it) => it && it.title && it.link)
    .map((it, i) => ({
      id: "read:" + (it.link || i),
      type: "read",
      title: it.title,
      url: it.link,
      source: it.source || "Discover",
      published: it.date || null,
      topics: ["ai", "local-first", "building"],
      summary: it.summary || "",
      image: it.image || genThumb("read", it.title, it.source || "Discover"),
      imageFallback: genThumb("read", it.title, it.source || "Discover"),
      evidence: { why: "Fresh read from " + (it.source || "a curated feed"), source: it.source || "RSS" },
    }));
}

async function watchCards() {
  const data = await youtube.load();
  return (data.videos || [])
    .filter((v) => v && v.id)
    .map((v) => ({
      id: "watch:" + v.id,
      type: "watch",
      title: v.title || v.id,
      url: v.url || ("https://www.youtube.com/watch?v=" + v.id),
      source: "lanternYT",
      published: null,
      topics: ["keystone"],
      // Every YouTube video has a stable hqdefault thumbnail keyed by id — a
      // free, reliable lead image for the card.
      image: "https://i.ytimg.com/vi/" + v.id + "/hqdefault.jpg",
      imageFallback: genThumb("watch", v.title || v.id, "lanternYT"),
      evidence: { why: v.featured ? "Featured canon piece" : "From the lanternYT channel", source: data.channel || "lanternYT" },
    }));
}

// Build cards get a generated themed cover: GitHub's OG images are uncached
// (max-age=0), generated on-demand at ~500KB, and would reload every feed view —
// a poor lead image. The instant, tiny, same-origin generated thumbnail is the
// reliable choice (consistent with docs).
async function buildCards() {
  const data = await github.load();
  const repo = data.repo || "alex-place/lantern-os";
  const rel = (data.releases || []).map((r) => ({
    id: "build:rel:" + (r.tag || r.url),
    type: "build",
    title: (r.name || r.tag) + " released",
    url: r.url,
    source: "Keystone Build",
    published: r.date || null,
    topics: ["keystone", "building"],
    image: genThumb("build", (r.name || r.tag) + " released", "Keystone Build"),
    evidence: { why: "New release " + (r.tag || ""), source: repo || "GitHub" },
  }));
  const com = (data.commits || []).map((c) => ({
    id: "build:com:" + (c.sha || c.url),
    type: "build",
    title: c.msg || "commit " + (c.sha || ""),
    url: c.url,
    source: "Keystone Build",
    published: c.date || null,
    topics: ["keystone", "building"],
    image: genThumb("build", c.msg || "commit " + (c.sha || ""), "Keystone Build"),
    evidence: { why: "Recent commit " + (c.sha || ""), source: repo || "GitHub" },
  }));
  return [...rel, ...com].filter((c) => c.url);
}

// Positive, informative presentation for each grounded belief. The numbers stay
// sourced + corroborated (External-Reality Rule) — only the FRAMING is editorial:
// lead with the real-world value and the progress it represents, not an opaque
// normalized "flourishing %". Declining biodiversity metrics are framed
// constructively (the recovery angle), never as doom. The full sourced figures —
// including the hard ones — remain one click away on /flourishing.html.
const BELIEF_PRESENT = {
  "humans:health": {
    headline: (v) => `People now live ${Math.round(v.raw)} years on average`,
    frame: "Global life expectancy has climbed by roughly 25 years since 1950 — humanity is living longer than at any point in history.",
  },
  "humans:health:children": {
    headline: (v) => {
      const surv = /1[,.]?000/.test(v.unit || "") ? 100 - v.raw / 10 : 100 - v.raw;
      return `${surv.toFixed(1)}% of children now survive to age five`;
    },
    frame: "Child deaths have more than halved since 1990 — one of the fastest humanitarian gains ever recorded, and still improving.",
  },
  "humans:opportunity": {
    headline: (v) => `Electricity now reaches ${Math.round(v.raw)}% of people`,
    frame: "More than a billion people have gained access to power since 2000, and the grid keeps reaching further every year.",
  },
  "humans:education": {
    headline: (v) => `${Math.round(v.raw)}% of teens are enrolled in secondary school`,
    frame: "More young people are learning than at any time in history, and global enrolment keeps rising.",
  },
  "humans:connectivity": {
    headline: (v) => `${Math.round(v.raw)}% of people are now online`,
    frame: "More than half the world has come online in two decades — the fastest expansion of access to knowledge in history.",
  },
  "humans:poverty": {
    headline: (v) => `${Math.round(100 - v.raw)}% of people now live above extreme poverty`,
    frame: "Extreme poverty has more than halved since 1990 — hundreds of millions of people have risen above it, and the share keeps falling.",
  },
  "ecosystems:protected_areas": {
    headline: (v) => `${Math.round(v.raw)}% of land is protected — and growing toward 30%`,
    frame: "Protected areas keep expanding toward the global 30×30 goal of safeguarding a third of the planet by 2030.",
  },
  "ecosystems:clean_energy": {
    headline: (v) => `Renewables now supply ${Math.round(v.raw)}% of the world's energy`,
    frame: "Solar and wind are the fastest-growing energy sources on Earth — their share of the mix climbs every single year.",
  },
  "animals:extinction_risk": {
    headline: () => "Conservation is pulling species back from the brink",
    frame: "Focused protection has already recovered the humpback whale, the bald eagle, and the giant panda — proof the curve can bend.",
  },
  "animals:wild_populations": {
    headline: () => "Where habitat is protected, wildlife bounces back",
    frame: "Rewilded forests, restored wetlands, and marine reserves are rebuilding wild populations — often faster than expected.",
  },
};

async function beliefCards() {
  const panel = await flourishing.panel();
  if (!panel || !panel.ok) return [];
  return (panel.beliefs || [])
    .filter((b) => b && b.entity)
    .map((b) => {
      const primary = (b.sources && b.sources[0]) || {};
      const years = (b.sources || []).map((s) => s.year).filter(Boolean).sort();
      const year = years.length ? years[years.length - 1] : "";
      const present = BELIEF_PRESENT[b.entity];
      let title;
      try {
        title = present && primary.raw != null ? present.headline(primary) : (b.label || b.entity);
      } catch {
        title = b.label || b.entity;
      }
      // A real grounded thumbnail: the Our World in Data chart PNG for this very
      // metric (the source we already fuse). Falls back to a generated cover.
      const owid = (b.sources || []).map((s) => /ourworldindata\.org\/grapher\/([a-z0-9-]+)/i.exec(s.source || "")).find(Boolean);
      const beliefImg = owid ? "https://ourworldindata.org/grapher/" + owid[1] + ".png" : genThumb("belief", title, "Good news, grounded");
      const providers = (b.sources || []).map((s) => s.provider).filter(Boolean).join(" + ") || "fused public feeds";
      const corroboration = b.n_sources >= 2
        ? `corroborated across ${b.n_sources} independent sources`
        : "single source";
      return {
        id: "belief:" + b.entity,
        type: "belief",
        title,
        url: "/flourishing.html",
        source: "Good news, grounded",
        published: null,
        topics: ["world-model", b.domain].filter(Boolean),
        summary: present ? present.frame : "",
        image: beliefImg,
        imageFallback: genThumb("belief", title, "Good news, grounded"),
        evidence: {
          why: (year ? `as of ${year} · ` : "") + corroboration,
          source: providers,
        },
      };
    });
}

// Knowledge meta is read once and cached (it only changes when the index is
// rebuilt) — same discipline as editorialOrder(), so a feed request never does
// synchronous disk I/O on the event loop.
let _knowledgeMeta;
function loadKnowledgeMeta() {
  if (_knowledgeMeta !== undefined) return _knowledgeMeta;
  try {
    _knowledgeMeta = JSON.parse(fs.readFileSync(KNOWLEDGE_META, "utf8"));
  } catch {
    _knowledgeMeta = null;
  }
  return _knowledgeMeta;
}

function docCards() {
  const meta = loadKnowledgeMeta();
  if (!meta) return [];
  const built = meta.built_at ? meta.built_at * 1000 : null;
  const docMeta = meta.doc_meta || {};
  // Surface the whole curated library — the Docs chip shows the full set; diversity
  // rerank keeps it from walling the unfiltered feed. External docs (e.g. Human
  // Flourishing Frameworks, registered via data/knowledge/external-sources.json)
  // carry their own upstream url/source/title in doc_meta so the card links to the
  // formatted source rather than this repo's blob.
  return (meta.docs || [])
    .slice(0, 300)
    .map((doc) => {
      const ext = docMeta[doc];
      const base = ext && ext.title
        ? ext.title
        : String(doc).split("/").pop().replace(/\.md$/i, "").replace(/[-_]/g, " ");
      const source = (ext && ext.source) || "Knowledge Center";
      return {
        id: "doc:" + doc,
        type: "doc",
        title: base,
        url: (ext && ext.url) || (REPO_BLOB + doc),
        source,
        published: built,
        topics: (ext && ext.topics) || ["keystone", "research"],
        image: genThumb("doc", base, source),
        evidence: {
          why: ext ? "Indexed external reference doc" : "Indexed Keystone reference doc",
          source: (ext && ext.url) || doc,
        },
      };
    });
}

// Market news as feed cards (#1582/#1583). Reuses the local-first trading-news
// CSF registry (lib/trading-news.js → free Yahoo Finance RSS via news-collector),
// so Explore surfaces the SAME grounded headlines the trader page does — no new
// ingestion path. Each card is a `read` (📰) typed card tagged topics:["finance",
// <symbols…>] so the Finance chip and /explore.html?topic=finance can filter to it
// while it still flows through the one ranked feed. A headline with no source/url
// is dropped (External-Reality Rule: no card without a source).
function financeCards(ctx) {
  let records = [];
  try {
    records = tradingNews.queryRecentNews({ limit: 200 });
  } catch {
    return [];
  }
  records = (records || []).filter((r) => r && (r.headline || r.title) && (r.url || r.source));

  // PERSONALIZE (Reason): when we know the user, rank the pool by per-user
  // relevance so the most-relevant news leads. The order is preserved into the
  // feed because finance cards share one source — diversityRerank keeps a
  // single source's input order. Without a user, fall through in registry
  // (newest-first) order.
  if (ctx) {
    try { records = rankNewsForUser(records, ctx); } catch { /* fall back to raw order */ }
  }

  return records.map((r) => {
    const headline = r.headline || r.title;
    const symbols = (Array.isArray(r.symbols) ? r.symbols : []).map((s) => String(s).toLowerCase());
    const src = r.source || "Market News";
    // Evidence: lead with the personalized "why this is relevant to YOU" signals
    // (External-Reality Rule — the ranking is explained, not opaque), then the
    // generic impact/ticker line.
    const personal = Array.isArray(r.relevanceWhy) ? r.relevanceWhy : [];
    // Personalized cards already name their top signals (ticker/impact/fresh) in
    // `relevanceWhy`; only fall back to the generic impact/ticker line when there
    // is no per-user context, so the evidence never repeats itself.
    const why = (personal.length
      ? [...personal, "market news"]
      : [
          r.impact ? `impact ${r.impact}` : "",
          symbols.length ? symbols.map((s) => s.toUpperCase()).join(", ") : "",
          "market news",
        ]
    ).filter(Boolean).join(" · ");
    // Lead image, in preference order (never the headline — that would render the
    // title twice): (1) the REAL article cover from the source; (2) the primary
    // ticker's company logo; (3) a clean minimal finance cover (glyph + source).
    // The browser loads (1)/(2) directly — same-origin TLS interception doesn't
    // affect <img>. A broken logo falls back to the minimal cover via imageFallback.
    const realImg = r.image && /^https:\/\//i.test(r.image) ? r.image : "";
    const primary = (symbols[0] || "").toUpperCase();
    // Only A–Z tickers have a stock logo (skip crypto/FX like BTCUSD, indices stay
    // best-effort). Company-logo-by-ticker via Financial Modeling Prep (no key).
    const logoUrl = /^[A-Z]{1,5}$/.test(primary)
      ? "https://financialmodelingprep.com/image-stock/" + primary + ".png"
      : "";
    const minimalCover = genThumb("finance", "", src);
    const card = {
      id: "finance:" + (r.news_id || r.memory_id || r.url || headline),
      type: "read",
      title: headline,
      url: r.url || "",
      source: src,
      published: r.published || r.recorded_at || null,
      topics: ["finance", ...symbols],
      summary: r.summary || "",
      image: realImg || logoUrl || minimalCover,
      imageFallback: minimalCover,
      // A logo (not a real photo) renders CONTAINED on a tile, not cropped.
      imageFit: !realImg && logoUrl ? "contain" : undefined,
      evidence: { why, source: src },
    };
    if (Number.isFinite(r.relevance)) card.relevance = r.relevance;
    return card;
  });
}

// Curated open-archive embeds (games + listening). Data-driven from
// data/explore/embeds.json so adding content is a JSON edit, not a code change.
// Cached like the other static reads — the seed only changes on deploy. Each
// embed keeps its OWN leaderboard key ("source:embed:<slug>") so every panel
// earns or loses its slot independently: engagement or discarded (#1217).
let _embeds;
function loadEmbedSeed() {
  if (_embeds !== undefined) return _embeds;
  try {
    const raw = JSON.parse(fs.readFileSync(EMBEDS_FILE, "utf8"));
    _embeds = Array.isArray(raw.embeds) ? raw.embeds : [];
  } catch {
    _embeds = [];
  }
  return _embeds;
}

// An embed's chip CATEGORY is derived from its topics, not lumped under one
// "embed" bucket: a public-domain film belongs under Watch, jazz/classical/radio
// under Listen, and everything else (games) stays Play. Without this every film
// and record hid under "Play" and never appeared when you filtered Watch/Listen
// (#explore-categories). The card still renders as an inline player — the embed
// path keys off `embed.src`, not `type` — so films play in-page under Watch.
function embedType(topics) {
  const t = (Array.isArray(topics) ? topics : []).map((x) => String(x).toLowerCase());
  if (t.some((x) => x === "listen" || x === "radio" || x === "music")) return "listen";
  if (t.some((x) => x === "watch" || x === "film" || x === "animation")) return "watch";
  return "embed";
}

function embedCards() {
  return loadEmbedSeed()
    .filter((e) => e && e.slug && e.embed && e.embed.src)
    .map((e) => {
      const tImg = e.thumb || archiveThumb(e.embed.src) || genThumb(embedType(e.topics), e.title || e.slug, e.source || "open archive");
      return {
      id: "embed:" + e.slug,
      type: embedType(e.topics),
      title: e.title || e.slug,
      url: e.url || e.embed.src,
      source: e.source || "Internet Archive",
      published: e.published || null,
      topics: Array.isArray(e.topics) ? e.topics : [],
      // Cover art so a game/film/record shows a real poster before you press Play.
      image: tImg,
      imageFallback: genThumb(embedType(e.topics), e.title || e.slug, e.source || "open archive"),
      evidence: { why: e.why || "", source: e.evidence_source || e.source || "open archive" },
      embed: {
        provider: e.embed.provider || "iframe",
        src: e.embed.src,
        // Preferred resolution: width × height define the embed's real aspect so
        // the inline frame, poster, and fullscreen fit it instead of squishing a
        // fixed-height box. width omitted ⇒ full-bleed (audio bars, wide games).
        width: Number(e.embed.width) || 0,
        height: Number(e.embed.height) || 360,
        interactive: e.embed.interactive !== false,
      },
      lore: e.lore || "",
      // Per-card key so each embed is scored on its own (not lumped by source).
      key: "source:embed:" + e.slug,
    };
    });
}

// Kingdome of Hearts gallery → ranked feed cards. The Three Doors image
// set used to be a static wall glued to the BOTTOM of every Explore view,
// bypassing the ranking, the filter chips, and the engagement signal. Now each
// titled image is a normal `art` card tagged topics:["kingdome", …] so it flows
// through the ONE ranked feed (PCSF + diversity), the ♥ Kingdome chip filters to
// it, and clicks/dwell float the best art up. We read the SAME manifest the page
// used (public/assets/content/koh/manifest.json — `base` points at the R2 CDN),
// cached like the other static seeds. Only titled `auto` items ship (the
// untitled `review` set still needs a human pass and carries no real caption).
let _koh;
function loadKohManifest() {
  if (_koh !== undefined) return _koh;
  try {
    const raw = JSON.parse(fs.readFileSync(KOH_MANIFEST, "utf8"));
    _koh = raw && Array.isArray(raw.items) ? raw : null;
  } catch {
    _koh = null;
  }
  return _koh;
}

const KOH_CAT_LABEL = { door: "Doors", hero: "Heroes", world: "World" };

function galleryCards() {
  const m = loadKohManifest();
  if (!m) return [];
  const base = m.base || "/assets/content/koh/";
  return (m.items || [])
    .filter((it) => it && it.status === "auto" && it.title && it.full && it.thumb)
    .map((it) => {
      const full = base + it.full;
      const thumb = base + it.thumb;
      const catLabel = KOH_CAT_LABEL[it.cat] || "Gallery";
      return {
        id: "koh:" + it.id,
        type: "art",
        title: it.title,
        url: full,
        source: "Kingdome of Hearts",
        published: null,
        // topics carry BOTH the collection (for the ♥ Kingdome chip / ?topic=
        // deep link) and the broad "art" tag, plus the door/hero/world category.
        topics: ["kingdome", "art", it.cat].filter(Boolean),
        image: thumb,
        imageFallback: genThumb("art", it.title, "Kingdome of Hearts"),
        // media tells the client renderer this is an image showcase: lead art that
        // opens the shared lightbox full-size (kind:"image").
        media: { kind: "image", full, thumb, pixel: false },
        evidence: { why: "Kingdome of Hearts — " + catLabel, source: "Three Doors gallery" },
      };
    });
  // key falls through to keyForSource("Kingdome of Hearts"): the whole gallery is
  // ONE leaderboard source, so diversityRerank spreads it instead of letting 240+
  // images wall the feed.
}

// Gage's showcase → ranked feed cards. The BFDM episodes (self-hosted mp4)
// and original game art used to be a second static wall. Data-driven from
// data/explore/gage.json so the set grows with a JSON edit; videos become `watch`
// cards (kind:"video", inline <video>), sprites become `art` image cards — all
// tagged topics:["gage", …] for the ✏️ Gage chip while flowing through the one feed.
let _gage;
function loadGageSeed() {
  if (_gage !== undefined) return _gage;
  try {
    _gage = JSON.parse(fs.readFileSync(GAGE_FILE, "utf8"));
  } catch {
    _gage = null;
  }
  return _gage;
}

function gageCards() {
  const g = loadGageSeed();
  if (!g) return [];
  const base = g.base || "";
  const source = g.source || "Pencil Guy — by Gage";
  const videos = (g.videos || [])
    .filter((v) => v && v.slug && v.file)
    .map((v) => ({
      id: "gage:" + v.slug,
      type: "watch",
      title: v.title || v.slug,
      url: "",
      source,
      published: null,
      topics: ["gage", "watch", "art"],
      image: v.poster ? base + v.poster : genThumb("watch", v.title || v.slug, source),
      imageFallback: genThumb("watch", v.title || v.slug, source),
      media: { kind: "video", src: base + v.file, poster: v.poster ? base + v.poster : "" },
      evidence: { why: "BFDM series — hand-drawn by Gage", source },
    }));
  const art = (g.art || [])
    .filter((a) => a && a.slug && a.file)
    .map((a) => {
      const full = base + a.file;
      return {
        id: "gage:" + a.slug,
        type: "art",
        title: a.title || a.slug,
        url: full,
        source,
        published: null,
        topics: ["gage", "art"],
        image: full,
        imageFallback: genThumb("art", a.title || a.slug, source),
        media: { kind: "image", full, thumb: full, pixel: !!a.pixel },
        evidence: { why: "Original game art by Gage", source },
      };
    });
  return [...videos, ...art];
}

// ── Aggregate (Observe) ──────────────────────────────────────────────────────

// Fan out to every producer; one source failing/timing out drops only its cards.
async function aggregate(userCtx) {
  const producers = [
    ["embed", () => Promise.resolve(embedCards())],
    ["read", readCards],
    ["watch", watchCards],
    ["build", buildCards],
    ["belief", beliefCards],
    ["doc", () => Promise.resolve(docCards())],
    ["finance", () => Promise.resolve(financeCards(userCtx))],
    ["gallery", () => Promise.resolve(galleryCards())],
    ["gage", () => Promise.resolve(gageCards())],
  ];
  const settled = await Promise.allSettled(
    producers.map(([label, fn]) => withTimeout(fn(), PER_SOURCE_TIMEOUT_MS, label).catch(() => [])),
  );
  const cards = [];
  const seen = new Set();
  for (const r of settled) {
    if (r.status !== "fulfilled" || !Array.isArray(r.value)) continue;
    for (const c of r.value) {
      // Dedupe by the per-card id (unique by construction), NOT url: belief cards
      // all share url "/flourishing.html", so a url key would collapse them to one.
      const dedupe = c.id || c.url;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      // Respect a producer-set per-card key (embeds use "source:embed:<slug>");
      // everything else falls through to the per-source key.
      cards.push({ ...c, key: c.key || keyForSource(c.source), publishedTs: publishedTs(c.published) });
    }
  }
  return cards;
}

// ── Diversity rerank (Converge) ──────────────────────────────────────────────

// Issue #1220: keep the algorithmic feed honest and non-collapsing. PCSF scores
// every card by its SOURCE key, so all cards from one engaged source inherit the
// SAME score and wall the top of the feed — e.g. eight "Flourishing" belief
// cards in a row (all 3.0) before you see a single game, read, or build. A pure
// score sort has no notion of "I've already shown three of these."
//
// This greedy pass re-orders the scored list with a multiplicative diversity
// decay: each time a source (or type) is placed, the remaining cards from that
// source/type are weighted down, so a strong source still LEADS but then yields
// the next slot to something different and reappears later. It's order-preserving
// within a source (the input is already score→editorial→freshness sorted, so the
// first of a tie wins) and fully deterministic — same input, same order.
//
// EXPLORE_DIVERSITY=0 disables it (pure score sort), matching the PCSF_ROUTING
// kill-switch convention.
//
// The base weight is the card's RANK in the incoming (score→editorial→freshness)
// order mapped to [0,1] — NOT its raw score. Using rank makes the pass
// scale-invariant: a runaway leaderboard score (we've seen source:Flourishing
// hit 10000) competes with diversity on ORDER, not magnitude, so no anomalous
// score can wall the feed. Diversity is then an additive demotion per prior card
// already placed from the same source / type.
const SOURCE_PENALTY = 0.40; // demotion per prior card already shown from the same source
const TYPE_PENALTY = 0.12;   // milder — types are broad buckets, some clustering reads fine

function diversityRerank(scored) {
  if (process.env.EXPLORE_DIVERSITY === "0" || !Array.isArray(scored) || scored.length < 3) {
    return Array.isArray(scored) ? scored : [];
  }
  const n = scored.length;
  const base = new Map();
  scored.forEach((c, i) => base.set(c, n === 1 ? 1 : 1 - i / (n - 1)));

  const remaining = scored.slice();
  const out = [];
  const srcCount = Object.create(null);
  const typeCount = Object.create(null);
  const sourceOf = (c) => String(c.source || c.key || "");
  const typeOf = (c) => String(c.type || "");
  while (remaining.length) {
    let bestIdx = 0;
    let bestEff = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const eff = base.get(c)
        - SOURCE_PENALTY * (srcCount[sourceOf(c)] || 0)
        - TYPE_PENALTY * (typeCount[typeOf(c)] || 0);
      // `remaining` stays in rank order, so a genuine tie keeps the
      // better-ranked card first — stable and explainable.
      if (eff > bestEff + 1e-9) { bestEff = eff; bestIdx = i; }
    }
    const [picked] = remaining.splice(bestIdx, 1);
    out.push(picked);
    srcCount[sourceOf(picked)] = (srcCount[sourceOf(picked)] || 0) + 1;
    typeCount[typeOf(picked)] = (typeCount[typeOf(picked)] || 0) + 1;
  }
  return out;
}

// ── Rank (Reason) ────────────────────────────────────────────────────────────

// Order the merged cards through the PCSF leaderboard. Unscored cards (cold
// start) fall back to editorial order, then freshness — exactly the contract in
// issue #1216.
//
// ── Short-TTL rank cache (perf/consistency) ──
// Endless scroll POSTs one page per ~viewport; each page previously re-ran the
// FULL aggregate() + rankCandidates() + diversityRerank() fan-out, so scrolling
// felt slow and each page could re-rank differently mid-scroll (jitter the user
// reads as "inconsistent loading"). We memoize the ranked feed for a few seconds
// per audience key: pages within the window are served from the same stable rank
// (instant, no jitter), and engagement still re-steers the feed on the next
// window. EXPLORE_FEED_TTL_MS=0 disables the cache (always recompute).
const FEED_CACHE_TTL_MS = process.env.EXPLORE_FEED_TTL_MS != null
  ? Math.max(0, Number(process.env.EXPLORE_FEED_TTL_MS) || 0)
  : 15000;
const _feedCache = new Map(); // cacheKey -> { at, feed }

async function rankedFeed(opts = {}) {
  const key = opts.cacheKey || (opts.userCtx ? "user" : "global");
  if (FEED_CACHE_TTL_MS > 0) {
    const hit = _feedCache.get(key);
    if (hit && (Date.now() - hit.at) < FEED_CACHE_TTL_MS) return hit.feed;
  }
  const feed = await computeRankedFeed(opts);
  if (FEED_CACHE_TTL_MS > 0) {
    _feedCache.set(key, { at: Date.now(), feed });
    // Bound the cache — one entry per audience key ('global' + signed-in users).
    if (_feedCache.size > 64) {
      const oldest = [..._feedCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) _feedCache.delete(oldest[0]);
    }
  }
  return feed;
}

async function computeRankedFeed(opts = {}) {
  const cards = await aggregate(opts.userCtx);
  const editorial = editorialOrder();
  const edIndex = (key) => {
    const i = editorial.indexOf(key);
    return i === -1 ? editorial.length : i;
  };

  // PCSF scores by leaderboard compositeScore; unscored get a cold prior. The
  // score already encodes the full order — an engaged source floats above the
  // cold prior, a dismissed source (score→0) sinks BELOW it. So sort by score
  // and only break genuine ties (the cold-start cards all share the prior) by
  // editorial order, then freshness.
  const ranked = await rankCandidates(cards, "explore", opts);

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ed = edIndex(a.key) - edIndex(b.key);
    if (ed !== 0) return ed;
    return (b.publishedTs || 0) - (a.publishedTs || 0);
  });

  // Diversity pass (#1220): break source/type walls so no single source
  // dominates the top of the batch. Pure score order is preserved within a
  // source; the kill-switch (EXPLORE_DIVERSITY=0) returns the raw sort.
  const cardsOut = diversityRerank(ranked);

  return { cards: cardsOut, count: cardsOut.length, generatedAt: new Date().toISOString() };
}

// ── Endless paginated feed (Act) — TikTok / Shorts-style ──────────────────────
//
// Infinite scroll with per-batch live re-ranking. Each page is a FRESH
// rankedFeed() (PCSF + diversity), so engagement recorded since the previous
// page already steers this one: dwell/click on games floats game sources up,
// dismiss sinks them — the next batch reflects it. We drop the cards already
// shown (`seen`, by stable card id), reserve a couple of EXPLORATION slots for
// cold / not-yet-scored cards pulled from deeper in the pool (the #1220
// exploration sub-item — keeps the feed learning your taste instead of
// bubbling), and when the bounded catalog is exhausted we CYCLE (re-serve a
// freshly-ranked set) so the scroll never ends.
const DEFAULT_PAGE = 9;

// Build one page: the top unseen cards for exploitation, plus a few exploration
// cards drawn from deeper in the pool (preferring cold/unscored), interleaved.
function pickPage(pool, limit, exploreRatio) {
  if (pool.length <= limit) return pool.slice();
  const exploreSlots = Math.min(
    pool.length - limit,
    Math.max(1, Math.round(limit * exploreRatio)),
  );
  const exploitSlots = Math.max(1, limit - exploreSlots);
  const page = pool.slice(0, exploitSlots);
  const rest = pool.slice(exploitSlots);
  // Prefer genuinely cold (unscored) cards for discovery; else any deeper card.
  const cold = rest.filter((c) => !c.scored);
  const bag = cold.length >= exploreSlots ? cold : rest;
  const chosen = [];
  const used = new Set();
  while (chosen.length < exploreSlots && used.size < bag.length) {
    const i = Math.floor(Math.random() * bag.length); // jitter so cycles vary
    if (used.has(i)) continue;
    used.add(i);
    chosen.push(bag[i]);
  }
  // Interleave the exploration cards at spread positions.
  const step = Math.max(1, Math.floor(page.length / (chosen.length + 1)));
  chosen.forEach((c, k) => page.splice(Math.min(page.length, (k + 1) * step + k), 0, c));
  return page.slice(0, limit);
}

async function pagedFeed({ seen = [], limit = DEFAULT_PAGE, type = null, topic = null, userCtx = null, cacheKey = null, exploreRatio = 0.22 } = {}) {
  limit = Math.max(1, Math.min(30, Number(limit) || DEFAULT_PAGE));
  const { cards } = await rankedFeed({ userCtx, cacheKey });
  // A chip filters by media TYPE (read/watch/…) OR by TOPIC (finance) — topics are
  // the cross-cutting dimension (e.g. finance news is a `read` tagged "finance").
  let all = type ? cards.filter((c) => c.type === type) : cards;
  if (topic) all = all.filter((c) => Array.isArray(c.topics) && c.topics.includes(topic));
  const seenSet = new Set(Array.isArray(seen) ? seen : []);
  let pool = all.filter((c) => !seenSet.has(c.id));
  let cycled = false;
  // Only cycle (re-serve the catalog) when it is genuinely bigger than one page.
  // A small filtered category — Watch's 3 videos, Build's 5 — fits in the first
  // page; cycling it immediately re-served the SAME cards right below, so a
  // filter looked broken (3 unique videos rendered 3× back-to-back). When the
  // whole filtered catalog has been shown once, return empty so the UI says
  // "caught up" instead of stacking duplicates.
  if (pool.length === 0 && all.length > limit) {
    cycled = true; // large catalog exhausted → endless cycle (re-serve a fresh rank)
    pool = all.slice();
  }
  const page = pickPage(pool, limit, exploreRatio);
  return {
    cards: page,
    count: page.length,
    cycled,
    remaining: Math.max(0, pool.length - page.length),
    catalog: all.length,
    endless: true,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { aggregate, rankedFeed, pagedFeed, pickPage, diversityRerank, keyForSource, editorialOrder, embedCards, galleryCards, gageCards };

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const out = (s) => process.stdout.write(s + "\n"); // process.stdout, not console.log (SLOP gate)
  rankedFeed()
    .then(({ cards }) => {
      out(`Explore feed — ${cards.length} cards (ranked):\n`);
      for (const c of cards) {
        const flag = c.scored ? `★${c.score.toFixed(2)}` : `·${c.score.toFixed(2)}`;
        out(`[${c.type.padEnd(6)}] ${flag}  ${c.title}`);
        out(`         ${c.source} · ${c.url}`);
      }
    })
    .catch((e) => {
      process.stderr.write("explore-feed failed: " + e.message + "\n");
      process.exit(1);
    });
}
