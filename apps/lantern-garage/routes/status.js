// Health, status, system metrics — read-only telemetry endpoints
const { getRoutingSnapshot } = require("../lib/provider-cache");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// In-memory model metrics cache
let _modelMetricsCache = { data: null, ts: 0 };
const METRICS_CACHE_TTL_MS = 5000;

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
};
