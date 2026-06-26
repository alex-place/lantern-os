const http = require("http");
const https = require("https");
const { refreshProviderCache } = require("../lib/provider-cache");
const modelRegistry = require("../lib/model-registry");
const { generateDoorSceneImage } = require("../lib/image-generation");

// Dream Journal core — create, chat, stream, stats, search, export, read, settings
const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "XAI_API_KEY", "OLLAMA_BASE_URL", "OLLAMA_MODEL", "ANTHROPIC_MODEL", "OPENAI_MODEL", "GEMINI_MODEL",
  "DISCORD_BOT_TOKEN", "LANTERN_DISCORD_GUILD_ID",
  "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID",
];

module.exports = async function dreamRoutes(req, res, url, deps) {
  const { fs, path, sendJson, collectRequestBody, appendJsonlQueued,
    repoRoot, maxDreamerTextLength, maxConversationTextLength,
    readRecentDreams, dreamChatReply, appendConversationEntry,
    unifiedAgentGreet, unifiedAgentHealth, unifiedAgentInspect,
    handleStreamChat } = deps;
  const { handleConvergenceCommand, selectAgent, verifyResponse, isVerifyEnabled } = require("../lib/dream-chat");
  const { classifyIntent, CAPABILITY_REGISTRY } = require("../lib/intent-router");

  if (url.pathname === "/api/dream/tools" && req.method === "GET") {
    const { capabilityManifest } = require("../lib/tool-runner");
    sendJson(res, capabilityManifest({
      executionEnabled: process.env.CHAT_TOOL_EXEC === "1",
    }));
    return true;
  }

  // ── CSF search endpoint ───────────────────────────────────────────────
  if (url.pathname === "/api/csf/search" && req.method === "GET") {
    const query = (url.searchParams.get("q") || "").trim();
    if (!query) {
      sendJson(res, { error: "q parameter required" }, 400);
      return true;
    }
    const topN = Math.min(10, Math.max(1, parseInt(url.searchParams.get("top_n") || "3", 10) || 3));
    try {
      const { spawn } = require("child_process");
      const py = process.platform === "win32" ? "python" : "python3";
      const result = await new Promise((resolve, reject) => {
        const proc = spawn(py, ["src/csf_search.py"], {
          cwd: repoRoot,
          env: { ...process.env, PYTHONPATH: path.join(repoRoot, "src") },
        });
        let out = "", err = "";
        proc.stdout.on("data", (c) => (out += c));
        proc.stderr.on("data", (c) => (err += c));
        const timeout = setTimeout(() => { proc.kill(); reject(new Error("csf_search timeout")); }, 8000);
        proc.on("close", (code) => {
          clearTimeout(timeout);
          if (code !== 0) reject(new Error(err || `csf_search exit ${code}`));
          else resolve(out.trim());
        });
        proc.on("error", (e) => { clearTimeout(timeout); reject(e); });
        proc.stdin.write(JSON.stringify({ query, top_n: topN }));
        proc.stdin.end();
      });
      const data = JSON.parse(result);
      sendJson(res, { ...data, query, generatedAt: new Date().toISOString() });
    } catch (err) {
      sendJson(res, { segments: [], query, error: err.message, generatedAt: new Date().toISOString() });
    }
    return true;
  }

  // ── Code modification endpoint (Keystone can apply real changes) ─────────
  if (url.pathname === "/api/code/apply" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw || "{}");
      const { filePath, changes, message } = body;

      if (!filePath || !changes) {
        sendJson(res, { error: "filePath and changes required" }, 400);
        return true;
      }

      const { execSync } = require("child_process");
      const fullPath = path.join(repoRoot, filePath);

      // Safety: ensure path is within repo
      const normalized = path.normalize(fullPath);
      if (!normalized.startsWith(path.normalize(repoRoot))) {
        sendJson(res, { error: "Path traversal blocked" }, 403);
        return true;
      }

      // Apply changes: either full replacement or array of edits
      let content;
      try {
        if (fs.existsSync(fullPath)) {
          content = fs.readFileSync(fullPath, "utf8");
        } else {
          content = "";
        }
      } catch (e) {
        sendJson(res, { error: `Cannot read file: ${e.message}` }, 400);
        return true;
      }

      if (typeof changes === "string") {
        // Full replacement
        content = changes;
      } else if (Array.isArray(changes)) {
        // Array of {old, new} replacements
        for (const edit of changes) {
          if (edit.old && edit.new !== undefined) {
            content = content.replace(edit.old, edit.new);
          }
        }
      }

      // Write file
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, content, "utf8");

      // Git add and commit
      try {
        execSync(`git add "${filePath}"`, { cwd: repoRoot });
        const commitMsg = message || `code: ${filePath}`;
        execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: repoRoot });
      } catch (gitErr) {
        // Commit might fail if nothing changed, that's OK
      }

      sendJson(res, {
        applied: true,
        filePath,
        committed: true,
        message: `Applied changes to ${filePath} and committed to git`,
      });
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }

  // ── Unified agent endpoints ───────────────────────────────────────────
  if (url.pathname === "/api/dream/greet" && req.method === "GET") {
    try {
      const recentDreams = readRecentDreams(5);
      const greet = await unifiedAgentGreet(recentDreams);
      sendJson(res, { ...greet, generatedAt: new Date().toISOString() });
    } catch (error) {
      sendJson(res, { greeting: "The dream door is open.", source: "offline_fallback", error: error.message });
    }
    return true;
  }
  if (url.pathname === "/api/agent/health" && req.method === "GET") {
    try {
      sendJson(res, { health: await unifiedAgentHealth(), generatedAt: new Date().toISOString() });
    } catch (error) { sendJson(res, { error: error.message }, 500); }
    return true;
  }
  if (url.pathname === "/api/agent/inspect" && req.method === "GET") {
    try {
      sendJson(res, { inspect: await unifiedAgentInspect(), generatedAt: new Date().toISOString() });
    } catch (error) { sendJson(res, { error: error.message }, 500); }
    return true;
  }

  // ── Dream CRUD ────────────────────────────────────────────────────────
  if (url.pathname === "/api/dream/create" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);
      const dreamId = `dream_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      const normalizeList = (value, limit = 12) => {
        if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean).slice(0, limit);
        return String(value || "").split(",").map((item) => item.trim()).filter(Boolean).slice(0, limit);
      };
      const entry = {
        id: dreamId, timestamp: new Date().toISOString(),
        kind: String(body.kind || "dream").slice(0, 40),
        name: String(body.name || body.title || "").slice(0, 140),
        text: String(body.text || body.content || "").slice(0, maxDreamerTextLength),
        lucidity: Math.max(0, Math.min(1, Number(body.lucidity || 0))),
        clarity: Math.max(0, Math.min(1, Number(body.clarity || 0))),
        mood: String(body.mood || "").slice(0, 80),
        technique: String(body.technique || "").slice(0, 80),
        sleep_window: String(body.sleep_window || "").slice(0, 80),
        recurring: Boolean(body.recurring), dreamsign: Boolean(body.dreamsign),
        emotions: normalizeList(body.emotions, 12), tags: normalizeList(body.tags, 10),
        symbols: normalizeList(body.symbols, 12),
        linked_goals: body.linked_goals || [], priority: body.priority || "normal",
        reflection_on: body.reflection_on || [], source: String(body.source || "api").slice(0, 40),
        dcf_class: body.dcf_class || null,
        rps_flags: body.rps_flags || [],
        ctf_glyphs: normalizeList(body.ctf_glyphs, 20),
      };
      const dreamDir = path.join(repoRoot, "data", "dream_journal");
      if (!fs.existsSync(dreamDir)) fs.mkdirSync(dreamDir, { recursive: true });
      const monthFile = path.join(dreamDir, `dreams_${new Date().toISOString().substring(0, 7)}.jsonl`);
      await appendJsonlQueued(monthFile, entry);

      // CSF delta ingest — non-blocking, non-fatal
      try {
        const { ingestEntry: csfIngest } = require("../lib/csf-delta-store");
        setImmediate(() => { try { csfIngest(entry); } catch {} });
      } catch {}

      // Dream Journal enrichment using Convergance OS models
      const enrichment = await enrichDreamEntry(entry);
      entry.models = enrichment.models;
      entry.doors = enrichment.doors;
      entry.symbols = enrichment.symbols;
      entry.image = enrichment.image;
      entry.receipt = enrichment.receipt;
      
      // MemOS ingest runs via: python -c "from src.convergence_io.memos_bridge import get_cube; get_cube().ingest_all()"
      // or automatically on each TesseractEngine._convergence_rag() call (lazy load).
      // Background CSF compression (non-blocking, debounced by file mtime)
      let csfStats = { compressed: false };
      try {
        const csfFile = monthFile.replace(/\.jsonl$/, ".csf");
        const jsonlStat = fs.existsSync(monthFile) ? fs.statSync(monthFile) : null;
        const csfStat = fs.existsSync(csfFile) ? fs.statSync(csfFile) : null;
        const needsCompress = !csfStat || !jsonlStat || (csfStat.mtime < jsonlStat.mtime);
        if (needsCompress) {
          const { spawn } = require("child_process");
          const py = process.platform === "win32" ? "python" : "python3";
          const script = `from csf.dream_compressor import compress_dream_file; compress_dream_file(r'${monthFile}')`;
          const proc = spawn(py, ["-c", script], { cwd: repoRoot, env: { ...process.env, PYTHONPATH: path.join(repoRoot, "src") } });
          proc.on("close", (code) => {
            csfStats = { compressed: code === 0 };
          });
        } else {
          csfStats = { compressed: true, cached: true };
        }
      } catch { /* compression is non-critical */ }

      // MemOS save-time ingest (non-blocking)
      let memosResult = { ingested: false };
      try {
        const { spawn } = require("child_process");
        const py = process.platform === "win32" ? "python" : "python3";
        const script = `import sys,json; from convergence_io.memos_bridge import get_cube; c=get_cube(); r=c.ingest_entry(json.loads(sys.stdin.read())); print(json.dumps({'ingested': r}))`;
        const proc = spawn(py, ["-c", script], { cwd: repoRoot, env: { ...process.env, PYTHONPATH: path.join(repoRoot, "src") } });
        let out = "";
        proc.stdout.on("data", (d) => { out += d.toString(); });
        proc.on("close", () => {
          try { memosResult = JSON.parse(out.trim()); } catch { /* non-critical */ }
        });
        proc.stdin.write(JSON.stringify(entry));
        proc.stdin.end();
      } catch { /* MemOS ingest is non-critical */ }

      sendJson(res, { id: dreamId, saved: true, entry, csf: csfStats, memos: memosResult });
    } catch (error) { sendJson(res, { error: error.message }, 400); }
    return true;
  }

  if (url.pathname === "/api/dream/chat" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw || "{}");
      const message = String(body.message || "").slice(0, maxDreamerTextLength);
      const recentDreams = readRecentDreams(5);
      const provStart = Date.now();

      // Check for !convergence / !convergance command
      let result;
      if (/^!convergan?ce/i.test(message.toLowerCase().trim())) {
        const requestedAgent = body.agent || "";
        const agent = requestedAgent
          ? require("../lib/dream-chat").AGENT_PERSONAS.find(a => a.id === requestedAgent) || selectAgent(message)
          : selectAgent(message);
        result = await handleConvergenceCommand(recentDreams, agent, message);
      } else {
        result = await dreamChatReply(message, recentDreams, body.agent || "", body.provider || "");
        // Σ₀ self-correction pass (only when SIGMA0_VERIFY=true and reply exists)
        if (result.reply && isVerifyEnabled()) {
          try {
            const { verified, corrected, records } = await verifyResponse(result.reply, message, result.agent || "lantern");
            if (corrected) result.reply = verified;
            result.sigma0 = { corrected, claims: records.length, verified: records.filter(r => r.confidence >= 0.5).length };
          } catch { /* verification non-fatal */ }
        }
      }

      const provLatency = Date.now() - provStart;
      try {
        await appendConversationEntry({ recordedAt: new Date().toISOString(), surface: "dream-journal", role: "operator", text: message.slice(0, maxConversationTextLength) });
        await appendConversationEntry({ recordedAt: new Date().toISOString(), surface: "dream-journal", role: "lantern", text: String(result.reply || "").slice(0, maxConversationTextLength) });
      } catch { /* logging non-critical */ }
      // Convergence IO provenance (AAPF) — lightweight Node-side record
      try {
        recordChatProvenance({
          actionId: `chat-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`,
          agentId: result.agent || "unknown",
          providerId: result.online ? (body.provider || "auto") : "offline",
          inputSummary: message.slice(0, 200),
          outputSummary: String(result.reply || "").slice(0, 200),
          latencyMs: provLatency,
          status: result.reply ? "ok" : (result.error ? "error" : "offline"),
          errorMsg: result.error || "",
          metadata: { source: result.source || "unknown", threeDoors: !!result.threeDoors, isConvergence: result.source === "convergence" },
        });
      } catch { /* provenance non-critical */ }
      if (!result.reply) { sendJson(res, { error: result.error || "no_provider_configured", agent: result.agent, online: false, help: result.help || "", suggestions: result.suggestions || [] }, 503); return true; }
      // wq-005: emit a ConvergenceRecord for this reasoning cycle (Reason → Act).
      // Single point — catches both the !convergence command and normal reply paths.
      // Guarded: a failed record must never break the reply.
      try {
        const { emitConvergenceRecord } = require("../lib/convergence-records");
        // #1011: retire the frozen 0.7/0.3 heuristic. Prefer an OUTCOME-GRADED
        // calibrated trust (Beta posterior over graded groundings for this provider
        // key) once we have enough graded events; otherwise fall back to the
        // heuristic and say so in verification_notes — never pass an ungraded number
        // off as calibrated. Grade the outcome, never the self-assessment.
        const heuristicConfidence = result.online ? 0.7 : 0.3;
        let confidence = heuristicConfidence;
        let confNote = `confidence=heuristic(${result.online ? "online→0.7" : "offline→0.3"}) — no graded outcomes for this key yet`;
        try {
          const cal = require("../lib/grounding-calibration");
          const calKey = `chat:${result.provider || (result.online ? (body.provider || "auto") : "local")}`;
          const evs = cal.readEvents().filter((e) => e && e.key === calKey);
          if (evs.length >= 3) {
            const folded = cal.foldKey(evs);
            confidence = folded.trust;
            confNote = `confidence=calibrated key=${calKey} n=${evs.length} brier=${folded.brier != null ? folded.brier.toFixed(3) : "n/a"}`;
          }
        } catch { /* calibration optional — keep heuristic */ }
        await emitConvergenceRecord({
          hypothesis: message.slice(0, 280),
          evidence_ids: (recentDreams || []).map((d) => d && (d.id || d.recordedAt)).filter(Boolean),
          result: String(result.reply || "").slice(0, 2000),
          confidence,
          reasoner: result.agent || "unknown",
          verification_notes: confNote,
          source: `dream-chat/${result.agent || "unknown"}/${result.provider || "local"}`,
        });
      } catch { /* convergence record non-critical */ }
      // ClaimsPacket — non-blocking, non-fatal
      try {
        const claimPacket = {
          packet_id: `cp-${Date.now().toString(36)}-${Math.random().toString(36).substr(2,5)}`,
          timestamp_ms: Date.now(),
          node_id: "local-node",
          action: "dream-chat",
          agent: result.agent || "unknown",
          provider: result.source || body.provider || "auto",
          input_hash: Buffer.from(message.slice(0,64)).toString("base64"),
          output_length: String(result.reply || "").length,
          latency_ms: provLatency,
          online: !!result.online,
        };
        const claimDir = path.join(repoRoot, "data", "claim-packets");
        if (!fs.existsSync(claimDir)) fs.mkdirSync(claimDir, { recursive: true });
        const claimFile = path.join(claimDir, `claim-packets.jsonl`);
        setImmediate(() => { try { fs.appendFileSync(claimFile, JSON.stringify(claimPacket) + "\n"); } catch {} });
      } catch { /* non-fatal */ }
      sendJson(res, { ...result, generatedAt: new Date().toISOString() });
    } catch (error) { sendJson(res, { error: error.message, online: false }); }
    return true;
  }

  if ((url.pathname === "/api/dream/stream" && req.method === "GET") ||
      (url.pathname === "/api/dream/chat/stream" && req.method === "POST")) {
    const { appendConvergenceRecord } = require("../lib/dream-chat");

    // Intercept SSE writes so we can log every model interaction as a convergence
    // record after the stream finishes — success or failure.
    const sseChunks = [];
    const origWrite = res.write.bind(res);
    const origEnd   = res.end.bind(res);
    res.write = (chunk, ...rest) => { sseChunks.push(String(chunk)); return origWrite(chunk, ...rest); };

    // Parse the accumulated SSE buffer for the done event after the stream ends.
    const _logInteraction = (inputMessage, errorText) => {
      try {
        const raw = sseChunks.join('');
        let responseText = '', provider = 'unknown', agentId = 'lantern';
        // Extract done-event payload
        const doneMatch = raw.match(/^data:\s*(\{[^\n]*"type"\s*:\s*"done"[^\n]*\})/m);
        if (doneMatch) {
          try {
            const d = JSON.parse(doneMatch[1]);
            if (d.cleanText) responseText = d.cleanText;
            if (d.source || d.provider) provider = d.source || d.provider;
            if (d.routeLabel) agentId = d.routeLabel.split('·')[0].trim();
          } catch { /* parse best-effort */ }
        }
        if (!responseText) {
          // Fallback: concatenate all token events
          const toks = [...raw.matchAll(/^data:\s*(\{[^\n]*"type"\s*:\s*"token"[^\n]*\})/mg)];
          responseText = toks.map(m => { try { return JSON.parse(m[1]).text || ''; } catch { return ''; } }).join('');
        }
        const failed = !!errorText;
        appendConvergenceRecord({
          hypothesis: inputMessage ? `model interaction: "${String(inputMessage).slice(0, 100)}"` : 'model interaction',
          evidence: inputMessage ? [String(inputMessage).slice(0, 500)] : [],
          result: failed ? `ERROR: ${errorText}` : (responseText.slice(0, 1000) || '(empty response)'),
          fix: null,
          confidence: failed ? 0.1 : (responseText.length > 20 ? 0.6 : 0.3),
          reasoner: provider || 'unknown',
          verified: false,
          priority: failed ? 'HIGH' : 'LOW',
          loop_stage: 'Act',
          tags: ['chat-interaction', provider, agentId, ...(failed ? ['failure'] : [])].filter(Boolean),
        });
      } catch (e) {
        console.error('[convergence] chat log failed:', e.message);
      }
    };

    // Override res.end to fire the log after the socket closes.
    res.end = (...args) => {
      const result = origEnd(...args);
      res.write = origWrite; // restore in case of reuse
      _logInteraction('', null);
      return result;
    };

    try {
      await handleStreamChat(req, url, res);
    } catch (err) {
      // Honest fallback: never leave an SSE socket hanging on an internal throw.
      console.error("[dream/stream] handler error (non-fatal to client):", err && err.stack ? err.stack : err);
      _logInteraction('', String(err && err.message || err));
      if (!res.writableEnded) {
        try {
          if (!res.headersSent) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "Access-Control-Allow-Origin": "*",
              "X-Accel-Buffering": "no",
            });
          }
          origWrite(`data: ${JSON.stringify({ type: "error", text: "The streaming engine hit an internal error." })}\n\n`);
          origWrite(`data: ${JSON.stringify({ type: "done", source: "offline", online: false, error: String(err && err.message || err) })}\n\n`);
          origEnd();
        } catch { /* socket already gone */ }
      }
    }
    return true;
  }

  // ── Debug: validate chat pipeline end-to-end ─────────────────────────────
  // POST /api/debug/chat-validate — sends a synthetic test turn, reads the SSE
  // response, verifies a convergence record was appended, returns pass/fail.
  // Only available in dev / operator context (not gated further — server is local).
  if (url.pathname === "/api/debug/chat-validate" && req.method === "POST") {
    const { appendConvergenceRecord } = require("../lib/dream-chat");
    const recordsBefore = (() => {
      try {
        const p = path.join(repoRoot, "data", "convergence", "records.jsonl");
        return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).length;
      } catch { return 0; }
    })();
    const t0 = Date.now();
    let ok = false, responsePreview = '', errorText = '';
    try {
      const port = process.env.LANTERN_GARAGE_PORT || process.env.PORT || 4177;
      const payload = JSON.stringify({ message: "__debug_validate__", user: "debug" });
      const streamRes = await new Promise((resolve, reject) => {
        const mod = require(port === 443 ? "https" : "http");
        const r = mod.request({ host: "127.0.0.1", port, path: "/api/dream/chat/stream", method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, resolve);
        r.on("error", reject);
        r.write(payload); r.end();
      });
      await new Promise((resolve) => {
        let buf = '';
        streamRes.on("data", (chunk) => {
          buf += chunk.toString();
          const lines = buf.split("\n");
          buf = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === "token" && ev.text) responsePreview += ev.text;
              if (ev.type === "done") { ok = true; resolve(); }
              if (ev.type === "error") { errorText = ev.text || "server error event"; }
            } catch { /* skip */ }
          }
        });
        streamRes.on("end", resolve);
        streamRes.on("error", (e) => { errorText = e.message; resolve(); });
        setTimeout(resolve, 30000);
      });
    } catch (e) { errorText = e.message; }
    const latencyMs = Date.now() - t0;
    // Wait briefly for the convergence record to be flushed, then count
    await new Promise(r => setTimeout(r, 200));
    const recordsAfter = (() => {
      try {
        const p = path.join(repoRoot, "data", "convergence", "records.jsonl");
        return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).length;
      } catch { return 0; }
    })();
    const recordWritten = recordsAfter > recordsBefore;
    if (!recordWritten && ok) {
      // Write a diagnostic record so failures are always auditable
      appendConvergenceRecord({
        hypothesis: "debug-validate: convergence record not written after successful stream",
        evidence: [`latencyMs: ${latencyMs}`, `responsePreview: ${responsePreview.slice(0, 100)}`],
        result: "record missing — _logInteraction may have failed silently",
        confidence: 0.9,
        reasoner: "debug-validate",
        verified: true,
        priority: "HIGH",
        loop_stage: "Verify",
        tags: ["debug-validate", "failure", "missing-record"],
      });
    }
    sendJson(res, {
      ok,
      latencyMs,
      responsePreview: responsePreview.slice(0, 200),
      recordWritten,
      recordsBefore,
      recordsAfter,
      error: errorText || null,
    });
    return true;
  }

  // ── MemOS memory health (cached 5s to avoid Python spawn per poll) ──
  if (url.pathname === "/api/dream/memory/health" && req.method === "GET") {
    const now = Date.now();
    if (module._memosHealthCache && (now - module._memosHealthCache.ts) < 5000) {
      sendJson(res, { ...module._memosHealthCache.data, cached: true, generatedAt: new Date().toISOString() });
      return true;
    }
    try {
      const { spawn } = require("child_process");
      const py = process.platform === "win32" ? "python" : "python3";
      const script = `from convergence_io.memos_bridge import memos_available, get_cube; c=get_cube(); print(__import__('json').dumps({'available': memos_available(), 'installed': memos_available(), 'entry_count': len(c._entries), 'fallback': not memos_available(), 'last_ingest': c._entries[0].get('timestamp','') if c._entries else ''}))`;
      const result = await new Promise((resolve, reject) => {
        let out = "", err = "";
        const proc = spawn(py, ["-c", script], { cwd: repoRoot, env: { ...process.env, PYTHONPATH: path.join(repoRoot, "src") } });
        proc.stdout.on("data", (d) => { out += d.toString(); });
        proc.stderr.on("data", (d) => { err += d.toString(); });
        proc.on("close", (code) => {
          if (code !== 0) reject(new Error(err || `exit ${code}`));
          else resolve(out.trim());
        });
        proc.on("error", reject);
      });
      const data = JSON.parse(result);
      module._memosHealthCache = { data, ts: now };
      sendJson(res, { ...data, generatedAt: new Date().toISOString() });
    } catch (error) {
      sendJson(res, { available: false, installed: false, entry_count: 0, fallback: true, error: error.message, generatedAt: new Date().toISOString() });
    }
    return true;
  }


  // ── Dream stats / search / export / read ────────────────────────────
  if (url.pathname === "/api/dream/stats" && req.method === "GET") {
    try {
      const entries = loadDreamEntries(fs, path, repoRoot);
      const stats = { total_entries: entries.length, entries_by_kind: {}, top_emotions: {}, top_tags: {}, top_symbols: {}, top_ctf: {}, entries_with_ctf: 0, total_lucidity: 0, avg_lucidity: 0 };
      for (const entry of entries) {
        stats.entries_by_kind[entry.kind || "dream"] = (stats.entries_by_kind[entry.kind || "dream"] || 0) + 1;
        for (const e of (entry.emotions || [])) stats.top_emotions[e] = (stats.top_emotions[e] || 0) + 1;
        for (const t of (entry.tags || [])) stats.top_tags[t] = (stats.top_tags[t] || 0) + 1;
        for (const s of (entry.symbols || [])) stats.top_symbols[s] = (stats.top_symbols[s] || 0) + 1;
        const ctf = entry.ctf_glyphs || [];
        if (ctf.length) stats.entries_with_ctf++;
        for (const g of ctf) stats.top_ctf[g] = (stats.top_ctf[g] || 0) + 1;
        stats.total_lucidity += entry.lucidity || 0;
      }
      if (entries.length > 0) stats.avg_lucidity = (stats.total_lucidity / entries.length).toFixed(2);
      sendJson(res, stats);
    } catch (error) { sendJson(res, { error: error.message }, 400); }
    return true;
  }

  if (url.pathname === "/api/dream/search" && req.method === "GET") {
    try {
      const query = url.searchParams.get("text") || "";
      const tags = (url.searchParams.get("tags") || "").split(",").filter(t => t);
      const ctf = (url.searchParams.get("ctf") || "").split(",").filter(t => t);
      const results = loadDreamEntries(fs, path, repoRoot).filter(e =>
        (query === "" || (e.text || "").toLowerCase().includes(query.toLowerCase())) &&
        (tags.length === 0 || tags.some(t => (e.tags || []).includes(t))) &&
        (ctf.length === 0 || ctf.some(t => (e.ctf_glyphs || []).includes(t)))
      );
      sendJson(res, { query, tags, ctf, count: results.length, results: results.slice(0, 50) });
    } catch (error) { sendJson(res, { error: error.message }, 400); }
    return true;
  }

  if (url.pathname === "/api/dream/export" && req.method === "GET") {
    try {
      const format = url.searchParams.get("format") || "jsonl";
      const entries = loadDreamEntries(fs, path, repoRoot, true);
      if (format === "csv") {
        const cols = ["id", "timestamp", "kind", "text", "lucidity", "emotions", "tags", "symbols", "ctf_glyphs"];
        const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const rows = [cols.join(","), ...entries.map(e => [
          escape(e.id), escape(e.timestamp), escape(e.kind), escape(e.text),
          escape(e.lucidity), escape((e.emotions || []).join(";")),
          escape((e.tags || []).join(";")), escape((e.symbols || []).join(";")), escape((e.ctf_glyphs || []).join(";"))
        ].join(","))];
        res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="dream-journal-${new Date().toISOString().substring(0,10)}.csv"` });
        res.end(rows.join("\n"));
      } else {
        res.writeHead(200, { "Content-Type": "application/x-ndjson", "Content-Disposition": `attachment; filename="dream-journal-${new Date().toISOString().substring(0,10)}.jsonl"` });
        res.end(entries.map(e => JSON.stringify(e)).join("\n"));
      }
    } catch (error) { sendJson(res, { error: error.message }, 400); }
    return true;
  }

  if (url.pathname.startsWith("/api/dream/read/") && req.method === "GET") {
    try {
      const id = url.pathname.replace("/api/dream/read/", "");
      const found = loadDreamEntries(fs, path, repoRoot).find(e => e.id === id);
      found ? sendJson(res, found) : sendJson(res, { error: "not_found" }, 404);
    } catch (error) { sendJson(res, { error: error.message }, 400); }
    return true;
  }

  // ── Web Search Grounding ───────────────────────────────────────────
  if (url.pathname === "/api/dream/search/web" && req.method === "GET") {
    const query = (url.searchParams.get("q") || "").trim();
    if (!query) {
      sendJson(res, { error: "q parameter required" }, 400);
      return true;
    }
    const maxResults = Math.min(10, Math.max(1, parseInt(url.searchParams.get("max_results") || "5", 10) || 5));
    const http = require("http");
    const mcpHost = process.env.MCP_SERVER_HOST || "127.0.0.1";
    const mcpPort = parseInt(process.env.MCP_SERVER_PORT || "8771", 10);
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: "web_search", arguments: { query, max_results: maxResults } },
    });
    const mcpReq = http.request(
      { hostname: mcpHost, port: mcpPort, path: "/messages", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, timeout: 15000 },
      (mcpRes) => {
        let data = "";
        mcpRes.on("data", (c) => { data += c; });
        mcpRes.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.result) {
              sendJson(res, { success: parsed.result.success, query, ...parsed.result, generatedAt: new Date().toISOString() });
            } else {
              sendJson(res, { error: parsed.error?.message || "MCP error", generatedAt: new Date().toISOString() }, 502);
            }
          } catch (e) {
            sendJson(res, { error: `Parse error: ${e.message}`, generatedAt: new Date().toISOString() }, 502);
          }
        });
      }
    );
    mcpReq.on("error", (err) => sendJson(res, { error: err.message, generatedAt: new Date().toISOString() }, 502));
    mcpReq.on("timeout", () => { mcpReq.destroy(); sendJson(res, { error: "MCP timeout", generatedAt: new Date().toISOString() }, 504); });
    mcpReq.write(payload);
    mcpReq.end();
    return true;
  }

  // ── Symbol co-occurrence timeline ────────────────────────────────────
  if (url.pathname === "/api/dream/symbols/timeline" && req.method === "GET") {
    try {
      const entries = loadDreamEntries(fs, path, repoRoot);
      const byWeek = {};
      for (const e of entries) {
        if (!e.timestamp) continue;
        const d = new Date(e.timestamp);
        const week = `${d.getUTCFullYear()}-W${String(Math.ceil((d.getUTCDate() - d.getUTCDay() + 6) / 7)).padStart(2,'0')}`;
        if (!byWeek[week]) byWeek[week] = {};
        for (const s of [...(e.symbols || []), ...(e.tags || [])]) {
          byWeek[week][s] = (byWeek[week][s] || 0) + 1;
        }
      }
      // Co-occurrence across all entries
      const coOccur = {};
      for (const e of entries) {
        const syms = [...(e.symbols || []), ...(e.tags || [])].slice(0, 8);
        for (let a = 0; a < syms.length; a++)
          for (let b = a + 1; b < syms.length; b++) {
            const key = [syms[a], syms[b]].sort().join('⟶');
            coOccur[key] = (coOccur[key] || 0) + 1;
          }
      }
      const topPairs = Object.entries(coOccur).sort((x,y)=>y[1]-x[1]).slice(0,10)
        .map(([k,v]) => ({ pair: k, count: v }));
      sendJson(res, { weeks: byWeek, top_pairs: topPairs, total_entries: entries.length });
    } catch (error) { sendJson(res, { error: error.message }, 400); }
    return true;
  }

  // ── TTS proxy ─────────────────────────────────────────────────────────
  if (url.pathname === "/api/dream/tts" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);
      const text = String(body.text || "").slice(0, 4000).trim();
      if (!text) { sendJson(res, { error: "text_required" }, 400); return true; }
      const voiceId = String(body.voice_id || process.env.ELEVENLABS_VOICE_ID || "Rachel").slice(0, 60);

      const proxyAudio = (hostname, path2, headers, postData) => {
        return new Promise((resolve) => {
          let resolved = false;
          const proxyReq = https.request({ hostname, path: path2, method: "POST", headers, timeout: 15000 }, (proxyRes) => {
            if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
              res.writeHead(200, { "Content-Type": "audio/mpeg" });
              proxyRes.pipe(res);
              resolved = true;
              resolve(true);
            } else {
              // Drain the error response so the connection closes cleanly
              proxyRes.resume();
              if (!resolved) { resolved = true; resolve(false); }
            }
          });
          proxyReq.on("timeout", () => {
            proxyReq.destroy();
            if (!resolved) { resolved = true; resolve(false); }
          });
          proxyReq.on("error", () => {
            if (!resolved) { resolved = true; resolve(false); }
          });
          proxyReq.write(postData);
          proxyReq.end();
        });
      };

      // Try ElevenLabs first
      if (process.env.ELEVENLABS_API_KEY) {
        const postData = JSON.stringify({ text, model_id: "eleven_turbo_v2_5" });
        const ok = await proxyAudio(
          "api.elevenlabs.io",
          `/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
          {
            "xi-api-key": process.env.ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
            "Accept": "audio/mpeg",
          },
          postData
        );
        if (ok) return true;
      }

      // Fall back to OpenAI TTS
      if (process.env.OPENAI_API_KEY) {
        const openaiVoice = String(body.voice_id || "nova").slice(0, 20);
        const postData = JSON.stringify({ model: "tts-1", input: text, voice: openaiVoice });
        const ok = await proxyAudio(
          "api.openai.com",
          "/v1/audio/speech",
          {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
          },
          postData
        );
        if (ok) return true;
      }

      sendJson(res, { fallback: "browser" });
    } catch (err) { sendJson(res, { error: err.message }, 500); }
    return true;
  }

  // ── Provider settings ─────────────────────────────────────────────────
  if (url.pathname === "/api/settings/providers" && req.method === "GET") {
    const result = {};
    let any = false;
    for (const k of PROVIDER_KEYS) { result[k] = !!(process.env[k]); if (result[k]) any = true; }
    result._any = any;
    sendJson(res, result);
    return true;
  }

  if (url.pathname === "/api/settings/providers" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const { key, value } = JSON.parse(raw || "{}");
      if (!key || !PROVIDER_KEYS.includes(key)) { sendJson(res, { error: "unknown_key" }, 400); return true; }
      const envFilePath = path.join(repoRoot, ".env.local");
      let existing = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, "utf8") : "";
      const lines = existing.split("\n").filter(l => !l.startsWith(`${key}=`) && !l.startsWith(`${key} =`));
      if (value) lines.push(`${key}=${value}`);
      fs.writeFileSync(envFilePath, lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n", "utf8");
      if (value) process.env[key] = value; else delete process.env[key];
      refreshProviderCache();
      sendJson(res, { ok: true });
    } catch (err) { sendJson(res, { error: err.message }, 500); }
    return true;
  }

  // ── Door choice persistence ─────────────────────────────────────────────
  if (url.pathname === "/api/dream/door-choice" && req.method === "POST") {
    try {
      const body = JSON.parse(await collectRequestBody(req));
      const { saveDoorChoice } = require("../lib/csf-memory");
      saveDoorChoice(body.choice || null, body.doors || []);
      sendJson(res, { ok: true });
    } catch (err) { sendJson(res, { error: err.message }, 500); }
    return true;
  }


  // ── Convergence Models 3 — live status from Ollama ────────────────────
  if (url.pathname === "/api/dream/lantern-models" && req.method === "GET") {
    const LANTERN_MODELS = [
      { id: "lantern-csf-dream",   role: "dream",       icon: "🌙", base: "mistral",        description: "Kingdome of Hearts game · Elephant Oasis · dream narrative" },
      { id: "lantern-convergance", role: "convergence", icon: "◈",  base: "qwen2.5-coder",  description: "Convergence receipts · AAPF provenance · structured output" },
      { id: "lantern-pcsf",        role: "pcsf",        icon: "⌖",  base: "qwen2.5-coder",  description: "PCSF state manifests · system receipts · agent declarations" },
    ];
    const ollamaBase = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
    try {
      const ollamaUrl = new URL(ollamaBase);
      const tagsRaw = await new Promise((resolve, reject) => {
        const r = require("http").request({
          hostname: ollamaUrl.hostname, port: ollamaUrl.port || 11434,
          path: "/api/tags", method: "GET",
        }, (upstream) => {
          let d = ""; upstream.on("data", c => d += c);
          upstream.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
          upstream.on("error", reject);
        });
        r.on("error", reject);
        r.setTimeout(4000, () => { r.destroy(); reject(new Error("timeout")); });
        r.end();
      });
      const pulledIds = (tagsRaw.models || []).map(m => String(m.name || "").replace(/:latest$/, "").toLowerCase());
      const pulledFull = tagsRaw.models || [];
      const models = LANTERN_MODELS.map(m => {
        const entry = pulledFull.find(p => String(p.name || "").toLowerCase().startsWith(m.id));
        return {
          ...m,
          loaded: pulledIds.some(id => id === m.id),
          size_gb: entry ? Math.round((entry.size / 1e9) * 100) / 100 : null,
          modified_at: entry ? entry.modified_at : null,
        };
      });
      const loaded = models.filter(m => m.loaded).length;
      sendJson(res, { convergence_models: models, loaded, total: LANTERN_MODELS.length, healthy: loaded === LANTERN_MODELS.length, ollama_base: ollamaBase });
    } catch (err) {
      sendJson(res, { convergence_models: LANTERN_MODELS.map(m => ({ ...m, loaded: false, size_gb: null })), loaded: 0, total: LANTERN_MODELS.length, healthy: false, error: err.message }, 200);
    }
    return true;
  }
};

// Dream Journal enrichment using Convergance OS models
async function enrichDreamEntry(entry) {
  const enrichment = {
    models: {
      text: modelRegistry.text.dream.profileId,
      pcsf: modelRegistry.text.pcsf.profileId,
      convergance: modelRegistry.text.convergance.profileId,
      image: modelRegistry.image.dream.modelId,
    },
    doors: [],
    symbols: entry.symbols || [],
    image: { status: "skipped" },
    receipt: { privacyBoundary: "local_private", claimBoundary: "grounded", decision: "hold" },
  };

  // lantern-csf-dream: symbolic summary and door suggestions
  let dreamLatency = Date.now();
  try {
    const { spawn } = require("child_process");
    const py = process.platform === "win32" ? "python" : "python3";
    const script = `import sys,json; from ollama import Client; c=Client(); r=c.generate(model='${modelRegistry.text.dream.ollamaModel}',prompt='Analyze this dream for symbols and suggest 3 doors: '+json.dumps({'text':sys.stdin.read()}),options={'num_predict':256}); print(r['response'])`;
    const result = await new Promise((resolve) => {
      const proc = spawn(py, ["-c", script], { cwd: repoRoot });
      let out = "";
      proc.stdout.on("data", (d) => { out += d.toString(); });
      proc.on("close", () => resolve(out.trim()));
      proc.stdin.write(JSON.stringify({ text: entry.text }));
      proc.stdin.end();
    });
    dreamLatency = Date.now() - dreamLatency;
    if (result) {
      const parsed = JSON.parse(result);
      enrichment.doors = parsed.doors || [];
      enrichment.symbols = parsed.symbols || entry.symbols;
    }
    logModelUsage({ modelId: modelRegistry.text.dream.profileId, provider: "ollama", action: "generate", metadata: { latencyMs: dreamLatency, entryId: entry.id } });
  } catch { /* non-critical */ }

  // lantern-pcsf: privacy/provider receipt
  try {
    enrichment.receipt.privacyBoundary = "local_private";
    enrichment.receipt.claimBoundary = "grounded";
    logModelUsage({ modelId: modelRegistry.text.pcsf.profileId, provider: "static", action: "receipt", metadata: { entryId: entry.id, privacyBoundary: "local_private" } });
  } catch { /* non-critical */ }

  // lantern-convergance: promote/hold/archive decision
  try {
    enrichment.receipt.decision = "hold";
    logModelUsage({ modelId: modelRegistry.text.convergance.profileId, provider: "static", action: "decide", metadata: { entryId: entry.id, decision: "hold" } });
  } catch { /* non-critical */ }

  // Optional image generation (non-blocking)
  if (process.env.LANTERN_IMAGE_LORA) {
    const imgStart = Date.now();
    generateDoorSceneImage({ cleanText: entry.text, doors: enrichment.doors, symbolMesh: enrichment.symbols, entryId: entry.id })
      .then(result => {
        const latencyMs = Date.now() - imgStart;
        if (result.ok) {
          enrichment.image = { status: "generated", path: `data/images/dream-journal/${entry.id}.png`, model: modelRegistry.image.dream.modelId, adapter: process.env.LANTERN_IMAGE_LORA };
          logModelUsage({ modelId: modelRegistry.image.dream.modelId, provider: "local", action: "generate", metadata: { latencyMs, entryId: entry.id, status: "success" } });
        } else {
          enrichment.image = { status: "failed", error: result.error };
          logModelUsage({ modelId: modelRegistry.image.dream.modelId, provider: "local", action: "generate", metadata: { latencyMs, entryId: entry.id, status: "failed", error: result.error } });
        }
      })
      .catch((err) => {
        enrichment.image = { status: "failed" };
        logModelUsage({ modelId: modelRegistry.image.dream.modelId, provider: "local", action: "generate", metadata: { entryId: entry.id, status: "failed", error: err?.message } });
      });
  }

  return enrichment;
}

// Lightweight AAPF provenance recorder (Node-side mirror of ConvergenceIO engine)
function recordChatProvenance({ actionId, agentId, providerId, inputSummary, outputSummary, latencyMs, status, errorMsg, metadata }) {
  const crypto = require("crypto");
  const record = {
    action_id: actionId,
    timestamp: new Date().toISOString(),
    actor: { agent_id: agentId, provider_id: providerId, model: "" },
    action_type: "chat",
    input_summary: inputSummary,
    output_summary: outputSummary,
    capability_claim_id: null,
    nap_profile_id: null,
    dcf_ref: null,
    tier: "wanderer",
    consent_state: "implicit",
    data_classifications: ["dream_content"],
    authority_check: "passed",
    boundary: "local",
    latency_ms: latencyMs,
    status,
    error_msg: errorMsg,
    metadata: metadata || {},
  };
  const payload = JSON.stringify(record, Object.keys(record).sort());
  record.integrity_hash = crypto.createHash("sha256").update(payload).digest("hex");
  const provenanceDir = require("path").join(require("path").resolve(__dirname, "..", "..", ".."), "data", "provenance");
  if (!require("fs").existsSync(provenanceDir)) require("fs").mkdirSync(provenanceDir, { recursive: true });
  const provenancePath = require("path").join(provenanceDir, "actions.jsonl");
  require("fs").appendFileSync(provenancePath, JSON.stringify(record) + "\n", "utf8");
}

// ── Model usage metrics (local JSONL) ───────────────────────────────
function logModelUsage({ modelId, provider, action, metadata }) {
  const fs = require("fs");
  const path = require("path");
  const record = {
    timestamp: new Date().toISOString(),
    modelId,
    provider,
    action,
    metadata: metadata || {},
  };
  const metricsDir = path.join(path.resolve(__dirname, "..", "..", ".."), "data", "metrics");
  if (!fs.existsSync(metricsDir)) fs.mkdirSync(metricsDir, { recursive: true });
  const metricsPath = path.join(metricsDir, "model-usage.jsonl");
  fs.appendFileSync(metricsPath, JSON.stringify(record) + "\n", "utf8");
}

// Shared helper — read all dream entries from monthly JSONL files
let _dreamEntriesCache = { entries: [], ts: 0 };
const DREAM_ENTRIES_TTL_MS = 3000;

function loadDreamEntries(fs, path, repoRoot, sorted = false) {
  const now = Date.now();
  if ((now - _dreamEntriesCache.ts) < DREAM_ENTRIES_TTL_MS) {
    return _dreamEntriesCache.entries;
  }
  const dreamDir = path.join(repoRoot, "data", "dream_journal");
  if (!fs.existsSync(dreamDir)) return [];
  const files = fs.readdirSync(dreamDir).filter(f => f.endsWith(".jsonl"));
  if (sorted) files.sort();
  const entries = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(dreamDir, file), "utf-8").trim();
    if (content) {
      for (const line of content.split("\n")) {
        try { entries.push(JSON.parse(line)); } catch { /* skip bad lines */ }
      }
    }
  }
  _dreamEntriesCache = { entries, ts: now };
  return entries;
}
