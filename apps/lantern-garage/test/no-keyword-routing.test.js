// Σ₀ contract — the chat surface routes capabilities through the model's native tool
// calls, NOT deterministic keyword/regex intercepts. This test locks that in:
//   1. the deleted keyword routers are gone and not re-imported by the chat path,
//   2. the model-based Ouro router is KEPT (that's legitimate model separation),
//   3. no pre-LLM message intercepts remain in the chat UI,
//   4. the enforcement guard flags a keyword classifier but allows the model one,
//   5. the image capability survived as a native tool (generate_image).
//
// Run: node apps/lantern-garage/test/no-keyword-routing.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const LIB = path.resolve(__dirname, "../lib");
const PUBLIC = path.resolve(__dirname, "../public");
const readOrEmpty = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

console.log("\nNo-keyword-intent-routing contract\n");

check("deleted keyword routers no longer exist", () => {
  for (const rel of ["intent-router.js", "task-detector.js", "convergance-os/model-router.js"]) {
    assert.ok(!fs.existsSync(path.join(LIB, rel)), `${rel} should have been deleted`);
  }
});

check("stream-chat.js does not import the keyword routers", () => {
  const src = readOrEmpty(path.join(LIB, "stream-chat.js"));
  assert.ok(!/require\(["'][^"']*intent-router["']\)/.test(src), "must not require intent-router");
  assert.ok(!/require\(["'][^"']*convergance-os\/model-router["']\)/.test(src), "must not require model-router");
  assert.ok(!/require\(["'][^"']*task-detector["']\)/.test(src), "must not require task-detector");
  assert.ok(!/\bclassifyIntent(?!Ouro)\w*\s*\(/.test(src), "must not call keyword classifyIntent(");
});

check("stream-chat.js KEEPS the model-based Ouro router (model separation)", () => {
  const src = readOrEmpty(path.join(LIB, "stream-chat.js"));
  assert.ok(/require\(["']\.\/ouro-router["']\)/.test(src), "ouro-router (model-based) must remain imported");
  assert.ok(/classifyIntentOuro\s*\(/.test(src), "the model router must still be called");
});

check("dream-chat.js does not import task-detector (keyword)", () => {
  const src = readOrEmpty(path.join(LIB, "dream-chat.js"));
  assert.ok(!/require\(["'][^"']*task-detector["']\)/.test(src), "must not require task-detector");
});

check("dream-chat-ui.js has no pre-LLM message intercepts", () => {
  const src = readOrEmpty(path.join(PUBLIC, "js/dream-chat-ui.js"));
  assert.ok(!/function\s+(?:parse\w*Request|detectEmbed\w*|detect\w*Intent)\s*\(/.test(src),
    "no parse*Request / detect*Intent / detectEmbed* intercept functions");
});

check("generate_image capability survived as a native tool", () => {
  const tr = require("../lib/tool-runner");
  const manifest = tr.capabilityManifest ? JSON.stringify(tr.capabilityManifest({ executionEnabled: true })) : "";
  assert.ok(manifest.includes("generate_image"), "generate_image must be an advertised tool");
});

// The guard is ESM (.mjs) — dynamic-import it for the logic assertions.
(async () => {
  await new Promise((r) => setTimeout(r, 0));
  try {
    const guard = await import(pathToFileURL(path.resolve(__dirname, "../../../scripts/no-keyword-intent-routing.mjs")).href);
    check("guard flags a keyword classifier but allows the model router", () => {
      const r = guard.evaluateAddedLines([
        { file: "apps/lantern-garage/lib/x.js", line: 1, text: "const r = classifyIntent(message);" },
        { file: "apps/lantern-garage/lib/x.js", line: 2, text: "ouroRoute = await classifyIntentOuro(message);" },
      ]);
      assert.strictEqual(r.violations.length, 1, "exactly the keyword classifier is flagged");
      assert.strictEqual(r.violations[0].rule, "classify-intent-call");
    });
  } catch (e) {
    failures++;
    console.error("  FAIL- guard import/logic\n      ", e.message);
  }

  console.log(`\n${failures ? "FAILED " + failures : "All passed"}\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
