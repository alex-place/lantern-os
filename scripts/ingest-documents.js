#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { extractDocumentContent, extractFileMetadata } = require('../apps/lantern-garage/lib/document-extractor');
const { isDuplicate, buildDedupIndex, recordDedupEntry } = require('../apps/lantern-garage/lib/document-deduplicator');

// Utility functions from files-upload.js
function chunkText(text, chunkSize = 500) {
  const chunks = [];
  const sentences = text.match(/[^.!?]*[.!?]+/g) || [text];

  let currentChunk = "";
  for (const sentence of sentences) {
    if ((currentChunk + sentence).length <= chunkSize) {
      currentChunk += sentence;
    } else {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = sentence;
    }
  }
  if (currentChunk) chunks.push(currentChunk.trim());

  return chunks.filter(c => c.length > 20);
}

function extractKeywords(text, limit = 5) {
  const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 4);
  const freq = {};
  for (const word of words) {
    freq[word] = (freq[word] || 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

// Main ingest function
async function ingestDocuments(sourceDir, repoRoot = null) {
  if (!repoRoot) {
    repoRoot = path.resolve(__dirname, '..');
  }

  console.log(`\n=== DOCUMENT INGEST ===`);
  console.log(`Source: ${sourceDir}`);
  console.log(`Repo root: ${repoRoot}\n`);

  if (!fs.existsSync(sourceDir)) {
    console.error(`ERROR: Directory not found: ${sourceDir}`);
    process.exit(1);
  }

  const csfPath = path.join(repoRoot, 'data', 'csf-ingest', 'deltas.jsonl');
  const dedupIndex = buildDedupIndex(csfPath);

  // Get all files recursively
  const getFiles = (dir) => {
    let files = [];
    const items = fs.readdirSync(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        files = files.concat(getFiles(fullPath));
      } else if (item.isFile()) {
        files.push(fullPath);
      }
    }

    return files;
  };

  const files = getFiles(sourceDir);
  console.log(`Found ${files.length} files to process\n`);

  let stats = {
    processed: 0,
    skipped: 0,
    duplicates: 0,
    errors: 0,
    totalChunks: 0
  };

  // Ensure CSF ingest directory exists
  const csfDir = path.dirname(csfPath);
  if (!fs.existsSync(csfDir)) {
    fs.mkdirSync(csfDir, { recursive: true });
  }

  // Process each file
  for (const filePath of files) {
    const fileName = path.relative(sourceDir, filePath);

    try {
      const ext = path.extname(filePath).toLowerCase();

      // Skip unsupported files
      if (!['.pdf', '.png', '.jpg', '.jpeg', '.txt', '.md', '.json', '.gif', '.tiff', '.webp'].includes(ext)) {
        stats.skipped++;
        continue;
      }

      // Extract content
      const extracted = await extractDocumentContent(filePath);
      if (!extracted.content) {
        console.error(`  ✗ ${fileName} — extraction failed`);
        stats.errors++;
        continue;
      }

      // Extract metadata
      const metadata = await extractFileMetadata(filePath);

      // Check for duplicates
      const isDup = isDuplicate(extracted.content, metadata, dedupIndex);
      if (isDup) {
        console.log(`  ↷ ${fileName} — duplicate (matches ${isDup.fileName})`);
        recordDedupEntry(extracted.content, metadata, filePath, repoRoot);
        stats.duplicates++;
        continue;
      }

      // Chunk the document
      const chunks = chunkText(extracted.content, 500);

      // Ingest chunks into CSF
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const csfEntry = {
          kind: "document-chunk",
          text: chunk,
          tags: [fileName, `chunk:${i + 1}/${chunks.length}`],
          symbols: extractKeywords(chunk),
          source: {
            fileName: fileName,
            type: ext.slice(1),
            extractionMethod: extracted.method,
            confidence: extracted.confidence
          },
          docMetadata: {
            title: path.basename(fileName),
            createdAt: metadata.createdAt?.toISOString(),
            modifiedAt: metadata.modifiedAt?.toISOString(),
            size: metadata.size,
            pages: extracted.pages || 1
          },
          chunkIdx: i,
          totalChunks: chunks.length,
          timestamp: new Date().toISOString()
        };

        fs.appendFileSync(csfPath, JSON.stringify(csfEntry) + '\n');
      }

      recordDedupEntry(extracted.content, metadata, filePath, repoRoot);

      console.log(`  ✓ ${fileName} (${chunks.length} chunks, ${extracted.method})`);
      stats.processed++;
      stats.totalChunks += chunks.length;

    } catch (err) {
      console.error(`  ✗ ${fileName} — ${err.message}`);
      stats.errors++;
    }
  }

  // Print summary
  console.log(`\n=== INGEST COMPLETE ===`);
  console.log(`Processed: ${stats.processed}`);
  console.log(`Duplicates: ${stats.duplicates}`);
  console.log(`Skipped: ${stats.skipped}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`Total chunks: ${stats.totalChunks}`);
  console.log(`CSF file: ${csfPath}\n`);

  return stats;
}

// CLI entry point. Source dir: pass as arg 2, or set LANTERN_INGEST_DIR;
// defaults to a repo-relative folder (no hardcoded drive).
const sourceDir = process.argv[2] || process.env.LANTERN_INGEST_DIR
  || path.join(__dirname, '..', 'data', 'imagesandreports');
ingestDocuments(sourceDir).catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
