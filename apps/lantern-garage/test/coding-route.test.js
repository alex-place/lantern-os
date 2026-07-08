// coding-route.test.js — #2185: the coding control-plane HTTP surface. Validates
// the route contract (path matching, operator-gating of mutations, input
// validation, read shapes, and that an operator route call reaches the backend
// and returns a held+verified proposal). The propose/verify/apply mechanics
// themselves are covered by coding-backend/coding-verifier tests.
// Run: node apps/lantern-garage/test/coding-route.test.js
"use strict";

const assert = require("assert");
const os = require("os");
const fs = require("fs");
const path = require("path");

// deterministic operator auth: unset tokens so an un-proxied loopback socket = operator
delete process.env.UNISONA_LOCAL_TOKEN;
delete process.env.OPERATOR_TOKEN;

const route = require("../routes/coding");

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.stack || e.message); }
}

// mock helpers
const OP = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };        // loopback => operator
const REMOTE = { socket: { remoteAddress: "8.8.8.8" }, headers: {} };      // no token => not operator
function mkReq(base, method, body) { return { ...base, method, url: "/", _body: body == null ? "" : JSON.stringify(body) }; }
function mkRes() { const r = {}; return r; }
const deps = {
  sendJson: (res, body, status = 200) => { res._json = { body, status }; },
  collectRequestBody: async (req) => req._body,
};
async function call(req, pathname) {
  const res = mkRes();
  const handled = await route(req, res, { pathname }, deps);
  return { handled, ...(res._json || {}) };
}

(async () => {
  await check("ignores non-coding paths (returns false)", async () => {
    const r = await call(mkReq(OP, "GET"), "/api/health");
    assert.strictEqual(r.handled, false);
  });

  await check("GET /backends returns the backend list + local engine", async () => {
    const r = await call(mkReq(OP, "GET"), "/api/coding/backends");
    assert.strictEqual(r.handled, true);
    assert(Array.isArray(r.body.backends) && r.body.backends.includes("mock"));
    assert("localEngine" in r.body);
  });

  await check("GET /pending returns an array shape", async () => {
    const r = await call(mkReq(OP, "GET"), "/api/coding/pending");
    assert.strictEqual(r.status || 200, 200);
    assert(Array.isArray(r.body.pending));
  });

  await check("POST /route WITHOUT operator → 403", async () => {
    const r = await call(mkReq(REMOTE, "POST", { task: "x" }), "/api/coding/route");
    assert.strictEqual(r.status, 403);
  });
  await check("POST /approve WITHOUT operator → 403", async () => {
    const r = await call(mkReq(REMOTE, "POST", { pendingId: "x" }), "/api/coding/approve");
    assert.strictEqual(r.status, 403);
  });

  await check("POST /route (operator) with no task → 400", async () => {
    const r = await call(mkReq(OP, "POST", {}), "/api/coding/route");
    assert.strictEqual(r.status, 400);
  });
  await check("POST /approve (operator) with no pendingId → 400", async () => {
    const r = await call(mkReq(OP, "POST", {}), "/api/coding/approve");
    assert.strictEqual(r.status, 400);
  });

  await check("POST /route (operator) reaches the backend → held + verified proposal", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kb-route-"));
    const r = await call(mkReq(OP, "POST", { task: "add a note", repoPath: repo, candidates: ["mock"], defaultBackend: "mock" }), "/api/coding/route");
    assert.strictEqual(r.status, 200, "routed ok");
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.status, "awaiting_approval");
    assert(r.body.pendingId, "returns a pendingId to approve against");
    assert("verification" in r.body, "verifier verdict rides along");
    assert(r.body.routing, "routing decision included");
  });

  console.log(failures ? `\n${failures} FAILED` : "\nall coding-route (#2185) tests passed");
  process.exit(failures ? 1 : 0);
})();
