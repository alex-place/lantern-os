"use strict";
// #2081 — the Remember-stage READ seam. routes/memory.js spawns src/convergence/memory_query.py
// so reasoners (and dream-chat, via /api/memory/query) can query persistent memory — the interface
// convergence-core-mapping.md Stage 2 flagged missing ("Remember stage is write-only"). This
// asserts a logged JSONL fact is retrieved end-to-end through the Node→Python seam, isolating a
// temp store via the new --memory-dir override so it never touches real data/.
//
// Run: node test/memory-query-seam.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { queryMemory } = require("../routes/memory");

(async () => {
  let failures = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memq-seam-"));
  // MemoryStore reads <dir>/observations.jsonl among its logs — seed one distinctive fact there.
  fs.writeFileSync(
    path.join(tmp, "observations.jsonl"),
    JSON.stringify({
      id: "m-2081", source: "observations", confidence: 0.9,
      content: { fact: "the dev server listens on port 4178", topic: "deploy-config" },
      timestamp: "2026-07-05T12:00:00",
    }) + "\n",
  );

  async function check(name, fn) {
    try { await fn(); console.log("  ok  -", name); }
    catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
  }

  await check("seam retrieves a logged JSONL fact by content keyword", async () => {
    const results = await queryMemory({ pattern: "deploy-config", min_confidence: 0.0, memory_dir: tmp });
    assert.ok(Array.isArray(results), "results must be an array");
    assert.ok(results.length >= 1, `expected a hit, got ${results.length}`);
    assert.ok(JSON.stringify(results[0].content).includes("4178"),
      `retrieved fact should carry the logged content, got ${JSON.stringify(results[0].content)}`);
  });

  await check("non-matching pattern returns nothing (no false positive)", async () => {
    const results = await queryMemory({ pattern: "zzz-nonexistent-term-xyz", min_confidence: 0.0, memory_dir: tmp });
    assert.ok(Array.isArray(results) && results.length === 0, `expected 0, got ${results.length}`);
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(failures ? `\n${failures} FAILED` : "\nall memory-query seam checks passed");
  process.exit(failures ? 1 : 0);
})();
