// patent-index.test.js — BM25 retrieval over the local worldwide-patent corpus
// (lib/patent-index.js). Builds a tiny fixture index in a temp PATENT_CORPUS_DIR
// (using the module's own tokenizer so postings line up), then asserts: the
// patent-intent gate, top-k relevance, citable publication-number passthrough,
// worldwide-office coverage, and fail-safe [] when the query doesn't pass the gate.
// Run: node test/patent-index.test.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Point the lib at a throwaway corpus BEFORE requiring it (INDEX_DIR is resolved at require time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "patent-idx-"));
process.env.PATENT_CORPUS_DIR = TMP;
const INDEX_DIR = path.join(TMP, "index");
fs.mkdirSync(INDEX_DIR, { recursive: true });

const patents = require("../lib/patent-index");

// --- Build a fixture index using the module's own tokenizer -------------------
// Publication numbers + offices span US / EP / WO / CN to exercise worldwide coverage.
const FIXTURE = [
  {
    id: "US-11289701-B2",
    title: "Solid-state electrolyte for lithium metal batteries",
    published: "2022-03-29",
    country: "US",
    assignee: "QuantumScape",
    cpc: "H01M10/0562",
    abstract: "A solid-state electrolyte comprising a lithium-stuffed garnet separator that suppresses dendrite formation at the lithium metal anode, enabling high energy density solid-state batteries with improved cycle life.",
    url: "https://patents.google.com/patent/US11289701B2/en",
  },
  {
    id: "EP-3745492-A1",
    title: "Sulfide solid electrolyte and all-solid-state battery",
    published: "2020-12-02",
    country: "EP",
    assignee: "Toyota",
    cpc: "H01M10/0525",
    abstract: "A sulfide-based solid electrolyte material with high ionic conductivity for all-solid-state lithium-ion batteries, and a method of manufacturing the electrolyte layer.",
    url: "https://patents.google.com/patent/EP3745492A1/en",
  },
  {
    id: "WO-2021146073-A1",
    title: "CRISPR-Cas gene editing of hematopoietic stem cells",
    published: "2021-07-22",
    country: "WO",
    assignee: "Broad Institute",
    cpc: "C12N15/113",
    abstract: "Methods for editing a target locus in hematopoietic stem cells using a CRISPR-Cas system with a guide RNA, for treating genetic blood disorders such as sickle cell disease.",
    url: "https://patents.google.com/patent/WO2021146073A1/en",
  },
];

const postings = {};
const docsLines = [];
let totalLen = 0;
FIXTURE.forEach((rec, docId) => {
  const tokens = patents.tokenize(`${rec.title} ${rec.abstract}`);
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  for (const [term, freq] of Object.entries(tf)) {
    (postings[term] = postings[term] || []).push([docId, freq]);
  }
  totalLen += tokens.length;
  docsLines.push(JSON.stringify({
    id: rec.id, title: rec.title, published: rec.published,
    country: rec.country, assignee: rec.assignee, cpc: rec.cpc,
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

check("gate accepts patent / prior-art / IP questions", () => {
  assert.ok(patents.looksLikePatentQuestion("is there prior art for a solid-state battery electrolyte"));
  assert.ok(patents.looksLikePatentQuestion("who holds the patent on CRISPR gene editing"));
  assert.ok(patents.looksLikePatentQuestion("freedom to operate analysis for lithium metal anodes"));
  assert.ok(patents.looksLikePatentQuestion("search USPTO and Espacenet for sulfide electrolytes"));
});

check("gate rejects unrelated questions", () => {
  assert.ok(!patents.looksLikePatentQuestion("what's the weather in Paris today"));
  assert.ok(!patents.looksLikePatentQuestion("best sourdough bread recipe"));
  assert.ok(!patents.looksLikePatentQuestion("summarize this earnings call"));
});

check("gated query returns [] for a non-patent message", () => {
  assert.deepStrictEqual(patents.queryPatents("how do I bake bread"), []);
});

check("BM25 ranks the on-topic patent first", () => {
  const res = patents.queryPatents("prior art on a lithium garnet solid-state electrolyte separator patent", 3);
  assert.ok(res.length >= 1, "expected at least one hit");
  assert.strictEqual(res[0].id, "US-11289701-B2", `expected garnet electrolyte patent first, got ${res[0].id}`);
});

check("CRISPR patent query surfaces the gene-editing patent", () => {
  const res = patents.queryPatents("patent for CRISPR-Cas editing of hematopoietic stem cells", 3);
  assert.ok(res.some((p) => p.id === "WO-2021146073-A1"), "expected CRISPR patent in results");
});

check("results carry citable publication number + url + worldwide office", () => {
  const res = patents.queryPatents("sulfide solid electrolyte all-solid-state battery patent", 1);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].id, "EP-3745492-A1");
  assert.ok(res[0].url.includes("EP3745492A1"), "url should cite the publication number");
  assert.strictEqual(res[0].country, "EP", "office/country should be carried through");
  assert.ok(res[0].published, "publication date should be present");
});

check("isAvailable() true with a built index", () => {
  assert.strictEqual(patents.isAvailable(), true);
});

// cleanup
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nall patent-index tests passed");
