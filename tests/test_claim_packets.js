/**
 * Claim Packet + Consent Gate tests
 *
 * Run with: node tests/test_claim_packets.js
 * Requires a running Lantern Garage server on port 4177.
 */

const http = require("http");

const { baseUrl: BASE, hostname: HOST, port: PORT } = require("./lantern-test-base");
const TEST_ID = `claim:${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;

function req(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      port: PORT,
      path,
      method,
      headers: { "Content-Type": "application/json" },
    };
    const r = http.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function makeValidPacket(packetId) {
  return {
    schema: "lantern.claim_packet.v1",
    packet_id: packetId,
    created_at: new Date().toISOString(),
    origin: {
      node_id: "node:test-node-001",
      software: "lantern-os",
      software_version: "1.0.0",
      operator_approved: false,
    },
    claim: {
      title: "Morning pet-care reminder reduced missed feeding events",
      kind: "measurement",
      safe_wording:
        "In this local node, morning reminders were associated with fewer missed pet-care events during the 7-day observation window.",
      scope: "household:pet-care",
      domain: "animal_welfare",
      flourishing_dimensions: ["animal_health", "animal_comfort", "routine_stability"],
    },
    measurement: {
      value: { missed_events_before: 3, missed_events_after: 1 },
      uncertainty: 0.42,
      confidence_interval: [0.0, 1.0],
      sample_size: 14,
      source: "local_node",
      methodology: "operator_logged_events",
      temporal_range: ["2026-06-01", "2026-06-08"],
      scope: "household:pet-care",
      confounders: ["single_household", "short_window", "self_reported"],
      missing: ["no independent verification", "no randomized baseline"],
      measurement_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
    evidence: {
      evidence_class: "local_pilot",
      certainty: "low",
      replication_status: "not_replicated",
      source_refs: [],
      status_cube_refs: [],
    },
    privacy: {
      raw_private_data_included: false,
      privacy_level: "anonymized",
      allowed_use: "aggregate_pattern_only",
      revocable: true,
      expires_at: null,
    },
    risk: {
      risk_class: "low",
      sensitive: false,
      automation_allowed: false,
      recommendation_allowed: true,
    },
    review: {
      consent_gate_status: "draft",
      reviewer: "local_operator",
      reviewed_at: null,
      challenge_path: true,
      rollback_path: true,
    },
    signature: {
      algorithm: "ed25519",
      public_key: "ed25519:placeholder",
      signature: null,
    },
  };
}

async function run() {
  console.log("=== Claim Packet Tests ===\n");

  // 1. Health check
  console.log("1. Server health check...");
  const health = await req("GET", "/api/health");
  assert(health.status === 200, `health returned ${health.status}`);
  console.log("   OK\n");

  // 2. Create draft
  console.log("2. POST /api/claims/draft — create draft...");
  const packet = makeValidPacket(TEST_ID);
  const draft = await req("POST", "/api/claims/draft", packet);
  assert(draft.status === 200, `draft returned ${draft.status}: ${JSON.stringify(draft.body)}`);
  assert(draft.body.saved === true, "draft body.saved should be true");
  assert(draft.body.status === "draft", "draft status should be draft");
  console.log("   OK\n");

  // 3. List drafts
  console.log("3. GET /api/claims — list packets...");
  const list = await req("GET", "/api/claims");
  assert(list.status === 200, `list returned ${list.status}`);
  assert(list.body.count >= 1, "list should have at least 1 packet");
  assert(list.body.packets.some((p) => p.packet_id === TEST_ID), "list should include test packet");
  console.log("   OK\n");

  // 4. Get single packet
  console.log("4. GET /api/claims/:id — get packet...");
  const get = await req("GET", `/api/claims/${TEST_ID}`);
  assert(get.status === 200, `get returned ${get.status}`);
  assert(get.body.packet.packet_id === TEST_ID, "packet_id mismatch");
  assert(get.body.exportable === false, "draft should not be exportable");
  console.log("   OK\n");

  // 5. Approve for export
  console.log("5. POST /api/claims/:id/approve — approve...");
  const approve = await req("POST", `/api/claims/${TEST_ID}/approve`, { reviewer: "test_operator" });
  assert(approve.status === 200, `approve returned ${approve.status}: ${JSON.stringify(approve.body)}`);
  assert(approve.body.approved === true, "approved flag should be true");
  assert(approve.body.signed === true, "signed flag should be true");
  assert(approve.body.exportable === true, "approved packet should be exportable");
  console.log("   OK\n");

  // 6. Export-ready list
  console.log("6. GET /api/claims/export-ready — export-ready list...");
  const ready = await req("GET", "/api/claims/export-ready");
  assert(ready.status === 200, `export-ready returned ${ready.status}`);
  assert(ready.body.packets.some((p) => p.packet_id === TEST_ID), "export-ready should include test packet");
  console.log("   OK\n");

  // 7. Node public key
  console.log("7. GET /api/claims/node-public-key...");
  const key = await req("GET", "/api/claims/node-public-key");
  assert(key.status === 200, `key returned ${key.status}`);
  assert(key.body.algorithm === "ed25519", "algorithm should be ed25519");
  assert(key.body.public_key.startsWith("ed25519:"), "public_key should start with ed25519:");
  console.log("   OK\n");

  // 8. Reject a new packet
  console.log("8. POST /api/claims/:id/reject — reject...");
  const rejectId = `claim:${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  const rejectPacket = makeValidPacket(rejectId);
  await req("POST", "/api/claims/draft", rejectPacket);
  const reject = await req("POST", `/api/claims/${rejectId}/reject`, { reviewer: "test_operator" });
  assert(reject.status === 200, `reject returned ${reject.status}`);
  assert(reject.body.rejected === true, "rejected flag should be true");
  console.log("   OK\n");

  // 9. Revoke approved packet
  console.log("9. POST /api/claims/:id/revoke — revoke...");
  const revoke = await req("POST", `/api/claims/${TEST_ID}/revoke`);
  assert(revoke.status === 200, `revoke returned ${revoke.status}`);
  assert(revoke.body.revoked === true, "revoked flag should be true");
  console.log("   OK\n");

  // 10. Validation failure — bad schema
  console.log("10. POST /api/claims/draft — validation rejects bad schema...");
  const badId = `claim:${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  const bad = makeValidPacket(badId);
  bad.schema = "bad.schema";
  const badRes = await req("POST", "/api/claims/draft", bad);
  assert(badRes.status === 400, `bad schema should return 400, got ${badRes.status}`);
  assert(badRes.body.error === "validation_failed", "should be validation_failed");
  console.log("   OK\n");

  // 11. Immutable approved packet
  console.log("11. POST /api/claims/draft — approved packet is immutable...");
  const immutableId = `claim:${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  const immutablePacket = makeValidPacket(immutableId);
  await req("POST", "/api/claims/draft", immutablePacket);
  await req("POST", `/api/claims/${immutableId}/approve`);
  const immutableRes = await req("POST", "/api/claims/draft", { ...immutablePacket, claim: { title: "New title" } });
  assert(immutableRes.status === 409, `immutable should return 409, got ${immutableRes.status}`);
  console.log("   OK\n");

  console.log("=== All 11 tests passed ===");
}

run().catch((err) => {
  console.error("\nTest failed:", err.message);
  process.exit(1);
});
