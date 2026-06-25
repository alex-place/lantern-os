// PCSF Live Refresh — update data/pcsf/*.pcsf.json from live provider + journal state on server start
const fs = require("fs");
const path = require("path");
const { readMcpResourceSync, readFileViaMcp } = require("./mcp-resource-client");

const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY",
];

function _now() {
  return new Date().toISOString();
}

// Load JSON via MCP resource URI, falling back to fs.readFileSync for backwards compat
function loadJson(p) {
  // Map known paths to MCP URIs
  const basename = path.basename(p);
  const uriMap = {
    "settings.pcsf.json": "pcsf://settings",
    "provider.pcsf.json": "pcsf://provider",
    "health.pcsf.json": "pcsf://health",
    "model.pcsf.json": "pcsf://model",
    "agent.pcsf.json": "pcsf://agent",
    "narrator.pcsf.json": "pcsf://narrator",
  };
  const uri = uriMap[basename];
  if (uri) {
    const remote = readMcpResourceSync(uri, null);
    if (remote) return remote;
  }
  // Direct fs fallback
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function saveJson(p, data) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch (e) {
    console.error("[PCSF] Failed to write", p, e.message);
  }
}

function envPresent(key) {
  if (process.env[key] && process.env[key].trim().length > 0) return true;
  // On Windows, server process may not inherit User-scope env vars set after boot.
  // Fall back to reading from HKCU\Environment (the User-scope env store).
  if (process.platform === "win32") {
    try {
      const { execFileSync } = require("child_process");
      const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", key], { encoding: "utf8", timeout: 3000 });
      const m = out.match(/REG_\w+\s+(.+)/);
      if (m && m[1].trim().length > 0) return true;
    } catch {}
  }
  return false;
}

function refreshSettingsPcsf(repoRoot) {
  const p = path.join(repoRoot, "data", "pcsf", "settings.pcsf.json");
  const data = loadJson(p);
  if (!data) return;
  let changed = false;
  for (const setting of data.settings || []) {
    const present = envPresent(setting.key);
    const newState = present ? "present" : "absent";
    if (setting.state !== newState) {
      setting.state = newState;
      changed = true;
    }
  }
  data.generated_at = _now();
  if (changed) {
    saveJson(p, data);
    console.log("[PCSF] settings.pcsf.json refreshed —", data.settings.filter(s => s.state === "present").length, "present," , data.settings.filter(s => s.state === "absent").length, "absent");
  } else {
    console.log("[PCSF] settings.pcsf.json unchanged");
  }
}

// Known providers + their env keys. Used to bootstrap provider.pcsf.json when it
// is absent (it is git-ignored, so a fresh checkout has no file) and to mark each
// provider available/no_key.
const KNOWN_PROVIDERS = [
  { provider_id: "anthropic", env_key: "ANTHROPIC_API_KEY" },
  { provider_id: "gemini",    env_key: "GEMINI_API_KEY" },
  { provider_id: "openai",    env_key: "OPENAI_API_KEY" },
  { provider_id: "xai",       env_key: "XAI_API_KEY" },
  { provider_id: "mistral",   env_key: "MISTRAL_API_KEY" },
  { provider_id: "cohere",    env_key: "COHERE_API_KEY" },
  { provider_id: "deepseek",  env_key: "DEEPSEEK_API_KEY" },
  { provider_id: "ollama",    env_key: "" },
];

function _envKeyFor(providerId) {
  const k = KNOWN_PROVIDERS.find((x) => x.provider_id === providerId);
  return k ? k.env_key : "";
}

// Compute the live provider ranking per task type from real leaderboard outcomes
// (agent-performance compositeScore), so provider.pcsf.json becomes the persisted,
// inspectable projection of the merit ranking — the source of truth the router reads.
async function _buildRouting() {
  const { rankCandidates } = require("./model-leaderboard");
  const { PROVIDER_CHAINS } = require("./provider-router");
  let CLOUD_PROVIDERS;
  try { CLOUD_PROVIDERS = require("./leaderboard-routing").CLOUD_PROVIDERS; } catch { CLOUD_PROVIDERS = null; }

  // Only rank providers the streaming dispatch (stream-chat buildBrainOrder) can
  // actually execute — ranking a provider it can't run would be silently dropped.
  const EXECUTABLE = new Set(["anthropic", "gemini", "openai", "xai", "ollama"]);

  const byTask = {};
  for (const [taskType, chain] of Object.entries(PROVIDER_CHAINS)) {
    // Rank the chain's executable cloud providers that actually have a key; keep
    // ollama last as the offline backstop (not merit-ranked).
    const cands = chain
      .filter((s) => s.provider !== "ollama" && EXECUTABLE.has(s.provider) && envPresent(_envKeyFor(s.provider)))
      .map((s) => ({ provider: s.provider, model: s.models[0], key: s.provider }));
    let order = [];
    if (cands.length) {
      let ranked = await rankCandidates(cands, taskType, { cloudSet: CLOUD_PROVIDERS });
      // Per-task signal can be empty because outcomes are recorded under the
      // intent taxonomy (dream_chat, technical_debug, …) while the chains use
      // detectTaskType keys (coding, reasoning, …). When nothing is scored for
      // this task type, fall back to the AGGREGATE ("all") ranking so accumulated
      // outcomes still drive order; per-task specialization takes over once that
      // task type has its own scored data.
      if (!ranked.some((c) => c.scored)) {
        ranked = await rankCandidates(cands, "all", { cloudSet: CLOUD_PROVIDERS });
      }
      order = ranked.map((c) => c.provider);
    }
    if (chain.some((s) => s.provider === "ollama")) order.push("ollama");
    byTask[taskType] = order;
  }
  return { source: "leaderboard", generated_at: _now(), by_task_type: byTask };
}

