/**
 * Tests for the deterministic Convergence Agent (no LLM).
 * Plain-node harness (matches repo convention, run: node tests/test_convergence_agent.js).
 */

const assert = require("assert");
const agent = require("../apps/lantern-garage/lib/convergence-agent");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

(async () => {
  console.log("\nConvergence Agent Tests (grounded local answers, no LLM)\n");

  console.log("Routing (intent -> persona + category)");
  const cases = [
    ["what work needs to be done", "keystone", "work"],
    ["show me kalshi market positions", "xenon", "trade"],
    ["help me make a video short", "waterfall", "create"],
    ["tell me a story", "lantern", "story"],
    ["explain the convergence router", "xenon", "convergence"],
    ["is the system ready", "keystone", "status"],
  ];
  for (const [msg, persona, category] of cases) {
    await test(`"${msg}" -> ${persona}/${category}`, async () => {
      const r = await agent.respond(msg);
      assert.strictEqual(r.agent, persona, `agent ${r.agent}`);
      assert.strictEqual(r.category, category, `category ${r.category}`);
    });
  }

  console.log("\nDeterminism (template categories, state-independent)");
  await test("same input yields byte-identical output for a template category", async () => {
    const a = JSON.stringify(await agent.respond("tell me a story"));
    const b = JSON.stringify(await agent.respond("tell me a story"));
    assert.strictEqual(a, b);
  });

  console.log("\nGrounding contract");
  await test("classify() is synchronous and stable for work", () => {
    assert.strictEqual(agent.classify("what work needs to be done").category, "work");
  });
  await test("getOpenIssues never throws (returns array even offline)", async () => {
    const issues = await agent.getOpenIssues(3);
    assert.ok(Array.isArray(issues));
  });
  await test("work category exposes a grounded boolean", async () => {
    const r = await agent.respond("what work needs to be done");
    assert.strictEqual(typeof r.grounded, "boolean");
    // source reflects whether live data was used
    assert.ok(/^convergence_agent:(live|template)$/.test(r.source));
  });

  console.log("\nResponse contract");
  await test("response always carries a non-empty answer string", async () => {
    const r = await agent.respond("zxcv qwer no match");
    assert.ok(typeof r.answer === "string" && r.answer.length > 0);
  });
  await test("response always carries at least one action", async () => {
    const r = await agent.respond("zxcv qwer no match");
    assert.ok(Array.isArray(r.actions) && r.actions.length >= 1);
  });
  await test("every action has a label and a command or href", async () => {
    for (const [msg] of cases) {
      const r = await agent.respond(msg);
      for (const a of r.actions) {
        assert.ok(a.label, "action missing label");
        assert.ok(a.command || a.href, `action "${a.label}" missing command/href`);
      }
    }
  });
  await test("empty message falls back to help with default persona", async () => {
    const r = await agent.respond("");
    assert.strictEqual(r.category, "help");
    assert.strictEqual(r.agent, "keystone");
  });
  await test("confidence rises with keyword density", async () => {
    const weak = (await agent.respond("tell me a story")).confidence;
    const strong = (await agent.respond("kalshi market position buy sell")).confidence;
    assert.ok(strong > weak, `expected ${strong} > ${weak}`);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
