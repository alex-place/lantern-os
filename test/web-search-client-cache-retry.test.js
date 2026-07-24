// #1529 — short-TTL success cache + 429 backoff-retry on the keyless search chain.
// Deterministic: real network functions are swapped for fakes via the underscore-
// prefixed injection opts (_mcpImpl / _fallbackImpls / _retryBackoffMs), which default
// to the real implementations for every non-test caller.
//
// Run: node test/web-search-client-cache-retry.test.js
const assert = require("assert");
const { webSearch, _cacheKey, _clearSearchCache, _isRateLimited } = require("../lib/web-search-client");

let failures = 0;
async function check(name, fn) {
  try { await fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.stack || e.message}\n`); }
}

function okResult(n) {
  return { success: true, results: [{ title: `r${n}`, url: `https://x/${n}`, snippet: "s" }], source: "direct" };
}
function rateLimited() { return { success: false, error: "direct rate-limited (HTTP 429)", source: "direct" }; }
function noResults() { return { success: false, error: "no results (direct)", source: "direct" }; }

(async () => {
  check("_isRateLimited detects 429 phrasing, ignores other errors", () => {
    assert.ok(_isRateLimited("direct rate-limited (HTTP 429, retry-after 30s)"));
    assert.ok(_isRateLimited("wiki HTTP 429"));
    assert.ok(!_isRateLimited("direct timeout"));
    assert.ok(!_isRateLimited("no results (direct)"));
  });

  await check("cache: identical query within TTL returns the cached result, fromCache:true", async () => {
    _clearSearchCache();
    let calls = 0;
    const mcpImpl = async () => { calls++; return { success: false, error: "down" }; };
    const fallbackImpls = [async () => { calls++; return okResult(1); }];
    const r1 = await webSearch("same query", 5, { retries: 0, _mcpImpl: mcpImpl, _fallbackImpls: fallbackImpls });
    const r2 = await webSearch("same query", 5, { retries: 0, _mcpImpl: mcpImpl, _fallbackImpls: fallbackImpls });
    assert.strictEqual(r1.success, true);
    assert.ok(!r1.fromCache);
    assert.strictEqual(r2.success, true);
    assert.strictEqual(r2.fromCache, true);
    assert.deepStrictEqual(r2.results, r1.results);
    assert.strictEqual(calls, 2, "second call must NOT hit the network (1 mcp + 1 fallback = 2 total)");
  });

  await check("cache key is case-insensitive and trims whitespace", () => {
    assert.strictEqual(_cacheKey("  Hello World  ", 5), _cacheKey("hello world", 5));
    assert.notStrictEqual(_cacheKey("hello", 5), _cacheKey("hello", 3)); // maxResults is part of the key
  });

  await check("cache: failures are never cached (keeps retrying, doesn't replay a zero)", async () => {
    _clearSearchCache();
    let calls = 0;
    const mcpImpl = async () => { calls++; return { success: false, error: "down" }; };
    const fallbackImpls = [async () => { calls++; return noResults(); }];
    const r1 = await webSearch("will fail", 5, { retries: 0, _mcpImpl: mcpImpl, _fallbackImpls: fallbackImpls, _retryBackoffMs: 0 });
    const r2 = await webSearch("will fail", 5, { retries: 0, _mcpImpl: mcpImpl, _fallbackImpls: fallbackImpls, _retryBackoffMs: 0 });
    assert.strictEqual(r1.success, false);
    assert.strictEqual(r2.success, false);
    assert.strictEqual(calls, 4, "both calls must hit the network — a failure must never be cached");
  });

  await check("skipCache bypasses a warm cache entry", async () => {
    _clearSearchCache();
    let calls = 0;
    const mcpImpl = async () => { calls++; return { success: false, error: "down" }; };
    const fallbackImpls = [async () => { calls++; return okResult(1); }];
    await webSearch("bypass me", 5, { retries: 0, _mcpImpl: mcpImpl, _fallbackImpls: fallbackImpls });
    const r2 = await webSearch("bypass me", 5, { retries: 0, _mcpImpl: mcpImpl, _fallbackImpls: fallbackImpls, skipCache: true });
    assert.strictEqual(calls, 4); // 2 calls x (1 mcp + 1 fallback)
    assert.ok(!r2.fromCache);
  });

  await check("429 on a fallback provider triggers exactly one retry, which can then succeed", async () => {
    _clearSearchCache();
    let fbCalls = 0;
    const mcpImpl = async () => ({ success: false, error: "down" });
    const fallbackImpls = [async () => {
      fbCalls++;
      return fbCalls === 1 ? rateLimited() : okResult(2); // throttled once, then clears
    }];
    const r = await webSearch("flaky throttle", 5, { retries: 0, _mcpImpl: mcpImpl, _fallbackImpls: fallbackImpls, _retryBackoffMs: 5 });
    assert.strictEqual(r.success, true);
    assert.strictEqual(fbCalls, 2, "must have retried the same provider once after the 429");
  });

  await check("a non-429 failure does NOT get the extra retry — falls through to the next provider", async () => {
    _clearSearchCache();
    let firstCalls = 0, secondCalls = 0;
    const mcpImpl = async () => ({ success: false, error: "down" });
    const fallbackImpls = [
      async () => { firstCalls++; return noResults(); },           // ordinary miss, not a 429
      async () => { secondCalls++; return okResult(3); },
    ];
    const r = await webSearch("ordinary miss", 5, { retries: 0, _mcpImpl: mcpImpl, _fallbackImpls: fallbackImpls, _retryBackoffMs: 5 });
    assert.strictEqual(r.success, true);
    assert.strictEqual(firstCalls, 1, "no retry on a non-429 miss");
    assert.strictEqual(secondCalls, 1);
  });

  await check("still honest on total failure: no fabricated success, error surfaced", async () => {
    _clearSearchCache();
    const mcpImpl = async () => ({ success: false, error: "down" });
    const fallbackImpls = [async () => rateLimited(), async () => noResults()];
    const r = await webSearch("everything fails", 5, { retries: 0, _mcpImpl: mcpImpl, _fallbackImpls: fallbackImpls, _retryBackoffMs: 1 });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.results.length, 0);
    assert.ok(r.error);
    assert.strictEqual(r.source, "none");
  });

  if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
  process.stdout.write("\nall web-search cache/retry checks passed\n");
})();
