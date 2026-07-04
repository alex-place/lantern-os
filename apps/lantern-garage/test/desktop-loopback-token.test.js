// desktop-loopback-token.test.js — #1946 G4 wiring. When UNISONA_LOCAL_TOKEN is set
// (the desktop launcher mints one per boot), loopback ALONE is not operator — the
// request must carry the token via header, the SameSite cookie the Core hands the
// browser, or the ?__lt= launch/query param (EventSource can't set headers). Servers
// (token unset) are unchanged. Run: node apps/lantern-garage/test/desktop-loopback-token.test.js
"use strict";

const assert = require("assert");
const auth = require("../lib/request-auth");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const loop = (extra = {}) => ({ socket: { remoteAddress: "127.0.0.1" }, url: "/", headers: {}, ...extra });
const withCookie = (v) => loop({ headers: { cookie: `theme=dark; unisona_lt=${v}; foo=bar` } });
const withQuery = (v) => loop({ url: `/dream-chat.html?__lt=${v}&x=1`, headers: { host: "127.0.0.1:5000" } });
const withHeader = (name, v) => loop({ headers: { [name]: v } });

const TOKEN = "boot-token-abcdef123456";

check("requestToken reads header, cookie, and ?__lt query (in that precedence)", () => {
  assert.strictEqual(auth.requestToken(withHeader("x-operator-token", "H")), "H");
  assert.strictEqual(auth.requestToken(withHeader("x-unisona-token", "U")), "U");
  assert.strictEqual(auth.requestToken(withCookie("C")), "C");
  assert.strictEqual(auth.requestToken(withQuery("Q")), "Q");
  assert.strictEqual(auth.requestToken(loop()), ""); // nothing carried
});

check("parseCookies is tolerant and decodes values", () => {
  const c = auth.parseCookies({ headers: { cookie: "a=1; unisona_lt=x%20y; b=" } });
  assert.strictEqual(c.a, "1");
  assert.strictEqual(c.unisona_lt, "x y");
});

check("UNISONA_LOCAL_TOKEN set: loopback ALONE is denied; the token (any transport) grants", () => {
  const env = { UNISONA_LOCAL_TOKEN: TOKEN };
  assert.strictEqual(auth.isOperatorRequest(loop(), env), false, "bare loopback must be denied");
  assert.strictEqual(auth.isOperatorRequest(withCookie(TOKEN), env), true, "matching cookie grants");
  assert.strictEqual(auth.isOperatorRequest(withQuery(TOKEN), env), true, "matching ?__lt grants");
  assert.strictEqual(auth.isOperatorRequest(withHeader("x-operator-token", TOKEN), env), true, "matching header grants");
  assert.strictEqual(auth.isOperatorRequest(withCookie("wrong-token-abcdef1234"), env), false, "wrong token denied");
});

check("token unset: servers behave as today (un-proxied loopback trusted)", () => {
  assert.strictEqual(auth.isOperatorRequest(loop(), {}), true);
  const proxied = { socket: { remoteAddress: "127.0.0.1" }, url: "/", headers: { "x-forwarded-for": "9.9.9.9" } };
  assert.strictEqual(auth.isOperatorRequest(proxied, {}), false);
});

if (failures) { console.error(`\ndesktop-loopback-token: ${failures} FAILED`); process.exit(1); }
console.log("\ndesktop-loopback-token: all checks passed");
