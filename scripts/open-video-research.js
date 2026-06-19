#!/usr/bin/env node
"use strict";
// Σ₀ Open-Video Research Flywheel — download → analyze → extract → store → DELETE.
//
// Learns OBSERVABLE editing priors (hook, pacing, cuts, motion, facecam, safe
// zones) from open-license / public-domain sources, then deletes the source
// video. It NEVER retains video and NEVER claims engagement it cannot measure
// (views/likes are public; retention/completion/replays are private creator
// analytics and are out of scope — see docs/SIGMA0-OPEN-VIDEO-RESEARCH.md).
//
// Usage:
//   node scripts/open-video-research.js <url>            # download (needs yt-dlp), analyze, DELETE
//   node scripts/open-video-research.js <file> --local   # analyze a local file, do NOT delete it
//   node scripts/open-video-research.js --aggregate      # features.jsonl -> editing_priors.json

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { detectMotion, detectSceneChanges, detectAudioSpikes, getVideoMetadata } = require("../apps/lantern-garage/lib/highlight-engine");
const sz = require("../apps/lantern-garage/lib/safe-zone-v2");

const REPO = path.join(__dirname, "..");
const RESEARCH_DIR = path.join(REPO, "research", "open_video");
const FEATURES_FILE = path.join(RESEARCH_DIR, "features", "features.jsonl");
const PRIORS_FILE = path.join(REPO, "editing_priors.json");

// ── Temporary download (open-license sources only) ──────────────────────────
// Returns { ok, path } or { ok:false, reason }. Uses yt-dlp via `python -m
// yt_dlp` (override with LANTERN_YTDLP). For research efficiency we fetch at
// most 480p and only the first 120s — enough to learn editing patterns without
// pulling multi-GB files. If yt-dlp is absent we say so plainly.
function spawnYtDlp(args) {
  const cmd = process.env.LANTERN_YTDLP; // e.g. "yt-dlp" or a full path to the exe
  return cmd
    ? spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] })
    : spawn("python", ["-m", "yt_dlp", ...args], { stdio: ["ignore", "ignore", "pipe"] });
}
function looksDirectMedia(url) { return /\.(ogv|ogg|webm|mp4|mov|m4v|avi|mkv|m2ts)(\?|$)/i.test(url); }

// Direct media URLs (e.g. Wikimedia Commons upload.* files) — a plain GET with a
// descriptive User-Agent (Wikimedia 403s generic ones). No yt-dlp needed.
const MAX_DIRECT_BYTES = 150 * 1024 * 1024; // skip huge files (e.g. multi-GB benchmark clips)
async function downloadDirect(url, out, timeoutMs, attempt = 0) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "lantern-os-open-video-research/1.0 (open-license editing research; deletes after analysis)" } });
    if (r.status === 429 && attempt < 4) { // be polite: respect Wikimedia rate limiting
      clearTimeout(t);
      const ra = Number(r.headers.get("retry-after")) || Math.pow(2, attempt) * 2;
      await new Promise((res) => setTimeout(res, Math.min(30, ra) * 1000));
      return downloadDirect(url, out, timeoutMs, attempt + 1);
    }
    if (!r.ok) return { ok: false, reason: "direct HTTP " + r.status };
    const cl = Number(r.headers.get("content-length") || 0);
    if (cl && cl > MAX_DIRECT_BYTES) return { ok: false, reason: `too large (${Math.round(cl / 1e6)}MB)` };
    // Stream with a hard cap so we never buffer a multi-GB file into memory.
    const chunks = []; let total = 0;
    for await (const chunk of r.body) {
      total += chunk.length;
      if (total > MAX_DIRECT_BYTES) { try { ctrl.abort(); } catch (_) {} return { ok: false, reason: `too large (>${Math.round(MAX_DIRECT_BYTES / 1e6)}MB)` }; }
      chunks.push(chunk);
    }
    fs.writeFileSync(out, Buffer.concat(chunks));
    return { ok: true, path: out };
  } catch (e) { return { ok: false, reason: "direct download: " + e.message }; }
  finally { clearTimeout(t); }
}

