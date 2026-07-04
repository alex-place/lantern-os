// Trust the OS cert store on Windows so TLS verification SUCCEEDS behind AV/corporate
// interception (verification stays ON — no rejectUnauthorized bypass). Must run before
// any outbound HTTPS. No-op off Windows. #1376
require("./lib/system-ca").trustSystemCAs();

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// ── Dependency preflight ───────────────────────────────────────────────────
// When `git pull` adds a dependency to package.json but `npm install` hasn't run
// yet, startup otherwise dies with a raw "Cannot find module 'x'" stack trace
// (e.g. busboy via routes/pdfs.js). Surface an actionable message instead.
(function preflightDependencies() {
  // Escape hatch for worktree/CI runs where node_modules is junctioned from another
  // checkout and a `file:` workspace self-dep (lantern-os) isn't symlinked. Opt-in only.
  if (process.env.SKIP_DEP_PREFLIGHT === "1") return;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  } catch {
    return; // no/unreadable manifest → nothing to check
  }
  const missing = [];
  for (const dep of Object.keys(pkg.dependencies || {})) {
    try {
      require.resolve(dep);
    } catch (e) {
      // Only a genuinely absent package is MODULE_NOT_FOUND. Other resolve errors
      // (e.g. ERR_PACKAGE_PATH_NOT_EXPORTED) mean the package IS installed.
      if (e && e.code === "MODULE_NOT_FOUND") missing.push(dep);
    }
  }
  if (missing.length) {
    console.error(
      `\n[startup] Missing ${missing.length} dependenc${missing.length === 1 ? "y" : "ies"}: ${missing.join(", ")}` +
      `\n[startup] Run:  npm install --prefix apps/lantern-garage\n`
    );
    process.exit(1);
  }
})();

// Load .env.local then .env from repo root (two levels up from apps/lantern-garage/)
// .env.local ALWAYS overrides system env — .env only sets if not already present
const candidateEnvFiles = [
  { path: path.resolve(__dirname, "..", "..", ".env.local"), override: true },
  { path: path.resolve(__dirname, "..", "..", ".env"),       override: false },
];
for (const { path: envPath, override } of candidateEnvFiles) {
  if (!fs.existsSync(envPath)) continue;
  fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const m = line.replace(/\r$/, "").match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && (override || !process.env[m[1]])) process.env[m[1]] = m[2].replace(/^['"]/g, "").replace(/['"]$/g, "");
  });
}

const { sendJson, sendFile, sendHtml, collectRequestBody } = require("./lib/http-utils");
const { readJson, readJsonl, appendJsonlQueued } = require("./lib/file-queue");
const { getStatus, getReadiness, getMiningLabStatus, getActionCapabilities, getOperatorFeedbackMemory, getAccessModel, getCloudMirrorStatus, setTunnelState } = require("./lib/status");
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
const { dataRoot } = require("./lib/app-paths"); // #1946 G2: writable state root (servers: <repoRoot>/data)
const publicRoot = path.join(__dirname, "public");
const port = Number(process.env.LANTERN_GARAGE_PORT || process.env.PORT || 4177);
const host = process.env.LANTERN_GARAGE_HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const conversationLogPath = path.join(dataRoot(), "conversations", "garage-conversations.jsonl");
const flatRagHousePath = path.join(dataRoot(), "rag-house", "flat-rag-house-latest.json");
const flatRagHouseManifestPath = path.join(repoRoot, "manifests", "FLAT-RAG-HOUSE-LATEST.md");
const operatorNotesPath = path.join(dataRoot(), "operator-notes", "notes.jsonl");
const cloudMirrorsPath = path.join(repoRoot, "manifests", "cloud-mirrors.json");
const cloudMirrorUrls = process.env.LANTERN_CLOUD_MIRROR_URLS || "";
const openaiApiKey = process.env.OPENAI_API_KEY || "";
const maxConversationTextLength = 4000;
const maxDreamerTextLength = 2000;

