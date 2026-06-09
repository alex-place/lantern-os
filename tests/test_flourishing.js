/**
 * Human Flourishing Frameworks route tests
 * Runs against a live lantern-garage server on port 4177.
 */

const http = require("http");
const assert = require("assert");
const { hostname: HOST, port: PORT } = require("./lantern-test-base");

let passed = 0;
let failed = 0;

async function request(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: HOST, port: PORT, path, method }, (res) => {
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
    req.on("error", reject);
    req.end();
  });
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

async function run() {
  console.log("\nFlourishing Frameworks API Tests\n");

  // ── Dashboard page ────────────────────────────────────────────────────────
  console.log("GET /flourishing");
  await test("returns HTML dashboard", async () => {
    const r = await request("GET", "/flourishing");
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes("<html") || r.body.includes("<!DOCTYPE"), "should return HTML");
  });

  // ── World status ─────────────────────────────────────────────────────────
  console.log("GET /api/flourishing/world/status");
  await test("returns world status with ok=true", async () => {
    const r = await request("GET", "/api/flourishing/world/status");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(typeof r.body.db_exists === "boolean", "db_exists should be boolean");
    assert.ok(typeof r.body.snapshot_exists === "boolean", "snapshot_exists should be boolean");
  });

  // ── Flourishing metrics ──────────────────────────────────────────────────
  console.log("GET /api/flourishing/world/flourishing");
  await test("returns flourishing scope data", async () => {
    const r = await request("GET", "/api/flourishing/world/flourishing");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(typeof r.body.by_scope === "object", "by_scope should be object");
  });

  // ── Beliefs ──────────────────────────────────────────────────────────────
  console.log("GET /api/flourishing/world/beliefs");
  await test("returns beliefs array", async () => {
    const r = await request("GET", "/api/flourishing/world/beliefs");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(Array.isArray(r.body.beliefs), "beliefs should be array");
  });

  await test("respects limit parameter", async () => {
    const r = await request("GET", "/api/flourishing/world/beliefs?limit=5");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.beliefs.length <= 5, "beliefs should be limited to 5");
  });

  // ── Violations ─────────────────────────────────────────────────────────────
  console.log("GET /api/flourishing/violations");
  await test("returns violations list", async () => {
    const r = await request("GET", "/api/flourishing/violations");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(Array.isArray(r.body.violations), "violations should be array");
    assert.ok(typeof r.body.count === "number", "count should be number");
  });

  // ── Autonomous status ──────────────────────────────────────────────────────
  console.log("GET /api/flourishing/autonomous/status");
  await test("returns autonomous agent status", async () => {
    const r = await request("GET", "/api/flourishing/autonomous/status");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(Array.isArray(r.body.agents), "agents should be array");
    assert.ok(typeof r.body.escalation_queue === "number", "escalation_queue should be number");
    assert.ok(typeof r.body.rules === "number", "rules should be number");
  });

  // ── Adoption stats ─────────────────────────────────────────────────────────
  console.log("GET /api/flourishing/adoption/stats");
  await test("returns adoption statistics", async () => {
    const r = await request("GET", "/api/flourishing/adoption/stats");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(typeof r.body.verified_nodes === "number", "verified_nodes should be number");
    assert.ok(typeof r.body.active_nodes === "number", "active_nodes should be number");
    assert.ok(typeof r.body.total_nodes === "number", "total_nodes should be number");
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
