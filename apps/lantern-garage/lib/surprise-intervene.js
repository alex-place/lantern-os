// Σ₀ ADR-0017: surprise-gated decoding — spend the canary (Verify → Act coupling).
//
// stream-surprise.js (#1678) captures per-token surprise bits during streaming;
// until now nothing ACTED on it. This module is the intervention controller:
// when the rolling windowed surprise of a reply crosses a calibrated threshold,
// a grounding round fires through three arbitrated arms —
//   1. CSF/KC memory retrieval  (Remember — knowledge-router.answer)
//   2. tool execution           (Act — safe local arithmetic; injectable runTool)
//   3. web search               (Observe — web-search-client.webSearch)
// — and, when grounding is found, one grounded revise pass rewrites the reply
// with the evidence in context (post-hoc path: providers without decode control;
// the local rewind-and-resume path lands with the ouro_serve integration).
//
// Contract (mirrors stream-surprise.js):
//   • Default OFF. SURPRISE_INTERVENE=1 enables; read dynamically per call.
//   • Never worse than baseline: any arm error, deadline, or empty grounding
//     → the original reply is returned unchanged and the event is logged.
//   • Max SURPRISE_INTERVENE_ROUNDS grounding rounds (default 2), hard per-arm
//     deadline SURPRISE_INTERVENE_ARM_MS (default 4000 ms — the web arm's DNS
//     phase is NOT covered by socket timeouts, so every arm races a deadline).
//   • Every round emits a convergence record {claim, evidence, confidence, source}.
"use strict";

const { surpriseField } = require("./token-surprise");

function enabled() {
  return process.env.SURPRISE_INTERVENE === "1";
}

function _cfg() {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    window: n(process.env.SURPRISE_INTERVENE_WINDOW, 16),
    // Trigger when the WINDOW MEAN surprise (bits/token) crosses this. The Layer-1
    // separation lives in mean/p90 (tailMass degenerate) — mean is the stable one.
    thresholdBits: n(process.env.SURPRISE_INTERVENE_BITS, 5),
    maxRounds: n(process.env.SURPRISE_INTERVENE_ROUNDS, 2),
    armDeadlineMs: n(process.env.SURPRISE_INTERVENE_ARM_MS, 4000),
  };
}

// ── Trigger scan ─────────────────────────────────────────────────────────────
// Offline pass over the per-token bits array: find non-overlapping windows whose
// mean surprise crosses the threshold. Returns spans sorted by mean, capped at
// maxRounds — these are the claims the model was most likely guessing.
function findTriggerSpans(perToken, opts = {}) {
  const { window: W, thresholdBits, maxRounds } = { ..._cfg(), ...opts };
  const toks = (perToken || []).filter((t) => t && Number.isFinite(t.bits));
  if (toks.length < W) return [];
  const spans = [];
  let i = 0;
  while (i + W <= toks.length) {
    let sum = 0;
    for (let j = i; j < i + W; j++) sum += toks[j].bits;
    const mean = sum / W;
    if (mean >= thresholdBits) {
      spans.push({
        start: i, end: i + W, meanBits: Number(mean.toFixed(3)),
        text: toks.slice(i, i + W).map((t) => t.token).join(""),
      });
      i += W; // non-overlapping; also acts as cooldown
    } else i++;
  }
  spans.sort((a, b) => b.meanBits - a.meanBits);
  return spans.slice(0, maxRounds);
}

// ── Span classifier ──────────────────────────────────────────────────────────
// 'computable' → prefer the tool arm (a verified execution beats retrieved text);
// 'factual'    → memory then web; 'none' → memory only (cheap, then give up).
const _ARITH_RE = /\d+(?:\.\d+)?\s*[-+*/%^]\s*\d+(?:\.\d+)?/;
const _FACTUAL_RE = /\d{2,}|[A-Z][a-z]+\s+[A-Z][a-z]+|(?:19|20)\d{2}|%|\$|°/;
function classifySpan(text) {
  const t = String(text || "");
  if (_ARITH_RE.test(t)) return "computable";
  if (_FACTUAL_RE.test(t)) return "factual";
  return "none";
}

