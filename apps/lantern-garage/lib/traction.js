"use strict";

/**
 * lib/traction.js — the traction / adoption evidence pipe.
 *
 * WHY THIS EXISTS
 * The report card graded Traction/adoption "D": revenue telemetry lived only in
 * an LLM cost ledger, activation/retention had *zero* instrumentation, and the
 * named power users + operator-reported Patreon income were "unverifiable
 * in-repo and unsized." There was no pipe to measure any of it.
 *
 * This module is that pipe. It does NOT invent numbers — the Arc Reactor's own
 * boundary is "No fake revenue" (data/arc-reactor/status.json) and the Σ₀
 * protocol forbids fabrication. Instead it records real, sourced events
 * append-only and aggregates them into *evidence-classed* metrics, so every
 * traction claim finally carries [claim, evidence, confidence, source] and the
 * true state (e.g. $0 cleared, 0 verified non-operator workflows) becomes
 * measurable instead of anecdotal. Making the emptiness visible IS the fix:
 * you cannot improve activation/retention/NRR you do not measure.
 *
 * LOOP STAGE: OBSERVE (record real usage/revenue/activation events) +
 * VERIFY (evidence-class every number; quarantine unverified from measured
 * totals; never silently upgrade an evidence class — Σ₀ §2).
 *
 * SOURCES OF TRUTH (read-only; never duplicated here):
 *   - Revenue / outreach : data/wallet/local-cash-wallet.json + data/wallet/ledger.jsonl
 *   - Onboarded creators : data/creators/*.json
 *   - Usage / activation : data/traction/events.jsonl  (this module's append log)
 */

const fs = require("fs");
const path = require("path");
const { appendJsonlQueued } = require("./file-queue");

const repoRoot = path.resolve(__dirname, "..", "..", "..");

const DEFAULTS = {
  file: path.join(repoRoot, "data", "traction", "events.jsonl"),
  walletJson: path.join(repoRoot, "data", "wallet", "local-cash-wallet.json"),
  walletLedger: path.join(repoRoot, "data", "wallet", "ledger.jsonl"),
  creatorsDir: path.join(repoRoot, "data", "creators"),
};

// Evidence classes — a definition, not a consequence. Never silently upgrade
// one to a stronger one (Σ₀ COLLAPSE-CERTIFICATE §2).
const MEASURED = "MEASURED";                              // machine-checked from an in-repo artifact
const OPERATOR_REPORTED = "OPERATOR_REPORTED_UNVERIFIED"; // operator states it; not verifiable in-repo
const REFERENCE = "REFERENCE_ONLY";                       // external benchmark, nothing to measure against yet

// Event kinds the ledger understands.
const VALID_KINDS = new Set([
  "signup",            // an actor created an account / first-touched a surface
  "activation",        // an actor reached a first-value milestone
  "workflow_used",     // an actor completed a real workflow (resume, job app, chat task, deck…)
  "revenue",           // money (verified only when it maps to a cleared wallet receipt)
  "outreach",          // a send to a prospect (mirror of the wallet ledger's outreach_send)
  "creator_onboarded", // a creator profile was ingested
  "feedback",          // a user/customer/stakeholder feedback receipt
  "daily_active",      // an actor was active on a given UTC day (retention signal, #2041)
  "churn",             // an actor lapsed
]);

// daily_active is a usage signal, so it feeds distinct-day retention below.
const USAGE_KINDS = new Set(["signup", "activation", "workflow_used", "feedback", "daily_active"]);

