"use strict";
// Milling for ideas that are NOT already done -- and the reason that is dangerous to optimise for.
//
// THE MEASURED PROBLEM. Sixteen ideas milled by bench.js across two goals, audited and then hand
// reviewed: zero novel. Fourteen were placed by the machine, and the two it could not place were
// placed by hand in about two queries each. The cause is structural, not a prompt accident --
// bench.js retrieves papers, shows them to the generator under the heading MOST RELEVANT
// RETRIEVED WORK, and asks for ideas. Retrieval-grounded generation produces retrieval-shaped
// ideas. Three of eight on one list were the TITLE of a paper the generator had just been shown.
//
// WHAT THIS DOES DIFFERENTLY, in the order it matters:
//
//   1. RETRIEVED WORK IS AN EXCLUSION LIST, NOT AN INSPIRATION LIST. Same papers, opposite
//      framing: "these are DONE, proposing any of them is a failed answer".
//   2. OUR OWN NOTEBOOK IS A SECOND EXCLUSION LIST. priorwork.js knows what this lab has already
//      measured; the generator never saw it before, so it kept proposing our own experiments.
//   3. THE FIELD IS MAPPED FIRST. Stage 0 extracts the DESIGN AXES the retrieved work varies
//      along and which values are occupied. Stage 1 proposes into an unoccupied combination.
//      A gap you can name is a gap you can aim at.
//   4. EVERY IDEA MUST NAME ITS OWN CLOSEST PRIOR WORK AND THE DIFFERENCE. An idea that cannot
//      say what it is not is rejected before it reaches the ranking.
//   5. THE AUDIT IS IN THE LOOP. Ideas that come back RESTATES / PORT / ANSWERED-HERE are fed
//      back with the collision named, and the generator tries again. Rounds continue until the
//      target is met or the budget runs out.
//
// THE FAILURE MODE THIS INVITES, and the guard. "Not found in the literature" is trivially
// achieved by being vague, incoherent, or untestable -- optimising for unplaceability selects for
// nonsense. So the sham arm is doubled: alongside the inert-but-plausible sham that bench.js
// uses, there is a VAGUE sham -- impressive-sounding, genuinely unplaceable, and empty. If the
// ranking puts the vague sham in the top half, the run is measuring novelty-flavoured word salad
// and says so. Every idea also still has to state a falsifier and a concrete measurement, which
// is what an unplaceable-because-empty idea cannot do.
//
// WHAT WOULD MAKE THIS WORK, stated as a number before running it: the bench.js baseline is
// 0 of 16 unencumbered, 14 of 16 placed by the machine. This is better if the placed share falls
// AND the vague sham stays in the bottom half. Either alone proves nothing.
//
// AND THE THIRD THING, learned the hard way on the second run. The placed rate fell to 5/8 and
// every one of the three survivors named a ROUND-ONE COLLISION as its own closest prior work:
//   "Epistemic-Controller-Gated Dynamic Parameter Allocation"  <- "...Gated Curriculum"
//   "Prediction-Market-Weighted Ensemble Distillation"         <- "Prediction-Market-Informed RL"
//   "Ledger-Guided Contrastive Fine-Tuning"                    <- "Ledger-Driven Meta-Reasoning FT"
// Telling the generator what it collided with taught it to REPHRASE THE COLLISION until the audit
// stopped recognising it. That is the loop optimising for the measurement rather than the goal,
// and the falling placed rate was measuring evasion. So an idea whose own closest_prior is one of
// our rejected proposals is discarded as EVASION, using the field the generator fills in itself.
//
// AND THE FOURTH, from the run that blocked evasion. The placed rate fell to 2/8 and both shams
// held -- but four of six survivors were "Ledger-Guided/Driven X" and one named a SURVIVOR of the
// same run as its closest prior work. Two more failures, both of which the literature already
// names: the evasion check has to compare against what we KEPT as well as what collided, and
// novelty alone is the wrong objective. The established protocol (see run_rinobench.js header)
// scores generated ideas on quality, novelty AND DIVERSITY -- diversity as the semantic distance
// among the ideas themselves -- precisely because optimising novelty collapses onto one theme.
// So diversity is measured and reported here, and a run that produces six permutations of one
// asset is called what it is.

const btl = require("./btl");
const novelty = require("./novelty");
const priorwork = require("./priorwork");
const agents = require("./agents");
const { retrieve, renderMarkdown, nearDuplicate, SHAM } = require("./bench");

