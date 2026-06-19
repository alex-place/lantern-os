// Lantern Creator Suite Job Worker
// Processes queued analysis, caption, and export jobs
// Runs async, updates progress, persists results

const fs = require("fs");
const path = require("path");
const { analyzeVideoForHighlights } = require("./highlight-engine");
const { generateCaptions } = require("./caption-engine");
const { detectSafeZones } = require("./safe-zone-detector");
const { reencodeToShortForm, renderSegments, probeSource, burnCaptionsToVideo } = require("./video-export");
// Facecam V3-aware crop analysis: same plan as safe-zone-v2 but with the facecam
// region upgraded by the thorough multi-window detector (falls back to v2 on error).
const { analyzeForCropV3: analyzeForCrop } = require("./safe-zone-v3");
const ci = require("../../../src/creator-intelligence");

// Stage manifests — defines named stages and their progress weight for each job type.
// Weights must sum to 100.
const STAGE_MANIFESTS = {
  analyze: [
    { id: "load",       name: "Loading Video",        weight: 5  },
    { id: "metadata",   name: "Extracting Metadata",  weight: 5  },
    { id: "frame_scan", name: "Scanning Frames",      weight: 25 },
    { id: "motion",     name: "Motion Analysis",      weight: 15 },
    { id: "highlights", name: "Detecting Highlights", weight: 15 },
    { id: "ranking",    name: "Ranking Moments",      weight: 10 },
    { id: "scoring",    name: "Scoring & Variants",   weight: 15 },
    { id: "saving",     name: "Saving Results",       weight: 10 },
  ],
  export: [
    { id: "prepare",   name: "Preparing Render",      weight: 10 },
    { id: "safezones", name: "Detecting Safe Zones",  weight: 15 },
    { id: "encode",    name: "Encoding Video",        weight: 55 },
    { id: "captions",  name: "Burning Captions",      weight: 10 },
    { id: "validate",  name: "Validating Output",     weight: 10 },
  ],
  safezones: [
    { id: "sample",  name: "Sampling Frames",    weight: 30 },
    { id: "detect",  name: "Detecting Regions",  weight: 40 },
    { id: "overlay", name: "Rendering Overlay",  weight: 20 },
    { id: "save",    name: "Saving Results",     weight: 10 },
  ],
  caption: [
    { id: "parse",    name: "Parsing Timeline",    weight: 30 },
    { id: "generate", name: "Generating Captions", weight: 50 },
    { id: "save",     name: "Saving Captions",     weight: 20 },
  ],
};

class JobWorker {
  constructor(jobQueue, repoRoot) {
    this.jobQueue = jobQueue;
    this.repoRoot = repoRoot;
    this.running = false;
    this.currentJob = null;
  }

  start(intervalMs = 2000) {
    if (this.running) return;
    this.running = true;
    console.log("[job-worker] Started");

    this.loopInterval = setInterval(() => this.processNextJob(), intervalMs);
  }

  stop() {
    this.running = false;
    if (this.loopInterval) clearInterval(this.loopInterval);
    console.log("[job-worker] Stopped");
  }

  async processNextJob() {
    if (this.currentJob) return; // Already processing

    const pending = this.jobQueue.getPending();
    if (pending.length === 0) return;

    const job = pending[0];
    await this.executeJob(job);
  }

