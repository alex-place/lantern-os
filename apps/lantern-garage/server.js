const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const publicRoot = path.join(__dirname, "public");
const port = Number(process.env.LANTERN_GARAGE_PORT || process.env.PORT || 4177);
const host = process.env.LANTERN_GARAGE_HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const conversationLogPath = path.join(repoRoot, "data", "conversations", "garage-conversations.jsonl");
const flatRagHousePath = path.join(repoRoot, "data", "rag-house", "flat-rag-house-latest.json");
const flatRagHouseManifestPath = path.join(repoRoot, "manifests", "FLAT-RAG-HOUSE-LATEST.md");
const mcpSourcesPath = path.join(repoRoot, "manifests", "lantern-mcp-sources.json");
const mcpCatalogPath = path.join(repoRoot, "manifests", "validation", "MCP-CONNECTOR-LATEST.json");
const orchestratorDependencyPath = path.join(repoRoot, "manifests", "orchestrator-dependency.json");
const orchestratorDependencyValidationPath = path.join(repoRoot, "manifests", "validation", "LANTERN-ORCHESTRATOR-DEPENDENCY-LATEST.json");
const orchestratorQueueDir = path.join("C:\\Users\\alexp\\Documents\\gm-agent-orchestrator", "tasks", "queue");
const operatorNotesPath = path.join(repoRoot, "data", "operator-notes", "notes.jsonl");
const agentDispatchStatePath = path.join(repoRoot, "data", "operator-notes", "agent-dispatch-state.json");
const cloudMirrorsPath = path.join(repoRoot, "manifests", "cloud-mirrors.json");
const maxConversationTextLength = 4000;
const localChatTagsTimeoutMs = Number(process.env.LANTERN_CHAT_TAGS_TIMEOUT_MS || 1000);
const localChatTimeoutMs = Number(process.env.LANTERN_CHAT_TIMEOUT_MS || 20000);
const mcpReadOnlyTimeoutMs = Number(process.env.LANTERN_MCP_READ_TIMEOUT_MS || 15000);
const agentDispatchSlots = ["gemini-flash", "gemini-main", "codex-main", "gpt-web"];
const agentDispatchCooldownMs = 300000;
const agentDispatchDelayMs = 1500;
const writeQueues = new Map();
let activeAgentDispatch = null;

function enqueueFileWrite(filePath, operation) {
  const previous = writeQueues.get(filePath) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(operation)
    .finally(() => {
      if (writeQueues.get(filePath) === next) {
        writeQueues.delete(filePath);
      }
    });
  writeQueues.set(filePath, next);
  return next;
}

async function appendJsonlQueued(filePath, record) {
  const line = `${JSON.stringify(record)}\n`;
  return enqueueFileWrite(filePath, async () => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.appendFile(filePath, line, "utf8");
  });
}

async function writeTextQueued(filePath, text) {
  return enqueueFileWrite(filePath, async () => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, text, "utf8");
  });
}

function readText(relativePath, fallback = "") {
  try {
    return fs.readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/^\uFEFF/, "");
  } catch {
    return fallback;
  }
}

function readJson(relativePath, fallback = null) {
  try {
    return JSON.parse(readText(relativePath));
  } catch {
    return fallback;
  }
}

function getDefaultMcpSources() {
  return {
    sources: [
      {
        id: "gm-agent-orchestrator-local",
        label: "GM Agent Orchestrator Local",
        baseUrl: "http://127.0.0.1:8787",
        transport: "http_jsonrpc",
        enabled: true,
        localOnly: true,
        allowRemote: false,
        allowToolExecution: false,
        agentAgnostic: true,
        tokenAgnostic: true,
        discovery: { healthPath: "/health", rpcPath: "/mcp" },
        ioProfile: {
          inputMode: "jsonrpc_tools",
          outputMode: "content_blocks",
          tokenPolicy: "externalized",
          agentPolicy: "externalized",
        },
        notes: "Fallback local MCP source.",
      },
    ],
  };
}

function readMcpSourceConfig() {
  const config = readJson(path.relative(repoRoot, mcpSourcesPath), null) || getDefaultMcpSources();
  const sources = Array.isArray(config.sources) && config.sources.length > 0
    ? config.sources
    : getDefaultMcpSources().sources;
  return { ...config, sources };
}

function getPrimaryMcpSource() {
  const sources = readMcpSourceConfig().sources;
  return sources.find((source) => source && source.enabled !== false)
    || getDefaultMcpSources().sources[0];
}

function getPrimaryMcpRpcUrl() {
  const source = getPrimaryMcpSource();
  const baseUrl = String(source.baseUrl || "http://127.0.0.1:8787").replace(/\/+$/, "");
  const rpcPath = String(source.discovery?.rpcPath || "/mcp");
  return `${baseUrl}${rpcPath.startsWith("/") ? rpcPath : `/${rpcPath}`}`;
}

function getMcpCatalog() {
  const catalog = readJson(path.relative(repoRoot, mcpCatalogPath), null);
  if (catalog) return catalog;
  const sourceConfig = readMcpSourceConfig();
  return {
    generatedAt: null,
    status: "unverified",
    boundaryStatus: "hold",
    primarySourceId: getPrimaryMcpSource().id,
    summary: {
      sourceCount: sourceConfig.sources.length,
      readySourceCount: 0,
      readyWithToolsCount: 0,
      heldSourceCount: sourceConfig.sources.length,
      totalToolCount: 0,
      tokenAgnosticSources: sourceConfig.sources.filter((source) => source?.tokenAgnostic !== false).length,
      agentAgnosticSources: sourceConfig.sources.filter((source) => source?.agentAgnostic !== false).length,
    },
    sources: sourceConfig.sources,
    normalizedToolCatalog: [],
  };
}

