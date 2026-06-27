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
const { rankCandidates } = require("./model-leaderboard");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PCSF_FILE = path.join(REPO_ROOT, "data", "pcsf", "explore.pcsf.json");
const KNOWLEDGE_META = path.join(REPO_ROOT, "data", "knowledge", "index.meta.json");
const EMBEDS_FILE = path.join(REPO_ROOT, "data", "explore", "embeds.json");
const REPO_BLOB = "https://github.com/alex-place/lantern-os/blob/master/";

const PER_SOURCE_TIMEOUT_MS = 8000;

function keyForSource(source) {
  return "source:" + String(source || "unknown");
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
      image: it.image || "",
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
      evidence: { why: v.featured ? "Featured canon piece" : "From the lanternYT channel", source: data.channel || "lanternYT" },
    }));
}

async function buildCards() {
  const data = await github.load();
  const rel = (data.releases || []).map((r) => ({
    id: "build:rel:" + (r.tag || r.url),
    type: "build",
    title: (r.name || r.tag) + " released",
    url: r.url,
    source: "Keystone Build",
    published: r.date || null,
    topics: ["keystone", "building"],
    evidence: { why: "New release " + (r.tag || ""), source: data.repo || "GitHub" },
  }));
  const com = (data.commits || []).map((c) => ({
    id: "build:com:" + (c.sha || c.url),
    type: "build",
    title: c.msg || "commit " + (c.sha || ""),
    url: c.url,
    source: "Keystone Build",
    published: c.date || null,
    topics: ["keystone", "building"],
    evidence: { why: "Recent commit " + (c.sha || ""), source: data.repo || "GitHub" },
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
  return (meta.docs || [])
    .slice(0, 8)
    .map((doc) => {
      const base = String(doc).split("/").pop().replace(/\.md$/i, "").replace(/[-_]/g, " ");
      return {
        id: "doc:" + doc,
        type: "doc",
        title: base,
        url: REPO_BLOB + doc,
        source: "Knowledge Center",
        published: built,
        topics: ["keystone", "research"],
        evidence: { why: "Indexed Keystone reference doc", source: doc },
      };
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

function embedCards() {
  return loadEmbedSeed()
    .filter((e) => e && e.slug && e.embed && e.embed.src)
    .map((e) => ({
      id: "embed:" + e.slug,
      type: "embed",
      title: e.title || e.slug,
      url: e.url || e.embed.src,
      source: e.source || "Internet Archive",
      published: e.published || null,
      topics: Array.isArray(e.topics) ? e.topics : [],
      evidence: { why: e.why || "", source: e.evidence_source || e.source || "open archive" },
      embed: {
        provider: e.embed.provider || "iframe",
        src: e.embed.src,
        height: Number(e.embed.height) || 360,
        interactive: e.embed.interactive !== false,
      },
      lore: e.lore || "",
      // Per-card key so each embed is scored on its own (not lumped by source).
      key: "source:embed:" + e.slug,
    }));
}

// ── Aggregate (Observe) ──────────────────────────────────────────────────────

// Fan out to every producer; one source failing/timing out drops only its cards.
async function aggregate() {
  const producers = [
    ["embed", () => Promise.resolve(embedCards())],
    ["read", readCards],
    ["watch", watchCards],
    ["build", buildCards],
    ["belief", beliefCards],
    ["doc", () => Promise.resolve(docCards())],
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
async function rankedFeed(opts = {}) {
  const cards = await aggregate();
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

async function pagedFeed({ seen = [], limit = DEFAULT_PAGE, type = null, exploreRatio = 0.22 } = {}) {
  limit = Math.max(1, Math.min(30, Number(limit) || DEFAULT_PAGE));
  const { cards } = await rankedFeed();
  const all = type ? cards.filter((c) => c.type === type) : cards;
  const seenSet = new Set(Array.isArray(seen) ? seen : []);
  let pool = all.filter((c) => !seenSet.has(c.id));
  let cycled = false;
  if (pool.length === 0 && all.length > 0) {
    cycled = true; // catalog exhausted → endless cycle (re-serve a fresh rank)
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

module.exports = { aggregate, rankedFeed, pagedFeed, pickPage, diversityRerank, keyForSource, editorialOrder };

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
