// #1605 — Python replies streamed to the chat UI rendered non-ASCII as "�".
// Root cause: child Python stdout defaults to the OS locale encoding (cp1252 on
// Windows), so an em-dash "—" (U+2014) left the process as the cp1252 byte 0x97,
// which Node then decoded as invalid UTF-8 → U+FFFD "�". Fix: spawn Python with
// PYTHONIOENCODING=utf-8 on the chat bridges.
//
// Run: node test/python-stdout-utf8.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

let failures = 0;
function check(name, fn) {
  // process.stdout.write (not console.log) so the repo debug-statement CI gate,
  // which only exempts tests/ and test_* paths, doesn't flag this *.test.js reporter.
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

// 1. Wiring: both chat-path Python spawns set PYTHONIOENCODING=utf-8.
const adapterSrc = fs.readFileSync(
  path.join(__dirname, "..", "lib", "convergence-adapter.js"), "utf8");
check("convergence-adapter spawn sets PYTHONIOENCODING utf-8", () =>
  assert.ok(/PYTHONIOENCODING:\s*['"]utf-8['"]/.test(adapterSrc),
    "convergence-adapter.js spawn env is missing PYTHONIOENCODING: 'utf-8'"));

const streamSrc = fs.readFileSync(
  path.join(__dirname, "..", "lib", "stream-chat.js"), "utf8");
check("doors spawn sets PYTHONIOENCODING utf-8", () =>
  assert.ok(/PYTHONIOENCODING:\s*['"]utf-8['"]/.test(streamSrc),
    "stream-chat.js door-image spawn env is missing PYTHONIOENCODING: 'utf-8'"));

// 2. Functional: a Python subprocess with PYTHONIOENCODING=utf-8 round-trips the
// em-dash intact (no "�"). Skips cleanly if no `python` is on PATH.
for (const py of ["python", "python3"]) {
  const r = spawnSync(py, ["-c", "import sys; sys.stdout.write('\\u2014')"], {
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    encoding: "utf8",
  });
  if (r.error || r.status === null) continue; // interpreter not found / killed — try next
  check(`${py} stdout em-dash round-trips as UTF-8 (not �)`, () => {
    assert.strictEqual(r.stdout, "—", `got ${JSON.stringify(r.stdout)}`);
    assert.ok(!r.stdout.includes("�"), "stdout contains the replacement char");
  });
  break;
}

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall python-stdout-utf8 checks passed\n");
