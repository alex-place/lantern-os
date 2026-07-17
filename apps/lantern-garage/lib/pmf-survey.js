"use strict";

/**
 * lib/pmf-survey.js — the Sean Ellis product-market-fit check (#2551).
 *
 * Product plan v5 §02, Level-2 clear-condition: survey ACTIVE users —
 * "How would you feel if you could no longer use unisona.ai?" — and require
 * ≥40% "very disappointed". The plan's rule: if the fit check fails, improve
 * the product — don't spend on ads. Level 2 (pricing + growth spend) gates on it.
 *
 * Σ₀ discipline (same as lib/active-user-metric.js):
 *   - Eligibility = the COMPOSITE active definition (watchlist + ≥10 chats +
 *     ≥1 paper trade, operator excluded) — only genuinely-active users are asked.
 *   - Prompt-once is AUDITABLE: showing the survey records a `pmf_prompted`
 *     event; answering records `pmf_response`. Eligibility requires neither
 *     exists, so nobody is prompted twice — provable from the log alone.
 *   - One response per user, first write wins; the tally is computable from
 *     `data/traction/events.jsonl` with no other state.
 *   - MEASURED only: both events are machine-recorded from an authed session
 *     (verified:true); the tally never counts unverified rows.
 *
 * LOOP STAGE: Converge (grounds the Level-2 gate in measured user sentiment).
 */

const path = require("path");
const fs = require("fs");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_FILE = path.join(repoRoot, "data", "traction", "events.jsonl");

const FEELINGS = Object.freeze(["very_disappointed", "somewhat_disappointed", "not_disappointed"]);
const BAR = 0.4; // Sean Ellis threshold: 40% very-disappointed

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/)
      .filter((l) => l && !l.trimStart().startsWith("#"))
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function pmfEvents(file) {
  return readJsonl(file || DEFAULT_FILE).filter(
    (e) => (e.kind === "pmf_prompted" || e.kind === "pmf_response") && e.verified === true
  );
}

/**
 * Is this user eligible to be shown the survey right now?
 * eligible = composite-active AND never prompted AND never answered.
 */
function eligibility(userId, opts = {}) {
  const uid = String(userId || "").trim();
  if (!uid) return { eligible: false, reason: "no_user" };
  const { classifyActor } = require("./traction");
  if (classifyActor(uid) !== "external") return { eligible: false, reason: "operator_or_unknown" };

  const events = pmfEvents(opts.tractionFile);
  if (events.some((e) => e.actor === uid && e.kind === "pmf_response")) {
    return { eligible: false, reason: "already_answered" };
  }
  if (events.some((e) => e.actor === uid && e.kind === "pmf_prompted")) {
    return { eligible: false, reason: "already_prompted" };
  }

  const { evaluateActiveUsers } = require("./active-user-metric");
  const { actives } = evaluateActiveUsers(opts);
  if (!actives.some((u) => u.userId === uid)) {
    return { eligible: false, reason: "not_active" };
  }
  return { eligible: true, reason: "active_never_asked" };
}

/** Record that the survey was SHOWN (called once, right before display). */
async function recordPrompted(userId, opts = {}) {
  const e = eligibility(userId, opts);
  if (!e.eligible) return { ok: false, reason: e.reason };
  const { recordTractionEvent } = require("./traction");
  const rec = await recordTractionEvent({
    kind: "pmf_prompted",
    actor: String(userId),
    verified: true,
    confidence: "high",
    source: opts.source || "GET /api/pmf/survey",
    evidence: { question: "How would you feel if you could no longer use unisona.ai?" },
  }, { file: opts.tractionFile });
  return { ok: true, event: rec };
}

/** Record the user's answer. One per user — a second write no-ops. */
async function recordResponse(userId, { feeling, benefit, alternative } = {}, opts = {}) {
  const uid = String(userId || "").trim();
  if (!uid) return { ok: false, reason: "no_user" };
  const f = String(feeling || "").trim().toLowerCase();
  if (!FEELINGS.includes(f)) return { ok: false, reason: "invalid_feeling", valid: FEELINGS };
  const { classifyActor } = require("./traction");
  if (classifyActor(uid) !== "external") return { ok: false, reason: "operator_or_unknown" };
  const already = pmfEvents(opts.tractionFile).some((e) => e.actor === uid && e.kind === "pmf_response");
  if (already) return { ok: false, reason: "already_answered" };
  const { recordTractionEvent } = require("./traction");
  const rec = await recordTractionEvent({
    kind: "pmf_response",
    actor: uid,
    verified: true,
    confidence: "high",
    source: opts.source || "POST /api/pmf/response",
    evidence: {
      feeling: f,
      benefit: String(benefit || "").slice(0, 500) || null,
      alternative: String(alternative || "").slice(0, 500) || null,
    },
  }, { file: opts.tractionFile });
  return { ok: true, event: rec };
}

/**
 * The tally — computable from the log alone (acceptance criterion).
 * Dedup by actor (first response wins); rate null when n === 0.
 */
function tally(opts = {}) {
  const byUser = new Map();
  for (const e of pmfEvents(opts.tractionFile)) {
    if (e.kind !== "pmf_response") continue;
    const f = e.evidence && e.evidence.feeling;
    if (!FEELINGS.includes(f)) continue;
    if (!byUser.has(e.actor)) byUser.set(e.actor, e); // first wins
  }
  const counts = { very_disappointed: 0, somewhat_disappointed: 0, not_disappointed: 0 };
  const freeText = [];
  for (const e of byUser.values()) {
    counts[e.evidence.feeling]++;
    if (e.evidence.benefit || e.evidence.alternative) {
      freeText.push({ userId: e.actor, feeling: e.evidence.feeling, benefit: e.evidence.benefit, alternative: e.evidence.alternative });
    }
  }
  const n = byUser.size;
  const rate = n ? counts.very_disappointed / n : null;
  return {
    n,
    counts,
    pctVeryDisappointed: rate,
    bar: BAR,
    pass: rate != null && rate >= BAR, // an unmeasured check never passes
    provenance: "MEASURED",
    freeText: freeText.slice(0, 100),
  };
}

module.exports = { FEELINGS, BAR, eligibility, recordPrompted, recordResponse, tally };
