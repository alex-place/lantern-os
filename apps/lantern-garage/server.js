const http = require("http");
const fs = require("fs");
const path = require("path");

const {
  sendJson, sendFile, sendHtml, collectRequestBody,
} = require("./lib/http-utils");
const {
  readJson, readJsonl, appendJsonlQueued,
} = require("./lib/file-queue");
const {
  getStatus, getReadiness, getMiningLabStatus, getActionCapabilities,
  getOperatorFeedbackMemory, getAccessModel, getCloudMirrorStatus,
} = require("./lib/status");
const {
  readConversationLog, normalizeConversationEntry, appendConversationEntry,
  appendExternalRagItem, readOperatorQueue,
} = require("./lib/conversation-store");
const {
  buildFlatRagHouse, writeFlatRagHouse,
} = require("./lib/rag-house");
const { runPowerShell } = require("./lib/powershell");
const { renderMarkdownDocument } = require("./lib/markdown-render");
const {
  normalizeDreamerUser, dreamerNotebookPath, appendDreamerEntry,
  readDreamerNotebook, readRecentDreams,
} = require("./lib/dreamer-store");
const {
  dreamChatReply, AGENT_PERSONAS, DREAM_DOORS, selectAgent,
} = require("./lib/dream-chat");
const {
  unifiedAgentGreet, unifiedAgentHealth, unifiedAgentInspect,
} = require("./lib/unified-agent");
const { handleStreamChat } = require("./lib/stream-chat");

