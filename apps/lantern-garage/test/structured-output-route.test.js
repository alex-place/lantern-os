// #2757 — route-level wiring of structured output into POST /api/dream/chat.
// Drives the REAL dream.js handler with stubbed deps (fake dreamChatReply / sendJson /
// body), so the schema-hint injection, validate, single repair round-trip, JSON
// canonicalisation, and the Σ₀-skip-under-schema behaviour are all exercised without a
// provider or node_modules.
//
// Run: node apps/lantern-garage/test/structured-output-route.test.js
const assert = require("assert");
const os = require("os");
const dreamRoutes = require("../routes/dream");

let failures = 0;
async function check(name, fn) {
  try { await fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.stack || e.message}\n`); }
}

// A loopback request is operator-trusted (request-auth.isOperatorRequest), so the
// daily chat quota is skipped — no chat-quota state needed in the test.
function makeReq(body) {
  return { method: "POST", headers: {}, socket: { remoteAddress: "127.0.0.1" }, _body: JSON.stringify(body) };
}

// Drive the handler; returns { response, calls } where calls[] are the args each
// dreamChatReply invocation saw (so we can assert the schema hint + repair turn).
async function runChat(body, replyFn) {
  const calls = [];
  const sent = {};
  const deps = {
    fs: require("fs"), path: require("path"),
    sendJson: (res, obj, status) => { sent.obj = obj; sent.status = status == null ? 200 : status; },
    collectRequestBody: async (req) => req._body,
    appendJsonlQueued: () => {},
    repoRoot: os.tmpdir(),
    maxDreamerTextLength: 8000, maxConversationTextLength: 8000,
    readRecentDreams: () => [],
    dreamChatReply: async (message, recent, agent, provider, mode) => {
      calls.push({ message, agent, provider, mode });
      return replyFn(calls.length, { message, agent, provider, mode });
    },
    appendConversationEntry: async () => {},
    unifiedAgentGreet: () => {}, unifiedAgentHealth: () => {}, unifiedAgentInspect: () => {},
    handleStreamChat: () => {},
  };
  const url = new URL("http://127.0.0.1/api/dream/chat");
  await dreamRoutes(makeReq(body), {}, url, deps);
  return { response: sent.obj, status: sent.status, calls };
}

const schema = {
  type: "object",
  required: ["city", "population"],
  properties: { city: { type: "string" }, population: { type: "integer" } },
};

(async () => {
  // 1. First reply already valid → validated, canonicalised, single generation.
  await check("valid first reply → structured.ok, canonical JSON, one call", async () => {
    const { response, calls } = await runChat(
      { message: "capital of France as JSON", responseSchema: schema },
      () => ({ reply: 'Sure!\n```json\n{"city":"Paris","population":2100000}\n```', agent: "lantern", online: true }));
    assert.strictEqual(calls.length, 1, "should not repair a valid reply");
    assert.ok(/JSON Schema/i.test(calls[0].message), "schema hint must be injected into the prompt");
    assert.ok(response.structured && response.structured.ok, JSON.stringify(response.structured));
    assert.deepStrictEqual(response.structured.value, { city: "Paris", population: 2100000 });
    assert.strictEqual(response.reply, JSON.stringify({ city: "Paris", population: 2100000 }, null, 2));
  });

  // 2. Invalid first reply → ONE repair round-trip that fixes it.
  await check("invalid first reply → repaired on second call", async () => {
    const { response, calls } = await runChat(
      { message: "give me the city", responseSchema: schema },
      (n) => n === 1
        ? ({ reply: '{"city":"Paris"}', agent: "lantern", online: true })            // missing population
        : ({ reply: '{"city":"Paris","population":2100000}', agent: "lantern", online: true }));
    assert.strictEqual(calls.length, 2, "should do exactly one repair round-trip");
    assert.strictEqual(calls[1].mode, "review", "repair uses the clean one-shot review mode");
    assert.ok(/did not match/i.test(calls[1].message), "repair prompt states the mismatch");
    assert.ok(response.structured.ok, JSON.stringify(response.structured));
    assert.deepStrictEqual(response.structured.value, { city: "Paris", population: 2100000 });
  });

  // 3. Repair also fails → best-effort: ok:false with errors, no throw.
  await check("repair still invalid → ok:false with errors", async () => {
    const { response, calls } = await runChat(
      { message: "city please", responseSchema: schema },
      () => ({ reply: '{"city":"Paris"}', agent: "lantern", online: true }));  // always missing population
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(response.structured.ok, false);
    assert.ok(response.structured.errors.some((e) => /population/.test(e)), response.structured.errors.join("|"));
  });

  // 4. No schema → untouched free-text behaviour, no schema hint, no structured field.
  await check("no responseSchema → plain reply, no hint, no structured", async () => {
    const { response, calls } = await runChat(
      { message: "hello there" },
      () => ({ reply: "Hi! How can I help?", agent: "lantern", online: true }));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].message, "hello there", "no schema hint appended");
    assert.strictEqual(response.reply, "Hi! How can I help?");
    assert.strictEqual(response.structured, undefined);
  });

  // 5. Malformed schema (not a schema object) → treated as no schema.
  await check("malformed responseSchema (string) → ignored", async () => {
    const { response, calls } = await runChat(
      { message: "hi", responseSchema: "not a schema" },
      () => ({ reply: "hello", agent: "lantern", online: true }));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].message, "hi");
    assert.strictEqual(response.structured, undefined);
  });

  process.stdout.write(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
