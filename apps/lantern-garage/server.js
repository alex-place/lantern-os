const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// Load .env.local then .env from repo root (two levels up from apps/lantern-garage/)
const candidateEnvFiles = [
  path.resolve(__dirname, "..", "..", ".env.local"),
  path.resolve(__dirname, "..", "..", ".env"),
];
for (const envPath of candidateEnvFiles) {
  if (!fs.existsSync(envPath)) continue;
  fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const m = line.replace(/\r$/, "").match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]/g, "").replace(/['"]$/g, "");
  });
}

const { sendJson, sendFile, sendHtml, collectRequestBody } = require("./lib/http-utils");
const { readJson, readJsonl, appendJsonlQueued } = require("./lib/file-queue");
const { getStatus, getReadiness, getMiningLabStatus, getActionCapabilities, getOperatorFeedbackMemory, getAccessModel, getCloudMirrorStatus } = require("./lib/status");
const { readConversationLog, normalizeConversationEntry, appendConversationEntry, appendExternalRagItem, readOperatorQueue } = require("./lib/conversation-store");
const { buildFlatRagHouse, writeFlatRagHouse } = require("./lib/rag-house");
const { runPowerShell } = require("./lib/powershell");
const { renderMarkdownDocument } = require("./lib/markdown-render");
const { normalizeDreamerUser, dreamerNotebookPath, appendDreamerEntry, readDreamerNotebook, readRecentDreams } = require("./lib/dreamer-store");
const { dreamChatReply, AGENT_PERSONAS, DREAM_DOORS, selectAgent, tokenAudit } = require("./lib/dream-chat");
const { unifiedAgentGreet, unifiedAgentHealth, unifiedAgentInspect } = require("./lib/unified-agent");
const { handleStreamChat } = require("./lib/stream-chat");
const { refreshAllPcsf } = require("./lib/pcsf-refresh");
const { getRoutingSnapshot, refreshProviderCache } = require("./lib/provider-cache");
const { JobQueue } = require("./lib/job-queue");
const { JobWorker } = require("./lib/job-worker");
const { PrWatcher } = require("./lib/pr-watcher");

const repoRoot = path.resolve(__dirname, "..", "..");
const publicRoot = path.join(__dirname, "public");
const port = Number(process.env.LANTERN_GARAGE_PORT || process.env.PORT || 4177);
const host = process.env.LANTERN_GARAGE_HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const conversationLogPath = path.join(repoRoot, "data", "conversations", "garage-conversations.jsonl");
const flatRagHousePath = path.join(repoRoot, "data", "rag-house", "flat-rag-house-latest.json");
const flatRagHouseManifestPath = path.join(repoRoot, "manifests", "FLAT-RAG-HOUSE-LATEST.md");
const operatorNotesPath = path.join(repoRoot, "data", "operator-notes", "notes.jsonl");
const cloudMirrorsPath = path.join(repoRoot, "manifests", "cloud-mirrors.json");
const cloudMirrorUrls = process.env.LANTERN_CLOUD_MIRROR_URLS || "";
const openaiApiKey = process.env.OPENAI_API_KEY || "";
const maxConversationTextLength = 4000;
const maxDreamerTextLength = 2000;

// Initialize Creator Suite job queue and worker
const jobQueue = new JobQueue(repoRoot);
const jobWorker = new JobWorker(jobQueue, repoRoot);
jobWorker.start(2000); // Poll every 2 seconds for new jobs

// PR Watcher — auto-reviews PRs idle for 3min via Keystone fleet
const prWatcher = new PrWatcher({ repoRoot, port, idleMs: Number(process.env.PR_WATCHER_IDLE_MS || 3 * 60_000) });

