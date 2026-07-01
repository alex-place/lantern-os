"use strict";
/**
 * Research Task — a persisted, resumable long-running research job.
 *
 * A single wideSearch() pass answers one question; a real research TASK keeps
 * going across multiple rounds — each round widening/deepening on the gaps the
 * previous round left open — until either nothing is left to cover or a round
 * cap is hit, and it survives across chat turns (and server restarts) as a
 * plain JSON file so "!research continue <id>" can pick a long job back up
 * instead of re-starting from zero. This is the Task object (goal + status)
 * CLAUDE.md's four-object model calls for, scoped to the research workload.
 */
const fs = require("fs");
const path = require("path");
const { wideSearch } = require("./wide-search");

let callLlm = null;
try { ({ callLlm } = require("./self-edit-engine")); } catch (_e) { /* optional — degrades to fixed round count */ }

const TASKS_DIR = path.resolve(__dirname, "..", "..", "..", "data", "research-tasks");
// Hard ceiling on total rounds a task will ever run, even across many
// "!research continue" turns — keeps a misbehaving gap-check from looping forever.
const MAX_TOTAL_ROUNDS = parseInt(process.env.RESEARCH_TASK_MAX_ROUNDS || "8", 10);

function _ensureDir() {
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
}

function _slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "topic";
}

function newTaskId(topic) {
  return `${_slug(topic)}-${Date.now().toString(36)}`;
}

function taskPath(id) {
  return path.join(TASKS_DIR, `${id}.json`);
}

function loadTask(id) {
  try {
    return JSON.parse(fs.readFileSync(taskPath(id), "utf8"));
  } catch (_e) {
    return null;
  }
}

/**
 * Find the most recently updated still-running task for a chat session — lets
 * a plain "keep going" / "continue" resume a task without the user having to
 * remember or paste its id, which is how a real person actually talks.
 */
function findLatestRunningTask(sessionId) {
  if (!sessionId) return null;
  try {
    _ensureDir();
    const candidates = fs.readdirSync(TASKS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf8")); } catch { return null; } })
      .filter((t) => t && t.status === "running" && t.sessionId === sessionId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return candidates[0] || null;
  } catch (_e) {
    return null;
  }
}

function saveTask(task) {
  _ensureDir();
  task.updatedAt = new Date().toISOString();
  fs.writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2));
  return task;
}

function createTask(topic, { sessionId = null } = {}) {
  const task = {
    id: newTaskId(topic),
    topic: String(topic || "").trim(),
    sessionId,
    status: "running",
    rounds: [],
    sources: [],       // deduped across all rounds, url -> {n, title, url, snippet}
    latestAnswer: "",
    confidence: 0,
    gaps: [],
    createdAt: new Date().toISOString(),
  };
  return saveTask(task);
}

function _extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start];
  const close = open === "[" ? "]" : "}";
  const end = body.lastIndexOf(close);
  if (end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

/** Ask a model what's still missing given the topic + answer so far. Best-effort. */
async function _gapCheck(topic, answer) {
  if (typeof callLlm !== "function") return [];
  try {
    const raw = await callLlm(
      "You audit research answers for completeness. Given a topic and the current "
        + "answer, reply with ONLY a JSON array of up to 3 short remaining-gap phrases "
        + "(e.g. \"real-world pricing\", \"regulatory status\") that a thorough answer "
        + "should still cover. If the answer is already thorough, reply with [].",
      `Topic: ${topic}\n\nCurrent answer:\n${String(answer).slice(0, 2000)}\n\nRemaining gaps (JSON array):`,
      "auto",
      256
    );
    const parsed = _extractJson(raw);
    return Array.isArray(parsed) ? parsed.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 3) : [];
  } catch (_e) {
    return [];
  }
}

function _mergeSources(task, sources) {
  const byUrl = new Map(task.sources.map((s) => [s.url, s]));
  for (const s of sources || []) {
    if (s.url && !byUrl.has(s.url)) byUrl.set(s.url, s);
  }
  task.sources = [...byUrl.values()].map((s, i) => ({ ...s, n: i + 1 }));
}

/**
 * Run exactly one round of a task: wideSearch on the topic + open gaps, then a
 * completeness gap-check to decide whether another round is warranted.
 * @param {object} task
 * @param {function} [onStep] - (stage, status, extra) sink, wired to SSE.
 */
async function runRound(task, onStep) {
  const roundN = task.rounds.length + 1;
  const query = task.gaps.length
    ? `${task.topic} — additionally address: ${task.gaps.join("; ")}`
    : task.topic;

  const emit = (stage, status, extra) => { try { if (onStep) onStep(stage, status, extra); } catch (_e) { /* ignore */ } };
  emit("round", "start", { round: roundN, query });

  const result = await wideSearch({
    query,
    breadth: 6,
    perQuery: 4,
    onStep: (stage, status, extra) => emit(stage, status, extra),
  });

  _mergeSources(task, result.sources);
  task.latestAnswer = result.answer;
  task.confidence = Math.max(task.confidence, result.confidence || 0);

  emit("round", "gap_check_start", { round: roundN });
  const gaps = roundN >= MAX_TOTAL_ROUNDS ? [] : await _gapCheck(task.topic, result.answer);
  task.gaps = gaps;
  emit("round", "gap_check_done", { round: roundN, gaps });

  task.rounds.push({
    n: roundN,
    query,
    answerPreview: String(result.answer || "").slice(0, 400),
    sourcesFound: (result.sources || []).length,
    confidence: result.confidence,
    gaps,
    at: new Date().toISOString(),
  });

  if (!gaps.length || roundN >= MAX_TOTAL_ROUNDS) task.status = "done";
  saveTask(task);
  emit("round", "done", { round: roundN, status: task.status });
  return task;
}

module.exports = { createTask, loadTask, saveTask, runRound, newTaskId, findLatestRunningTask, MAX_TOTAL_ROUNDS, TASKS_DIR };