// ── Deadline helper ──────────────────────────────────────────────────────────
// Promise.race with a timer that always clears (autowork web-hang lesson: DNS
// resolution sits OUTSIDE socket timeouts, so the race is the only real bound).
function withDeadline(promise, ms, label) {
  let timer;
  const gate = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label}_deadline`)), ms); });
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}

// ── Arms ─────────────────────────────────────────────────────────────────────
// Each returns {arm, ok, evidence, confidence, source} or null. All deps are
// injectable for tests; defaults lazy-require the real modules so this file
// stays loadable in minimal environments.
function _defaultArms() {
  return {
    memory: async (span) => {
      const kr = require("./knowledge-router");
      const a = kr.answer(span);
      if (!a || !a.hit) return null;
      return { arm: "memory", ok: true, evidence: String(a.text).slice(0, 800),
               confidence: Math.min(1, Number(a.score) || 0.5), source: `kc:${a.source}#${a.heading}` };
    },
    tool: async (span) => {
      // Phase-1 verified computation: safe arithmetic (shunting-free — Function-less,
      // digits/operators only, evaluated by a tiny recursive parser). A correct
      // execution is the strongest grounding and stamps observable confidence 1.0.
      const m = String(span).match(_ARITH_RE);
      if (!m) return null;
      const value = _safeArith(m[0]);
      if (value == null) return null;
      return { arm: "tool", ok: true, evidence: `${m[0].replace(/\s+/g, "")} = ${value}`,
               confidence: 1.0, source: "tool:arith" };
    },
    web: async (span) => {
      const wsc = require("./web-search-client");
      const r = await wsc.webSearch(String(span).slice(0, 160), 3);
      if (!r || !r.success || !Array.isArray(r.results) || !r.results.length) return null;
      const top = r.results.slice(0, 2)
        .map((x) => `${x.title || ""}: ${(x.snippet || x.description || "").slice(0, 240)} [${x.url || ""}]`)
        .join("\n");
      return { arm: "web", ok: true, evidence: top, confidence: 0.7, source: "web-search" };
    },
  };
}

// Minimal safe arithmetic on "a op b" (binary only — that is all _ARITH_RE admits).
function _safeArith(expr) {
  const m = String(expr).match(/^(\d+(?:\.\d+)?)\s*([-+*/%^])\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[3]);
  const v = { "+": a + b, "-": a - b, "*": a * b, "/": b === 0 ? null : a / b, "%": b === 0 ? null : a % b, "^": Math.pow(a, b) }[m[2]];
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(6));
}

// Arbitration order per ADR-0017: memory first always (cheapest); computable
// spans then try tool before web; factual spans web after memory miss.
function armOrder(cls) {
  if (cls === "computable") return ["memory", "tool", "web"];
  if (cls === "factual") return ["memory", "web"];
  return ["memory"];
}

async function groundSpan(span, deps = {}) {
  const cfg = _cfg();
  const arms = { ..._defaultArms(), ...(deps.arms || {}) };
  const cls = classifySpan(span.text);
  for (const name of armOrder(cls)) {
    try {
      const r = await withDeadline(Promise.resolve(arms[name](span.text)), cfg.armDeadlineMs, name);
      if (r && r.ok && r.evidence) return { ...r, class: cls };
    } catch { /* arm error/deadline → next arm; never break the reply */ }
  }
  return null;
}