// Initialize Creator Suite job queue and worker
const jobQueue = new JobQueue(repoRoot);
const jobWorker = new JobWorker(jobQueue, repoRoot);
jobWorker.start(2000); // Poll every 2 seconds for new jobs

// Expose the live JobQueue singleton to in-process chat tools (lib/tool-runner)
// so the Creator video tools enqueue onto the same instance JobWorker polls.
require("./lib/creator-runtime").setCreatorRuntime({ jobQueue, repoRoot });

// PR Watcher — auto-reviews PRs idle for 3min via Keystone fleet, and (when
// PR_WATCHER_AUTOMERGE=1) auto-merges reviewed + green + conflict-free PRs.
const prWatcher = new PrWatcher({
  repoRoot, port,
  idleMs: Number(process.env.PR_WATCHER_IDLE_MS || 3 * 60_000),
  autoMerge: process.env.PR_WATCHER_AUTOMERGE === "1",
  mergeIgnoreChecks: process.env.PR_WATCHER_MERGE_IGNORE_CHECKS
    ? process.env.PR_WATCHER_MERGE_IGNORE_CHECKS.split(",").map((s) => s.trim()).filter(Boolean)
    : null,
  mergeIgnorePatterns: process.env.PR_WATCHER_MERGE_IGNORE_PATTERNS
    ? process.env.PR_WATCHER_MERGE_IGNORE_PATTERNS.split(",").map((s) => s.trim()).filter(Boolean)
    : null,
});

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

// Authoritative gate for the trading API. Page-level gating (routes/pages.js)
// stops the HTML from loading, but the data endpoints must be guarded too so a
// non-entitled account (e.g. Deep Dreamer/founder without trade access) cannot
// reach /api/trading/* directly. Runs before routes/trading. Admins and the
// local bypass pass through (see auth-middleware.requireEntitlement).
const { requireEntitlement, isAdmin } = require("./lib/auth-middleware");
// Read-only market-data GETs with NO account/order state — served to everyone so
// the logged-out chart view (guest-mode stock-trader.html) renders from the exact
// same endpoints the live terminal uses (a true 1:1 copy, no duplicated data
// layer). Everything NOT on this list (positions, orders, order placement,
// agent-log, calibration, overnight-scan, all mutations) stays trade-gated.
const PUBLIC_TRADING_READS = new Set([
  "/api/trading/watchlist",         // GET → server default watchlist (not per-user)
  "/api/trading/watchlist-prices",  // live quotes
  "/api/trading/bars-multi",        // OHLCV for the charts
  "/api/trading/market-status",     // VIX / regime / SPY trend / session
  "/api/trading/zones",             // S/R zones (derived from bars)
  "/api/trading/symbols/search",    // symbol-search popup (broker asset universe)
  "/api/trading/symbol-stats",      // Yahoo returns/technicals
  "/api/trading/symbol-info",       // name/exchange/asset_class
  "/api/trading/logo",              // brand-logo proxy
  "/api/trading/news/recent",       // public news feed
]);
function tradeApiGuard(req, res, url) {
  if (!url.pathname.startsWith("/api/trading/")) return false; // not ours → continue
  if (req.method === "GET" && PUBLIC_TRADING_READS.has(url.pathname)) return false; // public read → fall through
  if (requireEntitlement(req, res, "trade")) return false;     // allowed → fall through
  return true;                                                  // blocked → 403/302 already sent
}

