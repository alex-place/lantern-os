// #1420 — the Grounding Diff viewer needs the [claim · evidence · source · confidence]
// tuple in the GET /api/claims list response (not an N+1 fetch per packet). This locks
// the additive fields (confidence, sources, safe_wording, grounded_at) onto the list.
//
// Run: node test/claims-evidence-fields.test.js
const assert = require("assert");
const consentGate = require("../lib/consent-gate");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

// Stub the store so the route is exercised against a known packet, no disk needed.
const SAMPLE = {
  packet_id: "claim:test-1",
  created_at: "2026-06-30T00:00:00.000Z",
  claim: { title: "Sky is clear", kind: "factual", safe_wording: "The sky is clear today.", scope: "test:weather" },
  evidence: { sources: [{ type: "web", excerpt: "Forecast: clear skies." }], confidence: 0.82, grounded_at: "2026-06-30T00:00:00.000Z" },
  review: { consent_gate_status: "approved", reviewer: "x", reviewed_at: "2026-06-30T00:00:00.000Z" },
  signature: { signature: "" },
};
const origList = consentGate.listPackets;
const origExport = consentGate.canExportClaim;
consentGate.listPackets = () => [SAMPLE];
consentGate.canExportClaim = () => false;

const claimsRoute = require("../routes/claims");

async function run() {
  let captured = null;
  const deps = {
    sendJson: (res, obj) => { captured = obj; },
    collectRequestBody: async () => "",
    repoRoot: ".",
  };
  await claimsRoute({ method: "GET" }, {}, new URL("http://x/api/claims"), deps);

  check("GET /api/claims responds with packets", () =>
    assert.ok(captured && Array.isArray(captured.packets) && captured.packets.length === 1));

  const p = captured.packets[0];
  check("list includes confidence (number)", () => assert.strictEqual(p.confidence, 0.82));
  check("list includes sources with type + excerpt", () => {
    assert.ok(Array.isArray(p.sources) && p.sources.length === 1);
    assert.strictEqual(p.sources[0].type, "web");
    assert.ok(/Forecast/.test(p.sources[0].excerpt));
  });
  check("list includes safe_wording (evidence body)", () =>
    assert.strictEqual(p.safe_wording, "The sky is clear today."));
  check("list includes grounded_at", () =>
    assert.strictEqual(p.grounded_at, "2026-06-30T00:00:00.000Z"));
  check("existing summary fields still present (backward compatible)", () => {
    assert.strictEqual(p.title, "Sky is clear");
    assert.strictEqual(p.scope, "test:weather");
    assert.strictEqual(p.status, "approved");
  });

  // A packet with no evidence must degrade safely (ungrounded claim → empty sources, null confidence).
  consentGate.listPackets = () => [{ packet_id: "claim:bare", created_at: "t", claim: { title: "bare", scope: "s" }, review: {}, signature: {} }];
  captured = null;
  await claimsRoute({ method: "GET" }, {}, new URL("http://x/api/claims"), deps);
  const bare = captured.packets[0];
  check("ungrounded packet → empty sources, null confidence", () => {
    assert.deepStrictEqual(bare.sources, []);
    assert.strictEqual(bare.confidence, null);
  });

  consentGate.listPackets = origList;
  consentGate.canExportClaim = origExport;

  if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
  process.stdout.write("\nall claims-evidence-fields checks passed\n");
}

run();
