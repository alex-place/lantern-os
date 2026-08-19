"use strict";

/**
 * twin-machine-bind.js — attach REAL models to the twin core (lib/twin-machine.js).
 *
 * The core is pure; this is the only file that knows what A and B actually are. Both ride the
 * existing verify-model transport (lib/verify-llm.js callVerifyModel), which already falls
 * through anthropic → openai → gemini → xai → ollama, so nothing new is wired for networking.
 *
 * WHY B IS BUILT THE WAY IT IS — the gloss trap, designed against.
 * This repo measured that a model's stated confidence tracks WRITING STYLE, not truth (the
 * 2026-07-06 de-gloss: a probe at AUROC 1.0 on glossed text fell to chance de-glossed). So B
 * is not asked "how confident are you" and it is NEVER shown A's own confidence language as
 * something to weigh. B is asked to do a specific, checkable job: list the concrete ways the
 * answer could be wrong, say whether any action could settle it, and emit ONE number. That is
 * still a model's opinion — but it is an opinion about falsifiability, not about vibes, and
 * the core grades it against reality whenever reality arrives.
 *
 * B IS A DIFFERENT CALL, NOT A DIFFERENT MODEL — yet. Today A and B may resolve to the same
 * provider. That is the echo risk the design names, and it is why `perturbationTest()` exists:
 * two B's that share every blind spot will fail it, and the core will say so. The destination
 * is B = the in-house verifier-first model (ADR-0024 A1); until it exists, B is the frontier
 * asked a different question, and it is labelled as such in every envelope.
 */

const twin = require("./twin-machine");

let _call = null;
function _transport() {
  if (_call) return _call;
  return require("./verify-llm").callVerifyModel;
}
function _setTransport(fn) { _call = fn; }     // test seam

const A_PROMPT = (q) =>
  `Answer the question directly and concisely. If you are not sure, say what you would need to check.\n\nQuestion: ${q}\n\nAnswer:`;

// B never sees "how confident is A". B sees the question and the answer, and is asked a job.
const B_PROMPT = (q, answerText) =>
  `You are an auditor. You do NOT answer the question. You judge an answer someone else gave.

Question: ${q}
Their answer: ${answerText}

Do exactly this:
1. List the concrete ways this answer could be WRONG (facts that could be false, steps that could fail, assumptions it leans on). Be specific. Ignore how confident the answer sounds — tone is not evidence.
2. Say whether ANY action could settle it: a test to run, a source to check, a measurement to take. If nothing could, say "UNREACHABLE".
3. Give ONE probability, 0.00 to 1.00, that the answer is wrong.

Reply in exactly this format, nothing else:
WAYS_WRONG: <semicolon-separated list>
RESOLVABLE: <YES or UNREACHABLE>
PROBE: <the single most informative action, or NONE>
P_WRONG: <number>`;

function _parseB(text) {
  const t = String(text || "");
  const p = t.match(/P_WRONG:\s*([01](?:\.\d+)?|\.\d+)/i);
  const r = t.match(/RESOLVABLE:\s*(YES|UNREACHABLE)/i);
  const w = t.match(/WAYS_WRONG:\s*(.+)/i);
  const pr = t.match(/PROBE:\s*(.+)/i);
  if (!p) return null;                           // no number → B did not do its job → fail closed upstream
  return {
    pWrong: Math.max(0, Math.min(1, parseFloat(p[1]))),
    canResolve: r ? r[1].toUpperCase() !== "UNREACHABLE" : true,
    reason: w ? w[1].trim().slice(0, 400) : null,
    probe: pr && !/^NONE$/i.test(pr[1].trim()) ? { question: pr[1].trim().slice(0, 300) } : null,
  };
}

/** A: the answerer. Rides the frontier fall-through. */
async function realA(question) {
  const q = typeof question === "string" ? question : question.text;
  const r = await _transport()(A_PROMPT(q), { maxTokens: 400 });
  if (!r) return { text: null, error: "no provider answered" };
  return { text: r.text, provider: r.provider };
}

/** B: the auditor. Same transport, different job. Returns a NUMBER or fails closed. */
async function realB(question, answer) {
  const q = typeof question === "string" ? question : question.text;
  if (!answer || !answer.text) {
    return { pWrong: 1, reason: "no answer to audit", canResolve: true, probe: null };
  }
  const r = await _transport()(B_PROMPT(q, answer.text), { maxTokens: 300 });
  const parsed = r ? _parseB(r.text) : null;
  if (!parsed) {
    // B did not return a number. The core treats a thrown B as fail-closed; do the same here
    // explicitly rather than inventing a pWrong — an invented number is the gloss trap again.
    throw new Error("B returned no parseable P_WRONG");
  }
  return { ...parsed, provider: r.provider, note: "B is the frontier asked a different question, not yet the in-house verifier" };
}

/** A bound machine. Same options as twin.create minus a/b. */
function bind(opts = {}) {
  return twin.create({ a: realA, b: realB, ...opts });
}

module.exports = { bind, realA, realB, _parseB, _setTransport, A_PROMPT, B_PROMPT };
