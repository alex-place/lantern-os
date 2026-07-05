"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const path = require("path");
const toolRunner = require("../apps/lantern-garage/lib/tool-runner");
const dreamRoutes = require("../apps/lantern-garage/routes/dream");

const repoRoot = path.resolve(__dirname, "..");

function bridge(command, payload) {
  const result = spawnSync(process.execPath, ["scripts/tool-runner-bridge.js", command], {
    cwd: repoRoot,
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function main() {
  const direct = toolRunner.capabilityManifest({ executionEnabled: true });
  const bridged = bridge("manifest", { execution_enabled: true });
  const generated = JSON.parse(require("fs").readFileSync(
    path.join(repoRoot, "manifests", "tool-capability-manifest-v1.json"),
    "utf8"
  ));
  assert.deepStrictEqual(bridged, direct);
  assert.deepStrictEqual(generated, toolRunner.capabilityManifest({ executionEnabled: false }));
  assert.strictEqual(direct.schema_version, 1);
  // The committed golden manifest is the single source of truth for the tool surface
  // (regenerate with `node scripts/tool-runner-bridge.js generate-manifest` after any
  // registry change). Assert the live surface matches it by name instead of a
  // hand-maintained literal that silently drifts every time a tool is added.
  assert.deepStrictEqual(
    direct.tools.map((tool) => tool.name),
    generated.tools.map((tool) => tool.name),
    "tool surface drifted from the golden manifest — run `node scripts/tool-runner-bridge.js generate-manifest`"
  );
  for (const tool of direct.tools) {
    assert.strictEqual(tool.surface_availability.dream_chat, true);
    assert.strictEqual(tool.surface_availability.mcp, true);
    assert.strictEqual(tool.operator_required, tool.policy !== "read");
  }

  let routePayload = null;
  const handled = await dreamRoutes(
    { method: "GET" },
    {},
    { pathname: "/api/dream/tools", searchParams: new URLSearchParams() },
    {
      sendJson(_res, payload) { routePayload = payload; },
    }
  );
  assert.strictEqual(handled, true);
  assert.deepStrictEqual(routePayload, toolRunner.capabilityManifest());

  // Read is operator-gated since the #1213 guest-safe hardening (guests get web-only
  // tools), so the execute-path assertions must run as operator — otherwise the call is
  // denied (operator_required) before the behavior under test is reached.
  const read = await toolRunner.runTool("Read", { file_path: "package.json", limit: 2 }, {
    executionEnabled: true,
    operator: true,
  });
  assert.strictEqual(read.status, "executed");
  assert.strictEqual(read.receipt.schema_version, 1);

  const denied = await toolRunner.runTool("Write", {
    file_path: "never-written.txt",
    content: "blocked",
  }, { executionEnabled: true, operator: false });
  assert.strictEqual(denied.status, "denied");
  assert.strictEqual(denied.reason_code, "operator_required");

  const unsafePath = await toolRunner.runTool("Read", { file_path: "../package.json" }, {
    executionEnabled: true,
    operator: true,
  });
  assert.strictEqual(unsafePath.status, "blocked");
  assert.strictEqual(unsafePath.reason_code, "unsafe_path");

  const disallowed = await toolRunner.runTool("Bash", { command: "rm -rf ." }, {
    executionEnabled: true,
    operator: true,
  });
  assert.strictEqual(disallowed.status, "blocked");
  assert.strictEqual(disallowed.reason_code, "command_not_allowlisted");

  const privateFetch = await toolRunner.runTool("web_fetch", { url: "http://127.0.0.1:4177/private" }, {
    executionEnabled: true,
  });
  assert.strictEqual(privateFetch.status, "blocked");
  assert.strictEqual(privateFetch.reason_code, "private_host_blocked");

  const disabled = await toolRunner.runTool("Read", { file_path: "package.json" }, {
    executionEnabled: false,
  });
  assert.strictEqual(disabled.status, "unavailable");
  assert.strictEqual(disabled.reason_code, "chat_tool_exec_disabled");

}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
  process.exitCode = 1;
});
