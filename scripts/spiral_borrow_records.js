"use strict";
/*
 * Spiral (ADR-0030) borrow survey → ConvergenceRecords.
 *
 * "Nothing is accepted without evidence." Each candidate open WEIGHT or TRAINING SET
 * we might borrow to find incremental gains is validated here as one honest
 * ConvergenceRecord (claim / evidence / confidence / source / verified_by). Web-grounded
 * 2026-07-22. Records land in the canonical ledger data/convergence/records.jsonl (which
 * is gitignored); the human-reviewable evidence table is docs/SIGMA0-OURO-CODER.md.
 *
 * Honesty rule (External Reality Rule + the verified_by gate in convergence-records.js):
 * a borrow is `verified:false` until REPRODUCED on our hardware. Only Qwen2.5-Coder-7B is
 * verified — it is our on-box coding-golden result (#2173). Everything else is a
 * vendor/paper-claimed CANDIDATE, sorted behind reproduced peers by the same rule the
 * local-model-registry grounding gate uses. Synthesized trajectory sets carry the extra
 * gate that we exec-verify before any of them becomes a VTD target (Gekhman 2405.05904:
 * SFT on unverified data raises hallucination).
 *
 * Run: node scripts/spiral_borrow_records.js
 */

const { emitConvergenceRecord } = require("../apps/lantern-garage/lib/convergence-records");

