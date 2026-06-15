// Creator Suite Routes V9 — Full Job Queue Integration
// All analysis, caption, and export operations queued asynchronously

module.exports = async function creatorRoutes(req, res, url, deps) {
  const { sendJson, path: pathModule, repoRoot, jobQueue, collectRequestBody } = deps;
  const fs = require("fs");

  // =========================================================================
  // POST /api/creator/analyze
  // =========================================================================
  // Queue a highlight analysis job
  // Returns immediately with job ID; analysis happens in background

  if (url.pathname === "/api/creator/analyze" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);

      const videoPath = body.videoPath;
      const entryId = body.entryId || null;
      if (!videoPath) {
        sendJson(res, { error: "videoPath required" }, 400);
        return true;
      }

      // Verify video exists
      const fullPath = pathModule.join(repoRoot, videoPath);
      if (!fs.existsSync(fullPath)) {
        sendJson(res, { error: "video file not found" }, 404);
        return true;
      }

      // Queue the job
      const job = jobQueue.enqueue("analyze", {
        videoPath,
        entryId,
        options: body.options || {},
      });

      sendJson(res, {
        success: true,
        jobId: job.id,
        status: job.status,
        message: "Analysis queued. Check /api/creator/job/" + job.id + " for progress",
      });
    } catch (error) {
      console.error("[creator] analyze queue error:", error.message);
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }

  // =========================================================================
  // GET /api/creator/job/:jobId
  // =========================================================================
  // Get job status and progress

  if (url.pathname.startsWith("/api/creator/job/") && req.method === "GET") {
    const jobId = url.pathname.split("/").pop();
    const job = jobQueue.getJob(jobId);

    if (!job) {
      sendJson(res, { error: "job not found" }, 404);
      return true;
    }

    sendJson(res, {
      jobId: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      progressMessage: job.progressMessage,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    });
    return true;
  }

  // =========================================================================
  // POST /api/creator/variants
  // =========================================================================
  // Queue variant generation (requires highlight timeline from analyze)

  if (url.pathname === "/api/creator/variants" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);

      if (!body.highlightTimeline) {
        sendJson(res, { error: "highlightTimeline required" }, 400);
        return true;
      }

      const job = jobQueue.enqueue("caption", {
        highlightTimeline: body.highlightTimeline,
        strategy: body.strategy || "gaming",
      });

      sendJson(res, {
        success: true,
        jobId: job.id,
        status: job.status,
        message: "Variant generation queued",
      });
    } catch (error) {
      console.error("[creator] variants error:", error.message);
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }

  // =========================================================================
  // POST /api/creator/captions
  // =========================================================================
  // Queue caption generation

  if (url.pathname === "/api/creator/captions" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);

      if (!body.highlightTimeline) {
        sendJson(res, { error: "highlightTimeline required" }, 400);
        return true;
      }

      const job = jobQueue.enqueue("caption", {
        highlightTimeline: body.highlightTimeline,
        strategy: body.strategy || "gaming",
        format: body.format || "all",
      });

      sendJson(res, {
        success: true,
        jobId: job.id,
        status: job.status,
        message: "Caption generation queued",
      });
    } catch (error) {
      console.error("[creator] captions error:", error.message);
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }

  // =========================================================================
  // POST /api/creator/safe-zones
  // =========================================================================
  // Queue safe zone detection

  if (url.pathname === "/api/creator/safe-zones" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);

      if (!body.videoPath) {
        sendJson(res, { error: "videoPath required" }, 400);
        return true;
      }

      // Verify video exists
      const fullPath = pathModule.join(repoRoot, body.videoPath);
      if (!fs.existsSync(fullPath)) {
        sendJson(res, { error: "video file not found" }, 404);
        return true;
      }

      const job = jobQueue.enqueue("safezones", {
        videoPath: body.videoPath,
        entryId: body.entryId || null, // persist crop plan onto the project
      });

      sendJson(res, {
        success: true,
        jobId: job.id,
        status: job.status,
        message: "Safe zone detection queued",
      });
    } catch (error) {
      console.error("[creator] safe-zones error:", error.message);
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }

  // =========================================================================
  // POST /api/creator/export
  // =========================================================================
  // Queue video export with specified format

  if (url.pathname === "/api/creator/export" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);

      if (!body.videoPath) {
        sendJson(res, { error: "videoPath required" }, 400);
        return true;
      }

      if (!body.format) {
        sendJson(res, { error: "format required (9:16, 16:9, 1:1, 4:5)" }, 400);
        return true;
      }

      const fullPath = pathModule.join(repoRoot, body.videoPath);
      if (!fs.existsSync(fullPath)) {
        sendJson(res, { error: "video file not found" }, 404);
        return true;
      }

      const job = jobQueue.enqueue("export", {
        videoPath: body.videoPath,
        variant: body.variant || "balanced",
        format: body.format,
        // V10 re-encode + crop-plan options (all optional)
        entryId: body.entryId || null, // when set, persists validation+fit back to the entry
        renderKey: body.renderKey || body.variant || "highlight",
        segments: Array.isArray(body.segments) ? body.segments : null, // variant cut-list (trim+concat)
        fit: body.fit, // pad (default) | crop | blur
        fps: body.fps,
        width: body.width,
        height: body.height,
        start: body.start,
        duration: body.duration,
        useSafeZones: body.useSafeZones === true, // crop-plan to avoid facecam/HUD
        burnCaptions: body.burnCaptions === true,  // overlay captions via subtitles filter
      });

      sendJson(res, {
        success: true,
        jobId: job.id,
        status: job.status,
        message: "Export queued",
      });
    } catch (error) {
      console.error("[creator] export error:", error.message);
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }

  // =========================================================================
  // GET /api/creator/queue
  // =========================================================================
  // Get queue status

  if (url.pathname === "/api/creator/queue" && req.method === "GET") {
    const stats = jobQueue.getStats();
    const pending = jobQueue.getPending();

    sendJson(res, {
      stats,
      pending: pending.map((j) => ({
        id: j.id,
        type: j.type,
        progress: j.progress,
        progressMessage: j.progressMessage,
      })),
    });
    return true;
  }

  // =========================================================================
  // GET /api/creator/health
  // =========================================================================
  // Creator Suite health check

  if (url.pathname === "/api/creator/health" && req.method === "GET") {
    const stats = jobQueue.getStats();

    sendJson(res, {
      status: "ready",
      service: "creator-suite-v9",
      features: [
        "highlight-analysis",
        "variant-generation",
        "caption-generation",
        "safe-zone-detection",
        "video-export",
      ],
      queue: stats,
    });
    return true;
  }

  return false;
};
