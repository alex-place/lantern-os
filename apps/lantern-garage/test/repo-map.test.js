// #1409 — local repo-map: symbol extraction, dependency graph, PageRank, query ranking,
// evidence packet. Builds a synthetic mini-repo in a temp dir for deterministic graph tests.
//
// Run: node apps/lantern-garage/test/repo-map.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const rm = require("../lib/repo-map");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.stack || e.message}\n`); }
}

check("extractSymbols finds function/const-arrow/class declarations", () => {
  const src = `
function processOrder(x) { return x; }
async function fetchUser(id) {}
const calculateTotal = (items) => items.length;
const helper = async (x) => x;
class PaymentProcessor {}
`;
  const names = rm.extractSymbols(src).map((s) => s.name);
  assert.ok(names.includes("processOrder"));
  assert.ok(names.includes("fetchUser"));
  assert.ok(names.includes("calculateTotal"));
  assert.ok(names.includes("helper"));
  assert.ok(names.includes("PaymentProcessor"));
});

check("extractRequires finds only relative requires (not bare package names)", () => {
  const src = `
const fs = require("fs");
const { foo } = require("./foo-lib");
const bar = require("../lib/bar");
const pkg = require("some-npm-package");
`;
  const reqs = rm.extractRequires(src);
  assert.deepStrictEqual(reqs, ["./foo-lib", "../lib/bar"]);
});

check("queryTerms tokenizes, lowercases, drops stopwords and 1-char tokens", () => {
  const t = rm.queryTerms("Fix the Payment Processor for orders");
  assert.ok(t.has("fix") && t.has("payment") && t.has("processor") && t.has("orders"));
  assert.ok(!t.has("the") && !t.has("for"));
});

// ---- synthetic mini-repo for graph/ranking tests ----
function makeMiniRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-map-test-"));
  // hub.js: required by three other files -> should rank highest by centrality.
  fs.writeFileSync(path.join(root, "hub.js"), `
function sharedUtility(x) { return x * 2; }
module.exports = { sharedUtility };
`);
  fs.writeFileSync(path.join(root, "a.js"), `
const { sharedUtility } = require("./hub");
function processPayment(order) { return sharedUtility(order.total); }
module.exports = { processPayment };
`);
  fs.writeFileSync(path.join(root, "b.js"), `
const { sharedUtility } = require("./hub");
function processRefund(order) { return sharedUtility(-order.total); }
module.exports = { processRefund };
`);
  fs.writeFileSync(path.join(root, "c.js"), `
const { sharedUtility } = require("./hub");
class InvoiceGenerator {}
module.exports = { InvoiceGenerator };
`);
  // leaf.js: nothing requires it, requires nothing -> lowest centrality.
  fs.writeFileSync(path.join(root, "leaf.js"), `
function unrelatedHelper() { return 42; }
module.exports = { unrelatedHelper };
`);
  return root;
}

check("buildGraph: nodes cover every file, edges resolve require() to real files", () => {
  const root = makeMiniRepo();
  const graph = rm.buildGraph(root);
  assert.strictEqual(graph.nodes.size, 5);
  const relPaths = [...graph.nodes.values()].map((n) => n.rel).sort();
  assert.deepStrictEqual(relPaths, ["a.js", "b.js", "c.js", "hub.js", "leaf.js"]);
  // 3 edges: a->hub, b->hub, c->hub
  assert.strictEqual(graph.edges.length, 3);
  assert.ok(graph.edges.every((e) => e.to.endsWith("hub.js")));
  fs.rmSync(root, { recursive: true, force: true });
});

check("pageRank: a file required by three others outranks an isolated leaf", () => {
  const root = makeMiniRepo();
  const graph = rm.buildGraph(root);
  const ranks = rm.pageRank(graph);
  const hubFile = [...graph.nodes.keys()].find((k) => k.endsWith("hub.js"));
  const leafFile = [...graph.nodes.keys()].find((k) => k.endsWith("leaf.js"));
  assert.ok(ranks.get(hubFile) > ranks.get(leafFile), `hub ${ranks.get(hubFile)} should outrank leaf ${ranks.get(leafFile)}`);
  // Rank mass should be conserved (sums to ~1 across all nodes) — catches a dangling-mass bug.
  const total = [...ranks.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 0.01, `total rank mass ${total} should be ~1`);
  fs.rmSync(root, { recursive: true, force: true });
});

