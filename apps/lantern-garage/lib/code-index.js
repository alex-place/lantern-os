"use strict";

/**
 * code-index.js — semantic retrieval over the repository SOURCE CODE.
 *
 * Closes the "Remember over code" gap: before this, code retrieval was purely
 * lexical (ripgrep + regex-symbol scoring in repo-context.js), so a query phrased
 * differently from the code ("where do we back off when Kalshi rate-limits us")
 * never found the file unless it shared literal tokens. This adds a genuine
 * semantic layer — embed source chunks, cosine-match the query — mirroring the
 * arxiv-index.js build→flat-index→query() pattern.
 *
 * DESIGN (lean MVP, zero new deps — measure the lift before adding tree-sitter/LanceDB):
 *   - Chunking: declaration-boundary split (function/class/def/const), size-capped.
 *     Good enough to isolate "one unit of code" without a real parser.
 *   - Embedding: REUSES semantic-reranker's nomic-embed/Ollama path — one embedding
 *     provider for the whole system, per the convergence constraint (no 2nd model,
 *     no 2nd vector DB).
 *   - Store: one flat file  data/code-index/chunks.jsonl  (line = {file,start,end,text,vec})
 *     + meta.json — same shape philosophy as the arXiv postings index.
 *
 * FAIL-SAFE: any missing index / Ollama-down / parse error yields [] so chat is
 * never blocked — callers fall back to the lexical searchRepoFiles() path.
 *
 * Build the index:   node scripts/build-code-index.js
 * Query at runtime:  const { queryCode } = require("./code-index");
 *                    const hits = await queryCode("retry backoff on 429", 5);
 */

const fs = require("fs");
const path = require("path");
const { embed, cosine } = require("./semantic-reranker");

const REPO_ROOT = path.resolve(__dirname, "../../../");
const INDEX_DIR = path.join(REPO_ROOT, "data", "code-index");
const CHUNKS_PATH = path.join(INDEX_DIR, "chunks.jsonl");
const META_PATH = path.join(INDEX_DIR, "meta.json");

// Which files are worth embedding, and which to never touch.
const CODE_FILE_RE = /\.(js|mjs|cjs|ts|tsx|jsx|py)$/;
const EXCLUDE_RE = [
  /node_modules/, /__pycache__/, /\.min\.js$/, /vendor\//, /\bdist\//,
  /\.test\.js$/, /test_.*\.py$/, /\/tests?\//, /public\/games\//,
];

// Chunk sizing. A chunk is roughly one function/class; capped so a giant file
// can't produce one enormous embedding, floored so trivial fragments merge up.
const MAX_CHUNK_LINES = 80;
const MIN_CHUNK_LINES = 5;
const SNIPPET_CHARS = 1200;   // stored text per chunk (bounds index size + embed cost)

// A line that starts a new top-level-ish declaration → a chunk boundary.
const DECL_RE = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|def|const|let|var)\s+[A-Za-z_$]/;

// ── Chunking (pure) ────────────────────────────────────────────────────────────
/**
 * Split source text into declaration-bounded chunks.
 * @returns {Array<{start:number,end:number,text:string}>}  1-indexed line ranges
 */
function chunkSource(content) {
  const lines = String(content || "").split("\n");
  if (lines.length <= MAX_CHUNK_LINES) {
    return lines.join("\n").trim()
      ? [{ start: 1, end: lines.length, text: lines.join("\n").slice(0, SNIPPET_CHARS) }]
      : [];
  }

  // Boundary line numbers (0-indexed): every declaration start, plus a forced
  // split whenever a chunk would exceed MAX_CHUNK_LINES.
  const bounds = [0];
  for (let i = 1; i < lines.length; i++) {
    const sinceLast = i - bounds[bounds.length - 1];
    if (DECL_RE.test(lines[i]) && sinceLast >= MIN_CHUNK_LINES) bounds.push(i);
    else if (sinceLast >= MAX_CHUNK_LINES) bounds.push(i);
  }
  bounds.push(lines.length);

  const chunks = [];
  for (let b = 0; b < bounds.length - 1; b++) {
    const s = bounds[b], e = bounds[b + 1];
    const text = lines.slice(s, e).join("\n");
    if (!text.trim()) continue;
    chunks.push({ start: s + 1, end: e, text: text.slice(0, SNIPPET_CHARS) });
  }
  return chunks;
}

