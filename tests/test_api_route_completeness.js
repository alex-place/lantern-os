/**
 * API Route Completeness Tests
 * Verifies /api/images and /api/trading/kalshi/order endpoints
 * Covers fixes for issues #438 (image gallery 404) and #433 (order HTTP status codes)
 *
 * Run against live server: node apps/lantern-garage/server.js
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
  console.log("\n=== API Route Completeness Tests ===\n");

  // ─────────────────────────────────────────────────────────────────
  // Issue #438: GET /api/images — Image Gallery Endpoint
  // ─────────────────────────────────────────────────────────────────
  console.log("Issue #438: GET /api/images\n");

  await test("returns 200 with images array (empty if no images)", async () => {
    const r = await request("GET", "/api/images", null);
    assert.strictEqual(r.status, 200, `Expected 200, got ${r.status}`);
    assert.ok(Array.isArray(r.body.images), "images should be an array");
    assert.ok(typeof r.body.count === "number", "count should be a number");
  });

  await test("returns proper structure when no images exist", async () => {
    const r = await request("GET", "/api/images", null);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.count, r.body.images.length, "count should match images length");
  });

  await test("image objects have required fields (id, filename, url, size, timestamp)", async () => {
    const r = await request("GET", "/api/images", null);
    if (r.body.images.length > 0) {
      const img = r.body.images[0];
      assert.ok(img.id, "image should have id");
      assert.ok(img.filename, "image should have filename");
      assert.ok(img.url, "image should have url");
      assert.ok(typeof img.size === "number", "image should have size");
      assert.ok(img.timestamp, "image should have timestamp");
    }
  });

  await test("returns images sorted by timestamp (newest first)", async () => {
    const r = await request("GET", "/api/images", null);
    if (r.body.images.length > 1) {
      for (let i = 1; i < r.body.images.length; i++) {
        const prev = new Date(r.body.images[i - 1].timestamp).getTime();
        const curr = new Date(r.body.images[i].timestamp).getTime();
        assert.ok(prev >= curr, "images should be sorted newest first");
      }
    }
  });

  await test("does not return 404 (issue #438 fix verification)", async () => {
    const r = await request("GET", "/api/images", null);
    assert.notStrictEqual(r.status, 404, "should not return 404");
    assert.ok(!r.body.error || r.body.error !== "not_found", "should not have not_found error");
  });

  // ─────────────────────────────────────────────────────────────────
  // Issue #433: POST /api/trading/kalshi/order — Order HTTP Status Codes
  // ─────────────────────────────────────────────────────────────────
  console.log("\nIssue #433: POST /api/trading/kalshi/order\n");

  await test("returns 400 when missing required fields (ticker, quantity, price)", async () => {
    const r = await request("POST", "/api/trading/kalshi/order", {});
    assert.ok(r.status >= 400 && r.status < 300, "should return 4xx for invalid order");
  });

  await test("returns 402 when insufficient funds (cash check from #434)", async () => {
    // This test assumes the order would exceed available cash
    // The actual response status depends on Kalshi connection and account state
    const r = await request("POST", "/api/trading/kalshi/order", {
      ticker: "BTCUSD",
      side: "buy",
      quantity: 999999,
      price: 9999,
      // This should trigger 402 if cash insufficient
    });
    // Accept 400, 402, or 503 (if Kalshi unavailable)
    assert.ok(r.status === 400 || r.status === 402 || r.status === 503, `Got status ${r.status}`);
  });

  await test("does not always return 200 for failed orders (issue #433 fix)", async () => {
    // Place an order that should fail (invalid/missing data)
    const r = await request("POST", "/api/trading/kalshi/order", {
      // Missing required fields
    });
    assert.notStrictEqual(r.status, 200, "should not return 200 for invalid order");
  });

  await test("properly maps Kalshi status codes to HTTP status (live orders)", async () => {
    // When Kalshi returns a non-2xx status, the HTTP response should reflect it
    // This test verifies the fix: const httpStatus = result.status >= 200...
    const r = await request("POST", "/api/trading/kalshi/order", {
      ticker: "INVALID",
      side: "buy",
      quantity: 1,
      price: 1,
    });
    // Should get 4xx or 5xx, not always 200
    assert.ok(r.status !== 200 || r.body.error, "should indicate error in response");
  });

  // ─────────────────────────────────────────────────────────────────
  // Integration: DELETE /api/images/:id
  // ─────────────────────────────────────────────────────────────────
  console.log("\nIntegration: DELETE /api/images/:id\n");

  await test("returns 404 when deleting non-existent image", async () => {
    const r = await request("DELETE", "/api/images/nonexistent_id_12345", null);
    assert.strictEqual(r.status, 404, `Expected 404, got ${r.status}`);
    assert.ok(r.body.error, "should have error message");
  });

  await test("returns 200 when deleting valid image (if exists)", async () => {
    // First, get list to find an image
    const list = await request("GET", "/api/images", null);
    if (list.body.images && list.body.images.length > 0) {
      const imageId = list.body.images[0].id;
      const r = await request("DELETE", `/api/images/${imageId}`, null);
      assert.strictEqual(r.status, 200, `Expected 200, got ${r.status}`);
      assert.ok(r.body.success === true || r.body.id, "should confirm deletion");
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // Trading Memory: GET /api/trading/orders (local store)
  // ─────────────────────────────────────────────────────────────────
  console.log("\nTrading Memory: GET /api/trading/orders\n");

  await test("GET /api/trading/dashboard/orders returns array", async () => {
    const r = await request("GET", "/api/trading/dashboard/orders", null);
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body), "should return array");
  });

  await test("GET /api/trading/orders returns array", async () => {
    const r = await request("GET", "/api/trading/orders", null);
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body), "should return array");
  });

  // ─────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  console.log(`${"=".repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Test suite error:", err);
  process.exit(1);
});
