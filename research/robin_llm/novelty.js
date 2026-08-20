"use strict";
// The novelty audit -- and the reason it cannot return "novel".
//
// WHAT THIS EXISTS TO PREVENT. On 2026-08-20 the first two bench lists were triaged by hand and
// four ideas were called "worth starting". A web-search red team killed two of them in one query
// each:
//   "verification heads on a frozen base"  -> UHeads, ICLR 2026 submission, does exactly that
//   "attention-head sparsity as a signal"  -> arXiv 2505.20045, uncertainty-aware attention heads
// Both had been called novel because the LOCAL CORPUS RETRIEVED NOTHING CLOSE. That inference --
// silence means novelty -- is the single failure this module is built to make impossible.
//
// Two more were already answered inside this repo (a probe ladder, a reranker), which no web
// search would ever surface. So an honest audit needs three sources, and only two of them can be
// consulted automatically here:
//
//   REPO      priorwork.js over 432 experiment scripts, notes, ADRs and result files
//   CORPUS    the local arXiv BM25 index
//   SHOWN     the papers this very idea was generated from
//   WEB       live arXiv API + OpenAlex, via websearch.js
//
// THE WEB LEG IS A SECOND PASS. The first judgement uses local evidence only. If it comes back
// UNVERIFIED -- nothing here matched -- the queries it generated are actually run and the idea is
// judged again with the results in front of it. That ordering matters: the web is searched
// exactly when local silence would otherwise have been mistaken for novelty, which is the failure
// this module exists to prevent, and it costs one extra call only for the ideas that need it.
//
// The repo's own web-search client is NOT used: it falls through to a wiki lookup and returns
// confident nonsense (asked about attention heads and hallucination it returned a Wikipedia
// article on Lewy body dementia, with success:true). websearch.js talks to the scholarly indexes
// directly instead.
//
// Even so, "no match" is still not "novel". Both legs miss OpenReview and other unindexed
// preprints -- UHeads, one of the two papers that killed a novelty claim in the red team, returns
// zero results from both. A searched silence is a stronger silence, not evidence.
//
// THE VERDICT VOCABULARY. Fixed, and deliberately WITHOUT a "novel" value:
//   ANSWERED-HERE   this repo already measured it -- cites the file and the number
//   REFUTED-HERE    this repo measured it and it failed
//   RESTATES        the idea is a retrieved paper's contribution, restated
//   PORT            a published method applied to our setting: legitimate, not new
//   INCREMENTAL     adjacent prior art exists and the idea adds something to it
//   UNVERIFIED      nothing matched locally. THIS IS NOT A NOVELTY CLAIM. It carries the web
//                   queries that would have to come back empty before anyone says "novel".
//
// CONTROLS, run once per audit, because an auditor that never fires is indistinguishable from a
// world with no prior art:
//   plant_restatement  a paper from the shown set, restated as an idea -> must NOT be UNVERIFIED
//   plant_answered     something this repo demonstrably has            -> must be ANSWERED-HERE
// If either fails, every verdict in the run is marked untrusted and the report says so.

const priorwork = require("./priorwork");
const websearch = require("./websearch");
const agents = require("./agents");

const VERDICTS = ["ANSWERED-HERE", "REFUTED-HERE", "RESTATES", "PORT", "INCREMENTAL", "UNVERIFIED"];

const PLANT_ANSWERED = {
  title: "Linear probe on mid-layer hidden states for hallucination detection",
  mechanism: "Train a logistic probe on mid-layer hidden states of an open-weight model and measure "
           + "held-out AUROC for separating truthful from hallucinated answers.",
};

// Query the repo with each field SEPARATELY and union the hits. One combined query dilutes the
// distinctive terms: the cross-layer-norm idea reached its real prior work (the layer-1 surprise
// leak note, 20.9) only through its `experiment` field, and missed it on title+mechanism.
function repoCandidates(idea) {
  const seen = new Map();
  for (const q of [`${idea.title} ${idea.mechanism || ""}`, idea.mechanism || "", idea.experiment || ""]) {
    if (!q.trim()) continue;
    for (const h of priorwork.search(q, 4)) {
      const prev = seen.get(h.file);
      if (!prev || h.score > prev.score) seen.set(h.file, h);
    }
  }
  return Array.from(seen.values()).sort((a, b) => b.score - a.score).slice(0, 6);
}

