"use strict";
/**
 * Chat escalation meter — measures how often a live chat turn needs the expensive tier.
 *
 * WHY THIS EXISTS. docs/research/2026-07-27-in-house-model-spec-grounded-in-the-product.md
 * showed, from the measured workload, that serving ordinary chat on the cheap tier is nearly
 * free at our scale target (~$5.9k/mo at 10,000 users) while one frontier turn costs ~67x a
 * cheap one. So the entire cost curve — and the entire business case for an in-house model —
 * is the ESCALATION RATE, and that number was never measured on the chat path.
 *
 * It exists for the CODING path already: lib/keystone-escalation.js readRolloverShare()
 * computes an escalationRate from kernel convergence records. But index.html, chat.html and
 * stock-trader.html all post to /api/dream/chat/stream, which had no equivalent. This is that
 * equivalent, and it deliberately reuses the same vocabulary so the two are comparable.
 *
 * WHAT COUNTS AS AN ESCALATION. Not a routing *hint* (lib/router-gate.js emits one of those,
 * behind ROUTER_GATE=1) — those measure what we *intended*. This measures what actually served
 * the turn: the provider/model that produced the reply, mapped to a price tier. A turn is
 * escalated when a frontier-priced model answered it.
 *
 * PRIVACY — LOAD-BEARING, NOT A NICETY. Chat on the trader surface carries positions, balances
 * and P&L. This meter records ONLY derived scalars: tier, sizes, latency, surface, and a
 * one-way session hash. It never records message text, and there is no code path here that can
 * — `record()` takes the fields it wants explicitly rather than spreading a caller object, so a
 * future caller cannot accidentally leak text through it.
 *
 * FAIL-OPEN. Every write is best-effort and swallowed. A metering failure must never break a
 * user's chat turn.
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const REL = path.join("data", "metrics", "chat-escalation.jsonl");

/**
 * Price tiers, $ per million tokens (public list prices, 2026-07).
 * `tier` is what the rate is computed over; `in`/`out` drive the cost projection.
 * Unknown models fall back to "cheap" — deliberately conservative: an unclassified
 * model inflates neither the escalation rate nor the projected saving.
 */
const TIERS = {
  local: { in: 0, out: 0 },
  cheap: { in: 0.40, out: 2.00 },
  frontier: { in: 15.0, out: 75.0 },
};

const LOCAL_PROVIDERS = new Set(["ollama", "ouro", "local", "llamacpp", "vllm"]);
// Frontier = the expensive reasoning tier. Matched on MODEL, because every one of these
// providers also sells a cheap tier (gpt-4.1-mini, gemini-flash, claude-haiku).
const FRONTIER_MODEL_RE = /(opus|sonnet|gpt-5|o[34](?:-|$)|gemini-[0-9.]*-pro|grok-[0-9]+)/i;
// Cheap markers must sit on a TOKEN boundary, not just appear as a substring. Without the
// leading delimiter, "gemini-2.5-pro" matches `mini` inside "ge-mini-" and every Gemini Pro
// turn is silently counted as cheap — which understates the escalation rate and argues
// against building on a measurement artifact. Caught by test, kept as a regression.
const CHEAP_MODEL_RE = /(?:^|[-_./ ])(mini|flash|haiku|nano|lite|small|tiny|\d+\.?\d*b)(?:$|[-_./ ])/i;

/**
 * Which price tier actually served this turn? Pure — this is the unit under test.
 * @returns {"local"|"cheap"|"frontier"}
 */
function classifyTier(provider, model) {
  const p = String(provider || "").toLowerCase();
  const m = String(model || "").toLowerCase();
  if (LOCAL_PROVIDERS.has(p)) return "local";
  // A cheap marker wins over a frontier one: "claude-3-5-haiku" is cheap, not frontier.
  if (CHEAP_MODEL_RE.test(m)) return "cheap";
  if (FRONTIER_MODEL_RE.test(m)) return "frontier";
  return "cheap";
}

/** One-way session hash — lets us count distinct sessions without storing an identifier. */
function _hash(v) {
  if (!v) return null;
  return crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 12);
}