// ── Orchestration control gate (admin-only) ──────────────────────────────────
// orchestration.html is a public read-only fleet view (guests + non-admins see
// status panels only). Its CONTROL endpoints — save provider/GPU keys, dispatch
// training, toggle the autonomous fleet, run autowork — carry NO auth of their
// own, so making the page public would otherwise let anyone POST to them. We gate
// them here to admin (the local owner passes via isLocalBypass; real admin
// sessions pass). The key GETs are gated too: even masked, they leak which
// providers are configured. Everything else (Work Board, PR Lanes, Agent Slots,
// reliance, calibration, rollover) stays public read-only. Order matters: this
// runs before the route handlers, which have no auth check themselves.
const ADMIN_ONLY_CONTROL = {
  // exact-path endpoints → set of methods that require admin ("*" = all methods)
  "/api/providers/keys":                     "*",  // GET(masked)+POST(save key)
  "/api/gpu-training/keys":                  "*",  // GET(masked)+POST(save key)
  "/api/gpu-training/dispatch":              "*",  // fire a training job
  "/api/gpu-training/dispatch-all":          "*",
  "/api/gpu-training/poll":                  "*",
  "/api/convergence/autonomous-work":        "*",  // run an issue autonomously
  "/api/convergence/autonomous-work/stream": "*",  // SSE autonomous work
  "/api/research/repo/learn":                "*",  // trigger repo→memory learning
};
function orchestrationControlGuard(req, res, url) {
  const rule = ADMIN_ONLY_CONTROL[url.pathname];
  if (!rule) return false;                         // not a controlled endpoint → continue
  if (rule !== "*" && rule !== req.method) return false;
  if (isAdmin(req)) return false;                  // admin / local owner → allow
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "admin_required", detail: "Orchestration control is admin-only." }));
  return true;                                      // blocked
}

// ── Autonomous AI-trader gate ($200 Synthesasia Guild tier / admin) ──────────
// The $20 Deep Dreamer tier unlocks manual trading + AI *suggestions* (the whole
// /api/trading/* surface, via tradeApiGuard). The AUTONOMOUS AI trader — where the
// system records/executes trades on the user's behalf — is a $200 capability, so
// its execution endpoint requires admin (the $200 Synthesasia Guild role; the
// local owner passes via isLocalBypass, keeping the server-side autonomous loop
// working). Runs after tradeApiGuard, so $20 users are already past the trade gate
// and only get stopped here for autonomous execution.
const AI_TRADER_ADMIN = {
  "/api/trading/ai-trader/trades": "POST", // record/execute an autonomous trade
};
function aiTraderGuard(req, res, url) {
  const rule = AI_TRADER_ADMIN[url.pathname];
  if (!rule || rule !== req.method) return false;   // not a gated autonomous op → continue
  if (isAdmin(req)) return false;                    // $200 tier / local owner → allow
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "tier_required", detail: "The autonomous AI trader requires the $200 tier." }));
  return true;                                        // blocked
}