function candidates(idea, shown = []) {
  const q = `${idea.title} ${idea.mechanism || ""}`;
  const repo = repoCandidates(idea);
  const idx = agents.corpus();
  const corpus = idx && idx.isAvailable() ? (idx.queryArxiv(q, 5) || []) : [];
  // The papers this idea was generated FROM are the likeliest source of a restatement, and they
  // are not necessarily what a fresh query retrieves -- the spectral-rewiring idea scored 0.00
  // against its own re-retrieval while sitting next to the paper it restated in the shown set.
  const shownTop = shown.slice(0, 12);
  return { repo, corpus, shown: shownTop };
}

function block(c) {
  const L = [];
  if (c.repo.length) {
    L.push("OUR OWN PRIOR WORK (this repository):");
    for (const h of c.repo) L.push(`  [${h.file}] ${h.title}\n    ${String(h.snippet).replace(/\s+/g, " ").slice(0, 320)}`);
  } else L.push("OUR OWN PRIOR WORK: nothing matched.");
  if (c.corpus.length) {
    L.push("\nRETRIEVED LITERATURE (fresh query):");
    for (const p of c.corpus) L.push(`  [${p.id}] (${(p.published || "").slice(0, 7)}) ${p.title}`);
  }
  if (c.shown.length) {
    L.push("\nPAPERS THIS IDEA WAS GENERATED FROM:");
    for (const p of c.shown) L.push(`  [${p.id}] ${p.title}`);
  }
  if (c.web && c.web.length) {
    L.push("\nLIVE SEARCH OF arXiv AND OpenAlex FOR THIS IDEA:");
    for (const h of c.web.slice(0, 12)) L.push(`  [${h.source}:${h.id}] (${h.year}) ${h.title}`);
  }
  return L.join("\n");
}

async function judgeOnce(idea, c, llm) {
  const prompt = `You are checking whether a proposed experiment is already done.\n\n`
    + `IDEA: ${idea.title}\nMECHANISM: ${idea.mechanism || "(none)"}\n\n${block(c)}\n\n`
    + `Work through these IN ORDER and stop at the first that applies:\n\n`
    + `1. Is the idea one of the papers listed above -- its title, or the contribution its abstract `
    + `describes? If a listed title says the same thing as the idea's title, that is RESTATES. `
    + `An idea whose title appears in the lists above is NEVER "UNVERIFIED".\n`
    + `2. Is it a method from a paper above, applied to our setting? PORT.\n`
    + `3. Did OUR OWN prior work measure it? ANSWERED-HERE if it did, REFUTED-HERE if it measured `
    + `it and the signal failed. Only choose these if you can name WHAT that file measured -- if `
    + `you cannot say what was measured, it is not the same investigation.\n`
    + `4. Is something above adjacent, with the idea adding to it? INCREMENTAL.\n`
    + `5. Otherwise UNVERIFIED. This does NOT mean novel; it means nothing here matched.\n\n`
    + `For 2-4, match on MECHANISM rather than shared vocabulary: two files about "activations" `
    + `are not automatically the same investigation.\n\n`
    + `Reply with ONE line of JSON: {"verdict":"<one of the six>","evidence":"<the file path or `
    + `arXiv id, or empty>","why":"<20 words>","web_queries":["<query>","<query>"]}\n`
    + `web_queries: two searches that would find prior art if it exists. Always provide them.`;
  const text = (await llm(prompt, 320)) || "";
  const m = text.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (!m) return { verdict: "UNVERIFIED", evidence: "", why: "unparseable audit reply",
                   web_queries: [idea.title], candidates: c, parse_failed: true };
  try {
    const v = JSON.parse(m[0]);
    const verdict = VERDICTS.includes(String(v.verdict).toUpperCase()) ? String(v.verdict).toUpperCase() : "UNVERIFIED";
    const qs = Array.isArray(v.web_queries) ? v.web_queries.filter((x) => typeof x === "string").slice(0, 3) : [];
    return { verdict, evidence: String(v.evidence || "").slice(0, 200), why: String(v.why || "").slice(0, 160),
             web_queries: qs.length ? qs : [idea.title], candidates: c };
  } catch {
    return { verdict: "UNVERIFIED", evidence: "", why: "unparseable audit reply",
             web_queries: [idea.title], candidates: c, parse_failed: true };
  }
}

