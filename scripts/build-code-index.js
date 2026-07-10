#!/usr/bin/env node
"use strict";

/**
 * build-code-index.js — build the semantic source-code index (data/code-index/).
 *
 * Reuses the nomic-embed/Ollama path via lib/code-index.js. Ollama must be up with
 * the embed model pulled:  ollama pull nomic-embed-text
 *
 * Usage:
 *   node scripts/build-code-index.js                 # index tracked source (cap 800 files)
 *   node scripts/build-code-index.js --max-files 200 # smaller/faster pass
 */

const path = require("path");
const { buildIndex, INDEX_DIR } = require(path.join(
  __dirname, "..", "apps", "lantern-garage", "lib", "code-index"
));

function argVal(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
}

(async () => {
  const maxFiles = argVal("--max-files", 800);
  const t0 = Date.now();
  console.log(`[code-index] building → ${INDEX_DIR} (maxFiles=${maxFiles})`);
  console.log(`[code-index] requires Ollama at 127.0.0.1:11434 with nomic-embed-text pulled`);

  try {
    const meta = await buildIndex({
      maxFiles,
      onProgress: ({ nFiles, nChunks, nEmbedded }) =>
        process.stdout.write(`\r[code-index] files=${nFiles} chunks=${nChunks} embedded=${nEmbedded}   `),
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[code-index] done in ${secs}s →`, meta);
    if (!meta.nEmbedded) {
      console.error("[code-index] WARNING: 0 chunks embedded — is Ollama running and nomic-embed-text pulled?");
      process.exit(1);
    }
  } catch (e) {
    console.error("[code-index] build failed:", e.message);
    process.exit(1);
  }
})();