function summarizeMcpCatalog(catalog) {
  const summary = catalog?.summary || {};
  return {
    status: catalog?.status || "unverified",
    primarySourceId: catalog?.primarySourceId || getPrimaryMcpSource().id,
    sourceCount: summary.sourceCount ?? (Array.isArray(catalog?.sources) ? catalog.sources.length : 0),
    readySourceCount: summary.readySourceCount ?? 0,
    toolCount: summary.totalToolCount ?? (Array.isArray(catalog?.normalizedToolCatalog) ? catalog.normalizedToolCatalog.length : 0),
  };
}

function getOrchestratorDependencyStatus() {
  const manifest = readJson(path.relative(repoRoot, orchestratorDependencyPath), {});
  const validation = readJson(path.relative(repoRoot, orchestratorDependencyValidationPath), null);
  const fleet = validation?.fleet || {};
  const mcp = validation?.mcp || {};
  return {
    dependencyId: manifest.dependencyId || "gm-agent-orchestrator-local",
    label: manifest.label || "GM Agent Orchestrator",
    repoPath: manifest.repoPath || "C:\\Users\\alexp\\Documents\\gm-agent-orchestrator",
    healthUrl: manifest.mcp?.healthUrl || "http://127.0.0.1:8787/health",
    rpcUrl: manifest.mcp?.rpcUrl || "http://127.0.0.1:8787/mcp",
    status: fleet.status || "unvalidated",
    healthOk: mcp.healthOk === true,
    toolCount: mcp.toolCount ?? null,
    missingReadTools: Array.isArray(mcp.missingReadTools) ? mcp.missingReadTools : [],
    targetLanternSlots: Array.isArray(manifest.targetLanternSlots) ? manifest.targetLanternSlots : [],
    availableAgentCount: fleet.availableAgentCount ?? null,
    activeAgentCount: fleet.activeAgentCount ?? null,
    staleAgentCount: fleet.staleAgentCount ?? null,
    queueCount: fleet.queue ?? null,
    failedCount: fleet.failed ?? null,
    canUseReadTools: validation?.boundary?.canUseReadTools === true,
    canDispatchAgents: validation?.boundary?.canDispatchAgents === true,
    nextHumanAction: fleet.nextHumanAction || manifest.lanternPolicy?.nextSafePath || "Run scripts/Test-LanternOrchestratorDependency.ps1.",
    validationPath: validation ? path.relative(repoRoot, orchestratorDependencyValidationPath) : null,
  };
}

function readJsonl(relativePath, limit = 20) {
  return readText(relativePath)
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { parseError: true, raw: line };
      }
    });
}

function readConversationLog(limit = 50) {
  return readJsonl(path.relative(repoRoot, conversationLogPath), limit)
    .filter((entry) => !entry.parseError);
}

