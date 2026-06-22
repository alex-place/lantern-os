"use strict";

// GPU training dispatcher — routes Ouro fine-tune jobs across free providers.
// Provider state is read from data/pcsf/gpu-training.pcsf.json (PCSF format).
// Checkpoint transport: CSF pack → HuggingFace Hub → next provider unpacks.
// Issues: #1062 (pack/upload), #1063 (dispatch), #1064 (poll/rotate)

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { appendJsonlQueued } = require("./file-queue");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const JOBS_LOG = path.join(REPO_ROOT, "data", "self-improvement", "training-jobs.jsonl");
const GPU_PCSF = path.join(REPO_ROOT, "data", "pcsf", "gpu-training.pcsf.json");

function isoNow() { return new Date().toISOString(); }

function ensureDir(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }

function loadGpuPcsf() {
  try { return JSON.parse(fs.readFileSync(GPU_PCSF, "utf8")); } catch { return null; }
}

function readJobsLog() {
  try {
    return fs.readFileSync(JOBS_LOG, "utf8")
      .split(/\r?\n/).filter(Boolean)
      .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { return []; }
}

function getProviderConfig(providerId) {
  const pcsf = loadGpuPcsf();
  if (!pcsf) return null;
  return (pcsf.providers || []).find(p => p.provider_id === providerId) || null;
}

// ---------------------------------------------------------------------------
// Issue #1062 — packAndUploadCheckpoint
// ---------------------------------------------------------------------------

async function packAndUploadCheckpoint(checkpointDir, hfRepoId) {
  if (!fs.existsSync(checkpointDir)) {
    return { error: "dir_not_found", checkpointDir };
  }

  const archivePath = checkpointDir.replace(/[\\/]+$/, "") + ".csf";
  const hfRepo = hfRepoId
    || process.env.HF_TRAINING_REPO
    || loadGpuPcsf()?.checkpoint_repo_default
    || "ouro-checkpoints";

  // Pack via Python CSF module — shell:false, no interpolation of user paths
  let manifest;
  try {
    const raw = execFileSync(
      "python",
      ["-c",
        "import csf, json, sys; m = csf.pack([sys.argv[1]], sys.argv[2]); print(json.dumps(m))",
        checkpointDir, archivePath,
      ],
      { encoding: "utf8", timeout: 120_000 }
    );
    manifest = JSON.parse(raw.trim());
  } catch (err) {
    return { error: "csf_pack_failed", detail: err.message };
  }

  const sha256 = manifest?.footer_sha256 || manifest?.sha256 || null;

  // Upload to HuggingFace Hub via Python — shell:false
  let uri;
  try {
    const raw = execFileSync(
      "python",
      ["-c",
        "from huggingface_hub import upload_file; import json, sys\n"
        + "r = upload_file(path_or_fileobj=sys.argv[1], path_in_repo=sys.argv[2], repo_id=sys.argv[3], repo_type='model')\n"
        + "print(json.dumps({'uri': str(r)}))",
        archivePath,
        path.basename(archivePath),
        hfRepo,
      ],
      { encoding: "utf8", timeout: 300_000 }
    );
    uri = JSON.parse(raw.trim()).uri;
  } catch (err) {
    return { error: "hf_upload_failed", detail: err.message, archivePath };
  }

  const record = {
    type: "checkpoint_upload",
    uri,
    sha256,
    archivePath,
    hfRepo,
    uploadedAt: isoNow(),
  };
  ensureDir(JOBS_LOG);
  await appendJsonlQueued(JOBS_LOG, record);
  return record;
}

// ---------------------------------------------------------------------------
// Issue #1063 — dispatchTrainingJob
// ---------------------------------------------------------------------------

async function dispatchTrainingJob(provider, checkpointUri, steps = 600) {
  const creds = _checkCredentials(provider);
  if (creds.error) return creds;

  if (provider === "kaggle") return _dispatchKaggle(checkpointUri, steps);
  if (provider === "paperspace") return _dispatchPaperspace(checkpointUri, steps);

  // Colab, SageMaker, Lightning — emit a manual-handoff record
  const cfg = getProviderConfig(provider);
  const record = {
    type: "training_dispatch",
    provider,
    status: "manual_required",
    checkpointUri,
    steps,
    instructionsUrl: cfg?.api || null,
    notebookTemplate: _notebookTemplate(provider, checkpointUri, steps),
    dispatchedAt: isoNow(),
  };
  ensureDir(JOBS_LOG);
  await appendJsonlQueued(JOBS_LOG, record);
  return record;
}

function _checkCredentials(provider) {
  const cfg = getProviderConfig(provider);
  if (!cfg) return { error: "unknown_provider", provider };
  if (provider === "kaggle") {
    // Accept new Bearer token OR legacy Basic credentials
    if (!process.env.KAGGLE_API_TOKEN && !(process.env.KAGGLE_USERNAME && process.env.KAGGLE_KEY)) {
      return { error: "missing_credentials", provider, required: ["KAGGLE_API_TOKEN", "or KAGGLE_USERNAME+KAGGLE_KEY"] };
    }
    return {};
  }
  for (const envKey of (cfg.auth_env || [])) {
    if (!process.env[envKey]) {
      return { error: "missing_credentials", provider, required: cfg.auth_env };
    }
  }
  return {};
}

// Returns the Authorization header value for Kaggle — Bearer token preferred over Basic.
function _kaggleAuthHeader() {
  if (process.env.KAGGLE_API_TOKEN) {
    return `Bearer ${process.env.KAGGLE_API_TOKEN}`;
  }
  const creds = Buffer.from(`${process.env.KAGGLE_USERNAME}:${process.env.KAGGLE_KEY}`).toString("base64");
  return `Basic ${creds}`;
}

async function _dispatchKaggle(checkpointUri, steps) {
  const cfg = getProviderConfig("kaggle");
  const hfRepo = process.env.HF_TRAINING_REPO || loadGpuPcsf()?.checkpoint_repo_default || "ouro-checkpoints";
  const slug = `ouro-train-${Date.now()}`;

  const kernelPayload = {
    title: `Ouro Training — ${steps} steps`,
    slug,
    source_code: _kaggleScript(checkpointUri, hfRepo, steps),
    language: "python",
    kernel_type: "script",
    is_private: true,
    enable_gpu: true,
    enable_internet: true,
  };

  let responseData;
  try {
    const res = await fetch("https://www.kaggle.com/api/v1/kernels/push", {
      method: "POST",
      headers: { "Authorization": _kaggleAuthHeader(), "Content-Type": "application/json" },
      body: JSON.stringify(kernelPayload),
    });
    if (!res.ok) {
      const text = await res.text();
      return { error: "kaggle_push_failed", httpStatus: res.status, detail: text };
    }
    responseData = await res.json();
  } catch (err) {
    return { error: "kaggle_network_error", detail: err.message };
  }

  const jobId = responseData.ref || slug;
  const hoursEstimated = Math.ceil((steps / (cfg?.steps_per_hour_estimate || 180)));

  const record = {
    type: "training_dispatch",
    provider: "kaggle",
    status: "queued",
    jobId,
    slug,
    checkpointUri,
    steps,
    hoursEstimated,
    dispatchedAt: isoNow(),
  };
  ensureDir(JOBS_LOG);
  await appendJsonlQueued(JOBS_LOG, record);
  return record;
}

async function _dispatchPaperspace(checkpointUri, steps) {
  const apiKey = process.env.PAPERSPACE_API_KEY;
  const hfRepo = process.env.HF_TRAINING_REPO || loadGpuPcsf()?.checkpoint_repo_default || "ouro-checkpoints";
  const cfg = getProviderConfig("paperspace");

  let responseData;
  try {
    const res = await fetch("https://api.paperspace.io/v1/notebooks", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        machineType: "Free-GPU",
        container: "paperspace/nb:PyTorch-1.14.0-Python-3.9",
        name: `ouro-train-${Date.now()}`,
        startupScript: _notebookTemplate("paperspace", checkpointUri, steps),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { error: "paperspace_push_failed", httpStatus: res.status, detail: text };
    }
    responseData = await res.json();
  } catch (err) {
    return { error: "paperspace_network_error", detail: err.message };
  }

  const jobId = responseData.id || responseData.name;
  const hoursEstimated = Math.ceil(steps / (cfg?.steps_per_hour_estimate || 90));
  const record = {
    type: "training_dispatch",
    provider: "paperspace",
    status: "queued",
    jobId,
    checkpointUri,
    steps,
    hoursEstimated,
    dispatchedAt: isoNow(),
  };
  ensureDir(JOBS_LOG);
  await appendJsonlQueued(JOBS_LOG, record);
  return record;
}

function _kaggleScript(checkpointUri, hfRepo, steps) {
  const filename = checkpointUri ? path.basename(checkpointUri) : "checkpoint.csf";
  return [
    "import subprocess, sys",
    "subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'huggingface_hub', 'zstandard'], check=True)",
    "import csf, json",
    "from huggingface_hub import hf_hub_download, upload_file",
    `local_csf = hf_hub_download(repo_id="${hfRepo}", filename="${filename}", repo_type="model")`,
    "csf.unpack(local_csf, '/kaggle/working/checkpoint')",
    `result = subprocess.run([`,
    `  sys.executable, 'scripts/train_ouro.py',`,
    `  '--resume_from', '/kaggle/working/checkpoint',`,
    `  '--max_steps', '${steps}',`,
    `  '--seq_len', '1536',`,
    `  '--output_dir', '/kaggle/working/output',`,
    `], capture_output=True, text=True)`,
    "print(result.stdout); print(result.stderr, file=sys.stderr)",
    "result.check_returncode()",
    "manifest = csf.pack(['/kaggle/working/output'], '/kaggle/working/output.csf')",
    `upload_file(path_or_fileobj='/kaggle/working/output.csf', path_in_repo='output.csf', repo_id="${hfRepo}", repo_type='model')`,
    `print(json.dumps({'status': 'done', 'steps': ${steps}, 'sha256': manifest.get('footer_sha256')}))`,
  ].join("\n");
}

function _notebookTemplate(provider, checkpointUri, steps) {
  const hfRepo = process.env.HF_TRAINING_REPO || "ouro-checkpoints";
  const filename = checkpointUri ? path.basename(checkpointUri) : "checkpoint.csf";
  return [
    `# Ouro training continuation — ${steps} steps on ${provider}`,
    `# Provider: ${provider} | Checkpoint: ${checkpointUri || "(none — cold start)"}`,
    "!pip install -q huggingface_hub zstandard",
    "import csf, subprocess, sys",
    "from huggingface_hub import hf_hub_download, upload_file",
    `local_csf = hf_hub_download(repo_id="${hfRepo}", filename="${filename}", repo_type="model")`,
    "csf.unpack(local_csf, '/tmp/checkpoint')",
    `subprocess.run([sys.executable, 'scripts/train_ouro.py',`,
    `  '--resume_from', '/tmp/checkpoint', '--max_steps', '${steps}',`,
    `  '--seq_len', '1536', '--output_dir', '/tmp/output'], check=True)`,
    "manifest = csf.pack(['/tmp/output'], '/tmp/output.csf')",
    `upload_file('/tmp/output.csf', 'output.csf', repo_id="${hfRepo}", repo_type='model')`,
    "print('Done — checkpoint uploaded to HuggingFace Hub')",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Issue #1064 — pollJobStatus + rotateProvider
// ---------------------------------------------------------------------------

async function pollJobStatus(provider, jobId) {
  if (provider === "kaggle") return _pollKaggle(jobId);
  if (provider === "paperspace") return _pollPaperspace(jobId);
  // Manual providers — caller must check externally
  const update = { type: "training_poll", provider, jobId, status: "manual_required", polledAt: isoNow() };
  await appendJsonlQueued(JOBS_LOG, update);
  return update;
}

async function _pollKaggle(jobId) {
  const creds = _checkCredentials("kaggle");
  if (creds.error) return creds;

  const username = process.env.KAGGLE_USERNAME || "lanternfounder";
  let data;
  try {
    const res = await fetch(
      `https://www.kaggle.com/api/v1/kernels/${username}/${jobId}/status`,
      { headers: { "Authorization": _kaggleAuthHeader() } }
    );
    if (!res.ok) return { error: "kaggle_poll_failed", httpStatus: res.status };
    data = await res.json();
  } catch (err) {
    return { error: "kaggle_network_error", detail: err.message };
  }

  const statusMap = { complete: "done", running: "running", error: "failed", queued: "queued", cancelAcknowledged: "cancelled" };
  const status = statusMap[data.status] || data.status;

  const update = { type: "training_poll", provider: "kaggle", jobId, status, rawStatus: data.status, polledAt: isoNow() };
  await appendJsonlQueued(JOBS_LOG, update);
  return update;
}

async function _pollPaperspace(jobId) {
  const creds = _checkCredentials("paperspace");
  if (creds.error) return creds;

  let data;
  try {
    const res = await fetch(`https://api.paperspace.io/v1/notebooks/${jobId}`, {
      headers: { "Authorization": `Bearer ${process.env.PAPERSPACE_API_KEY}` },
    });
    if (!res.ok) return { error: "paperspace_poll_failed", httpStatus: res.status };
    data = await res.json();
  } catch (err) {
    return { error: "paperspace_network_error", detail: err.message };
  }

  const statusMap = { Running: "running", Stopped: "done", Error: "failed", Starting: "queued" };
  const status = statusMap[data.state] || data.state;

  const update = { type: "training_poll", provider: "paperspace", jobId, status, rawStatus: data.state, polledAt: isoNow() };
  await appendJsonlQueued(JOBS_LOG, update);
  return update;
}

function _weekStartMs() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // back to Sunday
  return d.getTime();
}

function rotateProvider(current) {
  const pcsf = loadGpuPcsf();
  const order = pcsf?.rotation_order || ["kaggle", "sagemaker", "colab", "paperspace", "lightning"];
  const weekStart = _weekStartMs();

  // Tally hours dispatched this week per provider
  const used = {};
  for (const j of readJobsLog()) {
    if (j.type !== "training_dispatch" || j.status === "manual_required") continue;
    if (!j.dispatchedAt || new Date(j.dispatchedAt).getTime() < weekStart) continue;
    used[j.provider] = (used[j.provider] || 0) + (j.hoursEstimated || 0);
  }

  // Return next provider after current with quota remaining
  const startIdx = Math.max(0, order.indexOf(current));
  const candidates = [...order.slice(startIdx + 1), ...order.slice(0, startIdx + 1)];
  for (const p of candidates) {
    const cfg = (pcsf?.providers || []).find(x => x.provider_id === p);
    const quota = cfg?.quota_hours_per_week || 0;
    if ((used[p] || 0) < quota) return p;
  }
  return null;
}

module.exports = {
  packAndUploadCheckpoint,
  dispatchTrainingJob,
  pollJobStatus,
  rotateProvider,
  loadGpuPcsf,
};
