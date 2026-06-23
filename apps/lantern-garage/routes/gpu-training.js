// GPU Training Orchestration routes
// GET  /api/gpu-training/providers   — PCSF provider list + live credential states
// GET  /api/gpu-training/status      — providers + last 20 job records + active job
// POST /api/gpu-training/dispatch    — { provider?, checkpointUri?, steps? }
// POST /api/gpu-training/poll        — { provider, jobId }
// POST /api/gpu-training/test        — { provider } quick smoke-test (no GPU spin-up)

const { execFileSync } = require("child_process");

const {
  dispatchTrainingJob,
  pollJobStatus,
  rotateProvider,
  loadGpuPcsf,
} = require("../lib/training-dispatcher");

const JOBS_LOG_REL = ["data", "self-improvement", "training-jobs.jsonl"];

// Only these keys may be set via the UI — prevents arbitrary env injection
const GPU_KEY_ALLOWLIST = [
  // HuggingFace — checkpoint transport between providers
  "HF_TOKEN",
  "HF_TRAINING_REPO",
  // Kaggle — 30 h/wk free T4/P100, automated
  "KAGGLE_API_TOKEN",
  "KAGGLE_USERNAME",
  "KAGGLE_KEY",
  // Lightning AI — 22 credits/mo T4/A10, automated
  "LIGHTNING_USER_ID",
  "LIGHTNING_API_KEY",
  // Modal Labs — $30/mo free H100/A100, automated
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  // Vast.ai — spot marketplace ~$0.15-0.40/hr, automated
  "VAST_AI_API_KEY",
  // RunPod — spot/on-demand ~$0.20-0.50/hr, automated
  "RUNPOD_API_KEY",
  // Paperspace — key set, but free GPU removed (PRO required)
  "PAPERSPACE_API_KEY",
];

// Read a key from Windows User env scope (fallback for process.env miss).
// Returns the value string or empty string if absent / PowerShell unavailable.
function _readWindowsUserEnv(key) {
  try {
    const val = execFileSync("powershell", [
      "-NonInteractive", "-Command",
      `[System.Environment]::GetEnvironmentVariable('${key}', 'User')`,
    ], { timeout: 5_000, encoding: "utf8" }).trim();
    return val || "";
  } catch { return ""; }
}

// Sync allowlisted keys from Windows User env into process.env on first call.
let _keysSynced = false;
function _syncUserEnvKeys() {
  if (_keysSynced) return;
  _keysSynced = true;
  for (const k of GPU_KEY_ALLOWLIST) {
    if (!process.env[k]) {
      const val = _readWindowsUserEnv(k);
      if (val) process.env[k] = val;
    }
  }
}

