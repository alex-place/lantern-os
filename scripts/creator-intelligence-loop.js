#!/usr/bin/env node
"use strict";
// Perpetual Creator Intelligence Research Loop — Σ₀ Observe → Measure → Verify →
// Calibrate → Recommend → repeat. RESUMABLE (checkpointed) and HONEST.
//
// LEGAL/HONESTY BOUNDARY (load-bearing):
//   - Discovery collects only PUBLIC METADATA (title, duration, views, likes,
//     comments, hashtags, upload age) via the official YouTube Data API. It
//     NEVER downloads copyrighted Shorts/TikToks/Reels — platform ToS and
//     copyright forbid scraping/analyzing that media.
//   - Editing FEATURES (cutsPerMin, hook length, motion, …) are extracted ONLY
//     from PERMITTED open-license video, via the open-video flywheel
//     (scripts/open-video-research.js: download → analyze → DELETE).
//   - Therefore the editing→virality correlation is ALWAYS reported as
//     insufficient_data: we can lawfully measure metadata→views and open-license
//     editing priors, but NOT the editing of the viral copyrighted videos. The
//     loop never invents that link.
//
// Confidence ladder (never skipped): insufficient_data → directional → calibrated.
//
// Usage:
//   node scripts/creator-intelligence-loop.js --cycle           # run one cycle
//   node scripts/creator-intelligence-loop.js --forever         # loop forever (resumable)
//   node scripts/creator-intelligence-loop.js --status          # checkpoint + calibration
//   node scripts/creator-intelligence-loop.js --calibrate       # recompute calibration only

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");

// Load .env.local then .env from repo root (so YOUTUBE_API_KEY etc. work for the
// CLI / scheduled task, matching server.js). Existing env vars win.
for (const envFile of [".env.local", ".env"]) {
  const p = path.join(REPO, envFile);
  try {
    if (require("fs").existsSync(p)) {
      require("fs").readFileSync(p, "utf8").split("\n").forEach((line) => {
        const m = line.replace(/\r$/, "").match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]/, "").replace(/['"]$/, "");
      });
    }
  } catch (_) { /* ignore */ }
}

const DIR = path.join(REPO, "research", "ci_loop");
const CHECKPOINT = path.join(DIR, "checkpoint.json");
const VIRAL_RESEARCH = path.join(DIR, "viralResearch.jsonl");
const FIRST_PARTY = path.join(DIR, "first_party_outcomes.jsonl");
const CALIBRATION = path.join(DIR, "calibration.json");
const SEEN = path.join(DIR, "seen.json"); // dedup index

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return dflt; } }
function readJsonl(p) { try { return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } }

function loadCheckpoint() {
  return readJson(CHECKPOINT, { cycle: 0, metadataCollected: 0, openLicenseAnalyzed: 0, startedAt: null, lastCycleAt: null });
}
function saveCheckpoint(c) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(CHECKPOINT, JSON.stringify(c, null, 2)); }

function loadSeen() { return new Set(readJson(SEEN, [])); }
function saveSeen(set) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(SEEN, JSON.stringify([...set])); }

// ── Discovery: PUBLIC METADATA ONLY (YouTube Data API). No video download. ────
async function discoverMetadata({ query = "gaming shorts", max = 25 } = {}) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return { ok: false, confidence: "insufficient_data", reason: "no YOUTUBE_API_KEY set — discovery is unavailable; not fabricating metadata", items: [] };
  try {
    const su = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoDuration=short&maxResults=${Math.min(50, max)}&q=${encodeURIComponent(query)}&key=${key}`;
    const sr = await (await fetch(su)).json();
    // Surface API failures honestly — never treat an error body as "0 results".
    if (sr.error) return { ok: false, confidence: "insufficient_data", reason: `YouTube API: ${sr.error.message}`, items: [] };
    const ids = (sr.items || []).map((i) => i.id && i.id.videoId).filter(Boolean);
    if (!ids.length) return { ok: true, confidence: "insufficient_data", reason: "no results for query", items: [] };
    const vu = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${ids.join(",")}&key=${key}`;
    const vr = await (await fetch(vu)).json();
    if (vr.error) return { ok: false, confidence: "insufficient_data", reason: `YouTube API: ${vr.error.message}`, items: [] };
    const items = (vr.items || []).map((v) => {
      const s = v.statistics || {}, sn = v.snippet || {};
      const tags = (sn.title || "").match(/#\w+/g) || [];
      return {
        videoId: v.id, source: "youtube",
        title: sn.title || null, duration: v.contentDetails && v.contentDetails.duration || null,
        views: num(s.viewCount), likes: num(s.likeCount), comments: num(s.commentCount),
        hashtags: tags, uploadAge: sn.publishedAt || null, collectedAt: new Date().toISOString(),
      };
    });
    return { ok: true, confidence: "ok", items };
  } catch (e) {
    return { ok: false, confidence: "insufficient_data", reason: "API error: " + e.message, items: [] };
  }
}
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