const routes = [
  tradeApiGuard,                        // gate /api/trading/* by "trade" entitlement ($20+)
  aiTraderGuard,                        // gate autonomous AI-trader execution to $200/admin
  orchestrationControlGuard,            // gate orchestration control endpoints to admin
  require("./routes/auth"),             // Patreon OAuth + session
  require("./routes/pages"),            // Protected pages with server-side role checking (no flicker)
  require("./routes/profiles"),         // User profiles + role configuration (CSF-backed)
  require("./routes/status"),
  require("./routes/ui"),
  require("./routes/media"), // Video/media streaming (range requests)
  require("./routes/rag"),
  require("./routes/operator"),
  require("./routes/api-tools-log"),     // Tool execution logs
  require("./routes/files"),
  require("./routes/files-upload"),
  require("./routes/dreamer"),
  require("./routes/queue"),
  require("./routes/dream"),
  require("./routes/dreams"),
  require("./routes/keystone"),
  require("./routes/rollover"), // #898: Keystone-vs-Claude landed-work share
  require("./routes/image"),
  require("./routes/web-images"),
  require("./routes/youtube"),
  require("./routes/github-activity"), // Explore: latest releases + commits (cached)
  require("./routes/github-issue"),    // Chat screenshot reporter → files a GitHub issue
  require("./routes/discover-feeds"),  // Explore: curated discovery rail (RSS/Atom, cached)
  require("./routes/explore"),         // Explore: single-pane PCSF-ranked feed + interaction logging (#1211)
  require("./routes/convergence-dispatch"),
  require("./routes/metrics"),          // #1411: outcome metrics (verified-patch / honesty / route-quality)
  require("./routes/doors"),            // Three Doors: canon + journey + Σ₀ turns (1.8.18)
  require("./routes/factcheck"),        // #1430: personal fact-check button
  require("./routes/drift"),            // #1428: drift-canary observability
  require("./routes/replay"),           // #1419: convergence replay / time-travel debugger
  require("./routes/feedback"),         // #1965: per-message 👍/👎 → chat-feedback ledger (Observe)
  require("./routes/memory"),
  require("./routes/research-repo"),    // Research Team: repo→Convergence-Memory learning
  require("./routes/flourishing"),
  require("./routes/claims"),
  require("./routes/cubes"),
  require("./routes/csf"),
  require("./routes/training"),
  require("./routes/gpu-training"),
  require("./routes/token-audit"),
  require("./routes/trading"),
  require("./routes/agent-performance"),
  require("./routes/leaderboard"),
  require("./routes/agent-status"),
  require("./routes/providers"),
  require("./routes/library"),
  require("./routes/self-edit"),
  require("./routes/creator"),
  require("./routes/creator-entries"),
  require("./routes/creator-calibration"),
  require("./routes/research"), // open-video learning flywheel status

  require("./routes/pdfs"), // PDF document listing for Knowledge Center
  require("./routes/documents"), // .docx upload → LLM rewrite → return new version
  require("./routes/docmode"), // Document Mode — versioned collaborative doc editor
  require("./routes/features"),
  require("./routes/admin-flags"),     // Admin feature flags + per-page nav visibility
  require("./routes/personal-cube"),
  require("./routes/grounding"),       // Mesh grounding resolver: /api/grounding/resolve + /api/mesh/ground (gated by MESH_GROUNDING=1)
  require("./routes/pr-review"),
  require("./routes/auto-merge"),
  require("./routes/creators"),        // creator profiles + intake form
  require("./routes/surfaces"),        // static file catch-all — MUST stay last (returns true for any path)
];

// ── Session middleware (Patreon OAuth) ──
const session = require("express-session");
// Fail-closed: the committed dev default may sign sessions only on loopback. Bound
// beyond loopback (PORT set / NODE_ENV=production) without a real SESSION_SECRET,
// refuse to boot rather than sign with a repo-public key. #867
const { resolveSessionSecret } = require("./lib/session-secret");
let sessionSecret;
try {
  sessionSecret = resolveSessionSecret(process.env);
} catch (err) {
  console.error("[FATAL] " + err.message);
  process.exit(1);
}
const sessionMiddleware = session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  // Behind Railway's TLS-terminating proxy, honor X-Forwarded-Proto so a
  // `secure` session cookie is actually set (otherwise login never persists).
  proxy: true,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
});

