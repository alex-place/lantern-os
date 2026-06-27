// Health, status, system metrics — read-only telemetry endpoints
const { getRoutingSnapshot } = require("../lib/provider-cache");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// In-memory model metrics cache
let _modelMetricsCache = { data: null, ts: 0 };
const METRICS_CACHE_TTL_MS = 5000;

// Probe the local Ollama-API model server (:11434 by default) to report the
// actual offline model wired into the coder/agent path. OLLAMA_MODEL is the
// operator-pinned local model (e.g. ouro:latest, the Σ₀ Ouro Coder); we report
// whether it is genuinely being served right now vs only configured.
async function probeLocalModel() {
  const base = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const pinned = process.env.OLLAMA_MODEL || null;
  const out = {
    base,
    pinned,                                   // configured offline model (e.g. ouro:latest)
    adapter: process.env.OURO_ADAPTER || null,
    serving: false,                           // is the local model server reachable?
    served_models: [],                        // model tags actually loaded on the server
    pinned_served: false,                     // is the pinned model actually being served?
    active_model: null,                       // what the coder path will really use right now
  };
  try {
    const u = new URL(base);
    const tags = await new Promise((resolve, reject) => {
      const r = require("http").request(
        { hostname: u.hostname, port: u.port || 11434, path: "/api/tags", method: "GET" },
        (up) => { let d = ""; up.on("data", c => (d += c)); up.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); }
      );
      r.on("error", reject);
      r.setTimeout(3000, () => { r.destroy(); reject(new Error("timeout")); });
      r.end();
    });
    out.serving = true;
    out.served_models = (tags.models || []).map(m => String(m.name || "")).filter(Boolean);
    const norm = s => String(s || "").replace(/:latest$/, "").toLowerCase();
    out.pinned_served = !!pinned && out.served_models.some(m => norm(m) === norm(pinned));
    // The coder path leads with the pinned model when served, else the first served tag.
    out.active_model = out.pinned_served ? pinned : (out.served_models[0] || null);
  } catch {
    // server unreachable → serving stays false
  }
  return out;
}

function getModelMetrics(repoRoot) {
  const now = Date.now();
  if (_modelMetricsCache.data && (now - _modelMetricsCache.ts) < METRICS_CACHE_TTL_MS) {
    return _modelMetricsCache.data;
  }

  const metricsPath = path.join(repoRoot, "data", "metrics", "model-usage.jsonl");
  const metrics = {
    "lantern-csf-dream": { calls: 0, errors: 0, totalLatency: 0 },
    "lantern-pcsf": { calls: 0, errors: 0, totalLatency: 0 },
    "lantern-convergance": { calls: 0, errors: 0, totalLatency: 0 },
    "lantern-csf-dream-image": { calls: 0, errors: 0, totalLatency: 0 },
  };

  if (!fs.existsSync(metricsPath)) {
    _modelMetricsCache = { data: metrics, ts: now };
    return metrics;
  }

  const lines = fs.readFileSync(metricsPath, "utf8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      const modelId = record.modelId;
      if (!modelId || !metrics[modelId]) continue;

      metrics[modelId].calls += 1;
      if (record.metadata?.status === "failed") {
        metrics[modelId].errors += 1;
      }
      if (typeof record.metadata?.latencyMs === "number") {
        metrics[modelId].totalLatency += record.metadata.latencyMs;
      }
    } catch { /* skip bad lines */ }
  }

  _modelMetricsCache = { data: metrics, ts: now };
  return metrics;
}

function getGitVersion(repoRoot) {
  try {
    const commit = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
    const tag = execSync("git describe --tags --always", { cwd: repoRoot, encoding: "utf8" }).trim();
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
    const date = execSync("git log -1 --format=%cI", { cwd: repoRoot, encoding: "utf8" }).trim();
    let semver = tag;
    try {
      const vj = JSON.parse(fs.readFileSync(path.join(repoRoot, "apps/lantern-garage/public/version.json"), "utf8"));
      if (vj.version) semver = vj.version;
    } catch {}
    return { commit, tag, branch, date, semver };
  } catch {
    return { commit: "unknown", tag: "unknown", branch: "unknown", date: new Date().toISOString(), semver: "unknown" };
  }
}

