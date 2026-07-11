// #openhands-dup — the Σ₀ post-reply grounding pass fired the SAME web_search
// query 13-20 times for one chat turn (data/tool-logs/2026-07-11.jsonl), because
// verifyResponse calls the un-cached webSearchMcp once per claim and runs several
// times per turn. webSearchMcpDeduped collapses identical (query, maxResults) calls
// within a TTL window to a single real MCP request — coalescing concurrent callers
// onto one in-flight promise and briefly caching the result (successes AND failures).
//
// Run: node apps/lantern-garage/test/grounding-query-dedup.test.js
const assert = require("assert");
const { webSearchMcpDeduped, _clearGroundingDedup } = require("../lib/web-search-client");

let failures = 0;
async function check(name, fn) {
  try { await fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.stack || e.message}\n`); }
}

(async () => {
  await check("concurrent identical queries coalesce to ONE underlying call", async () => {
    _clearGroundingDedup();
    let calls = 0;
    const impl = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return { results: [{ url: "u" }] }; };
    // Fire 20 identical queries in parallel — mirrors the 13-20 duplicate turn.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => webSearchMcpDeduped("openhands not available", 3, 8000, impl))
    );
    assert.strictEqual(calls, 1, `expected 1 real call, got ${calls}`);
    assert.ok(results.every(r => r.results && r.results[0].url === "u"));
  });

  await check("sequential identical queries reuse the cached result within TTL", async () => {
    _clearGroundingDedup();
    let calls = 0;
    const impl = async () => { calls++; return { results: [{ url: `u${calls}` }] }; };
    const a = await webSearchMcpDeduped("same q", 3, 8000, impl);
    const b = await webSearchMcpDeduped("same q", 3, 8000, impl);
    const c = await webSearchMcpDeduped("same q", 3, 8000, impl);
    assert.strictEqual(calls, 1, `expected 1 real call, got ${calls}`);
    assert.strictEqual(a.results[0].url, "u1");
    assert.strictEqual(b.results[0].url, "u1");
    assert.strictEqual(c.results[0].url, "u1");
  });

  await check("failures are cached too — a failing query is not retried 20x per turn", async () => {
    _clearGroundingDedup();
    let calls = 0;
    const impl = async () => { calls++; return { success: false, error: "down" }; };
    for (let i = 0; i < 20; i++) await webSearchMcpDeduped("bad q", 3, 8000, impl);
    assert.strictEqual(calls, 1, `expected 1 real call, got ${calls}`);
  });

  await check("distinct queries and distinct maxResults are NOT deduped together", async () => {
    _clearGroundingDedup();
    let calls = 0;
    const impl = async () => { calls++; return { results: [] }; };
    await webSearchMcpDeduped("query A", 3, 8000, impl);
    await webSearchMcpDeduped("query B", 3, 8000, impl);   // different query
    await webSearchMcpDeduped("query A", 5, 8000, impl);   // same query, different maxResults
    assert.strictEqual(calls, 3, `expected 3 distinct calls, got ${calls}`);
  });

  await check("query key is trim/case-insensitive (same claim, incidental casing)", async () => {
    _clearGroundingDedup();
    let calls = 0;
    const impl = async () => { calls++; return { results: [] }; };
    await webSearchMcpDeduped("The Claim", 3, 8000, impl);
    await webSearchMcpDeduped("  the claim  ", 3, 8000, impl);
    assert.strictEqual(calls, 1, `expected 1 real call, got ${calls}`);
  });

  if (failures) { process.stderr.write(`\n${failures} test(s) failed\n`); process.exit(1); }
  process.stdout.write("\nall grounding-query-dedup tests passed\n");
})();
