/**
 * Repo Context — File search and grounding for Keystone Kernel
 *
 * Provides:
 * - searchRepoFiles(query) — find relevant files
 * - readFileContent(path) — read file with caching
 * - resolveRepoPath(relativePath) — resolve to absolute path
 */

const fs = require("fs").promises;
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../../../");
const DATA_DIR = path.join(REPO_ROOT, "data");
const SRC_DIR = path.join(REPO_ROOT, "src");
const APPS_DIR = path.join(REPO_ROOT, "apps");
const TESTS_DIR = path.join(REPO_ROOT, "tests");

// Simple file cache to avoid repeated reads
const fileCache = new Map();
const CACHE_TTL = 60000; // 1 minute

// File patterns to prioritize in search
const PRIORITY_PATTERNS = [
  /\.js$/,
  /\.py$/,
  /\.json$/,
  /\.md$/,
  /test_.*\.py$/,
  /.*\.test\.js$/,
];

// Files to exclude from search
const EXCLUDE_PATTERNS = [
  /node_modules/,
  /__pycache__/,
  /\.pyc$/,
  /\.git/,
  /\.env/,
  /\.pem$/,
  /\.key$/,
  /\.csf$/,
  /venv\//,
  /\.pytest_cache/,
  /\.vscode/,
];

// ── Code-aware retrieval (#1200) ─────────────────────────────────────────────
// The legacy scorer matched only the filename/path, so a task like "fix paginate()"
// never found the file that *defines* paginate unless its name said so. We now also
// index the SYMBOLS each source file declares (functions/classes/consts/exports) and
// boost files whose symbols match the query — the core "code-aware" signal.
const CODE_FILE_RE = /\.(js|mjs|cjs|ts|tsx|jsx|py)$/;
const SYMBOL_INDEX_TTL = 5 * 60_000;
let _symbolIndex = null;        // { ts, map: Map<file, Set<symbol>> }

/**
 * @typedef {object} EvidencePacket
 * @property {string} file - The relative path to the file.
 * @property {number} score

// Pure: extract declared symbol names from source text (JS + Python). Regex-level
// (no full parse) — fast and good enough to rank files by what they define.
function extractSymbols(content) {
  const out = new Set();
  if (!content) return out;
  const add = (m) => { if (m && m.length > 1) out.add(m); };
  const patterns = [
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,              // function foo
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, // const foo =
    /\bclass\s+([A-Za-z_$][\w$]*)/g,                 // class Foo (JS+PY)
    /\bdef\s+([A-Za-z_][\w]*)/g,                      // def foo (PY)
    /\bexports\.([A-Za-z_$][\w$]*)/g,                // exports.foo
    /^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm,     // method foo(...) {
    /\b([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\()/g, // foo: function / foo: (
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(content)) !== null) add(m[1]);
  }
  return out;
}

// Pure: identifier-ish tokens from a free-text query (so "fix paginate() off-by-one"
// yields paginate/fix/off/by/one). Used for symbol matching.
function queryTokens(query) {
  return [...new Set(String(query || "").toLowerCase().match(/[a-z_$][\w$]*/g) || [])]
    .filter((t) => t.length >= 3);
}

// Pure: score files by how well their declared symbols match the query. Returns a
// Map<file, score>. Exact symbol == query token is a strong signal; substring weaker.
function scoreBySymbols(query, symbolMap) {
  const tokens = queryTokens(query);
  const scores = new Map();
  if (!tokens.length) return scores;

  // lowercased symbol set per file + document frequency of each exact token, so we
  // can down-weight generic names (verify/gate/run) that are defined everywhere.
  const fileLower = new Map();
  for (const [file, symbols] of symbolMap) {
    fileLower.set(file, new Set([...symbols].map((s) => s.toLowerCase())));
  }
  const df = new Map();
  for (const tok of tokens) {
    let c = 0;
    for (const syms of fileLower.values()) if (syms.has(tok)) c++;
    df.set(tok, c);
  }
  const exactWeight = (tok) => {
    const d = df.get(tok) || 0;
    if (d <= 2) return 40;   // rare, specific identifier — strong signal
    if (d <= 6) return 18;   // somewhat common
    return 6;                // generic name (verify/gate/run) — weak
  };

  for (const [file, syms] of fileLower) {
    let s = 0;
    for (const tok of tokens) {
      if (syms.has(tok)) { s += exactWeight(tok); continue; } // exact symbol match
      for (const sym of syms) {
        if (sym.length >= 5 && (sym.includes(tok) || tok.includes(sym))) {
          s += 10; break;                                     // partial match (once/token)
        }
      }
    }
    if (s > 0) scores.set(file, s);
  }
  return scores;
}

// Build (and cache) the file→symbols index over tracked code files. Bounded reads;
// best-effort — any failure leaves the index empty and search falls back to filenames.
function buildSymbolIndex(gitFiles, readFileSync, maxBytes = 200_000) {
  if (_symbolIndex && Date.now() - _symbolIndex.ts < SYMBOL_INDEX_TTL) return _symbolIndex.map;
  const map = new Map();
  for (const f of gitFiles) {
    if (!CODE_FILE_RE.test(f) || EXCLUDE_PATTERNS.some((p) => p.test(f))) continue;
    try {
      const abs = path.join(REPO_ROOT, f);
      const content = readFileSync(abs, "utf-8");
      if (content.length > maxBytes) continue;
      const syms = extractSymbols(content);
      if (syms.size) map.set(f, syms);
    } catch (_e) { /* skip unreadable */ }
  }
  _symbolIndex = { ts: Date.now(), map };
  return map;
}

/**
 * Search repository for files matching a query.
 * Uses git ls-files for speed, falls back to directory scan.
 */