// Operator identity — so the operator's own dogfooding never inflates "external"
// adoption. The whole report-card ask is "used by someone OTHER than the
// operator", so this seam is load-bearing. Env-overridable, comma-separated.
function operatorSet() {
  const raw = process.env.KEYSTONE_OPERATOR
    || "alex place,alex,alex-place,founder,founder@lantern-os.net,operator,keystone";
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function classifyActor(actor) {
  const a = String(actor || "").trim().toLowerCase();
  if (!a || a === "unknown") return "unknown";
  return operatorSet().has(a) ? "operator" : "external";
}

function readAllJsonl(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => l && !l.trimStart().startsWith("#"))
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Append one real traction event. Defaults are deliberately conservative:
 * `verified` defaults to FALSE — a claim must prove itself to count as MEASURED.
 * Unverified events are recorded (so the claim is auditable with a source) but
 * are excluded from every MEASURED metric by getTractionSummary().
 */
async function recordTractionEvent(event = {}, opts = {}) {
  const file = opts.file || DEFAULTS.file;
  const kind = String(event.kind || "").trim();
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`traction: unknown event kind "${kind}" (valid: ${[...VALID_KINDS].join(", ")})`);
  }
  const actor = String(event.actor || "").trim() || "unknown";
  const verified = event.verified === true;
  const rec = {
    ts: event.ts || new Date().toISOString(),
    kind,
    actor,
    actorType: event.actorType || classifyActor(actor),
    verified,
    confidence: event.confidence || (verified ? "high" : "low"),
    source: event.source || (verified ? null : "operator-reported"),
    evidence: event.evidence || null,
    amountUsd: typeof event.amountUsd === "number" ? event.amountUsd : null,
    note: event.note || null,
  };
  await appendJsonlQueued(file, rec, { rotate: true });
  return rec;
}

/**
 * #2040 — Activation, fired ONCE per actor ever. Records the first-value
 * milestone (e.g. a user's first successful chat reply) exactly once, so
 * repeated replies don't re-emit. Best-effort idempotency (reads the ledger for
 * a prior activation by this actor); a race that slips a duplicate through is
 * harmless because getTractionSummary dedupes activation by distinct actor.
 * Returns the recorded event, or null if already activated / actor unknown.
 */
async function recordActivationOnce(event = {}, opts = {}) {
  const file = opts.file || DEFAULTS.file;
  const actor = String(event.actor || "").trim();
  if (!actor || actor.toLowerCase() === "unknown") return null;
  const prior = readAllJsonl(file).some((e) => e.kind === "activation" && e.actor === actor);
  if (prior) return null;
  return recordTractionEvent({ ...event, kind: "activation" }, opts);
}

/**
 * #2041 — Daily-active retention signal, fired at most ONCE per actor per UTC
 * day (deduped on actor+date). Enough to compute D1/D7 return offline. Same
 * best-effort idempotency + Set-dedup safety net as recordActivationOnce.
 * Returns the recorded event, or null if already recorded today / actor unknown.
 */
async function recordDailyActive(event = {}, opts = {}) {
  const file = opts.file || DEFAULTS.file;
  const actor = String(event.actor || "").trim();
  if (!actor || actor.toLowerCase() === "unknown") return null;
  const date = String(event.date || event.ts || new Date().toISOString()).slice(0, 10);
  const prior = readAllJsonl(file).some(
    (e) => e.kind === "daily_active" && e.actor === actor && String(e.ts || "").slice(0, 10) === date
  );
  if (prior) return null;
  return recordTractionEvent({ ...event, kind: "daily_active", ts: event.ts }, opts);
}

/**
 * Aggregate the ledgers into an evidence-classed traction summary. Pure read;
 * safe to call from a GET handler. Paths are overridable for tests.
 */
