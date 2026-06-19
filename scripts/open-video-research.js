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
// Returns { ok, path } or { ok:false, reason }. yt-dlp is required for remote
// URLs; if it's absent we say so plainly rather than pretending to fetch.
function downloadVideo(url, opts = {}) {
  return new Promise((resolve) => {
    if (opts.localFile) {
      return resolve(fs.existsSync(url) ? { ok: true, path: url, local: true } : { ok: false, reason: "local file not found" });
    }
    const out = path.join(os.tmpdir(), `ovr_${Date.now()}.mp4`);
    let proc;
    try {
      proc = spawn("yt-dlp", ["-f", "mp4/bestvideo+bestaudio/best", "--no-playlist", "-o", out, url],
        { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, reason: "yt-dlp not available: " + e.message });
    }
    let err = "";
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", (e) => resolve({ ok: false, reason: "yt-dlp not installed (" + (e.code || e.message) + ")" }));
    proc.on("close", (code) => {
      if (code !== 0) return resolve({ ok: false, reason: `yt-dlp exit ${code}: ${err.split("\n").slice(-2).join(" ").trim()}` });
      resolve(fs.existsSync(out) ? { ok: true, path: out } : { ok: false, reason: "download produced no file" });
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
  const audioPeaks = audio.filter((a) => a.transient || a.loudness > 0.7).length;

  const szRes = await sz.analyzeForCrop(videoPath, { fps: 1 }).catch(() => ({ status: "unavailable" }));
  const facecam = szRes.status === "ok" ? (szRes.regions || []).find((r) => r.type === "facecam") : null;

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

module.exports = { downloadVideo, analyzeForResearch, research, storeFeatures, aggregateEditingPriors };

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    if (process.argv.includes("--aggregate")) {
      console.log(JSON.stringify(aggregateEditingPriors(), null, 2));
      return;
    }
    const src = process.argv[2];
    if (!src) { console.error("usage: node open-video-research.js <url|file [--local]> | --aggregate"); process.exit(1); }
    const r = await research(src, { source: src, localFile: process.argv.includes("--local") });
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(1);
  })().catch((e) => { console.error("ERR", e.message); process.exit(1); });
}
