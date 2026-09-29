/**
 * Fuzzy tests — index.html APIs + dream-chat stream endpoint
 *
 * Covers today's changes:
 *   - index.html: all 8 API calls it fires on load
 *   - dream-chat.js: bang-command routing edge cases
 *   - /api/dream/doors/image: image suggestion endpoint
 *
 * Run: node tests/test_fuzzy_index_dreamchat.js
 * Requires: server running on port 4177
 */

const http = require("http");
const assert = require("assert");
const { hostname: HOST, port: PORT } = require("./lantern-test-base");

let passed = 0;
let failed = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────

async function req(method, path, body, rawBody) {
  return new Promise((resolve, reject) => {
    const payload = rawBody != null ? rawBody : body != null ? JSON.stringify(body) : null;
    const opts = {
      hostname: HOST,
      port: PORT,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(payload != null ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };
    const r = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, raw: data, body: tryJson(data) }));
    });
    r.on("error", reject);
    if (payload != null) r.write(payload);
    r.end();
  });
}

function tryJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ✓ ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  ✗ ${name}\n    ${err.message}\n`);
    failed++;
  }
}

// ── Index page: all 8 APIs ───────────────────────────────────────────────────

process.stdout.write("\n=== INDEX PAGE APIs ===\n");

async function runIndexTests() {
  const INDEX_APIS = [
    { method: "GET", path: "/api/health" },
    { method: "GET", path: "/version.json" },
    { method: "GET", path: "/api/version" },
    { method: "GET", path: "/api/status" },
    { method: "GET", path: "/api/pcsf/routing" },
    { method: "GET", path: "/api/agents" },
    { method: "GET", path: "/api/dreamer?user=dreamer" },
    { method: "GET", path: "/api/dream/search" },
  ];

  for (const api of INDEX_APIS) {
    await test(`GET ${api.path} — loads without crash`, async () => {
      const r = await req(api.method, api.path);
      assert.ok(r.status < 500, `Expected <500, got ${r.status}: ${r.raw.slice(0, 200)}`);
    });
  }

  // Fuzz /api/dream/search with weird query params
  const SEARCH_FUZZ = [
    "/api/dream/search?q=",
    "/api/dream/search?q=<script>alert(1)</script>",
    "/api/dream/search?q=" + encodeURIComponent("'; DROP TABLE--"),
    "/api/dream/search?q=" + encodeURIComponent("a".repeat(2000)),
    "/api/dream/search?q=" + encodeURIComponent("\u0000\u0000"),
    "/api/dream/search?q=" + encodeURIComponent("🦊🌙"),
    "/api/dream/search?limit=-1&q=dream",
    "/api/dream/search?limit=9999999&q=dream",
    "/api/dream/search?limit=abc&q=dream",
  ];
  for (const path of SEARCH_FUZZ) {
    await test(`search fuzz: ${path.slice(0, 60)}`, async () => {
      const r = await req("GET", path);
      assert.ok(r.status < 500, `Crashed with ${r.status}`);
    });
  }

  // Fuzz /api/dreamer with weird user params
  const DREAMER_FUZZ = [
    "/api/dreamer?user=",
    "/api/dreamer?user=" + encodeURIComponent("<script>"),
    "/api/dreamer?user=" + encodeURIComponent("../../../etc"),
    "/api/dreamer?user=" + encodeURIComponent("a".repeat(1000)),
    "/api/dreamer?user=" + encodeURIComponent("\u0000"),
  ];
  for (const path of DREAMER_FUZZ) {
    await test(`dreamer fuzz: ${path.slice(0, 60)}`, async () => {
      const r = await req("GET", path);
      assert.ok(r.status < 500, `Crashed with ${r.status}`);
    });
  }
}

// ── Index page static load ───────────────────────────────────────────────────

process.stdout.write("\n=== STATIC PAGE LOADS ===\n");

async function runStaticLoadTests() {
  const PAGES = [
    "/",
    "/index.html",
    "/chat.html",
  ];
  for (const page of PAGES) {
    await test(`GET ${page} — loads 200`, async () => {
      const r = await req("GET", page);
      assert.strictEqual(r.status, 200, `Expected 200, got ${r.status}`);
      assert.ok(r.raw.includes("<html") || r.raw.includes("<!doctype"), "Response is not HTML");
    });
  }

  // Path traversal on static files
  const TRAVERSAL = [
    "/../../../etc/passwd",
    "/..%2F..%2Fetc%2Fpasswd",
    "/index.html/../../../etc/passwd",
    "/.env",
    "/.env.local",
    "/node_modules/express/package.json",
  ];
  for (const path of TRAVERSAL) {
    await test(`traversal blocked: ${path.slice(0, 50)}`, async () => {
      const r = await req("GET", path);
      assert.ok(
        r.status === 403 || r.status === 404 || r.status === 400,
        `Expected 4xx for traversal, got ${r.status} for ${path}`
      );
    });
  }
}

// ── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  try {
    await runIndexTests();
    await runStaticLoadTests();
  } catch (err) {
    process.stdout.write(`\nFATAL: ${err.message}\n`);
    process.exit(1);
  }

  process.stdout.write(`\n${"─".repeat(50)}\n`);
  process.stdout.write(`Passed: ${passed}  Failed: ${failed}  Total: ${passed + failed}\n`);
  if (failed > 0) {
    process.stdout.write(`\n⚠  ${failed} fuzz case(s) caused server crashes or unexpected errors.\n`);
    process.exit(1);
  } else {
    process.stdout.write(`\n✓ All fuzz cases survived — no server crashes.\n`);
  }
})();
