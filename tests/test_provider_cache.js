/**
 * Provider Cache Tests — PCSF routing cache
 * Verifies: TTL refresh, success/failure recording, redacted snapshot,
 * /api/pcsf/routing endpoint contract.
 *
 * Run: node tests/test_provider_cache.js
 */

const assert = require("assert");
const http = require("http");
const { baseUrl, hostname: HOST, port: PORT } = require("./lantern-test-base");

let passed = 0;
let failed = 0;

async function ok(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${label}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

async function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: HOST, port: PORT, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

// ── Unit tests on the module directly ────────────────────────────────────────

console.log("\nProvider Cache — unit tests");

// Clear module cache so we get a fresh instance
delete require.cache[require.resolve("../apps/lantern-garage/lib/provider-cache")];
const cache = require("../apps/lantern-garage/lib/provider-cache");

ok("getProviderState() includes the core providers", () => {
  const state = cache.getProviderState();
  assert.ok(state.gemini, "missing gemini");
  assert.ok(state.anthropic, "missing anthropic");
  assert.ok(state.openai, "missing openai");
  assert.ok(state.xai, "missing xai");
  assert.ok(state.ollama, "missing ollama");
});

ok("each provider entry has expected shape", () => {
  const state = cache.getProviderState();
  for (const [id, p] of Object.entries(state)) {
    assert.strictEqual(typeof p.hasKey, "boolean", `${id}.hasKey not boolean`);
    assert.ok("lastSuccess" in p, `${id} missing lastSuccess`);
    assert.ok("lastFailure" in p, `${id} missing lastFailure`);
    assert.ok(Array.isArray(p.recentHistory), `${id}.recentHistory not array`);
  }
});

ok("recordProviderSuccess updates lastSuccess and clears lastError", () => {
  cache.recordProviderSuccess("gemini", { model: "gemini-test" });
  const state = cache.getProviderState();
  assert.ok(state.gemini.lastSuccess, "lastSuccess not set");
  assert.strictEqual(state.gemini.lastError, null, "lastError not cleared");
  assert.ok(state.gemini.recentHistory.length > 0, "history empty");
  assert.strictEqual(state.gemini.recentHistory[state.gemini.recentHistory.length - 1].status, "ok");
});

ok("recordProviderFailure updates lastFailure and lastError", () => {
  cache.recordProviderFailure("anthropic", "anthropic_status_429");
  const state = cache.getProviderState();
  assert.ok(state.anthropic.lastFailure, "lastFailure not set");
  assert.strictEqual(state.anthropic.lastError, "anthropic_status_429");
  const last = state.anthropic.recentHistory[state.anthropic.recentHistory.length - 1];
  assert.strictEqual(last.status, "fail");
  assert.strictEqual(last.error, "anthropic_status_429");
});

ok("history is capped at 10 entries", () => {
  delete require.cache[require.resolve("../apps/lantern-garage/lib/provider-cache")];
  const fresh = require("../apps/lantern-garage/lib/provider-cache");
  for (let i = 0; i < 15; i++) {
    fresh.recordProviderSuccess("openai");
  }
  const state = fresh.getProviderState();
  assert.ok(state.openai.recentHistory.length <= 10, "history exceeded cap");
});

ok("getRoutingSnapshot returns schema + cacheTtlSeconds + providers array", () => {
  const snap = cache.getRoutingSnapshot();
  assert.strictEqual(snap.schema, "lantern.pcsf.routing.v1");
  assert.strictEqual(snap.cacheTtlSeconds, 60);
  assert.ok(typeof snap.cacheAgeSeconds === "number", "cacheAgeSeconds missing");
  assert.ok(Array.isArray(snap.providers), "providers not array");
  assert.ok(snap.providers.length >= 5, `expected at least 5 providers, got ${snap.providers.length}`);
});

ok("getRoutingSnapshot does NOT expose key values", () => {
  const snap = cache.getRoutingSnapshot();
  const raw = JSON.stringify(snap);
  // Must not contain any actual key value (just boolean hasKey)
  assert.ok(!raw.includes("sk-"), "found sk- prefix in snapshot");
  assert.ok(!raw.includes("AIza"), "found AIza prefix in snapshot");
  // hasKey must be boolean
  for (const p of snap.providers) {
    assert.strictEqual(typeof p.hasKey, "boolean", `${p.id}.hasKey not boolean in snapshot`);
  }
});

ok("recentHistory in snapshot is capped to last 5 entries", () => {
  delete require.cache[require.resolve("../apps/lantern-garage/lib/provider-cache")];
  const fresh = require("../apps/lantern-garage/lib/provider-cache");
  for (let i = 0; i < 8; i++) fresh.recordProviderSuccess("xai");
  const snap = fresh.getRoutingSnapshot();
  const xai = snap.providers.find(p => p.id === "xai");
  assert.ok(xai.recentHistory.length <= 5, "snapshot history not trimmed to 5");
});

ok("refreshProviderCache re-reads env keys", () => {
  // Hermetic: clear every variable that makes Gemini reachable, then set one.
  const GEMINI_ENV = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GEMINI_USE_VERTEX", "VERTEX_PROJECT"];
  const saved = Object.fromEntries(GEMINI_ENV.map((k) => [k, process.env[k]]));
  try {
    for (const k of GEMINI_ENV) delete process.env[k];
    cache.refreshProviderCache();
    assert.strictEqual(cache.getProviderState().gemini.hasKey, false, "no gemini credentials → hasKey false");
    process.env.GEMINI_API_KEY = "test-value";
    cache.refreshProviderCache();
    assert.strictEqual(cache.getProviderState().gemini.hasKey, true, "a gemini key → hasKey true");
  } finally {
    for (const k of GEMINI_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    cache.refreshProviderCache();
  }
});

// ── HTTP endpoint tests ───────────────────────────────────────────────────────

console.log("\nGET /api/pcsf/routing");

async function runEndpointTests() {
  const res = await get("/api/pcsf/routing");

  ok("returns HTTP 200", () => {
    assert.strictEqual(res.status, 200);
  });

  ok("Content-Type is application/json", () => {
    assert.ok(res.headers["content-type"]?.includes("application/json"), `got: ${res.headers["content-type"]}`);
  });

  let snap;
  ok("body is valid JSON", () => {
    snap = JSON.parse(res.body);
  });

  ok("schema field is present", () => {
    assert.strictEqual(snap.schema, "lantern.pcsf.routing.v1");
  });

  ok("cacheTtlSeconds is 60", () => {
    assert.strictEqual(snap.cacheTtlSeconds, 60);
  });

  ok("cacheAgeSeconds is a non-negative number", () => {
    assert.ok(typeof snap.cacheAgeSeconds === "number" && snap.cacheAgeSeconds >= 0);
  });

  ok("providers array has at least 5 entries", () => {
    assert.ok(snap.providers.length >= 5);
  });

  ok("all providers have hasKey boolean", () => {
    for (const p of snap.providers) {
      assert.strictEqual(typeof p.hasKey, "boolean", `${p.id}.hasKey not boolean`);
    }
  });

  ok("no provider has a real key value exposed", () => {
    const raw = JSON.stringify(snap);
    assert.ok(!raw.includes("sk-"), "found sk- prefix");
    assert.ok(!raw.includes("AIza"), "found AIza prefix");
  });

  await ok("endpoint responds in under 1 second", async () => {
    const t0 = Date.now();
    await get("/api/pcsf/routing");
    assert.ok(Date.now() - t0 < 1000, `too slow: ${Date.now() - t0}ms`);
  });

  await ok("second request reflects same or newer cache age", async () => {
    const r1 = JSON.parse((await get("/api/pcsf/routing")).body);
    const r2 = JSON.parse((await get("/api/pcsf/routing")).body);
    assert.ok(r2.cacheAgeSeconds >= r1.cacheAgeSeconds - 1, "cache age went backwards unexpectedly");
  });
}

runEndpointTests().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}).catch(err => {
  console.error("Test runner error:", err);
  process.exit(1);
});