// Assets this lab has that the literature does not. An idea that needs one of these is not
// automatically novel, but it is a long way from a paper's contribution restated -- nobody
// outside can run it. Kept short and CONCRETE: a vague asset list produces vague ideas.
const OUR_ASSETS = [
  "an epistemic controller with pre-registered gates, null worlds and recorded refutations "
  + "(research/epistemic_controller) -- a reasoning loop whose failures are instrumented",
  "a ledger of our own convergence records: hypothesis, evidence, result, confidence, over months",
  "920 merged PRs and 243 agent sessions crystallised into a searchable corpus -- a long "
  + "longitudinal record of one system's own development",
  "a verified cascade in production with measured escalation rates (ADR-0030)",
  "de-glossed honesty probe sets built with a style-matched control (data/eval/v1_10)",
  "live prediction-market and trading outcomes with settled ground truth",
];

const VAGUE_SHAM = {
  title: "Emergent Cross-Scale Representational Alignment for Reasoning Coherence",
  mechanism: "Align latent representational manifolds across model scales so that reasoning "
           + "coherence emerges from cross-scale consistency rather than from parameter count.",
  experiment: "Measure representational alignment across scales and correlate with reasoning coherence.",
  falsifier: "Alignment does not correlate with coherence.",
  needs: "compute, models at several scales",
  cost: "high",
  vague_sham: true,
};

const FIELDS = ["title", "mechanism", "experiment", "falsifier", "needs", "cost",
                "closest_prior", "difference"];