/**
 * Record one completed chat turn. Explicit field list — no object spread — so message text
 * cannot reach the log through a future caller. Best-effort; never throws, never blocks.
 *
 * @param {object} o
 * @param {string} o.provider        provider that produced the reply
 * @param {string} o.model           model that produced the reply
 * @param {string} [o.surface]       "dream-chat" | "stock-trader" | ...
 * @param {number} [o.replyChars]    length of the reply (size only, never content)
 * @param {number} [o.promptChars]   approximate input size
 * @param {number} [o.latencyMs]
 * @param {number} [o.toolCalls]
 * @param {boolean} [o.gateEscalate] what router-gate WANTED (intent), for intent-vs-actual
 * @param {number} [o.trust]         answer-trust score, when computed
 * @param {string} [o.sessionId]     hashed before writing; never stored raw
 * @param {string} repoRoot
 */
function record(o, repoRoot) {
  try {
    const tier = classifyTier(o.provider, o.model);
    const row = {
      ts: new Date().toISOString(),
      tier,
      provider: String(o.provider || "").slice(0, 40) || null,
      model: String(o.model || "").slice(0, 60) || null,
      surface: String(o.surface || "").slice(0, 40) || null,
      replyChars: Number.isFinite(o.replyChars) ? Math.round(o.replyChars) : null,
      promptChars: Number.isFinite(o.promptChars) ? Math.round(o.promptChars) : null,
      latencyMs: Number.isFinite(o.latencyMs) ? Math.round(o.latencyMs) : null,
      toolCalls: Number.isFinite(o.toolCalls) ? o.toolCalls : null,
      gateEscalate: typeof o.gateEscalate === "boolean" ? o.gateEscalate : null,
      trust: Number.isFinite(o.trust) ? Math.round(o.trust * 1000) / 1000 : null,
      session: _hash(o.sessionId),
    };
    const p = path.join(repoRoot, REL);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(row) + "\n");
    return row;
  } catch (_e) {
    return null; // metering must never break a chat turn
  }
}

/** Read raw rows. Tolerates a partially-written trailing line. */
function readRows(repoRoot) {
  try {
    const p = path.join(repoRoot, REL);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf8").split("\n").reduce((acc, l) => {
      if (l.trim()) { try { acc.push(JSON.parse(l)); } catch (_e) { /* skip partial */ } }
      return acc;
    }, []);
  } catch (_e) { return []; }
}

const CHARS_PER_TOKEN = 4; // measured on our own logs; good enough for a cost projection

/**
 * The verdict, kept in one place so the thresholds cannot drift silently.
 *
 * The trap this guards: if escalation is switched off, the realized rate is 0 BY POLICY and
 * reads BUILD-NEGATIVE no matter how many turns actually needed the big model. So a flat-zero
 * realized rate defers to the demand signal instead of being reported as a finding.
 *
 * Thresholds (15% / 5%) come from the spec doc and were fixed before any data was collected.
 */
function _verdict(realized, demand) {
  if (realized === null) return "no data yet";
  if (realized === 0 && demand !== null && demand > 0.02) {
    return `POLICY-BOUND — nothing escalated, so the realized rate measures our routing, not need; `
      + `the demand signal says ${Math.round(demand * 1000) / 10}% of turns looked hard. `
      + `Enable escalation on a slice before reading this as evidence either way`;
  }
  if (realized >= 0.15) return "BUILD-SUPPORTIVE — escalation premium is the dominant cost; an in-house verifier attacks it";
  if (realized >= 0.05) return "INCONCLUSIVE — premium is real but modest; re-measure at larger n before committing people";
  return "BUILD-NEGATIVE — escalation is rare, renting the frontier is cheap; spend the team on features instead";
}

/**
 * Aggregate the rate + the cost counterfactual. Pure over `rows` so it is unit-testable.
 *
 * The headline is `escalationRate`: the fraction of NON-LOCAL turns served by the frontier
 * tier. Local turns are excluded from the denominator because they are already free — an
 * in-house model cannot save money it is already saving.
 */