// Wrap session middleware to work with Node's http module
function withSession(req, res, handler) {
  return new Promise((resolve) => {
    sessionMiddleware(req, res, () => {
      resolve(handler(req, res));
    });
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // #1946 G4 desktop loopback token: when the launcher-opened page carries the
  // per-boot ?__lt=<token> matching UNISONA_LOCAL_TOKEN, hand the browser a
  // SameSite=Strict, HttpOnly session cookie so every SUBSEQUENT request (fetch,
  // EventSource, asset) authenticates automatically — while a DNS-rebind / CSRF
  // page cannot, because SameSite blocks the cookie cross-site and the attacker
  // never learns the token. No-op unless the token is configured (servers unaffected).
  const _localToken = process.env.UNISONA_LOCAL_TOKEN;
  if (_localToken) {
    const lt = url.searchParams.get("__lt");
    if (lt && require("./lib/request-auth").tokensEqual(lt, _localToken)) {
      res.setHeader(
        "Set-Cookie",
        `unisona_lt=${encodeURIComponent(_localToken)}; Path=/; SameSite=Strict; HttpOnly; Max-Age=31536000`
      );
    }
  }

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
    try {
      const handled = await handler(req, res, url, deps);
      if (handled) return;
    } catch (e) {
      console.error(`Route handler error for ${url.pathname}:`, e.message);
      if (!res.headersSent) {
        sendJson(res, { error: e.message }, 500);
      }
      return;
    }
  }
}

const server = http.createServer((req, res) => {
  withSession(req, res, () => route(req, res)).catch((error) => {
    if (res.headersSent) {
      console.error("Route error after response sent:", error.message);
      return;
    }
    sendJson(res, { error: error.message }, 500);
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    // Name the owning PID + the exact command to free the port, instead of a bare
    // "already in use" — the deploy/boot EADDRINUSE wedge was hard to clear because you
    // couldn't tell which stale instance held the port (#1549).
    const { findPortOwner, eaddrinuseHelp } = require("./lib/port-guard");
    findPortOwner(port)
      .then((owner) => console.error(`[lantern-garage] ${eaddrinuseHelp(port, owner)}`))
      .catch(() => console.error(`[lantern-garage] Port ${port} is already in use.`))
      .finally(() => { process.exitCode = 1; });
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

// ── MCP child lifecycle (singleton + no-orphan) ─────────────────────────────
// This same server.js runs as the stable production server AND from any dev /
// `node --watch` checkout. Each used to UNCONDITIONALLY spawn its own MCP
// (server.py:8771, server_oauth.py:8772). Two checkouts at once raced for the
// port, and `node --watch` restarts orphaned the python *grandchild*: on Windows
// `python` re-execs into the real interpreter, so a SIGTERM to the direct child
// left the grandchild bound to 8771 and still spawning tool-runner bridges.
// Strays piled up on a RAM-tight box (memory: stable-4177-orphan-leak-502).
//
//   • probe the port first → DEFER to whoever already owns it (singleton)
//   • track every child and TREE-kill it on shutdown → never orphan a grandchild
const mcpChildren = [];

function probeMcpPort(port, cb) {
  // Quick "is something already listening here?" check (no payload sent).
  const socket = new net.Socket();
  let settled = false;
  const finish = (inUse) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    cb(inUse);
  };
  socket.setTimeout(500);
  socket.once("connect", () => finish(true));
  socket.once("timeout", () => finish(false));
  socket.once("error", () => finish(false));
  try {
    socket.connect(port, "127.0.0.1");
  } catch {
    finish(false);
  }
}

function killMcpChild(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      // Tree-kill: `python` re-execs into the real interpreter, so killing only
      // the direct child orphans the grandchild that holds 8771. /T kills the tree.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

function startMcpChild({ label, script, port, portEnvKey, enabled }) {
  if (!enabled) {
    console.log(`[${label}] Disabled (set ${portEnvKey === "LANTERN_MCP_PORT" ? "LANTERN_MCP_SERVER" : "LANTERN_MCP_OAUTH"}=true to enable)`);
    return;
  }
  if (!fs.existsSync(script)) {
    console.warn(`[${label}] Script not found: ${script}`);
    return;
  }
  probeMcpPort(port, (inUse) => {
    if (inUse) {
      console.log(`[${label}] Port ${port} already serving an MCP — reusing it (singleton); not spawning a duplicate.`);
      return;
    }
    const pythonExe = process.platform === "win32" ? "python" : "python3";
    const child = spawn(pythonExe, [script], {
      stdio: "inherit",
      cwd: repoRoot,
      env: { ...process.env, [portEnvKey]: String(port) },
    });
    mcpChildren.push(child);
    child.on("error", (err) => console.error(`[${label}] Failed to start: ${err.message}`));
    child.on("exit", (code) => console.log(`[${label}] exited with code ${code}`));
    console.log(`[${label}] Starting on port ${port}...`);
  });
}

// ── MCP Server (no-auth, port 8771) ──
startMcpChild({
  label: "MCP Server",
  script: path.join(repoRoot, "src", "mcp_server", "server.py"),
  port: 8771,
  portEnvKey: "LANTERN_MCP_PORT",
  enabled: process.env.LANTERN_MCP_SERVER !== "false",
});

// ── MCP OAuth2 Server (OAuth2 protected, port 8772) ──
startMcpChild({
  label: "MCP OAuth Server",
  script: path.join(repoRoot, "src", "mcp_server", "server_oauth.py"),
  port: 8772,
  portEnvKey: "LANTERN_MCP_OAUTH_PORT",
  enabled: process.env.LANTERN_MCP_OAUTH !== "false",
});

// ── Trading ──
// The autonomous Python trader (scripts/start-ai-trader.js → src/trading_agents,
// Alpaca) and the port-5050 trading microservice were removed. Trading now runs
// in-process via routes/trading.js + the Node signal-engine (lib/signal-engine)
// with broker access through IBKR (lib/ibkr-cpapi.js) — nothing to spawn here.

// ── Cloudflare Tunnel (optional, for public access) ──
let cloudflaredProcess = null;
const enableCloudflare = process.env.LANTERN_CLOUDFLARE_TUNNEL !== "false";
if (enableCloudflare) {
  setTunnelState({ enabled: true, status: "starting", startedAt: new Date().toISOString() });
  // Use tunnel run without explicit name to let cloudflared use ~/.cloudflared/config.yml
  cloudflaredProcess = spawn("cloudflared", ["tunnel", "run"], {
    stdio: "inherit",
    cwd: repoRoot,
    env: { ...process.env },
  });
  let _tunnelFailed = false;
  cloudflaredProcess.on("error", (err) => {
    _tunnelFailed = true;
    console.error(`[Cloudflare Tunnel] Failed to start: ${err.message}`);
    console.log("[Cloudflare Tunnel] Install with: choco install cloudflare-warp");
    setTunnelState({ status: "error", lastError: err.message, exitedAt: new Date().toISOString() });
  });
  cloudflaredProcess.on("exit", (code) => {
    _tunnelFailed = true;
    setTunnelState({ status: "exited", exitCode: code, exitedAt: new Date().toISOString() });
    if (code && code !== 0) {
      // Non-zero exit: public access is down but the local server keeps running.
      // The most common cause is a stale/unauthorized tunnel credential
      // ("Unauthorized: Tunnel not found", see #672) — surface the fix instead of
      // a bare exit code so it is self-explanatory.
      console.warn(
        `[Cloudflare Tunnel] exited with code ${code} — public access (https://lantern-os.net) ` +
        `unavailable; the server continues locally on this port.\n` +
        `[Cloudflare Tunnel] If you see "Unauthorized: Tunnel not found", the credential is ` +
        `stale/revoked — recreate the tunnel:\n` +
        `[Cloudflare Tunnel]   cloudflared tunnel login && cloudflared tunnel create lantern-os\n` +
        `[Cloudflare Tunnel] then point ~/.cloudflared/config.yml at the new tunnel id.`
      );
    } else {
      console.log(`[Cloudflare Tunnel] exited cleanly (code ${code}).`);
    }
  });
  // Brief delay to let cloudflared handshake; only set running if no error/exit fired first
  setTimeout(() => {
    if (!_tunnelFailed && cloudflaredProcess && !cloudflaredProcess.killed) {
      setTunnelState({ status: "running" });
    }
  }, 3000);
  console.log(`[Cloudflare Tunnel] Starting (reading from ~/.cloudflared/config.yml)...`);
} else {
  setTunnelState({ enabled: false, status: "disabled" });
  console.log("[Cloudflare Tunnel] Disabled via LANTERN_CLOUDFLARE_TUNNEL=false (it is enabled by default; unset the var to re-enable).");
}

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down...`);
  if (discordBot && !discordBot.killed) {
    discordBot.kill("SIGTERM");
  }
  // Tree-kill MCP children FIRST (before server.close, which can hang on open
  // SSE) so the python grandchild can't be left orphaned holding 8771.
  for (const child of mcpChildren) killMcpChild(child);
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

  // ── Nav lock-step assertion (#1880): warn if NAV_PAGES has drifted from the
  // links the global header renders (index.html .nav-links), so a page added to
  // one list but not the other is caught at boot instead of silently breaking.
  try {
    require("./lib/feature-flags").assertNavInSync();
  } catch (e) {
    console.error("[feature-flags] nav-sync check failed (non-fatal):", e && e.message);
  }

  // ── Boot-time queue reconcile: sweep stale assigned claims ──
  // A claim file is written per issue an autowork run opens a draft PR for and never
  // removed; when the issue later closes the claim lingers and inflates the
  // orchestration dashboard's "In Progress" count (75 leaked closed-issue claims was
  // the trigger for this). Sweep closed/stale claims once at boot. Deferred off the
  // critical boot path so the `gh` open-issue lookup never blocks the listen.
  setTimeout(() => {
    try {
      const q = require("./routes/queue");
      const rr = require("path").resolve(__dirname, "../..");
      const open = q.loadOpenIssues(rr);
      const openNums = open && open.openNumbers ? new Set(open.openNumbers) : null;
      const swept = q.sweepStaleAssigned(rr, { openIssueNumbers: openNums });
      if (swept.length) console.log(`[queue] boot reconcile: swept ${swept.length} stale assigned claim(s) (${openNums ? "issue-closed + age" : "age-only, gh unavailable"})`);
    } catch (e) {
      console.error("[queue] boot reconcile failed (non-fatal):", e && e.message);
    }
  }, 8000);

  // ── Market/trading background loops ─────────────────────────────────────────
  // These 24/7 collectors + convergence loops start on every boot. The desktop
  // launcher (docs/adr/0014) runs the Core purely for chat and sets
  // LANTERN_CHAT_ONLY=1 to skip them. Normal boots (4177/4178/cloud) leave the
  // flag unset, so their behaviour is unchanged.
  const chatOnly = process.env.LANTERN_CHAT_ONLY === "1";
  if (chatOnly) {
    console.log("[chat-only] Market collectors + convergence loops skipped (LANTERN_CHAT_ONLY=1)");
  } else {
    // ── Kalshi Tight-Band Collector (6s polling) ──
    const kalshiCollector = require("./lib/kalshi-collector");
    kalshiCollector.start();
    deps.kalshiCollector = kalshiCollector; // Make available to routes

    // ── Crypto Price & News Collector (30s polling) ──
    const CryptoCollector = require("./lib/crypto-collector");
    const cryptoCollector = new CryptoCollector();
    cryptoCollector.start(10000); // 10s (#1697: tighter so 24/7 crypto price ticks are visible/flash)
    deps.cryptoCollector = cryptoCollector; // Make available to routes

    // ── Market News Collector (10-min polling, watchlist + broad market RSS) ──
    const NewsCollector = require("./lib/news-collector");
    const newsCollector = new NewsCollector();
    newsCollector.start(300000); // 5-min interval
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
  }

  // ── Crypto CIO Live Trader (15-min market observer + paper-trade signal log) ──
  // Paper-only observer of 15-min crypto markets. It has NO proven taker edge (loses
  // after fees — see docs / kalshi-no-taker-edge) and, running 24/7, it floods the
  // shared paper-positions ledger (thousands of sim rows) which swamps real swipe
  // history and the Σ₀ council stats. So it is now OPT-IN: set KALSHI_CRYPTO_OBSERVER=1
  // to re-enable data collection; default OFF.
  const enableCryptoObserver = process.env.KALSHI_CRYPTO_OBSERVER === "1"
    && !!(process.env.KALSHI_API_KEY_ID || process.env.KALSHI_PRIVATE_KEY || process.env.KALSHI_PRIVATE_KEY_PATH);
  const cryptoObserverScript = path.join(repoRoot, "experiments", "crypto_live_trader.py");
  if (enableCryptoObserver && fs.existsSync(cryptoObserverScript)) {
    const pythonExe = process.platform === "win32" ? "python" : "python3";
    const logDir = path.join(repoRoot, "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    // A crash used to leave a silent training-data gap until the next server
    // restart. Relaunch with exponential backoff; a run that survives 10 min
    // resets the attempt counter so intermittent crashes don't exhaust retries.
    let observerAttempts = 0;
    const OBSERVER_MAX_ATTEMPTS = 6;
    const startCryptoObserver = () => {
      const observerLogFd = fs.openSync(path.join(logDir, "crypto-observer.log"), "a");
      const startedAtMs = Date.now();
      const child = spawn(pythonExe, [cryptoObserverScript, "--interval", "10", "--edge", "0.06"], {
        cwd: repoRoot,
        stdio: ["ignore", observerLogFd, observerLogFd],
      });
      child.on("error", (err) => console.error(`[CryptoObserver] Failed to start: ${err.message}`));
      child.on("exit", (code) => {
        fs.closeSync(observerLogFd);
        if (Date.now() - startedAtMs > 10 * 60 * 1000) observerAttempts = 0;
        observerAttempts++;
        if (observerAttempts > OBSERVER_MAX_ATTEMPTS) {
          console.warn(`[CryptoObserver] Exited with code ${code} — gave up after ${OBSERVER_MAX_ATTEMPTS} restarts; training data gap from this point`);
          return;
        }
        const delayMs = Math.min(60000, 2000 * 2 ** (observerAttempts - 1));
        console.warn(`[CryptoObserver] Exited with code ${code} — restarting in ${Math.round(delayMs / 1000)}s (attempt ${observerAttempts}/${OBSERVER_MAX_ATTEMPTS})`);
        setTimeout(startCryptoObserver, delayMs).unref();
      });
      deps.cryptoObserver = {
        pid: child.pid,
        startedAt: new Date().toISOString(),
        process: child,
      };
    };
    startCryptoObserver();
    console.log("[CryptoObserver] Started — logging to logs/crypto-observer.log");
  } else if (enableCryptoObserver) {
    console.warn(`[CryptoObserver] Script not found: ${cryptoObserverScript}`);
  } else {
    console.log("[CryptoObserver] Disabled (opt-in: set KALSHI_CRYPTO_OBSERVER=1 with Kalshi creds to collect paper data)");
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

  // PR Watcher is opt-in to a SINGLE designated fleet host. Running it on multiple
  // accounts multiplies auto-review comments (each comment also re-triggers the
  // others). Enable PR_WATCHER_ENABLED=1 on exactly ONE machine.
  if (process.env.PR_WATCHER_ENABLED === "1") {
    prWatcher.start();
    console.log(`[PR Watcher] auto-merge ${process.env.PR_WATCHER_AUTOMERGE === "1" ? "ENABLED" : "off (set PR_WATCHER_AUTOMERGE=1 to land ready PRs)"}`);
  } else {
    console.log("[PR Watcher] disabled — set PR_WATCHER_ENABLED=1 on ONE fleet host to enable");
  }
  Promise.resolve(refreshAllPcsf(repoRoot)).catch((e) => console.error("[PCSF] refresh failed:", e.message));

  // ── CSF Research Tesseract — auto-pack on startup ──────────────────────────
  // Runs in background; skips if archive is less than 24 hours old.
  (() => {
    const { execFile } = require("child_process");
    const fs = require("fs");
    const path = require("path");
    const manifest = path.join(dataRoot(), "tesseract", "manifest.json");
    const script   = path.join(repoRoot, "scripts", "csf_research_tesseract.py");
    let stale = true;
    try {
      const m = fs.statSync(manifest);
      stale = Date.now() - m.mtimeMs > 24 * 60 * 60 * 1000;
    } catch { /* doesn't exist yet */ }
    if (!stale) { console.log("[Tesseract] Archive fresh — skipping auto-pack"); return; }
    console.log("[Tesseract] Packing research archive in background…");
    execFile("python", [script, "pack"], { cwd: repoRoot, timeout: 300_000 }, (err, stdout) => {
      if (err) { console.error("[Tesseract] Pack failed:", err.message); return; }
      const last = stdout.trim().split("\n").pop();
      console.log("[Tesseract]", last);
    });
  })();
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