function parseIdeas(text, avoid = []) {
  const out = [];
  let malformed = 0, no_difference = 0, evasion = 0;
  const body = String(text || "").replace(/```[a-zA-Z]*/g, "").trim();
  for (const line of body.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const o = JSON.parse(s);
      if (!o.title || !o.mechanism) { malformed++; continue; }
      // An idea that cannot say what it is NOT has not been checked against anything, and is the
      // shape restatements arrive in. Rejected here rather than at the audit, and counted.
      if (!o.closest_prior || !o.difference || String(o.difference).length < 25) { no_difference++; continue; }
      // EVASION: the idea's own stated closest prior work is something we already proposed and
      // the audit already placed. Rephrasing a rejected proposal is not finding a gap.
      // Compared against what we KEPT as well as what collided: on the evasion-blocked run a
      // survivor named another survivor of the same run as its closest prior work, which is the
      // same dodge one level over.
      if (avoid.some((c) => nearDuplicate(c.title, String(o.closest_prior)))) { evasion++; continue; }
      const idea = {};
      for (const f of FIELDS) idea[f] = String(o[f] || "").slice(0, 900);
      out.push(idea);
    } catch { malformed++; }
  }
  return { ideas: out, malformed, no_difference, evasion };
}

// Mean pairwise vocabulary overlap across the surviving ideas. The established evaluation
// protocol for generated research ideas scores quality, novelty AND diversity, where diversity is
// the semantic distance among the ideas; this is the cheap token-level stand-in for it. Measured
// at 0.23 on the run where four of six survivors were "Ledger-Guided/Driven something", with
// "ledger", "curriculum" and "reasoning" the most repeated words -- a number worth printing next
// to a low placed rate, because the two move together when the generator finds one asset it likes.
function diversity(ideas) {
  const tok = (t) => new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3));
  const sets = ideas.map((i) => tok(`${i.title} ${i.mechanism}`));
  if (sets.length < 2) return { mean_overlap: null, repeated: [] };
  let total = 0, pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      let shared = 0;
      for (const w of sets[i]) if (sets[j].has(w)) shared++;
      total += shared / Math.max(1, Math.min(sets[i].size, sets[j].size));
      pairs++;
    }
  }
  const counts = new Map();
  for (const st of sets) for (const w of st) counts.set(w, (counts.get(w) || 0) + 1);
  const repeated = Array.from(counts.entries()).filter(([, n]) => n >= Math.ceil(sets.length * 0.6))
    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w, n]) => `${w}(${n}/${sets.length})`);
  return { mean_overlap: Number((total / pairs).toFixed(3)), repeated };
}

function paperBlock(papers) {
  return papers.map((p) => `- [${p.id}] ${p.title}`).join("\n");
}

// What this lab has already measured on this goal -- the exclusion list nothing outside can build.
function ourWork(goal, k = 10) {
  const seen = new Map();
  for (const q of [goal, `${goal} experiment measurement result`]) {
    for (const h of priorwork.search(q, k)) if (!seen.has(h.file)) seen.set(h.file, h);
  }
  return Array.from(seen.values()).slice(0, k);
}

function ourBlock(hits) {
  return hits.map((h) => `- [${h.file}] ${h.title}`).join("\n");
}

// ── stage 0: map the field ──────────────────────────────────────────────────────────────────
async function mapAxes(goal, lit, llm) {
  const papers = [...lit.relevant, ...lit.recent];
  if (!papers.length) return { axes: [] };
  const text = await llm(
    `Here is retrieved work on one goal.\n\nGOAL: ${goal}\n\n`
    + papers.map((p) => `[${p.id}] ${p.title}\n${(p.snippet || "").slice(0, 260)}`).join("\n\n")
    + `\n\nName the DESIGN AXES this work varies along -- the choices a method makes -- and for `
    + `each, the values these papers occupy. Axes are things like: what signal is read, at what `
    + `stage it is read, what supervision it needs, what it costs at inference, what it is `
    + `compared against.\n\n`
    + `Reply with ONE line of JSON: {"axes":[{"axis":"...","occupied":["...","..."]}]} -- at most `
    + `six axes.`, 700);
  const m = String(text || "").match(/\{[\s\S]*"axes"[\s\S]*\}/);
  if (!m) return { axes: [] };
  try {
    const v = JSON.parse(m[0]);
    return { axes: Array.isArray(v.axes) ? v.axes.slice(0, 6) : [] };
  } catch { return { axes: [] }; }
}

// ── stage 1: propose into the gaps ──────────────────────────────────────────────────────────
async function genGap(llm, goal, lit, mine, axes, want, collisions, already) {
  const axisBlock = axes.length
    ? axes.map((a) => `- ${a.axis}: occupied by ${(a.occupied || []).join("; ")}`).join("\n")
    : "(no axes extracted)";
  const collisionBlock = collisions.length
    ? `\nYOUR PREVIOUS PROPOSALS THAT WERE ALREADY DONE. These are CLOSED. Do not propose them, do not rephrase them, and do not propose anything whose closest prior work is one of them -- an idea that differs from a closed proposal only in wording is discarded without being read. Go somewhere else on the axes:\n`
      + `differs only in wording:\n${collisions.map((c) => `- "${c.title}" collided with ${c.evidence || "prior work"} (${c.verdict})`).join("\n")}\n`
    : "";
  return llm(
    `You are proposing experiments that DO NOT ALREADY EXIST.\n\nGOAL: ${goal}\n\n`
    + `ALREADY DONE IN THE LITERATURE -- proposing any of these is a failed answer:\n`
    + `${paperBlock([...lit.relevant, ...lit.recent])}\n\n`
    + `ALREADY DONE IN OUR OWN LAB -- also a failed answer:\n${ourBlock(mine)}\n\n`
    + `THE DESIGN AXES THIS FIELD VARIES ALONG, and what is occupied:\n${axisBlock}\n\n`
    + `WHAT THIS LAB HAS THAT NOBODY ELSE DOES:\n${OUR_ASSETS.map((a) => `- ${a}`).join("\n")}\n`
    + collisionBlock
    + (already.length ? `\nAlready proposed this run: ${already.join("; ")}\n` : "")
    + `\nPropose ${want} experiments, each occupying a combination of axis values that NO listed `
    + `work occupies, or exploiting an asset only this lab has. A different application of a `
    + `known method is NOT a gap. A known method with one hyperparameter changed is NOT a gap.\n\n`
    + `Each must still be something reality could refuse: a concrete mechanism, a concrete `
    + `measurement, and a result that would kill it. Vagueness is not novelty -- an idea that `
    + `cannot be falsified will be discarded.\n\n`
    + `Output exactly ${want} lines, each ONE JSON object, no code fence, no other text, every `
    + `field under 45 words:\n`
    + `{"title":"...","mechanism":"why this changes the quantity","experiment":"what to run",`
    + `"falsifier":"the result that kills it","needs":"hardware, data, time",`
    + `"cost":"low|medium|high","closest_prior":"the nearest existing work, named",`
    + `"difference":"what this does that the closest prior work does not"}`, 1800);
}

const PLACED = new Set(["RESTATES", "PORT", "ANSWERED-HERE", "REFUTED-HERE"]);

async function millGaps(goal, opts = {}) {
  const llm = opts.llm || agents.defaultLlm();
  const n = opts.n || 8;
  const rounds = opts.rounds || 3;
  const log = opts.log || (() => {});
  const lit = retrieve(goal, opts.corpusK || 40);
  const mine = ourWork(goal);
  log("corpus", { papers: (lit.relevant.length + lit.recent.length), our_prior_work: mine.length });

  const axes = await mapAxes(goal, lit, llm);
  log("axes", { n: axes.axes.length, axes: axes.axes.map((a) => a.axis) });

  const shown = [...lit.relevant, ...lit.recent];
  const kept = [];          // survived the audit unplaced
  const collisions = [];    // proposed and found to exist; fed back
  let malformed = 0, no_difference = 0, evasion = 0;
  const perRound = [];

  for (let round = 1; round <= rounds && kept.length < n; round++) {
    const want = Math.min(4, n - kept.length);
    const text = await genGap(llm, goal, lit, mine, axes.axes, want, collisions,
                              [...kept, ...collisions].map((i) => i.title));
    const got = parseIdeas(text, [...collisions, ...kept]);
    malformed += got.malformed;
    no_difference += got.no_difference;
    evasion += got.evasion;
    const fresh = got.ideas.filter((i) => ![...kept, ...collisions].some((x) => nearDuplicate(x.title, i.title)));
    log("proposed", { round, parsed: got.ideas.length, malformed: got.malformed,
                      no_difference: got.no_difference, evasion: got.evasion, fresh: fresh.length });

    let placedThisRound = 0;
    for (const idea of fresh) {
      const a = await novelty.auditIdea(idea, { llm }, shown);
      idea.audit = { verdict: a.verdict, evidence: a.evidence, why: a.why, web_queries: a.web_queries,
                     web_searched: !!(a.web && a.web.searched), web_hits: a.web ? a.web.hits.length : 0 };
      if (PLACED.has(a.verdict)) {
        collisions.push({ title: idea.title, verdict: a.verdict, evidence: a.evidence });
        placedThisRound++;
      } else {
        kept.push(idea);
      }
      log("audited", { round, verdict: a.verdict, title: idea.title.slice(0, 42) });
    }
    perRound.push({ round, proposed: fresh.length, placed: placedThisRound, kept: kept.length });
  }

  if (!kept.length) {
    return { goal, ideas: [], collisions, perRound, malformed, no_difference, evasion, lit, axes: axes.axes };
  }

  // Reviews and ranking, with BOTH shams: the inert-plausible one bench.js uses, and a vague one
  // that is genuinely unplaceable and says nothing. If the vague sham ranks well, this run is
  // measuring novelty-flavoured word salad.
  for (const idea of kept) {
    const f = await agents.falcon({ title: idea.title, rationale: idea.mechanism, assay: "bench", params: {} }, goal, { llm });
    idea.review = f.text; idea.citations = f.citations; idea.grounded = f.grounded;
  }
  const pool = [...kept,
    { ...SHAM, review: "MECHANISM: consistent formatting aids comparison. EVIDENCE: none. RISK: none." },
    { ...VAGUE_SHAM, review: "MECHANISM: cross-scale alignment. EVIDENCE: none retrieved. RISK: unclear." }];
  const ranked = await btl.rank(pool, async (a, b, i, j) => {
    const v = await agents.judge({ title: a.title, rationale: a.mechanism, assay: "bench", params: {}, report: a.review },
                                 { title: b.title, rationale: b.mechanism, assay: "bench", params: {}, report: b.review },
                                 goal, { llm });
    return v.winner === "A" ? i : v.winner === "B" ? j : null;
  }, { seed: opts.seed || 1 });

  const shamRank = ranked.order.findIndex((r) => r.item.sham) + 1;
  const vagueRank = ranked.order.findIndex((r) => r.item.vague_sham) + 1;
  const half = Math.ceil(pool.length / 2);
  log("ranked", { pairs: ranked.pairs, sham_rank: shamRank, vague_sham_rank: vagueRank, of: pool.length });

  const proposed = perRound.reduce((s, r) => s + r.proposed, 0);
  const placed = collisions.length;
  return {
    goal, lit, axes: axes.axes, perRound, malformed, no_difference, evasion,
    diversity: diversity(kept),
    proposed, placed, placed_rate: proposed ? placed / proposed : null,
    collisions,
    pairs: ranked.pairs, sham_rank: shamRank, of: pool.length,
    sham_control_held: shamRank > half,
    vague_sham_rank: vagueRank,
    vague_control_held: vagueRank > half,
    ideas: ranked.order.filter((r) => !r.item.sham && !r.item.vague_sham).map((r, i) => ({
      rank: i + 1, strength: Number(r.strength.toFixed(4)), wins: r.wins, comparisons: r.comparisons, ...r.item,
    })),
  };
}

module.exports = { millGaps, mapAxes, parseIdeas, ourWork, diversity, OUR_ASSETS, VAGUE_SHAM, renderMarkdown };