function collectRequestBody(req, maxBytes = 64000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        reject(new Error("request_body_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function normalizeConversationEntry(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("json_object_required");
  }

  const role = String(input.role || "operator").trim().toLowerCase();
  const allowedRoles = new Set(["operator", "lantern", "system", "note"]);
  const text = String(input.text || "").trim();
  const surface = String(input.surface || "garage").trim().slice(0, 80) || "garage";

  if (!allowedRoles.has(role)) {
    throw new Error("invalid_conversation_role");
  }
  if (!text) {
    throw new Error("conversation_text_required");
  }

  return {
    recordedAt: new Date().toISOString(),
    surface,
    role,
    text: text.slice(0, maxConversationTextLength),
  };
}

async function appendConversationEntry(entry) {
  await appendJsonlQueued(conversationLogPath, entry);
}

async function appendExternalRagItem(input) {
  const record = normalizeRagCacheItem(input);
  const cachePath = path.join(repoRoot, "data", "rag-intake", "external-llm-web-cache", "cache.jsonl");
  await appendJsonlQueued(cachePath, record);
  return record;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    if (!response.ok) {
      throw new Error(body?.error || body?.raw || `HTTP ${response.status}`);
    }
    if (body?.error) {
      throw new Error(body.error.message || body.error.code || "mcp_json_rpc_error");
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function callMcpTool(name, args = {}, timeoutMs = 8000) {
  return fetchJsonWithTimeout(getPrimaryMcpRpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  }, timeoutMs);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readAgentDispatchState() {
  try {
    return JSON.parse(fs.readFileSync(agentDispatchStatePath, "utf8"));
  } catch {
    return { lastDispatchAt: 0, running: false, results: [] };
  }
}

async function writeAgentDispatchState(state) {
  await writeTextQueued(agentDispatchStatePath, `${JSON.stringify(state, null, 2)}\n`);
}

function parseMcpToolContent(data) {
  const text = data?.result?.content?.find((item) => item.type === "text")?.text
    || data?.result?.content?.[0]?.text
    || "";
  if (!text) return data;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function getFleetSnapshot() {
  try {
    const data = await callMcpTool("get_agent_status", {}, mcpReadOnlyTimeoutMs);
    const parsed = parseMcpToolContent(data);
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      counts: parsed.counts || {},
      raw: parsed,
    };
  } catch (error) {
    return {
      ok: false,
      generatedAt: new Date().toISOString(),
      agents: [],
      counts: {},
      error: error.message,
    };
  }
}

function summarizeDispatchFleet(fleet) {
  const agents = Array.isArray(fleet.agents) ? fleet.agents : [];
  const availability = fleet.raw?.availability || {};
  const parsedAvailableCount = Number(availability.availableCount);
  const availableCount = Number.isFinite(parsedAvailableCount)
    ? parsedAvailableCount
    : agents.filter((agent) => agent.available === true && !agent.currentTask).length;
  const dispatchableSlots = agents
    .filter((agent) => agentDispatchSlots.includes(agent.slot))
    .filter((agent) => agent.available === true && !agent.currentTask)
    .map((agent) => agent.slot);
  const nextHumanAction = availability.nextHumanAction
    || fleet.raw?.nextAction?.action
    || fleet.raw?.headline
    || fleet.error
    || "Refresh MCP fleet status after clearing stale slots, failed tasks, or dirty worktrees.";
  return { availableCount, dispatchableSlots, nextHumanAction };
}

async function runAgentDispatchBatch(startedAt, slots = agentDispatchSlots) {
  const results = [];
  for (const slot of slots) {
    try {
      const data = await callMcpTool("start_agent", { slot }, 12000);
      const parsed = parseMcpToolContent(data);
      results.push({ slot, ok: parsed.ok === true, result: parsed });
    } catch (error) {
      results.push({ slot, ok: false, error: error.message });
    }
    await writeAgentDispatchState({
      lastDispatchAt: startedAt,
      running: true,
      updatedAt: new Date().toISOString(),
      results,
    });
    if (slot !== slots[slots.length - 1]) {
      await sleep(agentDispatchDelayMs);
    }
  }
  const state = {
    lastDispatchAt: startedAt,
    running: false,
    updatedAt: new Date().toISOString(),
    code: results.every((item) => item.ok) ? 0 : 1,
    results,
  };
  await writeAgentDispatchState(state);
  return state;
}

async function dispatchAllAgents() {
  const now = Date.now();
  const state = readAgentDispatchState();
  const staleRunning = state.running === true && now - Number(state.lastDispatchAt || 0) > 300000;
  if (activeAgentDispatch || (state.running === true && !staleRunning)) {
    return {
      code: 2,
      active: true,
      retryAfterMs: 10000,
      message: "Agent dispatch is already running. Refresh Fleet in a few seconds.",
      results: state.results || [],
    };
  }
  const lastDispatchAt = staleRunning ? 0 : Number(state.lastDispatchAt || 0);
  const retryAfterMs = Math.max(0, agentDispatchCooldownMs - (now - lastDispatchAt));
  if (retryAfterMs > 0) {
    return {
      code: 2,
      rateLimited: true,
      retryAfterMs,
      message: `Dispatch is rate-limited. Try again in ${Math.ceil(retryAfterMs / 1000)} seconds.`,
      results: [],
    };
  }
  const fleet = await getFleetSnapshot();
  const dispatchSummary = summarizeDispatchFleet(fleet);
  if (!fleet.ok || dispatchSummary.dispatchableSlots.length === 0) {
    await writeAgentDispatchState({
      lastDispatchAt: lastDispatchAt || 0,
      running: false,
      updatedAt: new Date().toISOString(),
      held: true,
      results: [],
      fleetCounts: fleet.counts || {},
      nextHumanAction: dispatchSummary.nextHumanAction,
    });
    return {
      code: 3,
      held: true,
      canDispatch: false,
      message: "Dispatch held: no safe agent slots available.",
      mcpOk: fleet.ok,
      availableCount: dispatchSummary.availableCount,
      nextHumanAction: dispatchSummary.nextHumanAction,
      counts: fleet.counts || {},
      agents: (fleet.agents || []).map((agent) => ({
        slot: agent.slot,
        available: agent.available === true,
        currentTask: agent.currentTask || null,
        reason: agent.reason || null,
      })),
      results: [],
    };
  }
  const dispatchableSlots = dispatchSummary.dispatchableSlots;
  await writeAgentDispatchState({
    lastDispatchAt: now,
    running: true,
    updatedAt: new Date().toISOString(),
    results: [],
    slots: dispatchableSlots,
  });
  activeAgentDispatch = runAgentDispatchBatch(now, dispatchableSlots).finally(() => {
    activeAgentDispatch = null;
  });
  return {
    code: 0,
    accepted: true,
    message: "Agent dispatch started as a rate-limited background batch.",
    rateLimited: false,
    cooldownMs: agentDispatchCooldownMs,
    delayMs: agentDispatchDelayMs,
    slots: dispatchableSlots,
    results: [],
  };
}

async function getHffSensorStatus() {
  return {
    ok: false,
    status: "aws_endpoint_pending",
    dataSource: "local-held",
    liveSensorsEnabled: false,
    verifiedNodes: 0,
    securityNodes: 0,
    minConsensusNodes: 0,
    error: "HFF Render polling was retired from Lantern dashboard truth. Add an AWS/HFF endpoint only after /api/status is verified live.",
  };
}

function buildDashboardReply(message, provider = "local-rag") {
  const lower = message.toLowerCase();
  if (lower.includes("mine") || lower.includes("mining") || lower.includes("monero") || lower.includes("btc") || lower.includes("rock and stone")) {
    return "Rock and stone, safely. CPU goes to the Monero learning lane, GPU stays experimental for RVN or ETC, and BTC belongs only on owned SHA-256 ASIC hardware or a clearly labeled lottery path. Next useful step: run hardware intake, set power cost, then compare net/day before any miner starts. No wallet cracking, no hidden signing, no fake one-shot ROI.";
  }
  if (lower.includes("dispatch") || lower.includes("fleet") || lower.includes("agent")) {
    return "Fleet work now routes through the Lantern server instead of browser-to-MCP calls. Refresh Fleet checks the local orchestrator, and Dispatch Agents asks the local MCP service to start the known slots. If MCP is offline, the button should report that honestly instead of pretending it worked.";
  }
  if (lower.includes("refresh") || lower.includes("works")) {
    return "Refresh pulls the current wallet, readiness, RAG, mining lab, cloud mirror, queue, fleet, and HFF sensor status. It is a read-only status pull; the higher-impact actions are separated into their own buttons.";
  }
  if (lower.includes("sync") || lower.includes("evidence") || lower.includes("ingest") || lower.includes("repo") || lower.includes("rag")) {
    return "Sync Evidence rebuilds the flat RAG house from the configured local source repos. It should answer who/what by listing sources and records, not by dropping you into raw notes.";
  }
  if (lower.includes("sensor") || lower.includes("hff")) {
    return "HFF needs real installed polling nodes to earn live confidence. This dashboard now reports AWS endpoint pending, verified node count, consensus target, and whether the data source is live or locally held.";
  }
  if (lower.includes("mic") || lower.includes("voice")) {
    return "Mic input is a browser feature: tap the mic button by the composer, speak, review the text, then send. If the browser blocks speech recognition, Lantern will say so in the action log.";
  }
  if (lower.includes("operator") || lower.includes("tony")) {
    return "Tony is operator material here: short action labels, formatted reader pages, and evidence panels first. The dashboard should make the next move obvious without requiring someone to decode internal project names.";
  }
  return `I am on the ${provider} path. I can help with the dashboard, mining lane choices, repo evidence, wallet receipts, cloud mirrors, or local fleet controls. Ask in plain language and I will route it to the safest visible lane.`;
}

function wantsMcpChatReply(message) {
  const lower = message.toLowerCase();
  return (
    lower.includes("mcp") ||
    lower.includes("tool") ||
    lower.includes("tools") ||
    lower.includes("fleet") ||
    lower.includes("agent") ||
    lower.includes("queue") ||
    lower.includes("task") ||
    lower.includes("status")
  );
}

async function tryMcpChatReply(message) {
  if (!wantsMcpChatReply(message)) return null;
  const lower = message.toLowerCase();
  const chunks = [];
  const wantsQueue = lower.includes("queue") || lower.includes("task");
  const wantsFleet = lower.includes("fleet") || lower.includes("agent");
  const wantsTools = lower.includes("mcp") || lower.includes("tool") || lower.includes("tools") || lower.includes("status");

  try {
    if (wantsQueue) {
      const summary = parseMcpToolContent(await callMcpTool("get_queue_summary", {}, mcpReadOnlyTimeoutMs));
      const counts = summary.counts || summary;
      chunks.push(`Queue: ${counts.queue ?? "--"} queued, ${counts.active ?? "--"} active, ${counts.failed ?? "--"} failed, ${counts.done ?? "--"} done.`);
    }

    if (wantsFleet) {
      const fleet = parseMcpToolContent(await callMcpTool("get_agent_status", {}, mcpReadOnlyTimeoutMs));
      const agents = Array.isArray(fleet.agents) ? fleet.agents : [];
      const active = agents.filter((agent) => agent.currentTask).length;
      const available = agents.filter((agent) => agent.available).length;
      chunks.push(`Fleet: ${available}/${agents.length} slots available, ${active} active.`);
    }

    if (wantsTools || chunks.length === 0) {
      const features = parseMcpToolContent(await callMcpTool("get_mcp_feature_overview", {}, mcpReadOnlyTimeoutMs));
      const tools = Array.isArray(features.availableTools) ? features.availableTools : [];
      const gaps = Array.isArray(features.missingOpsGaps) ? features.missingOpsGaps : [];
      chunks.push(`MCP (Model Context Protocol, not Multi-Chain Protocol): ${tools.length} live tools exposed on ${features.server?.mcpUrl || getPrimaryMcpRpcUrl()}. Gaps held: ${gaps.slice(0, 4).join(", ") || "none listed"}.`);
    }
  } catch (error) {
    return {
      provider: "mcp-read-only-error",
      reply: `MCP connection attempted but did not return cleanly: ${error.message}. The dashboard will keep the message local and you can retry after checking 127.0.0.1:8787/health.`,
    };
  }

  return {
    provider: "mcp-read-only",
    reply: `${chunks.join(" ")} Read-only chat path only: no agent start, queue move, repo sync, or shell action was run.`,
  };
}

async function tryLocalModelReply(message) {
  const tags = await fetchJsonWithTimeout("http://127.0.0.1:11434/api/tags", {}, localChatTagsTimeoutMs);
  const model = process.env.LANTERN_CHAT_MODEL || tags?.models?.[0]?.name;
  if (!model) return null;
  const data = await fetchJsonWithTimeout("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: "system",
          content: "You are Lantern OS inside a local-first operator dashboard. Be concise, practical, truthful, and do not promise hidden wallet actions, brute force, or fake ROI.",
        },
        { role: "user", content: message },
      ],
    }),
  }, localChatTimeoutMs);
  const reply = String(data?.message?.content || data?.response || "").trim();
  return reply ? { reply, provider: `ollama:${model}` } : null;
}

