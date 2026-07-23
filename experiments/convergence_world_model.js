"use strict";
/*
 * Convergence World Model (CWM) v0 — a learned VALUE FUNCTION for the Converge stage.
 * ---------------------------------------------------------------------------------
 * World models are transition/value functions V(state, action) -> future outcome.
 * Our "world" is not pixels+physics; it is CHANGES -> CONVERGENCE. This model learns
 *
 *     P(converge)  =  P(a proposed change reaches the repo's own Verify receipt: MERGE)
 *
 * from features derivable at PROPOSE time (the diff + branch) — no post-hoc/leakage
 * features. Merge is not an arbitrary label: convergence-records.js only lets a record
 * stand as verified=true with a CHECKABLE artifact ("a merged PR / commit / passing
 * test"), so P(merge) is P(reaching the system's canonical convergence receipt).
 *
 * GROUNDED IN REALITY: we grade the model with the product's OWN scoring rule —
 * convergence-outcome-grader.js (Brier = (conf-outcome)^2 + 10-bin ECE) — not a metric
 * we invented here. We also emit a spec-shaped ConvergenceRecord and honor the #767
 * write-gates (verified=false until the PR actually resolves).
 *
 * This is Dreamer's "learn a model of your world and plan against it", ported to code:
 * given N candidate patches, predict P(converge) for each and act on the best.
 *
 * Run: node experiments/convergence_world_model.js <path/to/prs_all.json>
 */

const fs = require("fs");
const path = require("path");
const grader = require(path.resolve(
  __dirname, "..", "apps", "lantern-garage", "lib", "convergence-outcome-grader"));

// ── deterministic RNG (reproducible split; no Math.random) ───────────────────
let _seed = 1337;
function rand() { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; }

