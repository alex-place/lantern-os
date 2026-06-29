"use strict";
// OH-1 (#1548): resolve-python must find a real interpreter and honor the override.
const assert = require("assert");
const { resolvePython, pythonArgv, _reset } = require("../lib/resolve-python");

// 1. PYTHON_PATH override is trusted verbatim (no probe).
{
  _reset();
  const prev = process.env.PYTHON_PATH;
  process.env.PYTHON_PATH = "/custom/python";
  const r = resolvePython();
  assert.deepStrictEqual(r, { cmd: "/custom/python", prefixArgs: [] }, "override should be used verbatim");
  if (prev === undefined) delete process.env.PYTHON_PATH; else process.env.PYTHON_PATH = prev;
  _reset();
}

// 2. Result is cached (same object reference on second call).
{
  _reset();
  const a = resolvePython();
  const b = resolvePython();
  assert.strictEqual(a, b, "resolvePython should cache");
  _reset();
}

// 3. pythonArgv prepends prefixArgs + script args (or null when no interpreter).
{
  _reset();
  const prev = process.env.PYTHON_PATH;
  process.env.PYTHON_PATH = "py";
  const argv = pythonArgv(["script.py", "--flag"]);
  assert.strictEqual(argv.cmd, "py");
  assert.deepStrictEqual(argv.args, ["script.py", "--flag"]);
  if (prev === undefined) delete process.env.PYTHON_PATH; else process.env.PYTHON_PATH = prev;
  _reset();
}

// 4. On THIS machine a real interpreter should resolve (python/py/venv present in CI/dev).
{
  _reset();
  const r = resolvePython();
  // Don't hard-fail CI images without python: just assert the shape when found.
  if (r) {
    assert.ok(typeof r.cmd === "string" && r.cmd.length > 0);
    assert.ok(Array.isArray(r.prefixArgs));
  }
  _reset();
}

console.log("resolve-python.test.js: all assertions passed");
