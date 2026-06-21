// Convergence #919 finding #2 — answer → claim-packet bridge.
// Verifies a Σ₀ grounding record becomes a VALID draft packet that the consent
// gate accepts, lists, but refuses to export (no auto-approval / signing).
//
// Run: node apps/lantern-garage/test/claim-draft.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildDraftPacket, draftClaimsFromRecords, isPacketWorthy, certaintyFor } =
  require("../lib/claim-draft");
const { validateClaimPacket, canExportClaim, listPackets } = require("../lib/consent-gate");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const groundedRecord = {
  claim: "The Anthropic Messages API uses the x-api-key header for auth.",
  type: "fact",
  evidence: "web: docs.anthropic.com authentication",
  confidence: 0.9,
  source: "gemini-grounding",
  sources: ["https://docs.anthropic.com/en/api", "https://github.com/anthropics/anthropic-sdk-python"],
  refuted: false,
  agent: "lantern",
};

async function main() {
  // --- worthiness gate -----------------------------------------------------
  check("worthy: grounded, confident, not refuted", () =>
    assert.strictEqual(isPacketWorthy(groundedRecord), true));
  check("unworthy: refuted record", () =>
    assert.strictEqual(isPacketWorthy({ ...groundedRecord, refuted: true }), false));
  check("unworthy: source=none (ungrounded)", () =>
    assert.strictEqual(isPacketWorthy({ ...groundedRecord, source: "none" }), false));
  check("unworthy: below confidence floor", () =>
    assert.strictEqual(isPacketWorthy({ ...groundedRecord, confidence: 0.6 }), false));

  check("certainty mapping", () => {
    assert.strictEqual(certaintyFor(0.95), "very_high");
    assert.strictEqual(certaintyFor(0.85), "high");
    assert.strictEqual(certaintyFor(0.65), "moderate");
    assert.strictEqual(certaintyFor(0.1), "none");
  });

  // --- packet shape --------------------------------------------------------
  check("buildDraftPacket produces a VALID packet", () => {
    const p = buildDraftPacket(groundedRecord, { now: "2026-06-21T00:00:00.000Z" });
    const v = validateClaimPacket(p);
    assert.ok(v.valid, "validation errors: " + JSON.stringify(v.errors));
  });
  check("draft packet is inert: draft status, unsigned, NOT exportable", () => {
    const p = buildDraftPacket(groundedRecord, { now: "2026-06-21T00:00:00.000Z" });
    assert.strictEqual(p.review.consent_gate_status, "draft");
    assert.strictEqual(p.origin.operator_approved, false);
    assert.ok(!p.signature.signature, "must not be pre-signed");
    assert.strictEqual(canExportClaim(p), false, "a draft must never be exportable");
  });
  check("evidence captures [claim, source, confidence]", () => {
    const p = buildDraftPacket(groundedRecord, { now: "2026-06-21T00:00:00.000Z" });
    assert.ok(p.claim.title.includes("x-api-key"));
    assert.deepStrictEqual(p.evidence.source_refs, groundedRecord.sources);
    assert.strictEqual(p.evidence.certainty, "very_high");
    assert.strictEqual(p.measurement.source, "gemini-grounding");
  });

  // --- end-to-end persist through the real consent gate --------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claimtest-"));
  try {
    const records = [groundedRecord, { ...groundedRecord, refuted: true }, { ...groundedRecord, source: "none" }];
    const out = await draftClaimsFromRecords(tmp, records, {});
    check("draftClaimsFromRecords drafts only the worthy record", () => {
      assert.strictEqual(out.drafted.length, 1, "exactly one worthy record: " + JSON.stringify(out));
      assert.strictEqual(out.skipped, 2);
    });
    check("persisted packet is listable as a draft", () => {
      const listed = listPackets(tmp, "draft");
      assert.strictEqual(listed.length, 1, "packet persisted + listable as draft");
      assert.ok(listed[0].packet_id.startsWith("claim:"));
      assert.strictEqual(canExportClaim(listed[0]), false);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nall claim-draft bridge checks passed");
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