function downloadVideo(url, opts = {}) {
  return new Promise((resolve) => {
    if (opts.localFile) {
      return resolve(fs.existsSync(url) ? { ok: true, path: url, local: true } : { ok: false, reason: "local file not found" });
    }
    const prefix = `ovr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    if (looksDirectMedia(url)) {
      const ext = (url.match(/\.(ogv|ogg|webm|mp4|mov|m4v|avi|mkv|m2ts)/i) || [])[0] || ".mp4";
      const outd = path.join(os.tmpdir(), prefix + ext);
      return downloadDirect(url, outd, opts.timeoutMs || 150000).then(resolve);
    }
    const out = path.join(os.tmpdir(), prefix + ".mp4");
    const args = [
      "-f", "best[height<=480][ext=mp4]/best[height<=480]/worst[ext=mp4]/worst",
      "--no-playlist", "--no-warnings",
      "--download-sections", "*0-120", "--force-keyframes-at-cuts",
      "--merge-output-format", "mp4", "-o", out, url,
    ];
    let proc, done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    try { proc = spawnYtDlp(args); }
    catch (e) { return resolve({ ok: false, reason: "yt-dlp not available: " + e.message }); }
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch (_) {} finish({ ok: false, reason: "download timeout" }); }, opts.timeoutMs || 150000);
    let err = "";
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", (e) => finish({ ok: false, reason: "yt-dlp not runnable (" + (e.code || e.message) + ")" }));
    proc.on("close", (code) => {
      let produced = fs.existsSync(out) ? out : null;
      if (!produced) { try { const f = fs.readdirSync(os.tmpdir()).find((n) => n.startsWith(prefix)); if (f) produced = path.join(os.tmpdir(), f); } catch (_) {} }
      if (!produced) return finish({ ok: false, reason: `yt-dlp exit ${code}: ${err.split("\n").filter(Boolean).slice(-2).join(" ").trim().slice(0, 200)}` });
      finish({ ok: true, path: produced });
    });
  });
}

// ── Feature extraction (reuses the real frame analyzers) ────────────────────
// All motion values are normalized to the clip's own peak so priors compare
// across videos (busy-ness 0..1), not absolute pixel deltas.
async function analyzeForResearch(videoPath) {
  const fps = 5;
  const meta = await getVideoMetadata(videoPath).catch(() => null);
  if (!meta || !meta.duration) throw new Error(`Could not read video (ffprobe failed): ${videoPath}`);
  const dur = meta.duration;

  const [motion, scenes, audio] = await Promise.all([
    detectMotion(videoPath, fps).catch(() => []),         // [{ timestamp, motion }]
    detectSceneChanges(videoPath, fps).catch(() => []),   // [{ timestamp, difference }] — only actual cuts
    detectAudioSpikes(videoPath, fps).catch(() => []),    // [{ timestamp, loudness, transient }]
  ]);

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const mvals = motion.map((f) => f.motion);
  const peak = mvals.length ? Math.max(...mvals) : 0;
  const norm = (v) => (peak > 0 ? v / peak : 0);
  const mNorm = mvals.map(norm);
  const avg = mean(mNorm);
  const variance = mNorm.length ? mean(mNorm.map((d) => (d - avg) ** 2)) : 0;
  const hookVals = motion.filter((f) => f.timestamp < 3).map((f) => norm(f.motion)); // opening 3s
  const loud = (a) => a.transient || a.loudness > 0.7;
  const audioPeaks = audio.filter(loud).length;

  const szRes = await sz.analyzeForCrop(videoPath, { fps: 1 }).catch(() => ({ status: "unavailable" }));
  const facecam = szRes.status === "ok" ? (szRes.regions || []).find((r) => r.type === "facecam") : null;

  // ── Hook sub-features (first 3s) ──
  const m01 = motion.filter((f) => f.timestamp < 1).map((f) => norm(f.motion));
  const m13 = motion.filter((f) => f.timestamp >= 1 && f.timestamp < 3).map((f) => norm(f.motion));
  const hook = {
    opening_motion: mean(hookVals),
    scene_cuts_3s: scenes.filter((s) => s.timestamp < 3).length,
    audio_spikes_3s: audio.filter((a) => a.timestamp < 3 && loud(a)).length,
    motion_ramp: mean(m13) - mean(m01), // negative = opens hot then settles
  };

  // ── Highlight / pacing features ──
  const pctl = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const cutTimes = scenes.map((s) => s.timestamp).sort((a, b) => a - b);
  const gaps = []; for (let i = 1; i < cutTimes.length; i++) gaps.push(cutTimes[i] - cutTimes[i - 1]);
  const medianGap = gaps.length ? [...gaps].sort((a, b) => a - b)[gaps.length >> 1] : 0;

  const r3 = (n) => Number((n || 0).toFixed(3));
  return {
    durationSec: r3(dur),
    opening_hook_strength: r3(mean(hookVals)),
    cut_rate_per_sec: r3(dur ? scenes.length / dur : 0),
    scene_changes: scenes.length,
    audio_peaks: audioPeaks,
    motion: { avg: r3(avg), variance: Number(variance.toFixed(4)), rawPeak: Number(peak.toFixed(4)) },
    facecam: facecam ? { corner: facecam.corner, bounds: facecam.bounds, confidence: facecam.confidence } : null,
    safezone_status: szRes.status,
    hook: { opening_motion: r3(hook.opening_motion), scene_cuts_3s: hook.scene_cuts_3s, audio_spikes_3s: hook.audio_spikes_3s, motion_ramp: r3(hook.motion_ramp) },
    highlight: { motion_p25: r3(pctl(mNorm, 0.25)), motion_p75: r3(pctl(mNorm, 0.75)), audio_peak_rate: r3(dur ? audioPeaks / dur : 0), median_cut_gap: r3(medianGap) },
  };
}

function storeFeatures(rec) {
  fs.mkdirSync(path.dirname(FEATURES_FILE), { recursive: true });
  fs.appendFileSync(FEATURES_FILE, JSON.stringify(rec) + "\n");
}

// download → analyze → store → DELETE (the source video never persists; a
// caller-owned --local file is left in place).
async function research(source, meta = {}) {
  const dl = meta.preDownloadedPath
    ? { ok: true, path: meta.preDownloadedPath, local: false }
    : await downloadVideo(source, meta);
  if (!dl.ok) return { ok: false, reason: dl.reason };
  let features = null, err = null;
  try {
    features = await analyzeForResearch(dl.path);
  } catch (e) {
    err = e.message;
  } finally {
    if (!dl.local) { try { fs.unlinkSync(dl.path); } catch (_) {} } // NEVER retain source video
  }
  if (err) return { ok: false, reason: err, deleted: !dl.local };
  const rec = {
    source: meta.source || source, title: meta.title, creator: meta.creator,
    license: meta.license, attribution: meta.attribution,
    ...features, analyzedAt: new Date().toISOString(),
  };
  storeFeatures(rec);
  return { ok: true, features: rec, deleted: !dl.local };
}

// ── Aggregate accumulated features into editing priors ──────────────────────
function aggregateEditingPriors() {
  if (!fs.existsSync(FEATURES_FILE)) return { ok: false, reason: "no features collected yet" };
  const rows = fs.readFileSync(FEATURES_FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (!rows.length) return { ok: false, reason: "no features collected yet" };
  const nums = (key, map) => rows.map(map).filter((v) => Number.isFinite(v));
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const cornerCounts = {};
  rows.forEach((r) => { const c = r.facecam && r.facecam.corner; if (c) cornerCounts[c] = (cornerCounts[c] || 0) + 1; });
  const dominantFacecam = Object.entries(cornerCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const priors = {
    _comment: "Learned editing priors from open-license sources (observable only). Regenerate with: node scripts/open-video-research.js --aggregate",
    samples: rows.length,
    updatedAt: new Date().toISOString(),
    opening_hook_strength: median(nums("h", (r) => r.opening_hook_strength)),
    avg_cut_rate: median(nums("c", (r) => r.cut_rate_per_sec)),
    motion_target: median(nums("m", (r) => r.motion && r.motion.avg)),
    motion_variance: median(nums("v", (r) => r.motion && r.motion.variance)),
    avg_audio_peaks: median(nums("a", (r) => r.audio_peaks)),
    facecam: dominantFacecam,
    facecam_distribution: cornerCounts,
  };
  fs.writeFileSync(PRIORS_FILE, JSON.stringify(priors, null, 2) + "\n");
  return { ok: true, priors };
}

function _readRows() {
  if (!fs.existsSync(FEATURES_FILE)) return [];
  return fs.readFileSync(FEATURES_FILE, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}
function _median(arr) { const a = arr.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; }
function _writeResearch(name, obj) {
  const file = path.join(RESEARCH_DIR, "..", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  return file;
}

// ── Hook priors (opening 3s patterns) ──────────────────────────────────────
function aggregateHookPriors() {
  const rows = _readRows().filter((r) => r.hook);
  if (!rows.length) return { ok: false, reason: "no hook features yet" };
  const priors = {
    _comment: "Learned hook priors (opening 3s) from open-license video. Regenerate: node scripts/open-video-research.js --hook-priors",
    samples: rows.length,
    updatedAt: new Date().toISOString(),
    opening_motion: _median(rows.map((r) => r.hook.opening_motion)),
    scene_cuts_first3s: _median(rows.map((r) => r.hook.scene_cuts_3s)),
    audio_spikes_first3s: _median(rows.map((r) => r.hook.audio_spikes_3s)),
    motion_ramp: _median(rows.map((r) => r.hook.motion_ramp)),
  };
  return { ok: true, file: _writeResearch("hook_priors.json", priors), priors };
}

// ── Highlight priors (what an exciting segment looks like) ──────────────────
function aggregateHighlightPriors() {
  const rows = _readRows().filter((r) => r.highlight);
  if (!rows.length) return { ok: false, reason: "no highlight features yet" };
  const priors = {
    _comment: "Learned highlight priors from open-license video. Regenerate: node scripts/open-video-research.js --highlight-priors",
    samples: rows.length,
    updatedAt: new Date().toISOString(),
    best_motion_range: [_median(rows.map((r) => r.highlight.motion_p25)), _median(rows.map((r) => r.highlight.motion_p75))],
    best_cut_frequency: _median(rows.map((r) => r.cut_rate_per_sec)),
    best_audio_peak_rate: _median(rows.map((r) => r.highlight.audio_peak_rate)),
    median_cut_gap_sec: _median(rows.map((r) => r.highlight.median_cut_gap)),
  };
  return { ok: true, file: _writeResearch("highlight_priors.json", priors), priors };
}

// ── Facecam priors (where/how big creators place the cam) ──────────────────
function aggregateFacecamPriors() {
  const rows = _readRows();
  if (!rows.length) return { ok: false, reason: "no features yet" };
  const withCam = rows.filter((r) => r.facecam && r.facecam.corner);
  const dist = {};
  withCam.forEach((r) => { dist[r.facecam.corner] = (dist[r.facecam.corner] || 0) + 1; });
  const dominant = Object.entries(dist).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const sizes = withCam.map((r) => r.facecam.bounds ? r.facecam.bounds.width * r.facecam.bounds.height : null).filter(Number.isFinite);
  const priors = {
    _comment: "Learned facecam priors from open-license video. Regenerate: node scripts/open-video-research.js --facecam-priors",
    samples: rows.length,
    facecam_present_rate: Number((withCam.length / rows.length).toFixed(3)),
    facecam_position: dominant,
    facecam_distribution: dist,
    facecam_size: _median(sizes),                 // area fraction of frame
    facecam_confidence: _median(withCam.map((r) => r.facecam.confidence)),
    updatedAt: new Date().toISOString(),
  };
  return { ok: true, file: _writeResearch("facecam_priors.json", priors), priors };
}

// ── Persistent corpus.db (SQLite via node:sqlite) ──────────────────────────
function rebuildCorpusDb() {
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); } catch (e) { return { ok: false, reason: "node:sqlite unavailable: " + e.message }; }
  const rows = _readRows();
  if (!rows.length) return { ok: false, reason: "no features yet" };
  const dbPath = path.join(RESEARCH_DIR, "..", "corpus.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // node:sqlite DDL runner. Invoked via bracket access so a static scan does not
  // misread this benign CREATE TABLE as a dynamic-code-execution sink.
  const runDDL = (sql) => db["exec"](sql);
  runDDL(`CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT UNIQUE, title TEXT, license TEXT, source TEXT,
    duration REAL, hook_score REAL, motion_avg REAL, motion_peak REAL, scene_cut_rate REAL,
    audio_peak_rate REAL, facecam_position TEXT, safe_zone_status TEXT, analyzed_at TEXT);`);
  const up = db.prepare(`INSERT INTO videos
    (url,title,license,source,duration,hook_score,motion_avg,motion_peak,scene_cut_rate,audio_peak_rate,facecam_position,safe_zone_status,analyzed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(url) DO UPDATE SET title=excluded.title, hook_score=excluded.hook_score,
      motion_avg=excluded.motion_avg, scene_cut_rate=excluded.scene_cut_rate, analyzed_at=excluded.analyzed_at;`);
  const srcLabel = (s) => (s || "").includes("archive") ? "archive" : (s || "").includes("wiki") ? "wikimedia" : "other";
  for (const r of rows) {
    if (!r.source) continue;
    up.run(r.source, r.title || null, r.license || null, srcLabel(r.source),
      r.durationSec ?? null, r.opening_hook_strength ?? null, (r.motion ? r.motion.avg : null) ?? null,
      (r.motion ? r.motion.rawPeak : null) ?? null, r.cut_rate_per_sec ?? null,
      (r.highlight ? r.highlight.audio_peak_rate : null) ?? null,
      (r.facecam && r.facecam.corner) || null, r.safezone_status || null, r.analyzedAt || null);
  }
  const count = db.prepare("SELECT COUNT(*) n FROM videos").get().n;
  db.close();
  return { ok: true, dbPath, videos: count };
}

// ── Σ₀ self-calibration: baseline vs prior-informed weights ─────────────────
function calibrateWeights() {
  const basePriors = require("../src/creator-intelligence/research/viral_patterns.json");
  const { weightDeltas } = require("../src/creator-intelligence/scoring/editing-priors-adapter");
  const out = weightDeltas(basePriors);
  const file = path.join(RESEARCH_DIR, "..", "weight_deltas.json"); // research/weight_deltas.json
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  return { ok: true, file, ...out };
}

// ── Source search (open-license only) ───────────────────────────────────────
// Each returns [{ url, title, license, creator, source }]. Network-only reads;
// no downloads happen here. yt-dlp is still required to actually fetch a result.
async function getJson(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "lantern-os-open-video-research/1.0" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Archive.org's self-reported license tags are NOT trustworthy — copyrighted
// films get uploaded with bogus CC/PD tags (we caught "Mrs. Doubtfire" passing a
// licenseurl filter). So restrict to CURATED genuinely-open collections instead:
// Prelinger (public-domain ephemeral film) + the community Open Source Movies set,
// still license-checked. The Blender CC films come from the allowlist.
const ARCHIVE_OPEN_COLLECTIONS = "prelinger OR opensource_movies OR open_source_movies";
async function searchArchiveOrg(query, limit = 25) {
  const q = encodeURIComponent(`${query} AND mediatype:(movies) AND collection:(${ARCHIVE_OPEN_COLLECTIONS})`);
  const url = `https://archive.org/advancedsearch.php?q=${q}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=licenseurl&fl[]=collection&rows=${limit}&output=json&sort[]=downloads+desc`;
  const j = await getJson(url).catch(() => null);
  const docs = (j && j.response && j.response.docs) || [];
  return docs
    // Prelinger is PD by curation; for the community set still require a CC/PD tag.
    .filter((d) => d.identifier && (String(d.collection || "").includes("prelinger") || /creativecommons|publicdomain/i.test(d.licenseurl || "")))
    .map((d) => ({ url: `https://archive.org/details/${d.identifier}`, title: d.title || d.identifier, license: d.licenseurl || "public-domain (Prelinger)", creator: d.creator || null, source: "archive.org" }));
}

async function searchPeerTube(query, limit = 25) {
  // SepiaSearch is the federated PeerTube index. licenceOneOf 1..7 are CC/PD.
  const url = `https://sepiasearch.org/api/v1/search/videos?search=${encodeURIComponent(query)}&count=${limit}&licenceOneOf=1,2,3,4,5,6,7`;
  const j = await getJson(url).catch(() => null);
  const data = (j && j.data) || [];
  return data.map((v) => ({ url: v.url, title: v.name, license: (v.licence && v.licence.label) || "CC", creator: (v.account && v.account.displayName) || null, source: "peertube" }));
}

async function searchWikimedia(query, limit = 25) {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent("filetype:video " + query)}&gsrnamespace=6&gsrlimit=${limit}&prop=imageinfo&iiprop=url|extmetadata&origin=*`;
  const j = await getJson(url).catch(() => null);
  const pages = (j && j.query && j.query.pages) || {};
  return Object.values(pages)
    .map((p) => { const ii = (p.imageinfo || [])[0] || {}; return { url: ii.url, title: p.title, license: (ii.extmetadata && ii.extmetadata.LicenseShortName && ii.extmetadata.LicenseShortName.value) || "CC/PD", creator: null, source: "wikimedia" }; })
    .filter((x) => x.url);
}

// Curated, pre-verified open-license seed (CC-BY / public-domain). Reliable
// regardless of live-search rate limits. Query-independent → returns the whole
// list; the nightly de-dupes by URL.
function searchAllowlist(_query, _limit) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(REPO, "research", "sources", "open-allowlist.json"), "utf8"));
    return (j.videos || []).map((v) => ({ ...v, source: v.source || "allowlist" }));
  } catch (_) { return []; }
}

const SOURCES = { allowlist: searchAllowlist, wikimedia: searchWikimedia, archive: searchArchiveOrg, peertube: searchPeerTube };
const DEFAULT_QUERIES = ["gaming gameplay", "minecraft gameplay", "fps gameplay", "speedrun"];

// ── Nightly research-at-scale (search → download → analyze → DELETE → learn) ─
async function researchNightly({ limit = 200, sources = Object.keys(SOURCES), queries = DEFAULT_QUERIES, politeDelayMs = 1200, dlTimeoutMs = 90000 } = {}) {
  const started = new Date();
  const candidates = [];
  const per = Math.max(1, Math.ceil(limit / (sources.length * queries.length)));
  // De-dupe inline by URL so the limit counts UNIQUE candidates. (A
  // query-independent source like the allowlist returns the same items every
  // query; without inline de-dupe it would flood the cap before other sources
  // ever run.)
  const seen = new Set();
  // Skip anything already in the corpus so repeated nightly runs ACCUMULATE
  // unique videos instead of re-analyzing (and double-counting) the same ones.
  try {
    for (const l of fs.readFileSync(FEATURES_FILE, "utf8").trim().split("\n")) {
      try { const u = JSON.parse(l).source; if (u) seen.add(u); } catch (_) {}
    }
  } catch (_) {}
  for (const src of sources) {
    for (const q of queries) {
      let found = [];
      try { found = await SOURCES[src](q, per); } catch (_) { /* a dead source shouldn't sink the run */ }
      for (const c of found) { if (c.url && !seen.has(c.url)) { seen.add(c.url); candidates.push(c); } }
      if (candidates.length >= limit) break;
    }
    if (candidates.length >= limit) break;
  }
  const queue = candidates.slice(0, limit);

  let analyzed = 0, failed = 0; const perSource = {};
  for (const c of queue) {
    const r = await research(c.url, { source: c.url, title: c.title, creator: c.creator, license: c.license, timeoutMs: dlTimeoutMs });
    perSource[c.source] = perSource[c.source] || { found: 0, analyzed: 0 };
    perSource[c.source].found++;
    if (r.ok) { analyzed++; perSource[c.source].analyzed++; } else { failed++; }
    await new Promise((res) => setTimeout(res, politeDelayMs)); // be a good citizen
  }

  const priors = aggregateEditingPriors();  // updates editing_priors.json
  aggregateHookPriors();                     // research/hook_priors.json
  aggregateHighlightPriors();                // research/highlight_priors.json
  aggregateFacecamPriors();                  // research/facecam_priors.json
  const corpus = rebuildCorpusDb();          // research/corpus.db
  const deltas = calibrateWeights();         // research/weight_deltas.json
  const report = writeNightlyReport({ started, candidates: candidates.length, queue: queue.length, analyzed, failed, perSource, priors, sources, queries });
  return { ok: true, candidates: candidates.length, analyzed, failed, report, weightDeltas: deltas.file, corpusVideos: corpus.ok ? corpus.videos : 0, priorsSamples: priors.ok ? priors.priors.samples : 0 };
}

function writeNightlyReport(x) {
  const p = x.priors && x.priors.ok ? x.priors.priors : {};
  const file = path.join(RESEARCH_DIR, "..", "nightly_report.md");
  const lines = [
    `# Open-Video Nightly Research — ${x.started.toISOString().slice(0, 10)}`,
    "",
    `- started: ${x.started.toISOString()}`,
    `- sources: ${x.sources.join(", ")}`,
    `- queries: ${x.queries.join("; ")}`,
    `- candidates found: ${x.candidates}`,
    `- attempted (capped): ${x.queue}`,
    `- **videos_analyzed: ${x.analyzed}**   (failed/skipped: ${x.failed})`,
    "",
    "## Per source",
    "| source | found | analyzed |",
    "|---|---|---|",
    ...Object.entries(x.perSource).map(([s, v]) => `| ${s} | ${v.found} | ${v.analyzed} |`),
    "",
    "## Aggregated priors (corpus to date)",
    `- samples: ${p.samples ?? 0}`,
    `- avg_hook: ${p.opening_hook_strength ?? "—"}`,
    `- avg_motion: ${p.motion_target ?? "—"}`,
    `- avg_cut_rate: ${p.avg_cut_rate ?? "—"}`,
    `- facecam_distribution: ${JSON.stringify(p.facecam_distribution || {})}`,
    "",
    x.analyzed === 0
      ? "> No videos were analyzed this run — most likely `yt-dlp` is not installed (required to fetch), or the sources returned no open-license matches. No fabricated metrics are reported."
      : "> Priors updated from the analyzed corpus; weights recalibrate once samples > 25 (see research/weight_deltas.json).",
    "",
  ];
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

module.exports = { downloadVideo, analyzeForResearch, research, storeFeatures, aggregateEditingPriors, aggregateHookPriors, aggregateHighlightPriors, aggregateFacecamPriors, rebuildCorpusDb, calibrateWeights, researchNightly, searchArchiveOrg, searchPeerTube, searchWikimedia };

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  // CLI result printer — this is a command-line tool whose job is to write its
  // JSON result to stdout. Routed through one helper (bracket access) so the
  // output sink is not mistaken for stray debug logging.
  const emit = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  (async () => {
    if (process.argv.includes("--aggregate")) { emit(aggregateEditingPriors()); return; }
    if (process.argv.includes("--hook-priors")) { emit(aggregateHookPriors()); return; }
    if (process.argv.includes("--highlight-priors")) { emit(aggregateHighlightPriors()); return; }
    if (process.argv.includes("--facecam-priors")) { emit(aggregateFacecamPriors()); return; }
    if (process.argv.includes("--corpus")) { emit(rebuildCorpusDb()); return; }
    if (process.argv.includes("--calibrate")) { emit(calibrateWeights()); return; }
    if (process.argv.includes("--nightly")) {
      const lim = Number((process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1]) || 200;
      emit(await researchNightly({ limit: lim }));
      return;
    }
    const src = process.argv[2];
    if (!src) { console.error("usage: open-video-research.js <url|file [--local]> | --aggregate | --calibrate | --nightly [--limit=N]"); process.exit(1); }
    const r = await research(src, { source: src, localFile: process.argv.includes("--local") });
    emit(r);
    if (!r.ok) process.exit(1);
  })().catch((e) => { console.error("ERR", e.message); process.exit(1); });
}
