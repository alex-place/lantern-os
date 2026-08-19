"use strict";
// Robin's stage graph, rebuilt for LLM design.
//
// Robin (arXiv:2505.13400) runs, in a fixed order:
//   goal -> literature queries -> literature -> candidate ASSAYS -> ranked -> chosen assay
//        -> literature -> candidate TREATMENTS -> deep reports -> ranked -> run -> analyse
//        -> insights -> next round
// Their own Methods section notes the agentic version "almost always called tools in the same
// order", so they rewrote it as a deterministic notebook. This is written deterministic from the
// start, for the same reason: the value is in the pipeline, not in letting a model choose the
// order.
//
// WHAT IS DIFFERENT HERE, and why:
//
// 1. RUNNABILITY IS ENFORCED. A candidate must name (assay, knob, value) that assays.js can
//    actually execute. Unrunnable proposals are kept in the report as `unrunnable` with the
//    reason -- an idea that cannot be tested is not a hypothesis, it is a suggestion.
// 2. THERE IS A SHAM ARM. A deliberately inert candidate is added before ranking, in disguise.
//    If the judge ranks the sham above real candidates, the ranking is measuring plausibility
//    rather than merit, and the run says so. Robin has no such control: nothing in the paper
//    asks what the ranker does when a proposal is empty.
// 3. THE ASSAY CARRIES ITS OWN NULL CONTROL. Each result reports whether the assay's control
//    held. A candidate that improves the headline number while breaking the control is reported
//    as a REGRESSION, never as a discovery.
// 4. BASELINE FIRST. The chosen assay is run once with default knobs before any candidate, so
//    "better" means better than a measured baseline from the same machine on the same day --
//    not better than a number in a previous commit.
//
// Returns a report object; run_robin_llm.js prints it and writes it to results/.

const btl = require("./btl");
const agents = require("./agents");
const { ASSAYS, validate, list } = require("./assays");

const SHAM = {
  title: "Re-order the candidate list alphabetically before scoring",
  rationale: "Presentation order is known to bias sequential evaluation, so normalising it should "
           + "reduce variance in which observable is chosen.",
  assay: null, params: {}, sham: true,
};

function parseCandidates(text, fallbackAssay) {
  // The generator is asked for one JSON object per line. Anything unparseable is dropped and
  // counted -- a silently-repaired malformed proposal is a proposal we did not actually receive.
  const out = [];
  let malformed = 0;
  for (const line of String(text || "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const o = JSON.parse(s);
      if (!o.title) { malformed++; continue; }
      out.push({ title: String(o.title).slice(0, 160), rationale: String(o.rationale || "").slice(0, 700),
                 assay: o.assay || fallbackAssay, params: o.params && typeof o.params === "object" ? o.params : {} });
    } catch { malformed++; }
  }
  return { candidates: out, malformed };
}

function knobDoc(assayName) {
  const a = ASSAYS[assayName];
  return Object.entries(a.knobs).map(([k, s]) =>
    `  ${k} (${s.type}${s.min !== undefined ? `, ${s.min}..${s.max}` : ""}, default ${s.default}) -- ${s.what}`).join("\n");
}

// The verdict rule, kept out of run() so it can be tested without spawning anything.
// The band is the WIDER of the two runs' own bands: a delta smaller than the sampling error of
// either measurement is not a result, it is the seeds moving.
function verdictFor(f, baseline) {
  const band = Math.max(baseline.noise || 0, f.noise || 0);
  const delta = f.ok ? f.metric - baseline.metric : null;
  const verdict = !f.ok ? "FAILED"
    : f.control === false ? "REGRESSION (control broken)"
    : delta > band ? "IMPROVED"
    : delta < -band ? "WORSE"
    : "WITHIN NOISE";
  return { band, delta, verdict };
}

