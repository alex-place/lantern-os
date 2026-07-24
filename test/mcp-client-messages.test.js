// #2760 — mcp-client.callTool must speak the server's JSON-RPC `tools/call` over
// `/messages` (the working endpoint), not the 404ing `/tool/<name>` it used to post
// to. Drives callTool against a mock MCP server that answers /health + /messages.
//
// Run: node test/mcp-client-messages.test.js
const assert = require("assert");
const http = require("http");

let failures = 0;
async function check(name, fn) {
  try { await fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.stack || e.message}\n`); }
}

// Spin a mock MCP server: /health → 200, /messages → the JSON-RPC reply `respond(rpcReq)`
// produces. Returns { url:{host,port}, calls, close }.
function mockServer(respond) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    if (req.url === "/health") { res.statusCode = 200; res.end('{"ok":true}'); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let rpcReq = {};
      try { rpcReq = JSON.parse(body); } catch { /* leave empty */ }
      calls.push({ path: req.url, method: req.method, rpc: rpcReq });
      const out = respond(rpcReq);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      resolve({ port, calls, close: () => srv.close() });
    });
  });
}

// Load a FRESH mcp-client bound to the mock server's port (MCP_URL is read at require).
function freshClient(port) {
  const prevHost = process.env.MCP_HOST, prevPort = process.env.MCP_PORT;
  process.env.MCP_HOST = "127.0.0.1";
  process.env.MCP_PORT = String(port);
  delete require.cache[require.resolve("../lib/mcp-client")];
  const mod = require("../lib/mcp-client");
  mod._resetCache();
  return { mod, restore: () => {
    if (prevHost === undefined) delete process.env.MCP_HOST; else process.env.MCP_HOST = prevHost;
    if (prevPort === undefined) delete process.env.MCP_PORT; else process.env.MCP_PORT = prevPort;
    delete require.cache[require.resolve("../lib/mcp-client")];
  } };
}

(async () => {
  // 1. Success: posts tools/call to /messages, returns the tool's parsed JSON payload.
  await check("calls /messages tools/call and returns parsed tool payload", async () => {
    const srv = await mockServer((rpc) => ({
      jsonrpc: "2.0", id: rpc.id,
      result: { content: [{ type: "text", text: JSON.stringify({ skills: [{ name: "dream_journal" }] }) }], isError: false },
    }));
    const { mod, restore } = freshClient(srv.port);
    try {
      const out = await mod.callTool("list_skills", {});
      // hit the working endpoint with the right JSON-RPC method + params
      const toolCall = srv.calls.find((c) => c.path === "/messages");
      assert.ok(toolCall, "should POST to /messages");
      assert.strictEqual(toolCall.rpc.method, "tools/call");
      assert.strictEqual(toolCall.rpc.params.name, "list_skills");
      // and surface the tool's own payload (so keystone-context can read .skills)
      assert.deepStrictEqual(out.skills, [{ name: "dream_journal" }]);
      assert.ok(!srv.calls.some((c) => c.path.startsWith("/tool/")), "must not use the /tool/<name> route");
    } finally { restore(); srv.close(); }
  });

  // 2. Non-JSON text result → wrapped as { text }.
  await check("non-JSON tool text → { text }", async () => {
    const srv = await mockServer((rpc) => ({
      jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "plain output" }] },
    }));
    const { mod, restore } = freshClient(srv.port);
    try {
      const out = await mod.callTool("something", {});
      assert.deepStrictEqual(out, { text: "plain output" });
    } finally { restore(); srv.close(); }
  });

  // 3. JSON-RPC error → standardized error result.
  await check("rpc error → { status:error }", async () => {
    const srv = await mockServer((rpc) => ({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "method not found" } }));
    const { mod, restore } = freshClient(srv.port);
    try {
      const out = await mod.callTool("nope", {});
      assert.strictEqual(out.status, "error");
      assert.strictEqual(out.reason_code, "mcp_tool_error");
      assert.match(out.error, /method not found/);
    } finally { restore(); srv.close(); }
  });

  // 4. tools/call result.isError → error status carrying the error text.
  await check("result.isError → { status:error }", async () => {
    const srv = await mockServer((rpc) => ({
      jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "boom" }], isError: true },
    }));
    const { mod, restore } = freshClient(srv.port);
    try {
      const out = await mod.callTool("x", {});
      assert.strictEqual(out.status, "error");
      assert.match(out.error, /boom/);
    } finally { restore(); srv.close(); }
  });

  // 5. Offline (no server) → unavailable, never throws.
  await check("offline → { status:unavailable }", async () => {
    // Point at a port with nothing listening.
    const { mod, restore } = freshClient(1);
    try {
      const out = await mod.callTool("list_skills", {});
      assert.strictEqual(out.status, "unavailable");
      assert.strictEqual(out.reason_code, "mcp_server_offline");
    } finally { restore(); }
  });

  process.stdout.write(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
