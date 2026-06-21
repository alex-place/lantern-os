const fs = require("fs");
const path = require("path");

const writeQueues = new Map();

function enqueueFileWrite(filePath, operation) {
  const previous = writeQueues.get(filePath) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(operation)
    .finally(() => {
      if (writeQueues.get(filePath) === next) {
        writeQueues.delete(filePath);
      }
    });
  writeQueues.set(filePath, next);
  return next;
}

// Default rotation caps (env-tunable), shared by the hot-path callers that opt in. #872
const JSONL_MAX_BYTES = Number(process.env.JSONL_MAX_BYTES) || 5 * 1024 * 1024;
const JSONL_KEEP_ARCHIVES = Number(process.env.JSONL_KEEP_ARCHIVES) || 5;

// opts.rotate (truthy, or {maxBytes,keepArchives}) bounds the file's growth AFTER the
// append, reusing the same per-path queue so the rename never interleaves. Existing
// callers (no opts) are unchanged — rotation is opt-in per #872 so the ~30 append
// sites don't all change behavior at once.
async function appendJsonlQueued(filePath, record, opts = {}) {
  const line = `${JSON.stringify(record)}\n`;
  const result = await enqueueFileWrite(filePath, async () => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.appendFile(filePath, line, "utf8");
  });
  if (opts.rotate) {
    const cfg = opts.rotate === true
      ? { maxBytes: JSONL_MAX_BYTES, keepArchives: JSONL_KEEP_ARCHIVES }
      : opts.rotate;
    await rotateJsonlIfNeeded(filePath, cfg);
  }
  return result;
}

// Convenience: append + bound growth with the default (or supplied) caps.
async function appendJsonlRotating(filePath, record, rotateOpts = {}) {
  return appendJsonlQueued(filePath, record, { rotate: rotateOpts || {} });
}

async function rotateJsonlIfNeeded(filePath, { maxBytes = 5 * 1024 * 1024, keepArchives = 5 } = {}) {
  // Bound append-only growth (#771). Runs INSIDE the per-path write queue so a rename can
  // never interleave with an in-flight append. Past maxBytes the current file is renamed to
  // a timestamped archive (`<base>.<ISO>`); the next append recreates a fresh file. Old
  // archives beyond keepArchives are pruned (oldest first).
  return enqueueFileWrite(filePath, async () => {
    let size;
    try {
      size = (await fs.promises.stat(filePath)).size;
    } catch {
      return { rotated: null, pruned: 0 };          // nothing to rotate yet
    }
    if (size < maxBytes) {
      return { rotated: null, pruned: 0 };
    }
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let archive = path.join(dir, `${base}.${stamp}`);
    for (let n = 1; fs.existsSync(archive); n += 1) {  // avoid clobber within the same ms
      archive = path.join(dir, `${base}.${stamp}.${n}`);
    }
    await fs.promises.rename(filePath, archive);
    let pruned = 0;
    const archives = (await fs.promises.readdir(dir))
      .filter((name) => name.startsWith(`${base}.`) && name !== base)
      .sort();                                        // ISO stamp prefix → chronological
    for (let i = 0; i < archives.length - keepArchives; i += 1) {
      try {
        await fs.promises.unlink(path.join(dir, archives[i]));
        pruned += 1;
      } catch { /* best-effort prune */ }
    }
    return { rotated: path.basename(archive), pruned };
  });
}

async function writeTextQueued(filePath, text) {
  return enqueueFileWrite(filePath, async () => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, text, "utf8");
  });
}

function readText(relativePath, fallback = "") {
  try {
    return fs.readFileSync(path.join(path.resolve(__dirname, "..", "..", ".."), relativePath), "utf8").replace(/^\uFEFF/, "");
  } catch {
    return fallback;
  }
}

function readJson(relativePath, fallback = null) {
  try {
    return JSON.parse(readText(relativePath));
  } catch {
    return fallback;
  }
}

function readJsonl(relativePath, limit = 20) {
  return readText(relativePath)
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { parseError: true, raw: line };
      }
    });
}

module.exports = {
  enqueueFileWrite,
  appendJsonlQueued,
  appendJsonlRotating,
  rotateJsonlIfNeeded,
  JSONL_MAX_BYTES,
  JSONL_KEEP_ARCHIVES,
  writeTextQueued,
  readText,
  readJson,
  readJsonl,
};
