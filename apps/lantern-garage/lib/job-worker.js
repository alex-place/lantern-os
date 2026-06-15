// Lantern Creator Suite Job Worker
// Processes queued analysis, caption, and export jobs
// Runs async, updates progress, persists results

const fs = require("fs");
const path = require("path");
const { analyzeVideoForHighlights } = require("./highlight-engine");
const { generateCaptions } = require("./caption-engine");
const { detectSafeZones } = require("./safe-zone-detector");
const { reencodeToShortForm, renderSegments, probeSource, burnCaptionsToVideo } = require("./video-export");
const { analyzeForCrop } = require("./safe-zone-v2");
const ci = require("../../../src/creator-intelligence");

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

    try {
      job.start();
      this.jobQueue.updateJob(job);

      console.log(`[job-worker] Processing job ${job.id} (${job.type})`);

      let result;

      switch (job.type) {
        case "analyze":
          result = await processAnalyzeJob(job, this.repoRoot, (percent, msg) => {
            job.setProgress(percent, msg);
            this.jobQueue.updateJob(job);
          });
          break;

        case "caption":
          result = await processCaptionJob(job, this.repoRoot, (percent, msg) => {
            job.setProgress(percent, msg);
            this.jobQueue.updateJob(job);
          });
          break;

        case "export":
          result = await processExportJob(job, this.repoRoot, (percent, msg) => {
            job.setProgress(percent, msg);
            this.jobQueue.updateJob(job);
          });
          break;

        case "safezones":
          result = await processSafeZonesJob(job, this.repoRoot, (percent, msg) => {
            job.setProgress(percent, msg);
            this.jobQueue.updateJob(job);
          });
          break;

        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }

      job.complete(result);
      console.log(`[job-worker] Completed job ${job.id}`);
    } catch (error) {
      job.fail(error);
      console.error(`[job-worker] Failed job ${job.id}:`, error.message);
    } finally {
      this.jobQueue.updateJob(job);
      this.currentJob = null;
    }
  }
}

// ============================================================================
// JOB HANDLERS
// ============================================================================

async function processAnalyzeJob(job, repoRoot, updateProgress) {
  const { videoPath, options } = job.input;

  // Verify file exists
  const fullPath = path.join(repoRoot, videoPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  updateProgress(10, "Starting video analysis");

  // Run highlight analysis
  const timeline = await analyzeVideoForHighlights(fullPath, options || {});

  updateProgress(70, "Analyzing highlights");

  // Generate captions automatically
  const captions = generateCaptions(timeline, null, "gaming");
  updateProgress(85, "Generated captions");

  // V10 scoring + variants — computed from the REAL analysis timeline. Every
  // value is traceable to selected segments; nothing mocked (this replaces the
  // old retention-engine variants whose metrics used Math.random()).
  // Guard: analyzeVideoForHighlights may return either a HighlightTimeline
  // instance (with .toJSON()) or a plain object — handle both.
  const timelineJSON = typeof timeline.toJSON === "function" ? timeline.toJSON() : timeline;
  const gaming = (options || {}).gaming !== false;
  let scoreV10 = null;
  let variantsV10 = null;
  try {
    scoreV10 = ci.scoreVideoV10(timelineJSON, { gaming });
    variantsV10 = ci.generateVariantsV10(timelineJSON, { gaming });
    updateProgress(95, `Generated ${variantsV10.variants.length} ranked variants`);
  } catch (e) {
    console.error("[job-worker] V10 scoring/variants failed:", e.message);
  }

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
      const stages = ["analyzed"];
      if (variantsV10 && variantsV10.variants && variantsV10.variants.length) stages.push("variants");
      if (captions && captions.length) stages.push("captions");
      entryStore.touchStages(repoRoot, job.input.entryId, stages);
    } catch (e) {
      console.error("[job-worker] persist V10 results to entry failed:", e.message);
    }
  }

  updateProgress(100, "Analysis complete");

  return {
    timeline: timelineJSON,
    variants: variantsV10 ? variantsV10.variants : [],
    captions: captions.map((c) => c.toJSON()),
    scoreV10,
    resultsFile: resultFile,
  };
}

async function processCaptionJob(job, repoRoot, updateProgress) {
  const { highlightTimeline, strategy } = job.input;

  updateProgress(20, "Parsing timeline");

  // Generate captions with specified strategy
  const captions = generateCaptions(highlightTimeline, null, strategy || "gaming");

  updateProgress(60, `Generated ${captions.length} captions`);

  // Store captions in multiple formats
  const captionsDir = path.join(repoRoot, "data", "creator", "captions");
  if (!fs.existsSync(captionsDir)) {
    fs.mkdirSync(captionsDir, { recursive: true });
  }

  const vttPath = path.join(captionsDir, `${job.id}.vtt`);
  const srtPath = path.join(captionsDir, `${job.id}.srt`);
  const jsonPath = path.join(captionsDir, `${job.id}.json`);

  const { generateVTT, generateSRT, generateJSON } = require("./caption-engine");
  fs.writeFileSync(vttPath, generateVTT(captions));
  fs.writeFileSync(srtPath, generateSRT(captions));
  fs.writeFileSync(jsonPath, generateJSON(captions));

  updateProgress(100, "Captions saved");

  return {
    captionCount: captions.length,
    files: { vtt: vttPath, srt: srtPath, json: jsonPath },
  };
}

