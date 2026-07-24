// #2811: the docs-drift gate must fail when a canonical entry doc references a public
// surface that was removed or renamed (now only a redirect stub), and must NOT fire on
// live pages, external URLs, or explicitly-marked legacy notes.
//
// Two guarantees:
//   1. Fixture behaviour — feed the scanner synthetic docs against a synthetic public/
//      dir and assert the exact drift set (missing surface + stub surface flagged;
//      live page, legacy-marked ref, and external URL all clean).
//   2. Repo currently clean — run the real gate over the four canonical docs and assert
//      zero drift, so the eleven-reference (#2751) incident class can't recur silently
//      AND the legacy-marked dream-chat.html notes are correctly exempted.
//
// ESM interop: check-docs-drift.mjs is an ES module, so it is loaded with dynamic
// import() from this CommonJS test. Dependency-free (no server, no node_modules) — safe
// in a bare worktree.
//
// Run: node test/docs-drift-gate.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log("  ok  -", name))
    .catch((e) => { failures++; console.error("  FAIL-", name, "\n      ", e.message); });
}

const REAL_STUB =
  '<!doctype html>\n<meta http-equiv="refresh" content="0; url=/chat.html">\n' +
  '<script>location.replace("/chat.html");</script>\n';
const REAL_PAGE = "<!doctype html>\n<title>Trader</title>\n" + "x".repeat(4000) + "\n";

(async () => {
  const mod = await import(
    pathToFileURL(path.resolve(__dirname, "../scripts/check-docs-drift.mjs")).href);
  const { scanDocs } = mod;

  // ── 1. Fixture behaviour ────────────────────────────────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docs-drift-"));
  const pub = path.join(tmp, "public");
  fs.mkdirSync(pub);
  fs.writeFileSync(path.join(pub, "chat.html"), REAL_PAGE);            // live page
  fs.writeFileSync(path.join(pub, "dream-chat.html"), REAL_STUB);      // redirect stub
  // trader-dashboard.html intentionally absent → "missing"

  const doc = [
    "| Chat | `/chat.html` | live |",                                  // clean (page)
    "| Trader | `/trader-dashboard.html` | dead link |",               // DRIFT: missing
    "Open `/dream-chat.html` to chat.",                                 // DRIFT: stub, unmarked
    "The legacy `/dream-chat.html` redirects to /chat.html.",          // clean (legacy marker)
    "See the report at https://example.com/results.html for details.", // clean (external URL)
  ].join("\n");
  fs.writeFileSync(path.join(tmp, "GUIDE.md"), doc);

  const findings = scanDocs({ repoRoot: tmp, publicDir: pub, docs: ["GUIDE.md"] });

  await check("flags the removed surface (missing)", () => {
    const f = findings.find((x) => x.surface === "trader-dashboard.html");
    assert.ok(f, "trader-dashboard.html not flagged");
    assert.strictEqual(f.reason, "missing");
    assert.strictEqual(f.line, 2);
  });
  await check("flags the renamed surface (redirect stub)", () => {
    const f = findings.find((x) => x.surface === "dream-chat.html" && x.reason === "stub");
    assert.ok(f, "unmarked dream-chat.html stub ref not flagged");
    assert.strictEqual(f.line, 3);
  });
  await check("exempts the legacy-marked reference", () => {
    const onLine4 = findings.find((x) => x.line === 4);
    assert.ok(!onLine4, "legacy-marked line 4 should be exempt");
  });
  await check("ignores live pages and external URLs", () => {
    assert.ok(!findings.find((x) => x.surface === "chat.html"), "live chat.html must not flag");
    assert.ok(!findings.find((x) => x.surface === "results.html"), "external URL must not flag");
  });
  await check("exactly two findings for the fixture", () => {
    assert.strictEqual(findings.length, 2, `got ${findings.length}: ${JSON.stringify(findings)}`);
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  // ── 2. Repo currently clean ─────────────────────────────────────────────────
  await check("the four canonical docs are drift-free in this repo", () => {
    const repoRoot = path.resolve(__dirname, "..");
    const real = scanDocs({ repoRoot });
    assert.strictEqual(real.length, 0,
      "canonical docs reference a dead surface:\n" +
      real.map((f) => `  ${f.doc}:${f.line} ${f.ref} (${f.reason})`).join("\n"));
  });

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nall docs-drift gate checks passed");
})();
