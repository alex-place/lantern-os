#!/usr/bin/env node
// End-to-end Creator Dashboard pipeline test — drives the REAL backend code
// (entry-store + JobQueue + JobWorker + creator-intelligence), not mocks.
//
// Covers: upload-equivalent (createEntry) -> thumbnail -> analyze -> Σ₀ metrics
// -> highlights -> variants(+segments) -> safe zones -> captions -> render mp4
// -> persistence reload. Prints a PASS/FAIL table and exits non-zero on failure.
//
// Usage: node scripts/test_creator_pipeline.js
// A test asset is auto-generated at tests/assets/test-video.mp4 if missing.

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const repoRoot = process.cwd();
const entryStore = require("../lib/entry-store");
const { JobQueue } = require("../lib/job-queue");
const { JobWorker } = require("../lib/job-worker");
const { generateProjectThumbnail } = require("../lib/thumbnail-generator");

process.env.LANTERN_JOB_IDLE_TIMEOUT_MS = process.env.LANTERN_JOB_IDLE_TIMEOUT_MS || "1800000";

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? "  — " + detail : ""}`);
}
const num = (v) => typeof v === "number" && Number.isFinite(v);

// ── Ensure a test asset exists ───────────────────────────────────────────────
function ensureTestAsset() {
  const assetDir = path.join(repoRoot, "tests", "assets");
  const asset = path.join(assetDir, "test-video.mp4");
  if (fs.existsSync(asset) && fs.statSync(asset).size > 100000) return asset;
  fs.mkdirSync(assetDir, { recursive: true });

  // Prefer trimming a real source for genuine motion; else synthesize one.
  const realSrc = path.join(repoRoot, "data", "dreamer", "videos", "1781483831769-2025-12-08 20-45-57.mkv");
  let args;
  if (fs.existsSync(realSrc)) {
    args = ["-y", "-ss", "300", "-i", realSrc, "-t", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-c:a", "aac", asset];
  } else {
    args = ["-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=30",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=30", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", asset];
  }
  console.log("[setup] generating test asset…");
  const r = spawnSync("ffmpeg", args, { stdio: "ignore" });
  if (r.status !== 0 || !fs.existsSync(asset)) throw new Error("failed to generate test asset");
  return asset;
}

async function main() {
  const assetAbs = ensureTestAsset();
  // Path relative to repoRoot, as the app stores it.
  const videoPath = path.relative(repoRoot, assetAbs).split(path.sep).join("/");
  const queue = new JobQueue(repoRoot);
  const worker = new JobWorker(queue, repoRoot);

  // ── 1. Upload-equivalent: create the project entry ─────────────────────────
  const entry = entryStore.createEntry(repoRoot, { title: "E2E Pipeline Test", filePath: videoPath, type: "video" });
  record("1. Upload/createEntry", !!(entry && entry.id && entry.filePath && entry.createdAt),
    `id=${entry.id}`);
  const entryId = entry.id;

  // ── 2. Thumbnail from a video frame ────────────────────────────────────────
  let thumbPath = null;
  try { thumbPath = await generateProjectThumbnail(repoRoot, entryId, videoPath); } catch (e) { /* recorded below */ }
  if (thumbPath) entryStore.updateEntry(repoRoot, entryId, { thumbnail: thumbPath });
  const thumbAbs = thumbPath ? path.join(repoRoot, thumbPath) : null;
  record("2. Thumbnail generated", !!(thumbAbs && fs.existsSync(thumbAbs) && fs.statSync(thumbAbs).size > 1000),
    thumbPath || "no thumbnail");

  // ── 3. Analyze (real ffmpeg + Σ₀ scoring + variants + captions) ────────────
  const aJob = queue.enqueue("analyze", { videoPath, entryId, options: { gaming: true } });
  await worker.executeJob(aJob);
  record("3. Analysis completes", aJob.status === "complete", `status=${aJob.status}${aJob.error ? " err=" + aJob.error : ""}`);
  // progress must reach 100
  record("3b. Progress reaches 100%", aJob.progress === 100, `progress=${aJob.progress}`);

  // Load persisted results for inspection.
  const resultsFile = path.join(repoRoot, "data", "creator", "analyses", `${aJob.id}-results.json`);
  const persisted = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, "utf8")) : {};
  const timeline = persisted.timeline || {};
  const highlights = timeline.highlights || [];
  const scoreV10 = persisted.scoreV10 || {};

  // ── 4. Σ₀ / V10 metrics are real (not 0/null/NaN) ──────────────────────────
  const viral = scoreV10.viral || {};
  const comps = viral.componentScores || {};
  const metricChecks = {
    viralScore: viral.viralScore,
    hookSpeed: comps.hookSpeed && comps.hookSpeed.score,
    sceneDensity: comps.sceneDensity && comps.sceneDensity.score,
    audioEnergy: comps.audioEnergy && comps.audioEnergy.score,
    confidence: viral.confidence,
    gamingViralScore: scoreV10.gaming && scoreV10.gaming.gamingViralScore,
  };
  const metricsOk = num(metricChecks.viralScore) && num(metricChecks.confidence) &&
    num(metricChecks.gamingViralScore) && Object.values(metricChecks).every((v) => v === undefined || num(v));
  record("4. Σ₀/V10 metrics valid", metricsOk, JSON.stringify(metricChecks));

  // ── 5. Highlights present (>=1; ideally >=3) ───────────────────────────────
  record("5. Highlights generated", highlights.length > 0, `count=${highlights.length}`);

  // ── 6. Variants A/B/C(/D/E) all carry segments ─────────────────────────────
  const variants = persisted.variants || [];
  const variantsOk = variants.length >= 3 && variants.every((v) => Array.isArray(v.segments) && v.segments.length > 0);
  record("6. Variants have segments", variantsOk,
    `variants=${variants.length} segs=[${variants.map((v) => v.segments.length).join(",")}]`);
  const top = variants.find((v) => v.rank === 1) || variants[0];

  // ── 7. Safe zones ──────────────────────────────────────────────────────────
  const szJob = queue.enqueue("safezones", { videoPath, entryId });
  await worker.executeJob(szJob);
  record("7. Safe zones detected", szJob.status === "complete",
    `status=${szJob.status}${szJob.result ? " result=" + (szJob.result.status || "ok") : ""}`);

  // ── 8. Captions (separate caption job over the analyzed timeline) ──────────
  const cJob = queue.enqueue("caption", { highlightTimeline: timeline, strategy: "gaming" });
  await worker.executeJob(cJob);
  const capCount = cJob.result && cJob.result.captionCount;
  record("8. Captions generated", cJob.status === "complete" && capCount > 0, `count=${capCount}`);

  // ── 9. Render Shorts -> real mp4 > 1MB, passes validator ───────────────────
  const eJob = queue.enqueue("export", {
    videoPath, entryId, renderKey: top.id, segments: top.segments,
    format: "9:16", fit: "pad", burnCaptions: false, validation: {},
  });
  await worker.executeJob(eJob);
  const er = eJob.result || {};
  const renderOk = eJob.status === "complete" && er.exportFile && fs.existsSync(er.exportFile) && er.size > 1024 * 1024;
  record("9. Render produces mp4 >1MB", renderOk,
    `status=${eJob.status} size=${er.size ? (er.size / 1048576).toFixed(2) + "MB" : "?"}${eJob.error ? " err=" + eJob.error : ""}`);

  // ── 10. Render dimensions are 1080x1920 (ffprobe) ──────────────────────────
  let dim = "?";
  if (er.exportFile && fs.existsSync(er.exportFile)) {
    const p = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", er.exportFile], { encoding: "utf8" });
    dim = (p.stdout || "").trim();
  }
  record("10. Render is 1080x1920", dim.replace(/\s/g, "") === "1080,1920", `dims=${dim}`);

  // ── 11. Persistence: reload entry from disk, everything survives ───────────
  const reloaded = entryStore.getEntry(repoRoot, entryId);
  const persistChecks = {
    title: !!reloaded.title,
    filePath: !!reloaded.filePath,
    thumbnail: !!reloaded.thumbnail,
    analysis: !!entryStore.getAnalysis(repoRoot, entryId),
    variants: Array.isArray(reloaded.variantsV10) && reloaded.variantsV10.length > 0,
    captions: Array.isArray(reloaded.captions) && reloaded.captions.length > 0,
    renderRecords: Array.isArray(reloaded.renderRecords) && reloaded.renderRecords.length > 0,
  };
  const persistOk = Object.values(persistChecks).every(Boolean);
  record("11. Persistence after reload", persistOk, JSON.stringify(persistChecks));

  // ── Summary ────────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  // Write machine-readable summary for the validation doc.
  const summaryFile = path.join(repoRoot, "data", "creator", "pipeline-test-summary.json");
  fs.writeFileSync(summaryFile, JSON.stringify({ at: new Date().toISOString(), entryId, results }, null, 2));
  console.log(`summary: ${path.relative(repoRoot, summaryFile)}`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((e) => { console.error("driver error:", e); process.exit(1); });
