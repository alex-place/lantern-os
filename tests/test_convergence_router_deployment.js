/**
 * Convergence Router Deployment Tests (Issue #452)
 */

const assert = require("assert");
const { ConvergenceRouter, getRouter } = require("../apps/lantern-garage/lib/convergence-router");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
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
  console.log("\nConvergence Router Deployment Tests (#452)\n");

  console.log("Router Initialization");

  test("ConvergenceRouter constructs successfully", () => {
    const router = new ConvergenceRouter();
    assert.ok(router, "router should be created");
    assert.ok(router.patterns, "patterns should be initialized");
  });

  test("getRouter returns singleton instance", () => {
    const r1 = getRouter();
    const r2 = getRouter();
    assert.strictEqual(r1, r2, "getRouter should return the same instance");
  });

  console.log("\nIntent Routing (6 Personas)");

  await testAsync("routeIntent returns one of 6 valid agents", async () => {
    const router = new ConvergenceRouter();
    const validAgents = ["lantern", "blinkbug", "keystone", "waterfall", "xenon", "founder"];
    const result = await router.routeIntent("I need to debug this routing issue");
    assert.ok(result.agent, "should return an agent");
    assert.ok(validAgents.includes(result.agent), `agent should be one of 6 personas`);
  });

  await testAsync("routeIntent includes confidence score", async () => {
    const router = new ConvergenceRouter();
    const result = await router.routeIntent("classify the intent here");
    assert.ok(typeof result.confidence === "number", "confidence should be a number");
    assert.ok(result.confidence > 0 && result.confidence <= 100, "confidence should be between 0 and 100");
  });

  console.log("\nCache Validation (Σ₀ Staleness Fix)");

  await testAsync("cache_validated returned for cached match", async () => {
    const router = new ConvergenceRouter();
    const uniqueMsg = "unique debug routing message " + Date.now();
    const first = await router.routeIntent(uniqueMsg);
    assert.ok(["keystone_routing", "cache_validated"].includes(first.source));

    const second = await router.routeIntent(uniqueMsg);
    assert.strictEqual(second.source, "cache_validated", "identical intent should use validated cache");
    assert.strictEqual(second.cacheHit, true, "should report cache hit");
  });

  console.log("\nPattern Cache Management");

  test("pattern cache structure is valid", () => {
    const router = new ConvergenceRouter();
    const patterns = router.patterns;
    assert.strictEqual(patterns.version, 1, "patterns should have version 1");
    assert.ok(typeof patterns.marketPatterns === "object");
    assert.ok(typeof patterns.intentPatterns === "object");
    assert.ok(typeof patterns.codePatterns === "object");
  });

  console.log("\nTask Routing (Deterministic + Dynamic)");

  await testAsync("deterministic tasks map to local endpoints", async () => {
    const router = new ConvergenceRouter();
    const result = await router.routeTask("market_analysis", {});
    assert.strictEqual(result.source, "deterministic_route");
    assert.ok(result.endpoint, "should have endpoint");
  });

  await testAsync("unknown tasks route to Keystone dispatcher", async () => {
    const router = new ConvergenceRouter();
    const result = await router.routeTask("novel_task_type", {});
    assert.strictEqual(result.source, "dynamic_route");
    assert.strictEqual(result.handler, "keystone_dispatcher");
  });

  console.log("\nToken Efficiency (90% Local Target)");

  await testAsync("90% of deterministic tasks route locally", async () => {
    const router = new ConvergenceRouter();
    const deterministicTasks = [
      "market_analysis", "position_monitoring", "win_rate_check",
      "market_analysis", "position_monitoring", "win_rate_check",
      "market_analysis", "position_monitoring", "win_rate_check",
      "unknown_novel_task"
    ];

    const localRoutes = await Promise.all(
      deterministicTasks.map(t => router.routeTask(t, {}))
    );

    const localCount = localRoutes.filter(r => r.source === "deterministic_route").length;
    const localPercentage = (localCount / localRoutes.length) * 100;
    console.log(`  deterministic task routing: ${localPercentage.toFixed(1)}%`);
    assert.ok(localPercentage >= 90, `should route 90% locally`);
  });

  console.log("\nStatistics & Monitoring");

  test("getStats returns all required metrics", () => {
    const router = new ConvergenceRouter();
    const stats = router.getStats();
    assert.strictEqual(typeof stats.cachedMarketPatterns, "number");
    assert.strictEqual(typeof stats.cachedIntentPatterns, "number");
    assert.strictEqual(typeof stats.cachedCodePatterns, "number");
    assert.ok(stats.generatedAt);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error("Test suite error:", err);
  process.exit(1);
});
