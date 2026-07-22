// #2762: a plan with zero tests left the Verify stage empty — the first end-to-end
// autowork run shipped `verified: false` because nothing was specified. The verify
// floor derives deterministic verification commands from the files a patch actually
// changed, and every emitted command must already pass the runTests allowlist
// (closed character classes, #873) or the floor silently verifies nothing.
//
// Run: node apps/lantern-garage/test/verify-floor.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { deriveVerifyFloor, isAllowedTest } = require(path.join(__dirname, "..", "lib", "self-edit-engine"));

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write("  ok  - " + name + "\n"); }
  catch (e) { failures++; process.stdout.write("  FAIL- " + name + "\n        " + e.message + "\n"); }
}

// A fake repo root with the shapes the floor probes for.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-verify-floor-"));
fs.mkdirSync(path.join(root, "tests"), { recursive: true });
fs.mkdirSync(path.join(root, "apps", "lantern-garage", "test"), { recursive: true });
fs.mkdirSync(path.join(root, "apps", "lantern-garage", "lib"), { recursive: true });
fs.mkdirSync(path.join(root, "src", "mcp_server"), { recursive: true });
fs.writeFileSync(path.join(root, "tests", "test_github_tools.py"), "def test_ok():\n    assert True\n");
fs.writeFileSync(path.join(root, "apps", "lantern-garage", "test", "alpaca-adapter.test.js"), "process.exit(0);\n");

check("python file → py_compile + its real pytest file", () => {
  const cmds = deriveVerifyFloor(root, ["src/mcp_server/github_tools.py"]);
  assert.deepStrictEqual(cmds, [
    "python -m py_compile src/mcp_server/github_tools.py",
    "python -m pytest tests/test_github_tools.py",
  ]);
});

check("python file with no matching test → syntax check only", () => {
  const cmds = deriveVerifyFloor(root, ["src/mcp_server/other_tools.py"]);
  assert.deepStrictEqual(cmds, ["python -m py_compile src/mcp_server/other_tools.py"]);
});

check("js file → node --check + its real standalone unit test", () => {
  const cmds = deriveVerifyFloor(root, ["apps/lantern-garage/lib/alpaca-adapter.js"]);
  assert.deepStrictEqual(cmds, [
    "node --check apps/lantern-garage/lib/alpaca-adapter.js",
    "node apps/lantern-garage/test/alpaca-adapter.test.js",
  ]);
});

check("non-code files contribute nothing", () => {
  assert.deepStrictEqual(deriveVerifyFloor(root, ["docs/README.md", "public/work.html"]), []);
});

check("unsafe path characters are skipped, not sanitized", () => {
  assert.deepStrictEqual(deriveVerifyFloor(root, ["lib/evil;rm -rf.py", "lib/$(x).js"]), []);
});

check("windows separators are normalized", () => {
  const cmds = deriveVerifyFloor(root, ["src\\mcp_server\\github_tools.py"]);
  assert.strictEqual(cmds[0], "python -m py_compile src/mcp_server/github_tools.py");
});

check("duplicates collapse", () => {
  const cmds = deriveVerifyFloor(root, ["a.py", "a.py"]);
  assert.deepStrictEqual(cmds, ["python -m py_compile a.py"]);
});

check("every emitted command passes the runTests allowlist verbatim", () => {
  const cmds = deriveVerifyFloor(root, [
    "src/mcp_server/github_tools.py",
    "apps/lantern-garage/lib/alpaca-adapter.js",
    "apps/lantern-garage/routes/trading.js",
  ]);
  assert.ok(cmds.length >= 3);
  for (const c of cmds) assert.ok(isAllowedTest(c), "not allowlisted: " + c);
});

process.exit(failures ? 1 : 0);