// phase legend: P0 harness/eval · P1 VTD-specialize the cheap tier · P2 tiny-recursive · M4 verifier
const BORROWS = [
  // ── TRAINING SETS (the likelier incremental win — we already have a good cheap tier) ──
  {
    hypothesis: "Borrow SWE-Gym (2.4K real executable Python tasks + 234 Lite) as the Phase-0 spiral corpus and a Phase-1 SFT/RL environment — executable tests make it a native Fix-Rate source.",
    confidence: 0.7, source: "https://modal.com/resources/best-open-source-models-swe-bench-coding-agents ; SWE-Gym",
    result: { phase: "P0/P1", kind: "dataset", size: "2.4K (+234 Lite)", executable: true, license: "open (per-repo)", gain: "turns 'measurable on SWE-bench today' into a real run; each task is a Fix-Rate-ready unit" },
    notes: "executable → directly compatible with our exec-verify M4; Lite (234) is the cheap first run.",
  },
  {
    hypothesis: "Borrow SWE-rebench V2 (Nebius: 32k+ containerized, decontaminated tasks across 20 languages, +100k PR-derived) as the Phase-1 scale training environment.",
    confidence: 0.68, source: "https://nebius.com/blog/posts/meet-swe-rebench-v2 ; arXiv:2505.20411",
    result: { phase: "P1", kind: "dataset", size: "32k+ containerized (+100k PR)", executable: true, decontaminated: true, gain: "scale + decontamination for honest Phase-1 training; multilingual widens the cheap tier" },
    notes: "decontamination matters — avoids training on eval leakage (a real risk for the moat claim).",
  },
  {
    hypothesis: "Borrow the SWE-HERO exec-verified subset (13.5k instances whose reference patches were verified BY EXECUTION in Docker) as directly-usable Phase-1 VTD targets — exec-verified means honest to distill.",
    confidence: 0.75, source: "arXiv:2604.01496 (SWE-ZERO→SWE-HERO)",
    result: { phase: "P1", kind: "dataset", size: "13.5k exec-verified (of 180k+)", executable: true, license: "permissive", gain: "the honest VTD subset — passes the Gekhman gate without extra work" },
    notes: "the 13.5k exec-verified subset is the gold; the wider 180k needs our own exec-filter first.",
  },
  {
    hypothesis: "Borrow Open-SWE-Traces (207,489 synthesized agent trajectories, 9 languages) as Phase-1 VTD CANDIDATES — but only after exec-verifying each trace, because they are synthesized, not executed.",
    confidence: 0.5, source: "arXiv:2606.16038",
    result: { phase: "P1", kind: "dataset", size: "207,489 trajectories", executable: false, gate: "exec-verify-before-use", gain: "volume — but gated behind our Fix-Rate verifier per the honesty rule" },
    notes: "SYNTHESIZED → not accepted as VTD targets until reality (our exec gate) confirms them.",
  },
  {
    hypothesis: "Borrow KodCode (largest fully-synthetic dataset with verifiable solutions + ≥5 unit tests per problem, SFT+RL splits) as Fix-Rate verifier fuel and self-contained VTD data.",
    confidence: 0.72, source: "arXiv:2503.02951 ; https://huggingface.co/KodCode",
    result: { phase: "P1/M4", kind: "dataset", tests_per_problem: ">=5", verifiable: true, gain: "self-contained + test-rich → ideal Fix-Rate granularity (per-test, not coarse pass/fail)" },
    notes: ">=5 tests/problem gives the RICH (per-test) Fix Rate our metric rewards over coarse pass/fail.",
  },
  {
    hypothesis: "Borrow TACO (25K verified competitive-programming instances, Apache-2.0) as permissive executable RL/verify data for the cheap tier.",
    confidence: 0.68, source: "arXiv:2501.01054 ; TACO (Apache-2.0)",
    result: { phase: "P1/M4", kind: "dataset", size: "25K", license: "Apache-2.0", verified: "official solution passes all tests", gain: "clean permissive license — safe for a commercial moat" },
    notes: "Apache-2.0 is the cleanest license here — matters because the moat is a shippable product.",
  },
  {
    hypothesis: "Adopt pass-rate reward (fraction of tests passed) as the trained-verifier form of our M4 Fix Rate, grounded in the code-RL literature; optionally train a cheap learned PRM as a pre-filter before the exec gate.",
    confidence: 0.65, source: "arXiv:2605.02944 (Pass-Rate Reward) ; arXiv:2501.01054 (Dynamic unit-test scaling)",
    result: { phase: "M4", kind: "method", gain: "confirms Fix Rate ~ pass-rate is the right signal; a learned PRM pre-filter cuts exec cost on obvious fails" },
    notes: "we keep EXEC as the terminal gate; a learned PRM is only a cost-saving pre-filter, never the arbiter.",
  },

  // ── OPEN WEIGHTS (the cheap tier / Phase-1 base) ──
  {
    hypothesis: "Keep Qwen2.5-Coder-7B (Apache-2.0) as the Phase-1 cheap-tier base — it is the best code model for an 8GB box and is our REPRODUCED on-box default.",
    confidence: 0.82, verified: true,
    verified_by: ["commit:2173", "test:coding-golden-exec-pass@1-0.96"],
    source: "https://www.tembo.io/blog/best-local-llm-for-coding ; local-model-registry.js (#2171/#2173)",
    result: { phase: "P1", kind: "weights", params: "7B", vramGB: 6, license: "Apache-2.0", onbox: "coding-golden exec pass@1 0.96 (24/25)", gain: "known-good verified base — the thing VTD improves, not replaces" },
    notes: "the ONLY verified borrow — reproduced on our box (#2173); every other candidate sorts behind it.",
  },
  {
    hypothesis: "Borrow OpenCoder-8B's FULLY-OPEN data + training recipe (not just weights) as the reproducible pretraining/SFT reference for an owned cheap tier.",
    confidence: 0.6, source: "https://kilo.ai/open-source-models (OpenCoder-8B, open weights+data+recipe)",
    result: { phase: "P1", kind: "weights+data", params: "8B", openness: "weights + data + recipe", gain: "the open DATA/recipe is the real borrow — a reproducible path to an owned base" },
    notes: "valued for the open DATA, not the weights — the recipe is what a home-grown base needs.",
  },
  {
    hypothesis: "Borrow DeepCoder-14B's fully-open RL recipe + data (o3-mini-level, verl-based) as the Phase-1 target for a 12–24GB box; it does not fit 8GB but the recipe transfers down.",
    confidence: 0.58, source: "https://www.together.ai/blog/deepcoder",
    result: { phase: "P1", kind: "weights+recipe", params: "14B", fits_8gb: false, gain: "the open RL recipe (verl) transfers to the 7B cheap tier; a bigger-box escalation candidate" },
    notes: "14B does NOT fit 8GB — borrowed for the RECIPE, and as an escalation-tier option on a 24GB box.",
  },

  // ── TINY-RECURSIVE SUBSTRATE (Phase 2 — the research bet) ──
  {
    hypothesis: "Borrow TRM (~7M) / HRM (27M) recursive substrates + code for Phase 2 — but hold at LOW confidence: they are proven on puzzles/tabular only, not code/language (risk #0).",
    confidence: 0.35, source: "arXiv:2510.04871 (TRM) ; arXiv:2506.21734 (HRM) ; arcprize.org/blog/hrm-analysis",
    result: { phase: "P2", kind: "weights+arch", params: "7M–27M", proven_on: "ARC/Sudoku/Maze only", risk: "no code/language evidence", gain: "the tiny recursive core IF it generalizes to code — quarantined behind P0/P1" },
    notes: "ARC-Prize showed the wins are largely memorization → the verifier (M4), not this arch, is load-bearing.",
  },
];

(async () => {
  console.log("Spiral (ADR-0030) borrow survey → ConvergenceRecords\n");
  let n = 0, verified = 0;
  for (const b of BORROWS) {
    const rec = await emitConvergenceRecord({
      hypothesis: b.hypothesis,
      result: b.result,
      confidence: b.confidence,
      reasoner: "spiral-borrow-survey (ADR-0030)",
      verified: !!b.verified,
      verified_by: b.verified_by || [],
      source: b.source,
      verification_notes: b.notes || null,
    });
    if (rec) {
      n++;
      if (rec.verified) verified++;
      console.log(`  [${rec.confidence.toFixed(2)}${rec.verified ? " VERIFIED" : "         "}] ${b.result.phase.padEnd(6)} ${b.hypothesis.slice(0, 82)}`);
    }
  }
  console.log(`\nEmitted ${n}/${BORROWS.length} records (${verified} verified) → data/convergence/records.jsonl`);
  console.log("Honesty: only the reproduced-on-box borrow is verified; the rest are web-grounded candidates.");
})();