function storeMetadata(items) {
  const seen = loadSeen();
  fs.mkdirSync(DIR, { recursive: true });
  let added = 0;
  for (const it of items) {
    const id = it.source + ":" + it.videoId;
    if (seen.has(id)) continue;       // dedup
    seen.add(id); fs.appendFileSync(VIRAL_RESEARCH, JSON.stringify(it) + "\n"); added++;
  }
  saveSeen(seen);
  return added;
}

// ── Calibration: honest confidence per signal ────────────────────────────────
function pearson(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const n = pairs.length; if (n < 3) return null;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n, my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let num2 = 0, dx = 0, dy = 0;
  for (const [a, b] of pairs) { num2 += (a - mx) * (b - my); dx += (a - mx) ** 2; dy += (b - my) ** 2; }
  return dx && dy ? Number((num2 / Math.sqrt(dx * dy)).toFixed(3)) : null;
}
function isoDurationToSec(d) { const m = String(d || "").match(/PT(?:(\d+)M)?(?:(\d+)S)?/); return m ? (Number(m[1] || 0) * 60 + Number(m[2] || 0)) : null; }
function confFor(n) { return n >= 200 ? "calibrated" : n >= 25 ? "directional" : "insufficient_data"; }

function calibrate() {
  const rows = readJsonl(VIRAL_RESEARCH);
  const n = rows.length;
  const views = rows.map((r) => r.views);
  const metaConf = confFor(n);

  // FIRST-PARTY: the user's OWN published videos — real editing features (from our
  // analysis of their own clip) vs real outcomes (their own analytics). This is
  // fully lawful AND is the signal that actually improves the editor over time.
  const fp = readJsonl(FIRST_PARTY); // [{videoId, features:{cutsPerMin,hookLength,motionIntensity}, outcomes:{views,retentionPct,completionPct}}]
  const fpN = fp.length;
  const fpConf = confFor(fpN);
  const feat = (k) => fp.map((r) => r.features && r.features[k]);
  const out = (k) => fp.map((r) => r.outcomes && r.outcomes[k]);
  const first_party = fpN >= 3
    ? {
      samples: fpN,
      cutsPerMin_vs_retention: { confidence: fpConf, correlation: pearson(feat("cutsPerMin"), out("retentionPct")), basis: "first_party (own content + own analytics)" },
      hookLength_vs_completion: { confidence: fpConf, correlation: pearson(feat("hookLength"), out("completionPct")), basis: "first_party" },
      motionIntensity_vs_views: { confidence: fpConf, correlation: pearson(feat("motionIntensity"), out("views")), basis: "first_party" },
    }
    : { samples: fpN, _status: { confidence: "insufficient_data", reason: `only ${fpN} of 25 first-party videos have reported outcomes — feed more of YOUR OWN published-video stats to calibrate the editor` } };

  const cal = {
    updatedAt: new Date().toISOString(),
    samples: n,
    signals: {
      duration_vs_views: { confidence: metaConf, correlation: n >= 3 ? pearson(rows.map((r) => isoDurationToSec(r.duration)), views) : null, basis: "public metadata" },
      hashtag_count_vs_views: { confidence: metaConf, correlation: n >= 3 ? pearson(rows.map((r) => (r.hashtags || []).length), views) : null, basis: "public metadata" },
      likes_vs_views: { confidence: metaConf, correlation: n >= 3 ? pearson(rows.map((r) => r.likes), views) : null, basis: "public metadata" },
      editing_features_vs_virality: { confidence: "insufficient_data", correlation: null, reason: "editing features of copyrighted viral videos cannot be lawfully extracted; the loop collects only their public metadata" },
    },
    first_party,
  };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CALIBRATION, JSON.stringify(cal, null, 2));
  return cal;
}

