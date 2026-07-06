"use strict";

/**
 * test/traction.test.js — the traction pipe's honesty guarantees.
 *
 * The report card graded Traction/adoption "D" for having no instrumentation
 * and unverifiable claims. These tests pin the two properties that make the new
 * pipe trustworthy: (1) operator-reported / unverified numbers never leak into
 * MEASURED totals, and (2) the "one workflow used by someone other than the
 * operator" gate counts only VERIFIED external events.
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/traction.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  recordTractionEvent, recordActivationOnce, recordDailyActive,
  getTractionSummary, classifyActor,
} = require("../lib/traction");

function readEvents(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

function tmpFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "traction-"));
  const walletJson = path.join(dir, "wallet.json");
  const walletLedger = path.join(dir, "ledger.jsonl");
  const creatorsDir = path.join(dir, "creators");
  fs.mkdirSync(creatorsDir, { recursive: true });
  fs.writeFileSync(walletJson, JSON.stringify({ clearedCashUsd: 0, pendingInvoiceUsd: 398, receivedPayments: [] }));
  fs.writeFileSync(walletLedger,
    ["SEND-001", "SEND-002", "SEND-003"]
      .map((id) => JSON.stringify({ event: "outreach_send", sendId: id, status: "sent_awaiting_response" }))
      .join("\n") + "\n");
  fs.writeFileSync(path.join(creatorsDir, "courtney.json"), "{}");
  return { dir, file: path.join(dir, "events.jsonl"), walletJson, walletLedger, creatorsDir };
}

test("classifyActor separates the operator from external users", () => {
  process.env.KEYSTONE_OPERATOR = "alex,founder,operator";
  assert.equal(classifyActor("Alex"), "operator");     // case-insensitive
  assert.equal(classifyActor("kriskin"), "external");
  assert.equal(classifyActor(""), "unknown");
  delete process.env.KEYSTONE_OPERATOR;
  // Default set must classify the operator's Google-login gmail as operator, so the
  // operator's own email-verification signups never inflate external adoption.
  assert.equal(classifyActor("alex.place.7@gmail.com"), "operator");
  assert.equal(classifyActor("newuser@example.com"), "external");
});

test("recordTractionEvent defaults to unverified and rejects unknown kinds", async () => {
  const fx = tmpFixtures();
  const rec = await recordTractionEvent({ kind: "activation", actor: "kriskin" }, { file: fx.file });
  assert.equal(rec.verified, false);                    // must prove itself to count
  assert.equal(rec.actorType, "external");
  assert.equal(rec.confidence, "low");
  await assert.rejects(() => recordTractionEvent({ kind: "banana", actor: "x" }, { file: fx.file }));
});

test("operator-reported revenue is NEVER counted as cleared", async () => {
  const fx = tmpFixtures();
  await recordTractionEvent(
    { kind: "revenue", actor: "patreon", verified: false, amountUsd: 5000 },
    { file: fx.file }
  );
  const s = getTractionSummary(fx);
  assert.equal(s.revenue.clearedUsd, 0);                            // wallet truth, untouched
  assert.equal(s.revenue.operatorReported.evidenceClass, "OPERATOR_REPORTED_UNVERIFIED");
  assert.equal(s.arcReactorGates.onePaidPilot, false);
});

test("the non-operator-workflow gate counts ONLY verified external events", async () => {
  const fx = tmpFixtures();
  // An operator-reported (unverified) external user does NOT satisfy the gate.
  await recordTractionEvent({ kind: "workflow_used", actor: "kriskin", verified: false }, { file: fx.file });
  let s = getTractionSummary(fx);
  assert.equal(s.nonOperatorWorkflows.count, 0);
  assert.equal(s.arcReactorGates.oneNonOperatorWorkflow, false);

  // The operator dogfooding does NOT satisfy it either.
  await recordTractionEvent({ kind: "workflow_used", actor: "alex", actorType: "operator", verified: true }, { file: fx.file });
  s = getTractionSummary(fx);
  assert.equal(s.nonOperatorWorkflows.count, 0);

  // A VERIFIED external workflow finally moves the gate.
  await recordTractionEvent({ kind: "workflow_used", actor: "realuser", actorType: "external", verified: true }, { file: fx.file });
  s = getTractionSummary(fx);
  assert.equal(s.nonOperatorWorkflows.count, 1);
  assert.deepEqual(s.nonOperatorWorkflows.actors, ["realuser"]);
  assert.equal(s.arcReactorGates.oneNonOperatorWorkflow, true);
});

test("#2040 recordActivationOnce fires exactly once per actor, then no-ops", async () => {
  const fx = tmpFixtures();
  const first = await recordActivationOnce(
    { actor: "kriskin", verified: true, source: "chat-reply", note: "first_chat_reply" },
    { file: fx.file }
  );
  assert.equal(first.kind, "activation");
  assert.equal(first.verified, true);
  const second = await recordActivationOnce({ actor: "kriskin", verified: true }, { file: fx.file });
  assert.equal(second, null);                                   // idempotent — no duplicate
  assert.equal(readEvents(fx.file).filter((e) => e.kind === "activation").length, 1);
  const unknown = await recordActivationOnce({ actor: "unknown", verified: true }, { file: fx.file });
  assert.equal(unknown, null);                                  // unknown actor is not activation
});

test("#2041 recordDailyActive dedupes per actor+day and feeds retention", async () => {
  const fx = tmpFixtures();
  // Two sessions the SAME day → one record.
  const a = await recordDailyActive({ actor: "kriskin", verified: true, ts: "2026-07-04T08:00:00.000Z" }, { file: fx.file });
  const b = await recordDailyActive({ actor: "kriskin", verified: true, ts: "2026-07-04T20:00:00.000Z" }, { file: fx.file });
  assert.equal(a.kind, "daily_active");
  assert.equal(b, null);
  // Next day → a second record.
  const c = await recordDailyActive({ actor: "kriskin", verified: true, ts: "2026-07-05T09:00:00.000Z" }, { file: fx.file });
  assert.ok(c);
  assert.equal(readEvents(fx.file).filter((e) => e.kind === "daily_active").length, 2);
  // ≥2 distinct external active days → counted as returning in the MEASURED summary.
  const s = getTractionSummary(fx);
  assert.equal(s.retention.returningExternalActors, 1);
  assert.equal(s.retention.evidenceClass, "MEASURED");
});

test("MEASURED outreach comes from the wallet ledger, and gaps surface the empty state", async () => {
  const fx = tmpFixtures();
  const s = getTractionSummary(fx);
  assert.equal(s.outreach.sends, 3);
  assert.equal(s.outreach.evidenceClass, "MEASURED");
  assert.equal(s.creatorsOnboarded.count, 1);
  assert.ok(s.gaps.some((g) => /No cleared revenue/.test(g)));
  assert.ok(s.gaps.some((g) => /non-operator workflows/i.test(g)));
});
