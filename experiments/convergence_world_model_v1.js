"use strict";
/*
 * CWM v1 trainer + honest evaluator.  target = `held` (converged without additive correction).
 * Run:  node experiments/convergence_world_model_v1.js <prs_all.json>
 *   CWM_EMIT=1  also writes one real ConvergenceRecord to the canonical ledger (demo of !convergance integration)
 */
const fs = require("fs");
const path = require("path");
const cwm = require(path.resolve(__dirname, "..", "apps", "lantern-garage", "lib", "convergence-world-model"));
const grader = require(path.resolve(__dirname, "..", "apps", "lantern-garage", "lib", "convergence-outcome-grader"));
const { scale } = cwm._internal;
const { sigmoid } = cwm._internal;

let _seed = 20260723;
const rand = () => { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; };
const shuf = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function auroc(scored) {
  const pos = scored.filter((r) => r.y === 1), neg = scored.filter((r) => r.y === 0);
  if (!pos.length || !neg.length) return null;
  let w = 0; for (const a of pos) for (const b of neg) w += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0;
  return w / (pos.length * neg.length);
}

const dataPath = process.argv[2];
if (!dataPath) { console.error("usage: node experiments/convergence_world_model_v1.js <prs_all.json>"); process.exit(1); }
const prs = JSON.parse(fs.readFileSync(dataPath, "utf8"));

// ── label + featurize every merged PR (held target) ──────────────────────────
const ctx = cwm.buildContext(prs);
const rows = [];
for (const p of prs) {
  const y = cwm.computeHeld(p, prs, ctx);
  if (y == null) continue;                       // skip open / unmerged (can't "hold")
  rows.push({ number: p.number, title: p.title, x: cwm.featurize(p, ctx), y });
}
const nHeld = rows.filter((r) => r.y === 1).length, nCorr = rows.length - nHeld;
console.log(`\nConvergence World Model v1 — P(change HELD = converged without additive correction within ${cwm.HOLD_WINDOW_DAYS}d)`);
console.log(`dataset: ${rows.length} merged PRs  |  held=${nHeld}  needed-correction=${nCorr}  held-rate=${(100 * nHeld / rows.length).toFixed(1)}%`);
console.log(`(vs v0's 93% "merged" base rate — the held target is far more balanced, i.e. it carries real signal)\n`);

// ── stratified split ─────────────────────────────────────────────────────────
const pos = shuf(rows.filter((r) => r.y === 1)), neg = shuf(rows.filter((r) => r.y === 0));
const cut = (a, f) => { const k = Math.round(a.length * f); return [a.slice(k), a.slice(0, k)]; };
const [trP, teP] = cut(pos, 0.30), [trN, teN] = cut(neg, 0.30);
const tr = [...trP, ...trN], te = [...teP, ...teN];

// ── fit scaler + class-weighted logistic + Platt on TRAIN only ───────────────
const scaler = cwm._internal.fitScaler(tr.map((r) => r.x));
const Xtr = tr.map((r) => scale(r.x, scaler)), ytr = tr.map((r) => r.y);
const { w, b } = cwm._internal.trainLogistic(Xtr, ytr);
const trLogits = Xtr.map((xs) => xs.reduce((a, xi, i) => a + xi * w[i], b));
const platt = cwm._internal.fitPlatt(trLogits, ytr);
const predP = (x) => { const lg = scale(x, scaler).reduce((a, xi, i) => a + xi * w[i], b); return sigmoid(platt.a * lg + platt.b); };

// ── grade held-out test with the PRODUCT'S OWN grader ────────────────────────
const scored = te.map((r) => ({ ...r, p: predP(r.x) }));
const cal = grader.calibrationSummary(scored.map((r) => grader.gradeRecord({ id: `cwm-${r.number}`, confidence: r.p }, { passed: r.y === 1 })));
const baseP = nHeld / rows.length;
const baseCal = grader.calibrationSummary(te.map((r) => grader.gradeRecord({ id: "b", confidence: baseP }, { passed: r.y === 1 })));
const roc = auroc(scored);
const corrFlag = scored.filter((r) => r.y === 0 && r.p < 0.5).length, corrTot = scored.filter((r) => r.y === 0).length;

console.log(`── held-out test (n=${te.length}: ${teP.length} held / ${teN.length} needed-correction) ──`);
console.log(`AUROC ...................... ${roc == null ? "n/a" : roc.toFixed(3)}   (ranks 'needed correction' below 'held')`);
console.log(`Brier  CWM / base-rate ..... ${cal.mean_brier.toFixed(4)} / ${baseCal.mean_brier.toFixed(4)}   (lower=better)`);
console.log(`ECE    CWM / base-rate ..... ${cal.ece.toFixed(4)} / ${baseCal.ece.toFixed(4)}   (lower=better calibrated)`);
console.log(`skill score ................ ${cal.skill_score.toFixed(3)}`);
console.log(`needs-correction recall .... ${corrFlag}/${corrTot}  (P(held)<0.5)`);

console.log(`\n── what predicts a change HOLDING in this repo (standardized log-odds) ──`);
cwm.FEATURES.map((f, i) => ({ f, w: w[i] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
  .forEach(({ f, w }) => console.log(`  ${w >= 0 ? "+" : "-"}${Math.abs(w).toFixed(3)}  ${f}  (${w >= 0 ? "holds" : "needs correction"})`));

// ── persist the deployable model (train on ALL rows; strip the eval rows) ────
const full = cwm.trainCWM(prs); delete full.rows;
fs.mkdirSync(path.dirname(cwm.MODEL_PATH), { recursive: true });
fs.writeFileSync(cwm.MODEL_PATH, JSON.stringify(full, null, 2));
console.log(`\nmodel persisted → ${path.relative(process.cwd(), cwm.MODEL_PATH)}  (held-rate ${(100 * full.held_rate).toFixed(1)}%, ${full.trained_on} PRs)`);

// ── !convergance integration: emit a spec-shaped ConvergenceRecord ───────────
const model = cwm.loadModel();
const riskiest = [...scored].sort((a, b) => a.p - b.p)[0];
const prLike = prs.find((p) => p.number === riskiest.number);
const rec = cwm.forecastRecord(prLike, cwm.predictHeld(model, prLike, ctx));
console.log(`\n── ConvergenceRecord for riskiest held-out change (feeds !convergance / records.jsonl) ──`);
console.log(JSON.stringify({ ...rec, _true_label: riskiest.y ? "held" : "needed-correction" }, null, 2));

if (process.env.CWM_EMIT) {
  (async () => {
    const { emitConvergenceRecord } = require(path.resolve(__dirname, "..", "apps", "lantern-garage", "lib", "convergence-records"));
    const emitted = await emitConvergenceRecord(rec);
    console.log(`\nCWM_EMIT=1 → wrote ConvergenceRecord ${emitted && emitted.id} to the canonical ledger.`);
  })();
}
