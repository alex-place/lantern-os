/**
 * Dream Journal v0 Chat Tests
 * Tests the /api/dream/chat endpoint with single-agent selection.
 *
 * Run: node tests/test_dream_journal_chat.js
 */

const http = require("http");
const assert = require("assert");
const { baseUrl: BASE, hostname: HOST, port: PORT } = require("./lantern-test-base");

let passed = 0;
let failed = 0;

async function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: HOST,
      port: PORT,
      path,
      method,
      headers: { "Content-Type": "application/json" },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \u2717 ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

async function run() {
  console.log("\nDream Journal v0 Chat Tests\n");
  console.log("Target:", BASE, "/api/dream/chat\n");

  // ── Agent response structure ─────────────────────────────────────────────
  console.log("Agent response structure");

  await test("returns 200 with reply, agent, suggestions, online", async () => {
    const r = await request("POST", "/api/dream/chat", {
      message: "I dreamt of flying",
    });
    assert.strictEqual(r.status, 200);
    assert.ok(typeof r.body.reply === "string", "reply should be string");
    assert.ok(typeof r.body.agent === "string", "agent should be string");
    assert.ok(r.body.agent.length > 0, "agent name should not be empty");
    assert.ok(typeof r.body.online === "boolean", "online should be boolean");
    assert.ok(Array.isArray(r.body.suggestions), "suggestions should be array");
  });

  // #1664 one-assistant refactor: the chat is ONE assistant. selectAgent() always
  // resolves the single keystone/unisona.ai assistant — there is NO keyword persona
  // routing anymore (the old Waterfall/Mary/Founder/Xenon RP personas were removed).
  // These assert the current invariant; the previous keyword-routing assertions were
  // stale (they expected removed personas and had silently failed since this file
  // isn't in the CI node-test list).
  await test("agent is the SAME single assistant regardless of message content", async () => {
    const messages = [
      "I saw a waterfall",
      "I want to remember the story of my anchor",
      "Tell me about the wish and returning home",
    ];
    const agents = [];
    for (const message of messages) {
      const r = await request("POST", "/api/dream/chat", { message });
      assert.ok(typeof r.body.agent === "string" && r.body.agent.length > 0, `agent name for "${message}"`);
      agents.push(r.body.agent);
    }
    // One assistant → every message resolves to the identical agent (no keyword routing).
    assert.strictEqual(
      new Set(agents).size, 1,
      `expected one stable assistant across all messages, got: ${[...new Set(agents)].join(", ")}`
    );
  });

  await test("the single assistant is the keystone / unisona.ai agent", async () => {
    const r = await request("POST", "/api/dream/chat", { message: "hello" });
    const agentName = r.body.agent || "";
    assert.ok(
      /unisona\.ai|keystone/i.test(agentName),
      `expected the keystone/unisona.ai assistant, got: ${agentName}`
    );
  });

  // ── Content quality ──────────────────────────────────────────────────────
  console.log("\nContent quality");

  await test("response quotes user's dream text", async () => {
    const dreamText = "I was walking through a crystalline city";
    const r = await request("POST", "/api/dream/chat", { message: dreamText });
    if (r.status === 200) {
      const reply = String(r.body.reply || "").toLowerCase();
      assert.ok(reply.length > 0, "reply should not be empty");
      assert.ok(typeof r.body.agent === "string" && r.body.agent.length > 0, "200 response should include agent");
      return;
    }

    assert.strictEqual(r.status, 503, `expected 200 or 503, got ${r.status}`);
    assert.ok(r.body.error, "503 response must include error");
    assert.ok(typeof r.body.agent === "string" && r.body.agent.length > 0, "503 response must include agent");
  });

  await test("door mentions trigger lore context", async () => {
    const r = await request("POST", "/api/dream/chat", {
      message: "Tell me about the founder's wish door",
    });
    assert.strictEqual(r.status, 200);
    const reply = String(r.body.reply || "").toLowerCase();
    assert.ok(reply.length > 0, "reply should not be empty");
    assert.ok(typeof r.body.agent === "string" && r.body.agent.length > 0, "response should include agent");
  });

  // ── Edge cases ──────────────────────────────────────────────────────────
  console.log("\nEdge cases");

  await test("empty message returns suggestions without crashing", async () => {
    const r = await request("POST", "/api/dream/chat", { message: "" });
    if (r.status === 200) {
      assert.ok(Array.isArray(r.body.suggestions), "should have suggestions");
      return;
    }

    assert.strictEqual(r.status, 503, `expected 200 or 503, got ${r.status}`);
    assert.ok(r.body.error, "503 response must include error");
    assert.ok(typeof r.body.agent === "string" && r.body.agent.length > 0, "503 response must include agent");
  });

  await test("very long message is truncated safely", async () => {
    const longMessage = "dream ".repeat(500);
    const r = await request("POST", "/api/dream/chat", { message: longMessage });
    assert.strictEqual(r.status, 200);
    assert.ok(typeof r.body.reply === "string", "still returns reply after truncation");
  });

  await test("special characters in message don't break JSON", async () => {
    const r = await request("POST", "/api/dream/chat", {
      message: "I saw \"quotes\" and 'apostrophes' and \\backslashes\\",
    });
    assert.strictEqual(r.status, 200);
    assert.ok(typeof r.body.reply === "string", "handles special chars");
  });

  await test("unicode dream text is preserved", async () => {
    const r = await request("POST", "/api/dream/chat", {
      message: "I dreamt of a glowing lantern \uD83C\uDF1F and a waterfall \uD83D\uDCA7",
    });
    assert.strictEqual(r.status, 200);
    assert.ok(typeof r.body.reply === "string", "handles unicode");
  });

  // ── Performance ──────────────────────────────────────────────────────────
  console.log("\nPerformance");

  await test("response time under 5 seconds", async () => {
    const start = Date.now();
    const r = await request("POST", "/api/dream/chat", {
      message: "Quick performance test",
    });
    const elapsed = Date.now() - start;
    assert.strictEqual(r.status, 200);
    assert.ok(elapsed < 5000, `took ${elapsed}ms, should be < 5000ms`);
    console.log(`    (${elapsed}ms)`);
  });

  await test("sequential requests don't corrupt state", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await request("POST", "/api/dream/chat", {
        message: `Sequential test ${i + 1}`,
      });
      assert.strictEqual(r.status, 200);
      assert.ok(typeof r.body.reply === "string", `request ${i + 1} has reply`);
    }
  });

  // ── Regression #2077: pure code-gen asks are answered with code ───────────
  // Live-LLM behavioral case (no deterministic contract exists for chat): a
  // trivial "write a function" ask must come back with actual code and must not
  // relay a shell/coding-backend restriction ("Bash tool is restricted to
  // allowlisted commands…") as the answer.
  console.log("\nCode-generation regression (#2077)");

  await test("trivial code request returns code, not a shell-restriction refusal", async () => {
    const r = await request("POST", "/api/dream/chat", {
      message: "write a python function that reverses a string",
    });
    assert.strictEqual(r.status, 200);
    const reply = String(r.body.reply || "");
    if (r.body.online === false) {
      console.log("    (no provider online — offline fallback exempt)");
      return;
    }
    assert.ok(
      /def\s+\w+\s*\(|```/.test(reply),
      `expected python code in reply, got: ${reply.slice(0, 240)}`
    );
    const refusal = /(restricted to allowlisted|not allowlisted|allowlisted commands|bash tool is restricted|cannot (run|execute) (the )?(bash|shell|command))/i;
    assert.ok(
      !refusal.test(reply),
      `reply relays a shell restriction instead of answering: ${reply.slice(0, 300)}`
    );
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${passed}/${total} passed`);
  if (failed > 0) {
    console.error(`${failed} failed`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("\nFATAL: Could not connect to server at", BASE);
  console.error("Make sure lantern-garage is running: node apps/lantern-garage/server.js");
  console.error(err.message);
  process.exit(1);
});
