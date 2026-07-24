// #1551 — boot health rollup + provider derivation. Pure (probes are live, not here).
//
// Run: node test/health-aggregator.test.js
const assert = require("assert");
const ha = require("../lib/health-aggregator");

let failures = 0;
async function check(name, fn) {
  try { await fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

async function run() {
  await check("all up → overall up", () => {
    const h = ha.assembleHealth([{ name: "web", state: "up", critical: true }, { name: "mcp", state: "up" }]);
    assert.strictEqual(h.overall, "up");
    assert.strictEqual(h.counts.up, 2);
  });

  await check("a non-critical down → degraded (not down)", () => {
    const h = ha.assembleHealth([{ name: "web", state: "up", critical: true }, { name: "mcp", state: "down" }]);
    assert.strictEqual(h.overall, "degraded");
    assert.strictEqual(h.counts.down, 1);
  });

  await check("a critical down → overall down", () => {
    const h = ha.assembleHealth([{ name: "web", state: "down", critical: true }, { name: "mcp", state: "up" }]);
    assert.strictEqual(h.overall, "down");
  });

  await check("disabled subsystems don't degrade overall", () => {
    const h = ha.assembleHealth([{ name: "web", state: "up", critical: true }, { name: "trader", state: "disabled" }]);
    assert.strictEqual(h.overall, "up");
    assert.strictEqual(h.counts.disabled, 1);
  });

  await check("empty → unknown", () => assert.strictEqual(ha.assembleHealth([]).overall, "unknown"));

  await check("providerStates marks configured vs not by env key", () => {
    const ps = ha.providerStates({ ANTHROPIC_API_KEY: "x", GEMINI_API_KEY: "" });
    const map = Object.fromEntries(ps.map((p) => [p.name, p.configured]));
    assert.strictEqual(map.anthropic, true);
    assert.strictEqual(map.gemini, false);     // empty string is not configured
    assert.strictEqual(map.openai, false);     // absent
  });

  // probeAll integration (live ports) — just assert it returns a well-formed report and
  // always includes the critical web subsystem as up.
  await check("probeAll returns a well-formed report with web up", async () => {
    const h = await ha.probeAll({ env: {} });
    assert.ok(["up", "degraded", "down"].includes(h.overall));
    const web = h.subsystems.find((s) => s.name === "web");
    assert.ok(web && web.state === "up" && web.critical === true);
    assert.ok(h.subsystems.some((s) => s.name === "cloud-providers"));
    assert.strictEqual(h.counts.total, h.subsystems.length);
  });

  if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
  process.stdout.write("\nall health-aggregator checks passed\n");
}

run();
