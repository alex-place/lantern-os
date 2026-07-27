/**
 * Training-jobs routes — the ONLY source of dispatchable training jobs is GitHub
 * issues labeled `training-job` carrying a fenced ```training-job block (flat
 * key: value lines — no YAML dependency, no nested structures).
 *
 *   GET /api/training-jobs — list open training-job issues, parsed + validated.
 *
 * Format (issue body):
 *   ```training-job
 *   script: scripts/train_qlora_qwen_coder.py
 *   args: --seed 3 --epochs 1
 *   dataset: data/eval/spiral/self-train/spiral-self-train-v1.jsonl
 *   vram_gb: 8
 *   ```
 *
 * Security: `script` must be on the allowlist below (repo-tracked training/eval
 * entry points only) and `args` must match a conservative charset. A job that
 * fails validation is still listed — with its errors — so the issue author can
 * fix it; it is never marked runnable. Running a job goes through the existing
 * admin-gated autowork endpoints; this route is read-only.
 */

const { safeExec } = require("../lib/safe-exec");

const GH_REPO = "alex-place/lantern-os";
const LABEL = "training-job";
const CACHE_TTL_MS = 60_000;

// Repo-tracked entry points a job may name. Extend deliberately, one line per PR.
const SCRIPT_ALLOWLIST = [
  "scripts/train_qlora_qwen_coder.py",
  "scripts/train-qlora-peft.py",
  "scripts/spiral_build_self_train.py",
  "experiments/spiral_gen_traces.js",
  "scripts/eval_qwen_coder.py",
  "scripts/eval_humaneval_ouro.py",
  "scripts/eval_coding.py",
];

// Conservative arg charset: flags, paths, numbers. No shell metacharacters —
// jobs run through safe-exec (shell:false) downstream, this is defense in depth.
const ARGS_RE = /^[A-Za-z0-9 ._\/=-]*$/;

let _cache = { ts: 0, data: null };

function parseJobBlock(body) {
  const m = String(body || "").match(/```training-job\r?\n([\s\S]*?)```/);
  if (!m) return { fields: null, errors: ["no ```training-job block found in the issue body"] };
  const fields = {};
  const errors = [];
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) { errors.push(`unparseable line: "${line.slice(0, 60)}"`); continue; }
    fields[kv[1]] = kv[2].trim();
  }
  if (!fields.script) errors.push("missing required field: script");
  else if (!SCRIPT_ALLOWLIST.includes(fields.script)) {
    errors.push(`script not on allowlist: ${fields.script.slice(0, 80)}`);
  }
  if (fields.args && !ARGS_RE.test(fields.args)) errors.push("args contain disallowed characters");
  if (fields.vram_gb && !/^\d{1,4}$/.test(fields.vram_gb)) errors.push("vram_gb must be a plain integer");
  return { fields, errors };
}

function listJobs() {
  const now = Date.now();
  if (_cache.data && now - _cache.ts < CACHE_TTL_MS) return _cache.data;
  // Sync like queue.js's gh call; the 60s cache keeps the event-loop cost rare.
  const out = safeExec([
    "gh", "issue", "list", "--repo", GH_REPO, "--label", LABEL, "--state", "open",
    "--json", "number,title,body,labels,updatedAt,url", "--limit", "50",
  ], { timeout: 15_000 });
  const issues = JSON.parse(out || "[]");
  const jobs = issues.map((i) => {
    const { fields, errors } = parseJobBlock(i.body);
    return {
      issue: i.number,
      title: i.title,
      url: i.url,
      updatedAt: i.updatedAt,
      job: fields,
      valid: errors.length === 0,
      errors,
    };
  });
  _cache = { ts: now, data: jobs };
  return jobs;
}

module.exports = async function trainingJobsRoutes(req, res, url, deps) {
  const { sendJson } = deps;

  if (url.pathname === "/api/training-jobs" && req.method === "GET") {
    try {
      const jobs = listJobs();
      sendJson(res, { ok: true, label: LABEL, allowlist: SCRIPT_ALLOWLIST, jobs }, 200);
    } catch (e) {
      sendJson(res, { ok: false, error: "GitHub CLI unreachable — check gh auth on the server", detail: String(e.message || e).slice(0, 200) }, 502);
    }
    return true;
  }

  return false;
};

module.exports._parseJobBlock = parseJobBlock; // unit-test seam
