"use strict";

/**
 * test/grounding-rings.test.js
 *
 * The real grounding-ring adapters (lib/grounding-rings.js) wrap the existing retrievers
 * (csf-memory.*, web-search-client.*) into the resolver's evidence shape. csf-memory and
 * web-search-client are stubbed via require.cache BEFORE grounding-rings binds them, so the
 * adapters are tested with zero disk/network. Pins: the score→confidence mapping, the web
 * prior + needsGrounding gate, and the ring ordering of defaultRings()/localServeRings().
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/grounding-rings.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

// ── stub the real retrievers before grounding-rings requires them ─────────────
let _csf = {};
let _web = {};
const csfId = require.resolve("../lib/csf-memory");
const webId = require.resolve("../lib/web-search-client");
require.cache[csfId] = { id: csfId, filename: csfId, loaded: true, exports: new Proxy({}, { get: (_t, p) => _csf[p] }) };
require.cache[webId] = { id: webId, filename: webId, loaded: true, exports: new Proxy({}, { get: (_t, p) => _web[p] }) };

const rings = require("../lib/grounding-rings");

function resetStubs() {
  _csf = {
    queryConversationMemory: () => [],
    queryMemories: () => [],
    queryRagHouse: () => [],
    queryResearchLibrary: () => [],
  };
  _web = {
    needsGrounding: () => true,
    extractSearchQuery: (q) => q,
    webSearchMcp: async () => [],
  };
}

// ── local-memory ring ─────────────────────────────────────────────────────────

test("localMemoryRing maps conversation turns, carrying their relevance score as confidence", async () => {
  resetStubs();
  _csf.queryConversationMemory = () => [
    { role: "lantern", text: "the deploy went green at 16:23", score: 0.83, at: "2026-06-27" },
  ];
  _csf.queryMemories = () => [{ content: { text: "user prefers concise answers" }, tags: ["pref"] }];
  const out = await rings.localMemoryRing().source("did the deploy go green?");
  assert.equal(out.length, 2);
  const conv = out.find((e) => /deploy went green/.test(e.claim));
  assert.ok(conv && conv.confidence === 0.83, "conversation score becomes confidence");
  assert.equal(conv.source, "local-memory");
  assert.ok(out.every((e) => typeof e.claim === "string" && e.claim.length));
});

test("localMemoryRing is fail-safe — a throwing retriever contributes nothing, not a crash", async () => {
  resetStubs();
  _csf.queryConversationMemory = () => { throw new Error("disk gone"); };
  _csf.queryMemories = () => [{ content: { text: "still here" }, tags: [] }];
  const out = await rings.localMemoryRing().source("q");
  assert.equal(out.length, 1);
  assert.equal(out[0].claim, "still here");
});

// ── knowledge-center ring ──────────────────────────────────────────────────────

test("knowledgeCenterRing maps RAG + research records with overlap-based confidence", async () => {
  resetStubs();
  _csf.queryRagHouse = () => [{ title: "CSF format spec", content: "zstd-backed binary archive with per-file sha256" }];
  _csf.queryResearchLibrary = () => [{ pdfTitle: "Adams & Laughlin 1997", textSnippet: "far-future cosmology eras" }];
  const out = await rings.knowledgeCenterRing().source("csf format archive");
  assert.ok(out.length >= 1);
  const rag = out.find((e) => /CSF format spec/.test(e.claim));
  assert.ok(rag, "RAG record surfaces as a claim");
  assert.ok(rag.confidence > 0, "overlap with the query yields nonzero confidence");
  assert.equal(rag.source, "knowledge-center");
});

// ── web ring ────────────────────────────────────────────────────────────────

test("webRing respects the needsGrounding gate (returns nothing when grounding isn't needed)", async () => {
  resetStubs();
  _web.needsGrounding = () => false;
  _web.webSearchMcp = async () => [{ title: "should not be fetched", snippet: "x" }];
  const out = await rings.webRing().source("hello there");
  assert.deepEqual(out, []);
});

test("webRing maps results with the calibrated 0.45 prior (a lone web hit abstains under threshold 0.5)", async () => {
  resetStubs();
  _web.webSearchMcp = async () => [{ title: "Result A", snippet: "some snippet", url: "https://ex.com/a" }];
  const out = await rings.webRing().source("what is X?");
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, 0.45, "default web prior is the calibrated 0.45");
  assert.ok(out[0].source.startsWith("web"), "web source tag");
  assert.ok(out[0].confidence < 0.5, "below the resolver answer threshold → lone web hit abstains");
});

// ── ring composition ──────────────────────────────────────────────────────────

test("defaultRings: local→KC→web by default; mesh ring only when peers are provided", async () => {
  resetStubs();
  const noPeers = rings.defaultRings();
  assert.deepEqual(noPeers.map((r) => r.name), ["local-memory", "knowledge-center", "web"]);

  const withPeers = rings.defaultRings({ peers: [{ id: "b", url: "http://b/api/mesh/ground" }] });
  assert.deepEqual(withPeers.map((r) => r.name), ["local-memory", "knowledge-center", "mesh", "web"]);
  assert.ok(withPeers.indexOf(withPeers.find((r) => r.name === "mesh")) < withPeers.findIndex((r) => r.name === "web"),
    "mesh ring sits ABOVE web (trusted peer beats open web)");

  const noWeb = rings.defaultRings({ web: false });
  assert.ok(!noWeb.some((r) => r.name === "web"));
});

test("localServeRings (what a node serves to peers) is local rings ONLY — never the mesh ring (no recursion)", () => {
  const serve = rings.localServeRings();
  assert.deepEqual(serve.map((r) => r.name), ["local-memory", "knowledge-center"]);
  assert.ok(!serve.some((r) => r.name === "mesh"), "a peer request must not re-federate");
});