async function handleChatMessage(input) {
  const message = String(input.message || input.text || "").trim().slice(0, maxConversationTextLength);
  if (!message) throw new Error("message_required");
  const operatorEntry = normalizeConversationEntry({ surface: "lantern-garage", role: "operator", text: message });
  await appendConversationEntry(operatorEntry);

  let provider = "local-rag";
  let reply = "";
  const command = normalizeLanternCommand(message);
  if (command) {
    const commandResult = await runLanternCommand(command);
    provider = "lantern-command-entrypoint";
    reply = renderCommandReply(commandResult);
  } else {
    const mcpReply = await tryMcpChatReply(message);
    if (mcpReply) {
      provider = mcpReply.provider;
      reply = mcpReply.reply;
    }
  }
  if (!reply) {
    try {
      const localModel = await tryLocalModelReply(message);
      if (localModel) {
        provider = localModel.provider;
        reply = localModel.reply;
      }
    } catch {
      provider = "local-rag";
    }
  }
  if (!reply) {
    reply = buildDashboardReply(message, provider);
  }

  const lanternEntry = normalizeConversationEntry({ surface: "lantern-garage", role: "lantern", text: reply });
  await appendConversationEntry(lanternEntry);
  return { ok: true, provider, reply, entries: [operatorEntry, lanternEntry] };
}