async function searchRepoFiles(query, maxResults = 10) {
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

  try {
    // Try git ls-files for speed
    const gitFiles = execSync("git ls-files", {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    })
      .split("\n")
      .filter(Boolean);

    // #1200 code-aware signal: symbol-match scores for files that DECLARE a symbol
    // named in the query (even when the filename doesn't). Best-effort + cached.
    let symbolScores = new Map();
    try {
      symbolScores = scoreBySymbols(query, buildSymbolIndex(gitFiles, require("fs").readFileSync));
    } catch (_e) { /* fall back to filename/path scoring */ }

    // Score files based on keyword matches
    const scored = gitFiles
      .filter((f) => !EXCLUDE_PATTERNS.some((p) => p.test(f)))
      .map((file) => {
        let score = 0;

        // Keyword matches in filename
        const filename = path.basename(file).toLowerCase();
        for (const kw of keywords) {
          if (filename.includes(kw)) score += 10;
        }

        // Keyword matches in path
        const filePath = file.toLowerCase();
        for (const kw of keywords) {
          if (filePath.includes(kw)) score += 5;
        }

        // Code-aware: declared-symbol matches (the #1200 lift)
        score += symbolScores.get(file) || 0;

        // Boost priority file types
        if (PRIORITY_PATTERNS.some((p) => p.test(file))) score += 2;

        // Prefer shorter paths (more likely to be relevant)
        score -= file.split("/").length * 0.1;

        return { path: file, score };
      })
      .filter((f) => f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    return scored;
  } catch (e) {
    // Fallback: directory scan (slower)
    return await scanDirectory(REPO_ROOT, query, maxResults);
  }
}

/**
 * Scan directory recursively (fallback for non-git repos).
 */
async function scanDirectory(dir, query, maxResults = 10, depth = 0) {
  if (depth > 5) return []; // Prevent deep recursion

  const results = [];
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (EXCLUDE_PATTERNS.some((p) => p.test(entry.name))) continue;

      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(REPO_ROOT, fullPath);

      if (entry.isDirectory()) {
        results.push(...(await scanDirectory(fullPath, query, maxResults, depth + 1)));
      } else if (entry.isFile()) {
        let score = 0;
        for (const kw of keywords) {
          if (entry.name.toLowerCase().includes(kw)) score += 10;
          if (relPath.toLowerCase().includes(kw)) score += 5;
        }

        if (score > 0) {
          results.push({ path: relPath, score });
        }
      }

      if (results.length >= maxResults) break;
    }
  } catch (e) {
    // Silently skip unreadable directories
  }

  return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

/**
 * Read file content with caching.
 * Respects .gitignore and size limits.
 */
async function readFileContent(filePath, maxSize = 100000) {
  const absPath = resolveRepoPath(filePath);

  // Check cache
  const cached = fileCache.get(absPath);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.content;
  }

  try {
    const stats = await fs.stat(absPath);

    // Skip binary files and huge files
    if (stats.size > maxSize) {
      return `[File too large: ${stats.size} bytes]\n`;
    }

    const content = await fs.readFile(absPath, "utf-8");

    // Cache the result
    fileCache.set(absPath, {
      content,
      timestamp: Date.now(),
    });

    return content;
  } catch (e) {
    throw new Error(`Failed to read ${filePath}: ${e.message}`);
  }
}

/**
 * Resolve a relative path to absolute within repo.
 * Handles various path formats.
 */
function resolveRepoPath(filePath) {
  // Already absolute
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  // Relative to repo root
  const absPath = path.join(REPO_ROOT, filePath);

  // Check if file exists
  try {
    fs.statSync(absPath);
    return absPath;
  } catch (e) {
    // Try common directories
    for (const dir of [SRC_DIR, APPS_DIR, TESTS_DIR, DATA_DIR]) {
      const candidate = path.join(dir, filePath);
      try {
        fs.statSync(candidate);
        return candidate;
      } catch (e2) {
        // Try next directory
      }
    }

    // Return best guess
    return absPath;
  }
}

/**
 * List all issues from git issue tracker or local files.
 */
async function listIssues(pattern = "") {
  const issues = [];

  // Try to get issues from GitHub via git (if available)
  try {
    const remoteUrl = execSync("git config --get remote.origin.url", {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    }).trim();

    if (remoteUrl.includes("github.com")) {
      // Extract owner/repo
      const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/);
      if (match) {
        // Return format hint for user to fetch from GitHub
        return {
          source: "github",
          repo: `${match[1]}/${match[2]}`,
          instruction:
            "Use `gh issue list --state open` to fetch real issues from GitHub",
        };
      }
    }
  } catch (e) {
    // Not a GitHub repo or git not available
  }

  // Fallback: scan for open-issues.md or TODO comments
  try {
    const openIssuesPath = path.join(REPO_ROOT, "docs", "open-issues.md");
    const content = await fs.readFile(openIssuesPath, "utf-8");

    // Simple extraction of issue lines
    const lines = content.split("\n");
    for (const line of lines) {
      if (
        line.includes("#") &&
        (line.includes("TODO") || line.includes("FIXME") || line.includes("BUG"))
      ) {
        issues.push({
          type: "todo",
          text: line.trim(),
        });
      }
    }
  } catch (e) {
    // File not found
  }

  return issues;
}

module.exports = {
  searchRepoFiles,
  readFileContent,
  resolveRepoPath,
  listIssues,
  REPO_ROOT,
  // #1200 code-aware retrieval internals (pure — exported for tests/reuse)
  extractSymbols,
  queryTokens,
  scoreBySymbols,
  buildSymbolIndex,
};
