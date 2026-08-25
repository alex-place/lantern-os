"use strict";
// The four agents, mapped onto what this repo already has.
//
//   Robin                     here
//   -----------------------   ------------------------------------------------------------
//   Crow   (concise lit)      crow()   BM25 over the local arXiv corpus + one LLM summary
//   Falcon (deep lit report)  falcon() same corpus, more documents, a structured report
//   LLM judge (pairwise)      judge()  pairwise verdict as JSON, consumed by btl.js
//   Finch  (data analysis)    finch()  RUN the assay as a subprocess and read its result
//
// Every agent takes an injected `llm` so the pipeline is testable without a network. The default
// is lib/verify-llm.js callVerifyModel, which is already provider-agnostic with a fallback chain
// -- the repo's "models are replaceable" rule applied here rather than pinning o4-mini and
// Claude 3.7 the way Robin's notebook does.
//
// GROUNDING. crow/falcon return {text, citations:[arxivId]}. A candidate with zero citations is
// marked ungrounded, and the pipeline reports how many of its finalists were ungrounded. This is
// the repo's external-reality rule: [claim, evidence, confidence, source] or it does not count.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { ASSAYS, ROOT } = require("./assays");

function defaultLlm() {
  const { callVerifyModel } = require(path.join(ROOT, "apps", "lantern-garage", "lib", "verify-llm"));
  return async (prompt, maxTokens = 900) => {
    const r = await callVerifyModel(prompt, { maxTokens });
    return r ? r.text : null;
  };
}

function corpus() {
  try {
    return require(path.join(ROOT, "apps", "lantern-garage", "lib", "arxiv-index"));
  } catch {
    return null;
  }
}

// ── Crow: retrieve, then summarise ────────────────────────────────────────────────────────
async function crow(question, { llm, k = 6 } = {}) {
  const idx = corpus();
  const papers = idx && idx.isAvailable() ? (idx.queryArxiv(question, k) || []) : [];
  const citations = papers.map((p) => p.id);
  if (!papers.length) {
    return { text: "", citations: [], papers: [], grounded: false,
             note: idx && idx.isAvailable() ? "corpus returned nothing for this query" : "no local arXiv corpus" };
  }
  const block = papers.map((p, i) => `[${i + 1}] ${p.id} ${p.title}\n${(p.snippet || "").slice(0, 700)}`).join("\n\n");
  const prompt = `You are summarising retrieved literature for an engineering decision. Question:\n${question}\n\n`
    + `Retrieved papers:\n${block}\n\n`
    + `Write at most 180 words. State only what these papers support, cite as [n], and end with a line `
    + `"UNSUPPORTED:" listing any part of the question the retrieved papers do not answer.`;
  const text = (await llm(prompt, 500)) || "";
  return { text, citations, papers, grounded: citations.length > 0, note: "" };
}

// ── Falcon: the deep per-candidate report ─────────────────────────────────────────────────
async function falcon(candidate, goal, { llm, k = 8 } = {}) {
  const idx = corpus();
  const q = `${candidate.title} ${candidate.rationale || ""} ${goal}`;
  const papers = idx && idx.isAvailable() ? (idx.queryArxiv(q, k) || []) : [];
  const block = papers.map((p, i) => `[${i + 1}] ${p.id} ${p.title}\n${(p.snippet || "").slice(0, 500)}`).join("\n\n");
  const prompt = `Evaluate one proposed design change, the way a sceptical reviewer would.\n\n`
    + `GOAL: ${goal}\nCHANGE: ${candidate.title}\nMECHANISM CLAIMED: ${candidate.rationale || "(none given)"}\n`
    + `EXPERIMENT IT MAPS TO: assay=${candidate.assay} params=${JSON.stringify(candidate.params || {})}\n\n`
    + (block ? `Retrieved literature:\n${block}\n\n` : `No literature was retrieved for this change.\n\n`)
    + `Answer in four short sections, 200 words total:\nMECHANISM: why it could work, concretely.\n`
    + `EVIDENCE: what the retrieved papers actually support, cited as [n]; say "none" if they do not.\n`
    + `WHAT WOULD FALSIFY IT: the observation that would show it does not work.\n`
    + `RISK: how this could improve the headline number while making the system worse.`;
  const text = (await llm(prompt, 700)) || "";
  return { text, citations: papers.map((p) => p.id), grounded: papers.length > 0 };
}

