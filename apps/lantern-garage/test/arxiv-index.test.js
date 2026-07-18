// arxiv-index.test.js — BM25 retrieval over the local arXiv corpus (lib/arxiv-index.js).
// Builds a tiny fixture index in a temp ARXIV_CORPUS_DIR (using the module's own
// tokenizer so postings line up), then asserts: the AI-research gate, top-k relevance,
// citable id passthrough, and fail-safe [] when the query doesn't pass the gate.
// Run: node apps/lantern-garage/test/arxiv-index.test.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Point the lib at a throwaway corpus BEFORE requiring it (INDEX_DIR is resolved at require time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "arxiv-idx-"));
process.env.ARXIV_CORPUS_DIR = TMP;
const INDEX_DIR = path.join(TMP, "index");
fs.mkdirSync(INDEX_DIR, { recursive: true });

const arxiv = require("../lib/arxiv-index");

// --- Build a fixture index using the module's own tokenizer -------------------
const FIXTURE = [
  {
    id: "2506.00001",
    title: "Reducing Hallucination in Large Language Models with Reward Feedback",
    published: "2026-03-01",
    primary_category: "cs.CL",
    abstract: "We study hallucination in large language models and propose an RLHF reward model that penalizes unsupported claims, improving factual grounding on question answering benchmarks.",
    url: "https://arxiv.org/abs/2506.00001",
  },
  {
    id: "2506.00002",
    title: "Sparse Mixture of Experts Routing for Efficient Transformers",
    published: "2026-04-10",
    primary_category: "cs.LG",
    abstract: "We introduce a routing algorithm for sparse mixture of experts transformers that lowers inference cost while preserving accuracy on language modeling.",
    url: "https://arxiv.org/abs/2506.00002",
  },
  {
    id: "2506.00003",
    title: "Long Context Attention via State Space Models",
    published: "2026-05-20",
    primary_category: "cs.LG",
    abstract: "A state space approach to long context attention that scales to very long sequences with linear memory, evaluated against transformer baselines.",
    url: "https://arxiv.org/abs/2506.00003",
  },
];

const postings = {};
const docsLines = [];
let totalLen = 0;
FIXTURE.forEach((rec, docId) => {
  const tokens = arxiv.tokenize(`${rec.title} ${rec.abstract}`);
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  for (const [term, freq] of Object.entries(tf)) {
    (postings[term] = postings[term] || []).push([docId, freq]);
  }
  totalLen += tokens.length;
  docsLines.push(JSON.stringify({
    id: rec.id, title: rec.title, published: rec.published,
    primary_category: rec.primary_category,
    snippet: rec.abstract.slice(0, 400), url: rec.url, len: tokens.length,
  }));
});

fs.writeFileSync(path.join(INDEX_DIR, "postings.json"), JSON.stringify(postings));
fs.writeFileSync(path.join(INDEX_DIR, "docs.jsonl"), docsLines.join("\n") + "\n");
fs.writeFileSync(path.join(INDEX_DIR, "meta.json"), JSON.stringify({
  count: FIXTURE.length, avgdl: totalLen / FIXTURE.length, k1: 1.5, b: 0.75,
}));

// --- Assertions ----------------------------------------------------------------
let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

check("gate accepts AI-research questions", () => {
  assert.ok(arxiv.looksLikeAIResearchQuestion("latest LLM alignment research 2026"));
  assert.ok(arxiv.looksLikeAIResearchQuestion("mixture of experts routing"));
});

check("gate rejects unrelated questions", () => {
  assert.ok(!arxiv.looksLikeAIResearchQuestion("what's the weather in Paris today"));
  assert.ok(!arxiv.looksLikeAIResearchQuestion("best sourdough bread recipe"));
});

check("gate accepts control-engineering questions (curated tranche)", () => {
  assert.ok(arxiv.looksLikeAIResearchQuestion("event-triggered control for scheduling the verify stage"));
  assert.ok(arxiv.looksLikeAIResearchQuestion("self triggered sampling from measured Lyapunov decay rates"));
  assert.ok(arxiv.looksLikeAIResearchQuestion("when should we rebalance under transaction costs"));
});

check("gate accepts survivorship-backtest questions (curated tranche)", () => {
  assert.ok(arxiv.looksLikeAIResearchQuestion("how much does survivorship bias inflate returns"));
  assert.ok(arxiv.looksLikeAIResearchQuestion("point-in-time index membership for delisted stocks"));
  assert.ok(arxiv.looksLikeAIResearchQuestion("is trend following profitable over two centuries"));
});

check("gated query returns [] for non-AI message", () => {
  assert.deepStrictEqual(arxiv.queryArxiv("how do I bake bread"), []);
});

check("BM25 ranks the on-topic paper first", () => {
  const res = arxiv.queryArxiv("sparse mixture of experts routing for transformers", 3);
  assert.ok(res.length >= 1, "expected at least one hit");
  assert.strictEqual(res[0].id, "2506.00002", `expected MoE paper first, got ${res[0].id}`);
});

check("hallucination query surfaces the RLHF paper", () => {
  const res = arxiv.queryArxiv("how to reduce hallucination in language models", 3);
  assert.ok(res.some((p) => p.id === "2506.00001"), "expected hallucination paper in results");
});

check("results carry citable id + url", () => {
  const res = arxiv.queryArxiv("long context state space models", 1);
  assert.strictEqual(res.length, 1);
  assert.match(res[0].id, /^\d{4}\.\d{5}$/);
  assert.ok(res[0].url.includes(res[0].id));
  assert.ok(res[0].published);
});

check("isAvailable() true with a built index", () => {
  assert.strictEqual(arxiv.isAvailable(), true);
});

// cleanup
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nall arxiv-index tests passed");
