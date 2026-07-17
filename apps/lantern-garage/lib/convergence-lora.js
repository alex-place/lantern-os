"use strict";
/**
 * convergence-lora.js — LoRA fine-tuning pipeline for convergence prediction
 *
 * Replaces mock Claude API calls with real Anthropic API calls (issue #597).
 * Reads convergence records, distils training pairs via Claude, and triggers
 * local LoRA training every TRAIN_EVERY examples.
 *
 * State machine:
 *   idle → collecting → training → idle
 *
 * State is persisted in data/convergence-lora-state.json.
 * Training pairs land in data/training/convergence-lora-training.jsonl.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const STATE_PATH = path.join(REPO_ROOT, "data", "convergence-lora-state.json");
const TRAINING_DIR = path.join(REPO_ROOT, "data", "training");
const PAIRS_PATH = path.join(TRAINING_DIR, "convergence-lora-training.jsonl");
const CONVERGENCE_LOG = path.join(REPO_ROOT, "data", "agent-fleet", "tesseract-convergence.jsonl");

const TRAIN_EVERY = parseInt(process.env.LORA_TRAIN_EVERY || "100", 10);
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 800;

// ── State helpers ─────────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {
      status: "idle",
      examplesCollected: 0,
      activeJobId: null,
      lastTrainedAt: null,
      lastError: null,
      jobs: [],
    };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

function appendPair(pair) {
  fs.mkdirSync(TRAINING_DIR, { recursive: true });
  fs.appendFileSync(PAIRS_PATH, JSON.stringify(pair) + "\n", "utf8");
}

// ── Claude API call ───────────────────────────────────────────────────────────

function callClaude(prompt, apiKey, attempt = 1) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          if (res.statusCode >= 500 && attempt < MAX_RETRIES) {
            setTimeout(
              () => callClaude(prompt, apiKey, attempt + 1).then(resolve).catch(reject),
              RETRY_DELAY_MS * 2 ** (attempt - 1)
            );
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode >= 400) {
              reject(new Error(`Claude API ${res.statusCode}: ${parsed.error?.message || raw}`));
              return;
            }
            resolve(parsed.content?.[0]?.text || "");
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", (e) => {
      if (attempt < MAX_RETRIES) {
        setTimeout(
          () => callClaude(prompt, apiKey, attempt + 1).then(resolve).catch(reject),
          RETRY_DELAY_MS * 2 ** (attempt - 1)
        );
      } else {
        reject(e);
      }
    });
    req.setTimeout(30000, () => {
      req.destroy(new Error("Claude API request timed out"));
    });
    req.write(body);
    req.end();
  });
}

// ── Record reader ─────────────────────────────────────────────────────────────

function readConvergenceRecords(limit = 20) {
  if (!fs.existsSync(CONVERGENCE_LOG)) return [];
  const lines = fs.readFileSync(CONVERGENCE_LOG, "utf8").trim().split("\n").filter(Boolean);
  return lines
    .slice(-limit)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ── Distil one convergence record into a training pair ────────────────────────

async function distilRecord(record, apiKey) {
  const phases = (record.phases || []).map((p) => `${p.name}=${p.status}`).join(", ");
  const prompt =
    `You are a convergence prediction trainer. Given this convergence loop result:\n` +
    `Score: ${record.convergence_score ?? "?"}\n` +
    `Status: ${record.status ?? "?"}\n` +
    `Phases: ${phases}\n\n` +
    `Output a JSON object with exactly two fields:\n` +
    `{"input": "<1-sentence summary of the run>", "output": "<1-sentence prediction rule>"}`;

  const text = await callClaude(prompt, apiKey);
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) throw new Error("Claude response did not contain JSON");
  const pair = JSON.parse(match[0]);
  pair.source_record_timestamp = record.timestamp;
  pair.convergence_score = record.convergence_score;
  return pair;
}

// ── Trigger local LoRA training ───────────────────────────────────────────────

function triggerLocalTraining(state) {
  const scriptPath = path.join(REPO_ROOT, "scripts", "train-convergence-lora.py");
  if (!fs.existsSync(scriptPath)) {
    // DELIBERATE STUB (#2543 audit decision): the flywheel's job is to COLLECT
    // verified convergence→distillation pairs (see collectAndMaybeTrainAsync); the
    // local-training launcher is a future step. train-convergence-lora.py has never
    // existed, so this returns a no-op sentinel instead of spawning a missing script.
    // When a trainer is added, drop it at scripts/train-convergence-lora.py and this
    // path activates unchanged — the collected pairs at PAIRS_PATH are its input.
    return `no-op:script-missing:${scriptPath}`;
  }
  const jobId = `lora-${Date.now()}`;
  const outputDir = path.join(REPO_ROOT, "data", "models", "lora", `convergence-${jobId}`);
  fs.mkdirSync(outputDir, { recursive: true });
  const logPath = path.join(outputDir, "training.log");
  const py = process.platform === "win32" ? "python" : "python3";
  const proc = spawn(
    py,
    [scriptPath, "--pairs", PAIRS_PATH, "--output_dir", outputDir],
    { cwd: REPO_ROOT, detached: true, stdio: ["ignore", fs.openSync(logPath, "w"), fs.openSync(logPath, "a")] }
  );
  fs.writeFileSync(path.join(outputDir, "training.pid"), String(proc.pid), "utf8");
  proc.unref();
  return jobId;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Process up to `batchSize` convergence records, generate training pairs via
 * Claude API, persist pairs, and trigger local training at the TRAIN_EVERY threshold.
 *
 * @param {object} opts
 * @param {string} opts.apiKey   - Anthropic API key
 * @param {number} [opts.batchSize=5] - records to process per call
 * @returns {Promise<{added: number, total: number, trainTriggered: boolean, jobId?: string}>}
 */
async function collectAndMaybeTrainAsync({ apiKey, batchSize = 5 } = {}) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY required for convergence-lora");

  const state = loadState();
  if (state.status === "training") {
    return { added: 0, total: state.examplesCollected, trainTriggered: false, note: "training in progress" };
  }

  state.status = "collecting";
  state.lastError = null;
  saveState(state);

  const records = readConvergenceRecords(batchSize);
  let added = 0;

  for (const rec of records) {
    try {
      const pair = await distilRecord(rec, apiKey);
      appendPair(pair);
      added++;
      state.examplesCollected = (state.examplesCollected || 0) + 1;
      saveState(state);
    } catch (err) {
      state.lastError = err.message;
      saveState(state);
    }
  }

  let trainTriggered = false;
  let jobId;
  if (state.examplesCollected >= TRAIN_EVERY) {
    state.status = "training";
    jobId = triggerLocalTraining(state);
    state.activeJobId = jobId;
    state.lastTrainedAt = new Date().toISOString();
    state.examplesCollected = 0;
    state.jobs = [...(state.jobs || []), { jobId, startedAt: state.lastTrainedAt }];
    trainTriggered = true;
    saveState(state);
  } else {
    state.status = "idle";
    saveState(state);
  }

  return { added, total: state.examplesCollected, trainTriggered, jobId };
}

/**
 * Sync wrapper for routes that prefer callbacks.
 */
function collectAndMaybeTrain(opts, callback) {
  collectAndMaybeTrainAsync(opts)
    .then((r) => callback(null, r))
    .catch((e) => callback(e));
}

/** Return current state without triggering any API calls. */
function getState() {
  return loadState();
}

module.exports = { collectAndMaybeTrain, collectAndMaybeTrainAsync, getState };