function getTractionSummary(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  const events = readAllJsonl(cfg.file);
  const walletLedger = readAllJsonl(cfg.walletLedger);
  let wallet = {};
  try { wallet = JSON.parse(fs.readFileSync(cfg.walletJson, "utf8")); } catch { /* absent */ }

  // ── Revenue: the wallet is the single source of truth. Never fabricate. ──
  const clearedUsd = Number(wallet.clearedCashUsd || 0);
  const pendingUsd = Number(wallet.pendingInvoiceUsd || 0);
  const receivedPayments = Array.isArray(wallet.receivedPayments) ? wallet.receivedPayments : [];

  // Operator-reported revenue (verified:false) is recorded but held OUT of cleared.
  const reportedRevenue = events.filter((e) => e.kind === "revenue" && !e.verified);
  const reportedSized = reportedRevenue.filter((e) => typeof e.amountUsd === "number");
  const operatorReportedUsd = reportedSized.reduce((a, e) => a + e.amountUsd, 0);
  const operatorReportedUnsized = reportedRevenue.length - reportedSized.length;

  // ── Outreach: the wallet ledger's outreach_send events are the truth. ──
  const outreachSends = walletLedger.filter((e) => e.event === "outreach_send");
  const awaiting = outreachSends.filter((e) => /awaiting/i.test(String(e.status || "")));
  const converted = outreachSends.filter((e) => /clear|paid|won/i.test(String(e.status || "")));

  // ── Actors / activation / retention: VERIFIED usage events only. ──
  const verifiedUsage = events.filter((e) => USAGE_KINDS.has(e.kind) && e.verified);
  const externalActors = new Set(verifiedUsage.filter((e) => e.actorType === "external").map((e) => e.actor));
  const operatorActors = new Set(verifiedUsage.filter((e) => e.actorType === "operator").map((e) => e.actor));
  const allActors = new Set(verifiedUsage.map((e) => e.actor));

  // Activation = distinct EXTERNAL actor with a verified activation or completed workflow.
  const activatedExternal = new Set(
    events
      .filter((e) => e.verified && e.actorType === "external" && (e.kind === "activation" || e.kind === "workflow_used"))
      .map((e) => e.actor)
  );

  // THE Arc Reactor Movie-2 gate: distinct external actors with a VERIFIED
  // workflow_used event. This is "one workflow used by someone other than the
  // operator." Honest baseline is 0 until a real external run is recorded.
  const nonOperatorWorkflowActors = new Set(
    events
      .filter((e) => e.verified && e.actorType === "external" && e.kind === "workflow_used")
      .map((e) => e.actor)
  );

  // Retention = external actor active on ≥2 distinct UTC days (verified usage).
  const daysByActor = new Map();
  for (const e of verifiedUsage) {
    if (e.actorType !== "external") continue;
    const day = String(e.ts || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!daysByActor.has(e.actor)) daysByActor.set(e.actor, new Set());
    daysByActor.get(e.actor).add(day);
  }
  const returningExternal = [...daysByActor.values()].filter((s) => s.size >= 2).length;

  // Operator-reported (unverified) named actors — recorded for auditability,
  // NOT counted as measured adoption.
  const reportedActors = new Set(
    events
      .filter((e) => !e.verified && e.actorType === "external"
        && ["signup", "activation", "workflow_used", "revenue", "feedback"].includes(e.kind))
      .map((e) => e.actor)
      .filter((a) => a && a !== "unknown")
  );

  // ── Creators onboarded: real profiles on disk. ──
  let creatorsOnboarded = 0;
  try {
    creatorsOnboarded = fs.readdirSync(cfg.creatorsDir).filter((f) => f.endsWith(".json")).length;
  } catch { /* absent */ }

  const feedbackReceipts = events.filter((e) => e.kind === "feedback" && e.verified && e.actorType === "external").length;
  const onePaidPilot = clearedUsd > 0 || receivedPayments.length > 0;

  const gaps = [
    clearedUsd === 0 ? "No cleared revenue yet (clearedCashUsd = 0)." : null,
    nonOperatorWorkflowActors.size === 0
      ? "0 VERIFIED non-operator workflows — the primary Movie-2 gate. Record a workflow_used event with verified:true when a real external run happens." : null,
    operatorReportedUnsized > 0
      ? `${operatorReportedUnsized} operator-reported revenue claim(s) are unsized/unverified — attach an in-repo receipt to promote to MEASURED.` : null,
    reportedActors.size > 0
      ? `${reportedActors.size} named user(s) are operator-reported only (${[...reportedActors].join(", ")}) — no in-repo activation evidence yet.` : null,
    returningExternal === 0
      ? "No multi-day external retention recorded — activation/retention instrumentation is live but empty." : null,
  ].filter(Boolean);

  return {
    generatedAt: new Date().toISOString(),
    disclaimer:
      "Every number is evidence-classed. MEASURED = machine-checked from an in-repo artifact; " +
      "OPERATOR_REPORTED_UNVERIFIED = operator-stated, not verifiable in-repo and NOT counted toward measured totals; " +
      "REFERENCE_ONLY = external benchmark with nothing to measure against yet. No fabricated revenue (Arc Reactor boundary).",
    revenue: {
      clearedUsd,
      pendingInvoiceUsd: pendingUsd,
      receivedPayments: receivedPayments.length,
      evidenceClass: MEASURED,
      source: "data/wallet/local-cash-wallet.json",
      operatorReported: {
        sizedUsd: reportedSized.length ? operatorReportedUsd : null,
        unsizedClaims: operatorReportedUnsized,
        evidenceClass: OPERATOR_REPORTED,
        note: "Operator-reported income (e.g. Patreon). Not in any in-repo ledger; excluded from clearedUsd.",
      },
    },
    outreach: {
      sends: outreachSends.length,
      awaitingResponse: awaiting.length,
      converted: converted.length,
      evidenceClass: MEASURED,
      source: "data/wallet/ledger.jsonl",
    },
    actors: {
      distinctTotal: allActors.size,
      distinctExternal: externalActors.size,
      distinctOperator: operatorActors.size,
      operatorIdentity: [...operatorSet()],
      evidenceClass: MEASURED,
      source: "data/traction/events.jsonl (verified usage only)",
    },
    activation: {
      externalActivated: activatedExternal.size,
      externalActivationRate: externalActors.size
        ? Math.round((activatedExternal.size / externalActors.size) * 100) / 100 : null,
      evidenceClass: MEASURED,
      note: "Distinct non-operator actors who reached a verified activation or completed-workflow event.",
    },
    nonOperatorWorkflows: {
      count: nonOperatorWorkflowActors.size,
      actors: [...nonOperatorWorkflowActors],
      evidenceClass: MEASURED,
      gate: "Arc Reactor Movie-2 gate: 'one workflow used by someone other than the operator'.",
    },
    retention: {
      returningExternalActors: returningExternal,
      evidenceClass: MEASURED,
      note: "External actors active on ≥2 distinct UTC days. NRR / churn require paid cohorts we do not yet have.",
    },
    operatorReportedUsage: {
      namedActors: [...reportedActors],
      count: reportedActors.size,
      evidenceClass: OPERATOR_REPORTED,
      note: "Named users the operator reports but that carry no in-repo activation evidence. Recorded for auditability; not counted as measured adoption.",
    },
    creatorsOnboarded: {
      count: creatorsOnboarded,
      evidenceClass: MEASURED,
      source: "data/creators/",
      note: "Onboarded profile ≠ active workflow.",
    },
    arcReactorGates: {
      fiveOutreachSends: outreachSends.length >= 5,
      oneNonOperatorWorkflow: nonOperatorWorkflowActors.size >= 1,
      onePaidPilot,
      oneFeedbackReceipt: feedbackReceipts >= 1,
      evidenceClass: MEASURED,
      source: "computed from data/wallet + data/traction ledgers",
    },
    benchmarks2026Saas: {
      reference: { nrrAvgPct: 106, nrrPlgRangePct: [115, 145], monthlyChurnMaxPct: 3.5, eliteChurnPct: 2, churnInFirst90DaysPct: 70 },
      status: "We lack paid cohorts to measure NRR / churn against these yet.",
      evidenceClass: REFERENCE,
      source: "report-card benchmark column (2026 SaaS norms)",
    },
    gaps,
  };
}

module.exports = {
  recordTractionEvent,
  recordActivationOnce,
  recordDailyActive,
  getTractionSummary,
  classifyActor,
  operatorSet,
  VALID_KINDS,
  DEFAULTS,
  EVIDENCE: { MEASURED, OPERATOR_REPORTED, REFERENCE },
};
