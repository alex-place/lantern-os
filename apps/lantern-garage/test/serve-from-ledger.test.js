"use strict";
// #2859 — serve-from-ledger determinism + honesty gates.
// The answer must be a function of (question, VERIFIED knowledge): a converged record is served
// verbatim + provenance; an unverified / artifact-less / low-confidence / non-matching record is
// NEVER served (falls through to normal generation). Deterministic: same inputs → same record.
//
// Run: node apps/lantern-garage/test/serve-from-ledger.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { lookupLedgerAnswer, isConverged } = require("../lib/serve-from-ledger");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

function writeLedger(rows) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), "records.jsonl");
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

const CONVERGED = {
  id: "cr-good", hypothesis: "The capital of France is Paris",
  result: "Paris", confidence: 0.95, verified: true, verified_by: ["pr:#123"],
  source: "geography", timestamp: "2026-07-01T00:00:00Z", reasoner: "keystone",
};
const UNVERIFIED = {
  id: "cr-unver", hypothesis: "The capital of France is Paris",
  result: "Lyon", confidence: 0.99, verified: false, verified_by: [],
  timestamp: "2026-07-02T00:00:00Z",
};
const NO_ARTIFACT = {
  id: "cr-noart", hypothesis: "The capital of France is Paris",
  result: "Marseille", confidence: 0.99, verified: true, verified_by: [],
  timestamp: "2026-07-03T00:00:00Z",
};
const LOW_CONF = {
  id: "cr-lowconf", hypothesis: "The capital of Spain is Madrid",
  result: "Madrid", confidence: 0.4, verified: true, verified_by: ["commit:abc"],
  timestamp: "2026-07-04T00:00:00Z",
};

check("isConverged accepts only verified+artifact+usable+high-confidence", () => {
  assert.strictEqual(isConverged(CONVERGED), true);
  assert.strictEqual(isConverged(UNVERIFIED), false);   // verified:false
  assert.strictEqual(isConverged(NO_ARTIFACT), false);  // no verified_by artifact
  assert.strictEqual(isConverged(LOW_CONF), false);     // below MIN_CONFIDENCE
  assert.strictEqual(isConverged({ ...CONVERGED, result: "  " }), false); // empty answer
});

check("a matching question is served the converged record verbatim + provenance", () => {
  const p = writeLedger([CONVERGED]);
  const hit = lookupLedgerAnswer("what is the capital of France", { path: p });
  assert.ok(hit, "expected a ledger hit");
  assert.strictEqual(hit.answer, "Paris");
  assert.strictEqual(hit.deterministic, true);
  assert.strictEqual(hit.record_id, "cr-good");
  assert.deepStrictEqual(hit.provenance.verified_by, ["pr:#123"]);
  assert.strictEqual(hit.provenance.confidence, 0.95);
});

check("an UNVERIFIED record is never served, even at higher confidence + exact match", () => {
  const p = writeLedger([UNVERIFIED, NO_ARTIFACT]);
  const hit = lookupLedgerAnswer("what is the capital of France", { path: p });
  assert.strictEqual(hit, null, "unverified/artifact-less records must not be served");
});

check("converged wins over an unverified twin (only the verified answer is served)", () => {
  const p = writeLedger([UNVERIFIED, CONVERGED, NO_ARTIFACT]);
  const hit = lookupLedgerAnswer("capital of France?", { path: p });
  assert.ok(hit);
  assert.strictEqual(hit.answer, "Paris");         // never Lyon/Marseille
  assert.strictEqual(hit.record_id, "cr-good");
});

check("a non-matching question returns null (falls through to generation)", () => {
  const p = writeLedger([CONVERGED]);
  assert.strictEqual(lookupLedgerAnswer("how do I bake sourdough bread", { path: p }), null);
});

check("low-confidence converged record is not served", () => {
  const p = writeLedger([LOW_CONF]);
  assert.strictEqual(lookupLedgerAnswer("what is the capital of Spain", { path: p }), null);
});

check("deterministic: same (question, ledger) → identical result across calls", () => {
  const p = writeLedger([CONVERGED, LOW_CONF]);
  const a = lookupLedgerAnswer("capital of France", { path: p });
  const b = lookupLedgerAnswer("capital of France", { path: p });
  assert.deepStrictEqual(a, b);
});

check("empty / blank question returns null", () => {
  const p = writeLedger([CONVERGED]);
  assert.strictEqual(lookupLedgerAnswer("", { path: p }), null);
  assert.strictEqual(lookupLedgerAnswer("   ", { path: p }), null);
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
