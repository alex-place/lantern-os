"use strict";
/*
 * convergence-world-model.js — CWM v1: a learned value function for the CONVERGE stage.
 * =====================================================================================
 * v0 predicted P(merge). You correctly rejected that: in this repo merging is nearly
 * automatic (auto-merge, 94% AI authorship) and corrections are ADDITIVE — a wrong PR
 * merges and a *later* PR fixes it, so "merged" ≠ "converged". v0's top signal (is_draft)
 * was a tautology; ~26% of its negatives were one batch-close day (an external event).
 *
 * v1 fixes the TARGET and accounts for the humans + outside happenings:
 *
 *   held = 1  iff a merged change was NOT reverted and NOT additively corrected
 *             (no later PR re-touched its non-hot files within HOLD_WINDOW_DAYS).
 *
 * "Held" is convergence you can actually verify after the fact — the only target that
 * can see additive correction, which is invisible to a merge/close label.
 *
 * LEAKAGE DISCIPLINE: every feature is knowable at PROPOSE time. time-to-merge and
 * merge-day volume are OUTCOMES, not predictors, so they are excluded. External context
 * is limited to authorship (who) and concurrent repo load at creation (what else was
 * happening) — both knowable when the change is opened.
 *
 * GROUNDED IN THE PRODUCT: predictions are emitted as spec-shaped ConvergenceRecords via
 * convergence-records.js (write-gates honored) and graded with convergence-outcome-grader
 * (Brier + ECE) — the same machinery kalshi-convergence-outcomes.js uses. This is the
 * `!convergance` data plane: CWM is a first-class convergence-record producer + grader.
 *
 * Pure/deterministic (no Math.random, no wall-clock in the math). I/O is caller-owned
 * except loadModel(), which reads the persisted coefficients.
 */

const fs = require("fs");
const path = require("path");

const HOLD_WINDOW_DAYS = 7;      // additive-correction lookahead window
const HOT_FILE_FRAC = 0.15;      // a file touched by >15% of PRs is "hot" — re-touch is background noise, not correction
const CREATE_LOAD_DAYS = 1;      // ±1 day window for concurrent-load-at-creation

const MODEL_PATH = path.resolve(__dirname, "..", "data", "convergence", "cwm-model.json");

