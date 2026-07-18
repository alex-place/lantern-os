"use strict";
// Issue #689 — OAuth state must survive the patreon.com → 127.0.0.1 redirect /
// server restart via a signed short-TTL cookie. Run: node tests/test_patreon_oauth_cookie.js
const assert = require("assert");
const { signOauth, verifyOauth, readCookie } = require("../apps/lantern-garage/lib/oauth-core");

let pass = 0;
const ok = (n, c) => { assert.ok(c, n); console.log("  ok -", n); pass++; };

const tok = signOauth({ state: "abc", verifier: "v1", return_to: "/x", exp: Date.now() + 60000 });
const v = verifyOauth(tok);
ok("round-trip recovers state/verifier/return_to", v && v.state === "abc" && v.verifier === "v1" && v.return_to === "/x");
ok("tampered token rejected", verifyOauth(tok.slice(0, -2) + "xx") === null);
ok("expired token rejected", verifyOauth(signOauth({ state: "s", exp: Date.now() - 1 })) === null);
ok("garbage/null rejected", verifyOauth("not-a-token") === null && verifyOauth(null) === null);
ok("readCookie parses target cookie", readCookie({ headers: { cookie: "foo=1; lantern_oauth=" + encodeURIComponent("xyz") + "; bar=2" } }, "lantern_oauth") === "xyz");
ok("readCookie returns null when absent", readCookie({ headers: {} }, "lantern_oauth") === null);

console.log(`\n${pass} passed`);
