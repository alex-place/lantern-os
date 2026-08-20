"use strict";
// The bench list -- ideas for a human to pipette.
//
// pipeline.js only admits a candidate if this repo can execute it as (assay, knob, value). That
// keeps the automated loop honest and it also throws away every idea worth having: the ones that
// need a GPU, a dataset, a new mechanism, a week of someone's time. Robin has the same split and
// resolves it the same way -- its actual human-facing output is a RANKED LIST OF PROPOSALS that a
// scientist then runs at the bench. This is that half.
//
// The rules that carry over from the automated loop, because an unexecuted idea is exactly where
// a pipeline is most likely to flatter itself:
//   GROUNDED     every idea is generated against retrieved papers and carries their arXiv ids.
//                Ideas whose review retrieved nothing are marked ungrounded, not hidden.
//   SHAM ARM     an inert proposal is ranked alongside the real ones, in disguise. If it places
//                in the top half, the ranking is measuring plausibility and the list says so.
//   FALSIFIABLE  each idea must state the experiment, the measurement, and the result that would
//                kill it. A proposal with no falsifier is not a hypothesis.
//   NOT MEASURED nothing here has been run. The list is labelled that way at the top, every time.
//
// Recency: the corpus index is BM25 only, so "cutting edge" is not something the ranking gives
// for free. We retrieve a wide pool and split it into MOST RELEVANT and MOST RECENT, showing the
// generator both, so the newest work is in front of it rather than buried under older, more
// keyword-dense papers.

const btl = require("./btl");
const agents = require("./agents");

const SHAM = {
  title: "Standardise numeric formatting across evaluation outputs to four decimal places",
  mechanism: "Inconsistent precision between harnesses makes results hard to compare and can hide "
           + "small regressions, so normalising the output format improves the reliability of every "
           + "downstream comparison.",
  experiment: "Apply the format to all harnesses and re-run the current suite.",
  falsifier: "No change in any measured quantity.",
  needs: "an afternoon",
  cost: "low",
  sham: true,
};

const FIELDS = ["title", "mechanism", "experiment", "falsifier", "needs", "cost"];