const PROTECTED = [/(^|\/)auth/i, /(^|\/)\.github\/workflows\//i, /secret/i,
  /(^|\/)migrations?\//i, /\.env/i, /plan-matrix|patreon|oauth|billing|money|payment/i];
const AGENT_LANES = ["claude/", "gemini/", "codex/", "devin/", "grok/", "openai/"];
const NOISE_FILE = /(^|\/)changelog\.d\//i; // additive changelog fragments aren't a correction of prior code

const FEATURES = ["log_files", "log_churn", "touches_protected", "has_changelog",
  "touches_tests", "docs_heavy", "hot_file_frac", "agent_lane", "human_touched", "create_load"];

// ── corpus context: hot files + per-PR concurrent-create load ────────────────
function buildContext(prs) {
  const fileCount = new Map();
  for (const p of prs) for (const f of (p.files || [])) {
    const k = f.path || ""; if (k) fileCount.set(k, (fileCount.get(k) || 0) + 1);
  }
  const n = prs.length || 1;
  const hotFiles = new Set([...fileCount].filter(([, c]) => c / n > HOT_FILE_FRAC).map(([k]) => k));
  // concurrent load at creation: PRs created within ±CREATE_LOAD_DAYS of this one
  const created = prs.map((p) => ({ n: p.number, t: Date.parse(p.createdAt || "") })).filter((x) => !isNaN(x.t));
  const win = CREATE_LOAD_DAYS * 864e5;
  const loadByNumber = new Map();
  for (const p of prs) {
    const t = Date.parse(p.createdAt || ""); if (isNaN(t)) { loadByNumber.set(p.number, 0); continue; }
    loadByNumber.set(p.number, created.filter((c) => Math.abs(c.t - t) <= win).length - 1);
  }
  const loads = [...loadByNumber.values()].sort((a, b) => a - b);
  const medianLoad = loads.length ? loads[Math.floor(loads.length / 2)] : 0;
  return { hotFiles, loadByNumber, medianLoad };
}

// ── held label: was a merged change reverted or additively corrected? ────────
function computeHeld(pr, prs, ctx) {
  if (!pr.mergedAt) return null;               // only merged changes can "hold"
  const mt = Date.parse(pr.mergedAt); if (isNaN(mt)) return null;
  const win = HOLD_WINDOW_DAYS * 864e5;
  const coreFiles = new Set((pr.files || []).map((f) => f.path || "")
    .filter((k) => k && !ctx.hotFiles.has(k) && !NOISE_FILE.test(k)));
  if (coreFiles.size === 0) return 1;          // no verifiable core surface to be corrected → treat as held
  for (const q of prs) {
    if (q.number === pr.number || !q.mergedAt) continue;
    const qt = Date.parse(q.mergedAt); if (isNaN(qt) || qt <= mt || qt - mt > win) continue;
    const qFiles = (q.files || []).map((f) => f.path || "");
    const overlap = qFiles.some((k) => coreFiles.has(k));
    const isRevert = /revert/i.test(q.title || "") && new RegExp(`#${pr.number}\\b`).test(q.title || "");
    if (isRevert || overlap) return 0;         // reverted or additively re-touched within the window
  }
  return 1;
}

// ── features (all knowable at propose time) ──────────────────────────────────
function featurize(pr, ctx) {
  const files = (pr.files || []).map((f) => f.path || "");
  const nf = pr.changedFiles || files.length || 0;
  const churn = (pr.additions || 0) + (pr.deletions || 0);
  const hotFrac = nf > 0 ? files.filter((k) => ctx.hotFiles.has(k)).length / nf : 0;
  const branch = pr.headRefName || "";
  const agentLane = AGENT_LANES.some((l) => branch.startsWith(l)) ? 1 : 0;
  const load = ctx.loadByNumber.get(pr.number);
  return [
    Math.log1p(nf),
    Math.log1p(churn),
    files.some((p) => PROTECTED.some((re) => re.test(p))) ? 1 : 0,
    files.some((p) => /(^|\/)changelog/i.test(p)) ? 1 : 0,
    files.some((p) => /(^|\/)tests?\//i.test(p) || /\.test\./i.test(p) || /_test\./i.test(p)) ? 1 : 0,
    nf > 0 && files.filter((p) => /(^|\/)docs\//i.test(p) || /\.md$/i.test(p)).length / nf >= 0.5 ? 1 : 0,
    hotFrac,
    agentLane,
    agentLane ? 0 : 1,                                   // human_touched
    Math.log1p(load == null ? ctx.medianLoad : load),    // concurrent load at creation
  ];
}

// ── math: standardize + class-weighted L2 logistic + Platt recalibration ─────
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
function fitScaler(X) {
  const d = X[0].length, mean = Array(d).fill(0), std = Array(d).fill(0);
  for (const x of X) for (let i = 0; i < d; i++) mean[i] += x[i];
  for (let i = 0; i < d; i++) mean[i] /= X.length;
  for (const x of X) for (let i = 0; i < d; i++) std[i] += (x[i] - mean[i]) ** 2;
  for (let i = 0; i < d; i++) std[i] = Math.sqrt(std[i] / X.length) || 1;
  return { mean, std };
}
const scale = (x, s) => x.map((v, i) => (v - s.mean[i]) / s.std[i]);

function trainLogistic(X, y, { iters = 4000, lr = 0.3, l2 = 1e-3 } = {}) {
  const d = X[0].length, w = Array(d).fill(0);
  const p = y.reduce((a, b) => a + b, 0) / y.length;
  let b = Math.log(p / (1 - p));
  const wPos = 1 / (2 * p), wNeg = 1 / (2 * (1 - p));
  for (let it = 0; it < iters; it++) {
    const gw = Array(d).fill(0); let gb = 0;
    for (let n = 0; n < X.length; n++) {
      const pred = sigmoid(X[n].reduce((acc, xi, i) => acc + xi * w[i], b));
      const err = (pred - y[n]) * (y[n] ? wPos : wNeg);
      for (let i = 0; i < d; i++) gw[i] += err * X[n][i];
      gb += err;
    }
    for (let i = 0; i < d; i++) w[i] -= lr * (gw[i] / X.length + l2 * w[i]);
    b -= lr * (gb / X.length);
  }
  return { w, b };
}
function fitPlatt(logits, y, { iters = 5000, lr = 0.05 } = {}) {
  let a = 1, b = 0;
  for (let it = 0; it < iters; it++) {
    let ga = 0, gb = 0;
    for (let n = 0; n < logits.length; n++) { const e = sigmoid(a * logits[n] + b) - y[n]; ga += e * logits[n]; gb += e; }
    a -= lr * ga / logits.length; b -= lr * gb / logits.length;
  }
  return { a, b };
}

// ── train a full model from a labeled corpus; returns a serializable object ──
function trainCWM(prs) {
  const ctx = buildContext(prs);
  const rows = [];
  for (const p of prs) {
    const y = computeHeld(p, prs, ctx);
    if (y == null) continue;
    rows.push({ number: p.number, title: p.title, x: featurize(p, ctx), y });
  }
  const scaler = fitScaler(rows.map((r) => r.x));
  const Xs = rows.map((r) => scale(r.x, scaler));
  const y = rows.map((r) => r.y);
  const { w, b } = trainLogistic(Xs, y);
  const logits = Xs.map((xs) => xs.reduce((acc, xi, i) => acc + xi * w[i], b));
  const platt = fitPlatt(logits, y);
  return {
    version: "cwm.v1",
    target: "held",
    hold_window_days: HOLD_WINDOW_DAYS,
    features: FEATURES,
    scaler, w, b, platt,
    hot_files: [...ctx.hotFiles],
    median_load: ctx.medianLoad,
    trained_on: rows.length,
    held_rate: y.reduce((a, c) => a + c, 0) / y.length,
    rows, // kept for eval; strip before persisting the deployable model
  };
}

// ── predict P(held) from a persisted model + a PR-like object + corpus ctx ───
function predictHeld(model, pr, ctx) {
  const x = featurize(pr, ctx || { hotFiles: new Set(model.hot_files), loadByNumber: new Map(), medianLoad: model.median_load });
  const xs = scale(x, model.scaler);
  const logit = xs.reduce((acc, xi, i) => acc + xi * model.w[i], model.b);
  return sigmoid(model.platt.a * logit + model.platt.b);
}

function loadModel(p = MODEL_PATH) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// ── build a spec-shaped ConvergenceRecord for a P(held) forecast (write-gates) ─
// verified stays FALSE — the hold window hasn't elapsed, so reality hasn't confirmed it.
function forecastRecord(pr, pHeld) {
  return {
    hypothesis: `Change "${(pr.title || `PR #${pr.number}`).slice(0, 200)}" will HOLD (converge without additive correction within ${HOLD_WINDOW_DAYS}d). CWM P(held)=${pHeld.toFixed(3)}`,
    confidence: Number(pHeld.toFixed(4)),
    reasoner: "convergence-world-model.v1",
    source: `learned held-value fn (target=held, window=${HOLD_WINDOW_DAYS}d); graded by convergence-outcome-grader`,
    verified: false,
    verified_by: [],
    result: { pr: pr.number, forecast: pHeld >= 0.5 ? "hold" : "will-need-correction" },
  };
}

module.exports = {
  HOLD_WINDOW_DAYS, HOT_FILE_FRAC, FEATURES, MODEL_PATH,
  buildContext, computeHeld, featurize, trainCWM, predictHeld, loadModel, forecastRecord,
  _internal: { fitScaler, scale, trainLogistic, fitPlatt, sigmoid },
};
