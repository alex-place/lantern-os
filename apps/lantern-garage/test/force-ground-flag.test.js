// "Ground this" retry — the forceGround flag must parse from both GET query and
// POST body, and default false. Wires the groundedness-canary badge to a real
// forced-grounding re-run.
//
// Run: node apps/lantern-garage/test/force-ground-flag.test.js
const assert = require("assert");
const { parseStreamChatRequest } = require("../lib/stream-chat/request");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

async function run() {
  // GET: forceGround=1
  const g1 = await parseStreamChatRequest(
    { method: "GET" },
    new URL("http://x/api/dream/chat/stream?message=hi&forceGround=1"));
  check("GET forceGround=1 → true", () => assert.strictEqual(g1.forceGround, true));

  // GET: forceGround=true
  const g2 = await parseStreamChatRequest(
    { method: "GET" },
    new URL("http://x/api/dream/chat/stream?message=hi&forceGround=true"));
  check("GET forceGround=true → true", () => assert.strictEqual(g2.forceGround, true));

  // GET: absent → false
  const g3 = await parseStreamChatRequest(
    { method: "GET" },
    new URL("http://x/api/dream/chat/stream?message=hi"));
  check("GET absent → false", () => assert.strictEqual(g3.forceGround, false));

  // POST: body.forceGround true
  const p1 = await parseStreamChatRequest(
    { method: "POST" },
    new URL("http://x/api/dream/chat/stream"),
    { collectRequestBody: async () => JSON.stringify({ message: "hi", forceGround: true }) });
  check("POST forceGround:true → true", () => assert.strictEqual(p1.forceGround, true));

  // POST: body without flag → false
  const p2 = await parseStreamChatRequest(
    { method: "POST" },
    new URL("http://x/api/dream/chat/stream"),
    { collectRequestBody: async () => JSON.stringify({ message: "hi" }) });
  check("POST absent → false", () => assert.strictEqual(p2.forceGround, false));

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nall force-ground-flag checks passed");
}

run();
