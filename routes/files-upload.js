module.exports = async function filesUploadRoutes(req, res, url, deps) {
  const { fs, path, sendJson, collectRequestBody, appendJsonlQueued, repoRoot } = deps;

  // POST /api/files/upload — Accept base64-encoded file in JSON
  if (url.pathname === "/api/files/upload" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw || "{}");
      const fileName = String(body.fileName || "document.txt").slice(0, 256);
      const fileContent = String(body.content || "").trim();
      const mimeType = String(body.mimeType || "text/plain").slice(0, 100);

      if (!fileContent) {
        sendJson(res, { error: "content field required (base64 or plain text)" }, 400);
        return true;
      }

      const uploadDir = path.join(repoRoot, "data", "file-uploads");
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

      const fileId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      const filePath = path.join(uploadDir, `${fileId}_${fileName}`);

      // Handle both base64 and plain text
      let buffer;
      if (body.isBase64) {
        buffer = Buffer.from(fileContent, "base64");
      } else {
        buffer = Buffer.from(fileContent, "utf8");
      }

      fs.writeFileSync(filePath, buffer);

      const entry = {
        fileId,
        fileName,
        mimeType,
        size: buffer.length,
        uploadedAt: new Date().toISOString(),
        processed: false,
        chunkCount: 0,
        metadata: body.metadata || {},
      };

      const uploadLogPath = path.join(uploadDir, "uploads.jsonl");
      await appendJsonlQueued(uploadLogPath, entry);

      // Queue document processing (non-blocking)
      setImmediate(() => processDocumentAsync(fileId, filePath, entry, deps));

      sendJson(res, { ...entry, message: "File queued for processing" });
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }

  // GET /api/files/{fileId}/status — Check processing status
  if (url.pathname.match(/^\/api\/files\/[a-z0-9_-]+\/status$/) && req.method === "GET") {
    try {
      const fileId = url.pathname.split("/")[3];
      const uploadDir = path.join(repoRoot, "data", "file-uploads");
      const uploadLogPath = path.join(uploadDir, "uploads.jsonl");

      if (!fs.existsSync(uploadLogPath)) {
        sendJson(res, { error: "file not found" }, 404);
        return true;
      }

      const text = fs.readFileSync(uploadLogPath, "utf8");
      const entries = text.trim().split("\n").filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      const entry = entries.find(e => e.fileId === fileId);
      if (!entry) {
        sendJson(res, { error: "file not found" }, 404);
        return true;
      }

      sendJson(res, { ...entry });
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }

  // POST /api/files/extract — SYNC: decode a base64/text file, extract its text, and RETURN it
  // for immediate chat use (the "+" work tool). Bounds the returned text; logs the upload so it
  // is also persisted. Accepts any file type; falls back to UTF-8 bytes for plain-text formats.
  if (url.pathname === "/api/files/extract" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw || "{}");
      const fileName = String(body.fileName || body.name || "upload.txt").slice(0, 200).replace(/[\\/]+/g, "_");
      const mimeType = String(body.mimeType || "application/octet-stream").slice(0, 120);
      let content = String(body.content || "");
      const dataUrl = content.match(/^data:[^;,]*;base64,(.*)$/s); // accept data: URLs
      if (dataUrl) content = dataUrl[1];
      if (!content) { sendJson(res, { ok: false, error: "content required" }, 400); return true; }

      const uploadDir = path.join(repoRoot, "data", "file-uploads");
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const fileId = `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const filePath = path.join(uploadDir, `${fileId}_${fileName}`);
      const buffer = body.isBase64 === false ? Buffer.from(content, "utf8") : Buffer.from(content, "base64");
      // Cap at ~12MB to avoid OOM on a hostile/huge upload.
      if (buffer.length > 12 * 1024 * 1024) { sendJson(res, { ok: false, error: "file too large (max 12MB)" }, 413); return true; }
      fs.writeFileSync(filePath, buffer);

      const { extractDocumentContent } = require("../lib/document-extractor");
      let text = "", extractError = null;
      try {
        const extracted = await extractDocumentContent(filePath, mimeType);
        text = extracted && extracted.content ? String(extracted.content) : "";
        extractError = extracted && extracted.error ? extracted.error : null;
      } catch (e) { extractError = e.message; }

      // Fallback: extractor handles pdf/txt/md/json/csv/images; for other text-like files
      // (code, logs, .ts, .yaml…) use the raw bytes when they look like printable UTF-8.
      if (!text) {
        const asText = buffer.toString("utf8");
        const printable = asText.length ? asText.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "").length / asText.length : 0;
        if (printable > 0.85) text = asText;
      }

      const MAX = 24000;
      const truncated = text.length > MAX;
      const outText = truncated ? text.slice(0, MAX) : text;

      const entry = { fileId, fileName, mimeType, size: buffer.length, chars: text.length,
        uploadedAt: new Date().toISOString(), extracted: !!text, via: "chat-attach" };
      try { await appendJsonlQueued(path.join(uploadDir, "uploads.jsonl"), entry); } catch { /* non-fatal */ }

      sendJson(res, {
        ok: true, fileId, name: fileName, mimeType, size: buffer.length,
        chars: text.length, truncated, text: outText, excerpt: outText.slice(0, 280),
        note: text ? null : (extractError || "No extractable text (binary or unsupported type)."),
      });
    } catch (error) {
      sendJson(res, { ok: false, error: error.message }, 400);
    }
    return true;
  }

  return false;
};

async function processDocumentAsync(fileId, filePath, entry, deps) {
  try {
    const { fs, appendJsonlQueued, repoRoot } = deps;
    const path = require("path");
    const { extractDocumentContent, extractFileMetadata } = require("../lib/document-extractor");
    const { isDuplicate, recordDedupEntry, buildDedupIndex } = require("../lib/document-deduplicator");

    if (!fs.existsSync(filePath)) {
      console.error(`File not found for processing: ${filePath}`);
      return;
    }

    // Extract content with appropriate method (PDF, OCR, plain text)
    const extracted = await extractDocumentContent(filePath, entry.mimeType);
    if (!extracted.content) {
      updateFileProcessingStatus(fileId, {
        processed: false,
        error: `Extraction failed: ${extracted.error}`
      }, deps);
      return;
    }

    // Extract metadata
    const metadata = await extractFileMetadata(filePath);

    // Check for duplicates
    const csfPath = path.join(repoRoot, "data", "csf-ingest", "deltas.jsonl");
    const dedupIndex = buildDedupIndex(csfPath);
    const isDup = isDuplicate(extracted.content, metadata, dedupIndex);

    if (isDup) {
      console.log(`[dedup] Skipping duplicate: ${entry.fileName} (matches ${isDup.fileName})`);
      recordDedupEntry(extracted.content, metadata, filePath);
      updateFileProcessingStatus(fileId, {
        processed: true,
        isDuplicate: true,
        duplicateOf: isDup.fileId,
        chunkCount: 0
      }, deps);
      return;
    }

    // Chunk the document
    const chunks = chunkText(extracted.content, 500);

    // Ingest chunks into CSF memory as document entries
    const { ingestEntry: csfIngest } = require("../lib/csf-delta-store");
    for (let i = 0; i < chunks.length; i++) {
      try {
        csfIngest({
          kind: "document-chunk",
          text: chunks[i],
          tags: [entry.fileName, `chunk:${i + 1}/${chunks.length}`],
          symbols: extractKeywords(chunks[i]),
          source: {
            fileId: fileId,
            fileName: entry.fileName,
            type: path.extname(filePath).slice(1),
            extractionMethod: extracted.method,
            confidence: extracted.confidence
          },
          docMetadata: {
            title: metadata.fileName,
            createdAt: metadata.createdAt,
            modifiedAt: metadata.modifiedAt,
            size: metadata.size,
            pages: extracted.pages
          },
          chunkIdx: i,
          totalChunks: chunks.length,
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        console.error(`CSF ingest failed for chunk ${i}:`, e.message);
      }
    }

    recordDedupEntry(extracted.content, metadata, filePath);

    // Update entry as processed
    updateFileProcessingStatus(fileId, {
      processed: true,
      chunkCount: chunks.length,
      extractionMethod: extracted.method,
      confidence: extracted.confidence
    }, deps);
  } catch (err) {
    console.error(`Document processing failed for ${fileId}:`, err.message);
    updateFileProcessingStatus(fileId, { processed: false, error: err.message }, deps);
  }
}

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

function updateFileProcessingStatus(fileId, updates, deps) {
  try {
    const { fs, repoRoot } = deps;
    const path = require("path");
    const uploadDir = path.join(repoRoot, "data", "file-uploads");
    const uploadLogPath = path.join(uploadDir, "uploads.jsonl");

    if (!fs.existsSync(uploadLogPath)) return;

    const text = fs.readFileSync(uploadLogPath, "utf8");
    const lines = text.trim().split("\n").filter(Boolean);
    const updated = lines.map(line => {
      try {
        const entry = JSON.parse(line);
        if (entry.fileId === fileId) {
          return JSON.stringify({ ...entry, ...updates });
        }
        return line;
      } catch {
        return line;
      }
    });

    fs.writeFileSync(uploadLogPath, updated.join("\n") + "\n");
  } catch (err) {
    console.error(`Status update failed for ${fileId}:`, err.message);
  }
}
