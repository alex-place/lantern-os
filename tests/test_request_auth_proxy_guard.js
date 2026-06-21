/**
 * Regression test — request-auth proxy-header guard (#839) + operator-gate basis (#837/#838).
 *
 * BEFORE: isOperatorRequest trusted req.socket.remoteAddress === 127.0.0.1 with no proxy-header
 * check. Behind the Cloudflare tunnel (lantern-os.net → 127.0.0.1) every visitor's socket is
 * loopback, so the whole internet was treated as the trusted operator — gating the global
 * conversation read/delete and (now) the keystone/operator action routes.
 *
 * AFTER: a proxied request (any of PROXY_HEADERS present) can never be "loopback", so it is only
 * an operator if it carries a valid OPERATOR_TOKEN. Un-proxied local hits still pass.
 *
 * Pure unit test — no server, no network. Run: node tests/test_request_auth_proxy_guard.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
const { isOperatorRequest, isLoopback, isProxied } = require(
  path.join(__dirname, "..", "apps", "lantern-garage", "lib", "request-auth.js")
);

function mkReq({ addr = "127.0.0.1", headers = {} } = {}) {
  return { socket: { remoteAddress: addr }, headers };
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  - " + name); passed++; }
  catch (e) { console.log("  FAIL- " + name + ": " + e.message); failed++; }
}

console.log("\nrequest-auth proxy-header guard (#839)\n");

check("un-proxied loopback request IS operator (local dashboard still works)", () => {
  assert.strictEqual(isOperatorRequest(mkReq(), {}), true);
});

check("loopback socket + cf-connecting-ip is NOT operator (Cloudflare tunnel visitor)", () => {
  assert.strictEqual(isOperatorRequest(mkReq({ headers: { "cf-connecting-ip": "203.0.113.7" } }), {}), false);
});

check("loopback socket + x-forwarded-for is NOT operator", () => {
  assert.strictEqual(isOperatorRequest(mkReq({ headers: { "x-forwarded-for": "203.0.113.7" } }), {}), false);
});

check("loopback socket + cf-ray is NOT operator", () => {
  assert.strictEqual(isOperatorRequest(mkReq({ headers: { "cf-ray": "7d2-LHR" } }), {}), false);
});

check("remote socket, no token configured, is NOT operator", () => {
  assert.strictEqual(isOperatorRequest(mkReq({ addr: "203.0.113.7" }), {}), false);
});

check("remote socket WITH valid OPERATOR_TOKEN IS operator", () => {
  assert.strictEqual(
    isOperatorRequest(mkReq({ addr: "203.0.113.7", headers: { "x-operator-token": "s3cret" } }), { OPERATOR_TOKEN: "s3cret" }),
    true
  );
});

check("proxied request with WRONG token is NOT operator", () => {
  assert.strictEqual(
    isOperatorRequest(mkReq({ headers: { "cf-ray": "abc", "x-operator-token": "wrong" } }), { OPERATOR_TOKEN: "s3cret" }),
    false
  );
});

check("isLoopback is false for a proxied request even from a loopback socket", () => {
  assert.strictEqual(isLoopback(mkReq({ headers: { "x-real-ip": "203.0.113.7" } })), false);
  assert.strictEqual(isProxied(mkReq({ headers: { "x-real-ip": "203.0.113.7" } })), true);
});

console.log(`\nrequest-auth: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