function summarize(rows, { sinceTs = 0, users = [1000, 5000, 10000], turnsPerUserPerDay = 15 } = {}) {
  const byTier = { local: 0, cheap: 0, frontier: 0 };
  const bySurface = {};
  let inTok = 0, outTok = 0, n = 0, gateWanted = 0, gateAgreed = 0, gateSeen = 0;
  const sessions = new Set();

  for (const r of rows || []) {
    if (!r || !r.tier) continue;
    if (sinceTs && (Date.parse(r.ts) || 0) < sinceTs) continue;
    n++;
    byTier[r.tier] = (byTier[r.tier] || 0) + 1;
    const s = r.surface || "unknown";
    bySurface[s] = bySurface[s] || { turns: 0, frontier: 0 };
    bySurface[s].turns++;
    if (r.tier === "frontier") bySurface[s].frontier++;
    if (r.session) sessions.add(r.session);
    inTok += (r.promptChars || 0) / CHARS_PER_TOKEN;
    outTok += (r.replyChars || 0) / CHARS_PER_TOKEN;
    if (typeof r.gateEscalate === "boolean") {
      gateSeen++;
      if (r.gateEscalate) gateWanted++;
      if (r.gateEscalate === (r.tier === "frontier")) gateAgreed++;
    }
  }

  const billable = byTier.cheap + byTier.frontier;
  const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
  const escalationRate = billable ? round(byTier.frontier / billable) : null;

  // Cost per turn at the OBSERVED mix, using the measured average turn shape.
  const avgIn = n ? inTok / n : 0;
  const avgOut = n ? outTok / n : 0;
  const perTurn = (t) => (avgIn * TIERS[t].in + avgOut * TIERS[t].out) / 1e6;
  const blended = escalationRate === null ? null
    : (1 - escalationRate) * perTurn("cheap") + escalationRate * perTurn("frontier");

  const projections = escalationRate === null ? [] : users.map((u) => {
    const turns = u * turnsPerUserPerDay * 30;
    const allCheap = turns * perTurn("cheap");
    const observed = turns * blended;
    return {
      users: u, turnsPerMonth: turns,
      allCheapUsd: round(allCheap, 0),
      atObservedRateUsd: round(observed, 0),
      // What an in-house verifier could save: the escalation premium, nothing else.
      escalationPremiumUsd: round(observed - allCheap, 0),
    };
  });

  return {
    turns: n,
    sessions: sessions.size,
    byTier,
    bySurface,
    escalationRate,
    escalationRatePct: escalationRate === null ? null : round(escalationRate * 100, 2),
    avgInTokens: round(avgIn, 0),
    avgOutTokens: round(avgOut, 0),
    costPerTurnUsd: {
      cheap: round(perTurn("cheap"), 6),
      frontier: round(perTurn("frontier"), 6),
      blendedObserved: blended === null ? null : round(blended, 6),
      frontierMultiple: perTurn("cheap") > 0 ? round(perTurn("frontier") / perTurn("cheap"), 1) : null,
    },
    // DEMAND vs POLICY — the distinction that makes the headline rate interpretable.
    // `escalationRate` is what we CHOSE to spend. `demandRate` is how many turns the router
    // gate judged hard enough to deserve the big model, computed measure-only regardless of
    // whether escalation is enabled. With escalation switched off the realized rate is 0 by
    // construction and says nothing about need; demand is what carries the signal there.
    demand: gateSeen ? {
      observed: gateSeen,
      demandRatePct: round(100 * gateWanted / gateSeen, 2),
      agreedWithActualPct: round(100 * gateAgreed / gateSeen, 2),
    } : null,
    projections,
    // The decision this number exists to make, stated so it cannot be quietly reinterpreted.
    // Thresholds are from the spec doc, fixed BEFORE any data was collected.
    verdict: _verdict(escalationRate, gateSeen ? gateWanted / gateSeen : null),
    sampleAdequate: n >= 1000,
  };
}

module.exports = { classifyTier, record, readRows, summarize, TIERS, REL, CHARS_PER_TOKEN };
