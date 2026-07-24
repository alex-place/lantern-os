"use strict";
// #2844 — the record evidence-grounding pass: attach cited external evidence + a corroboration
// score, and CAP confidence where the outside world offers zero support. Injectable retrievers
// let us test the logic without a mounted corpus.
//
// Run: node apps/lantern-garage/test/record-evidence-grounding.test.js
const assert = require("assert");
const { groundRecordEvidence, NO_SUPPORT_CEILING } = require("../lib/record-evidence-grounding");

let failures = 0;
function check(name, fn) {
  return fn().then(() => console.log("  ok  -", name))
    .catch((e) => { failures++; console.error("  FAIL-", name, "\n      ", e.message); });
}

const REC = {
  id: "cr-1", hypothesis: "Looped language models scale reasoning via recurrent depth",
  confidence: 0.9, verified: false, grounding_signals: [], allowed_max_confidence: null,
};
const arxivHit = [{ id: "2510.25741", title: "Scaling Latent Reasoning via Looped LMs", url: "https://arxiv.org/abs/2510.25741", published: "2025" }];
const patentHit = [{ id: "US1234567B2", title: "Recurrent inference apparatus", url: "https://patents.google.com/patent/US1234567B2" }];

(async () => {
  await check("supporting hits → citations attached, corroboration counted, NOT capped", async () => {
    const out = await groundRecordEvidence(REC, { arxivQuery: async () => arxivHit, patentQuery: async () => patentHit });
    assert.strictEqual(out.corroboration_score, 2);
    assert.strictEqual(out.needs_review, false);
    assert.strictEqual(out.allowed_max_confidence, null, "corroborated record keeps its ceiling");
    assert.strictEqual(out.confidence, 0.9, "confidence unchanged when corroborated");
    assert.deepStrictEqual(out.grounding_signals, ["arxiv:2510.25741", "patent:US1234567B2"]);
    assert.strictEqual(out.evidence_citations[0].source, "arxiv");
    assert.strictEqual(out.evidence_citations[0].url, "https://arxiv.org/abs/2510.25741");
  });

  await check("ZERO external support → confidence capped to the ceiling + flagged for review", async () => {
    const out = await groundRecordEvidence(REC, { arxivQuery: async () => [], patentQuery: async () => [] });
    assert.strictEqual(out.corroboration_score, 0);
    assert.strictEqual(out.needs_review, true);
    assert.strictEqual(out.allowed_max_confidence, NO_SUPPORT_CEILING);
    assert.strictEqual(out.confidence, NO_SUPPORT_CEILING, "0.9 clamped down to the 0.5 ceiling");
    assert.deepStrictEqual(out.grounding_signals, [], "no citations added when nothing corroborates");
  });

  await check("a tighter existing ceiling is never raised by the pass", async () => {
    const out = await groundRecordEvidence({ ...REC, allowed_max_confidence: 0.3 }, { arxivQuery: async () => [], patentQuery: async () => [] });
    assert.strictEqual(out.allowed_max_confidence, 0.3, "min(existing, ceiling) — never loosen");
    assert.strictEqual(out.confidence, 0.3);
  });

  await check("retriever that throws is treated as no hits (conservative cap, never throws)", async () => {
    const out = await groundRecordEvidence(REC, { arxivQuery: async () => { throw new Error("corpus down"); }, patentQuery: async () => [] });
    assert.strictEqual(out.corroboration_score, 0);
    assert.strictEqual(out.needs_review, true);
    assert.strictEqual(out.allowed_max_confidence, NO_SUPPORT_CEILING);
  });

  await check("empty hypothesis → record returned unchanged", async () => {
    const out = await groundRecordEvidence({ ...REC, hypothesis: "   " }, { arxivQuery: async () => arxivHit });
    assert.strictEqual(out.corroboration_score, undefined);
    assert.strictEqual(out.confidence, 0.9);
  });

  await check("default retrievers (no corpus mounted on this box) → capped, never throws", async () => {
    const out = await groundRecordEvidence(REC); // uses live arxiv-index/patent-index; corpus absent → []
    assert.strictEqual(out.corroboration_score, 0);
    assert.strictEqual(out.needs_review, true);
    assert.strictEqual(out.allowed_max_confidence, NO_SUPPORT_CEILING);
  });

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