  async executeJob(job) {
    this.currentJob = job;

    // Idle watchdog — if a job emits no progress for idleMs it is considered
    // wedged (e.g. a hung ffmpeg). We fail it with a timeout and release the
    // worker so one stuck job can never poison the whole queue forever.
    const idleMs = Number(process.env.LANTERN_JOB_IDLE_TIMEOUT_MS) || 5 * 60 * 1000;
    let lastProgressAt = Date.now();
    let watchdog = null;

    const flush = () => this.jobQueue.updateJob(job);

    const onProgress = (percent, msg) => {
      lastProgressAt = Date.now();
      job.setProgress(percent, msg);
      // Linear ETA from elapsed time and overall progress
      if (percent > 5 && job.startedAt) {
        const elapsedMs = Date.now() - new Date(job.startedAt).getTime();
        const totalEstMs = elapsedMs / (percent / 100);
        job.setEta(Math.round((totalEstMs - elapsedMs) / 1000));
      }
      flush();
    };

    // Rich context object passed to job handlers for stage/log/liveStats updates
    const ctx = {
      progress: onProgress,
      stage: (stageId) => {
        lastProgressAt = Date.now();
        job.startStage(stageId);
        flush();
      },
      log: (msg) => {
        lastProgressAt = Date.now();
        job.appendLog(msg);
        flush();
      },
      liveStats: (stats) => {
        lastProgressAt = Date.now();
        job.setLiveStats(stats);
        flush();
      },
    };

    try {
      job.start();
      // Initialize named stages for this job type
      const stageDefs = STAGE_MANIFESTS[job.type];
      if (stageDefs) job.setStages(stageDefs);
      flush();
      console.log(`[job-worker] Processing job ${job.id} (${job.type})`);

      const watchdogPromise = new Promise((_, reject) => {
        watchdog = setInterval(() => {
          if (Date.now() - lastProgressAt > idleMs) {
            clearInterval(watchdog); watchdog = null;
            reject(new Error(`timeout: no progress for ${Math.round(idleMs / 60000)} min`));
          }
        }, 15000);
      });

      const handlerPromise = (async () => {
        switch (job.type) {
          case "analyze": return processAnalyzeJob(job, this.repoRoot, ctx);
          case "caption": return processCaptionJob(job, this.repoRoot, ctx);
          case "export": return processExportJob(job, this.repoRoot, ctx);
          case "safezones": return processSafeZonesJob(job, this.repoRoot, ctx);
          default: throw new Error(`Unknown job type: ${job.type}`);
        }
      })();

      const result = await Promise.race([handlerPromise, watchdogPromise]);
      job.complete(result);
      console.log(`[job-worker] Completed job ${job.id}`);
    } catch (error) {
      job.fail(error);
      console.error(`[job-worker] Failed job ${job.id}:`, error.message);
      // Persist a structured failure on the project so the dashboard can show
      // exactly which stage failed and why, instead of a silent hang.
      if (job.type === "analyze" && job.input && job.input.entryId) {
        try {
          const entryStore = require("./entry-store");
          const failedStage = job.stages.find(s => s.status === "failed") || null;
          entryStore.recordAnalysisError(this.repoRoot, job.input.entryId, {
            stage: (failedStage && failedStage.name) || job.progressMessage || "unknown",
            error: error.message,
            at: new Date().toISOString(),
            jobId: job.id,
          });
        } catch (e) {
          console.error("[job-worker] persist analysis error failed:", e.message);
        }
      }
    } finally {
      if (watchdog) clearInterval(watchdog);
      this.jobQueue.updateJob(job);
      this.currentJob = null;
    }
  }
}

// ============================================================================
// JOB HANDLERS
// ============================================================================

