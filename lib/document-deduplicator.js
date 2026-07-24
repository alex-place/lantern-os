const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Generate content hash from text
function generateContentHash(text, metadata = {}) {
  const hash = crypto.createHash('sha256');

  // Hash filename + size (document-level)
  if (metadata.fileName) {
    hash.update(`file:${metadata.fileName}`);
  }
  if (metadata.size) {
    hash.update(`size:${metadata.size}`);
  }

  // Hash first 100 chars (chunk-level quick check)
  if (text) {
    hash.update(`content:${text.slice(0, 100)}`);
  }

  return hash.digest('hex');
}

// Build in-memory dedup index from CSF data
function buildDedupIndex(csfDataPath) {
  const dedupIndex = new Map();

  try {
    if (!fs.existsSync(csfDataPath)) {
      return dedupIndex;
    }

    const content = fs.readFileSync(csfDataPath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    lines.forEach(line => {
      try {
        const entry = JSON.parse(line);

        // Index document chunks by source + content hash
        if (entry.source?.fileId && entry.text) {
          const key = generateContentHash(entry.text, { fileName: entry.source.fileName });
          dedupIndex.set(key, {
            fileId: entry.source.fileId,
            fileName: entry.source.fileName,
            timestamp: entry.timestamp,
            chunkIdx: entry.chunkIdx
          });
        }
      } catch (e) {
        // Skip malformed entries
      }
    });
  } catch (err) {
    console.error(`[dedup] Failed to build index: ${err.message}`);
  }

  return dedupIndex;
}

// Check if content is a duplicate
function isDuplicate(text, metadata = {}, dedupIndex) {
  const hash = generateContentHash(text, metadata);
  return dedupIndex.has(hash) ? dedupIndex.get(hash) : null;
}

// Record a new document in dedup log (pass repoRoot to avoid path issues)
function recordDedupEntry(text, metadata, filePath, repoRoot = null) {
  if (!repoRoot) {
    // Fallback: try to find repo root by going up from current directory
    repoRoot = path.resolve(__dirname, '../..');
  }

  const dedupLogPath = path.join(repoRoot, 'data', 'csf-ingest', 'dedup-log.jsonl');

  const entry = {
    hash: generateContentHash(text, metadata),
    fileName: metadata.fileName,
    fileSize: metadata.size,
    ingestionTime: new Date().toISOString(),
    filePath: filePath,
    textLength: text.length,
    firstChars: text.slice(0, 50).replace(/\n/g, ' ')
  };

  try {
    fs.appendFileSync(dedupLogPath, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error(`[dedup] Failed to log entry: ${err.message}`);
  }
}

// Statistics on dedup effectiveness
function getDedupStats(dedupLogPath) {
  const stats = {
    total: 0,
    unique: 0,
    duplicatesCaught: 0
  };

  try {
    if (!fs.existsSync(dedupLogPath)) {
      return stats;
    }

    const content = fs.readFileSync(dedupLogPath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    const seen = new Set();
    lines.forEach(line => {
      try {
        const entry = JSON.parse(line);
        stats.total++;

        if (seen.has(entry.hash)) {
          stats.duplicatesCaught++;
        } else {
          seen.add(entry.hash);
          stats.unique++;
        }
      } catch (e) {
        // Skip malformed
      }
    });
  } catch (err) {
    console.error(`[dedup] Failed to read stats: ${err.message}`);
  }

  return stats;
}

module.exports = {
  generateContentHash,
  buildDedupIndex,
  isDuplicate,
  recordDedupEntry,
  getDedupStats
};
