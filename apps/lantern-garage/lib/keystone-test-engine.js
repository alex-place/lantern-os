"use strict";
/**
 * unisona.ai Test Engine — Σ₀ convergence chain for autonomous code generation
 *
 * 6-stage chain: Observe → Remember → Reason → Act → Verify → Converge
 * Each stage emits a PhaseRecord { stage, status, evidence, confidence }.
 * Rejection gate: confidence < 60 → no code delivered.
 * All runs appended to data/keystone-test-runs.jsonl.
 *
 * Closes #631
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const RUNS_PATH = path.join(REPO_ROOT, "data", "keystone-test-runs.jsonl");
const WORK_PATH = path.join(REPO_ROOT, "data", "convergence-autonomous-work.jsonl");
const CONFIDENCE_GATE = 60;

// ── Ollama helper ────────────────────────────────────────────────────────────

function _callOllama(systemPrompt, userPrompt) {
  const ollamaBase = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const ollamaModel = process.env.OLLAMA_MODEL || "lantern-csf-dream";
  const timeoutMs = parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 60000;
  const payload = JSON.stringify({
    model: ollamaModel,
    stream: false,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  const url = new URL(ollamaBase);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 11434,
      path: "/api/chat",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => {
        try { resolve(String(JSON.parse(data).message?.content || "").trim()); }
        catch { resolve(""); }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("ollama timeout")); });
    req.write(payload);
    req.end();
  });
}

function _extractConfidence(text) {
  const m = String(text).match(/<CONFIDENCE>\s*(\d+)\s*<\/CONFIDENCE>/i)
    || String(text).match(/confidence[:\s]+(\d+)/i);
  return m ? Math.min(100, Math.max(0, parseInt(m[1], 10))) : null;
}

// ── Sigma-0 system prompt ────────────────────────────────────────────────────

const SIGMA0_PROMPT = `You are unisona.ai Σ₀ — a verification-first coding agent.

Every response MUST use this format exactly:
<REQUIREMENT>State the exact requirement</REQUIREMENT>
<EVIDENCE>File paths and line numbers you examined</EVIDENCE>
<CODE>Complete, copy-paste-ready implementation</CODE>
<VERIFICATION>Exact test command and expected output</VERIFICATION>
<CONFIDENCE>[0-100]</CONFIDENCE>

Rules:
- Never emit code without citing specific file paths in EVIDENCE.
- If confidence < 60, state what is missing — do not provide code.
- No roleplay. Plain technical language only.`;

// ── 6-Stage convergence chain ────────────────────────────────────────────────

async function _stageObserve(requirement) {
  // Observe: classify the requirement
  const evidence = { requirement: requirement.slice(0, 400) };
  const isCoding = /\b(fix|implement|refactor|write|add|remove|debug|test|patch|create|generate)\b/i.test(requirement);
  evidence.task_type = isCoding ? "code_generation" : "query";
  return { stage: "observe", status: "pass", evidence, confidence: 80 };
}

async function _stageRemember(requirement) {
  // Remember: look up relevant existing files
  const evidence = {};
  try {
    const workLines = fs.existsSync(WORK_PATH)
      ? fs.readFileSync(WORK_PATH, "utf8").trim().split("\n").filter(Boolean).slice(-10).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      : [];
    evidence.recent_work_records = workLines.length;
    evidence.recent_accepted = workLines.filter(r => r.accepted).length;
  } catch { evidence.work_log_error = true; }
  return { stage: "remember", status: "pass", evidence, confidence: 75 };
}

async function _stageReason(requirement) {
  // Reason: verify requirements are sound via a lightweight Ollama pass
  const reasonerPrompt = `Analyze this coding requirement and assess whether it is clear, actionable, and technically sound. Score feasibility 0-100.

REQUIREMENT: ${requirement}

Respond in one paragraph and end with: FEASIBILITY: [0-100]`;
  let feasibility = 70;
  let reasoning = "";
  try {
    const raw = await _callOllama("You are a technical requirements analyst. Be concise.", reasonerPrompt);
    reasoning = raw.slice(0, 500);
    const m = raw.match(/FEASIBILITY:\s*(\d+)/i);
    if (m) feasibility = Math.min(100, Math.max(0, parseInt(m[1], 10)));
  } catch (err) {
    reasoning = `reason stage error: ${err.message}`;
    feasibility = 50;
  }
  return { stage: "reason", status: feasibility >= 40 ? "pass" : "hold", evidence: { reasoning, feasibility }, confidence: feasibility };
}

async function _stageAct(requirement, reasonStage) {
  // Act: call Ollama with Σ₀ framing to generate code
  if (reasonStage.status === "hold") {
    return { stage: "act", status: "skipped", evidence: { reason: "reason stage held" }, confidence: 0, code: null };
  }
  const userPrompt = `REQUIREMENT TO IMPLEMENT: ${requirement}\n\nRead relevant files first (cite paths), then respond in the <REQUIREMENT><EVIDENCE><CODE><VERIFICATION><CONFIDENCE> format.`;
  let content = "";
  let confidence = null;
  let code = null;
  try {
    content = await _callOllama(SIGMA0_PROMPT, userPrompt);
    confidence = _extractConfidence(content);
    const codeMatch = content.match(/<CODE>([\s\S]*?)<\/CODE>/i);
    if (codeMatch) code = codeMatch[1].trim();
  } catch (err) {
    content = `act stage error: ${err.message}`;
    confidence = 0;
  }
  const passed = confidence !== null && confidence >= CONFIDENCE_GATE && code !== null;
  return { stage: "act", status: passed ? "pass" : "gate_rejected", evidence: { content: content.slice(0, 800) }, confidence, code };
}

async function _stageVerify(actStage) {
  // Verify: extract and validate the verification command from the model output
  if (actStage.status !== "pass") {
    return { stage: "verify", status: "skipped", evidence: { reason: actStage.status }, confidence: 0 };
  }
  const verifyMatch = String(actStage.evidence.content).match(/<VERIFICATION>([\s\S]*?)<\/VERIFICATION>/i);
  const verificationText = verifyMatch ? verifyMatch[1].trim().slice(0, 300) : "No VERIFICATION tag found";
  const hasVerification = !!verifyMatch && verificationText.length > 10;
  return {
    stage: "verify",
    status: hasVerification ? "pass" : "hold",
    evidence: { verification_text: verificationText, has_verification: hasVerification },
    confidence: hasVerification ? 85 : 40,
  };
}

function _stageConverge(stages, requirement) {
  // Converge: build final evidence chain and convergence record
  const passCount = stages.filter(s => s.status === "pass").length;
  const total = stages.length;
  const overallConfidence = stages.reduce((sum, s) => sum + (s.confidence || 0), 0) / total;
  const actStage = stages.find(s => s.stage === "act");
  const accepted = actStage?.status === "pass" && overallConfidence >= CONFIDENCE_GATE;
  return {
    stage: "converge",
    status: accepted ? "pass" : "hold",
    evidence: {
      phases_passed: passCount,
      phases_total: total,
      overall_confidence: Math.round(overallConfidence),
      accepted,
    },
    confidence: Math.round(overallConfidence),
    code: accepted ? actStage.code : null,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

async function runChain(requirement) {
  const startedAt = new Date().toISOString();
  const observe  = await _stageObserve(requirement);
  const remember = await _stageRemember(requirement);
  const reason   = await _stageReason(requirement);
  const act      = await _stageAct(requirement, reason);
  const verify   = await _stageVerify(act);
  const stages   = [observe, remember, reason, act, verify];
  const converge = _stageConverge(stages, requirement);
  stages.push(converge);

  const run = {
    timestamp: startedAt,
    requirement: requirement.slice(0, 400),
    accepted: converge.evidence.accepted,
    overall_confidence: converge.confidence,
    code: converge.code,
    stages: stages.map(s => ({ stage: s.stage, status: s.status, confidence: s.confidence })),
  };

  // Append to runs log
  try {
    fs.mkdirSync(path.dirname(RUNS_PATH), { recursive: true });
    fs.appendFileSync(RUNS_PATH, JSON.stringify(run) + "\n", "utf8");
  } catch {}

  // Append to autonomous work log
  try {
    fs.appendFileSync(WORK_PATH, JSON.stringify({
      timestamp: startedAt,
      agent: "keystone-test-engine",
      source: converge.evidence.accepted ? "keystone-sigma0" : "keystone-sigma0-rejected",
      request: requirement.slice(0, 200),
      confidence: converge.confidence,
      accepted: converge.evidence.accepted,
    }) + "\n", "utf8");
  } catch {}

  return run;
}

module.exports = { runChain, CONFIDENCE_GATE };
