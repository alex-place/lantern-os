/**
 * Tests for apps/lantern-garage/routes/agent-status.js
 * Run: node tests/test_agent_status_route.js
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const http = require("http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-asr-test-"));

// ── Stub queue-manager ────────────────────────────────────────────────────────
const qmTmp = path.join(TMP, "queue-manager.js");
fs.writeFileSync(qmTmp, `
"use strict";
module.exports = {
  snapshot: () => ({
    pending:   [{ issue_number: 101, title: "Pending task", lane: "claude/" }],
    assigned:  [{ issue_number: 99, title: "Active task", lane: "gemini/", agent_id: "gemini-1", assigned_at: new Date(Date.now()-90000).toISOString() }],
    completed: [{ issue_number: 98, title: "Done task", lane: "claude/" }, { issue_number: 97, title: "Done 2", lane: "claude/" }],
  }),
};
`);

// ── Stub agent-slot-manager ───────────────────────────────────────────────────
const smTmp = path.join(TMP, "agent-slot-manager.js");
fs.writeFileSync(smTmp, `
"use strict";
module.exports = {
  getAllStatus: () => [
    { id: "claude-1", lane: "claude/", label: "Claude", status: "idle", enabled: true, retries: 0, currentEntryId: null, lastHeartbeat: Date.now(), lastError: null },
    { id: "gemini-1", lane: "gemini/", label: "Gemini", status: "working", enabled: true, retries: 0, currentEntryId: "wq-99-xxx", lastHeartbeat: Date.now(), lastError: null },
  ],
};
`);

// ── Minimal http-utils stub ───────────────────────────────────────────────────
const utilsTmp = path.join(TMP, "http-utils.js");
fs.writeFileSync(utilsTmp, `
"use strict";
module.exports = {
  sendJson(res, data, status = 200) {
    const body = JSON.stringify(data);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  }
};
`);

// ── Patch route to use stubs ──────────────────────────────────────────────────
const REPO_ROOT = path.resolve(__dirname, "..");
const routeSrc = fs.readFileSync(path.join(REPO_ROOT, "apps/lantern-garage/routes/agent-status.js"), "utf8")
  .replace(`tryRequire(path.join(REPO_ROOT, "src/queue-manager"))`, `tryRequire(${JSON.stringify(qmTmp)})`)
  .replace(`tryRequire(path.join(REPO_ROOT, "src/agent-slot-manager"))`, `tryRequire(${JSON.stringify(smTmp)})`)
  .replace('require("../lib/http-utils")', `require(${JSON.stringify(utilsTmp)})`);
const routeTmp = path.join(TMP, "agent-status-route.js");
fs.writeFileSync(routeTmp, routeSrc);

const agentStatusRoute = require(routeTmp);

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeReqRes(method, pathname) {
  const chunks = [];
  const res = {
    statusCode: 200,
    headers: {},
    writeHead(code, hdrs) { this.statusCode = code; Object.assign(this.headers, hdrs || {}); },
    end(body) { this._body = body; },
    get body() { return JSON.parse(this._body || "{}"); },
  };
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, url: pathname, headers: { host: "localhost" } };
  return { req, res, url };
}

let passed = 0, failed = 0;
function assert(label, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`); failed++; }
}
function section(n) { console.log(`\n── ${n}`); }

// ── Tests ─────────────────────────────────────────────────────────────────────

(async () => {
  section("GET /api/dream/status/agents");
  const { req, res, url } = makeReqRes("GET", "/api/dream/status/agents");
  const handled = await agentStatusRoute(req, res, url);
  assert("route handled", handled === true);
  assert("status 200", res.statusCode === 200);
  assert("body has text", typeof res.body.text === "string");
  assert("body has queue", typeof res.body.queue === "object");
  assert("pending count correct", res.body.queue.pending === 1);
  assert("working count correct", res.body.queue.working === 1);
  assert("completed count correct", res.body.queue.completed === 2);
  assert("pct calculated", res.body.queue.pct === 50); // 2/(1+1+2)
  assert("text mentions claude lane", res.body.text.includes("claude lane"));
  assert("text mentions gemini lane", res.body.text.includes("gemini lane"));
  assert("text mentions Queue:", res.body.text.includes("Queue:"));
  assert("next items present", res.body.queue.next.length > 0);
  assert("next item has number", res.body.queue.next[0].number === 101);

  section("non-matching routes pass through");
  const { req: r2, res: res2, url: u2 } = makeReqRes("GET", "/api/other");
  const h2 = await agentStatusRoute(r2, res2, u2);
  assert("returns false for other routes", h2 === false);

  const { req: r3, res: res3, url: u3 } = makeReqRes("POST", "/api/dream/status/agents");
  const h3 = await agentStatusRoute(r3, res3, u3);
  assert("returns false for POST", h3 === false);

  section("working slot shows timing");
  assert("gemini lane shows 'working'", res.body.text.includes("working"));

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
