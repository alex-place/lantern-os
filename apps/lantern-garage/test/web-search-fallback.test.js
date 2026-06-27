// Regression: keyless web-search fallbacks (DuckDuckGo + Wikipedia) must turn a
// non-2xx response into a clean, honest error — NEVER crash JSON.parse with a
// cryptic "Unexpected token". Wikipedia rate-limits with HTTP 429 and a text/plain
// body ("You are making too many requests to the API."); blindly parsing that as
// JSON produced `wiki parse error: Unexpected token 'Y', "You are ma"...` in chat,
// which is useless to both the user and the model. The guard intercepts non-2xx
// before parse; 2xx-but-non-JSON is handled by the parse-catch with a body snippet.
//
// Run: node apps/lantern-garage/test/web-search-fallback.test.js
const assert = require("assert");
const { _httpFallbackError } = require("../lib/web-search-client");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const mk = (statusCode, headers = {}) => ({ statusCode, headers });
const BODY_429 = "You are making too many requests to the API.\nPlease follow the best practices...";

check("2xx returns null (response is parseable)", () => {
  assert.strictEqual(_httpFallbackError("wiki", mk(200), '{"query":{}}'), null);
  assert.strictEqual(_httpFallbackError("direct", mk(202), "<html>challenge</html>"), null);
});

check("429 -> clean rate-limited error with Retry-After", () => {
  assert.strictEqual(
    _httpFallbackError("wiki", mk(429, { "retry-after": "5" }), BODY_429),
    "wiki rate-limited (HTTP 429, retry-after 5s)"
  );
});

check("429 without Retry-After header", () => {
  assert.strictEqual(_httpFallbackError("direct", mk(429), BODY_429), "direct rate-limited (HTTP 429)");
});

check("other non-2xx -> HTTP <code> + body snippet", () => {
  assert.strictEqual(
    _httpFallbackError("wiki", mk(500), "Internal Server Error happened here"),
    "wiki HTTP 500 — Internal Server Error happened here"
  );
});

check("the actual 429 body never leaks a JSON.parse crash", () => {
  const err = _httpFallbackError("wiki", mk(429), BODY_429) || "";
  assert.ok(!/Unexpected token|is not valid JSON/.test(err), `leaked parse crash: ${err}`);
  // And prove the body WOULD have crashed a naive JSON.parse:
  assert.throws(() => JSON.parse(BODY_429), /Unexpected token/);
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll web-search fallback checks passed.");
