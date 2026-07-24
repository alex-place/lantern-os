"use strict";

/**
 * Orchestrator–Worker sub-agents (#1392, part of the #1386 frontier-dev epic).
 *
 * Σ₀ framing: this is Reason/Act DELEGATION inside the ONE loop — NOT a separate
 * agent ecosystem (which CLAUDE.md forbids). A manager decomposes a task into
 * specialist sub-agents; each runs with its OWN ISOLATED CONTEXT (only its subtask
 * + its role prompt, NO shared chat history — the key difference from
 * swarm-orchestrator's councils, where every provider sees the same input); a
 * synthesizer merges the outputs into one answer. Every worker + the final answer
 * emit a Convergence Record.
 *
 * It is extension, not sprawl: every model call reuses swarmOrchestrate({mode:
 * "single"}) — the existing provider chain + fallback — so there is NO new model
 * path, no new provider logic. The model-call + record deps are injectable so the
 * orchestration logic is unit-testable without a live model (live end-to-end is
 * verified through the dream-chat UI).
 */

const { swarmOrchestrate } = require("./swarm-orchestrator");
const { emitConvergenceRecord } = require("./convergence-records");

const MAX_WORKERS = 4;
// Sub-agent model calls use the "chat" job chain (gemini-first) rather than
// "reasoning" (openai/deepseek/anthropic): on this project the gemini/Vertex path
// is the funded, reliable one, and the chain still falls back across providers.
// Override the provider entirely with KEYSTONE_AGENTS_PROVIDER if needed.
const WORKER_JOB = "chat";

/**
 * Extract the first balanced JSON object from model text. Tolerates ```json fences
 * and surrounding prose (weak local models love to wrap JSON in chatter). Returns
 * the parsed object, or null.
 */