async function auditIdea(idea, { llm, web = true } = {}, shown = []) {
  const c = candidates(idea, shown);
  const first = await judgeOnce(idea, c, llm);
  if (first.verdict !== "UNVERIFIED" || web === false) {
    return { ...first, web: null, first_pass: first.verdict };
  }
  // Local silence: this is exactly where a novelty claim would have been invented. Search.
  const w = await websearch.searchAll(first.web_queries);
  if (!w.searched || !w.hits.length) {
    return { ...first, web: w, first_pass: first.verdict };
  }
  const second = await judgeOnce(idea, { ...c, web: w.hits }, llm);
  return { ...second, web: w, first_pass: first.verdict };
}

// The auditor is audited. Both plants must come back matched; if either slips through as
// UNVERIFIED the auditor is not detecting prior art and none of its verdicts mean anything.
async function runControls(shown, { llm } = {}) {
  const out = { plants: [] };
  // The plant must read like an IDEA, not like a citation: give it the paper's own abstract as
  // its mechanism and an experiment, so the auditor is judging a proposal rather than a title.
  // The first version passed only the title and the auditor answered UNVERIFIED -- correctly, on
  // what it was shown, which made the control fire on a construction bug rather than a real miss.
  const src = (shown || []).find((p) => p && p.snippet && p.snippet.length > 120) || (shown || [])[0];
  const restated = src
    ? { title: src.title,
        mechanism: String(src.snippet || src.title).replace(/\s+/g, " ").slice(0, 420),
        experiment: `Run exactly what is described above and measure the effect it claims.` }
    : null;
  if (restated) {
    const r = await auditIdea(restated, { llm, web: false }, shown);
    out.plants.push({ plant: "restatement", verdict: r.verdict, pass: r.verdict !== "UNVERIFIED", why: r.why });
  }
  const a = await auditIdea(PLANT_ANSWERED, { llm, web: false }, shown);
  out.plants.push({ plant: "answered-here", verdict: a.verdict,
                    pass: a.verdict === "ANSWERED-HERE" || a.verdict === "REFUTED-HERE", why: a.why });
  out.trusted = out.plants.every((p) => p.pass);
  return out;
}

async function audit(ideas, { llm, shown = [], web = true, log = () => {} } = {}) {
  const controls = await runControls(shown, { llm });
  log("audit_controls", { trusted: controls.trusted, plants: controls.plants.map((p) => `${p.plant}:${p.verdict}`) });
  const audited = [];
  for (const idea of ideas) {
    const a = await auditIdea(idea, { llm, web }, shown);
    audited.push({ ...idea, audit: {
      verdict: a.verdict, evidence: a.evidence, why: a.why, web_queries: a.web_queries,
      trusted: controls.trusted, first_pass: a.first_pass,
      // Recorded so a reader can tell "searched and found nothing" from "never searched".
      web_searched: !!(a.web && a.web.searched),
      web_hits: a.web ? a.web.hits.length : 0,
      web_legs: a.web ? a.web.legs : null,
    } });
    log("audited", { title: idea.title.slice(0, 40), verdict: a.verdict,
                     web: a.web ? `${a.web.hits.length} hits` : "n/a",
                     evidence: (a.evidence || "").slice(0, 40) });
  }
  const counts = {};
  for (const i of audited) counts[i.audit.verdict] = (counts[i.audit.verdict] || 0) + 1;
  return { ideas: audited, controls, counts };
}

module.exports = { audit, auditIdea, runControls, candidates, repoCandidates, VERDICTS, PLANT_ANSWERED };
