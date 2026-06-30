"use strict";
/**
 * Health / symptom journal with calibrated honesty (#1435).
 *
 * Logs symptoms over time and surfaces *patterns in your own log* — never a diagnosis.
 * The differentiator in a space full of overconfident AI is cite-or-abstain discipline:
 * a factor↔severity association is only reported when there are enough logged days on
 * BOTH sides, confidence is capped (never "certain"), the framing is "pattern, not cause",
 * and every output carries the see-a-clinician disclaimer. Below the data floor it abstains.
 *
 * Pure analysis (no I/O), deterministic, fully testable.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../../..");
const MIN_N = 3;                 // days needed on each side before we'll say anything
const DISCLAIMER = "This reflects patterns in your own log, not a diagnosis or medical advice. Persistent, severe, or worrying symptoms — see a clinician.";

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round1 = (x) => Math.round(x * 10) / 10;
function normFactors(f) { return [...new Set((Array.isArray(f) ? f : []).map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))]; }
const sev = (e) => Math.max(0, Math.min(10, Number(e.severity) || 0));

// Mean severity on days WITH a factor vs WITHOUT. Abstains unless both sides clear MIN_N.
function factorEffect(entries, factor) {
  const withF = entries.filter((e) => normFactors(e.factors).includes(factor));
  const without = entries.filter((e) => !normFactors(e.factors).includes(factor));
  const nW = withF.length, nO = without.length;
  if (nW < MIN_N || nO < MIN_N) {
    return { factor, nWith: nW, nWithout: nO, status: "insufficient_data",
      verdict: `Only ${nW} day(s) logged with "${factor}" and ${nO} without — not enough to say anything yet.` };
  }
  const avgWith = round1(mean(withF.map(sev)));
  const avgWithout = round1(mean(without.map(sev)));
  const diff = round1(avgWith - avgWithout);            // + = symptoms worse on factor days
  // Confidence grows with total support but is HARD-capped at 0.85 — we never claim certainty.
  const confidence = Math.min(0.85, Math.round(((nW + nO) / 30) * 100) / 100);
  let verdict;
  if (Math.abs(diff) < 0.5) verdict = `No clear association with "${factor}" in your log.`;
  else if (diff > 0) verdict = `On days with "${factor}", symptoms run ${diff} pts WORSE on average — a pattern worth watching, not a proven cause.`;
  else verdict = `On days with "${factor}", symptoms run ${Math.abs(diff)} pts BETTER on average — a pattern worth noting, not a proven remedy.`;
  return { factor, nWith: nW, nWithout: nO, avgWith, avgWithout, diff, confidence, status: "ok", verdict };
}

// All factors that appear in the log, strongest |effect| first; insufficient-data ones last.
function findPatterns(entries) {
  const factors = [...new Set((entries || []).flatMap((e) => normFactors(e.factors)))];
  const effects = factors.map((f) => factorEffect(entries, f));
  const ok = effects.filter((e) => e.status === "ok").sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const insufficient = effects.filter((e) => e.status !== "ok");
  return { patterns: ok, insufficient, disclaimer: DISCLAIMER };
}

function summary(entries) {
  const es = entries || [];
  if (!es.length) return { n: 0, status: "insufficient_data", disclaimer: DISCLAIMER, message: "No entries yet. Log a few days to start seeing patterns." };
  const counts = {};
  for (const e of es) { const s = String(e.symptom || "symptom").toLowerCase(); counts[s] = (counts[s] || 0) + 1; }
  const topSymptoms = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([symptom, count]) => ({ symptom, count }));
  const recent = es.slice(-7);
  return {
    n: es.length, avgSeverity: round1(mean(es.map(sev))), recentAvgSeverity: round1(mean(recent.map(sev))),
    topSymptoms, status: "ok", disclaimer: DISCLAIMER,
  };
}

// ── thin JSONL persistence (local-only) ─────────────────────────────────────────
function _file(root) { return path.join(root || DEFAULT_REPO_ROOT, "data", "health", "log.jsonl"); }
function readEntries(root) {
  try {
    return fs.readFileSync(_file(root), "utf8").split("\n").filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function logEntry(root, input, nowIso) {
  const symptom = String(input.symptom || "").trim();
  if (!symptom) throw new Error("symptom is required");
  const entry = {
    id: `sym:${crypto.randomUUID()}`,
    date: input.date ? String(input.date).slice(0, 10) : nowIso.slice(0, 10),
    symptom: symptom.slice(0, 120),
    severity: Math.max(1, Math.min(10, Math.round(Number(input.severity) || 5))),
    factors: normFactors(input.factors),
    note: String(input.note || "").slice(0, 500),
    loggedAt: nowIso,
  };
  const f = _file(root); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(entry) + "\n");
  return entry;
}

module.exports = { MIN_N, DISCLAIMER, factorEffect, findPatterns, summary, readEntries, logEntry };