function extractJson(text) {
  if (typeof text !== "string") return null;
  const t = text.replace(/```/g, ""); // drop any code fences; JSON is located by brace-matching below
  const start = t.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * Manager step: split the task into 1–MAX_WORKERS independent worker specs. Robust:
 * any parse/model failure degrades to a single generalist worker doing the whole
 * task (so the flow always produces an answer).
 * @returns {Promise<Array<{name,role,task}>>}
 */
async function decompose(task, systemPrompt, orchestrate = swarmOrchestrate, provider) {
  const planPrompt =
    `${systemPrompt}\n\nYou are an ORCHESTRATOR. Break the user's task into 1-${MAX_WORKERS} ` +
    `INDEPENDENT subtasks that specialist sub-agents can solve in parallel WITHOUT seeing ` +
    `each other's work. Prefer fewer, well-scoped subtasks. Reply with ONLY JSON, no prose:\n` +
    `{"workers":[{"name":"short-id","role":"one-line specialty","task":"self-contained instruction"}]}`;
  let specs = [];
  try {
    const r = await orchestrate({ job: WORKER_JOB, mode: "single", provider, systemPrompt: planPrompt, message: task, history: [] });
    const parsed = extractJson(r && r.text);
    if (parsed && Array.isArray(parsed.workers)) specs = parsed.workers;
  } catch {
    /* fall through to the single-worker fallback */
  }
  specs = specs
    .filter((w) => w && typeof w.task === "string" && w.task.trim())
    .slice(0, MAX_WORKERS)
    .map((w, i) => ({ name: String(w.name || `worker-${i + 1}`).trim(), role: String(w.role || "specialist").trim(), task: String(w.task).trim() }));
  if (!specs.length) specs = [{ name: "worker-1", role: "generalist", task: String(task) }];
  return specs;
}

/**
 * Run every worker spec CONCURRENTLY, each with an isolated context (its own role
 * system prompt + only its subtask as the message; history is empty by design).
 * Each worker emits a Convergence Record. Never rejects — a failed worker is
 * captured as { ok:false }.
 */
async function runWorkers(specs, baseSystemPrompt, opts = {}) {
  const orchestrate = opts.orchestrate || swarmOrchestrate;
  const emit = opts.emit || emitConvergenceRecord;
  const { onWorkerStart, onWorkerDone, workerId = "orchestrator", provider } = opts;
  return Promise.all(
    specs.map(async (spec) => {
      const name = spec.name || "worker";
      const role = spec.role || "specialist";
      if (onWorkerStart) onWorkerStart(name, role);
      let text = "";
      let ok = true;
      let error = null;
      try {
        const sys =
          `${baseSystemPrompt}\n\nYou are sub-agent "${name}" — a ${role}. Work ONLY on your ` +
          `assigned subtask below. You cannot see the user's wider conversation or other ` +
          `sub-agents' work. Be concise, concrete, and self-contained.`;
        const r = await orchestrate({ job: WORKER_JOB, mode: "single", provider, systemPrompt: sys, message: spec.task, history: [] });
        text = (r && r.text) || "";
        if (!text.trim()) { ok = false; error = "empty_output"; }
      } catch (e) {
        ok = false;
        error = (e && e.message) || "worker_failed";
      }
      if (onWorkerDone) onWorkerDone(name, ok, error);
      try {
        await emit({
          hypothesis: `sub-agent ${name} (${role}) completes: ${String(spec.task).slice(0, 160)}`,
          result: ok ? text.slice(0, 2000) : `failed: ${error}`,
          confidence: ok ? 0.6 : 0.0,
          reasoner: `orchestrator-worker/${name}`,
          verified: false,
          source: `orchestrator/${workerId}/${name}`,
        });
      } catch {
        /* record emission is best-effort */
      }
      return { name, role, task: spec.task, ok, text, error };
    })
  );
}

/**
 * Synthesizer step: merge worker outputs into one answer. 0 good → honest failure
 * note; 1 good → return it directly; >1 → a synthesis model call (with a stitch
 * fallback if that call fails). Returns { text, provider, model }.
 */
async function synthesize(task, workers, systemPrompt, orchestrate = swarmOrchestrate, provider) {
  const good = workers.filter((w) => w.ok && w.text && w.text.trim());
  if (!good.length) return { text: "All sub-agents failed to produce output. Try rephrasing the task.", provider: null, model: null };
  if (good.length === 1) return { text: good[0].text, provider: "orchestrator", model: "single-worker" };
  const brief = good.map((w) => `### ${w.name} (${w.role})\n${w.text}`).join("\n\n");
  const sys =
    `${systemPrompt}\n\nYou are the SYNTHESIZER. Merge the specialist sub-agent outputs below ` +
    `into ONE coherent, non-repetitive answer to the user's task. Resolve any conflicts; ` +
    `integrate, don't just concatenate.`;
  try {
    const r = await orchestrate({ job: WORKER_JOB, mode: "single", provider, systemPrompt: sys, message: `Task: ${task}\n\nSub-agent outputs:\n\n${brief}`, history: [] });
    if (r && r.text && r.text.trim()) return { text: r.text, provider: r.provider, model: r.model };
  } catch {
    /* fall through to a deterministic stitch */
  }
  return { text: good.map((w) => `**${w.name}** (${w.role}): ${w.text}`).join("\n\n"), provider: "orchestrator", model: "stitch-fallback" };
}

/**
 * Full orchestrator flow: decompose → isolated workers (parallel) → synthesize.
 * Progress callbacks (onPhase/onWorkerStart/onWorkerDone) drive the SSE UI. Deps
 * (orchestrate/emit) are injectable for tests.
 * @returns {Promise<{synthesis, workers, specs}>}
 */
async function runOrchestrator(task, opts = {}) {
  const orchestrate = opts.orchestrate || swarmOrchestrate;
  const emit = opts.emit || emitConvergenceRecord;
  const { systemPrompt = "", workerId = "orchestrator", provider, onPhase, onWorkerStart, onWorkerDone } = opts;

  if (onPhase) onPhase("decompose");
  const specs = await decompose(task, systemPrompt, orchestrate, provider);
  if (onPhase) onPhase("workers", { count: specs.length, workers: specs.map((s) => ({ name: s.name, role: s.role })) });

  const workers = await runWorkers(specs, systemPrompt, { orchestrate, emit, onWorkerStart, onWorkerDone, workerId, provider });

  if (onPhase) onPhase("synthesize");
  const synthesis = await synthesize(task, workers, systemPrompt, orchestrate, provider);

  try {
    await emit({
      hypothesis: `orchestrator answers: ${String(task).slice(0, 200)}`,
      result: String(synthesis.text).slice(0, 2000),
      confidence: 0.7,
      reasoner: "orchestrator-synthesis",
      verified: false,
      evidence_ids: workers.filter((w) => w.ok).map((w) => w.name),
      source: `orchestrator/${workerId}`,
    });
  } catch {
    /* best-effort */
  }
  return { synthesis, workers, specs };
}

module.exports = { runOrchestrator, decompose, runWorkers, synthesize, extractJson, MAX_WORKERS };
