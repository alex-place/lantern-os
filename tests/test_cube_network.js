/**
 * Cube Network API tests
 * Run with: node tests/test_cube_network.js
 * Requires server on port 4177.
 */

const http = require("http");

const { hostname: HOST, port: PORT } = require("./lantern-test-base");

function req(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: HOST, port: PORT, path, method, headers: { "Content-Type": "application/json" } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function assert(cond, msg) { if (!cond) throw new Error(`FAIL: ${msg}`); }

async function run() {
  console.log("=== Cube Network Tests ===\n");

  // 1. GET /api/cubes/local
  console.log("1. GET /api/cubes/local — Alex private cube summary");
  const local = await req("GET", "/api/cubes/local");
  assert(local.status === 200, `status ${local.status}`);
  assert(local.body.cube_id === "cube:alex.private", `cube_id ${local.body.cube_id}`);
  assert(local.body.cube_type === "private", `cube_type ${local.body.cube_type}`);
  console.log("   OK");

  // 2. POST /api/cubes/alex/delta
  console.log("2. POST /api/cubes/alex/delta — write private delta");
  const delta = await req("POST", "/api/cubes/alex/delta", {
    source_surface: "dream-chat",
    event_type: "dream_chat_message",
    observer_id: "alex",
    symbols: ["door", "fox", "garden"],
    payload_ref: "conversation:test-001",
    coordinate: "dreams:symbolic:private:now",
  });
  assert(delta.status === 200, `status ${delta.status}`);
  assert(delta.body.saved === true, "saved");
  assert(delta.body.delta.delta_id, "delta_id");
  assert(delta.body.delta.privacy === "private", "privacy");
  console.log("   OK");

  // 3. GET /api/cubes/shared
  console.log("3. GET /api/cubes/shared — shared world cube summary");
  const shared = await req("GET", "/api/cubes/shared");
  assert(shared.status === 200, `status ${shared.status}`);
  assert(shared.body.cube_id === "cube:shared.world", `cube_id ${shared.body.cube_id}`);
  assert(shared.body.cube_type === "shared_world", `cube_type ${shared.body.cube_type}`);
  console.log("   OK");

  // 4. GET /api/cubes/allies
  console.log("4. GET /api/cubes/allies — list allies");
  const allies = await req("GET", "/api/cubes/allies");
  assert(allies.status === 200, `status ${allies.status}`);
  assert(Array.isArray(allies.body.allies), "allies array");
  console.log("   OK");

  // 5. POST /api/allies/invite
  console.log("5. POST /api/allies/invite — invite ally");
  const invite = await req("POST", "/api/allies/invite", {
    display_name: "Test Ally",
    node_id: "node:test-ally-001",
    public_key: "ed25519:test",
  });
  assert(invite.status === 200, `status ${invite.status}`);
  assert(invite.body.invited === true, "invited");
  console.log("   OK");

  // 6. Verify ally appears in list
  console.log("6. GET /api/cubes/allies — ally appears");
  const allies2 = await req("GET", "/api/cubes/allies");
  assert(allies2.body.allies.length >= 1, "ally count");
  assert(allies2.body.allies.some((a) => a.display_name === "Test Ally"), "ally found");
  console.log("   OK");

  console.log("\n=== All cube tests passed ===");
}

run().catch((err) => { console.error("\nTest failed:", err.message); process.exit(1); });