module.exports = async function statusRoutes(req, res, url, deps) {
  const { sendJson, readJson, readJsonl, getStatus, getReadiness, getMiningLabStatus,
    getActionCapabilities, getOperatorFeedbackMemory, getAccessModel, getCloudMirrorStatus } = deps;

  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (url.pathname === "/api/health") {
    sendJson(res, { ok: true, service: "lantern-garage", generatedAt: new Date().toISOString() });
    return true;
  }
  if (url.pathname === "/api/status") {
    sendJson(res, getStatus());
    return true;
  }
  if (url.pathname === "/api/arc-reactor") {
    sendJson(res, readJson("data/arc-reactor/status.json", {}));
    return true;
  }
  if (url.pathname === "/api/wallet") {
    sendJson(res, {
      wallet: readJson("data/wallet/local-cash-wallet.json", {}),
      ledger: readJsonl("data/wallet/ledger.jsonl", 30),
    });
    return true;
  }
  if (url.pathname === "/api/readiness") {
    sendJson(res, getReadiness());
    return true;
  }
  if (url.pathname === "/api/mining-lab") {
    sendJson(res, getMiningLabStatus());
    return true;
  }
  if (url.pathname === "/api/action-capabilities") {
    sendJson(res, getActionCapabilities());
    return true;
  }
  if (url.pathname === "/api/operator-feedback") {
    sendJson(res, getOperatorFeedbackMemory());
    return true;
  }
  if (url.pathname === "/api/access-model") {
    sendJson(res, getAccessModel());
    return true;
  }
  if (url.pathname === "/api/cloud-mirrors") {
    sendJson(res, getCloudMirrorStatus());
    return true;
  }
  if (url.pathname === "/api/pcsf/routing") {
    sendJson(res, getRoutingSnapshot());
    return true;
  }
  if (url.pathname === "/api/version") {
    sendJson(res, { ok: true, version: getGitVersion(deps.repoRoot), generatedAt: new Date().toISOString() });
    return true;
  }
  // Server-side, cached update check (#879) — the client reads this LOCAL endpoint
  // instead of polling api.github.com on a 60s timer. Non-blocking: returns the cached
  // snapshot and refreshes in the background at most every ~15 min (403-backoff aware).
  if (url.pathname === "/api/update-status") {
    const { getUpdateStatus } = require("../lib/update-check");
    sendJson(res, { ok: true, ...getUpdateStatus(deps.repoRoot), generatedAt: new Date().toISOString() });
    return true;
  }
  if (url.pathname === "/api/metrics") {
    const metrics = getModelMetrics(deps.repoRoot);
    const enriched = {};
    for (const [modelId, data] of Object.entries(metrics)) {
      enriched[modelId] = {
        ...data,
        avgLatency: data.calls > 0 ? Math.round(data.totalLatency / data.calls) : 0,
        errorRate: data.calls > 0 ? Math.round((data.errors / data.calls) * 1000) / 10 : 0,
      };
    }
    sendJson(res, { ok: true, metrics: enriched, generatedAt: new Date().toISOString() });
    return true;
  }
  if (url.pathname === "/api/agents/status") {
    const tessPath = path.join(deps.repoRoot, "data", "agent-fleet", "tesseract-latest.json");
    let tessData = {};
    try {
      if (fs.existsSync(tessPath)) {
        tessData = JSON.parse(fs.readFileSync(tessPath, "utf8"));
      }
    } catch { /* ignore parse errors */ }
    sendJson(res, { ok: true, data: tessData, generatedAt: new Date().toISOString() });
    return true;
  }
  if (url.pathname === "/api/convergence/audit") {
    try {
      const { getAuditStats, getRecentEntries } = require(path.join(deps.repoRoot, "src", "convergence-audit"));
      const stats = getAuditStats();
      const recent = getRecentEntries(50);
      sendJson(res, { ok: true, stats, recent, generatedAt: new Date().toISOString() });
      return true;
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
      return true;
    }
  }

  // GET /api/serving/status — Verify active serving mode + decode params (#729)
  if (url.pathname === "/api/serving/status") {
    const { execSync: _exec } = require("child_process");
    const ouroNative = process.env.OURO_NATIVE || "";
    const fastActive = !/^(1|true|yes)$/i.test(ouroNative);
    // Call serving_modes.py to get authoritative params (same Python used by inference)
    let modeDetail = null;
    try {
      // Forward-slash the path before embedding it in a Python string literal —
      // a raw Windows path (e.g. "...\Users\...") makes Python parse "\U" as the
      // start of a \UXXXXXXXX unicode escape and throw a SyntaxError (#1268).
      const pyRoot = path.join(deps.repoRoot, "src").replace(/\\/g, "/");
      const raw = _exec(
        `python -c "import sys; sys.path.insert(0,'${pyRoot}'); from serving_modes import get_serving_mode, get_decode_params, describe_mode; import json; m=get_serving_mode(); print(json.dumps({'mode':m.name,'description':m.description,'max_latency_ms':m.max_latency_ms,'decode_params':get_decode_params(m)}))"`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      modeDetail = JSON.parse(raw);
    } catch { /* Python unavailable — fall back to env-based inference */ }
    const localModel = await probeLocalModel();
    sendJson(res, {
      ok: true,
      fast_mode_active: fastActive,
      ouro_native_env: ouroNative || null,
      mode: modeDetail?.mode || (fastActive ? "fast" : "deep"),
      description: modeDetail?.description || null,
      max_latency_ms: modeDetail?.max_latency_ms || (fastActive ? 2000 : 120000),
      decode_params: modeDetail?.decode_params || null,
      local_model: localModel,
      generatedAt: new Date().toISOString(),
    });
    return true;
  }

  // GET /api/benchmarks/leaderboard — Summarize serving benchmark runs (#730)
  if (url.pathname === "/api/benchmarks/leaderboard") {
    const lbPath = path.join(deps.repoRoot, "data", "benchmarks", "leaderboard.jsonl");
    if (!fs.existsSync(lbPath)) {
      sendJson(res, { ok: true, runs: 0, providers: {}, generatedAt: new Date().toISOString() });
      return true;
    }
    const lines = fs.readFileSync(lbPath, "utf8").trim().split("\n").filter(Boolean);
    const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    // Aggregate by provider+mode
    const byProvider = {};
    for (const r of records) {
      const key = `${r.provider}:${r.mode || "fast"}`;
      if (!byProvider[key]) byProvider[key] = { latencies: [], repetitions: [], runs: 0 };
      const slot = byProvider[key];
      slot.runs++;
      if (r.avg_latency_ms != null) slot.latencies.push(r.avg_latency_ms);
      if (r.avg_repetition_ratio != null) slot.repetitions.push(r.avg_repetition_ratio);
    }
    const summary = {};
    for (const [key, slot] of Object.entries(byProvider)) {
      const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 100) / 100 : null;
      summary[key] = {
        runs: slot.runs,
        avg_latency_ms: avg(slot.latencies),
        avg_repetition_ratio: avg(slot.repetitions),
        fast_target_met: slot.latencies.length ? slot.latencies[slot.latencies.length - 1] <= 2000 : null,
      };
    }
    sendJson(res, { ok: true, runs: records.length, providers: summary, recent: records.slice(-5), generatedAt: new Date().toISOString() });
    return true;
  }
};
