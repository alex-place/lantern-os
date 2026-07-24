// convergence_inspect — the assistant's direct, guarded seam onto the
// convergence orchestrator (src/convergence_io_engine.py). Before this tool the
// engine was only reachable via loose subprocess spawns (routes/operator.js), a
// raw-shell debug allowlist, and CI — never a first-class tool. This locks in:
//   - it runs for an operator and returns REAL engine state (not a canned string)
//   - it is operator-gated (guest denied, not advertised) — it exposes internal
//     fleet/orchestrator state
//   - the adapter seam only permits read-only subcommands
//
// Run: node test/convergence-inspect-tool.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, fn) {
  // process.stdout.write (not console.log) so the debug-statement CI gate,
  // which only exempts test paths, doesn't flag this reporter.
  return Promise.resolve()
    .then(fn)
    .then(() => process.stdout.write(`  ok  - ${name}\n`))
    .catch((e) => { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); });
}

process.env.CHAT_TOOL_EXEC = "1";
const toolRunner = require("../lib/tool-runner");
const adapter = require("../lib/convergence-adapter");

(async () => {
  // 1. Adapter seam refuses non-read subcommands (no `loop`/`converge` here).
  await check("runEngineCommand rejects unsupported subcommands", async () => {
    const r = await adapter.runEngineCommand("loop");
    assert.strictEqual(r.error, "unsupported_command");
  });

  // 2. Operator execution returns real engine state.
  await check("operator exec returns live orchestrator state", async () => {
    const r = await toolRunner.runTool("convergence_inspect", {}, { operator: true });
    assert.strictEqual(r.status, "executed", `expected executed, got ${r.status} (${r.reason_code || ""})`);
    assert.ok(/cells:\s*\d+/.test(r.result), "output should report cell count from the engine");
    assert.ok(/target latencies/.test(r.result), "output should include engine target latencies");
  });

  // 3. Guests are denied (internal state — operator only).
  await check("guest exec is denied (operator_required)", async () => {
    const r = await toolRunner.runTool("convergence_inspect", {}, { operator: false });
    assert.strictEqual(r.status, "denied");
    assert.strictEqual(r.reason_code, "operator_required");
  });

  // 4. Not advertised to guests; advertised to operators.
  await check("advertised to operators only", async () => {
    const guest = toolRunner.anthropicTools({ operator: false }).map((t) => t.name);
    const op = toolRunner.anthropicTools({ operator: true }).map((t) => t.name);
    assert.ok(!guest.includes("convergence_inspect"), "must not be advertised to guests");
    assert.ok(op.includes("convergence_inspect"), "must be advertised to operators");
  });

  // 5. Present in the committed golden manifest on both surfaces.
  await check("in golden manifest with dream_chat + mcp availability", async () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(__dirname, "..", "manifests", "tool-capability-manifest-v1.json"), "utf8"));
    const entry = manifest.tools.find((t) => t.name === "convergence_inspect");
    assert.ok(entry, "convergence_inspect missing from golden manifest — run generate-manifest");
    assert.deepStrictEqual(entry.surface_availability, { dream_chat: true, mcp: true });
  });

  if (failures) { process.stderr.write(`\n${failures} check(s) failed\n`); process.exit(1); }
  process.stdout.write("\nconvergence-inspect-tool: all checks passed\n");
})();