// Shared dependency bundle passed to every route module
const deps = {
  fs, path,
  sendJson, sendFile, sendHtml, collectRequestBody,
  readJson, readJsonl, appendJsonlQueued,
  getStatus, getReadiness, getMiningLabStatus, getActionCapabilities,
  getOperatorFeedbackMemory, getAccessModel, getCloudMirrorStatus,
  readConversationLog, normalizeConversationEntry, appendConversationEntry,
  appendExternalRagItem, readOperatorQueue,
  buildFlatRagHouse, writeFlatRagHouse,
  runPowerShell, renderMarkdownDocument,
  normalizeDreamerUser, dreamerNotebookPath, appendDreamerEntry,
  readDreamerNotebook, readRecentDreams,
  dreamChatReply, AGENT_PERSONAS, DREAM_DOORS, selectAgent, tokenAudit,
  unifiedAgentGreet, unifiedAgentHealth, unifiedAgentInspect,
  handleStreamChat,
  jobQueue, jobWorker, prWatcher,
  repoRoot, publicRoot,
  conversationLogPath, flatRagHousePath, flatRagHouseManifestPath,
  operatorNotesPath, cloudMirrorsPath, cloudMirrorUrls,
  maxConversationTextLength, maxDreamerTextLength,
  openaiApiKey,
  "__dirname": __dirname,
};