async function processExportJob(job, repoRoot, updateProgress) {
  const { videoPath, variant, format } = job.input;

  updateProgress(10, `Starting export (${format})`);

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
  const useSafeZones = job.input.useSafeZones === true || ci.isEnabled("safeZoneV2");
  if (job.input.fit === "crop" && useSafeZones) {
    updateProgress(20, "Detecting safe zones (facecam/HUD)");
    try {
      const meta = await probeSource(fullPath);
      // Guard: if dimensions are unavailable (probe failed), the crop rect normalization
      // base would be wrong — skip detection and fall back to naive center crop.
      if (!meta.width || !meta.height) {
        cropPlan = { status: "unavailable", note: "fell back to center crop", reason: "source dimensions unknown (probe failed)" };
      } else {
        const plan = await analyzeForCrop(fullPath, {
          srcWidth: meta.width,
          srcHeight: meta.height,
        });
        if (plan.status === "ok" && plan.cropPlan && plan.cropPlan.mode === "horizontal") {
          cropRect = plan.cropPlan.cropRect;
          cropPlan = { ...plan.cropPlan, regions: plan.regions, framesSampled: plan.framesSampled };
        } else {
          cropPlan = { status: plan.status, note: "fell back to center crop", reason: plan.reason };
        }
      }
    } catch (e) {
      console.error("[job-worker] safe-zone crop plan failed:", e.message);
      cropPlan = { status: "error", note: "fell back to center crop", reason: e.message };
    }
  }

  // A variant export supplies a segment cut-list -> trim+concat render.
  // Otherwise re-encode the whole clip to spec.
  const segments = Array.isArray(job.input.segments) ? job.input.segments : null;
  let encodeInfo;
  if (segments && segments.length) {
    updateProgress(30, `Rendering ${segments.length} segments to short-form (1080x1920)`);
    encodeInfo = await renderSegments(fullPath, exportFile, segments, {
      width: job.input.width, height: job.input.height, fps: job.input.fps,
      fit: job.input.fit, cropRect, maxDuration: job.input.maxDuration,
    });
  } else {
    updateProgress(30, "Re-encoding to short-form (1080x1920)");
    encodeInfo = await reencodeToShortForm(fullPath, exportFile, {
      width: job.input.width,
      height: job.input.height,
      fps: job.input.fps,
      fit: job.input.fit, // pad (default) | crop | blur
      start: job.input.start,
      duration: job.input.duration,
      maxDuration: job.input.maxDuration,
      cropRect, // null → center crop; set → safe-zone-aware crop
    });
  }
  if (cropPlan) encodeInfo.cropPlan = cropPlan;

  // ── Caption burning (optional post-process) ──
  // When burnCaptions is set, load captions from the entry (saved by processAnalyzeJob)
  // and burn them into the rendered video via ffmpeg subtitles filter. Non-fatal: if
  // no captions are available or the burn fails, the un-captioned render is kept.
  if (job.input.burnCaptions && fs.existsSync(exportFile)) {
    updateProgress(85, "Burning captions into video");
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
        console.log(`[job-worker] Burned ${captionData.length} captions into ${exportFile}`);
      } catch (e) {
        console.error("[job-worker] caption burn failed (non-fatal):", e.message);
        encodeInfo.captionsBurnFailed = e.message;
      }
    }
  }

  updateProgress(90, "Validating output");

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

  updateProgress(100, "Export complete");

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

async function processSafeZonesJob(job, repoRoot, updateProgress) {
  const { videoPath } = job.input;
  const fullPath = path.join(repoRoot, videoPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Video not found: ${videoPath}`);
  }

  updateProgress(15, "Sampling frames for facecam/HUD detection");

  const meta = await probeSource(fullPath);
  let result;
  if (!meta.width || !meta.height) {
    result = { status: "unavailable", reason: "source dimensions unknown (probe failed)" };
  } else {
    const plan = await analyzeForCrop(fullPath, { srcWidth: meta.width, srcHeight: meta.height });
    result = plan; // { status, regions, cropPlan, framesSampled, ... } — honest "unavailable" when detection fails
  }

  updateProgress(85, "Persisting safe zones");

  // Persist onto the project so crop previews reload after a refresh.
  if (job.input.entryId) {
    try {
      const entryStore = require("./entry-store");
      entryStore.updateEntry(repoRoot, job.input.entryId, {
        safezones: { ...result, computedAt: new Date().toISOString() },
      });
      entryStore.touchStages(repoRoot, job.input.entryId, ["safezones"]);
    } catch (e) {
      console.error("[job-worker] persist safezones failed:", e.message);
    }
  }

  updateProgress(100, "Safe zone detection complete");
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