check("selectContext: a query matching a specific symbol ranks that file first", () => {
  const root = makeMiniRepo();
  const graph = rm.buildGraph(root);
  const selected = rm.selectContext(graph, "fix the refund processing bug");
  assert.ok(selected.length > 0);
  assert.strictEqual(selected[0].node.rel, "b.js"); // has processRefund
  assert.ok(selected[0].matchedTerms.includes("refund"));
  fs.rmSync(root, { recursive: true, force: true });
});

check("selectContext: centrality alone can surface a file with zero term match", () => {
  const root = makeMiniRepo();
  const graph = rm.buildGraph(root);
  // Query with terms that appear nowhere in the repo — nothing should have relevance,
  // but centrality-only inclusion means hub.js (most-required) can still surface.
  const selected = rm.selectContext(graph, "xyzzy nonexistent gibberish");
  const hubEntry = selected.find((s) => s.node.rel === "hub.js");
  assert.ok(hubEntry, "hub.js should surface on centrality even with no term match");
  assert.strictEqual(hubEntry.relevance, 0);
  assert.ok(hubEntry.centrality > 0);
  fs.rmSync(root, { recursive: true, force: true });
});

// Regression guard for the exact bug this module's own test suite caught before shipping:
// a naive relevance/centrality blend let the most-central file outrank an actually-relevant
// one. Every relevant file must outrank every irrelevant one, full stop — regardless of how
// load-bearing the irrelevant one is in the dependency graph.
check("selectContext: ANY relevance match outranks ANY non-match, regardless of centrality", () => {
  const root = makeMiniRepo();
  const graph = rm.buildGraph(root);
  const selected = rm.selectContext(graph, "fix the refund processing bug");
  const relevantIdx = selected.findIndex((s) => s.relevance > 0);
  const hubIdx = selected.findIndex((s) => s.node.rel === "hub.js");
  assert.ok(relevantIdx !== -1, "at least one relevant file must be selected");
  assert.strictEqual(selected[0].node.rel, "b.js", "the actually-relevant file must rank #1");
  if (hubIdx !== -1) assert.ok(hubIdx > relevantIdx, "hub.js (irrelevant, central) must rank below the relevant match");
  fs.rmSync(root, { recursive: true, force: true });
});

check("buildEvidencePacket: serializes query, files, scores, and a human-readable reason", () => {
  const root = makeMiniRepo();
  const graph = rm.buildGraph(root);
  const selected = rm.selectContext(graph, "refund processing");
  const packet = rm.buildEvidencePacket("refund processing", selected);
  assert.strictEqual(packet.query, "refund processing");
  assert.ok(packet.generatedAt);
  assert.ok(packet.files.length > 0);
  const top = packet.files[0];
  assert.ok(typeof top.score === "number");
  assert.ok(Array.isArray(top.symbols));
  assert.ok(top.reason.includes("matched") || top.reason.includes("centrality"));
  fs.rmSync(root, { recursive: true, force: true });
});

check("walkSourceFiles skips node_modules/.git and respects the exts filter", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-map-walk-"));
  fs.mkdirSync(path.join(root, "node_modules", "junk"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "junk", "index.js"), "// should be skipped");
  fs.writeFileSync(path.join(root, "real.js"), "// real file");
  fs.writeFileSync(path.join(root, "notes.md"), "not js");
  const files = rm.walkSourceFiles(root);
  assert.strictEqual(files.length, 1);
  assert.ok(files[0].endsWith("real.js"));
  fs.rmSync(root, { recursive: true, force: true });
});

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall repo-map checks passed\n");
