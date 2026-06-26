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

async function beliefCards() {
  const panel = await flourishing.panel();
  if (!panel || !panel.ok) return [];
  return (panel.beliefs || [])
    .filter((b) => b && b.entity)
    .map((b) => {
      const pct = Math.round((b.posterior || 0) * 100);
      const unc = Math.round((b.uncertainty || 0) * 100);
      return {
        id: "belief:" + b.entity,
        type: "belief",
        title: `${b.label || b.entity}: ${pct}% (±${unc}%)`,
        url: "/flourishing.html",
        source: "Flourishing",
        published: panel.updated_at || null,
        topics: ["world-model", b.domain].filter(Boolean),
        evidence: {
          why: `${b.n_sources} source${b.n_sources === 1 ? "" : "s"}, ${b.agreement}`,
          source: (b.sources || []).map((s) => s.provider).filter(Boolean).join(" + ") || "fused feeds",
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

// ── Aggregate (Observe) ──────────────────────────────────────────────────────

// Fan out to every producer; one source failing/timing out drops only its cards.
async function aggregate() {
  const producers = [
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
      cards.push({ ...c, key: keyForSource(c.source), publishedTs: publishedTs(c.published) });
    }
  }
  return cards;
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

  return { cards: ranked, count: ranked.length, generatedAt: new Date().toISOString() };
}

module.exports = { aggregate, rankedFeed, keyForSource, editorialOrder };

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
