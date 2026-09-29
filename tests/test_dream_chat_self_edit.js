/**
 * Self-Edit API tests
 * Runs against a live lantern-garage server on port 4177.
 */

const http = require("http");
const assert = require("assert");
const { baseUrl: BASE, hostname: HOST, port: PORT } = require("./lantern-test-base");

let passed = 0;
let failed = 0;

async function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: HOST,
      port: PORT,
      path,
      method,
      headers: { "Content-Type": "application/json" },
    };
    const req = http.request(opts, (res) => {
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
    if (body) req.write(JSON.stringify(body));
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
  console.log("\nSelf-Edit API Tests\n");

  // ── POST /api/self-edit/plan ──────────────────────────────────────────
  console.log("POST /api/self-edit/plan");

  await test("rejects empty request", async () => {
    const r = await request("POST", "/api/self-edit/plan", {});
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, "request_required");
  });

  await test("returns structured plan for valid request", async () => {
    const r = await request("POST", "/api/self-edit/plan", {
      request: "Add a comment to the top of apps/lantern-garage/server.js",
      scopeFiles: ["apps/lantern-garage/server.js"],
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.plan, "plan should exist");
    assert.ok(typeof r.body.plan.summary === "string", "summary should be a string");
    assert.ok(Array.isArray(r.body.plan.affectedFiles), "affectedFiles should be an array");
    assert.ok(["low", "medium", "high"].includes(r.body.plan.riskLevel), "riskLevel should be valid");
    assert.ok(Array.isArray(r.body.plan.testsToRun), "testsToRun should be an array");
    assert.ok(Array.isArray(r.body.plan.steps), "steps should be an array");
  });

  // ── POST /api/self-edit/patch ─────────────────────────────────────────
  console.log("POST /api/self-edit/patch");

  await test("rejects missing plan", async () => {
    const r = await request("POST", "/api/self-edit/patch", {});
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, "plan_required");
  });

  await test("returns diff preview but does not apply", async () => {
    // Use a minimal synthetic plan to test patch generation
    const plan = {
      summary: "Add test comment",
      affectedFiles: ["tests/test_dream_chat_self_edit.js"],
      riskLevel: "low",
      testsToRun: ["node tests/test_dream_chat_self_edit.js"],
      steps: [{ action: "edit", file: "tests/test_dream_chat_self_edit.js", description: "Add a harmless comment at the top" }],
      branchHint: "self-edit-test",
    };
    const r = await request("POST", "/api/self-edit/patch", { plan });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.previewOnly, "should be previewOnly");
    assert.ok(r.body.diffText, "diffText should exist");
    assert.ok(Array.isArray(r.body.changedFiles), "changedFiles should be an array");
    // Ensure it did NOT apply
    assert.ok(!r.body.applied, "should not have applied");
  });

  // ── POST /api/self-edit/apply ─────────────────────────────────────────
  console.log("POST /api/self-edit/apply");

  await test("rejects missing diffText", async () => {
    const r = await request("POST", "/api/self-edit/apply", {});
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, "diffText_required");
  });

  await test("dry run returns wouldApply without applying", async () => {
    const diffText = `--- a/tests/test_dream_chat_self_edit.js\n+++ b/tests/test_dream_chat_self_edit.js\n@@ -1,1 +1,2 @@\n /**\n+ * dry-run test\n`;
    const r = await request("POST", "/api/self-edit/apply", { diffText, dryRun: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.dryRun, true);
    assert.strictEqual(r.body.wouldApply, true);
  });

  await test("rejects files outside allowed repo paths", async () => {
    const diffText = `--- a/../../outside.js\n+++ b/../../outside.js\n@@ -1,1 +1,2 @@\n //outside\n+//evil\n`;
    const r = await request("POST", "/api/self-edit/apply", { diffText });
    // Should fail because path is unsafe
    assert.ok(r.status === 500 || r.body.ok === false, "should reject unsafe path");
    assert.ok(r.body.error?.includes("unsafe_path") || r.body.error?.includes("diff_unsafe_path"), `error should mention unsafe path, got: ${r.body.error}`);
  });

  // ── POST /api/self-edit/pr ────────────────────────────────────────────
  console.log("POST /api/self-edit/pr");

  await test("rejects missing title", async () => {
    const r = await request("POST", "/api/self-edit/pr", {});
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, "title_required");
  });

  await test("rejects operation on master branch", async () => {
    // The route checks the branch the SERVER runs on, not body.branch. Against a server on
    // any other branch this call would add, commit, push and open a draft PR, so only
    // run it where the server itself reports master.
    const st = await request("GET", "/api/self-edit/status");
    if (!st.body || st.body.isMaster !== true) return;
    const r = await request("POST", "/api/self-edit/pr", { title: "Test PR", branch: "master" });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.error, "cannot_commit_on_master");
  });

  // ── GET /api/self-edit/status ─────────────────────────────────────────
  console.log("GET /api/self-edit/status");

  await test("returns branch and diff stat", async () => {
    const r = await request("GET", "/api/self-edit/status", null);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(typeof r.body.branch === "string", "branch should be a string");
    assert.ok(typeof r.body.diffStat === "string", "diffStat should be a string");
    assert.ok(typeof r.body.isMaster === "boolean", "isMaster should be a boolean");
  });

  // ── Summary ───────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
