const assert = require("assert");
const { AGENT_PERSONAS, selectAgent, parseBangCommand } = require("../apps/lantern-garage/lib/dream-chat");

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

// One assistant, real tool calls: selectAgent no longer keyword-routes between
// personas — every message resolves to THE keystone assistant, and capabilities
// (documents, market data, web, repo) are native tools in lib/tool-runner.js.

console.log("\nTest: One assistant for every message");
test('trading ask resolves to the one assistant ("buy aapl shares")', () => {
  assert.strictEqual(selectAgent("buy aapl shares").id, "keystone");
});
test('document ask resolves to the one assistant ("help me work on my resume")', () => {
  assert.strictEqual(selectAgent("help me work on my resume").id, "keystone");
});
test("empty message resolves to the one assistant", () => {
  assert.strictEqual(selectAgent("").id, "keystone");
});

console.log("\nTest: Assistant contract");
test("exactly one persona is defined (no keyword-routed persona set)", () => {
  assert.strictEqual(AGENT_PERSONAS.length, 1);
  assert.strictEqual(AGENT_PERSONAS[0].id, "keystone");
});
test("assistant prompt is conversational + tool-using, not a scripted flow", () => {
  const prompt = AGENT_PERSONAS[0].systemPrompt || "";
  assert.ok(/real tools/i.test(prompt), "prompt should tell the model its capabilities are real tools");
  assert.ok(/never reply with a form/i.test(prompt), "prompt should forbid form-filling behavior");
});

console.log("\nTest: Bang command parsing");
test("parseBangCommand extracts name and args", () => {
  const cmd = parseBangCommand("!search current weather");
  assert.strictEqual(cmd.name, "search");
  assert.strictEqual(cmd.args, "current weather");
});
test("plain text is not a bang command", () => {
  assert.strictEqual(parseBangCommand("hello there"), null);
});

console.log("\n" + "=".repeat(50));
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);
console.log("=".repeat(50));

process.exit(failed > 0 ? 1 : 0);