// ── Build ────────────────────────────────────────────────────────────────────
/**
 * Build the semantic code index over tracked source files.
 * Bounded + best-effort: unreadable/oversized files are skipped, embed failures
 * drop that chunk. Writes chunks.jsonl + meta.json. Returns a summary.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.files]   — explicit relative file list (default: git ls-files)
 * @param {number}  [opts.maxFiles] — cap files indexed (default 800)
 * @param {number}  [opts.maxBytes] — skip files larger than this (default 200_000)
 * @param {function}[opts.onProgress]
 */
async function buildIndex(opts = {}) {
  const { execSync } = require("child_process");
  const maxFiles = opts.maxFiles || 800;
  const maxBytes = opts.maxBytes || 200_000;

  let files = opts.files;
  if (!files) {
    files = execSync("git ls-files", { cwd: REPO_ROOT, encoding: "utf-8" })
      .split("\n").filter(Boolean);
  }
  files = files
    .filter((f) => CODE_FILE_RE.test(f) && !EXCLUDE_RE.some((re) => re.test(f)))
    .slice(0, maxFiles);

  fs.mkdirSync(INDEX_DIR, { recursive: true });
  const out = fs.createWriteStream(CHUNKS_PATH, { encoding: "utf-8" });

  let nFiles = 0, nChunks = 0, nEmbedded = 0, dim = 0;
  for (const f of files) {
    let content;
    try {
      const abs = path.join(REPO_ROOT, f);
      if (fs.statSync(abs).size > maxBytes) continue;
      content = fs.readFileSync(abs, "utf-8");
    } catch { continue; }

    const chunks = chunkSource(content);
    if (!chunks.length) continue;
    nFiles++;

    for (const c of chunks) {
      nChunks++;
      // Embed "path + code" so the file path (a strong locality signal) is in-vector.
      const vec = await embed(`${f}\n${c.text}`.slice(0, 2048));
      if (!vec) continue;
      dim = vec.length;
      nEmbedded++;
      out.write(JSON.stringify({ file: f, start: c.start, end: c.end, text: c.text, vec }) + "\n");
      if (opts.onProgress && nEmbedded % 50 === 0) opts.onProgress({ nFiles, nChunks, nEmbedded });
    }
  }

  await new Promise((res) => out.end(res));
  const meta = { built: new Date().toISOString(), nFiles, nChunks, nEmbedded, dim, model: process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text" };
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
  return meta;
}

// ── Query ──────────────────────────────────────────────────────────────────────
let _cache = null;   // { mtime, rows: [{file,start,end,text,vec}] }

function _loadChunks() {
  const mtime = fs.statSync(CHUNKS_PATH).mtimeMs;
  if (_cache && _cache.mtime === mtime) return _cache.rows;
  const rows = [];
  for (const line of fs.readFileSync(CHUNKS_PATH, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  _cache = { mtime, rows };
  return rows;
}

/**
 * Return up to `k` source-code chunks most semantically similar to `message`.
 * Fail-safe: [] when no index exists or Ollama is unavailable.
 * @returns {Promise<Array<{file,start,end,snippet,score}>>}
 */
async function queryCode(message, k = 5) {
  try {
    if (!message || !message.trim()) return [];
    if (!fs.existsSync(CHUNKS_PATH)) return [];
    const rows = _loadChunks();
    if (!rows.length) return [];

    const qvec = await embed(message.slice(0, 2048));
    if (!qvec) return [];

    return rows
      .map((r) => ({
        file: r.file,
        start: r.start,
        end: r.end,
        snippet: r.text.slice(0, 400),
        score: cosine(qvec, r.vec),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  } catch {
    return [];
  }
}

/** Whether a usable index is present on disk (for status/diagnostics). */
function isAvailable() {
  try { return fs.existsSync(CHUNKS_PATH) && _loadChunks().length > 0; }
  catch { return false; }
}

module.exports = { queryCode, buildIndex, chunkSource, isAvailable, INDEX_DIR };
