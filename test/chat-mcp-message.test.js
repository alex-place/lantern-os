// chat-mcp-message.test.js — #1927: the MCP-offline message must not tell an
// end user to run a repo command. Neither the model-context injection
// (lib/keystone-context.js) nor the system_status tool (lib/tool-runner.js) may
// surface "python src/mcp_server/server.py" as a remedy to a unisona.ai user.
// Run: node test/chat-mcp-message.test.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log("  ok  -", name))
    .catch((e) => { failures++; console.error("  FAIL-", name, "\n      ", e.message); });
}

const REPO_CMD = /python\s+src[\\/]mcp_server[\\/]server\.py/;

(async () => {
  // 1) system_status tool — DOWN branch must not carry the repo command.
  await check("system_status reports MCP status without a 'run python …' remedy", async () => {
    const { REGISTRY } = require("../lib/tool-runner");
    const res = await REGISTRY.system_status.run();
    const text = typeof res === "string" ? res : JSON.stringify(res);
    assert.ok(!REPO_CMD.test(text), "system_status must not tell the user to run python src/mcp_server/server.py");
    assert.ok(/127\.0\.0\.1:8771/.test(text), "system_status should still name the MCP endpoint");
  });

  // 2) The model-context injection (keystone-context.js) — the offline branch is
  // gated on live gh + MCP state, so guard the source: the repo-command remedy
  // must not exist as a string the model can be handed and parrot back (#1927,
  // the injected-context antipattern).
  await check("keystone-context injects no terminal-command remedy for MCP offline", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "keystone-context.js"), "utf8");
    assert.ok(!REPO_CMD.test(src), "keystone-context.js must not inject 'python src/mcp_server/server.py' into model context");
    assert.ok(/MCP project tools are temporarily unavailable/.test(src), "expected the user-appropriate offline wording");
  });

  if (failures) {
    console.error(`\nchat-mcp-message: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nchat-mcp-message: all checks passed");
})();
