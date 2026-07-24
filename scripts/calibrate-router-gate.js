/**
 * Router Gate calibration — operating curve over the real conversation log.
 *
 * There are NO ground-truth "this turn needed Claude" labels, so this does NOT
 * report accuracy. It reports the only honest thing available: how the gate's
 * escalation rate responds to the threshold, plus the score distribution, so a
 * threshold can be chosen to hit a target escalation share (e.g. ~25%).
 *
 * It replays each operator (user) turn with its in-session history as the gate
 * would see it live, mirroring the session-splitting in router_sigma0_encoder.py
 * (new session on surface change or >30s inter-turn gap).
 *
 * Run: node scripts/calibrate-router-gate.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { gateDecision } = require("../lib/router-gate");

const LOG = path.resolve(__dirname, "..", "..", "..", "data", "conversations", "garage-conversations.jsonl");
const GAP_SECONDS = 30;
const USER_ROLE = "operator";

function loadSessions() {
  const rows = fs
    .readFileSync(LOG, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const sessions = [];
  let cur = [];
  let prevTs = null;
  let prevSurface = null;
  for (const r of rows) {
    const ts = Date.parse(r.recordedAt) / 1000;
    const surface = r.surface;
    if (cur.length && (surface !== prevSurface || (prevTs != null && ts - prevTs > GAP_SECONDS))) {
      sessions.push(cur);
      cur = [];
    }
    cur.push(r);
    prevTs = ts;
    prevSurface = surface;
  }
  if (cur.length) sessions.push(cur);
  return sessions;
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function main() {
  const sessions = loadSessions();
  const scores = [];
  let loopingCount = 0;
  let userTurns = 0;

  for (const s of sessions) {
    for (let t = 0; t < s.length; t++) {
      if ((s[t].role || "") !== USER_ROLE) continue;
      userTurns++;
      const history = s
        .slice(0, t + 1)
        .map((r) => ({ role: r.role, text: r.text || "" }));
      const d = gateDecision(history, { escalateScore: Infinity }); // never escalate -> read raw score
      if (/looping/.test(d.reason)) loopingCount++;
      else scores.push(d.score);
    }
  }

  const sorted = [...scores].sort((a, b) => a - b);
  const scorable = scores.length;

  console.log(`log: garage-conversations.jsonl`);
  console.log(`sessions: ${sessions.length}  |  operator turns: ${userTurns}  |  scorable: ${scorable}  |  short-circuited as looping: ${loopingCount}\n`);

  console.log("score distribution (operator turns, looping turns excluded):");
  for (const q of [0.1, 0.25, 0.5, 0.75, 0.9, 1.0]) {
    console.log(`  p${String(Math.round(q * 100)).padStart(3)}: ${quantile(sorted, q).toFixed(3)}`);
  }

  console.log("\nthreshold sweep — escalation rate over ALL operator turns:");
  console.log("  thresh   escalate%   (n escalated / n user turns)");
  for (const thr of [0.2, 0.3, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8]) {
    const n = scores.filter((x) => x >= thr).length;
    const pct = ((n / userTurns) * 100).toFixed(1);
    const bar = "#".repeat(Math.round((n / userTurns) * 40));
    console.log(`  ${thr.toFixed(2)}    ${pct.padStart(6)}%   (${n}/${userTurns}) ${bar}`);
  }

  // Suggest a threshold that escalates ~25% of user turns, if the data supports it.
  const target = 0.25;
  let best = null;
  for (let thr = 0.1; thr <= 1.0; thr += 0.01) {
    const rate = scores.filter((x) => x >= thr).length / userTurns;
    if (best === null || Math.abs(rate - target) < Math.abs(best.rate - target)) {
      best = { thr, rate };
    }
  }
  console.log(
    `\nclosest threshold to a ${(target * 100).toFixed(0)}% escalation target: ` +
      `${best.thr.toFixed(2)} (escalates ${(best.rate * 100).toFixed(1)}%)`
  );
  console.log(
    `current default ESCALATE_SCORE=0.45 escalates ` +
      `${((scores.filter((x) => x >= 0.45).length / userTurns) * 100).toFixed(1)}% here.`
  );

  console.log(
    "\nCAVEAT: 63 operator turns from mostly test traffic. This is an operating\n" +
      "curve for picking a threshold, NOT evidence the escalations are correct —\n" +
      "that needs labelled outcomes (provider-calls.jsonl + reply quality)."
  );
}

main();
