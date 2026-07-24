// #1200 — code-aware retrieval. The legacy scorer only matched filename/path, so a
// task referencing a symbol whose file isn't named for it was missed. These tests
// pin the symbol extraction + symbol-scoring (the code-aware lift) deterministically.
//
// Run: node test/repo-context-symbols.test.js
const assert = require("assert");
const {
  extractSymbols, queryTokens, scoreBySymbols, buildSymbolIndex,
} = require("../lib/repo-context");

let failures = 0;
function check(name, fn) {
  try { fn(); console.error("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

check("extractSymbols finds JS declarations", () => {
  const syms = extractSymbols(`
    function paginate(items, page) { return items; }
    const helper = () => 1;
    class Cursor {}
    exports.renderDeck = renderDeck;
    const obj = { onClick: function () {} };
  `);
  for (const s of ["paginate", "helper", "Cursor", "renderDeck", "onClick"]) {
    assert.ok(syms.has(s), `missing symbol ${s}`);
  }
});

check("extractSymbols finds Python def/class", () => {
  const syms = extractSymbols("class Engine:\n    def converge(self):\n        return 1\n");
  assert.ok(syms.has("Engine") && syms.has("converge"));
});

check("queryTokens pulls identifiers, drops short words", () => {
  const t = queryTokens("Fix the off-by-one in paginate()");
  assert.ok(t.includes("paginate") && t.includes("fix") && t.includes("off"));
  assert.ok(!t.includes("in"), "2-char tokens dropped");
});

check("scoreBySymbols ranks the DEFINING file top, even with an unrelated name", () => {
  const symbolMap = new Map([
    ["apps/lib/deck-utils.js", new Set(["paginate", "shuffle"])], // defines paginate, name unrelated
    ["apps/lib/readme-helpers.js", new Set(["formatDate"])],
    ["docs/paginate-notes.js", new Set(["noteX"])],               // name matches but no symbol
  ]);
  const scores = scoreBySymbols("fix the paginate off-by-one", symbolMap);
  assert.ok((scores.get("apps/lib/deck-utils.js") || 0) >= 40, "exact symbol match wins");
  assert.ok(!scores.has("apps/lib/readme-helpers.js"), "unrelated file not scored");
  // the defining file outranks the name-only file (which symbol-scores 0)
  assert.ok((scores.get("apps/lib/deck-utils.js") || 0) > (scores.get("docs/paginate-notes.js") || 0));
});

check("scoreBySymbols gives partial credit for substring symbol matches", () => {
  const scores = scoreBySymbols("paginate", new Map([["a.js", new Set(["paginateDeck"])]]));
  assert.ok((scores.get("a.js") || 0) >= 10 && (scores.get("a.js") || 0) < 40);
});

check("buildSymbolIndex indexes code files, skips excluded/oversized, caches", () => {
  const files = ["src/a.js", "node_modules/x.js", "docs/readme.md", "src/big.js"];
  const fakeRead = (abs) => {
    if (abs.endsWith("big.js")) return "x".repeat(300_000);     // oversized → skipped
    if (abs.endsWith("a.js")) return "function alpha(){}";
    throw new Error("should not read excluded/non-code");
  };
  const map = buildSymbolIndex(files, fakeRead, 200_000);
  assert.ok(map.has("src/a.js") && map.get("src/a.js").has("alpha"));
  assert.ok(!map.has("node_modules/x.js"), "excluded dir skipped");
  assert.ok(!map.has("docs/readme.md"), "non-code skipped");
  assert.ok(!map.has("src/big.js"), "oversized skipped");
  // cache: a second call with a throwing reader must reuse the cached map (no reads)
  const again = buildSymbolIndex(files, () => { throw new Error("must use cache"); });
  assert.strictEqual(again, map);
});

console.error(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