function normalizeRagCacheItem(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("json_object_required");
  }
  const text = (value, fallback, maxLength) => String(value || fallback).trim().slice(0, maxLength);
  const allowedSourceTypes = new Set(["official_source", "web_secondary", "external_llm", "operator_asserted"]);
  const allowedDecisions = new Set(["promote", "candidate", "hold", "reject"]);
  const sourceType = text(input.sourceType, "operator_asserted", 80);
  const decision = text(input.decision, "candidate", 40);
  const confidence = Math.max(0, Math.min(1, Number(input.confidence ?? 0.5)));
  const claim = text(input.claim, "", 500);
  const compressedSummary = text(input.compressedSummary, claim, 1200);
  if (!claim) {
    throw new Error("rag_claim_required");
  }
  return {
    timestamp: new Date().toISOString(),
    topic: text(input.topic, "operator form intake", 160),
    claim,
    sourceUrl: text(input.sourceUrl, "", 500),
    sourceTitle: text(input.sourceTitle, "Lantern OS form intake", 220),
    sourceType: allowedSourceTypes.has(sourceType) ? sourceType : "operator_asserted",
    rightsState: "summary_only",
    evidenceClass: "operator_asserted",
    confidence,
    decision: allowedDecisions.has(decision) ? decision : "candidate",
    compressedSummary,
  };
}

function readOperatorQueue() {
  const items = [];
  // Read orchestrator queue tasks
  try {
    if (fs.existsSync(orchestratorQueueDir)) {
      const files = fs.readdirSync(orchestratorQueueDir).filter(f => f.endsWith(".md"));
      for (const file of files) {
        const content = fs.readFileSync(path.join(orchestratorQueueDir, file), "utf8").replace(/^﻿/, "");
        const title = /^#\s+(.+)/m.exec(content)?.[1] || file.replace(/\.md$/, "").replace(/-/g, " ");
        const priority = /priority:\s*(P\d)/i.exec(content)?.[1] || "P1";
        const owner = /owner:\s*(\S+)/i.exec(content)?.[1] || "unassigned";
        const blocked = /blocked.?by:\s*(.+)/i.exec(content)?.[1]?.trim() || null;
        items.push({ type: "task", file, title, priority, owner, blocked, source: "orchestrator" });
      }
    }
  } catch { /* orchestrator dir may not exist */ }
  // Read local operator notes
  const notes = readJsonl(path.relative(repoRoot, operatorNotesPath), 50).filter(n => !n.parseError);
  for (const note of notes) {
    items.push({ type: "note", title: note.text, priority: note.priority || "P2", owner: "operator", source: "local", createdAt: note.createdAt });
  }
  // Sort: P0 first, then P1, then P2, notes and tasks interleaved by priority
  items.sort((a, b) => {
    const pa = parseInt(a.priority?.replace("P", "") ?? "9");
    const pb = parseInt(b.priority?.replace("P", "") ?? "9");
    return pa - pb;
  });
  return items;
}

function repoSources() {
  return [
    {
      name: "lantern-os",
      path: repoRoot,
      role: "control plane, RAG house, Garage app, release surface",
      archiveDecision: "keep_canonical",
    },
    {
      name: "human-flourishing-frameworks",
      path: "C:\\tmp\\human-flourishing-frameworks-scan",
      role: "HFF scan, COMET LEAP docs and PDFs, prior convergence evidence",
      archiveDecision: "source_evidence_only",
    },
    {
      name: "gm-agent-orchestrator",
      path: "C:\\Users\\alexp\\Documents\\gm-agent-orchestrator",
      role: "local MCP/orchestrator, agents, queue, service supervision",
      archiveDecision: "source_evidence_only",
    },
    {
      name: "ChildOfLevistus",
      path: "C:\\Users\\alexp\\Documents\\Codex\\2026-04-23-what-are-you-able-to-do\\ChildOfLevistus",
      role: "GameMaker game source and GM validation lane",
      archiveDecision: "source_evidence_only",
    },
  ];
}

function runGit(repoPath, args) {
  if (!fs.existsSync(repoPath)) {
    return { ok: false, output: "", error: "path_missing" };
  }
  const result = spawnSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    output: (result.stdout || "").trim(),
    error: (result.stderr || "").trim(),
  };
}

function inspectSourceRepo(source) {
  const branch = runGit(source.path, ["branch", "--show-current"]);
  const remote = runGit(source.path, ["remote", "get-url", "origin"]);
  const head = runGit(source.path, ["rev-parse", "--short=12", "HEAD"]);
  const status = runGit(source.path, ["status", "--short"]);
  const files = fs.existsSync(source.path)
    ? fs.readdirSync(source.path).slice(0, 24)
    : [];

  return {
    ...source,
    exists: fs.existsSync(source.path),
    branch: branch.output || "unknown",
    remote: remote.output || "",
    head: head.output || "",
    dirty: Boolean(status.output),
    statusShort: status.output,
    topLevelFiles: files,
  };
}

function buildFlatRagHouse() {
  const sources = repoSources().map(inspectSourceRepo);
  const ragRecords = readJsonl("data/rag-intake/external-llm-web-cache/cache.jsonl", 200)
    .filter((entry) => !entry.parseError);
  const conversations = readConversationLog(20);
  return {
    generatedAt: new Date().toISOString(),
    purpose: "One flat RAG house over Lantern OS, HFF, orchestrator, and GM source repos.",
    boundary: "Read-only source ingestion. Old repos are archived by manifest status, not deleted.",
    sources,
    ragRecordCount: ragRecords.length,
    recentRagRecords: ragRecords.slice(-20),
    recentConversations: conversations,
    windowsSurface: {
      host: "Windows remains host until dual-boot install gates pass.",
      garageUrl: `http://127.0.0.1:${port}`,
      defaultBootMutation: "blocked",
    },
  };
}

