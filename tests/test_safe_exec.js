/**
 * safe-exec + allowlist tests — command-injection prevention (#873).
 *
 * Proves the two defense layers:
 *   1. the test allowlist (isAllowedTest) rejects injection-shaped commands;
 *   2. tokenizeCommand rejects shell metacharacters, and safeExec runs argv
 *      with no shell so a metachar that somehow slips through is inert.
 */

const assert = require("assert");
const { tokenizeCommand, safeExec } = require("../apps/lantern-garage/lib/safe-exec");
const { isAllowedTest } = require("../apps/lantern-garage/lib/self-edit-engine");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log("\nsafe-exec / command-injection tests\n");

// ── tokenizeCommand: clean commands ──────────────────────────────────────
console.log("tokenizeCommand — valid");
test("splits a plain command", () => {
  assert.deepStrictEqual(tokenizeCommand("node tests/test_dream_journal_api.js"),
    ["node", "tests/test_dream_journal_api.js"]);
});
test("keeps a double-quoted span as one token (with spaces)", () => {
  assert.deepStrictEqual(tokenizeCommand('git commit -m "fix the thing"'),
    ["git", "commit", "-m", "fix the thing"]);
});
test("allows : / . - in tokens (refs, paths, flags)", () => {
  assert.deepStrictEqual(tokenizeCommand("git push origin HEAD:auto/fix-1"),
    ["git", "push", "origin", "HEAD:auto/fix-1"]);
});

// ── tokenizeCommand: injection rejection ─────────────────────────────────
console.log("tokenizeCommand — rejects shell metacharacters");
for (const evil of [
  "npm test; rm -rf /",
  "python -m pytest tests/x.py | cat /etc/passwd",
  'git commit -m "$(whoami)"',          // command substitution (the gitCommit hole)
  "git commit -m `id`",                 // backtick substitution
  "node x.js && curl evil.com",
  "cat x.json > /tmp/out",
  "npm run $(echo build)",
]) {
  test(`rejects: ${evil}`, () => {
    assert.throws(() => tokenizeCommand(evil), /shell_metacharacter_in_token|unbalanced_quotes/);
  });
}
test("rejects unbalanced quotes", () => {
  assert.throws(() => tokenizeCommand('git commit -m "oops'), /unbalanced_quotes/);
});

// ── isAllowedTest: tightened allowlist ───────────────────────────────────
console.log("isAllowedTest — allowlist");
test("allows legitimate test commands", () => {
  assert.strictEqual(isAllowedTest("node tests/test_dream_journal_api.js"), true);
  assert.strictEqual(isAllowedTest("python -m pytest tests/test_foo.py"), true);
  assert.strictEqual(isAllowedTest("python -m pytest tests/sub/test_bar.py"), true);
  assert.strictEqual(isAllowedTest("npm test"), true);
});
test("rejects the #873 wildcard-injection that used to slip through", () => {
  // Old pattern /pytest tests\/(.+)\.py/ matched this; the tightened one does not.
  assert.strictEqual(isAllowedTest("python -m pytest tests/x.py; rm -rf /"), false);
  assert.strictEqual(isAllowedTest("python -m pytest tests/x.py && curl evil.com"), false);
  assert.strictEqual(isAllowedTest("node tests/x.js; rm -rf /"), false);
});

// ── safeExec: no shell ───────────────────────────────────────────────────
console.log("safeExec — runs without a shell");
test("runs a real binary and returns stdout", () => {
  const out = safeExec(["node", "--version"], { timeout: 10000 });
  assert.ok(/^v\d+\./.test(out.trim()), `expected a node version, got: ${out}`);
});
test("passes metacharacter-bearing ARGS literally (no shell expansion)", () => {
  // If a shell ran, the `;`/`&`/`|` would split commands; here they're inert args.
  const out = safeExec(["node", "-e", "process.stdout.write(process.argv.slice(1).join('~'))",
                        "a;rm", "b&c", "d|e"], { timeout: 10000 });
  assert.strictEqual(out, "a;rm~b&c~d|e");
});
test("throws on empty argv", () => {
  assert.throws(() => safeExec([]), /empty_command/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