// Feed back one of the user's OWN published videos: its editing features (from
// our analysis of the clip we made) + its real outcomes (their own analytics).
function ingestFirstPartyOutcome(rec) {
  if (!rec || !rec.videoId || !rec.features || !rec.outcomes) return { ok: false, reason: "need { videoId, features:{...}, outcomes:{...} }" };
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(FIRST_PARTY, JSON.stringify({ ...rec, source: "first_party", ingestedAt: new Date().toISOString() }) + "\n");
  return { ok: true, videoId: rec.videoId };
}

// ── One cycle: Observe (discover) → Measure (store) → Calibrate → checkpoint ──
async function runCycle(opts = {}) {
  const cp = loadCheckpoint();
  cp.cycle += 1;
  if (!cp.startedAt) cp.startedAt = new Date().toISOString();
  const disc = await discoverMetadata(opts);
  let added = 0;
  if (disc.ok && disc.items.length) added = storeMetadata(disc.items);
  cp.metadataCollected += added;
  const cal = calibrate();
  cp.lastCycleAt = new Date().toISOString();
  saveCheckpoint(cp);
  return { cycle: cp.cycle, discovered: added, discoveryConfidence: disc.confidence, discoveryReason: disc.reason || null, calibration: cal };
}

// ── Perpetual loop: resumable, rate-limited. ─────────────────────────────────
async function runForever({ maxCycles = Infinity, cycleDelayMs = 60 * 60 * 1000, query } = {}) {
  for (let i = 0; i < maxCycles; i++) {
    try { const r = await runCycle({ query }); process.stdout.write(`[ci-loop] cycle ${r.cycle}: +${r.discovered} metadata (${r.discoveryConfidence})\n`); }
    catch (e) { console.error("[ci-loop] cycle error (continuing):", e.message); }
    if (i < maxCycles - 1) await sleep(cycleDelayMs); // rate-limit; checkpoint survives a crash
  }
}

function getLoopStatus() {
  const cp = loadCheckpoint();
  const cal = readJson(CALIBRATION, null);
  // Pool metadata signals + first-party editing→outcome signals for ranking.
  const allSignals = cal ? { ...cal.signals, ...(cal.first_party || {}) } : {};
  const rank = (v) => v === "calibrated" ? 2 : v === "directional" ? 1 : 0;
  const overall = Object.values(allSignals).reduce((acc, s) => (s && rank(s.confidence) > rank(acc)) ? s.confidence : acc, "insufficient_data");
  const top = Object.entries(allSignals).filter(([, s]) => s && Number.isFinite(s.correlation)).sort((a, b) => Math.abs(b[1].correlation) - Math.abs(a[1].correlation)).slice(0, 3).map(([k, s]) => ({ feature: k, correlation: s.correlation, confidence: s.confidence, basis: s.basis }));
  return { // This is the object returned by getLoopStatus
    cycle: cp.cycle,
    metadataCollected: cp.metadataCollected,
    firstPartyVideos: cal && cal.first_party ? cal.first_party.samples : 0,
    lastCycleAt: cp.lastCycleAt,
    overallConfidence: overall,
    topCorrelatedFeatures: top,
    lastCalibration: cal ? cal.updatedAt : null,
  };
}

module.exports = { runCycle, runForever, calibrate, discoverMetadata, storeMetadata, ingestFirstPartyOutcome, getLoopStatus, loadCheckpoint };

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    if (process.argv.includes("--status")) { process.stdout.write(JSON.stringify(getLoopStatus(), null, 2) + "\n"); return; }
    if (process.argv.includes("--calibrate")) { process.stdout.write(JSON.stringify(calibrate(), null, 2) + "\n"); return; }
    if (process.argv.includes("--forever")) {
      const lim = Number((process.argv.find((a) => a.startsWith("--max-cycles=")) || "").split("=")[1]) || Infinity;
      await runForever({ maxCycles: lim });
      return;
    }
    process.stdout.write(JSON.stringify(await runCycle(), null, 2) + "\n");
  })().catch((e) => { console.error("ERR", e.message); process.exit(1); });
}
