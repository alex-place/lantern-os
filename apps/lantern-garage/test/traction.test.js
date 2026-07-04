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

const { recordTractionEvent, getTractionSummary, classifyActor } = require("../lib/traction");

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

test("MEASURED outreach comes from the wallet ledger, and gaps surface the empty state", async () => {
  const fx = tmpFixtures();
  const s = getTractionSummary(fx);
  assert.equal(s.outreach.sends, 3);
  assert.equal(s.outreach.evidenceClass, "MEASURED");
  assert.equal(s.creatorsOnboarded.count, 1);
  assert.ok(s.gaps.some((g) => /No cleared revenue/.test(g)));
  assert.ok(s.gaps.some((g) => /non-operator workflows/i.test(g)));
});