const repoRoot = path.resolve(__dirname, "..", "..");
const publicRoot = path.join(__dirname, "public");
const port = Number(process.env.LANTERN_GARAGE_PORT || process.env.PORT || 4177);
const host = process.env.LANTERN_GARAGE_HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const conversationLogPath = path.join(repoRoot, "data", "conversations", "garage-conversations.jsonl");
const flatRagHousePath = path.join(repoRoot, "data", "rag-house", "flat-rag-house-latest.json");
const flatRagHouseManifestPath = path.join(repoRoot, "manifests", "FLAT-RAG-HOUSE-LATEST.md");
const operatorNotesPath = path.join(repoRoot, "data", "operator-notes", "notes.jsonl");
const cloudMirrorsPath = path.join(repoRoot, "manifests", "cloud-mirrors.json");
const maxConversationTextLength = 4000;
const maxDreamerTextLength = 2000;

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, { ok: true, service: "lantern-garage", generatedAt: new Date().toISOString() });
    return;
  }

  if (url.pathname === "/api/status") {
    sendJson(res, getStatus());
    return;
  }

  if (url.pathname === "/api/arc-reactor") {
    sendJson(res, readJson("data/arc-reactor/status.json", {}));
    return;
  }

  if (url.pathname === "/api/wallet") {
    sendJson(res, {
      wallet: readJson("data/wallet/local-cash-wallet.json", {}),
      ledger: readJsonl("data/wallet/ledger.jsonl", 30),
    });
    return;
  }

  if (url.pathname === "/api/readiness") {
    sendJson(res, getReadiness());
    return;
  }

  if (url.pathname === "/api/mining-lab") {
    sendJson(res, getMiningLabStatus());
    return;
  }

  if (url.pathname === "/api/action-capabilities") {
    sendJson(res, getActionCapabilities());
    return;
  }

  if (url.pathname === "/api/operator-feedback") {
    sendJson(res, getOperatorFeedbackMemory());
    return;
  }

  if (url.pathname === "/api/access-model") {
    sendJson(res, getAccessModel());
    return;
  }

  if (url.pathname === "/api/cloud-mirrors") {
    sendJson(res, getCloudMirrorStatus());
    return;
  }

  if (url.pathname === "/api/rag-cache" && req.method === "GET") {
    sendJson(res, readJsonl("data/rag-intake/external-llm-web-cache/cache.jsonl", 50));
    return;
  }

  if (url.pathname === "/api/rag-cache" && req.method === "POST") {
    try {
      const body = await collectRequestBody(req);
      const record = await appendExternalRagItem(JSON.parse(body || "{}"));
      sendJson(res, { ok: true, record }, 201);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return;
  }

  if (url.pathname === "/api/flat-rag-house") {
    sendJson(res, fs.existsSync(flatRagHousePath)
      ? readJson(path.relative(repoRoot, flatRagHousePath), buildFlatRagHouse())
      : buildFlatRagHouse());
    return;
  }

  if (url.pathname === "/api/operator-queue") {
    sendJson(res, { items: readOperatorQueue(), generatedAt: new Date().toISOString() });
    return;
  }

  if (url.pathname === "/api/operator-notes" && req.method === "POST") {
    try {
      const body = await collectRequestBody(req);
      const input = JSON.parse(body || "{}");
      const text = String(input.text || "").trim().slice(0, 500);
      const priority = ["P0", "P1", "P2"].includes(input.priority) ? input.priority : "P1";
      if (!text) throw new Error("note_text_required");
      const record = { createdAt: new Date().toISOString(), text, priority, done: false };
      await appendJsonlQueued(operatorNotesPath, record);
      sendJson(res, { ok: true, record }, 201);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return;
  }

  if (url.pathname === "/api/conversations" && req.method === "GET") {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 50)));
    sendJson(res, {
      path: path.relative(repoRoot, conversationLogPath),
      conversations: readConversationLog(limit),
    });
    return;
  }

  if (url.pathname === "/api/conversations" && req.method === "POST") {
    try {
      const body = await collectRequestBody(req);
      const entry = normalizeConversationEntry(JSON.parse(body || "{}"));
      await appendConversationEntry(entry);
      sendJson(res, { ok: true, entry }, 201);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return;
  }

  if (url.pathname === "/api/actions/run-loop" && req.method === "POST") {
    const result = await runPowerShell("scripts/Invoke-LanternConvergenceLoop.ps1");
    sendJson(res, result, result.code === 0 ? 200 : 500);
    return;
  }

  if (url.pathname === "/api/actions/local-controls" && req.method === "POST") {
    const result = await runPowerShell("scripts/Start-LanternLocalControls.ps1");
    sendJson(res, result, result.code === 0 ? 200 : 500);
    return;
  }

  if (url.pathname === "/api/actions/flat-rag-ingest" && req.method === "POST") {
    const house = await writeFlatRagHouse();
    sendJson(res, {
      code: 0,
      stdout: `Flat RAG house updated: ${path.relative(repoRoot, flatRagHousePath)}`,
      stderr: "",
      house,
    });
    return;
  }

  if (url.pathname.startsWith("/repo/")) {
    const relative = decodeURIComponent(url.pathname.replace(/^\/repo\//, ""));
    const target = path.resolve(repoRoot, relative);
    if (!target.startsWith(repoRoot)) {
      sendJson(res, { error: "forbidden" }, 403);
      return;
    }
    sendFile(res, target);
    return;
  }

  if (url.pathname === "/view") {
    const relative = decodeURIComponent(url.searchParams.get("path") || "");
    const target = path.resolve(repoRoot, relative);
    if (!relative || !target.startsWith(repoRoot)) {
      sendJson(res, { error: "forbidden" }, 403);
      return;
    }
    if (!fs.existsSync(target)) {
      sendJson(res, { error: "not_found" }, 404);
      return;
    }
    if (path.extname(target).toLowerCase() === ".md") {
      sendHtml(res, renderMarkdownDocument(fs.readFileSync(target, "utf8"), relative));
      return;
    }
    sendFile(res, target);
    return;
  }


  if (url.pathname === "/api/dreamer" && req.method === "GET") {
    const user = normalizeDreamerUser(url.searchParams.get("user") || "courtney");
    const entries = readDreamerNotebook(user);
    sendJson(res, { user, entries, path: path.relative(repoRoot, dreamerNotebookPath(user)) });
    return;
  }

  if (url.pathname === "/api/dreamer" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);
      const user = normalizeDreamerUser(body.user || "courtney");
      const record = await appendDreamerEntry(user, body);
      sendJson(res, { saved: true, record });
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return;
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
      sendJson(res, {
        saved: true,
        record,
        reply: chatResult.reply,
        agent: chatResult.agent,
        source: chatResult.online ? "llm" : "offline",
        suggestions: chatResult.suggestions,
      });
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return;
  }

  // ── Agents list ─────────────────────────────────────────────────────
  if (url.pathname === "/api/agents" && req.method === "GET") {
    sendJson(res, {
      agents: AGENT_PERSONAS.map((a) => ({
        id: a.id,
        name: a.name,
        symbol: a.symbol,
      })),
      default: AGENT_PERSONAS[0].id,
    });
    return;
  }

  // ── Agentic Workspace — Unified Connector Endpoints ──────────────────
  if (url.pathname === "/api/dream/greet" && req.method === "GET") {
    try {
      const recentDreams = readRecentDreams(5);
      const greet = await unifiedAgentGreet(recentDreams);
      sendJson(res, { ...greet, generatedAt: new Date().toISOString() });
    } catch (error) {
      sendJson(res, {
        greeting: "The dream door is open. Tell me what you brought back from sleep.",
        persona: "Blinkbug",
        source: "offline_fallback",
        error: error.message,
      });
    }
    return;
  }

  if (url.pathname === "/api/agent/health" && req.method === "GET") {
    try {
      const health = await unifiedAgentHealth();
      sendJson(res, { health, generatedAt: new Date().toISOString() });
    } catch (error) {
      sendJson(res, { error: error.message }, 500);
    }
    return;
  }

  if (url.pathname === "/api/agent/inspect" && req.method === "GET") {
    try {
      const inspect = await unifiedAgentInspect();
      sendJson(res, { inspect, generatedAt: new Date().toISOString() });
    } catch (error) {
      sendJson(res, { error: error.message }, 500);
    }
    return;
  }

  // Dream Journal API Routes
  if (url.pathname === "/api/dream/create" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);
      const dreamId = `dream_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      const normalizeList = (value, limit = 12) => {
        if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean).slice(0, limit);
        return String(value || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, limit);
      };
      const entry = {
        id: dreamId,
        timestamp: new Date().toISOString(),
        kind: String(body.kind || "dream").slice(0, 40),
        name: String(body.name || body.title || "").slice(0, 140),
        text: String(body.text || body.content || "").slice(0, maxDreamerTextLength),
        lucidity: Math.max(0, Math.min(1, Number(body.lucidity || 0))),
        clarity: Math.max(0, Math.min(1, Number(body.clarity || 0))),
        mood: String(body.mood || "").slice(0, 80),
        technique: String(body.technique || "").slice(0, 80),
        sleep_window: String(body.sleep_window || "").slice(0, 80),
        recurring: Boolean(body.recurring),
        dreamsign: Boolean(body.dreamsign),
        emotions: normalizeList(body.emotions, 12),
        tags: normalizeList(body.tags, 10),
        symbols: normalizeList(body.symbols, 12),
        linked_goals: body.linked_goals || [],
        priority: body.priority || "normal",
        reflection_on: body.reflection_on || [],
        source: "api"
      };
      const dreamDir = path.join(repoRoot, "data", "dream_journal");
      if (!fs.existsSync(dreamDir)) fs.mkdirSync(dreamDir, { recursive: true });
      const monthFile = path.join(dreamDir, `dreams_${new Date().toISOString().substring(0, 7)}.jsonl`);
      await appendJsonlQueued(monthFile, entry);

      sendJson(res, {
        id: dreamId,
        saved: true,
        entry,
        csf: { compressed: false },
      });
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return;
  }

  if (url.pathname === "/api/dream/chat" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw || "{}");
      const message = String(body.message || "").slice(0, maxDreamerTextLength);
      const recentDreams = readRecentDreams(5);
      const result = await dreamChatReply(message, recentDreams, body.agent || "", body.provider || "");
      // Best-effort conversation logging; never blocks the reply.
      try {
        await appendConversationEntry({
          recordedAt: new Date().toISOString(),
          surface: "dream-journal",
          role: "operator",
          text: message.slice(0, maxConversationTextLength),
        });
        await appendConversationEntry({
          recordedAt: new Date().toISOString(),
          surface: "dream-journal",
          role: "lantern",
          text: String(result.reply || "").slice(0, maxConversationTextLength),
        });
      } catch { /* logging is non-critical */ }
      sendJson(res, { ...result, generatedAt: new Date().toISOString() });
    } catch (error) {
      // Even on parse error, stay in character and online.
      sendJson(res, {
        reply: `${DREAM_DOORS.founder.phrase} Something tangled, but the dream door stays open.`,
        suggestions: Object.values(DREAM_DOORS).slice(0, 3).map((d) => d.name),
        online: false,
        error: error.message,
      });
    }
    return;
  }

  if ((url.pathname === "/api/dream/stream" && req.method === "GET") ||
      (url.pathname === "/api/dream/chat/stream" && req.method === "POST")) {
    await handleStreamChat(req, url, res);
    return;
  }

  if (url.pathname === "/api/dream/stats" && req.method === "GET") {
    try {
      const dreamDir = path.join(repoRoot, "data", "dream_journal");
      let entries = [];
      if (fs.existsSync(dreamDir)) {
        const files = fs.readdirSync(dreamDir).filter(f => f.endsWith(".jsonl"));
        for (const file of files) {
          const content = fs.readFileSync(path.join(dreamDir, file), "utf-8").trim();
          if (content) {
            entries.push(...content.split("\n").map(line => {
              try { return JSON.parse(line); } catch { return null; }
            }).filter(e => e));
          }
        }
      }
      const stats = {
        total_entries: entries.length,
        entries_by_kind: {},
        top_emotions: {},
        top_tags: {},
        top_symbols: {},
        total_lucidity: 0,
        avg_lucidity: 0
      };
      for (const entry of entries) {
        stats.entries_by_kind[entry.kind || "dream"] = (stats.entries_by_kind[entry.kind || "dream"] || 0) + 1;
        for (const emotion of (entry.emotions || [])) {
          stats.top_emotions[emotion] = (stats.top_emotions[emotion] || 0) + 1;
        }
        for (const tag of (entry.tags || [])) {
          stats.top_tags[tag] = (stats.top_tags[tag] || 0) + 1;
        }
        for (const symbol of (entry.symbols || [])) {
          stats.top_symbols[symbol] = (stats.top_symbols[symbol] || 0) + 1;
        }
        stats.total_lucidity += entry.lucidity || 0;
      }
      if (entries.length > 0) stats.avg_lucidity = (stats.total_lucidity / entries.length).toFixed(2);
      sendJson(res, stats);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return;
  }

  if (url.pathname === "/api/dream/search" && req.method === "GET") {
    try {
      const query = url.searchParams.get("text") || "";
      const tags = (url.searchParams.get("tags") || "").split(",").filter(t => t);
      const dreamDir = path.join(repoRoot, "data", "dream_journal");
      let results = [];
      if (fs.existsSync(dreamDir)) {
        const files = fs.readdirSync(dreamDir).filter(f => f.endsWith(".jsonl"));
        for (const file of files) {
          const content = fs.readFileSync(path.join(dreamDir, file), "utf-8").trim();
          if (content) {
            results.push(...content.split("\n").map(line => {
              try { return JSON.parse(line); } catch { return null; }
            }).filter(e => e && (
              (query === "" || (e.text || "").toLowerCase().includes(query.toLowerCase())) &&
              (tags.length === 0 || tags.some(t => (e.tags || []).includes(t)))
            )));
          }
        }
      }
      sendJson(res, { query, tags, count: results.length, results: results.slice(0, 50) });
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return;
  }

  if (url.pathname.startsWith("/api/dream/read/") && req.method === "GET") {
    try {
      const id = url.pathname.replace("/api/dream/read/", "");
      const dreamDir = path.join(repoRoot, "data", "dream_journal");
      let found = null;
      if (fs.existsSync(dreamDir)) {
        const files = fs.readdirSync(dreamDir).filter(f => f.endsWith(".jsonl"));
        for (const file of files) {
          const content = fs.readFileSync(path.join(dreamDir, file), "utf-8").trim();
          if (content) {
            for (const line of content.split("\n")) {
              try {
                const entry = JSON.parse(line);
                if (entry.id === id) { found = entry; break; }
              } catch { }
            }
          }
          if (found) break;
        }
      }
      if (found) {
        sendJson(res, found);
      } else {
        sendJson(res, { error: "not_found" }, 404);
      }
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return;
  }

  if (url.pathname === "/hub") {
    const hubPath = path.resolve(repoRoot, "central-hub.html");
    sendFile(res, hubPath);
    return;
  }

  // Serve surfaces directory
  if (url.pathname.startsWith("/surfaces/")) {
    const surfacesRoot = path.resolve(__dirname, "../../surfaces");
    const surfacePath = url.pathname.slice("/surfaces/".length) || "index.html";
    const surfaceTarget = path.resolve(surfacesRoot, surfacePath);
    if (surfaceTarget.startsWith(surfacesRoot)) {
      sendFile(res, surfaceTarget);
      return;
    }
  }

  const staticPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const target = path.resolve(publicRoot, staticPath);
  if (!target.startsWith(publicRoot)) {
    sendJson(res, { error: "forbidden" }, 403);
    return;
  }
  sendFile(res, target);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => sendJson(res, { error: error.message }, 500));
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Lantern Garage port ${port} is already in use. Open http://127.0.0.1:${port} or choose another port.`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

server.listen(port, host, () => {
  console.log(`Lantern Garage app listening on ${host}:${port}`);
});
