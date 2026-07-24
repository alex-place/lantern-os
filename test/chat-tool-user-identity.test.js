// Chat-tool user-identity forwarding — the in-process loopback hop that chat
// tools use for /api/trading/* carries no session cookie, so runTool ctx.userId
// is forwarded as x-keystone-user and honored ONLY on operator-trusted requests
// (request-auth.internalUserId). Without this, "my portfolio" in chat could
// never resolve the user's per-user IBKR connection (ADR-0022).
//
// Run: node test/chat-tool-user-identity.test.js
const assert = require("assert");
const http = require("http");
const { internalUserId } = require("../lib/request-auth");

let failures = 0;
function check(name, fn) {
  const done = (e) => {
    if (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
    else console.log("  ok  -", name);
  };
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.then(() => done(), done);
    done();
  } catch (e) { done(e); }
  return Promise.resolve();
}

const loopbackReq = (headers) => ({
  headers, url: "/api/trading/positions",
  socket: { remoteAddress: "127.0.0.1" },
});

async function main() {
  const ENV = {}; // no UNISONA_LOCAL_TOKEN / OPERATOR_TOKEN → loopback = operator

  await check("internal loopback request with both headers → forwarded id", () => {
    const req = loopbackReq({ "x-keystone-internal": "1", "x-keystone-user": "test-user" });
    assert.strictEqual(internalUserId(req, ENV), "test-user");
  });

  await check("URI-encoded ids decode (profile ids can contain any chars)", () => {
    const req = loopbackReq({ "x-keystone-internal": "1", "x-keystone-user": encodeURIComponent("u/1 %x") });
    assert.strictEqual(internalUserId(req, ENV), "u/1 %x");
  });

  await check("proxied request (cf-ray) is REFUSED even with both headers", () => {
    const req = loopbackReq({ "x-keystone-internal": "1", "x-keystone-user": "test-user", "cf-ray": "abc" });
    assert.strictEqual(internalUserId(req, ENV), "");
  });

  await check("non-internal request (no x-keystone-internal) is refused", () => {
    const req = loopbackReq({ "x-keystone-user": "test-user" });
    assert.strictEqual(internalUserId(req, ENV), "");
  });

  await check("non-loopback socket is refused", () => {
    const req = { headers: { "x-keystone-internal": "1", "x-keystone-user": "test-user" },
      url: "/x", socket: { remoteAddress: "203.0.113.5" } };
    assert.strictEqual(internalUserId(req, ENV), "");
  });

  await check("with UNISONA_LOCAL_TOKEN set, the hop must carry the token", () => {
    const env = { UNISONA_LOCAL_TOKEN: "boot-token" };
    const bare = loopbackReq({ "x-keystone-internal": "1", "x-keystone-user": "test-user" });
    assert.strictEqual(internalUserId(bare, env), "", "refused without the launcher token");
    const withTok = loopbackReq({
      "x-keystone-internal": "1", "x-keystone-user": "test-user", "x-unisona-token": "boot-token",
    });
    assert.strictEqual(internalUserId(withTok, env), "test-user");
  });

  // ── end-to-end: runTool ctx.userId reaches the trading endpoint as a header ──
  await check("runTool forwards ctx.userId on the loopback hop (trader_positions)", async () => {
    const seen = {};
    const srv = http.createServer((req2, res2) => {
      Object.assign(seen, req2.headers);
      res2.setHeader("content-type", "application/json");
      res2.end(JSON.stringify({ available: true, account: { equity: 1 }, positions: [] }));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const prevPort = process.env.LANTERN_GARAGE_PORT;
    process.env.LANTERN_GARAGE_PORT = String(srv.address().port);
    try {
      const toolRunner = require("../lib/tool-runner");
      const r = await toolRunner.runTool("trader_positions", {}, { operator: true, userId: "test-user" });
      assert.ok(r.ok, `tool failed: ${r.error || r.reason}`);
      assert.strictEqual(seen["x-keystone-internal"], "1");
      assert.strictEqual(seen["x-keystone-user"], "test-user");
    } finally {
      if (prevPort === undefined) delete process.env.LANTERN_GARAGE_PORT;
      else process.env.LANTERN_GARAGE_PORT = prevPort;
      srv.close();
    }
  });

  await check("runTool without ctx.userId sends no identity header (guest/MCP)", async () => {
    const seen = {};
    const srv = http.createServer((req2, res2) => {
      Object.assign(seen, req2.headers);
      res2.setHeader("content-type", "application/json");
      res2.end(JSON.stringify({ available: true, account: {}, positions: [] }));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const prevPort = process.env.LANTERN_GARAGE_PORT;
    process.env.LANTERN_GARAGE_PORT = String(srv.address().port);
    try {
      const toolRunner = require("../lib/tool-runner");
      const r = await toolRunner.runTool("trader_positions", {}, { operator: true });
      assert.ok(r.ok, `tool failed: ${r.error || r.reason}`);
      assert.strictEqual(seen["x-keystone-user"], undefined);
    } finally {
      if (prevPort === undefined) delete process.env.LANTERN_GARAGE_PORT;
      else process.env.LANTERN_GARAGE_PORT = prevPort;
      srv.close();
    }
  });

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nAll chat-tool-user-identity tests passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
