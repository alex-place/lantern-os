"use strict";
// trading-narration.test.js — #2354. Trading events are written to the SHARED CSF
// memory store as JSON blobs; without a `content.text` narration they are unretrievable
// in dream-chat (the recall path scores/embeds content.text) and they shadow prose
// memory. This asserts: (1) each writer produces a non-empty, field-accurate narration;
// (2) a narrated order is retrievable end-to-end through the real queryMemories() path;
// (3) an off-topic query does NOT surface it (the relevance gate still holds).
//
// Run: node apps/lantern-garage/test/trading-narration.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}
function fresh(rel) {
  const abs = require.resolve(rel);
  delete require.cache[abs];
  return require(rel);
}

(async () => {
  // ── unit: narration is non-empty and carries the salient fields ──────────────
  const tmem = require("../lib/trading-memory");
  const tnews = require("../lib/trading-news");

  await check("_narrateOrder carries side, qty, symbol, price, status", () => {
    const t = tmem._narrateOrder({ side: "buy", qty: 1, symbol: "KXHIGHNY", price: "1.72", status: "filled", filled_at: "2026-07-08T14:03:00Z" });
    for (const frag of ["BUY", "1", "KXHIGHNY", "1.72", "filled"]) {
      assert.ok(t.includes(frag), `expected "${frag}" in: ${t}`);
    }
  });

  await check("_narrateSignal carries agent, action, symbol, confidence", () => {
    const t = tmem._narrateSignal({ agent: "tightband-suggest", action: "enter high fade", symbol: "KNYC", confidence: 0.71 });
    for (const frag of ["tightband-suggest", "enter high fade", "KNYC", "0.71"]) {
      assert.ok(t.includes(frag), `expected "${frag}" in: ${t}`);
    }
  });

  await check("_narrateNews carries direction, headline, source, impact", () => {
    const t = tnews._narrateNews(
      { headline: "NWS revises NYC high down 3F", source: "NWS", impact: 55 },
      { direction: "bearish" }, "medium");
    for (const frag of ["bearish", "NWS revises NYC high", "NWS", "55"]) {
      assert.ok(t.includes(frag), `expected "${frag}" in: ${t}`);
    }
  });

  await check("narration is null-safe on empty inputs", () => {
    assert.ok(tmem._narrateOrder({}).length > 0, "order narration must be non-empty");
    assert.ok(tmem._narrateSignal({}).length > 0, "signal narration must be non-empty");
    assert.ok(tnews._narrateNews({}, {}, "low").length > 0, "news narration must be non-empty");
  });

  // ── end-to-end: a narrated order is retrievable through the real recall path ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-narr-"));
  const savedCsf = process.env.CSF_MEMORY_PATH;
  process.env.CSF_MEMORY_PATH = dir;  // set BEFORE requiring csf-memory (resolves at require-time)
  try {
    const tradingMemory = fresh("../lib/trading-memory");
    const csfMemory = fresh("../lib/csf-memory");

    await tradingMemory.recordOrder({
      id: "ord-narr-1", side: "buy", qty: 1, symbol: "KXHIGHNY",
      price: "1.72", status: "filled", filled_at: "2026-07-08T14:03:00Z",
    });

    await check("narrated order surfaces on a relevant chat query", () => {
      const hits = csfMemory.queryMemories("why did we buy KXHIGHNY", 5);
      assert.ok(hits.length >= 1, `expected the order to surface, got ${hits.length}`);
      const texts = hits.map((h) => (h.content && h.content.text) || "").join(" ");
      assert.ok(texts.includes("KXHIGHNY"), `retrieved record should carry the narration, got: ${texts}`);
    });

    await check("off-topic query does NOT surface the trading record (gate holds)", () => {
      const hits = csfMemory.queryMemories("lucid dream journal sleep symbols", 5);
      assert.strictEqual(hits.length, 0, `expected the relevance gate to filter it, got ${hits.length}`);
    });
  } finally {
    if (savedCsf === undefined) delete process.env.CSF_MEMORY_PATH;
    else process.env.CSF_MEMORY_PATH = savedCsf;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall trading-narration checks passed");
  process.exit(failures ? 1 : 0);
})();
