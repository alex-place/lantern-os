"use strict";

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const toolRunner = require(path.join(repoRoot, "apps", "lantern-garage", "lib", "tool-runner"));

function readInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

async function main() {
  const command = process.argv[2] || "manifest";
  const input = readInput();
  const executionEnabled = input.execution_enabled !== undefined
    ? Boolean(input.execution_enabled)
    : process.env.CHAT_TOOL_EXEC === "1";

  if (command === "manifest") {
    process.stdout.write(JSON.stringify(toolRunner.capabilityManifest({ executionEnabled })));
    return;
  }

  if (command === "call") {
    const result = await toolRunner.runTool(input.name, input.arguments || {}, {
      operator: Boolean(input.operator),
      executionEnabled,
    });
    process.stdout.write(JSON.stringify(result));
    return;
  }

  throw new Error(`unknown bridge command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