// ── protected paths (mirrors pr-watcher's human-gate list) ───────────────────
const PROTECTED = [/(^|\/)auth/i, /(^|\/)\.github\/workflows\//i, /secret/i,
  /(^|\/)migrations?\//i, /\.env/i, /plan-matrix|patreon|oauth|billing|money|payment/i];
const AGENT_LANES = ["claude/", "gemini/", "codex/", "devin/", "grok/", "openai/"];

// ── feature extraction — ONLY propose-time-derivable signals (no leakage) ─────
const FEATURES = ["log_files", "log_churn", "touches_protected", "has_changelog",
  "touches_tests", "is_draft", "docs_heavy", "agent_lane"];

function featurize(pr) {
  const files = (pr.files || []).map((f) => f.path || "");
  const nf = pr.changedFiles || files.length || 0;
  const churn = (pr.additions || 0) + (pr.deletions || 0);
  const touchesProtected = files.some((p) => PROTECTED.some((re) => re.test(p))) ? 1 : 0;
  const hasChangelog = files.some((p) => /(^|\/)changelog\.d\//i.test(p) || /changelog/i.test(p)) ? 1 : 0;
  const touchesTests = files.some((p) => /(^|\/)tests?\//i.test(p) || /\.test\./i.test(p) || /_test\./i.test(p)) ? 1 : 0;
  const docsFiles = files.filter((p) => /(^|\/)docs\//i.test(p) || /\.md$/i.test(p)).length;
  const docsHeavy = nf > 0 && docsFiles / nf >= 0.5 ? 1 : 0;
  const branch = pr.headRefName || "";
  const agentLane = AGENT_LANES.some((l) => branch.startsWith(l)) ? 1 : 0;
  return [
    Math.log1p(nf),
    Math.log1p(churn),
    touchesProtected,
    hasChangelog,
    touchesTests,
    pr.isDraft ? 1 : 0,
    docsHeavy,
    agentLane,
  ];
}

// ── load + label ─────────────────────────────────────────────────────────────
function loadSamples(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = [];
  for (const pr of j) {
    const merged = !!pr.mergedAt;
    const closedUnmerged = !merged && String(pr.state || "").toUpperCase() === "CLOSED";
    if (!merged && !closedUnmerged) continue; // drop open
    if (process.env.CWM_NODRAFT && pr.isDraft) continue; // ablation: drafts can't merge — a tautology, remove them
    rows.push({ x: featurize(pr), y: merged ? 1 : 0, number: pr.number, title: pr.title });
  }
  return rows;
}

// ── stratified split so the 42-strong minority appears in both halves ────────
function split(rows, testFrac) {
  const pos = rows.filter((r) => r.y === 1), neg = rows.filter((r) => r.y === 0);
  const shuf = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } };
  shuf(pos); shuf(neg);
  const take = (a) => { const k = Math.round(a.length * testFrac); return [a.slice(k), a.slice(0, k)]; };
  const [trP, teP] = take(pos), [trN, teN] = take(neg);
  return { train: [...trP, ...trN], test: [...teP, ...teN] };
}

// ── standardize ───────────────────────────────────────────────────────────────
function fitScaler(rows) {
  const d = rows[0].x.length, mean = Array(d).fill(0), std = Array(d).fill(0);
  for (const r of rows) for (let i = 0; i < d; i++) mean[i] += r.x[i];
  for (let i = 0; i < d; i++) mean[i] /= rows.length;
  for (const r of rows) for (let i = 0; i < d; i++) std[i] += (r.x[i] - mean[i]) ** 2;
  for (let i = 0; i < d; i++) std[i] = Math.sqrt(std[i] / rows.length) || 1;
  return { mean, std };
}
const scale = (x, s) => x.map((v, i) => (v - s.mean[i]) / s.std[i]);

// ── class-weighted L2 logistic regression via full-batch GD ──────────────────
function train(rows, s, { iters = 4000, lr = 0.3, l2 = 1e-3 } = {}) {
  const d = rows[0].x.length;
  const w = Array(d).fill(0);
  const p = rows.filter((r) => r.y === 1).length / rows.length;
  let b = Math.log(p / (1 - p)); // init bias at base rate
  const wPos = 1 / (2 * p), wNeg = 1 / (2 * (1 - p)); // inverse-freq class weights
  const X = rows.map((r) => scale(r.x, s));
  const sig = (z) => 1 / (1 + Math.exp(-z));
  for (let it = 0; it < iters; it++) {
    const gw = Array(d).fill(0); let gb = 0;
    for (let n = 0; n < rows.length; n++) {
      const pred = sig(X[n].reduce((acc, xi, i) => acc + xi * w[i], b));
      const cw = rows[n].y ? wPos : wNeg;
      const err = (pred - rows[n].y) * cw;
      for (let i = 0; i < d; i++) gw[i] += err * X[n][i];
      gb += err;
    }
    for (let i = 0; i < d; i++) w[i] -= lr * (gw[i] / rows.length + l2 * w[i]);
    b -= lr * (gb / rows.length);
  }
  return { w, b, sig, s };
}
function logit(m, x) { return scale(x, m.s).reduce((acc, xi, i) => acc + xi * m.w[i], m.b); }
function predict(m, x) { return m.sig(logit(m, x)); }

// ── Platt recalibration: fit sigmoid(a*logit + b) on train so probabilities are
//    HONEST. Monotonic in logit -> AUROC/ranking is preserved; only calibration moves.
function fitPlatt(rows, m, { iters = 5000, lr = 0.05 } = {}) {
  const L = rows.map((r) => logit(m, r.x)), Y = rows.map((r) => r.y);
  let a = 1, b = 0; const sig = (z) => 1 / (1 + Math.exp(-z));
  for (let it = 0; it < iters; it++) {
    let ga = 0, gb = 0;
    for (let n = 0; n < L.length; n++) { const e = sig(a * L[n] + b) - Y[n]; ga += e * L[n]; gb += e; }
    a -= lr * ga / L.length; b -= lr * gb / L.length;
  }
  return (lg) => sig(a * lg + b);
}

// ── metrics ───────────────────────────────────────────────────────────────────
function auroc(scored) { // scored: [{p, y}]
  const pos = scored.filter((r) => r.y === 1), neg = scored.filter((r) => r.y === 0);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

// ── run ────────────────────────────────────────────────────────────────────────
const dataPath = process.argv[2];
if (!dataPath) { console.error("usage: node experiments/convergence_world_model.js <prs_all.json>"); process.exit(1); }
const rows = loadSamples(dataPath);
const nPos = rows.filter((r) => r.y === 1).length, nNeg = rows.length - nPos;
console.log(`\nConvergence World Model v0 — P(change converges = merges)`);
console.log(`dataset: ${rows.length} resolved PRs  |  merged=${nPos}  closed-unmerged=${nNeg}  base-rate=${(nPos / rows.length * 100).toFixed(1)}%\n`);

const { train: tr, test: te } = split(rows, 0.30);
const s = fitScaler(tr);
const model = train(tr, s);

// Platt recalibration fit on TRAIN only, applied to held-out TEST
const platt = fitPlatt(tr, model);

// grade on held-out test with the PRODUCT'S OWN grader (Brier + ECE)
const scored = te.map((r) => ({ ...r, p: predict(model, r.x), pc: platt(logit(model, r.x)) }));
const grade = (key) => grader.calibrationSummary(
  scored.map((r) => grader.gradeRecord({ id: `cwm-${r.number}`, confidence: r[key] }, { passed: r.y === 1 })));
const calRaw = grade("p");    // class-weighted (good ranking, poor calibration)
const cal = grade("pc");      // + Platt recalibration (honest confidence)
const roc = auroc(scored.map((r) => ({ p: r.pc, y: r.y })));

// baseline: constant base-rate forecast, graded the same way
const baseP = nPos / rows.length;
const baseCal = grader.calibrationSummary(
  te.map((r) => grader.gradeRecord({ id: "b", confidence: baseP }, { passed: r.y === 1 })));

console.log(`── held-out test (n=${te.length}: ${te.filter(r=>r.y===1).length} merged / ${te.filter(r=>r.y===0).length} unmerged) ──`);
console.log(`AUROC .................... ${roc.toFixed(3)}   (0.5 = coin flip; ranks unmerged below merged)`);
console.log(`Brier  raw / recalibrated  ${calRaw.mean_brier.toFixed(4)} / ${cal.mean_brier.toFixed(4)}   vs base-rate ${baseCal.mean_brier.toFixed(4)}  (lower=better)`);
console.log(`ECE    raw / recalibrated  ${calRaw.ece.toFixed(4)} / ${cal.ece.toFixed(4)}   vs base-rate ${baseCal.ece.toFixed(4)}  (lower=better calibrated)`);
console.log(`skill score (recalibrated) ${cal.skill_score.toFixed(3)}   (1 - Brier/0.25)`);

// minority recall: of the truly-unmerged, how many did we flag as risky (below base rate)?
const flaggedRisk = scored.filter((r) => r.y === 0 && r.pc < 0.75).length;
const totalRisk = scored.filter((r) => r.y === 0).length;
console.log(`won't-converge recall .... ${flaggedRisk}/${totalRisk}  (unmerged PRs scored below 0.75 = flagged risky)`);

console.log(`\n── what drives convergence in THIS repo (standardized log-odds weights) ──`);
FEATURES.map((f, i) => ({ f, w: model.w[i] }))
  .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
  .forEach(({ f, w }) => console.log(`  ${w >= 0 ? "+" : "-"}${Math.abs(w).toFixed(3)}  ${f}  (${w >= 0 ? "raises" : "lowers"} P(converge))`));

// ── emit a spec-shaped ConvergenceRecord for the single riskiest held-out PR ──
const riskiest = [...scored].sort((a, b) => a.pc - b.pc)[0];
console.log(`\n── sample ConvergenceRecord emitted for riskiest held-out change (write-gates honored) ──`);
console.log(JSON.stringify({
  hypothesis: `PR #${riskiest.number} will converge (merge). CWM P(converge)=${riskiest.pc.toFixed(3)}`,
  confidence: Number(riskiest.pc.toFixed(3)),
  reasoner: "convergence-world-model.v0",
  source: "learned value fn over 599 real resolved PRs; graded by convergence-outcome-grader",
  verified: false,                 // #767 gate: no receipt yet — the PR hasn't resolved
  verified_by: [],                 // fills with [merge sha] iff it actually merges
  result: { predicted_outcome: riskiest.p >= 0.5 ? "converge" : "stall", true_label: riskiest.y ? "merged" : "closed-unmerged" },
}, null, 2));