function readJobsLog(fs, path, repoRoot) {
  const p = path.join(repoRoot, ...JOBS_LOG_REL);
  try {
    const lines = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function activeJob(jobs) {
  // Most recent dispatch that is not yet done/failed/cancelled
  const dispatches = [...jobs].reverse().filter(j => j.type === "training_dispatch");
  if (!dispatches.length) return null;
  const last = dispatches[0];
  // Find the latest poll for the same job
  const latestPoll = [...jobs].reverse().find(
    j => j.type === "training_poll" && j.jobId === last.jobId && j.provider === last.provider
  );
  const status = latestPoll?.status || last.status;
  return { ...last, currentStatus: status, latestPoll };
}

module.exports = async function gpuTrainingRoutes(req, res, url, deps) {
  const { fs, path, sendJson, collectRequestBody, repoRoot } = deps;

  if (!url.pathname.startsWith("/api/gpu-training/")) return false;

  // ── GET /api/gpu-training/providers ─────────────────────────────
  if (url.pathname === "/api/gpu-training/providers" && req.method === "GET") {
    const pcsf = loadGpuPcsf();
    if (!pcsf) { sendJson(res, { error: "gpu-training.pcsf.json not found" }, 503); return true; }
    sendJson(res, {
      providers: pcsf.providers,
      rotation_order: pcsf.rotation_order,
      weekly_total_hours: pcsf.weekly_total_hours,
      state: pcsf.state,
    });
    return true;
  }

  // ── GET /api/gpu-training/status ────────────────────────────────
  if (url.pathname === "/api/gpu-training/status" && req.method === "GET") {
    const pcsf = loadGpuPcsf();
    const jobs = readJobsLog(fs, path, repoRoot);
    const last20 = jobs.slice(-20).reverse();
    const active = activeJob(jobs);
    const nextProvider = rotateProvider(active?.provider || null);

    sendJson(res, {
      providers: pcsf?.providers || [],
      rotation_order: pcsf?.rotation_order || [],
      weekly_total_hours: pcsf?.weekly_total_hours || 0,
      active,
      nextProvider,
      recentJobs: last20,
      totalJobs: jobs.length,
    });
    return true;
  }

  // ── POST /api/gpu-training/dispatch ─────────────────────────────
  if (url.pathname === "/api/gpu-training/dispatch" && req.method === "POST") {
    let body = {};
    try { body = JSON.parse(await collectRequestBody(req)); } catch {}

    const { checkpointUri = "", steps = 600 } = body;
    let { provider } = body;

    // Auto-select provider from rotation if not specified
    if (!provider) {
      const jobs = readJobsLog(fs, path, repoRoot);
      const active = activeJob(jobs);
      provider = rotateProvider(active?.provider || null);
      if (!provider) {
        sendJson(res, { error: "all_providers_exhausted",
          message: "All providers have used their weekly quota. Try again Monday." }, 503);
        return true;
      }
    }

    try {
      const result = await dispatchTrainingJob(provider, checkpointUri, steps);
      sendJson(res, result);
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return true;
  }

  // ── POST /api/gpu-training/poll ─────────────────────────────────
  if (url.pathname === "/api/gpu-training/poll" && req.method === "POST") {
    let body = {};
    try { body = JSON.parse(await collectRequestBody(req)); } catch {}
    const { provider, jobId } = body;
    if (!provider || !jobId) {
      sendJson(res, { error: "provider and jobId required" }, 400); return true;
    }
    try {
      const result = await pollJobStatus(provider, jobId);
      sendJson(res, result);
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return true;
  }

  // ── GET /api/gpu-training/keys ──────────────────────────────────
  if (url.pathname === "/api/gpu-training/keys" && req.method === "GET") {
    _syncUserEnvKeys();
    const keys = GPU_KEY_ALLOWLIST.map(k => {
      const val = process.env[k] || "";
      const set = val.length > 0;
      return { key: k, set, masked: set ? val.substring(0, 8) + "…" : null };
    });
    sendJson(res, { keys });
    return true;
  }

  // ── POST /api/gpu-training/keys { key, value } ──────────────────
  if (url.pathname === "/api/gpu-training/keys" && req.method === "POST") {
    let body = {};
    try { body = JSON.parse(await collectRequestBody(req)); } catch {}
    const { key, value = "" } = body;
    if (!key || !GPU_KEY_ALLOWLIST.includes(key)) {
      sendJson(res, { error: "key_not_allowed", allowed: GPU_KEY_ALLOWLIST }, 400);
      return true;
    }
    // Set in current process immediately
    process.env[key] = value;
    // Persist to Windows User env — value passed via child env, never interpolated
    let persisted = false;
    try {
      execFileSync("powershell", [
        "-NonInteractive", "-Command",
        `[System.Environment]::SetEnvironmentVariable('${key}', $env:__GPU_KEY_VAL, 'User')`,
      ], { timeout: 10_000, env: { ...process.env, __GPU_KEY_VAL: value } });
      persisted = true;
    } catch {}
    sendJson(res, { ok: true, key, persisted, session_only: !persisted });
    return true;
  }

  // ── POST /api/gpu-training/test ─────────────────────────────────
  // Smoke-tests provider credential resolution without launching a GPU job.
  if (url.pathname === "/api/gpu-training/test" && req.method === "POST") {
    let body = {};
    try { body = JSON.parse(await collectRequestBody(req)); } catch {}
    const { provider } = body;
    if (!provider) { sendJson(res, { error: "provider required" }, 400); return true; }

    const pcsf = loadGpuPcsf();
    const cfg = (pcsf?.providers || []).find(p => p.provider_id === provider);
    if (!cfg) { sendJson(res, { error: "unknown provider", provider }, 404); return true; }

    // Check credential presence
    const credChecks = {};
    const envKeys = provider === "kaggle"
      ? ["KAGGLE_API_TOKEN", "KAGGLE_USERNAME", "KAGGLE_KEY"]
      : (cfg.auth_env || []);
    for (const k of envKeys) {
      credChecks[k] = !!(process.env[k] && process.env[k].trim().length > 0);
    }

    const kaggleOk = provider === "kaggle"
      ? (credChecks.KAGGLE_API_TOKEN || (credChecks.KAGGLE_USERNAME && credChecks.KAGGLE_KEY))
      : envKeys.every(k => credChecks[k]);

    const credOk = provider === "kaggle" ? kaggleOk : envKeys.every(k => credChecks[k]);

    sendJson(res, {
      provider,
      display: cfg.display,
      automatable: cfg.automatable,
      state: cfg.state,
      credOk,
      credChecks,
      gpu: cfg.gpu,
      quota_hours_per_week: cfg.quota_hours_per_week,
      steps_per_hour_estimate: cfg.steps_per_hour_estimate,
      setup_steps: cfg.setup_steps,
      kernelUrl: cfg.kernel_id ? `https://www.kaggle.com/code/${cfg.kernel_id}` : null,
      studioUrl: cfg.studio_name_default ? `https://lightning.ai/studios/${cfg.studio_name_default}` : null,
    });
    return true;
  }

  return false;
};