async function refreshProviderPcsf(repoRoot) {
  const p = path.join(repoRoot, "data", "pcsf", "provider.pcsf.json");
  let data = loadJson(p);
  if (!data) data = { schema: "provider.pcsf/2", providers: [] };          // bootstrap (file is git-ignored)
  if (!Array.isArray(data.providers) || !data.providers.length) {
    data.providers = KNOWN_PROVIDERS.map((k) => ({ provider_id: k.provider_id, env_key: k.env_key }));
  }
  for (const prov of data.providers) {
    if (!prov.env_key) { prov.state = "available"; prov.is_routable = false; prov.last_checked = _now(); continue; } // ollama
    const present = envPresent(prov.env_key);
    prov.state = present ? "available" : "no_key";
    prov.is_routable = present && prov.provider_id !== "ollama";
    prov.last_checked = _now();
  }
  // Live, leaderboard-derived ranking — what lib/provider-router.js reads.
  try {
    data.routing = await _buildRouting();
  } catch (e) {
    console.error("[PCSF] routing rank failed (keeping prior/none):", e.message);
  }
  data.generated_at = _now();
  saveJson(p, data);
  const routed = data.routing && data.routing.by_task_type ? Object.keys(data.routing.by_task_type).length : 0;
  console.log("[PCSF] provider.pcsf.json refreshed — providers:", data.providers.length, "routing task-types:", routed);
}

function loadDreamEntries(repoRoot) {
  const dreamDir = path.join(repoRoot, "data", "dream_journal");
  if (!fs.existsSync(dreamDir)) return [];
  const files = fs.readdirSync(dreamDir).filter(f => f.endsWith(".jsonl"));
  const entries = [];
  for (const file of files) {
    // Try MCP resource first, fall back to fs.readFileSync
    const filePath = path.join(dreamDir, file);
    const remote = readFileViaMcp(filePath);
    const text = remote && remote.text ? remote.text : (() => { try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; } })();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
  }
  return entries;
}

function refreshHealthPcsf(repoRoot) {
  const p = path.join(repoRoot, "data", "pcsf", "health.pcsf.json");
  const data = loadJson(p);
  if (!data) return;
  let changed = false;

  // Update provider key snapshot
  const checks = data.checks || data.health_checks || [];
  const checkList = Array.isArray(checks) ? checks : Object.values(checks);
  const provCheck = checkList.find(c => c.check_id === "settings_providers");
  if (provCheck && provCheck.current_snapshot) {
    const snap = provCheck.current_snapshot;
    for (const key of PROVIDER_KEYS) {
      const present = envPresent(key);
      if (snap[key] !== present) { snap[key] = present; changed = true; }
    }
    const any = PROVIDER_KEYS.some(envPresent) || envPresent("OLLAMA_BASE_URL");
    if (snap._any !== any) { snap._any = any; changed = true; }
  }

  // Update journal stats
  const entries = loadDreamEntries(repoRoot);
  const journal = {
    total_entries: entries.length,
    entries_by_kind: {},
    entries_with_ctf: 0,
    avg_lucidity: 0,
    generated_at: _now(),
  };
  let totalLucidity = 0;
  for (const e of entries) {
    journal.entries_by_kind[e.kind || "dream"] = (journal.entries_by_kind[e.kind || "dream"] || 0) + 1;
    if ((e.ctf_glyphs || []).length) journal.entries_with_ctf++;
    totalLucidity += e.lucidity || 0;
  }
  if (entries.length > 0) journal.avg_lucidity = +(totalLucidity / entries.length).toFixed(2);

  if (!data.journal || JSON.stringify(data.journal) !== JSON.stringify(journal)) {
    data.journal = journal;
    changed = true;
  }

  data.generated_at = _now();
  saveJson(p, data);
  console.log("[PCSF] health.pcsf.json refreshed — entries:", journal.total_entries, "CTF:", journal.entries_with_ctf, changed ? "(changed)" : "(unchanged)");
}

function refreshGpuTrainingPcsf(repoRoot) {
  const p = path.join(repoRoot, "data", "pcsf", "gpu-training.pcsf.json");
  let data;
  try { data = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return; }

  for (const prov of data.providers || []) {
    // Kaggle accepts either the new Bearer token OR the legacy username+key pair
    let credOk;
    if (prov.provider_id === "kaggle") {
      credOk = envPresent("KAGGLE_API_TOKEN")
        || (envPresent("KAGGLE_USERNAME") && envPresent("KAGGLE_KEY"));
    } else {
      credOk = !prov.auth_env || prov.auth_env.length === 0
        || prov.auth_env.every(k => envPresent(k));
    }
    prov.state = credOk ? "available" : "no_key";
    prov.last_checked = _now();
  }
  data.generated_at = _now();
  saveJson(p, data);

  const available = (data.providers || []).filter(p => p.state === "available").map(p => p.provider_id);
  console.error("[PCSF] gpu-training.pcsf.json refreshed — available:", available.join(", ") || "none");
}

async function refreshAllPcsf(repoRoot) {
  console.log("[PCSF] Starting live refresh…");
  refreshSettingsPcsf(repoRoot);
  await refreshProviderPcsf(repoRoot);
  refreshHealthPcsf(repoRoot);
  refreshGpuTrainingPcsf(repoRoot);
  console.log("[PCSF] Live refresh complete.");
}

module.exports = { refreshAllPcsf, refreshGpuTrainingPcsf };