async function run(goal, opts = {}) {
  const llm = opts.llm || agents.defaultLlm();
  const nCandidates = opts.candidates || 8;
  const available = opts.available || {};
  const log = opts.log || (() => {});
  const report = { goal, stages: [], started: opts.now || null };

  // ── STAGE 1: assay selection ────────────────────────────────────────────────────────────
  // Robin invents assays and ranks them. We can only run what exists, so the choice is over the
  // registry -- ranked by an LLM on fit to the goal, but constrained to what is executable.
  const runnable = list(available).filter((a) => a.available);
  if (!runnable.length) throw new Error("no assay is available in this environment");
  const litQ = `Which measurable property of a reasoning or language-model system does this goal turn on: ${goal}`;
  const lit = await agents.crow(litQ, { llm });
  log("literature", { citations: lit.citations.length, note: lit.note });
  report.stages.push({ stage: "literature", citations: lit.citations, note: lit.note, text: lit.text });

  let assay = opts.assay;
  if (!assay) {
    const menu = runnable.map((a) => `- ${a.name}: ${ASSAYS[a.name].what} (about ${a.seconds}s)`).join("\n");
    const pick = await llm(`GOAL: ${goal}\n\nAvailable experiments:\n${menu}\n\n`
      + `Which single experiment most directly discriminates changes aimed at this goal? `
      + `Reply with one line of JSON: {"assay":"<name>","why":"<20 words"}`, 150);
    const m = String(pick || "").match(/\{[^{}]*"assay"[^{}]*\}/);
    let why = "";
    if (m) { try { const v = JSON.parse(m[0]); if (ASSAYS[v.assay] && runnable.some((r) => r.name === v.assay)) { assay = v.assay; why = v.why; } } catch { /* fall through */ } }
    if (!assay) assay = runnable[0].name;
    report.stages.push({ stage: "assay_selected", assay, why });
    log("assay", { assay, why });
  }

  // ── STAGE 2: baseline ───────────────────────────────────────────────────────────────────
  // Measured now, on this machine, before anything is proposed. Every later comparison is
  // against this number.
  const baseline = await agents.finch({ assay, params: opts.baselineParams || {} });
  report.stages.push({ stage: "baseline", assay, ...baseline, result: undefined });
  report.baseline = baseline;
  log("baseline", { ok: baseline.ok, metric: baseline.metric, noise: baseline.noise,
                    control: baseline.control, wall_s: baseline.wall_s });
  if (!baseline.ok) { report.verdict = `baseline run failed: ${baseline.reason}`; return report; }

  // ── STAGE 3: candidate generation ───────────────────────────────────────────────────────
  const lit2 = await agents.crow(`${goal} -- what is known about the mechanisms behind it`, { llm, k: 8 });
  const gen = await llm(
    `You are proposing design changes to test, one experiment at a time.\n\n`
    + `GOAL: ${goal}\n\nEXPERIMENT: ${assay} -- ${ASSAYS[assay].what}\n`
    + `Measured baseline right now: ${baseline.metric}\n\n`
    + `You may only change these knobs:\n${knobDoc(assay)}\n\n`
    + (lit2.text ? `Relevant literature:\n${lit2.text}\n\n` : "")
    + `Propose ${nCandidates} DISTINCT changes. Each must name a concrete mechanism -- why that `
    + `knob moving in that direction changes the measured quantity. Do not propose changes you `
    + `cannot express as knob values.\n\n`
    + `Output exactly ${nCandidates} lines, each ONE JSON object and nothing else:\n`
    + `{"title":"...","rationale":"...","assay":"${assay}","params":{"<knob>":<value>}}`, 1400);
  const parsed = parseCandidates(gen, assay);
  log("generated", { n: parsed.candidates.length, malformed: parsed.malformed });

  const admitted = [], unrunnable = [];
  for (const c of parsed.candidates) {
    const v = validate(c);
    if (v.ok && Object.keys(c.params).length) admitted.push(c);
    else unrunnable.push({ ...c, reason: v.ok ? "sets no knob" : v.reason });
  }
  report.stages.push({ stage: "candidates", generated: parsed.candidates.length, malformed: parsed.malformed,
                       admitted: admitted.length, unrunnable });
  if (!admitted.length) { report.verdict = "no runnable candidate was produced"; return report; }

  // ── STAGE 4: deep reports, then the sham, then BTL ranking ──────────────────────────────
  for (const c of admitted) {
    const f = await agents.falcon(c, goal, { llm });
    c.report = f.text; c.citations = f.citations; c.grounded = f.grounded;
  }
  const sham = { ...SHAM, assay, params: {}, report: "MECHANISM: normalising presentation order removes "
    + "an ordering bias. EVIDENCE: none retrieved. WHAT WOULD FALSIFY IT: no change in the metric. "
    + "RISK: none." };
  const pool = [...admitted, sham];
  const ranked = await btl.rank(pool, async (a, b, i, j) => {
    const v = await agents.judge(a, b, goal, { llm });
    return v.winner === "A" ? i : v.winner === "B" ? j : null;
  }, { seed: opts.seed || 1 });
  const shamRank = ranked.order.findIndex((r) => r.item.sham) + 1;
  report.stages.push({ stage: "ranked", pairs: ranked.pairs, sham_rank: shamRank, of: pool.length,
                       order: ranked.order.map((r) => ({ title: r.item.title, strength: Number(r.strength.toFixed(4)),
                                                         wins: r.wins, comparisons: r.comparisons, sham: !!r.item.sham })) });
  const shamControlHeld = shamRank > Math.ceil(pool.length / 2);
  log("ranked", { pairs: ranked.pairs, sham_rank: shamRank, of: pool.length, control_held: shamControlHeld });

  // ── STAGE 5: run the top candidates and interpret ───────────────────────────────────────
  const toRun = ranked.order.filter((r) => !r.item.sham).slice(0, opts.top || 2);
  const results = [];
  for (const r of toRun) {
    const f = await agents.finch(r.item);
    const { band, delta, verdict } = verdictFor(f, baseline);
    results.push({ title: r.item.title, params: r.item.params, strength: r.strength, grounded: !!r.item.grounded,
                   ok: f.ok, metric: f.metric, baseline: baseline.metric, delta, noise_band: band,
                   control: f.control, control_what: f.control_what, wall_s: f.wall_s, reason: f.reason, verdict });
    log("ran", { title: r.item.title, metric: f.metric, baseline: baseline.metric,
                 band: band === 0 ? 0 : Number(band.toPrecision(2)), verdict });
  }
  report.results = results;

  const improved = results.filter((r) => r.verdict === "IMPROVED");
  const interp = await llm(
    `An experiment round finished. Interpret it for the next round.\n\nGOAL: ${goal}\nEXPERIMENT: ${assay}\n`
    + `Baseline: ${baseline.metric}\n`
    + `Noise band on this measurement: ${(results[0] && results[0].noise_band) || 0}. A change inside it means nothing.\n`
    + results.map((r) => `- ${r.title} ${JSON.stringify(r.params)} -> ${r.metric} (${r.verdict})`).join("\n")
    + `\n\nIn under 140 words: what does this rule out, what does it suggest, and what is the single `
    + `most informative next change to test? Say plainly if the round shows nothing.`, 400);
  report.interpretation = interp || "";

  report.controls = {
    sham_rank: shamRank, of: pool.length, sham_control_held: shamControlHeld,
    assay_control_held: results.every((r) => r.control !== false),
    ungrounded_finalists: results.filter((r) => !r.grounded).length,
  };
  report.verdict = !shamControlHeld
    ? `RANKING NOT TRUSTED: the inert sham candidate ranked ${shamRank} of ${pool.length}`
    : improved.length
      ? `${improved.length} of ${results.length} candidates beat the measured baseline by more than its noise band`
      : `no candidate beat the measured baseline by more than its noise band (+/-${(results[0] && results[0].noise_band) || 0})`;
  return report;
}

module.exports = { run, parseCandidates, verdictFor, SHAM };
