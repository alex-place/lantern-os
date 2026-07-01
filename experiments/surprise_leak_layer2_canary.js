"use strict";
/**
 * Surprise-leak Layer 2 — does feeding modelUncertainty into the groundedness canary's
 * risk score improve hallucination DETECTION (recall/FPR) vs the text-only baseline?
 *
 * #1679's exact question, answered directly: this calls the REAL, shipped
 * `groundedness-canary.js::scoreReplyGroundedness()` — not a re-implementation or a port —
 * twice per labeled example from the Layer-1 dataset (#1673): once with `tokenSurprise: null`
 * (text-only, today's live default with SURPRISE_CANARY off) and once with the real captured
 * `surpriseField` + the correct per-model calibration (#1681). No new model generation is
 * needed: experiments/results/surprise_leak_*.jsonl already carry the reply text, the
 * hallucination label, AND the field the canary consumes, from the real local-model run #1673
 * already did.
 *
 * Threshold note: the canary needs >=MIN_TOKENS (16) tokens of reply text to score at all —
 * below that it returns risk=0 unconditionally ("too_short"), regardless of tokenSurprise. Most
 * of this dataset is short one-line factual answers, so a large share of rows are structurally
 * unscoreable by this canary. That's reported explicitly below, not hidden — it's a real
 * methodological limit of testing THIS canary on THIS dataset, not a bug in the experiment.
 *
 * Run: node experiments/surprise_leak_layer2_canary.js
 */
const fs = require("fs");
const path = require("path");
const { scoreReplyGroundedness } = require("../apps/lantern-garage/lib/groundedness-canary");

const RESULTS_DIR = path.join(__dirname, "results");
const DATASETS = [
  { file: "surprise_leak_qwen15b.jsonl", model: "qwen2.5-coder:1.5b" },
  { file: "surprise_leak_mistral7b.jsonl", model: "mistral" },
];

function readJsonl(p) {
  return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// Confusion-matrix stats at the canary's own default threshold (0.5) — no threshold tuning,
// so this reports what the SHIPPED default actually does, not a cherry-picked operating point.
function evalMode(rows, withSurprise, model) {
  let tp = 0, fp = 0, tn = 0, fn = 0, tooShort = 0;
  for (const r of rows) {
    const opts = { threshold: 0.5 };
    if (withSurprise) { opts.tokenSurprise = r.field; opts.surpriseModel = model; }
    const score = scoreReplyGroundedness(r.prediction, opts);
    if (score.reason === "too_short") { tooShort++; continue; }
    const actual = !!r.hallucination;
    const flagged = score.ungrounded;
    if (actual && flagged) tp++;
    else if (actual && !flagged) fn++;
    else if (!actual && flagged) fp++;
    else tn++;
  }
  const scored = tp + fp + tn + fn;
  return {
    scored, tooShort, total: rows.length,
    recall: tp + fn > 0 ? tp / (tp + fn) : null,   // of real hallucinations, % flagged
    fpr: fp + tn > 0 ? fp / (fp + tn) : null,       // of real-correct, % wrongly flagged
    tp, fp, tn, fn,
  };
}

function main() {
  const report = { generatedAt: new Date().toISOString(), datasets: [] };
  for (const { file, model } of DATASETS) {
    const fp = path.join(RESULTS_DIR, file);
    if (!fs.existsSync(fp)) { console.log(`skip (missing): ${file}`); continue; }
    const rows = readJsonl(fp);
    const textOnly = evalMode(rows, false, model);
    const withSurprise = evalMode(rows, true, model);
    const entry = { file, model, n: rows.length, textOnly, withSurprise };
    report.datasets.push(entry);

    console.log(`\n=== ${file} (${model}) — n=${rows.length} ===`);
    console.log(`too_short (unscoreable, <16 tokens): ${textOnly.tooShort}/${rows.length} (${(100 * textOnly.tooShort / rows.length).toFixed(1)}%)`);
    console.log(`scored by canary: ${textOnly.scored}/${rows.length}`);
    console.log(`  text-only     recall=${fmt(textOnly.recall)}  FPR=${fmt(textOnly.fpr)}  (tp=${textOnly.tp} fp=${textOnly.fp} tn=${textOnly.tn} fn=${textOnly.fn})`);
    console.log(`  text+surprise recall=${fmt(withSurprise.recall)}  FPR=${fmt(withSurprise.fpr)}  (tp=${withSurprise.tp} fp=${withSurprise.fp} tn=${withSurprise.tn} fn=${withSurprise.fn})`);
    const dRecall = withSurprise.recall != null && textOnly.recall != null ? withSurprise.recall - textOnly.recall : null;
    const dFpr = withSurprise.fpr != null && textOnly.fpr != null ? withSurprise.fpr - textOnly.fpr : null;
    console.log(`  delta: recall ${dRecall != null ? (dRecall >= 0 ? "+" : "") + dRecall.toFixed(4) : "n/a"}, FPR ${dFpr != null ? (dFpr >= 0 ? "+" : "") + dFpr.toFixed(4) : "n/a"}`);
    entry.delta = { recall: dRecall, fpr: dFpr };
  }
  const outPath = path.join(RESULTS_DIR, "surprise_leak_layer2_canary_report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${path.relative(process.cwd(), outPath)}`);
}

function fmt(x) { return x == null ? "n/a" : x.toFixed(4); }

main();
