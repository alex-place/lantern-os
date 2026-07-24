// Dreamer notebook and agent list
module.exports = async function dreamerRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, path, repoRoot,
    normalizeDreamerUser, dreamerNotebookPath, appendDreamerEntry,
    readDreamerNotebook, readRecentDreams, dreamChatReply, AGENT_PERSONAS } = deps;

  if (url.pathname === "/api/dreamer" && req.method === "GET") {
    const user = normalizeDreamerUser(url.searchParams.get("user") || "dreamer");
    const entries = readDreamerNotebook(user);
    sendJson(res, { user, entries, path: path.relative(repoRoot, dreamerNotebookPath(user)) });
    return true;
  }
  if (url.pathname === "/api/dreamer" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);
      const user = normalizeDreamerUser(body.user || "dreamer");
      const record = await appendDreamerEntry(user, body);
      sendJson(res, { saved: true, record });
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }
  if (url.pathname === "/api/dreamer/chat" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);
      const user = normalizeDreamerUser(body.user || "orion");
      const kind = String(body.kind || "dream").slice(0, 40);
      const text = String(body.text || "").slice(0, 4000);
      const record = await appendDreamerEntry(user, { kind, text, name: body.name, mood: body.mood, tags: body.tags });
      const recentDreams = readRecentDreams(5);
      const chatResult = await dreamChatReply(`[${kind}] ${text}`, recentDreams, body.agent || "", body.provider || "");
      if (!chatResult.reply) {
        sendJson(res, { saved: true, record, error: chatResult.error || "no_provider_configured", agent: chatResult.agent, online: false, help: chatResult.help || "", suggestions: chatResult.suggestions || [] }, 503);
        return true;
      }
      sendJson(res, {
        saved: true, record,
        reply: chatResult.reply, agent: chatResult.agent,
        source: chatResult.online ? "llm" : "offline",
        suggestions: chatResult.suggestions,
      });
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }
  if (url.pathname === "/api/agents" && req.method === "GET") {
    sendJson(res, {
      agents: AGENT_PERSONAS.map((a) => ({ id: a.id, name: a.name, symbol: a.symbol, avatar: a.avatar || null, role: a.role || null })),
      default: AGENT_PERSONAS[0].id,
    });
    return true;
  }
  if (url.pathname === "/api/agents/slots" && req.method === "GET") {
    try {
      const fs = require("fs");
      const claudePath = path.join(repoRoot, ".claude", "agent-slots.json");
      const manifestPath = path.join(repoRoot, "manifests", "dream-journal-v1-agent-slots.json");
      let slotsPath = claudePath;
      if (!fs.existsSync(claudePath)) {
        if (!fs.existsSync(manifestPath)) {
          sendJson(res, { error: "agent-slots.json not found" }, 404);
          return true;
        }
        slotsPath = manifestPath;
      }
      if (!fs.existsSync(slotsPath)) {
        sendJson(res, { error: "agent-slots.json not found" }, 404);
        return true;
      }
      const raw = require("fs").readFileSync(slotsPath, "utf8");
      const data = JSON.parse(raw);
      sendJson(res, {
        slots: data.slots.map((s) => ({
          id: s.id,
          agent: s.agent,
          provider: s.provider,
          model: s.model,
          status: s.status,
          responsibilities: s.responsibilities,
          fallback: s.quotaTracking?.fallbackAgent || null,
        })),
        routing: data.routing?.dailyBootOrder || [],
        weights: data.routing?.weights || {},
      });
    } catch (error) {
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }
  if (url.pathname === "/api/dreamer/upload" && req.method === "POST") {
    console.log("[UPLOAD] Starting upload handler");
    try {
      const fs = require("fs");
      const busboy = require("busboy");
      // Identity comes from the authenticated SESSION, not a caller-supplied ?user=
      // (which previously let one account stage a video into any other user's notebook).
      // The premium guard already requires a Pro session to reach this endpoint, so a
      // session id is present; the query param is ignored when one exists.
      const { getEffectiveUserId } = require("../lib/session-identity");
      const user = normalizeDreamerUser(getEffectiveUserId(req) || url.searchParams.get("user") || "dreamer");
      console.log("[UPLOAD] Setup complete, creating busboy");

      const videosDir = path.join(repoRoot, "data", "dreamer", "videos");
      if (!fs.existsSync(videosDir)) {
        fs.mkdirSync(videosDir, { recursive: true });
      }

      const bb = busboy({ headers: req.headers });
      let fileInfo = null;
      let entryJson = null;
      let uploadError = null;
      let writePromise = null; // resolves once the video is fully flushed to disk

      // Generous default so long gameplay videos (often 1–3 GB) upload fully.
      // Override with LANTERN_MAX_UPLOAD_MB if needed.
      const MAX_FILE_SIZE = (Number(process.env.LANTERN_MAX_UPLOAD_MB) || 5120) * 1024 * 1024; // 5 GB default
      let bytesUploaded = 0;

      bb.on("file", (fieldname, file, info) => {
        if (fieldname === "file") {
          // Validate mime type — drain (resume), never destroy, so 'close' still fires.
          if (!info.mimeType || !info.mimeType.startsWith("video/")) {
            uploadError = new Error(`Invalid file type: ${info.mimeType}. Expected video/*`);
            file.resume();
            return;
          }

          const timestamp = Date.now();
          const filename = `${timestamp}-${info.filename}`;
          const filepath = path.join(videosDir, filename);
          const writeStream = fs.createWriteStream(filepath);
          let overLimit = false;
          const cleanupPartial = () => { try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch (_) {} };

          file.on("error", (err) => { uploadError = err; });

          file.on("data", (chunk) => {
            bytesUploaded += chunk.length;
            if (!overLimit && bytesUploaded > MAX_FILE_SIZE) {
              overLimit = true;
              uploadError = new Error(`File exceeds maximum size of ${Math.round(MAX_FILE_SIZE / (1024 * 1024))}MB`);
              // Stop writing and remove the partial file, but DRAIN the rest of the
              // request (file.resume) so busboy emits 'close' and we can respond.
              // Calling file.destroy() here stalls request parsing and hangs the
              // upload indefinitely (the ~27–32% freeze on long videos).
              file.unpipe(writeStream);
              writeStream.destroy();
              cleanupPartial();
              file.resume();
            }
          });

          // Respond only after the file is fully written, so fileInfo is populated
          // (busboy 'close' can otherwise fire before the disk write finishes).
          writePromise = new Promise((resolve) => {
            let settled = false;
            const done = () => { if (!settled) { settled = true; resolve(); } };
            writeStream.on("error", (err) => { uploadError = err; cleanupPartial(); done(); });
            // 'close' also covers writeStream.destroy() in the over-limit path,
            // which emits neither 'finish' nor 'error' — without this the handler
            // would await this promise forever and re-introduce the hang.
            writeStream.on("close", done);
            writeStream.on("finish", () => {
              if (!uploadError && !overLimit) {
                try {
                  const stats = fs.statSync(filepath);
                  fileInfo = {
                    filename: info.filename,
                    savedAs: filename,
                    mimeType: info.mimeType,
                    size: stats.size,
                    path: path.relative(repoRoot, filepath)
                  };
                } catch (err) { uploadError = err; }
              }
              done();
            });
          });

          file.pipe(writeStream);
        } else {
          file.resume();
        }
      });

      bb.on("field", (fieldname, value) => {
        console.log(`[dreamer] Field: ${fieldname} = ${typeof value}`);
        if (fieldname === "entry") {
          console.log(`[dreamer] Parsing entry JSON: ${value.substring(0, 50)}...`);
          try {
            entryJson = JSON.parse(value);
            // Validate entry structure
            if (typeof entryJson !== "object" || entryJson === null) {
              throw new Error("Entry must be an object");
            }
            // Sanitize title and description length
            if (entryJson.title && typeof entryJson.title === "string") {
              entryJson.title = entryJson.title.slice(0, 256);
            }
            if (entryJson.description && typeof entryJson.description === "string") {
              entryJson.description = entryJson.description.slice(0, 2048);
            }
            console.log(`[dreamer] Entry parsed successfully: ${JSON.stringify(entryJson)}`);
          } catch (e) {
            console.log(`[dreamer] Entry parse failed: ${e.message}`);
            uploadError = e;
          }
        }
      });

      bb.on("close", async () => {
        try {
          // Wait for the video to finish flushing to disk before replying.
          if (writePromise) await writePromise;
          console.log(`[dreamer] Close event - entryJson=${entryJson ? "defined" : "null"}, uploadError=${uploadError ? "yes" : "no"}`);

          if (uploadError) {
            sendJson(res, { error: uploadError.message }, 400);
            return;
          }

          if (!entryJson) {
            sendJson(res, { error: "No entry data provided" }, 400);
            return;
          }

          // Map JSON entry to dreamer schema
          const entry = {
            kind: entryJson.type || "video",
            name: entryJson.title || "Untitled",
            mood: entryJson.project || "",
            text: entryJson.description || "",
            tags: entryJson.tags ? entryJson.tags.split(",").map(t => t.trim()).filter(Boolean) : [],
          };

          const record = await appendDreamerEntry(user, entry);
          sendJson(res, {
            saved: true,
            record: { ...record, file: fileInfo },
            file: fileInfo
          });
        } catch (error) {
          sendJson(res, { error: error.message }, 400);
        }
      });

      bb.on("error", (error) => {
        if (!res.headersSent) {
          sendJson(res, { error: error.message }, 400);
        }
      });

      req.pipe(bb);
    } catch (error) {
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }
};
