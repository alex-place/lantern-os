// #2741 — the autowork research evidence (web + arXiv) must render into the code
// GENERATION prompt, not just Verify. It used to be passed as generatePlan's `history`
// param and rendered as `undefined: undefined`. renderResearchContext is the pure core
// that fixes that; locked down here.
//
// Run: node test/research-context-render.test.js
const assert = require("assert");
const { renderResearchContext } = require("../lib/self-edit-engine");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

const research = {
  keywords: ["retriever", "rerank"],
  webEvidence: [
    { title: "Hybrid retrieval survey", url: "https://ex.com/a", snippet: "Reranking lifts recall@5 substantially." },
    { title: "BM25 vs dense", url: "https://ex.com/b", snippet: "Fusion beats either alone." },
  ],
  arxivEvidence: [
    { title: "ColBERT late interaction", id: "2004.12832", snippet: "Token-level MaxSim scoring." },
  ],
  webSummary: "Reranking + fusion is the standard recipe.",
};

check("renders web evidence titles, urls, snippets", () => {
  const out = renderResearchContext(research);
  assert.match(out, /Web evidence:/);
  assert.match(out, /Hybrid retrieval survey/);
  assert.match(out, /https:\/\/ex\.com\/a/);
  assert.match(out, /Reranking lifts recall@5/);
});
check("renders arXiv evidence with id", () => {
  const out = renderResearchContext(research);
  assert.match(out, /arXiv corpus evidence:/);
  assert.match(out, /ColBERT late interaction \[2004\.12832\]/);
});
check("renders the web summary", () => {
  assert.match(renderResearchContext(research), /Web summary: Reranking \+ fusion/);
});
check("leads with a grounding instruction", () => {
  assert.match(renderResearchContext(research), /Research grounding[\s\S]*prefer it over guesses/);
});
check("never emits the old undefined:undefined bug", () => {
  assert.doesNotMatch(renderResearchContext(research), /undefined: undefined/);
});
check("null / undefined → empty string", () => {
  assert.strictEqual(renderResearchContext(null), "");
  assert.strictEqual(renderResearchContext(undefined), "");
});
check("object with no evidence → empty string", () => {
  assert.strictEqual(renderResearchContext({ keywords: ["x"], timestamp: "t" }), "");
});
check("web-only research still renders", () => {
  const out = renderResearchContext({ webEvidence: [{ title: "T", url: "u", snippet: "s" }] });
  assert.match(out, /Web evidence:/);
  assert.doesNotMatch(out, /arXiv/);
});
check("tolerates malformed evidence entries", () => {
  const out = renderResearchContext({ webEvidence: [null, { snippet: "only snippet" }], arxivEvidence: [{ id: "1" }] });
  assert.match(out, /only snippet/);
  assert.ok(typeof out === "string");
});
check("clips very long snippets", () => {
  const long = "x".repeat(2000);
  const out = renderResearchContext({ webEvidence: [{ title: "T", snippet: long }] });
  // 400-char snippet cap → the rendered line is far shorter than the raw 2000.
  assert.ok(out.length < 900, `expected clipped output, got ${out.length}`);
});

process.stdout.write(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