async function writeFlatRagHouse() {
  const house = buildFlatRagHouse();
  await Promise.all([
    writeTextQueued(flatRagHousePath, `${JSON.stringify(house, null, 2)}\n`),
    writeTextQueued(flatRagHouseManifestPath, renderFlatRagHouseManifest(house)),
  ]);
  return house;
}

function renderFlatRagHouseManifest(house) {
  const rows = house.sources.map((source) => (
    `| ${source.name} | ${source.branch} | ${source.dirty ? "dirty" : "clean"} | ${source.archiveDecision} | ${source.role} |`
  )).join("\n");
  return `# Flat RAG House Latest

Generated: ${house.generatedAt}

Status: local read-only merge surface.

Boundary: ${house.boundary}

## Sources

| Source | Branch | State | Archive Decision | Role |
|---|---|---|---|---|
${rows}

## Counts

- RAG records: ${house.ragRecordCount}
- Recent local conversations: ${house.recentConversations.length}

## Launch

Lantern OS Garage: ${house.windowsSurface.garageUrl}

Default boot mutation: ${house.windowsSurface.defaultBootMutation}
`;
}

function runPowerShell(scriptRelativePath, args = []) {
  return new Promise((resolve) => {
    const scriptPath = path.join(repoRoot, scriptRelativePath);
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...args,
    ], { cwd: repoRoot });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const commandSpecs = {
  "!one": {
    label: "One IDE read-only status",
    script: "scripts/Get-OneIdeStatus.ps1",
    args: [],
    mode: "read_only_preflight",
  },
  "!converge": {
    label: "Lantern convergence loop",
    script: "scripts/Invoke-LanternConvergenceLoop.ps1",
    args: [],
    mode: "local_convergence",
  },
  "!superjarvis": {
    label: "Super Jarvis one-pass diagnostic",
    script: "scripts/Invoke-SuperJarvisPerfectLoop.ps1",
    args: ["-Passes", "1"],
    mode: "local_diagnostic",
  },
  "!near20": {
    label: "Kalshi near-term paper block",
    script: "scripts/New-KalshiNearTermPaperBlock.ps1",
    args: ["-WindowMinutes", "20", "-BudgetUsd", "50", "-MaxOrders", "10"],
    mode: "paper_trade_no_live_execution",
  },
};

function normalizeLanternCommand(value) {
  const token = String(value || "").trim().split(/\s+/)[0].toLowerCase();
  return commandSpecs[token] ? token : "";
}

function listLanternCommands() {
  return Object.entries(commandSpecs).map(([command, spec]) => ({
    command,
    label: spec.label,
    mode: spec.mode,
    script: spec.script,
  }));
}

function renderCommandReply(result) {
  const state = result.code === 0 ? "completed" : "returned warnings";
  const output = String(result.stdout || result.stderr || "").trim();
  const tail = output.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ");
  return `${result.command} ${state} through /api/command (${result.label}). ${tail || "No output returned."}`;
}

async function runLanternCommand(rawCommand) {
  const command = normalizeLanternCommand(rawCommand);
  if (!command) {
    return {
      ok: false,
      code: 64,
      error: "unknown_lantern_command",
      commands: listLanternCommands(),
    };
  }
  const spec = commandSpecs[command];
  const result = await runPowerShell(spec.script, spec.args);
  return {
    ok: result.code === 0,
    entrypoint: "/api/command",
    command,
    label: spec.label,
    mode: spec.mode,
    script: spec.script,
    args: spec.args,
    ...result,
  };
}

function getStatus() {
  const arc = readJson("data/arc-reactor/status.json", {});
  const wallet = readJson("data/wallet/local-cash-wallet.json", {});
  const controls = readJson("manifests/validation/LOCAL-CONTROLS-LATEST.json", {});
  const mcpCatalog = getMcpCatalog();
  const mcpCatalogSummary = summarizeMcpCatalog(mcpCatalog);
  const readiness = getReadiness();
  const v1 = readText("reports/V1-READINESS-TEST-2026-05-26.md");

  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    app: "Lantern Garage",
    arc,
    wallet: {
      clearedCashUsd: wallet.clearedCashUsd ?? 0,
      pendingInvoiceUsd: wallet.pendingInvoiceUsd ?? 0,
      draftInvoiceUsd: wallet.draftInvoiceUsd ?? 0,
      pendingInvoices: wallet.pendingInvoices ?? [],
    },
    controls: {
      garageExists: controls.garageExists === true,
      accessXExists: controls.accessXExists === true,
      dashboardOk: controls.dashboard?.ok === true,
      mcpOk: controls.mcp?.ok === true,
      lanternOk: controls.lantern?.ok === true,
    },
    mcpCatalog: mcpCatalogSummary,
    orchestratorDependency: getOrchestratorDependencyStatus(),
    readiness: {
      readyForPrep: readiness.readyForPrep === true,
      readyForInstall: readiness.readyForInstall === true,
      pass: readiness.pass ?? null,
      warn: readiness.warn ?? null,
      fail: readiness.fail ?? null,
      held: readiness.held ?? null,
      summary: readiness.summary ?? "",
    },
    v1: {
      status: /Status:\s*`([^`]+)`/.exec(v1)?.[1] || "unknown",
      confidence: /Confidence:\s*`([^`]+)`/.exec(v1)?.[1] || "unknown",
    },
  };
}

