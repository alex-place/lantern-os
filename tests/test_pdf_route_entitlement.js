/**
 * Regression: /api/pdfs DELETE + upload must be gated behind an entitlement (#866).
 * The mutating endpoints used to apply NO auth check, so the research pool could be
 * deleted/poisoned without an entitled session.
 *
 * Run: node tests/test_pdf_route_entitlement.js   (no server; isolated temp cwd)
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// auth-middleware -> user-profiles resolves data/profiles from cwd at require time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-pdf-ent-"));
process.chdir(tmp);

const LIB = path.join(__dirname, "..", "apps", "lantern-garage", "lib");
const profiles = require(path.join(LIB, "user-profiles"));
const { hasEntitlement, requireEntitlement } = require(path.join(LIB, "auth-middleware"));
const pdfRoutes = require(path.join(__dirname, "..", "apps", "lantern-garage", "routes", "pdfs"));

let passed = 0;
function ok(name) { passed++; console.log("  ✓ " + name); }

function fakeRes() {
  return {
    statusCode: null, headers: null, body: "",
    writeHead(code, hdrs) { this.statusCode = code; this.headers = hdrs; },
    end(b) { if (b) this.body += b; },
  };
}
// remote-looking socket → no local-bypass
function req(session, extra = {}) {
  return { session, socket: { localPort: 4177, remoteAddress: "203.0.113.9" }, headers: {}, ...extra };
}
function urlOf(p, q) { return new URL("http://x" + p + (q ? "?" + q : "")); }
const deps = {
  repoRoot: tmp,
  sendJson: (res, obj, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); },
};
const blocked = (code) => code === 302 || code === 403;

(async () => {
  // ── guard decision (mirrors trade-entitlement) ──
  let res = fakeRes();
  assert.strictEqual(requireEntitlement(req(undefined), res, "pdf_admin"), false);
  assert.ok(blocked(res.statusCode), "unauth → 302/403");
  ok("requireEntitlement(pdf_admin) blocks an unauthenticated request");

  profiles.createProfile("pdf-admin", { role: "admin" });
  assert.strictEqual(hasEntitlement(req({ patreon: { id: "pdf-admin", role: "admin" } }), "pdf_admin"), true);
  ok("admin role passes pdf_admin entitlement implicitly");

  // ── route integration: unentitled mutation is blocked ──
  // seed an ingest file that a successful DELETE would remove
  const ingest = path.join(tmp, "data", "ingest");
  fs.mkdirSync(ingest, { recursive: true });
  fs.writeFileSync(path.join(ingest, "secret.pdf"), "%PDF-1.4 dummy");

  res = fakeRes();
  const delReq = req(undefined); delReq.method = "DELETE";
  let handled = await pdfRoutes(delReq, res, urlOf("/api/pdfs", "filename=secret.pdf"), deps);
  assert.strictEqual(handled, true, "DELETE handled");
  assert.ok(blocked(res.statusCode), "unentitled DELETE blocked (302/403)");
  assert.ok(fs.existsSync(path.join(ingest, "secret.pdf")), "file NOT deleted by a blocked request");
  ok("unentitled DELETE /api/pdfs is blocked and deletes nothing");

  res = fakeRes();
  const upReq = req(undefined); upReq.method = "POST"; upReq.headers = { "content-type": "multipart/form-data; boundary=x" };
  handled = await pdfRoutes(upReq, res, urlOf("/api/pdfs/upload"), deps);
  assert.strictEqual(handled, true, "upload handled");
  assert.ok(blocked(res.statusCode), "unentitled upload blocked (302/403) before body parse");
  ok("unentitled POST /api/pdfs/upload is blocked before any body parsing");

  console.log(`\nAll ${passed} pdf-entitlement assertions passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