// ── The post-hoc intervention (cloud path) ───────────────────────────────────
// perToken: accumulator.value() ([{token,bits}] or null). callLLM(prompt) → text,
// supplied by the provider branch. emit(obj) surfaces SSE progress (optional).
// Returns { intervened, revisedReply, rounds, field } — revisedReply null when
// no trigger, no grounding, or the revise call failed (caller keeps original).
async function maybeIntervene({ perToken, fullReply, callLLM, emit, arms } = {}) {
  const none = { intervened: false, revisedReply: null, rounds: [], field: null };
  if (!enabled() || !Array.isArray(perToken) || !perToken.length || !fullReply) return none;
  const spans = findTriggerSpans(perToken);
  if (!spans.length) return none;

  const rounds = [];
  for (const span of spans) {
    if (emit) try { emit({ type: "intervention", phase: "trigger", meanBits: span.meanBits, span: span.text.slice(0, 120) }); } catch { /* SSE best-effort */ }
    const g = await groundSpan(span, { arms });
    rounds.push({ span: span.text.slice(0, 200), meanBits: span.meanBits, grounded: !!g, ...(g || {}) });
    if (g) {
      try {
        const { emitConvergenceRecord } = require("./convergence-records");
        emitConvergenceRecord({
          hypothesis: `high-surprise claim: ${span.text.slice(0, 160)}`,
          result: "grounded", confidence: g.confidence, source: g.source,
          reasoner: "surprise-intervene", verified: g.arm === "tool",
          applied_evidence: [g.evidence.slice(0, 400)],
        }).catch(() => {});
      } catch { /* record emission must never break a reply */ }
      if (emit) try { emit({ type: "intervention", phase: "grounded", arm: g.arm, source: g.source }); } catch { /* SSE best-effort */ }
    }
  }

  const grounded = rounds.filter((r) => r.grounded);
  if (!grounded.length || typeof callLLM !== "function") return { ...none, intervened: rounds.length > 0, rounds };

  const evidenceBlock = grounded
    .map((r, i) => `[E${i + 1}] (${r.source}, confidence ${r.confidence}) ${r.evidence}`)
    .join("\n");
  const prompt =
    `Your draft reply contained claims stated with high internal uncertainty. ` +
    `Revise the draft so those claims agree with the evidence below; change NOTHING else ` +
    `(keep length, tone, and structure). If the evidence contradicts a claim, correct it and ` +
    `cite the evidence tag inline like [E1]. If the evidence is irrelevant, keep the draft as-is.\n\n` +
    `EVIDENCE:\n${evidenceBlock}\n\nDRAFT:\n${fullReply}\n\nREVISED:`;

  try {
    const revised = await withDeadline(Promise.resolve(callLLM(prompt)), _cfg().armDeadlineMs * 2, "revise");
    const text = typeof revised === "string" ? revised.trim() : "";
    // Guard: an empty or wildly shrunken revision is worse than the original.
    if (!text || text.length < fullReply.length * 0.3) return { intervened: true, revisedReply: null, rounds, field: surpriseField(perToken) };
    return { intervened: true, revisedReply: text, rounds, field: surpriseField(perToken) };
  } catch {
    return { intervened: true, revisedReply: null, rounds, field: surpriseField(perToken) };
  }
}

// ── Revise-call helper for OpenAI-compatible providers ──────────────────────
// One non-streaming completion for the grounded revise pass, so provider
// branches in stream-chat.js pass {host, apiKey, model} instead of a closure
// over their own request plumbing. Uses the shared TLS-gated agent.
function openaiCompatibleReviser({ host, apiKey, model }) {
  return (prompt) => new Promise((resolve, reject) => {
    const https = require("https");
    const { llmAgent } = require("./insecure-tls");
    const payload = JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0 });
    const req = https.request({
      agent: llmAgent, hostname: host, path: "/v1/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`, "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(buf).choices?.[0]?.message?.content || ""); }
        catch (e) { reject(e); }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(_cfg().armDeadlineMs * 2, () => { req.destroy(); reject(new Error("revise_timeout")); });
    req.write(payload); req.end();
  });
}

module.exports = {
  openaiCompatibleReviser,
  enabled,
  findTriggerSpans,
  classifySpan,
  groundSpan,
  maybeIntervene,
  withDeadline,
  armOrder,
  _safeArith,
};
