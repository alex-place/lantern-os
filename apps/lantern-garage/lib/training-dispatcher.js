"use strict";

// GPU training dispatcher — routes Ouro fine-tune jobs across free providers.
// Provider state is read from data/pcsf/gpu-training.pcsf.json (PCSF format).
// Checkpoint transport: CSF pack → HuggingFace Hub → next provider unpacks.
// Issues: #1062 (pack/upload), #1063 (dispatch), #1064 (poll/rotate)

const fs = require("fs");
const os = require("os");
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

  if (provider === "kaggle")     return _dispatchKaggle(checkpointUri, steps);
  if (provider === "paperspace") return _dispatchPaperspace(checkpointUri, steps);
  if (provider === "colab")      return _dispatchColab(checkpointUri, steps);
  if (provider === "lightning")  return _dispatchLightning(checkpointUri, steps);

  // SageMaker — basic manual-handoff record
  const cfg = getProviderConfig(provider);
  const record = {
    type: "training_dispatch",
    provider,
    status: "manual_required",
    checkpointUri,
    steps,
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
  const kernelId = cfg?.kernel_id || "lanternfounder/ouro-training";
  const [, kernelSlug] = kernelId.split("/");

  // Write kernel-metadata.json + train.py to a temp dir and push via the CLI.
  // The Python CLI handles proto serialisation correctly; plain REST JSON silently
  // changes field types across SDK versions and broke our direct fetch approach.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaggle-push-"));
  const metaPath = path.join(tmpDir, "kernel-metadata.json");
  const scriptPath = path.join(tmpDir, "train.py");

  // Title must slugify to exactly the slug portion of kernelId.
  // Kaggle slugifies titles by replacing spaces → hyphens; hyphens IN the title are
  // stripped (not kept), so "ouro-qlora" → "ouroqlora" ≠ "ouro-qlora".
  // Use spaces: "ouro qlora" → slug "ouro-qlora" ✓
  const [, kernelSlugOnly] = kernelId.split("/");
  const meta = {
    id: kernelId,
    title: kernelSlugOnly.replace(/-/g, " "),
    code_file: "train.py",
    language: "python",
    kernel_type: "script",
    is_private: true,
    enable_gpu: true,
    enable_internet: true,
    dataset_sources: [],
    kernel_sources: [],
    competition_sources: [],
    model_sources: [],
  };

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  fs.writeFileSync(scriptPath, _kaggleScript(checkpointUri, hfRepo, steps), "utf8");

  const env = {
    ...process.env,
    KAGGLE_API_TOKEN: process.env.KAGGLE_API_TOKEN || "",
    // Legacy auth for the Python kaggle package
    KAGGLE_USERNAME: cfg?.username || process.env.KAGGLE_USERNAME || "lanternfounder",
    KAGGLE_KEY: process.env.KAGGLE_KEY || "",
  };

  let raw;
  try {
    raw = execFileSync("python", ["-m", "kaggle", "kernels", "push", "-p", tmpDir],
      { encoding: "utf8", timeout: 60_000, env });
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { error: "kaggle_push_failed", detail: err.message + (err.stderr || "") };
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Extract actual slug from the CLI output URL — handles both URL formats:
  // old: kaggle.com/code/user/slug  new: kaggle.com/user/slug
  const slugMatch = raw.match(/kaggle\.com(?:\/code)?\/[^/]+\/([^\s"]+)/);
  const actualSlug = slugMatch ? slugMatch[1].replace(/[^\w-]/g, "") : kernelSlug;
  const actualKernelUrl = slugMatch
    ? `https://www.kaggle.com/code/${cfg?.username || "lanternfounder"}/${actualSlug}`
    : `https://www.kaggle.com/code/${kernelId}`;

  const hoursEstimated = Math.ceil(steps / (cfg?.steps_per_hour_estimate || 180));
  const record = {
    type: "training_dispatch",
    provider: "kaggle",
    status: "queued",
    jobId: actualSlug,
    kernelId,
    kernelUrl: actualKernelUrl,
    checkpointUri: checkpointUri || null,
    steps,
    hoursEstimated,
    cliOutput: raw.trim(),
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
    const res = await fetch("https://api.paperspace.com/v1/notebooks", {
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

async function _dispatchColab(checkpointUri, steps) {
  const hfRepo = process.env.HF_TRAINING_REPO || loadGpuPcsf()?.checkpoint_repo_default || "ouro-checkpoints";
  const ts = Date.now();
  const nbFilename = `ouro-training-${ts}.ipynb`;
  const nbPath = path.join(REPO_ROOT, "data", "self-improvement", "colab-notebooks", nbFilename);

  const notebook = _buildColabNotebook(checkpointUri, hfRepo, steps);
  ensureDir(nbPath);
  fs.writeFileSync(nbPath, JSON.stringify(notebook, null, 2), "utf8");

  // Colab badge URL — opens the notebook directly in Colab from the GitHub raw URL.
  // Requires the file to be committed and pushed to master to be accessible.
  const ghRawBase = "https://raw.githubusercontent.com/alex-place/lantern-os/master";
  const nbRelPath = `data/self-improvement/colab-notebooks/${nbFilename}`;
  const colabBadgeUrl = `https://colab.research.google.com/github/alex-place/lantern-os/blob/master/${nbRelPath}`;
  const rawUrl = `${ghRawBase}/${nbRelPath}`;

  const record = {
    type: "training_dispatch",
    provider: "colab",
    status: "manual_required",
    checkpointUri,
    steps,
    notebookPath: nbPath,
    colabBadgeUrl,
    rawUrl,
    instructions: [
      `1. Commit and push ${nbRelPath} to master (or open the local file in Colab via File > Upload)`,
      `2. Open in Colab: ${colabBadgeUrl}`,
      "3. Runtime → Change runtime type → T4 GPU → Save",
      "4. Run All (Ctrl+F9) — session runs up to 8 h then terminates",
    ],
    dispatchedAt: isoNow(),
  };
  ensureDir(JOBS_LOG);
  await appendJsonlQueued(JOBS_LOG, record);
  return record;
}

function _buildColabNotebook(checkpointUri, hfRepo, steps) {
  const filename = checkpointUri ? path.basename(checkpointUri) : "checkpoint.csf";
  const cells = [
    {
      cell_type: "markdown",
      metadata: {},
      source: [
        "# Ouro Training Continuation\n",
        `**Steps:** ${steps} | **Checkpoint:** \`${checkpointUri || "cold start"}\`\n\n`,
        "**Before running:** Runtime → Change runtime type → **T4 GPU** → Save\n\n",
        "Then: Runtime → Run all (Ctrl+F9)",
      ],
    },
    {
      cell_type: "code",
      execution_count: null,
      metadata: { id: "setup" },
      outputs: [],
      source: [
        "!pip install -q huggingface_hub zstandard\n",
        "import subprocess, sys, json\n",
        "import csf\n",
        "from huggingface_hub import hf_hub_download, upload_file\n",
      ],
    },
    {
      cell_type: "code",
      execution_count: null,
      metadata: { id: "pull_checkpoint" },
      outputs: [],
      source: [
        `HF_REPO = "${hfRepo}"\n`,
        `CHECKPOINT_FILE = "${filename}"\n`,
        `STEPS = ${steps}\n`,
        "\n",
        "local_csf = hf_hub_download(repo_id=HF_REPO, filename=CHECKPOINT_FILE, repo_type='model')\n",
        "csf.unpack(local_csf, '/content/checkpoint')\n",
        "print('Checkpoint unpacked.')\n",
      ],
    },
    {
      cell_type: "code",
      execution_count: null,
      metadata: { id: "train" },
      outputs: [],
      source: [
        "result = subprocess.run([\n",
        "    sys.executable, 'scripts/train_ouro.py',\n",
        "    '--resume_from', '/content/checkpoint',\n",
        "    f'--max_steps', str(STEPS),\n",
        "    '--seq_len', '1536',\n",
        "    '--output_dir', '/content/output',\n",
        "], check=True)\n",
        "print('Training complete.')\n",
      ],
    },
    {
      cell_type: "code",
      execution_count: null,
      metadata: { id: "upload_checkpoint" },
      outputs: [],
      source: [
        "manifest = csf.pack(['/content/output'], '/content/output.csf')\n",
        "upload_file(\n",
        "    path_or_fileobj='/content/output.csf',\n",
        "    path_in_repo='output.csf',\n",
        "    repo_id=HF_REPO,\n",
        "    repo_type='model',\n",
        ")\n",
        "print(json.dumps({'status': 'done', 'steps': STEPS, 'sha256': manifest.get('footer_sha256')}))\n",
      ],
    },
  ];

  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      accelerator: "GPU",
      colab: { provenance: [] },
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" },
    },
    cells,
  };
}

function _kaggleScript(checkpointUri, hfRepo, steps) {
  // Generates a self-contained Python script pushed to Kaggle via /api/v1/kernels/push.
  // Clones the lantern-os repo so train-qlora-ouro.py and training data are available.
  // Cold start (no checkpoint) skips HF download — saves adapter to Kaggle output storage.
  // If HF_TOKEN is set as a Kaggle secret it also uploads to hfRepo for cross-provider handoff.
  const resumeBlock = checkpointUri ? `
# Resume from checkpoint
from huggingface_hub import hf_hub_download
local_csf = hf_hub_download(repo_id="${hfRepo}", filename="${path.basename(checkpointUri)}", repo_type="model")
import sys as _sys; _sys.path.insert(0, "/kaggle/working/lantern-os/src")
import csf
csf.unpack(local_csf, "/kaggle/working/checkpoint")
resume_args = ["--resume_from", "/kaggle/working/checkpoint"]
` : `resume_args = []  # cold start`;

  return `import subprocess, sys, os, json

print("=== Ouro QLoRA training — ${steps} steps ===")

# Install dependencies — pin transformers <4.53 (ROPE_INIT_FUNCTIONS changed in 4.53+)
subprocess.run([sys.executable, "-m", "pip", "install", "-q",
    "transformers>=4.40,<4.53", "peft>=0.10", "bitsandbytes>=0.43",
    "datasets", "accelerate", "scipy", "huggingface_hub", "zstandard"],
    check=True)

# Monkey-patch: restore 'default' rope type in case transformers>=4.53 was pre-installed
# OuroRotaryEmbedding looks up ROPE_INIT_FUNCTIONS['default'] at model init time.
try:
    from transformers.modeling_rope_utils import ROPE_INIT_FUNCTIONS
    if 'default' not in ROPE_INIT_FUNCTIONS:
        from transformers.modeling_rope_utils import _compute_default_rope_parameters
        ROPE_INIT_FUNCTIONS['default'] = _compute_default_rope_parameters
        print("patched: ROPE_INIT_FUNCTIONS['default'] restored")
except Exception as _e:
    print(f"rope patch skipped: {_e}")

# Clone repo (training script + data).
# GIT_LFS_SKIP_SMUDGE=1 skips downloading LFS objects (*.png, *.pdf, *.zip) —
# the repo LFS budget is exceeded; we only need the Python script + JSONL data,
# neither of which is tracked by LFS.
REPO = "/kaggle/working/lantern-os"
if not os.path.exists(REPO):
    clone_env = {**os.environ, "GIT_LFS_SKIP_SMUDGE": "1"}
    subprocess.run(["git", "clone", "--depth", "1",
        "https://github.com/alex-place/lantern-os", REPO],
        env=clone_env, check=True)

os.chdir(REPO)
sys.path.insert(0, os.path.join(REPO, "src"))

${resumeBlock}

# Run QLoRA fine-tune — override HF_HOME to a writable Linux path
# (train-qlora-ouro.py defaults to D:/hf-cache which is Windows-only)
train_env = {**os.environ, "HF_HOME": "/kaggle/working/hf-cache"}
subprocess.run([
    sys.executable, "scripts/train-qlora-ouro.py",
    "--base", "ByteDance/Ouro-1.4B",
    "--data", "models/lantern-sigma0-coder/training-data.jsonl",
    "--out", "/kaggle/working/output",
    "--max-steps", "${steps}",
    "--seq", "1536",
    *resume_args,
], check=True, env=train_env)

# Upload to HF if token available (cross-provider handoff)
hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
if hf_token:
    import csf
    from huggingface_hub import upload_file
    manifest = csf.pack(["/kaggle/working/output"], "/kaggle/working/output.csf")
    upload_file(path_or_fileobj="/kaggle/working/output.csf", path_in_repo="output.csf",
                repo_id="${hfRepo}", repo_type="model", token=hf_token)
    print(json.dumps({"status": "done", "steps": ${steps},
                      "sha256": manifest.get("footer_sha256"), "uploaded_to_hf": True}))
else:
    print(json.dumps({"status": "done", "steps": ${steps},
                      "output": "/kaggle/working/output", "uploaded_to_hf": False,
                      "note": "Set HF_TOKEN Kaggle secret to enable cross-provider checkpoint handoff"}))
`;
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
  if (provider === "kaggle")     return _pollKaggle(jobId);
  if (provider === "paperspace") return _pollPaperspace(jobId);
  if (provider === "lightning")  return _pollLightning(jobId);
  // SageMaker, Colab — manual check
  const update = { type: "training_poll", provider, jobId, status: "manual_required", polledAt: isoNow() };
  await appendJsonlQueued(JOBS_LOG, update);
  return update;
}

// Invoke scripts/lightning_dispatch.py via execFileSync, return parsed JSON output.
function _runLightningScript(subcommand, extraArgs = []) {
  const script = path.join(REPO_ROOT, "scripts", "lightning_dispatch.py");
  const env = {
    ...process.env,
    LIGHTNING_USER_ID:        process.env.LIGHTNING_USER_ID        || "",
    LIGHTNING_API_KEY:        process.env.LIGHTNING_API_KEY        || "",
    LIGHTNING_STUDIO_USER:    process.env.LIGHTNING_STUDIO_USER    || "alexplace7",
    LIGHTNING_STUDIO_TEAMSPACE: process.env.LIGHTNING_STUDIO_TEAMSPACE || "custom-ml-model-development-project",
    HF_TRAINING_REPO:         process.env.HF_TRAINING_REPO         || "ouro-checkpoints",
  };
  const raw = execFileSync("python", [script, subcommand, ...extraArgs],
    { encoding: "utf8", timeout: 120_000, env });
  return JSON.parse(raw.trim());
}

async function _dispatchLightning(checkpointUri, steps) {
  const cfg = getProviderConfig("lightning");
  const hfRepo = process.env.HF_TRAINING_REPO || loadGpuPcsf()?.checkpoint_repo_default || "ouro-checkpoints";
  let result;
  try {
    const lightningArgs = ["--steps", String(steps), "--hf-repo", hfRepo];
    if (checkpointUri) lightningArgs.push("--checkpoint-uri", checkpointUri);
    result = _runLightningScript("dispatch", lightningArgs);
  } catch (err) {
    return { error: "lightning_dispatch_failed", detail: err.message };
  }
  if (result.error) return { error: result.error, provider: "lightning", detail: result };
  const hoursEstimated = Math.ceil(steps / (cfg?.steps_per_hour_estimate || 180));
  const record = {
    type: "training_dispatch",
    provider: "lightning",
    status: result.status || "running",
    jobId: result.studio,
    studioName: result.studio,
    machine: result.machine,
    checkpointUri,
    steps,
    hoursEstimated,
    logPath: result.log_path,
    dispatchedAt: isoNow(),
  };
  ensureDir(JOBS_LOG);
  await appendJsonlQueued(JOBS_LOG, record);
  return record;
}

async function _pollLightning(studioName) {
  const creds = _checkCredentials("lightning");
  if (creds.error) return creds;
  let result;
  try {
    result = _runLightningScript("poll", ["--studio", studioName || "ouro-training"]);
  } catch (err) {
    return { error: "lightning_poll_failed", detail: err.message };
  }
  if (result.error) return { error: result.error, provider: "lightning" };
  // Auto-stop when done to preserve credits
  if (result.status === "done") {
    try { _runLightningScript("stop", ["--studio", studioName || "ouro-training"]); } catch {}
  }
  const update = {
    type: "training_poll", provider: "lightning", jobId: studioName,
    status: result.status, studioStatus: result.studio_status,
    lastLogLine: result.last_log_line, polledAt: isoNow(),
  };
  await appendJsonlQueued(JOBS_LOG, update);
  return update;
}

async function _pollKaggle(jobId) {
  const creds = _checkCredentials("kaggle");
  if (creds.error) return creds;

  const cfg = getProviderConfig("kaggle");
  const username = cfg?.username || process.env.KAGGLE_USERNAME || "lanternfounder";
  // Confirmed working URL: GET /api/v1/kernels/status?userName=&kernelSlug=
  const url = `https://www.kaggle.com/api/v1/kernels/status?userName=${username}&kernelSlug=${jobId}`;

  let data;
  try {
    const res = await fetch(url, { headers: { "Authorization": _kaggleAuthHeader() } });
    if (!res.ok) return { error: "kaggle_poll_failed", httpStatus: res.status };
    data = await res.json();
  } catch (err) {
    return { error: "kaggle_network_error", detail: err.message };
  }

  const statusMap = { complete: "done", running: "running", error: "failed", queued: "queued", cancelAcknowledged: "cancelled" };
  const status = statusMap[data.status] || data.status;

  const update = {
    type: "training_poll",
    provider: "kaggle",
    jobId,
    status,
    rawStatus: data.status,
    failureMessage: data.failureMessage || null,
    polledAt: isoNow(),
  };
  await appendJsonlQueued(JOBS_LOG, update);
  return update;
}

async function _pollPaperspace(jobId) {
  const creds = _checkCredentials("paperspace");
  if (creds.error) return creds;

  let data;
  try {
    const res = await fetch(`https://api.paperspace.com/v1/notebooks/${jobId}`, {
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
