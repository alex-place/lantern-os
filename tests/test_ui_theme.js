/**
 * Regression test for the /api/ui/theme sendJson argument-order bug.
 *
 * routes/ui.js called sendJson(res, status, data) but the signature is
 * sendJson(res, data, status=200) — so GET/POST returned the numeric status as the
 * JSON body and the payload object as the HTTP status code. This mounts the REAL
 * route over HTTP and asserts a correct round-trip (status 200 + {theme} body) and
 * that the change persists.
 *
 * Run: node apps/lantern-garage/tests/test_ui_theme.js   (no external server)
 */
"use strict";
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const assert = require("assert");

const LIB = path.join(__dirname, "..");
const { sendJson, collectRequestBody } = require(path.join(LIB, "lib/http-utils"));
const uiRoute = require(path.join(LIB, "routes/ui.js"));

const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uitheme-"));
const deps = { sendJson, collectRequestBody, repoRoot };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const handled = await uiRoute(req, res, url, deps);
  if (!handled) { res.writeHead(404); res.end("nf"); }
});

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok  - " + n); } else { fail++; console.log("  FAIL- " + n); } };

server.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (method, p, body) => {
    const r = await fetch(base + p, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null; const t = await r.text();
    try { data = JSON.parse(t); } catch (_) {}
    return { status: r.status, data, text: t };
  };
  try {
    // GET default: status must be 200 (not a stringified object) and body a real {theme}.
    let r = await j("GET", "/api/ui/theme");
    ok("GET returns HTTP 200 (not the payload-as-status bug)", r.status === 200);
    ok("GET body is a JSON object with theme", r.data && r.data.theme === "dark");

    // POST light: 200 + {theme:'light', saved:true}
    r = await j("POST", "/api/ui/theme", { theme: "light" });
    ok("POST valid theme -> HTTP 200", r.status === 200);
    ok("POST returns {theme:'light', saved:true}", r.data && r.data.theme === "light" && r.data.saved === true);

    // Persisted
    r = await j("GET", "/api/ui/theme");
    ok("theme persisted across requests", r.data && r.data.theme === "light");

    // Invalid theme -> 400 with error body
    r = await j("POST", "/api/ui/theme", { theme: "neon" });
    ok("invalid theme -> HTTP 400", r.status === 400);
    ok("invalid theme -> {error}", r.data && typeof r.data.error === "string");
  } catch (e) {
    fail++; console.log("  FAIL- threw: " + e.stack);
  } finally {
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
});
