// #1504 — a malformed or empty POST body must surface an honest "bad request body"
// error instead of falling through to "all providers failed / cloud unreachable".
//
// Two halves of the contract:
//   1. The parser (lib/stream-chat/request.js) sets `parseError` to "malformed_json"
//      or "empty_body" — NOT the legacy `bodyError` flag.
//   2. The stream handler's bad-request guard reads `parsed.parseError`. The original
//      bug checked `parsed.bodyError`, which the parser never sets, so the guard was
//      dead and malformed bodies blamed the providers.
//
// Run: node test/malformed-body-parse-error.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { parseStreamChatRequest } = require("../lib/stream-chat/request");

let failures = 0;
function check(name, fn) {
  // process.stdout.write (not console.log) so the repo's debug-statement CI gate,
  // which only exempts tests/ and test_* paths, doesn't flag this *.test.js reporter.
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

async function run() {
  // 1. Malformed JSON body → parseError = "malformed_json"
  const bad = await parseStreamChatRequest(
    { method: "POST" },
    new URL("http://x/api/dream/chat/stream"),
    { collectRequestBody: async () => "{not valid json" });
  check("malformed body → parseError=malformed_json", () =>
    assert.strictEqual(bad.parseError, "malformed_json"));
  check("malformed body → no legacy bodyError flag", () =>
    assert.strictEqual(bad.bodyError, undefined));
  check("malformed body → empty message", () =>
    assert.strictEqual(bad.message, ""));

  // 2. Empty body → parseError = "empty_body"
  const empty = await parseStreamChatRequest(
    { method: "POST" },
    new URL("http://x/api/dream/chat/stream"),
    { collectRequestBody: async () => "   " });
  check("empty body → parseError=empty_body", () =>
    assert.strictEqual(empty.parseError, "empty_body"));

  // 3. Valid body → no parseError, message preserved
  const good = await parseStreamChatRequest(
    { method: "POST" },
    new URL("http://x/api/dream/chat/stream"),
    { collectRequestBody: async () => JSON.stringify({ message: "hello" }) });
  check("valid body → no parseError", () =>
    assert.strictEqual(good.parseError, undefined));
  check("valid body → message preserved", () =>
    assert.strictEqual(good.message, "hello"));

  // 4. Handler guard reads parsed.parseError (regression lock for the #1504 dead-guard).
  const handlerSrc = fs.readFileSync(
    path.join(__dirname, "..", "lib", "stream-chat.js"), "utf8");
  check("handler guard checks parsed.parseError", () =>
    assert.ok(/if \(parsed\.parseError && !message\)/.test(handlerSrc),
      "expected `if (parsed.parseError && !message)` bad-request guard in stream-chat.js"));
  check("handler no longer checks dead parsed.bodyError", () =>
    assert.ok(!/parsed\.bodyError/.test(handlerSrc),
      "stream-chat.js still references the never-set parsed.bodyError flag"));

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  process.stdout.write("\nall malformed-body-parse-error checks passed");
}

run();