// ── Judge: one pairwise verdict ───────────────────────────────────────────────────────────
// Robin's judge picks a winner and gives reasoning. Ours must also be allowed to abstain: a
// forced choice between two proposals it cannot separate manufactures a preference, and BTL
// then treats that coin flip as evidence. Abstentions are dropped, not split.
async function judge(a, b, goal, { llm } = {}) {
  const card = (c, n) => `CANDIDATE ${n}: ${c.title}\nmechanism: ${c.rationale || "(none)"}\n`
    + `experiment: ${c.assay} ${JSON.stringify(c.params || {})}\nreview: ${(c.report || "").slice(0, 900)}`;
  const prompt = `You are choosing which of two proposed design changes to spend an experiment on.\n\n`
    + `GOAL: ${goal}\n\n${card(a, "A")}\n\n${card(b, "B")}\n\n`
    + `Judge on: is the mechanism concrete, is it supported by the cited evidence, would the named `
    + `experiment actually discriminate it, and would a win be a real improvement rather than a `
    + `metric artefact. Ignore writing quality and length.\n\n`
    + `Reply with ONE line of JSON and nothing else: {"winner":"A"|"B"|"TIE","why":"<15 words"}`;
  const text = (await llm(prompt, 200)) || "";
  const m = text.match(/\{[^{}]*"winner"[^{}]*\}/);
  if (!m) return { winner: null, why: "unparseable judge reply" };
  try {
    const v = JSON.parse(m[0]);
    const w = String(v.winner || "").toUpperCase();
    return { winner: w === "A" || w === "B" ? w : null, why: String(v.why || "").slice(0, 120) };
  } catch {
    return { winner: null, why: "unparseable judge reply" };
  }
}

// ── Finch: actually run the experiment ────────────────────────────────────────────────────
function runProcess(cmd, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, shell: false });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill(); resolve({ code: -1, out, err: err + "\nTIMEOUT" }); }, timeoutMs);
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e) }); });
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

function lastJsonLine(text) {
  const lines = String(text).trim().split(/\r?\n/).reverse();
  for (const l of lines) {
    const s = l.trim();
    if (s.startsWith("{") && s.endsWith("}")) {
      try { return JSON.parse(s); } catch { /* keep looking */ }
    }
  }
  return null;
}

async function finch(candidate, { timeoutMs } = {}) {
  const a = ASSAYS[candidate.assay];
  const args = a.args(candidate.params || {});
  const env = a.env ? a.env(candidate.params || {}) : {};
  const limit = timeoutMs || (a.seconds + 120) * 1000;
  const started = Date.now();
  const r = await runProcess(a.cmd, args, env, limit);
  const wall = Math.round((Date.now() - started) / 1000);
  if (r.code !== 0) {
    return { ok: false, reason: `exit ${r.code}`, stderr: r.err.slice(-1200), wall_s: wall,
             cmd: [a.cmd, ...args].join(" "), env };
  }
  let result = null;
  if (a.stdout_json) result = lastJsonLine(r.out);
  else {
    const f = path.join(ROOT, a.result);
    if (fs.existsSync(f)) { try { result = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* below */ } }
  }
  if (!result) return { ok: false, reason: "no parseable result", stdout: r.out.slice(-800), wall_s: wall,
                        cmd: [a.cmd, ...args].join(" "), env };
  let metric = null, control = null, noise = null;
  try { metric = a.metric(result); } catch (e) { return { ok: false, reason: `metric: ${e.message}`, wall_s: wall }; }
  try { control = a.control(result); } catch { control = null; }
  try { noise = a.noise ? a.noise(result) : null; } catch { noise = null; }
  return { ok: true, metric, control, noise, control_what: a.control_what, wall_s: wall, result,
           cmd: [a.cmd, ...args].join(" "), env };
}

module.exports = { crow, falcon, judge, finch, defaultLlm, corpus, lastJsonLine, runProcess };
