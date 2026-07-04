// desktop-loopback-token-http.test.js — real-HTTP proof of the #1946 G4 cookie flow.
// Uses the REAL lib/request-auth + the exact cookie-set snippet from server.js's
// route() to verify end-to-end over a live socket, without the full server's deps:
//   1. no token            → operator DENIED
//   2. GET /?__lt=<token>  → 200 + Set-Cookie: unisona_lt (SameSite=Strict, HttpOnly)
//   3. request WITH cookie → operator GRANTED
//   4. request with wrong cookie → DENIED
// Run: node apps/lantern-garage/test/desktop-loopback-token-http.test.js
"use strict";

const assert = require("assert");
const http = require("http");
const auth = require("../lib/request-auth");

const TOKEN = "http-boot-token-abcdef123456";
let failures = 0;

// The exact loopback-token gate server.js applies, in one place.
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const localToken = TOKEN; // stands in for process.env.UNISONA_LOCAL_TOKEN
  const lt = url.searchParams.get("__lt");
  if (lt && auth.tokensEqual(lt, localToken)) {
    res.setHeader("Set-Cookie",
      `unisona_lt=${encodeURIComponent(localToken)}; Path=/; SameSite=Strict; HttpOnly; Max-Age=31536000`);
  }
  const ok = auth.isOperatorRequest(req, { UNISONA_LOCAL_TOKEN: localToken });
  res.writeHead(ok ? 200 : 403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ operator: ok }));
});

function req(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const r = http.get({ host: "127.0.0.1", port, path: pathname, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, setCookie: res.headers["set-cookie"], body }));
    });
    r.on("error", reject);
  });
}

function check(name, cond, detail) {
  if (cond) console.log("  ok  -", name);
  else { failures++; console.error("  FAIL-", name, detail ? `\n       ${detail}` : ""); }
}

server.listen(0, "127.0.0.1", async () => {
  try {
    const noTok = await req("/api/keystone/status");
    check("bare request (no token) is DENIED (403)", noTok.status === 403, `got ${noTok.status}`);

    const boot = await req(`/dream-chat.html?__lt=${TOKEN}`);
    const cookie = (boot.setCookie || []).join("; ");
    check("GET /?__lt=<token> is granted AND sets the cookie", boot.status === 200 && /unisona_lt=/.test(cookie), cookie);
    check("cookie is SameSite=Strict + HttpOnly (CSRF/rebind-safe, not JS-readable)",
      /SameSite=Strict/i.test(cookie) && /HttpOnly/i.test(cookie), cookie);

    const withCookie = await req("/api/keystone/status", { Cookie: `unisona_lt=${TOKEN}` });
    check("subsequent request WITH the cookie is GRANTED (200)", withCookie.status === 200, `got ${withCookie.status}`);

    const wrong = await req("/api/keystone/status", { Cookie: "unisona_lt=not-the-real-token-xx" });
    check("request with a WRONG cookie is DENIED (403)", wrong.status === 403, `got ${wrong.status}`);
  } catch (e) {
    failures++; console.error("  FAIL- harness error:", e.message);
  } finally {
    server.close(() => {
      if (failures) { console.error(`\ndesktop-loopback-token-http: ${failures} FAILED`); process.exit(1); }
      console.log("\ndesktop-loopback-token-http: all checks passed");
    });
  }
});
