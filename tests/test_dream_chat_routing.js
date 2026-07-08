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

console.log("\nTest: Document asks are not code intents (#1964)");
const { classifyIntent } = require("../apps/lantern-garage/lib/convergance-os/model-router");
test('"update the resume and link both" classifies as document_request, not coding', () => {
  assert.strictEqual(classifyIntent("update the resume and link both"), "document_request");
});
test('"update the cover letter based on my resume" classifies as document_request', () => {
  assert.strictEqual(classifyIntent("update the cover letter based on my resume"), "document_request");
});
test("real code asks still classify as coding_change", () => {
  assert.strictEqual(classifyIntent("refactor the streaming handler and open a pr"), "coding_change");
});

console.log("\nTest: Coding-change turns carry the patch directive (#2218 SWE-bench leak)");
const { codingPatchDirective, CODING_PATCH_DIRECTIVE } = require("../apps/lantern-garage/lib/stream-chat");
test("directive text requires a fenced diff block with git headers", () => {
  assert.ok(/```diff/.test(CODING_PATCH_DIRECTIVE), "directive should require a ```diff block");
  assert.ok(/diff --git/.test(CODING_PATCH_DIRECTIVE), "directive should require diff --git headers");
});
test("classified coding intent triggers the directive", () => {
  assert.strictEqual(codingPatchDirective(true, "general", false), CODING_PATCH_DIRECTIVE);
});
test("explicit routeIntent=coding_change triggers it even when unclassified (SWE-bench/API path)", () => {
  // The 0/20 leak: a raw single-shot patch prompt doesn't self-classify (isCodingIntent
  // false), so the trigger must also honor the caller's explicit routeIntent.
  assert.strictEqual(codingPatchDirective(false, "coding_change", false), CODING_PATCH_DIRECTIVE);
  assert.strictEqual(codingPatchDirective(false, "code_review", false), CODING_PATCH_DIRECTIVE);
});
test("non-coding turns get no directive (interactive chat unaffected)", () => {
  assert.strictEqual(codingPatchDirective(false, "general", false), "");
  assert.strictEqual(codingPatchDirective(false, "document_request", false), "");
});
test("RP mode never gets the directive", () => {
  assert.strictEqual(codingPatchDirective(true, "coding_change", true), "");
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
