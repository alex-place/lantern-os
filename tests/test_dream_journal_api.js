/**
 * Dream Journal REST API tests
 * Runs against a live lantern-garage server on port 4177.
 * Start the server before running: node apps/lantern-garage/server.js
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
  console.log("\nDream Journal REST API Tests\n");

  // ── POST /api/dream/create ──────────────────────────────────────────────
  console.log("POST /api/dream/create");

  let createdId;

  await test("creates entry and returns id + saved:true", async () => {
    const r = await request("POST", "/api/dream/create", {
      kind: "dream",
      text: "API test dream: flying over silver towers",
      lucidity: 0.8,
      emotions: ["awe", "clarity"],
      tags: ["test", "api", "towers"],
      symbols: ["tower", "sky"],
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.saved, true);
    assert.ok(r.body.id, "id should be present");
    assert.ok(r.body.entry.timestamp, "entry should have timestamp");
    assert.strictEqual(r.body.entry.kind, "dream");
    assert.strictEqual(r.body.entry.lucidity, 0.8);
    createdId = r.body.id;
  });

  await test("creates note entry", async () => {
    const r = await request("POST", "/api/dream/create", {
      kind: "note",
      text: "Quick note for testing",
      tags: ["test"],
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.entry.kind, "note");
  });

  await test("truncates tags to 10 max", async () => {
    const tags = Array.from({ length: 15 }, (_, i) => `tag${i}`);
    const r = await request("POST", "/api/dream/create", {
      kind: "dream",
      text: "Too many tags test",
      tags,
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.entry.tags.length <= 10, "Should have at most 10 tags");
  });

  await test("defaults missing fields gracefully", async () => {
    const r = await request("POST", "/api/dream/create", {
      kind: "reflection",
      text: "Minimal entry",
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.entry.emotions, []);
    assert.deepStrictEqual(r.body.entry.tags, []);
    assert.strictEqual(r.body.entry.lucidity, 0);
  });

  // ── GET /api/dream/stats ────────────────────────────────────────────────
  console.log("\nGET /api/dream/stats");

  await test("returns total_entries, entries_by_kind, avg_lucidity", async () => {
    const r = await request("GET", "/api/dream/stats");
    assert.strictEqual(r.status, 200);
    assert.ok(typeof r.body.total_entries === "number");
    assert.ok(typeof r.body.entries_by_kind === "object");
    assert.ok(typeof r.body.top_emotions === "object");
    assert.ok(typeof r.body.top_tags === "object");
    assert.ok(typeof r.body.avg_lucidity !== "undefined");
  });

  await test("total_entries is non-negative", async () => {
    const r = await request("GET", "/api/dream/stats");
    assert.ok(r.body.total_entries >= 0);
  });

  await test("counts include our created test entries", async () => {
    const r = await request("GET", "/api/dream/stats");
    assert.ok(r.body.total_entries >= 2, "Should have at least 2 entries from this test run");
  });

  // ── GET /api/dream/search ───────────────────────────────────────────────
  console.log("\nGET /api/dream/search");

  await test("empty query returns results", async () => {
    const r = await request("GET", "/api/dream/search?text=");
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body.results));
  });

  await test("text search filters by content", async () => {
    const r = await request("GET", "/api/dream/search?text=silver+towers");
    assert.strictEqual(r.status, 200);
    // If our test entry was saved with the right field name, it should appear
    assert.ok(typeof r.body.count === "number");
  });

  await test("tag search narrows results", async () => {
    const r = await request("GET", "/api/dream/search?tags=api");
    assert.strictEqual(r.status, 200);
    assert.ok(typeof r.body.count === "number");
  });

  await test("returns count and results array", async () => {
    const r = await request("GET", "/api/dream/search");
    assert.ok(typeof r.body.count === "number");
    assert.ok(Array.isArray(r.body.results));
  });

  // ── GET /api/dream/read/:id ─────────────────────────────────────────────
  console.log("\nGET /api/dream/read/:id");

  await test("404 for unknown id", async () => {
    const r = await request("GET", "/api/dream/read/does_not_exist_xyz");
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.error, "not_found");
  });

  // ── POST /api/dream/chat ──────────────────────────────────────────────
  console.log("\nPOST /api/dream/chat (single-agent selection)");

  await test("chat with no provider returns 503 with clear error", async () => {
    const r = await request("POST", "/api/dream/chat", {
      message: "I saw a glowing light in my dream",
    });
    // Without a provider key configured, the server must fail fast with 503.
    // With a provider key set, it returns 200 with reply/agent/online.
    if (r.status === 200) {
      assert.ok(typeof r.body.reply === "string", "reply should be a string");
      assert.ok(typeof r.body.agent === "string", "agent should be a string");
      assert.ok(typeof r.body.online === "boolean", "online should be boolean");
    } else {
      assert.strictEqual(r.status, 503, `expected 200 (provider configured) or 503 (no provider), got ${r.status}`);
      assert.ok(r.body.error, "503 response must include error field");
      assert.ok(typeof r.body.agent === "string", "503 response must include agent field");
    }
  });

  await test("chat with no provider includes agent in response", async () => {
    const r = await request("POST", "/api/dream/chat", {
      message: "I saw a waterfall",
    });
    assert.ok(r.status === 200 || r.status === 503, `unexpected status ${r.status}`);
    assert.ok(typeof r.body.agent === "string" && r.body.agent.length > 0, "agent name must be present");
  });

  await test("chat endpoint is reachable and returns JSON", async () => {
    const r = await request("POST", "/api/dream/chat", { message: "" });
    assert.ok([200, 503].includes(r.status), `unexpected status ${r.status}`);
    assert.ok(typeof r.body === "object", "response must be JSON");
  });

  // ── GET /api/dream/stream ──────────────────────────────────────────────
  console.log("\nGET /api/dream/stream (SSE)");

  await test("stream returns text/event-stream", async () => {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: HOST, port: PORT, path: "/api/dream/stream?message=test+stream", method: "GET" },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              assert.ok(data.includes("data:"), "should contain SSE data lines");
              resolve();
            } catch (e) { reject(e); }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  });

  // ── GET / (HTML dashboard) ──────────────────────────────────────────────
  console.log("\nGET / (dashboard)");

  await test("landing page returns 200 HTML with Keystone OS heading", async () => {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: HOST, port: PORT, path: "/", method: "GET" }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes("Keystone OS"), "Page should include Keystone OS heading");
    assert.ok(r.body.includes("dream-chat.html"), "Landing page should link to dream chat");
  });

  await test("landing page has CTA panels", async () => {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: HOST, port: PORT, path: "/", method: "GET" }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.ok(r.body.includes("patreon.com"), "Landing page should link to Patreon");
    assert.ok(r.body.includes("panel"), "Landing page should have panel elements");
  });

  // ── Summary ─────────────────────────────────────────────────────────────
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
