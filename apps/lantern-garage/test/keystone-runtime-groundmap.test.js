// #1409 — verifies keystoneRun() actually CONSUMES the repo-map evidence packet (the
// issue's own acceptance criterion), not just that repo-map-grounding.js's helpers work
// in isolation (that's repo-map-grounding.test.js). Uses keystoneRun's existing
// options.tools injection seam — no real filesystem/model/network I/O, and no coverage
// of keystoneRun's pre-existing behavior beyond what this issue touches (that function
// had zero test coverage before this; a full test suite for it is separate, larger work).
const assert = require("assert");
const { keystoneRun } = require("../lib/keystone-runtime");

let failures = 0;
async function check(name, fn) {
  try { await fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.stack || e.message}\n`); }
}

// Canned LLM: first call is the PLAN, second is the initial PATCH. Always returns a
// unified diff that (per the fake applyPatch below) "touches" central.js — the file
// ONLY repo-map's evidence packet surfaced, not the base search — so a passing test
// proves the merged file actually reached the model/patch step, not just the log.
function fakeLlm() {
  let call = 0;
  return async () => {
    call += 1;
    return { content: call === 1 ? "1. Fix the bug in central.js" : "--- a/central.js\n+++ b/central.js\n" };
  };
}

async function run(overrides = {}) {
  return keystoneRun("fix the central thing", "/fake/repo", fakeLlm(), {
    maxFiles: 5,
    maxAttempts: 1,
    tools: {
      searchRepoFiles: async () => [{ path: "existing.js", score: 10 }],
      readFileContent: async (p) => `// contents of ${p}\n`,
      buildRepoMapEvidence: async () => ({
        query: "fix the central thing",
        files: [{ path: "central.js", score: 1.4, relevance: 1, centrality: 0.9,
          matchedTerms: ["central"], symbols: ["centralThing"], reason: "query terms matched" }],
      }),
      validatePatch: async () => ({ valid: true, type: "diff" }),
      applyPatch: async () => ({ success: true, changed: [{ path: "central.js" }], filesChanged: 1 }),
      runVerification: async () => ({ ran: true, success: true, inconclusive: false, output: "ok", command: "test" }),
      ...overrides,
    },
  });
}

(async () => {
  await check("grounding merges repo-map's file even though search alone never found it", async () => {
    const result = await run();
    const ground = result.fullResults.find((r) => r.phase === "ground");
    assert.ok(ground.files.some((f) => f.path === "central.js"),
      "central.js (repo-map-only) should have reached the GROUND phase's file list");
    assert.ok(ground.files.some((f) => f.path === "existing.js"),
      "existing.js (searchRepoFiles) should still be present — additive, not a replacement");
  });

  await check("evidence packet is attached to the ground phase result", async () => {
    const result = await run();
    const ground = result.fullResults.find((r) => r.phase === "ground");
    assert.ok(ground.evidencePacket);
    assert.strictEqual(ground.evidencePacket.files[0].path, "central.js");
  });

  await check("context precision computed against what the patch actually touched", async () => {
    const result = await run();
    // Selected: central.js (from repo-map). Used: central.js (the fake patch touches it).
    // existing.js was selected by search but never repo-map-selected, so it's outside the
    // precision denominator here — precision measures repo-map's OWN selections specifically.
    assert.strictEqual(result.contextPrecision.selected, 1);
    assert.strictEqual(result.contextPrecision.selectedAndUsed, 1);
    assert.strictEqual(result.contextPrecision.selectedAndUnused, 0);
    assert.strictEqual(result.contextPrecision.precision, 1.0);
  });

  await check("a repo-map failure never breaks the kernel run (best-effort)", async () => {
    const result = await run({ buildRepoMapEvidence: async () => { throw new Error("graph build failed"); } });
    assert.strictEqual(result.status, "success");
    const ground = result.fullResults.find((r) => r.phase === "ground");
    assert.ok(ground.files.some((f) => f.path === "existing.js"), "base search still worked");
    assert.strictEqual(ground.evidencePacket, null);
  });

  await check("selected-but-unused is counted honestly when repo-map's pick wasn't the fix", async () => {
    const result = await run({
      buildRepoMapEvidence: async () => ({
        query: "x", files: [{ path: "central.js", score: 1 }, { path: "unused.js", score: 0.5 }],
      }),
      readFileContent: async (p) => `// ${p}\n`,
    });
    assert.strictEqual(result.contextPrecision.selected, 2);
    assert.strictEqual(result.contextPrecision.selectedAndUsed, 1);   // central.js
    assert.strictEqual(result.contextPrecision.selectedAndUnused, 1); // unused.js
    assert.strictEqual(result.contextPrecision.precision, 0.5);
  });

  if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
  process.stdout.write("\nall keystone-runtime groundmap checks passed\n");
})();
