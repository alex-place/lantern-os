/**
 * unisona.ai route tests for the Dream Journal debug/operator path.
 * Runs against a live lantern-garage server.
 */

const http = require("http");
const assert = require("assert");
const { baseUrl: BASE, hostname: HOST, port: PORT } = require("./lantern-test-base");

let passed = 0;
let failed = 0;

async function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const opts = {
      hostname: HOST,
      port: PORT,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    };

    const req = http.request(opts, (res) => {
      let out = "";
      res.on("data", (chunk) => (out += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(out) });
        } catch {
          resolve({ status: res.statusCode, body: out });
        }
      });
    });

    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \u2717 ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

async function run() {
  console.log("\nDream Journal unisona.ai Tests\n");

  console.log("GET /api/keystone/status");

  await test("returns branch, dirty_files, recent_commits, tests, and providers", async () => {
    const r = await request("GET", "/api/keystone/status");
    assert.strictEqual(r.status, 200);
    assert.ok(typeof r.body.branch === "string" && r.body.branch.length > 0, "branch must be present");
    assert.ok(typeof r.body.dirty_files === "number", "dirty_files must be numeric");
    assert.ok(typeof r.body.recent_commits === "string" && r.body.recent_commits.length > 0, "recent_commits must be present");
    assert.ok(typeof r.body.tests === "string" && r.body.tests.includes("test_dream_journal_keystone"), "tests summary should mention keystone suite");
    assert.ok(typeof r.body.providers === "object" && r.body.providers !== null, "providers must be an object");
  });

  console.log("\nPOST /api/keystone/exec");

  await test("rejects empty commands", async () => {
    const r = await request("POST", "/api/keystone/exec", {});
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, "empty_command");
  });

  await test("rejects non-allowlisted commands and returns allowlist patterns", async () => {
    const r = await request("POST", "/api/keystone/exec", {
      command: "powershell -Command Get-Location",
    });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.error, "command_not_allowed");
    assert.ok(Array.isArray(r.body.allowed_patterns), "allowed_patterns should be returned");
    assert.ok(r.body.allowed_patterns.some((pattern) => pattern.includes("^npm test$")), "allowlist should mention npm test");
    assert.ok(r.body.allowed_patterns.some((pattern) => pattern.includes("test_dream_journal_keystone")), "allowlist should mention keystone suite");
  });

  await test("runs an allowlisted read-only git command", async () => {
    const r = await request("POST", "/api/keystone/exec", {
      command: "git branch",
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.command, "git branch");
    assert.ok(typeof r.body.output === "string" && r.body.output.trim().length > 0, "git branch output should be present");
  });

  const total = passed + failed;
  console.log(`\n${passed}/${total} passed`);
  if (failed > 0) {
    console.error(`${failed} failed`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("\nFATAL: Could not connect to server at", BASE);
  console.error("Make sure lantern-garage is running: node apps/lantern-garage/server.js");
  console.error(err.message);
  process.exit(1);
});