function getReadiness() {
  return readJson("manifests/validation/DUAL-BOOT-PREP-LATEST.json", null)
    || readJson("data/dual-boot/latest-readiness.json", {})
    || {};
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => (
      `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
    ));
}

function renderMarkdownDocument(markdown, sourcePath) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const body = [];
  let inCode = false;
  let inList = false;
  let inTable = false;
  let tableRows = [];
  let title = path.basename(sourcePath);

  const closeList = () => {
    if (inList) {
      body.push("</ul>");
      inList = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      const rows = tableRows.filter((row) => !/^\s*\|?\s*:?-{3,}:?\s*\|/.test(row));
      body.push("<table>");
      rows.forEach((row, index) => {
        const cells = row.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
        body.push(index === 0 ? "<thead><tr>" : "<tbody><tr>");
        cells.forEach((cell) => body.push(index === 0 ? `<th>${inlineMarkdown(cell)}</th>` : `<td>${inlineMarkdown(cell)}</td>`));
        body.push(index === 0 ? "</tr></thead>" : "</tr></tbody>");
      });
      body.push("</table>");
      tableRows = [];
      inTable = false;
    }
  };

  lines.forEach((line) => {
    if (/^```/.test(line.trim())) {
      closeList();
      closeTable();
      body.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      return;
    }
    if (inCode) {
      body.push(`${escapeHtml(line)}\n`);
      return;
    }
    if (/^\s*\|.+\|\s*$/.test(line)) {
      closeList();
      inTable = true;
      tableRows.push(line);
      return;
    }
    closeTable();
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      if (level === 1) title = heading[2].trim();
      body.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      return;
    }
    const listItem = /^\s*[-*]\s+(.+)$/.exec(line);
    if (listItem) {
      if (!inList) {
        body.push("<ul>");
        inList = true;
      }
      body.push(`<li>${inlineMarkdown(listItem[1])}</li>`);
      return;
    }
    if (!line.trim()) {
      closeList();
      return;
    }
    closeList();
    body.push(`<p>${inlineMarkdown(line)}</p>`);
  });
  closeList();
  closeTable();
  if (inCode) body.push("</code></pre>");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - Lantern OS</title>
  <style>
    :root { color-scheme: light; --ink:#11191f; --muted:#596874; --paper:#eef4ef; --line:#bdc9c9; --arc:#08756f; --blue:#1e5f89; }
    * { box-sizing: border-box; }
    body { margin:0; color:var(--ink); background:var(--paper); font-family:"Segoe UI", Arial, sans-serif; }
    main { width:min(980px, calc(100% - 28px)); margin:0 auto; padding:24px 0 48px; }
    header { display:flex; align-items:center; justify-content:space-between; gap:16px; border-bottom:1px solid var(--line); padding-bottom:14px; margin-bottom:22px; }
    .source { color:var(--muted); font-size:0.86rem; overflow-wrap:anywhere; }
    a { color:var(--blue); font-weight:800; }
    .back { border:1px solid var(--line); padding:10px 12px; background:white; text-decoration:none; white-space:nowrap; }
    h1 { font-size:2.1rem; line-height:1.05; margin:0 0 10px; letter-spacing:0; }
    h2 { margin-top:28px; border-top:1px solid var(--line); padding-top:18px; }
    p, li { line-height:1.58; }
    code { background:white; border:1px solid var(--line); padding:1px 5px; }
    pre { background:#11191f; color:white; overflow:auto; padding:14px; }
    table { width:100%; border-collapse:collapse; background:white; margin:18px 0; }
    th, td { border:1px solid var(--line); padding:9px; vertical-align:top; }
    th { text-align:left; background:#f7faf8; color:var(--muted); text-transform:uppercase; font-size:0.78rem; }
  </style>
</head>
<body>
  <main>
    <header>
      <div><strong>Lantern Reader</strong><div class="source">${escapeHtml(sourcePath)}</div></div>
      <a class="back" href="/">Dashboard</a>
    </header>
    ${body.join("\n")}
  </main>
</body>
</html>`;
}

function getMiningLabStatus() {
  const files = [
    "docs/ARC-REACTOR-MINING-LAB.md",
    "docs/WALLET-MATRIX-TEMPLATE.md",
    "skills/solo-mining/SKILL.md",
    "templates/hardware-intake.csv",
    "templates/wallet-matrix.csv",
    "templates/coin-feasibility.csv",
    "templates/mining-receipt.json",
    "scripts/Get-HardwareInventory.ps1",
    "scripts/Test-MiningProfitability.ps1",
    "reports/ARC-REACTOR-MINING-LAB-2026-05-29.md",
  ];
  const present = files.map((relativePath) => ({
    path: relativePath,
    exists: fs.existsSync(path.join(repoRoot, relativePath)),
  }));
  const ready = present.every((item) => item.exists);
  return {
    ready,
    mode: "manual_first_read_only",
    shortcutRule: "single_lantern_shortcut",
    routeSummary: {
      cpu: "XMR learning lane",
      gpu: "RVN / ETC experiment lane",
      eth: "wallet / claim checks only",
      asic: "BTC / LTC / DOGE / KAS only with owned or justified hardware",
    },
    blocked: [
      "wallet_bruteforce",
      "unauthorized_transfers",
      "hidden_transaction_signing",
      "mining_on_unowned_devices",
      "fake_roi_claims",
      "eth_mainnet_mining_claims",
    ],
    files: present,
  };
}

function parseMirrorEnv() {
  return String(process.env.LANTERN_CLOUD_MIRROR_URLS || "")
    .split(/[,\s]+/)
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url, index) => ({
      name: `env-mirror-${index + 1}`,
      url,
      role: "environment configured mirror",
      status: "configured",
      healthPath: "/api/health",
      source: "LANTERN_CLOUD_MIRROR_URLS",
    }));
}

function getCloudMirrorStatus() {
  const manifest = readJson(path.relative(repoRoot, cloudMirrorsPath), {});
  const manifestMirrors = Array.isArray(manifest.cloudMirrors) ? manifest.cloudMirrors : [];
  const envMirrors = parseMirrorEnv();
  const seen = new Set();
  const cloudMirrors = [...manifestMirrors, ...envMirrors]
    .filter((mirror) => mirror && typeof mirror.url === "string" && mirror.url.startsWith("https://"))
    .filter((mirror) => {
      if (seen.has(mirror.url)) return false;
      seen.add(mirror.url);
      return true;
    })
    .map((mirror) => ({
      name: String(mirror.name || "cloud mirror").slice(0, 80),
      url: mirror.url,
      role: String(mirror.role || "cloud mirror").slice(0, 160),
      status: String(mirror.status || "configured").slice(0, 80),
      healthPath: String(mirror.healthPath || "/api/health").slice(0, 120),
      source: String(mirror.source || "manifests/cloud-mirrors.json").slice(0, 160),
    }));

  return {
    generatedAt: new Date().toISOString(),
    localPrimary: `http://127.0.0.1:${port}`,
    activeHost: host,
    activePort: port,
    deployBranch: manifest.deployBranch || "master",
    deployProvider: manifest.deployProvider || "AWS ECS Fargate",
    mirrorPolicy: manifest.mirrorPolicy || "Local is primary; cloud URLs are mirrors and must not create separate dashboards.",
    cloudMirrorCount: cloudMirrors.length,
    cloudMirrors,
  };
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, responseHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }));
  res.end(body);
}

function responseHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(self)",
    ...extra,
  };
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".pdf": "application/pdf",
  }[ext] || "application/octet-stream";

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, { error: "not_found" }, 404);
      return;
    }
    res.writeHead(200, responseHeaders({
      "Content-Type": type,
    }));
    res.end(data);
  });
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, responseHeaders({
    "Content-Type": "text/html; charset=utf-8",
  }));
  res.end(html);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, responseHeaders({
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    }));
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

  if (url.pathname === "/api/cloud-mirrors") {
    sendJson(res, getCloudMirrorStatus());
    return;
  }

  if (url.pathname === "/api/fleet") {
    sendJson(res, await getFleetSnapshot());
    return;
  }

  if (url.pathname === "/api/mcp-catalog") {
    sendJson(res, getMcpCatalog());
    return;
  }

  if (url.pathname === "/api/orchestrator-dependency") {
    sendJson(res, getOrchestratorDependencyStatus());
    return;
  }

  if (url.pathname === "/api/agent-dispatch-status") {
    sendJson(res, readAgentDispatchState());
    return;
  }

  if (url.pathname === "/api/hff-sensors") {
    sendJson(res, await getHffSensorStatus());
    return;
  }

  if (url.pathname === "/api/command" && req.method === "GET") {
    sendJson(res, {
      entrypoint: "/api/command",
      commands: listLanternCommands(),
    });
    return;
  }

  if (url.pathname === "/api/command" && req.method === "POST") {
    try {
      const body = await collectRequestBody(req);
      const input = JSON.parse(body || "{}");
      const result = await runLanternCommand(input.command || input.message || input.text);
      sendJson(res, result, result.ok ? 200 : 400);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return;
  }

  if (url.pathname === "/api/chat" && req.method === "POST") {
    try {
      const body = await collectRequestBody(req);
      sendJson(res, await handleChatMessage(JSON.parse(body || "{}")), 201);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
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
    const result = await runLanternCommand("!converge");
    sendJson(res, result, result.code === 0 ? 200 : 500);
    return;
  }

  if (url.pathname === "/api/actions/kalshi-near-term-paper-block" && req.method === "POST") {
    const result = await runLanternCommand("!near20");
    let payload = null;
    try {
      payload = readJson("data/kalshi/kalshi-near-term-paper-block-latest.json", null);
    } catch {
      payload = null;
    }
    sendJson(res, {
      ...result,
      receiptPath: "manifests/evidence/kalshi-near-term-paper-block-receipt-2026-05-30.md",
      dataPath: "data/kalshi/kalshi-near-term-paper-block-latest.json",
      paperOrderCount: payload?.paperOrderCount ?? null,
      realMoneyUsd: payload?.realMoneyUsd ?? 0,
      liveTradingStatus: payload?.liveTradingStatus || "blocked",
      paperBlock: payload ? {
        generatedAt: payload.generatedAt,
        windowMinutes: payload.windowMinutes,
        allocatedPaperRiskUsd: payload.budgetPolicy?.allocatedPaperRiskUsd ?? 0,
        remainingDailyPaperRiskUsd: payload.budgetPolicy?.remainingDailyPaperRiskUsd ?? 0,
        orders: (payload.orders || []).slice(0, 10).map((order) => ({
          ticker: order.ticker,
          title: order.title,
          limitCents: order.paperLimitCents,
          maxLossUsd: order.paperMaxLossUsd,
          minutesToKnown: order.minutesToKnown,
          status: order.orderStatus,
        })),
      } : null,
    }, result.code === 0 ? 200 : 500);
    return;
  }

  if (url.pathname === "/api/actions/local-controls" && req.method === "POST") {
    const result = await runPowerShell("scripts/Start-LanternLocalControls.ps1");
    sendJson(res, result, result.code === 0 ? 200 : 500);
    return;
  }

  if (url.pathname === "/api/actions/dispatch-all" && req.method === "POST") {
    const result = await dispatchAllAgents();
    sendJson(res, result, result.code === 0 ? 200 : 207);
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