// Models wrap JSON-lines in a code fence about as often as not, and a fenced reply parsed to
// zero ideas with zero malformed -- a silent failure that reads as "the model had no ideas".
// Fences are stripped and a whole-reply array is accepted; anything still unparseable is COUNTED.
function parseIdeas(text) {
  const out = [];
  let malformed = 0;
  const body = String(text || "").replace(/```[a-zA-Z]*/g, "").trim();
  if (body.startsWith("[")) {
    try {
      const arr = JSON.parse(body);
      if (Array.isArray(arr)) {
        for (const o of arr) {
          if (!o || !o.title || !o.mechanism) { malformed++; continue; }
          const idea = {};
          for (const f of FIELDS) idea[f] = String(o[f] || "").slice(0, 900);
          out.push(idea);
        }
        return { ideas: out, malformed };
      }
    } catch { /* not an array reply -- fall through to line mode */ }
  }
  for (const line of body.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const o = JSON.parse(s);
      if (!o.title || !o.mechanism) { malformed++; continue; }
      const idea = {};
      for (const f of FIELDS) idea[f] = String(o[f] || "").slice(0, 900);
      out.push(idea);
    } catch { malformed++; }
  }
  return { ideas: out, malformed };
}

// Retrieve a wide pool once, then show the generator two views of it.
function retrieve(goal, k = 40, recent = 8, relevant = 10) {
  const idx = agents.corpus();
  if (!idx || !idx.isAvailable()) return { relevant: [], recent: [], available: false };
  const pool = idx.queryArxiv(goal, k) || [];
  const byDate = [...pool].sort((a, b) => String(b.published || "").localeCompare(String(a.published || "")));
  const top = pool.slice(0, relevant);
  const topIds = new Set(top.map((p) => p.id));
  return { relevant: top, recent: byDate.filter((p) => !topIds.has(p.id)).slice(0, recent),
           available: true, pool: pool.length };
}

function paperBlock(papers) {
  return papers.map((p) => `[${p.id}] (${(p.published || "").slice(0, 10)}) ${p.title}\n${(p.snippet || "").slice(0, 420)}`).join("\n\n");
}

// Batch 2 is told which titles batch 1 produced and restates one anyway -- the first live run
// returned "Test-Time Sampling with Depth-Entropy Guided Decoding" and "Test-Time Depth-Entropy
// Sampling on Small Models" as separate ideas, which then padded the ranking with a vote for
// itself. Exact-title matching does not catch that; token overlap does.
const STOP = new Set(["a", "an", "the", "of", "on", "in", "for", "with", "and", "to", "via", "using", "by"]);

function titleTokens(t) {
  return new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w)));
}

function nearDuplicate(a, b, bar = 0.6) {
  const A = titleTokens(a), B = titleTokens(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size) >= bar;
}

async function genBatch(llm, goal, lit, want, already) {
  const avoid = already.length
    ? `Already proposed, do not repeat or restate these:\n${already.map((t) => `- ${t}`).join("\n")}\n\n` : "";
  return llm(
    `You are proposing experiments for a small team to run at the bench. They have: this codebase, `
    + `a few consumer GPUs, cloud GPU hours they must pay for, the frontier APIs, and their own time. `
    + `They cannot train a frontier model from scratch.\n\n`
    + `GOAL: ${goal}\n\n`
    + (lit.relevant.length ? `MOST RELEVANT RETRIEVED WORK:\n${paperBlock(lit.relevant)}\n\n` : "")
    + (lit.recent.length ? `MOST RECENT RETRIEVED WORK:\n${paperBlock(lit.recent)}\n\n` : "")
    + avoid
    + `Propose ${want} DISTINCT experiments. Each one must be something reality could refuse: a `
    + `concrete mechanism, a concrete measurement, and a concrete result that would kill it. `
    + `Prefer ideas that the retrieved work makes plausible but has not already settled. Do not `
    + `propose literature reviews, surveys, or "investigate whether" -- propose a thing to DO.\n\n`
    + `Output exactly ${want} lines, each ONE JSON object, no code fence, no other text. Keep every `
    + `field under 45 words:\n`
    + `{"title":"...","mechanism":"why this changes the quantity, concretely","experiment":"what to run",`
    + `"falsifier":"the result that kills it","needs":"what it costs them: hardware, data, time",`
    + `"cost":"low|medium|high"}`, 1600);
}

async function millIdeas(goal, opts = {}) {
  const llm = opts.llm || agents.defaultLlm();
  const n = opts.n || 10;
  const log = opts.log || (() => {});
  const lit = retrieve(goal, opts.corpusK || 40);
  log("corpus", { available: lit.available, pool: lit.pool || 0, relevant: lit.relevant.length, recent: lit.recent.length });

  // Generated in BATCHES. Ten ideas with six prose fields each does not fit one reply: the
  // provider truncates mid-object, every line fails to parse, and the run reports "0 ideas,
  // 0 malformed" -- which reads as "the model had nothing to say" when it actually had too much.
  // Measured on the first live run of this file.
  const batch = opts.batch || 4;
  const ideas = [];
  let malformed = 0;
  let raw = "";
  for (let done = 0; done < n; done += batch) {
    const want = Math.min(batch, n - done);
    const text = await genBatch(llm, goal, lit, want, ideas.map((i) => i.title));
    raw += String(text || "") + "\n";
    const got = parseIdeas(text);
    malformed += got.malformed;
    for (const idea of got.ideas) {
      if (!ideas.some((x) => nearDuplicate(x.title, idea.title))) ideas.push(idea);
    }
    log("batch", { asked: want, parsed: got.ideas.length, malformed: got.malformed, kept: ideas.length });
  }
  const parsed = { ideas, malformed };
  log("generated", { n: ideas.length, malformed });
  if (!ideas.length) {
    // Say WHY, with the evidence. A generation failure and an empty model are different problems.
    log("generation_failed", { reply_chars: raw.trim().length, head: raw.trim().slice(0, 200) });
    return { goal, ideas: [], malformed, lit, raw_head: raw.trim().slice(0, 800) };
  }

  for (const idea of parsed.ideas) {
    const f = await agents.falcon({ title: idea.title, rationale: idea.mechanism, assay: "bench", params: {} }, goal, { llm });
    idea.review = f.text;
    idea.citations = f.citations;
    idea.grounded = f.grounded;
  }

  const pool = [...parsed.ideas, { ...SHAM, review: "MECHANISM: consistent formatting aids comparison. "
    + "EVIDENCE: none retrieved. WHAT WOULD FALSIFY IT: no measured quantity moves. RISK: none.",
    citations: [], grounded: false }];
  const ranked = await btl.rank(pool, async (a, b, i, j) => {
    const v = await agents.judge({ title: a.title, rationale: a.mechanism, assay: "bench", params: {}, report: a.review },
                                 { title: b.title, rationale: b.mechanism, assay: "bench", params: {}, report: b.review },
                                 goal, { llm });
    return v.winner === "A" ? i : v.winner === "B" ? j : null;
  }, { seed: opts.seed || 1 });

  const shamRank = ranked.order.findIndex((r) => r.item.sham) + 1;
  log("ranked", { pairs: ranked.pairs, sham_rank: shamRank, of: pool.length });
  return {
    goal,
    malformed: parsed.malformed,
    lit,
    pairs: ranked.pairs,
    sham_rank: shamRank,
    of: pool.length,
    sham_control_held: shamRank > Math.ceil(pool.length / 2),
    ideas: ranked.order.filter((r) => !r.item.sham).map((r, i) => ({
      rank: i + 1, strength: Number(r.strength.toFixed(4)), wins: r.wins, comparisons: r.comparisons, ...r.item,
    })),
  };
}

function renderMarkdown(result, meta = {}) {
  const L = [];
  L.push(`# Bench list — ${result.goal}`);
  L.push("");
  L.push(`**NOTHING HERE HAS BEEN RUN.** These are ranked proposals, not results. The ranking is a `
       + `Bradley-Terry-Luce fit over ${result.pairs} pairwise judgements; it says which ideas an `
       + `LLM judge preferred given the retrieved literature, and nothing about whether they work.`);
  L.push("");
  const c = result.sham_control_held
    ? `**Sham control held.** An inert proposal was ranked in disguise alongside these and placed `
      + `${result.sham_rank} of ${result.of}, so the ranking is not simply rewarding plausible prose.`
    : `**SHAM CONTROL FAILED.** An inert proposal placed ${result.sham_rank} of ${result.of}. The `
      + `ranking below is measuring plausibility, not merit — read the ideas, ignore the order.`;
  L.push(c);
  const ungrounded = result.ideas.filter((i) => !i.grounded).length;
  L.push("");
  L.push(`Corpus: ${result.lit.available ? `${result.lit.pool} papers retrieved, `
    + `${result.lit.relevant.length} most relevant + ${result.lit.recent.length} most recent shown to the generator`
    : "**no local arXiv corpus was available** — these ideas are ungrounded"}. `
    + `${ungrounded} of ${result.ideas.length} ideas below retrieved no supporting paper.`
    + (meta.generated ? ` Generated ${meta.generated}.` : ""));
  L.push("");
  L.push("---");
  for (const i of result.ideas) {
    L.push("");
    L.push(`## ${i.rank}. ${i.title}`);
    L.push("");
    L.push(`**Cost:** ${i.cost || "unstated"} · **BTL strength** ${i.strength} (${i.wins}/${i.comparisons} pairwise wins)`
         + (i.grounded ? "" : " · **ungrounded — no supporting paper retrieved**"));
    L.push("");
    L.push(`**Mechanism.** ${i.mechanism}`);
    L.push("");
    L.push(`**Run this.** ${i.experiment}`);
    L.push("");
    L.push(`**Kills it.** ${i.falsifier}`);
    L.push("");
    L.push(`**Needs from you.** ${i.needs}`);
    if (i.citations && i.citations.length) {
      L.push("");
      L.push(`**Retrieved:** ${i.citations.map((x) => `\`${x}\``).join(", ")}`);
    }
    if (i.review) {
      L.push("");
      L.push("<details><summary>Sceptical review</summary>");
      L.push("");
      L.push(i.review);
      L.push("");
      L.push("</details>");
    }
  }
  L.push("");
  return L.join("\n");
}

module.exports = { millIdeas, renderMarkdown, parseIdeas, retrieve, nearDuplicate, SHAM };