const routes = [
  require("./routes/status"),
  require("./routes/system-overview"),
  require("./routes/ui"),
  require("./routes/media"), // Video/media streaming (range requests)
  require("./routes/rag"),
  require("./routes/operator"),
  require("./routes/files"),
  require("./routes/files-upload"),
  require("./routes/dreamer"),
  require("./routes/queue"),
  require("./routes/dream"),
  require("./routes/dreams"),
  require("./routes/keystone"),
  require("./routes/image"),
  require("./routes/web-images"),
  require("./routes/three-doors-image-pool"),
  require("./routes/flourishing"),
  require("./routes/claims"),
  require("./routes/cubes"),
  require("./routes/csf"),
  require("./routes/training"),
  require("./routes/token-audit"),
  require("./routes/trading"),
  require("./routes/agent-performance"),
  require("./routes/leaderboard"),
  require("./routes/agent-status"),
  require("./routes/self-edit"),
  require("./routes/creator"),
  require("./routes/creator-entries"),
  require("./routes/surfaces"),
  require("./routes/features"),
  require("./routes/personal-cube"),
  require("./routes/pr-review"),
  require("./routes/auto-merge"),
];

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    });
    res.end();
    return;
  }

  for (const handler of routes) {
    const handled = await handler(req, res, url, deps);
    if (handled) return;
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    if (res.headersSent) {
      console.error("Route error after response sent:", error.message);
      return;
    }
    sendJson(res, { error: error.message }, 500);
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Lantern Garage port ${port} is already in use. Open http://127.0.0.1:${port} or choose another port.`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

// ── Discord Bot (optional child process) ──
let discordBot = null;
const discordToken = process.env.DISCORD_BOT_TOKEN;
const discordGuildId = process.env.LANTERN_DISCORD_GUILD_ID;
if (discordToken && discordGuildId) {
  const botScript = path.join(repoRoot, "src", "discord_lounge_bot", "bot_v2.py");
  if (fs.existsSync(botScript)) {
    const pythonExe = process.platform === "win32" ? "python" : "python3";
    discordBot = spawn(pythonExe, [botScript], {
      stdio: "inherit",
      cwd: repoRoot,
      env: { ...process.env, DISCORD_BOT_TOKEN: discordToken, LANTERN_DISCORD_GUILD_ID: discordGuildId },
    });
    discordBot.on("error", (err) => {
      console.error(`[Discord Bot] Failed to start: ${err.message}`);
    });
    discordBot.on("exit", (code) => {
      console.log(`[Discord Bot] exited with code ${code}`);
    });
    console.log(`[Discord Bot] Spawning ${botScript}`);
  } else {
    console.warn(`[Discord Bot] Script not found: ${botScript}`);
  }
} else {
  console.log("[Discord Bot] Skipped (set DISCORD_BOT_TOKEN + LANTERN_DISCORD_GUILD_ID in .env.local to enable)");
}

// ── MCP Server (no-auth, port 8771) ──
let mcpServer = null;
const mcpServerScript = path.join(repoRoot, "src", "mcp_server", "server.py");
const enableMcpServer = process.env.LANTERN_MCP_SERVER !== "false";
if (enableMcpServer && fs.existsSync(mcpServerScript)) {
  const pythonExe = process.platform === "win32" ? "python" : "python3";
  mcpServer = spawn(pythonExe, [mcpServerScript], {
    stdio: "inherit",
    cwd: repoRoot,
    env: { ...process.env, LANTERN_MCP_PORT: "8771" },
  });
  mcpServer.on("error", (err) => {
    console.error(`[MCP Server] Failed to start: ${err.message}`);
  });
  mcpServer.on("exit", (code) => {
    console.log(`[MCP Server] exited with code ${code}`);
  });
  console.log(`[MCP Server] Starting on port 8771...`);
} else if (enableMcpServer) {
  console.warn(`[MCP Server] Script not found: ${mcpServerScript}`);
} else {
  console.log("[MCP Server] Disabled (set LANTERN_MCP_SERVER=true to enable)");
}

// ── MCP OAuth2 Server (OAuth2 protected, port 8772) ──
let mcpOAuthServer = null;
const mcpOAuthServerScript = path.join(repoRoot, "src", "mcp_server", "server_oauth.py");
const enableMcpOAuth = process.env.LANTERN_MCP_OAUTH !== "false";
if (enableMcpOAuth && fs.existsSync(mcpOAuthServerScript)) {
  const pythonExe = process.platform === "win32" ? "python" : "python3";
  mcpOAuthServer = spawn(pythonExe, [mcpOAuthServerScript], {
    stdio: "inherit",
    cwd: repoRoot,
    env: { ...process.env, LANTERN_MCP_OAUTH_PORT: "8772" },
  });
  mcpOAuthServer.on("error", (err) => {
    console.error(`[MCP OAuth Server] Failed to start: ${err.message}`);
  });
  mcpOAuthServer.on("exit", (code) => {
    console.log(`[MCP OAuth Server] exited with code ${code}`);
  });
  console.log(`[MCP OAuth Server] Starting on port 8772...`);
} else if (enableMcpOAuth) {
  console.warn(`[MCP OAuth Server] Script not found: ${mcpOAuthServerScript}`);
} else {
  console.log("[MCP OAuth Server] Disabled (set LANTERN_MCP_OAUTH=true to enable)");
}

// ── Trading Microservice (Lantern OS Native) ──
// Set LANTERN_DISABLE_TRADING=1 to skip the trading microservice + AI trader.
const tradingDisabled = process.env.LANTERN_DISABLE_TRADING === "1";
let tradingService = null;
const tradingServiceScript = path.join(__dirname, "start-trading-service.js");
if (tradingDisabled) {
  console.log("[Trading Service] Skipped (LANTERN_DISABLE_TRADING=1)");
} else if (fs.existsSync(tradingServiceScript)) {
  tradingService = spawn("node", [tradingServiceScript], {
    stdio: "inherit",
    cwd: __dirname,
    env: { ...process.env, AI_TRADER_DASHBOARD_PORT: 5050 },
  });
  tradingService.on("error", (err) => {
    console.error(`[Trading Service] Failed to start: ${err.message}`);
  });
  tradingService.on("exit", (code) => {
    console.log(`[Trading Service] Exited with code ${code}`);
  });
  console.log(`[Trading Service] Starting on port 5050...`);
} else {
  console.warn(`[Trading Service] Script not found: ${tradingServiceScript}`);
}

// ── AI Trader Process (autonomous trading system) ──
const aiTraderStartupScript = path.join(__dirname, "..", "..", "scripts", "start-ai-trader.js");
let aiTraderProcess = null;
if (tradingDisabled) {
  console.log("[AI Trader] Skipped (LANTERN_DISABLE_TRADING=1)");
} else if (fs.existsSync(aiTraderStartupScript)) {
  aiTraderProcess = spawn("node", [aiTraderStartupScript], {
    stdio: "inherit",
    cwd: repoRoot,
    env: { ...process.env },
  });
  aiTraderProcess.on("error", (err) => {
    console.error(`[AI Trader] Failed to start: ${err.message}`);
  });
  aiTraderProcess.on("exit", (code) => {
    console.log(`[AI Trader] Process manager exited with code ${code}`);
  });
  console.log(`[AI Trader] Started process manager`);
} else {
  console.log(`[AI Trader] Using native Lantern OS Trading Microservice`);
}

// ── Cloudflare Tunnel (optional, for public access) ──
let cloudflaredProcess = null;
const enableCloudflare = process.env.LANTERN_CLOUDFLARE_TUNNEL !== "false";
if (enableCloudflare) {
  // Use tunnel run without explicit name to let cloudflared use ~/.cloudflared/config.yml
  cloudflaredProcess = spawn("cloudflared", ["tunnel", "run"], {
    stdio: "inherit",
    cwd: repoRoot,
    env: { ...process.env },
  });
  cloudflaredProcess.on("error", (err) => {
    console.error(`[Cloudflare Tunnel] Failed to start: ${err.message}`);
    console.log("[Cloudflare Tunnel] Install with: choco install cloudflare-warp");
  });
  cloudflaredProcess.on("exit", (code) => {
    console.log(`[Cloudflare Tunnel] exited with code ${code}`);
  });
  console.log(`[Cloudflare Tunnel] Starting (reading from ~/.cloudflared/config.yml)...`);
} else {
  console.log("[Cloudflare Tunnel] Disabled (set LANTERN_CLOUDFLARE_TUNNEL=true to enable)");
}

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down...`);
  if (discordBot && !discordBot.killed) {
    discordBot.kill("SIGTERM");
  }
  if (mcpServer && !mcpServer.killed) {
    mcpServer.kill("SIGTERM");
  }
  if (mcpOAuthServer && !mcpOAuthServer.killed) {
    mcpOAuthServer.kill("SIGTERM");
  }
  if (tradingService && !tradingService.killed) {
    tradingService.kill("SIGTERM");
  }
  if (aiTraderProcess && !aiTraderProcess.killed) {
    aiTraderProcess.kill("SIGTERM");
  }
  if (cloudflaredProcess && !cloudflaredProcess.killed) {
    cloudflaredProcess.kill("SIGTERM");
  }
  if (deps.kalshiCollector) {
    deps.kalshiCollector.stop();
  }
  if (deps.newsCollector) {
    deps.newsCollector.stop();
  }
  prWatcher.stop();
  server.close(() => {
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(port, host, () => {
  console.log(`Lantern Garage app listening on ${host}:${port}`);

  // ── Kalshi Tight-Band Collector (6s polling) ──
  const kalshiCollector = require("./lib/kalshi-collector");
  kalshiCollector.start();
  deps.kalshiCollector = kalshiCollector; // Make available to routes

  // ── Crypto Price & News Collector (30s polling) ──
  const CryptoCollector = require("./lib/crypto-collector");
  const cryptoCollector = new CryptoCollector();
  cryptoCollector.start(30000); // 30s interval
  deps.cryptoCollector = cryptoCollector; // Make available to routes

  // ── Market News Collector (10-min polling, watchlist + broad market RSS) ──
  const NewsCollector = require("./lib/news-collector");
  const newsCollector = new NewsCollector();
  newsCollector.start(600000); // 10-min interval
  deps.newsCollector = newsCollector; // Make available to routes

  // ── Kalshi Position Monitor (10s polling) + Convergence Trainer ──
  const { startMonitoring } = require("./lib/kalshi-position-monitor");
  const { trainModel } = require("./lib/kalshi-convergence-trainer");
  const { startEnhancing } = require("./lib/kalshi-convergence-enhancer");
  const { startAnalyzing } = require("./lib/kalshi-convergence-lora");
  startMonitoring();   // Start automated stop-loss monitoring
  trainModel().catch(e => console.error("[Server] Convergence training failed:", e.message));
  startEnhancing();    // Start continuous convergence improvement loop
  startAnalyzing();    // Start LoRA fine-tuning (proactive, no trades needed)

  // ── Crypto CIO Live Trader (15-min market observer + paper-trade signal log) ──
  // Must run continuously during market hours so resolved windows produce training data.
  // Gated by KALSHI_CRYPTO_OBSERVER env var (defaults ON when Kalshi creds are present).
  const enableCryptoObserver = process.env.KALSHI_CRYPTO_OBSERVER !== "false"
    && !!(process.env.KALSHI_API_KEY_ID || process.env.KALSHI_PRIVATE_KEY || process.env.KALSHI_PRIVATE_KEY_PATH);
  const cryptoObserverScript = path.join(repoRoot, "experiments", "crypto_live_trader.py");
  let cryptoObserverProcess = null;
  if (enableCryptoObserver && fs.existsSync(cryptoObserverScript)) {
    const pythonExe = process.platform === "win32" ? "python" : "python3";
    const logDir = path.join(repoRoot, "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const observerLogFd = fs.openSync(path.join(logDir, "crypto-observer.log"), "a");
    cryptoObserverProcess = spawn(pythonExe, [cryptoObserverScript, "--interval", "10", "--edge", "0.06"], {
      cwd: repoRoot,
      stdio: ["ignore", observerLogFd, observerLogFd],
    });
    cryptoObserverProcess.on("error", (err) => console.error(`[CryptoObserver] Failed to start: ${err.message}`));
    cryptoObserverProcess.on("exit", (code) => console.warn(`[CryptoObserver] Exited with code ${code} — training data gap from this point`));
    deps.cryptoObserver = {
      pid: cryptoObserverProcess.pid,
      startedAt: new Date().toISOString(),
      process: cryptoObserverProcess,
    };
    console.log("[CryptoObserver] Started — logging to logs/crypto-observer.log");
  } else if (enableCryptoObserver) {
    console.warn(`[CryptoObserver] Script not found: ${cryptoObserverScript}`);
  } else {
    console.log("[CryptoObserver] Disabled (set KALSHI_CRYPTO_OBSERVER=false to suppress, or add Kalshi creds to enable)");
  }

  // Auto-register this node to the mesh
  (async () => {
    try {
      const nodeId = process.env.LANTERN_NODE_ID || require("os").hostname();
      const nodeName = process.env.LANTERN_NODE_NAME || `Lantern (${require("os").hostname()})`;
      const agentList = AGENT_PERSONAS.map(a => a.id) || ["lantern"];
      const workerCount = parseInt(process.env.LANTERN_WORKERS || "1", 10);

      const registrationData = {
        nodeId,
        nodeName,
        agents: agentList,
        workers: workerCount,
        port
      };

      const registrationReq = require("http").request({
        hostname: "127.0.0.1",
        port,
        path: "/api/nodes/register",
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }, (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            const result = JSON.parse(data);
            if (result.ok) {
              console.log(`[Mesh] Node registered: ${nodeName} (${agentList.length} agents, ${workerCount} workers)`);
            }
          } catch { /* silent */ }
        });
      });
      registrationReq.on("error", () => { /* silent */ });
      registrationReq.write(JSON.stringify(registrationData));
      registrationReq.end();

      // Heartbeat every 30 seconds
      setInterval(() => {
        const heartbeat = require("http").request({
          hostname: "127.0.0.1",
          port,
          path: "/api/nodes/register",
          method: "POST",
          headers: { "Content-Type": "application/json" }
        }, () => {});
        heartbeat.on("error", () => {});
        heartbeat.write(JSON.stringify(registrationData));
        heartbeat.end();
      }, 30000);
    } catch (err) {
      console.warn(`[Mesh] Auto-registration failed: ${err.message}`);
    }
  })();

  prWatcher.start();
  refreshAllPcsf(repoRoot);
  // Ollama cold-start probe
  const ollamaBase = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const ollamaModel = process.env.OLLAMA_MODEL || "qwen2.5-coder";
  const httpLib = ollamaBase.startsWith("https") ? require("https") : require("http");
  httpLib.get(`${ollamaBase}/api/tags`, (r) => {
    let d = "";
    r.on("data", c => d += c);
    r.on("end", () => {
      try {
        const j = JSON.parse(d);
        const models = j.models?.map(m => m.name) || [];
        const hasModel = models.includes(ollamaModel) || models.some(m => m.startsWith(ollamaModel));
        if (hasModel) {
          console.log(`[Ollama] Local model ready: ${ollamaModel} (${models.length} models available)`);
        } else {
          console.log(`[Ollama] Running but model '${ollamaModel}' not found. Available: ${models.slice(0, 5).join(", ") || "none"}. Run: ollama pull ${ollamaModel}`);
        }
      } catch {
        console.log("[Ollama] Responded but tags unreadable");
      }
    });
  }).on("error", () => {
    console.log("[Ollama] Not running on default port 11434. Local fallback disabled.");
  });
});
