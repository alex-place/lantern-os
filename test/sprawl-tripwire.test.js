// #1561 — sprawl tripwire: loop-stage extraction + surface evaluation. Pure.
//
// Run: node test/sprawl-tripwire.test.js
const assert = require("assert");
const { pathToFileURL } = require("url");
const path = require("path");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

(async () => {
  // the tripwire is ESM; import it dynamically
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "sprawl-tripwire.mjs")).href);
  const { extractLoopStage, evaluateSurfaces, isPublicSurface, VALID_STAGES } = mod;

  check("extractLoopStage reads a meta tag", () =>
    assert.strictEqual(extractLoopStage('<head><meta name="loop-stage" content="verify"></head>'), "verify"));

  check("extractLoopStage reads an HTML comment", () =>
    assert.strictEqual(extractLoopStage("<!-- loop-stage: remember -->"), "remember"));

  check("extractLoopStage rejects an invalid / missing stage", () => {
    assert.strictEqual(extractLoopStage('<meta name="loop-stage" content="banana">'), null);
    assert.strictEqual(extractLoopStage("<html>no marker here</html>"), null);
    assert.strictEqual(extractLoopStage(""), null);
  });

  check("VALID_STAGES is the six-stage loop", () =>
    assert.deepStrictEqual(VALID_STAGES, ["observe", "remember", "reason", "act", "verify", "converge"]));

  check("isPublicSurface matches public *.html, skips partials/components and non-public", () => {
    assert.ok(isPublicSurface("public/jobs.html"));
    assert.ok(!isPublicSurface("public/partials/nav.html"));
    assert.ok(!isPublicSurface("lib/foo.js"));
    assert.ok(!isPublicSurface("docs/readme.md"));
  });

  check("evaluateSurfaces: a justified page passes", () => {
    const r = evaluateSurfaces([{ path: "p/a.html", content: '<meta name="loop-stage" content="act">' }]);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.justified[0].stage, "act");
  });

  check("evaluateSurfaces: an unjustified new page FAILS the check (the acceptance)", () => {
    const r = evaluateSurfaces([
      { path: "p/ok.html", content: "<!-- loop-stage: observe -->" },
      { path: "p/bad.html", content: "<html><body>new surface, no justification</body></html>" },
    ]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.violations.length, 1);
    assert.strictEqual(r.violations[0].path, "p/bad.html");
  });

  check("evaluateSurfaces: empty set passes", () =>
    assert.strictEqual(evaluateSurfaces([]).ok, true));

  if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
  process.stdout.write("\nall sprawl-tripwire checks passed\n");
})();
