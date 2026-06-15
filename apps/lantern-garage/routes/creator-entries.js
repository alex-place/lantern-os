// Creator Dashboard Entry Management Routes
// Handles entry metadata, analysis, renders, and thumbnails

module.exports = async function creatorEntriesRoutes(req, res, url, deps) {
  const { sendJson, path: pathModule, repoRoot, collectRequestBody } = deps;
  const fs = require("fs");
  const entryStore = require("../lib/entry-store");
  const { generateProjectThumbnail } = require("../lib/thumbnail-generator");
  const ci = require("../../../src/creator-intelligence");

  // =========================================================================
  // GET /api/creator-entries - List all entries
  // =========================================================================
  if (url.pathname === "/api/creator-entries" && req.method === "GET") {
    try {
      const entries = entryStore.listEntries(repoRoot);
      const enriched = entries.map((entry) => ({
        ...entry,
        formattedDate: entryStore.formatTimestamp(entry.createdAt),
      }));
      sendJson(res, { entries: enriched });
      return true;
    } catch (error) {
      console.error("[creator-entries] List error:", error.message);
      sendJson(res, { error: error.message }, 500);
      return true;
    }
  }

  // =========================================================================
  // GET /api/creator-entries/:id - Get entry details
  // =========================================================================
  const entryDetailMatch = url.pathname.match(/^\/api\/creator-entries\/([^/]+)$/);
  if (entryDetailMatch && req.method === "GET") {
    try {
      const entryId = entryDetailMatch[1];
      const entry = entryStore.getEntry(repoRoot, entryId);

      if (!entry) {
        sendJson(res, { error: "Entry not found" }, 404);
        return true;
      }

      // Include analysis if available
      const analysis = entryStore.getAnalysis(repoRoot, entryId);

      sendJson(res, {
        entry: {
          ...entry,
          formattedDate: entryStore.formatTimestamp(entry.createdAt),
        },
        analysis,
      });
      return true;
    } catch (error) {
      console.error("[creator-entries] Detail error:", error.message);
      sendJson(res, { error: error.message }, 500);
      return true;
    }
  }

  // =========================================================================
  // POST /api/creator-entries - Create new entry
  // =========================================================================
  if (url.pathname === "/api/creator-entries" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);

      // Create entry with metadata
      const entry = entryStore.createEntry(repoRoot, {
        title: body.title,
        description: body.description,
        project: body.project,
        tags: body.tags,
        type: body.type || "video",
        filePath: body.filePath,
      });

      // Generate thumbnail in background (non-blocking)
      if (body.filePath && (body.filePath.endsWith(".mp4") || body.filePath.endsWith(".mov") || body.filePath.endsWith(".avi"))) {
        setImmediate(async () => {
          try {
            const thumbnailPath = await generateProjectThumbnail(repoRoot, entry.id, body.filePath);
            if (thumbnailPath) {
              entryStore.updateEntry(repoRoot, entry.id, { thumbnail: thumbnailPath });
              console.log("[creator-entries] ✅ Thumbnail generated for entry " + entry.id);
            }
          } catch (err) {
            console.error("[creator-entries] Thumbnail generation failed:", err.message);
          }
        });
      }

      // Add formatted date and send
      const enrichedEntry = {
        ...entry,
        formattedDate: entryStore.formatTimestamp(entry.createdAt),
      };

      sendJson(res, {
        success: true,
        entry: enrichedEntry,
      });
      return true;
    } catch (error) {
      console.error("[creator-entries] Create error:", error.message, error.stack);
      sendJson(res, { error: error.message }, 500);
      return true;
    }
  }

  // =========================================================================
  // POST /api/creator-entries/:id/analysis - Save analysis results
  // =========================================================================
  const analysisMatch = url.pathname.match(
    /^\/api\/creator-entries\/([^/]+)\/analysis$/
  );
  if (analysisMatch && req.method === "POST") {
    try {
      const entryId = analysisMatch[1];
      const raw = await collectRequestBody(req);
      const analysis = JSON.parse(raw);

      entryStore.saveAnalysis(repoRoot, entryId, analysis);

      sendJson(res, { success: true, message: "Analysis saved" });
      return true;
    } catch (error) {
      console.error("[creator-entries] Analysis save error:", error.message);
      sendJson(res, { error: error.message }, 500);
      return true;
    }
  }

  // =========================================================================
  // POST /api/creator-entries/:id/render/:type - Save rendered video
  // =========================================================================
  const renderMatch = url.pathname.match(
    /^\/api\/creator-entries\/([^/]+)\/render\/([^/]+)$/
  );
  if (renderMatch && req.method === "POST") {
    try {
      const entryId = renderMatch[1];
      const renderType = renderMatch[2]; // highlight, variantA, variantB, variantC
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);

      if (!body.filePath) {
        sendJson(res, { error: "filePath required" }, 400);
        return true;
      }

      // ── Quality gate (Phase 7): validate the render before accepting it ──
      // Runs real ffprobe. Blocks an out-of-spec export unless body.force is set.
      // Result is always persisted so the verdict is traceable in the dashboard.
      const renderFullPath = pathModule.join(repoRoot, body.filePath);
      const rawValidation = await ci.validateExport(renderFullPath, {
        ...(body.validation || {}),
        captionsExpected: body.captionsExpected === true,
        captionBurnConfirmed: body.captionBurnConfirmed === true,
      });
      // Normalize: ci.validateExport must always return {ok, skipped, ...}.
      // Guard against unexpected shapes so the dashboard never receives undefined.
      const validation = (rawValidation && typeof rawValidation === "object")
        ? rawValidation
        : { ok: false, skipped: false, blockedReasons: ["validateExport returned invalid shape"] };

      try {
        entryStore.saveValidation(repoRoot, entryId, renderType, validation);
      } catch (e) {
        console.error("[creator-entries] saveValidation failed:", e.message);
      }

      if (!validation.ok && !validation.skipped && body.force !== true) {
        // Export blocked — report the concrete reasons, do not save the render.
        sendJson(res, {
          error: "Export blocked by ExportValidator",
          blocked: true,
          validation,
        }, 422);
        return true;
      }

      entryStore.saveRender(repoRoot, entryId, renderType, body.filePath);

      // Continuous-learning: record the accepted export (first-party, non-fatal)
      try {
        ci.training.recordExport(entryId, { renderType, validated: validation.ok === true });
      } catch (e) {
        console.error("[creator-entries] recordExport failed:", e.message);
      }

      // Regenerate thumbnail from highlight/render video (non-blocking)
      if (renderType === "highlight" || renderType.startsWith("variant")) {
        setImmediate(async () => {
          try {
            const thumbnailPath = await generateProjectThumbnail(repoRoot, entryId, body.filePath);
            if (thumbnailPath) {
              entryStore.updateEntry(repoRoot, entryId, { thumbnail: thumbnailPath });
              console.log(`[creator-entries] ✅ Updated thumbnail for ${renderType} video of entry ${entryId}`);
            }
          } catch (err) {
            console.error("[creator-entries] Thumbnail regeneration failed:", err.message);
          }
        });
      }

      sendJson(res, {
        success: true,
        message: `${renderType} render saved`,
        validation,
        forced: !validation.ok && body.force === true ? true : undefined,
      });
      return true;
    } catch (error) {
      console.error("[creator-entries] Render save error:", error.message);
      sendJson(res, { error: error.message }, 500);
      return true;
    }
  }

  // =========================================================================
  // POST /api/creator-entries/:id/regenerate-variants
  // =========================================================================
  // Re-derive ranked variants from the project's STORED analysis (no ffmpeg).
  // Works on any reopened project, persists, and survives refresh.
  const regenVariantsMatch = url.pathname.match(/^\/api\/creator-entries\/([^/]+)\/regenerate-variants$/);
  if (regenVariantsMatch && req.method === "POST") {
    try {
      const entryId = regenVariantsMatch[1];
      const analysis = entryStore.getAnalysis(repoRoot, entryId);
      if (!analysis || !Array.isArray(analysis.highlights)) {
        sendJson(res, { error: "No stored analysis — run Analyze Highlights first" }, 409);
        return true;
      }
      const variants = ci.generateVariantsV10(analysis, {});
      entryStore.updateEntry(repoRoot, entryId, { variantsV10: variants.variants });
      entryStore.touchStages(repoRoot, entryId, ["variants"]);
      sendJson(res, { success: true, variants: variants.variants });
      return true;
    } catch (error) {
      console.error("[creator-entries] regenerate-variants error:", error.message);
      sendJson(res, { error: error.message }, 500);
      return true;
    }
  }

  // =========================================================================
  // POST /api/creator-entries/:id/regenerate-captions
  // =========================================================================
  // Re-derive captions from the project's STORED analysis (no ffmpeg).
  const regenCaptionsMatch = url.pathname.match(/^\/api\/creator-entries\/([^/]+)\/regenerate-captions$/);
  if (regenCaptionsMatch && req.method === "POST") {
    try {
      const entryId = regenCaptionsMatch[1];
      const analysis = entryStore.getAnalysis(repoRoot, entryId);
      if (!analysis || !Array.isArray(analysis.highlights)) {
        sendJson(res, { error: "No stored analysis — run Analyze Highlights first" }, 409);
        return true;
      }
      const { generateCaptions } = require("../lib/caption-engine");
      const captions = generateCaptions(analysis, null, "gaming");
      const captionsJson = captions.map((c) => c.toJSON());
      entryStore.updateEntry(repoRoot, entryId, { captions: captionsJson });
      entryStore.touchStages(repoRoot, entryId, ["captions"]);
      sendJson(res, { success: true, captions: captionsJson });
      return true;
    } catch (error) {
      console.error("[creator-entries] regenerate-captions error:", error.message);
      sendJson(res, { error: error.message }, 500);
      return true;
    }
  }

  // =========================================================================
  // DELETE /api/creator-entries/:id/render/:renderId - Delete a render
  // =========================================================================
  const deleteRenderMatch = url.pathname.match(/^\/api\/creator-entries\/([^/]+)\/render\/([^/]+)$/);
  if (deleteRenderMatch && req.method === "DELETE") {
    try {
      const entryId = deleteRenderMatch[1];
      const renderId = deleteRenderMatch[2];
      const updated = entryStore.removeRenderRecord(repoRoot, entryId, renderId);
      sendJson(res, { success: true, renderRecords: updated.renderRecords });
      return true;
    } catch (error) {
      console.error("[creator-entries] delete render error:", error.message);
      sendJson(res, { error: error.message }, 500);
      return true;
    }
  }

  // =========================================================================
  // POST /api/creator-entries/:id/thumbnail - Save thumbnail
  // =========================================================================
  const thumbnailMatch = url.pathname.match(/^\/api\/creator-entries\/([^/]+)\/thumbnail$/);
  if (thumbnailMatch && req.method === "POST") {
    try {
      const entryId = thumbnailMatch[1];
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);

      if (!body.filePath) {
        sendJson(res, { error: "filePath required" }, 400);
        return true;
      }

      entryStore.saveThumbnail(repoRoot, entryId, body.filePath);

      sendJson(res, { success: true, message: "Thumbnail saved" });
      return true;
    } catch (error) {
      console.error("[creator-entries] Thumbnail save error:", error.message);
      sendJson(res, { error: error.message }, 500);
      return true;
    }
  }

  // =========================================================================
  // PUT /api/creator-entries/:id - Update entry metadata
  // =========================================================================
  const updateMatch = url.pathname.match(/^\/api\/creator-entries\/([^/]+)$/);
  if (updateMatch && req.method === "PUT") {
    try {
      const entryId = updateMatch[1];
      const raw = await collectRequestBody(req);
      const updates = JSON.parse(raw);

      const entry = entryStore.updateEntry(repoRoot, entryId, updates);

      sendJson(res, { success: true, entry });
      return true;
    } catch (error) {
      console.error("[creator-entries] Update error:", error.message);
      sendJson(res, { error: error.message }, 500);
      return true;
    }
  }

  // =========================================================================
  // DELETE /api/creator-entries/:id - Delete entry
  // =========================================================================
  const deleteMatch = url.pathname.match(/^\/api\/creator-entries\/([^/]+)$/);
  if (deleteMatch && req.method === "DELETE") {
    try {
      const entryId = deleteMatch[1];
      entryStore.deleteEntry(repoRoot, entryId);

      sendJson(res, { success: true, message: "Entry deleted" });
      return true;
    } catch (error) {
      console.error("[creator-entries] Delete error:", error.message);
      sendJson(res, { error: error.message }, 500);
      return true;
    }
  }

  return false;
};
