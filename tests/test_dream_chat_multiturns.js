/**
 * Multi-turn Dream Chat Tests
 * Tests 3x send→receive cycles verifying:
 * - History is threaded through subsequent calls
 * - Suggestion chips are returned from real dream memory
 * - Conversation can be saved as a dream entry
 *
 * Requires: node apps/lantern-garage/server.js running on port 4177
 */

const http = require("http");
const assert = require("assert");
const { baseUrl: BASE, hostname: HOST, port: PORT } = require("./lantern-test-base");

let passed = 0;
let failed = 0;

async function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const opts = {
      hostname: HOST,
      port: PORT,
      path,
      method,
      headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
    };
    const req = http.request(opts, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
        catch { resolve({ status: res.statusCode, body: out }); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function streamPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: HOST,
      port: PORT,
      path,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    };
    const req = http.request(opts, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        const events = [];
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* skip */ }
        }
        resolve({ status: res.statusCode, events });
      });
    });
    req.on("error", reject);
    req.write(data);
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
  console.log("\nMulti-turn Dream Chat Tests\n");

  // ── Setup: seed a dream entry so suggestions have real data ─────────────
  console.log("Setup: seed dream entry with tags/emotions");
  await request("POST", "/api/dream/create", {
    kind: "dream",
    text: "I was flying over a glowing forest. Everything felt peaceful.",
    tags: ["flying", "forest", "glow"],
    emotions: ["peace", "wonder"],
    symbols: ["light", "tree"],
    lucidity: 0.8,
  });

  // ── Turn 1: initial message ─────────────────────────────────────────────
  console.log("\nTurn 1: initial message");

  let turn1Events, turn1Reply = "", turn1Suggestions = [];
  await test("POST /api/dream/chat/stream returns SSE events", async () => {
    const r = await streamPost("/api/dream/chat/stream", {
      message: "I had a dream about flying through a glowing forest",
      history: [],
    });
    assert.ok(r.events.length > 0, "should have SSE events");
    turn1Events = r.events;
  });

  await test("turn 1 has token events", async () => {
    const tokens = turn1Events.filter(e => e.type === "token");
    assert.ok(tokens.length > 0, "should have token events");
    turn1Reply = tokens.map(e => e.text).join("");
    assert.ok(turn1Reply.length > 0, "token text should not be empty");
  });

  await test("turn 1 done event has agent field", async () => {
    const done = turn1Events.find(e => e.type === "done");
    assert.ok(done, "should have done event");
    assert.ok(typeof done.agent === "string" && done.agent.length > 0, "done event must include agent name");
  });

  await test("turn 1 done event has suggestions from dream memory", async () => {
    const done = turn1Events.find(e => e.type === "done");
    assert.ok(done, "should have done event");
    assert.ok(Array.isArray(done.suggestions), "done event must include suggestions array");
    assert.ok(done.suggestions.length === 3, `expected 3 suggestions, got ${done.suggestions.length}`);
    assert.ok(done.suggestions.every(s => typeof s === "string" && s.length > 0), "all suggestions must be non-empty strings");
    turn1Suggestions = done.suggestions;
    console.log(`    suggestions: ${turn1Suggestions.map(s => `"${s}"`).join(", ")}`);
  });

  await test("turn 1 suggestions reference real dream data or are valid fallbacks", async () => {
    const allSuggestions = turn1Suggestions.join(" ").toLowerCase();
    // When provider is live, suggestions should reference real data.
    // When provider is down (429/503), fallback doors are acceptable.
    const realData = ["flying", "forest", "glow", "peace", "wonder", "light", "tree"];
    const fallbackIndicators = ["door", "dream", "open", "understand", "different"];
    const hasRealData = realData.some(word => allSuggestions.includes(word));
    const hasFallback = fallbackIndicators.some(word => allSuggestions.includes(word));
    assert.ok(hasRealData || hasFallback, `suggestions should reference dream data or valid fallbacks but got: ${turn1Suggestions.join(", ")}`);
  });

  // ── Turn 2: follow-up with history ──────────────────────────────────────
  console.log("\nTurn 2: follow-up with history");

  const historyAfterTurn1 = [
    { role: "user", text: "I had a dream about flying through a glowing forest" },
    { role: "assistant", text: turn1Reply },
  ];

  let turn2Reply = "";
  await test("turn 2 POST includes history and returns reply", async () => {
    const r = await streamPost("/api/dream/chat/stream", {
      message: "The trees were made of light and I could hear music",
      history: historyAfterTurn1,
    });
    const tokens = r.events.filter(e => e.type === "token");
    assert.ok(tokens.length > 0, "turn 2 should have tokens");
    turn2Reply = tokens.map(e => e.text).join("");
    assert.ok(turn2Reply.length > 0, "turn 2 reply should not be empty");
  });

  await test("turn 2 reply remains non-empty when history is supplied", async () => {
    assert.ok(turn2Reply.trim().length > 0, "turn 2 reply should remain non-empty");
  });

  // ── Turn 3: deeper follow-up with 2-turn history ────────────────────────
  console.log("\nTurn 3: 2-turn history threading");

  const historyAfterTurn2 = [
    ...historyAfterTurn1,
    { role: "user", text: "The trees were made of light and I could hear music" },
    { role: "assistant", text: turn2Reply },
  ];

  let turn3Done;
  await test("turn 3 POST with full 2-turn history returns reply", async () => {
    const r = await streamPost("/api/dream/chat/stream", {
      message: "Should I write this down in my journal?",
      history: historyAfterTurn2,
    });
    const tokens = r.events.filter(e => e.type === "token");
    assert.ok(tokens.length > 0, "turn 3 should have tokens");
    turn3Done = r.events.find(e => e.type === "done");
    assert.ok(turn3Done, "turn 3 should have done event");
  });

  await test("turn 3 done event has suggestions", async () => {
    assert.ok(Array.isArray(turn3Done.suggestions) && turn3Done.suggestions.length === 3, "turn 3 must have 3 suggestions");
  });

  // ── Memory recall — regression for #2956 ────────────────────────────────
  // The turns above thread history but only assert a reply comes back — they do
  // NOT check the reply USES the history. That gap let a bug ship where the
  // default gemini path built its request from only the current message, so the
  // model forgot everything earlier in the conversation. This states a
  // distinctive codeword, then requires it back. Gated on the provider being
  // ONLINE: an offline/fallback reply can't recall, and that is a provider
  // outage, not a memory regression — skip the assertion then rather than flake.
  console.log("\nMemory recall: the model must remember a codeword across turns (#2956)");
  const CODEWORD = "ZQXW4417";
  const codewordMsg = `Remember this codeword exactly for later: ${CODEWORD}. Reply "noted" to confirm.`;
  let recallHistory = [];
  await test("recall setup: state a codeword, capture the reply", async () => {
    const r = await streamPost("/api/dream/chat/stream", { message: codewordMsg, history: [] });
    const reply = r.events.filter(e => e.type === "token").map(e => e.text).join("");
    assert.ok(reply.length > 0, "codeword turn should return a reply");
    recallHistory = [
      { role: "user", text: codewordMsg },
      { role: "assistant", text: reply },
    ];
  });

  // A reply is "offline" (degraded, no LLM) when it carries the no-provider stub
  // markers — a reliable signal even when the done event mislabels online. Recall
  // cannot be exercised without a live model, so skip (never false-fail) then.
  const isOffline = (s) => {
    const t = (s || "").toLowerCase();
    return t.includes("no local model") || t.includes("providers are unreachable") ||
      t.includes("no llm") || t.includes("can't answer that right now") ||
      t.includes("degraded mode");
  };
  await test("the model recalls the codeword from history (conversation memory threads)", async () => {
    const setupReply = (recallHistory[1] && recallHistory[1].text) || "";
    const r = await streamPost("/api/dream/chat/stream", {
      message: "What was the exact codeword I asked you to remember? Reply with only the codeword.",
      history: recallHistory,
    });
    const done = r.events.find(e => e.type === "done");
    const reply = r.events.filter(e => e.type === "token").map(e => e.text).join("");
    if (!done || done.online !== true || isOffline(setupReply) || isOffline(reply)) {
      console.log("    (skipped: no live provider — recall needs an LLM; not a memory regression)");
      return;
    }
    assert.ok(
      reply.toUpperCase().includes(CODEWORD),
      `reply must recall the codeword ${CODEWORD} that was in the history, got: "${reply.slice(0, 140)}"`,
    );
  });

  // ── Save conversation as dream entry ────────────────────────────────────
  console.log("\nSave conversation as dream entry");

  const fullConversation = [
    "You: I had a dream about flying through a glowing forest",
    `Lantern: ${turn1Reply}`,
    "You: The trees were made of light and I could hear music",
    `Lantern: ${turn2Reply}`,
  ].join("\n");

  await test("POST /api/dream/create saves conversation as dream", async () => {
    const r = await request("POST", "/api/dream/create", {
      kind: "dream",
      text: fullConversation,
      tags: ["chat-log", "flying", "forest"],
      source: "dream-chat",
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.saved, true);
    assert.ok(r.body.id, "saved entry should have id");
    assert.ok(r.body.entry.text.includes("flying"), "saved text should include conversation content");
  });

  await test("saved chat-log entry appears in stats", async () => {
    const r = await request("GET", "/api/dream/stats");
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.total_entries >= 2, "should have at least 2 entries after saving");
  });

  // ── Summary ─────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${passed}/${total} passed`);
  if (failed > 0) {
    console.error(`${failed} failed`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("\nFATAL: Could not connect to server at", BASE);
  console.error(err.message);
  process.exit(1);
});