async function processAnalyzeJob(job, repoRoot, ctx) {
  const { videoPath, options } = job.input;

  // Verify file exists
  const fullPath = path.join(repoRoot, videoPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  ctx.stage("load");
  ctx.progress(5, "Starting analysis");
  ctx.log("Analysis started");

  // Mark the project as analyzing so a reopened project reflects live state.
  if (job.input.entryId) {
    try { require("./entry-store").updateEntry(repoRoot, job.input.entryId, { status: "analyzing" }); } catch {}
  }

  ctx.stage("metadata");
  ctx.progress(8, "Reading video metadata");
  ctx.log("Reading video metadata");

  // Highlight engine status keys → stage transitions
  const stageFromKey = { loading_video: "load", analyzing_motion: "frame_scan", detecting_highlights: "highlights" };
  let highlightsFoundSoFar = 0;

  // Run highlight analysis — real ffmpeg motion/audio/scene detection.
  // Streams sub-stage progress (8→66%) so the bar never sits on one number.
  const timeline = await analyzeVideoForHighlights(fullPath, options || {}, (percent, statusKey, message) => {
    const nextStage = stageFromKey[statusKey];
    if (nextStage && job.currentStageId !== nextStage) {
      ctx.stage(nextStage);
    }
    ctx.progress(percent, message || statusKey);
    ctx.log(message || statusKey);

    // Parse "Analyzing motion (13s / 120s)" for live stats
    const motionMatch = message && message.match(/Analyzing motion \((\d+)s \/ (\d+)s\)/);
    if (motionMatch) {
      ctx.liveStats({ analyzedSec: parseInt(motionMatch[1]), totalSec: parseInt(motionMatch[2]) });
    }
  });

  // GUARANTEE: downstream variants/render require at least one highlight segment.
  // If real detection found nothing (a quiet clip, or a long source the detector
  // couldn't score), synthesize short sample windows so the pipeline produces a
  // renderable selection instead of dead-ending the user. These are explicitly
  // labeled "fallback" — we do NOT fabricate quality signals. Windows are kept
  // short (≤12s) and evenly spaced so the result is still a usable Short even for
  // a long source (a naive "thirds" split of a 17-min clip is not a Short).
  if (Array.isArray(timeline.highlights) && timeline.highlights.length === 0) {
    const dur = Number(timeline.duration) || 0;
    if (dur > 1.5) {
      const win = Math.min(12, Math.max(3, dur / 6));
      if (dur <= win * 2) {
        // Short clip: a single window covering it.
        timeline.addHighlight(0, Number(Math.min(dur, 12).toFixed(1)), 0.5,
          "fallback: whole clip (no strong signals detected)", ["fallback"]);
      } else {
        // Longer clip: three short windows at 20% / 50% / 80%.
        for (const c of [0.2, 0.5, 0.8]) {
          const start = Math.max(0, Math.min(dur * c - win / 2, dur - win));
          timeline.addHighlight(Number(start.toFixed(1)), Number((start + win).toFixed(1)), 0.5,
            "fallback: sampled window (no strong signals detected)", ["fallback"]);
        }
      }
      timeline.sort();
      ctx.log(`No highlights detected — inserted ${timeline.highlights.length} fallback window(s) so variants/render can proceed`);
    }
  }

  ctx.stage("ranking");
  ctx.progress(70, "Scoring highlights");
  ctx.log("Scoring highlights");

  // Generate captions automatically
  const captions = generateCaptions(timeline, null, "gaming");
  ctx.progress(80, "Generated captions");
  ctx.log(`Generated ${captions.length} captions`);

  // V10 scoring + variants — computed from the REAL analysis timeline. Every
  // value is traceable to selected segments; nothing mocked (this replaces the
  // old retention-engine variants whose metrics used Math.random()).
  // Guard: analyzeVideoForHighlights may return either a HighlightTimeline
  // instance (with .toJSON()) or a plain object — handle both.
  const timelineJSON = typeof timeline.toJSON === "function" ? timeline.toJSON() : timeline;
  const gaming = (options || {}).gaming !== false;
  let scoreV10 = null;
  let variantsV10 = null;

  ctx.stage("scoring");
  try {
    scoreV10 = ci.scoreVideoV10(timelineJSON, { gaming });
    variantsV10 = ci.generateVariantsV10(timelineJSON, { gaming });
    ctx.progress(93, `Generated ${variantsV10.variants.length} ranked variants`);
    ctx.log(`Generated ${variantsV10.variants.length} ranked variants`);
    if (scoreV10 && scoreV10.viralProbability != null) {
      ctx.liveStats({ topScore: (scoreV10.viralProbability * 100).toFixed(1) });
    }
    highlightsFoundSoFar = Array.isArray(timelineJSON.highlights) ? timelineJSON.highlights.length : 0;
    ctx.liveStats({ highlightsFound: highlightsFoundSoFar });
  } catch (e) {
    console.error("[job-worker] V10 scoring/variants failed:", e.message);
    ctx.log(`Scoring error (non-fatal): ${e.message}`);
  }

  // Phase 1 instrumentation — a compact, real debug summary persisted on the
  // project (analysis.debug) so a "no segments" state is never invisible.
  const tlDebug = (timelineJSON.metadata && timelineJSON.metadata.debug) || {};
  const segmentCount = Array.isArray(timelineJSON.highlights) ? timelineJSON.highlights.length : 0;
  const usedFallback = !!(variantsV10 && variantsV10.usedFallback) ||
    (Array.isArray(timelineJSON.highlights) && timelineJSON.highlights.some((h) => Array.isArray(h.tags) && h.tags.includes("fallback")));
  timelineJSON.debug = {
    videoDuration: tlDebug.videoDuration != null ? tlDebug.videoDuration : (timelineJSON.duration || null),
    fps: tlDebug.fps != null ? tlDebug.fps : null,
    sampledMotionFrames: tlDebug.sampledMotionFrames != null ? tlDebug.sampledMotionFrames : null,
    sceneChanges: tlDebug.sceneChanges != null ? tlDebug.sceneChanges : null,
    candidateCount: tlDebug.sampledMotionFrames != null ? tlDebug.sampledMotionFrames : null,
    segmentCount,
    variantCount: variantsV10 ? variantsV10.variants.length : 0,
    captionCount: captions.length,
    usedFallback,
  };
  ctx.log(`debug: segments=${segmentCount} variants=${timelineJSON.debug.variantCount} fallback=${usedFallback}`);

  ctx.stage("saving");
  ctx.progress(96, "Saving results");
  ctx.log("Saving analysis results");

  // Store results
  const resultsDir = path.join(repoRoot, "data", "creator", "analyses");
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const resultFile = path.join(resultsDir, `${job.id}-results.json`);
  const results = {
    jobId: job.id,
    videoPath,
    analysisTimestamp: new Date().toISOString(),
    timeline: timelineJSON,
    variants: variantsV10 ? variantsV10.variants : [],
    captions: captions.map((c) => c.toJSON()),
    scoreV10,
  };

  fs.writeFileSync(resultFile, JSON.stringify(results, null, 2));

  // Persist the V10 score + ranked variants + captions onto the entry when tied to one.
  if (job.input.entryId) {
    try {
      const entryStore = require("./entry-store");
      // Persist the timeline as analysis.json so Variants/Captions can be
      // regenerated later from stored data without re-running ffmpeg.
      entryStore.saveAnalysis(repoRoot, job.input.entryId, timelineJSON);
      entryStore.updateEntry(repoRoot, job.input.entryId, {
        scoreV10: scoreV10 || undefined,
        variantsV10: variantsV10 ? variantsV10.variants : undefined,
        captions: captions.map((c) => c.toJSON()),
        status: "ready",
      });
      // Stamp completion times for the stages this analyze produced, so the
      // workspace can show "Analysis ✓ <timestamp>" after any refresh.
      const entryStages = ["analyzed"];
      if (variantsV10 && variantsV10.variants && variantsV10.variants.length) entryStages.push("variants");
      if (captions && captions.length) entryStages.push("captions");
      entryStore.touchStages(repoRoot, job.input.entryId, entryStages);
      // Audit trail + clear any prior failure now that analysis succeeded.
      entryStore.addAnalysisRun(repoRoot, job.input.entryId, {
        jobId: job.id,
        status: "complete",
        startedAt: job.startedAt,
        finishedAt: new Date().toISOString(),
        highlightCount: Array.isArray(timelineJSON.highlights) ? timelineJSON.highlights.length : 0,
        durationSec: timelineJSON.duration || null,
        analysisCapped: !!(timelineJSON.metadata && timelineJSON.metadata.analysisCapped),
      });
      entryStore.clearAnalysisError(repoRoot, job.input.entryId);
    } catch (e) {
      console.error("[job-worker] persist V10 results to entry failed:", e.message);
    }
  }

  // Write highlight_debug.json — per-segment instrumentation for future tuning.
  // Note: per-signal strengths (motion, audio_peak, speech_energy) are null until
  // the highlight engine is extended to preserve per-frame signal values.
  try {
    const fmtTime = (s) => {
      const m = Math.floor(s / 60), sec = (s % 60).toFixed(1);
      return `${String(m).padStart(2, "0")}:${String(sec).padStart(4, "0")}`;
    };
    const debugSegs = Array.isArray(timelineJSON.highlights)
      ? timelineJSON.highlights.map(hl => ({
          segment: `${fmtTime(hl.start)}-${fmtTime(hl.end)}`,
          startSec: hl.start, endSec: hl.end, duration: hl.duration, score: hl.score,
          signals: Array.isArray(hl.tags) ? hl.tags : [], reason: hl.reason || "",
          motion: null, audio_peak: null, speech_energy: null,
        }))
      : [];
    const highlightDebug = {
      jobId: job.id, videoPath, analyzedAt: new Date().toISOString(),
      durationSec: timelineJSON.duration || null, highlightCount: debugSegs.length,
      segments: debugSegs,
      topHighlight: debugSegs.length > 0 ? debugSegs.reduce((a, b) => a.score > b.score ? a : b) : null,
      scoreV10: scoreV10 ? { viralPct: scoreV10.viralProbability != null ? (scoreV10.viralProbability * 100).toFixed(1) : null, grade: scoreV10.grade } : null,
    };
    fs.writeFileSync(path.join(resultsDir, `${job.id}-highlight_debug.json`), JSON.stringify(highlightDebug, null, 2));
    if (job.input.entryId) {
      try {
        const eStore = require("./entry-store");
        const eDir = eStore.getEntryDir(repoRoot, job.input.entryId);
        fs.mkdirSync(eDir, { recursive: true });
        fs.writeFileSync(path.join(eDir, "highlight_debug.json"), JSON.stringify(highlightDebug, null, 2));
      } catch {}
    }
    ctx.log(`Wrote highlight_debug.json (${debugSegs.length} segments)`);
  } catch (e) {
    console.error("[job-worker] highlight_debug.json write failed (non-fatal):", e.message);
  }

  ctx.log("Analysis complete");
  ctx.progress(100, "Analysis complete");

  return {
    timeline: timelineJSON,
    variants: variantsV10 ? variantsV10.variants : [],
    captions: captions.map((c) => c.toJSON()),
    scoreV10,
    resultsFile: resultFile,
  };
}

async function processCaptionJob(job, repoRoot, ctx) {
  const { highlightTimeline, strategy } = job.input;

  ctx.stage("parse");
  ctx.progress(20, "Parsing timeline");
  ctx.log("Parsing highlight timeline");

  // Generate captions with specified strategy
  const captions = generateCaptions(highlightTimeline, null, strategy || "gaming");

  ctx.stage("generate");
  ctx.progress(60, `Generated ${captions.length} captions`);
  ctx.log(`Generated ${captions.length} captions`);

  // Store captions in multiple formats
  const captionsDir = path.join(repoRoot, "data", "creator", "captions");
  if (!fs.existsSync(captionsDir)) {
    fs.mkdirSync(captionsDir, { recursive: true });
  }

  ctx.stage("save");
  const vttPath = path.join(captionsDir, `${job.id}.vtt`);
  const srtPath = path.join(captionsDir, `${job.id}.srt`);
  const jsonPath = path.join(captionsDir, `${job.id}.json`);

  const { generateVTT, generateSRT, generateJSON } = require("./caption-engine");
  fs.writeFileSync(vttPath, generateVTT(captions));
  fs.writeFileSync(srtPath, generateSRT(captions));
  fs.writeFileSync(jsonPath, generateJSON(captions));

  ctx.log("Saved VTT, SRT, JSON caption files");
  ctx.progress(100, "Captions saved");

  return {
    captionCount: captions.length,
    files: { vtt: vttPath, srt: srtPath, json: jsonPath },
  };
}

// Ensure a variant cut-list meets the ExportValidator minimum duration (15s)
// when the source has the footage — extend the last segment toward the source
// end, then the first segment toward the start. Prevents a valid-but-short
// variant from being blocked purely on length. If the source itself is shorter
// than the floor, segments are returned unchanged (cannot make a longer Short).
const EXPORT_MIN_DURATION_SEC = 15;
function topUpSegmentsToMinDuration(segments, sourceDur, minSec = EXPORT_MIN_DURATION_SEC) {
  if (!Array.isArray(segments) || !segments.length || !sourceDur || sourceDur < minSec) return segments;
  const segs = segments.map((s) => ({ ...s }));
  const total = () => segs.reduce((a, s) => a + Math.max(0, (s.end || 0) - (s.start || 0)), 0);
  if (total() >= minSec) return segs;
  const last = segs[segs.length - 1];
  last.end = Math.min(sourceDur, (last.end || 0) + (minSec - total()));
  if (total() < minSec) {
    const first = segs[0];
    first.start = Math.max(0, (first.start || 0) - (minSec - total()));
  }
  return segs;
}

async function processExportJob(job, repoRoot, ctx) {
  const { videoPath, variant, format } = job.input;

  ctx.stage("prepare");
  ctx.progress(10, `Starting export (${format})`);
  ctx.log(`Starting export — format: ${format}`);

  // Verify video exists
  const fullPath = path.join(repoRoot, videoPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Video not found: ${videoPath}`);
  }

  // Create export directory
  const exportsDir = path.join(repoRoot, "data", "creator", "exports");
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }

  // Sanitize the format for use in a filename — "9:16" has a colon, which is an
  // invalid path char on Windows (NTFS treats ':' as an ADS separator).
  const safeFormat = String(format || "short").replace(/[^a-z0-9_-]/gi, "_");
  const exportFile = path.join(exportsDir, `${job.id}-${safeFormat}.mp4`);

  // ── SafeZoneDetectorV2 crop plan (V10) ──
  // For crop mode, optionally compute a crop window that avoids slicing through
  // facecam/HUD candidates. Honest fallback: if detection is unavailable or
  // low-confidence, leave cropRect unset → naive center crop.
  let cropRect = null;
  let cropPlan = null;
  let facecamRect = null;
  const useSafeZones = job.input.useSafeZones === true || ci.isEnabled("safeZoneV2");
  const wantsFacecamTop = job.input.fit === "facecam-top";
  // Run detection for crop-mode safe zones, and ALWAYS for facecam-top (which
  // needs the facecam box to lift it to the top band).
  if ((job.input.fit === "crop" && useSafeZones) || wantsFacecamTop) {
    ctx.stage("safezones");
    ctx.progress(20, "Detecting safe zones (facecam/HUD)");
    ctx.log("Sampling frames for safe-zone detection");
    try {
      const meta = await probeSource(fullPath);
      // Guard: if dimensions are unavailable (probe failed), the crop rect normalization
      // base would be wrong — skip detection and fall back to naive center crop.
      if (!meta.width || !meta.height) {
        cropPlan = { status: "unavailable", note: "fell back to center crop", reason: "source dimensions unknown (probe failed)" };
        ctx.log("Safe-zone detection unavailable — falling back to center crop");
      } else {
        let _fcg = job.input.facecamGuidance || null;
        if (!_fcg && job.input.entryId) { try { _fcg = require("./entry-store").getEntry(repoRoot, job.input.entryId)?.facecamGuidance || null; } catch {} }
        if (_fcg) ctx.log(`Applying facecam guidance: ${_fcg}`);
        const plan = await analyzeForCrop(fullPath, {
          srcWidth: meta.width,
          srcHeight: meta.height,
          facecamGuidance: _fcg,
        });
        if (plan.status === "ok") {
          if (plan.cropPlan && plan.cropPlan.mode === "horizontal") {
            cropRect = plan.cropPlan.cropRect;
          }
          cropPlan = { ...(plan.cropPlan || {}), regions: plan.regions, framesSampled: plan.framesSampled };
          // A confident facecam drives the facecam-top layout (locked to the top).
          const fc = (plan.regions || []).find((r) => r.type === "facecam" && !r.needsDeclaration);
          if (fc) {
            facecamRect = fc.bounds;
            ctx.log(`Facecam detected (${fc.corner}, conf ${fc.confidence}) — locking to top band`);
          }
          ctx.log(`Safe zones detected — ${(plan.regions || []).length} region(s)`);
        } else {
          cropPlan = { status: plan.status, note: "fell back to center crop", reason: plan.reason };
          ctx.log(`Safe-zone detection: ${plan.status} — center crop`);
        }
      }
    } catch (e) {
      console.error("[job-worker] safe-zone crop plan failed:", e.message);
      cropPlan = { status: "error", note: "fell back to center crop", reason: e.message };
      ctx.log(`Safe-zone error (non-fatal): ${e.message}`);
    }
  }

  // Lock a detected facecam to the top: an explicit facecam-top request OR any
  // crop-mode export that found a confident facecam upgrades to the split layout.
  // facecam-top without a facecam falls back to a safe fit (never a broken split).
  let effectiveFit = job.input.fit;
  if (facecamRect && (wantsFacecamTop || job.input.fit === "crop")) {
    effectiveFit = "facecam-top";
    ctx.log("Facecam locked to top band (facecam-top layout)");
  } else if (wantsFacecamTop && !facecamRect) {
    effectiveFit = cropRect ? "crop" : "pad";
    ctx.log(`No confident facecam — facecam-top falls back to ${effectiveFit}`);
  }

  // A variant export supplies a segment cut-list -> trim+concat render.
  // Otherwise re-encode the whole clip to spec.
  ctx.stage("encode");
  let segments = Array.isArray(job.input.segments) ? job.input.segments : null;
  let encodeInfo;
  if (segments && segments.length) {
    // Top up to the export minimum duration if the variant is short and the
    // source has the footage, so a valid render is never blocked purely on length.
    try {
      const probe = await probeSource(fullPath);
      const before = segments.reduce((a, s) => a + Math.max(0, (s.end || 0) - (s.start || 0)), 0);
      segments = topUpSegmentsToMinDuration(segments, probe && probe.duration);
      const after = segments.reduce((a, s) => a + Math.max(0, (s.end || 0) - (s.start || 0)), 0);
      if (after > before + 0.05) ctx.log(`Extended variant ${before.toFixed(1)}s -> ${after.toFixed(1)}s to meet export minimum`);
    } catch (e) { /* non-fatal: render the original cut-list */ }
    ctx.progress(30, `Rendering ${segments.length} segments to short-form (1080x1920)`);
    ctx.log(`Rendering ${segments.length} highlight segments`);
    encodeInfo = await renderSegments(fullPath, exportFile, segments, {
      width: job.input.width, height: job.input.height, fps: job.input.fps,
      fit: effectiveFit, cropRect, facecam: facecamRect, gameplayRect: cropRect,
      maxDuration: job.input.maxDuration,
    });
  } else {
    ctx.progress(30, "Re-encoding to short-form (1080x1920)");
    ctx.log("Re-encoding to 9:16 short-form");
    encodeInfo = await reencodeToShortForm(fullPath, exportFile, {
      width: job.input.width,
      height: job.input.height,
      fps: job.input.fps,
      fit: effectiveFit, // pad | crop | blur | facecam-top
      start: job.input.start,
      duration: job.input.duration,
      maxDuration: job.input.maxDuration,
      cropRect, // null → center crop; set → safe-zone-aware crop
      facecam: facecamRect, // facecam-top: lift this box to the top band
      gameplayRect: cropRect, // facecam-top: gameplay window (avoids the facecam)
    });
  }
  if (cropPlan) encodeInfo.cropPlan = cropPlan;

  // ── Caption burning (optional post-process) ──
  // When burnCaptions is set, load captions from the entry (saved by processAnalyzeJob)
  // and burn them into the rendered video via ffmpeg subtitles filter. Non-fatal: if
  // no captions are available or the burn fails, the un-captioned render is kept.
  if (job.input.burnCaptions && fs.existsSync(exportFile)) {
    ctx.stage("captions");
    ctx.progress(85, "Burning captions into video");
    ctx.log("Burning captions into rendered video");
    let captionData = job.input.captionData || null;
    if (!captionData && job.input.entryId) {
      try {
        const entryStore = require("./entry-store");
        const entryMeta = entryStore.getEntry(repoRoot, job.input.entryId);
        captionData = (entryMeta && Array.isArray(entryMeta.captions) && entryMeta.captions.length > 0)
          ? entryMeta.captions : null;
      } catch {}
    }
    if (captionData && captionData.length > 0) {
      const burnedFile = exportFile.replace(/\.mp4$/, "-captioned.mp4");
      try {
        await burnCaptionsToVideo(exportFile, burnedFile, captionData);
        fs.renameSync(burnedFile, exportFile);
        encodeInfo.captionsBurned = captionData.length;
        ctx.log(`Burned ${captionData.length} captions`);
        console.log(`[job-worker] Burned ${captionData.length} captions into ${exportFile}`);
      } catch (e) {
        console.error("[job-worker] caption burn failed (non-fatal):", e.message);
        encodeInfo.captionsBurnFailed = e.message;
        ctx.log(`Caption burn failed (non-fatal): ${e.message}`);
      }
    }
  }

  ctx.stage("validate");
  ctx.progress(90, "Validating output");
  ctx.log("Running export quality validation");

  // Verify output exists
  if (!fs.existsSync(exportFile)) {
    throw new Error("Export file was not created");
  }

  // ── Quality gate (Phase 7): validate with real ffprobe before completing ──
  // If the export does not meet short-form spec, block it: delete the invalid
  // file and fail the job with the concrete reasons. Honors exportValidator flag.
  const rawValidation = await ci.validateExport(exportFile, job.input.validation || {});
  const validation = (rawValidation && typeof rawValidation === "object")
    ? rawValidation
    : { ok: false, skipped: false, blockedReasons: ["validateExport returned invalid shape"] };

  // Persist verdict + encode info (fit mode, crop plan) back to the entry so the
  // dashboard can surface it. Recorded for both pass and block.
  if (job.input.entryId) {
    try {
      const entryStore = require("./entry-store");
      entryStore.saveValidation(repoRoot, job.input.entryId, job.input.renderKey || "highlight", {
        ...validation,
        encode: encodeInfo,
      });
    } catch (e) {
      console.error("[job-worker] persist validation failed:", e.message);
    }
  }

  if (!validation.ok && !validation.skipped) {
    try { fs.unlinkSync(exportFile); } catch { /* best-effort cleanup */ }
    const reasons = (validation.blockedReasons || []).join("; ") || "did not meet short-form spec";
    throw new Error(`Export blocked by ExportValidator: ${reasons}`);
  }

  const stats = fs.statSync(exportFile);

  // ── Register the render onto the project (persistence fix) ──
  // Previously the export landed only in data/creator/exports/ and was lost from
  // the workspace on refresh. Now we copy it into the project's renders/ folder
  // and record it (id/variant/path/duration/createdAt) so the Render Viewer shows
  // it after any refresh or restart.
  let renderRecord = null;
  if (job.input.entryId && (validation.ok || validation.skipped)) {
    try {
      const entryStore = require("./entry-store");
      const renderKey = job.input.renderKey || job.input.variant || "highlight";
      // saveRender copies the file into entries/<id>/renders/ and sets renders[key]
      entryStore.saveRender(repoRoot, job.input.entryId, renderKey, path.relative(repoRoot, exportFile));
      const saved = entryStore.getEntry(repoRoot, job.input.entryId);
      const renderRelPath = saved && saved.renders ? saved.renders[renderKey] : null;
      renderRecord = entryStore.addRenderRecord(repoRoot, job.input.entryId, {
        variant: renderKey,
        renderKey,
        path: renderRelPath || path.relative(repoRoot, exportFile),
        durationSec: encodeInfo && typeof encodeInfo.durationTarget === "number" ? encodeInfo.durationTarget : null,
        sizeBytes: stats.size,
        validation: { ok: validation.ok === true, skipped: validation.skipped === true },
      });
      entryStore.touchStages(repoRoot, job.input.entryId, ["rendered"]);
    } catch (e) {
      console.error("[job-worker] register render onto entry failed:", e.message);
    }
  }

  // Phase 7 — per-export render report in the project's renders/ folder.
  if (job.input.entryId) {
    try {
      const entryStore = require("./entry-store");
      const entry = entryStore.getEntry(repoRoot, job.input.entryId);
      const key = job.input.renderKey || job.input.variant || "highlight";
      const variant = (entry && Array.isArray(entry.variantsV10))
        ? entry.variantsV10.find((v) => v.id === key) : null;
      const viral = variant && variant.score ? variant.score : null;
      const segSec = Array.isArray(segments) ? segments.reduce((a, s) => a + Math.max(0, (s.end || 0) - (s.start || 0)), 0) : 0;
      const conf = viral && viral.confidence != null ? viral.confidence : null;
      const report = {
        variant: key,
        segments: Array.isArray(segments) ? segments.length : 0,
        duration: segSec ? `${Math.round(segSec)}s` : null,
        sigma0_score: viral && viral.viralScore != null ? viral.viralScore : null,
        confidence: conf,
        collapse_risk: conf != null ? Number((1 - conf).toFixed(3)) : null, // derived: 1 - confidence
        rendered: true,
        output: path.relative(repoRoot, exportFile).split(path.sep).join("/"),
        sizeBytes: stats.size,
        validation: { ok: validation.ok === true, skipped: validation.skipped === true },
        at: new Date().toISOString(),
      };
      const reportPath = path.join(entryStore.getEntryDir(repoRoot, job.input.entryId), "renders", "report.json");
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      ctx.log(`Render report: variant=${report.variant} segments=${report.segments} duration=${report.duration}`);
    } catch (e) {
      console.error("[job-worker] render report write failed (non-fatal):", e.message);
    }
  }

  ctx.log("Export complete");
  ctx.progress(100, "Export complete");

  return {
    format,
    exportFile,
    size: stats.size,
    created: stats.birthtime,
    encode: encodeInfo,
    validation,
    renderRecord,
  };
}

async function processSafeZonesJob(job, repoRoot, ctx) {
  const { videoPath } = job.input;
  const fullPath = path.join(repoRoot, videoPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Video not found: ${videoPath}`);
  }

  ctx.stage("sample");
  ctx.progress(15, "Sampling frames for facecam/HUD detection");
  ctx.log("Sampling frames for region detection");

  ctx.stage("detect");
  const meta = await probeSource(fullPath);
  let result;
  if (!meta.width || !meta.height) {
    result = { status: "unavailable", reason: "source dimensions unknown (probe failed)" };
    ctx.log("Detection unavailable — source dimensions unknown");
  } else {
    let _fcg = job.input.facecamGuidance || null;
    if (!_fcg && job.input.entryId) { try { _fcg = require("./entry-store").getEntry(repoRoot, job.input.entryId)?.facecamGuidance || null; } catch {} }
    if (_fcg) ctx.log(`Applying facecam guidance: ${_fcg}`);
    const plan = await analyzeForCrop(fullPath, { srcWidth: meta.width, srcHeight: meta.height, facecamGuidance: _fcg });
    result = plan; // { status, regions, cropPlan, framesSampled, ... } — honest "unavailable" when detection fails
    const regionCount = Array.isArray(plan.regions) ? plan.regions.length : 0;
    ctx.log(`Detection complete — ${regionCount} region(s) found (${plan.framesSampled || 0} frames sampled)`);
    ctx.liveStats({ regionsFound: regionCount, framesSampled: plan.framesSampled || 0 });
  }

  // Render a debug overlay (detected boxes drawn on a real frame) so the user
  // can VISUALLY verify the detections. Persisted into the project, served via /media.
  let overlayRel = null;
  if (result.status === "ok" && Array.isArray(result.regions) && job.input.entryId) {
    try {
      const { renderSafeZoneOverlay } = require("./safe-zone-v2");
      const entryStore = require("./entry-store");
      const dir = entryStore.getEntryDir(repoRoot, job.input.entryId);
      fs.mkdirSync(dir, { recursive: true });
      const outAbs = path.join(dir, "safezone-overlay.jpg");
      ctx.stage("overlay");
      ctx.progress(75, "Rendering safe-zone overlay");
      ctx.log("Rendering detection overlay image");
      const ov = await renderSafeZoneOverlay(fullPath, result.regions, outAbs, { at: 1 });
      if (ov.ok) overlayRel = path.relative(repoRoot, outAbs).split(path.sep).join("/");
    } catch (e) {
      console.error("[job-worker] safezone overlay render failed:", e.message);
      ctx.log(`Overlay render failed (non-fatal): ${e.message}`);
    }
  }

  ctx.stage("save");
  ctx.progress(85, "Persisting safe zones");
  ctx.log("Saving safe-zone data to project");

  // Persist onto the project so crop previews reload after a refresh.
  if (job.input.entryId) {
    try {
      const entryStore = require("./entry-store");
      entryStore.updateEntry(repoRoot, job.input.entryId, {
        safezones: { ...result, overlay: overlayRel, computedAt: new Date().toISOString() },
      });
      entryStore.touchStages(repoRoot, job.input.entryId, ["safezones"]);
    } catch (e) {
      console.error("[job-worker] persist safezones failed:", e.message);
      ctx.log(`Persist failed (non-fatal): ${e.message}`);
    }
  }

  // Write safe_zone_report.json alongside results for audit and enforcement tracking.
  try {
    const regions = Array.isArray(result.regions) ? result.regions : [];
    const facecam = regions.find(r => r.type === "facecam");
    const hudBands = regions.filter(r => r.type === "hud");
    const safeZoneReport = {
      jobId: job.id, videoPath: job.input.videoPath,
      detectedAt: new Date().toISOString(),
      status: result.status || "unavailable",
      framesSampled: result.framesSampled || 0,
      regions,
      cropPlan: result.cropPlan || null,
      enforcement: {
        facecam_visible: !!facecam,
        facecam_confidence: facecam ? facecam.confidence : null,
        facecam_corner: facecam ? facecam.corner : null,
        hud_bands_detected: hudBands.length,
        rejected: false,
        rejection_reason: null,
      },
    };
    // Reject crop if facecam was declared high-confidence but sits below 60% threshold
    if (facecam && facecam.confidence != null && facecam.confidence < 0.4) {
      safeZoneReport.enforcement.rejected = true;
      safeZoneReport.enforcement.rejection_reason = `facecam confidence ${facecam.confidence.toFixed(2)} below 0.40 threshold`;
    }
    if (job.input.entryId) {
      try {
        const eStore = require("./entry-store");
        const eDir = eStore.getEntryDir(repoRoot, job.input.entryId);
        fs.mkdirSync(eDir, { recursive: true });
        fs.writeFileSync(path.join(eDir, "safe_zone_report.json"), JSON.stringify(safeZoneReport, null, 2));
      } catch {}
    }
    ctx.log(`Wrote safe_zone_report.json (${regions.length} regions, rejected=${safeZoneReport.enforcement.rejected})`);
  } catch (e) {
    console.error("[job-worker] safe_zone_report.json write failed (non-fatal):", e.message);
  }

  ctx.log("Safe zone detection complete");
  ctx.progress(100, "Safe zone detection complete");
  return result;
}

async function processJob(job, repoRoot) {
  // Standalone job processor (used by single-job handlers)
  const worker = new JobWorker(null, repoRoot);
  await worker.executeJob(job);
  return job;
}

module.exports = {
  JobWorker,
  processJob,
};
