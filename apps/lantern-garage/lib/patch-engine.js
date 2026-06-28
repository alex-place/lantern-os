/**
 * Patch Engine — Apply and validate unified diffs
 *
 * Parses unified diffs and applies them to files.
 * Validates patch syntax before application.
 */

const fs = require("fs").promises;
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../../../");

/**
 * Validate patch syntax before applying.
 * Checks for well-formed unified diff blocks.
 */
function validatePatch(patchText) {
  if (!patchText || typeof patchText !== "string") {
    return {
      valid: false,
      error: "Patch text is empty or not a string",
    };
  }

  // SEARCH/REPLACE blocks are a valid edit payload (applied by applySearchReplace).
  if (looksLikeSearchReplace(patchText)) {
    return { valid: true, type: "search-replace" };
  }

  const lines = patchText.split("\n");
  let hasFileHeader = false;
  let hasHunkHeader = false;
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect file headers (--- a/path +++ b/path)
    if (line.startsWith("---") && line.includes("a/")) {
      hasFileHeader = true;
    }

    if (line.startsWith("+++") && line.includes("b/")) {
      hasFileHeader = true;
    }

    // Detect hunk headers (@@ ... @@)
    if (line.match(/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/)) {
      hasHunkHeader = true;
    }

    // Check for invalid diff context
    if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-")) {
      // Valid diff line
    } else if (
      !line.startsWith("---") &&
      !line.startsWith("+++") &&
      !line.match(/^@@/) &&
      !line.startsWith("\\") &&
      line.trim().length > 0
    ) {
      // Could be valid context line or error
    }
  }

  if (!hasFileHeader && !hasHunkHeader) {
    // Might be raw file content or newfile format
    if (patchText.includes("newfile")) {
      return { valid: true, type: "newfile" };
    }
    // Could be a simple diff without headers
    if (
      patchText.includes("---") ||
      patchText.includes("+++") ||
      patchText.match(/^@@/)
    ) {
      return { valid: true, type: "partial" };
    }
    return { valid: false, error: "No valid diff headers found" };
  }

  return {
    valid: true,
    hasFileHeader,
    hasHunkHeader,
    lineCount: lines.length,
  };
}

/**
 * Parse unified diff into structured changes.
 */
function parsePatch(patchText) {
  const changes = [];
  const lines = patchText.split("\n");
  let currentFile = null;
  let currentLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // File header
    if (line.startsWith("---") && lines[i + 1]?.startsWith("+++")) {
      if (currentFile) {
        changes.push({
          file: currentFile,
          additions: currentLines.filter((l) => l.startsWith("+")).length,
          deletions: currentLines.filter((l) => l.startsWith("-")).length,
          lines: currentLines,
        });
        currentLines = [];
      }

      // Extract file path
      const match = lines[i + 1].match(/^\+\+\+ b\/(.+)$/);
      if (match) {
        currentFile = match[1];
      }
      i++; // Skip the +++ line
    } else if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-")) {
      currentLines.push(line);
    }
  }

  // Add last file
  if (currentFile && currentLines.length > 0) {
    changes.push({
      file: currentFile,
      additions: currentLines.filter((l) => l.startsWith("+")).length,
      deletions: currentLines.filter((l) => l.startsWith("-")).length,
      lines: currentLines,
    });
  }

  return changes;
}

// ── Search/Replace edit format ────────────────────────────────────────────────
// Content-matched edits — line-number-INDEPENDENT, so they survive the line-drift
// that breaks the unified-diff "manual" fallback below. This is the format the
// 2026 harness literature credits for large reliability gains (models emit it more
// accurately than unified diffs). Each block is:
//
//   path/to/file.js
//   <<<<<<< SEARCH
//   exact lines to find
//   =======
//   lines to replace them with
//   >>>>>>> REPLACE
//
// An empty SEARCH (or a file that does not exist yet) creates the file from the
// REPLACE body. See #1389 / docs/research/2026-06-28-keystone-chat-frontier-stack.md.

const SR_HEAD = /^<{5,}\s*SEARCH\s*$/;
const SR_DIV = /^={5,}\s*$/;
const SR_TAIL = /^>{5,}\s*REPLACE\s*$/;

/** Quick detector: does this text use the SEARCH/REPLACE format (vs a unified diff)? */
function looksLikeSearchReplace(text) {
  if (typeof text !== "string") return false;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines.some((l) => SR_HEAD.test(l.trim())) && lines.some((l) => SR_TAIL.test(l.trim()));
}

/** Extract a file path from a header-ish line, or null if it isn't one. Tolerates
 *  `path` backticks, a trailing colon, and a "File:"/"path:" prefix; rejects prose
 *  (anything with internal whitespace that isn't a recognised path). */
function _pathFrom(line) {
  let t = String(line).trim();
  if (!t) return null;
  const m = t.match(/^(?:file|path)\s*:\s*(.+)$/i);
  if (m) t = m[1].trim();
  t = t.replace(/^`+/, "").replace(/`+$/, "").replace(/:$/, "").trim();
  if (!t || /\s/.test(t)) return null;
  return t.includes("/") || /\.[A-Za-z0-9]+$/.test(t) ? t : null;
}

/** Parse SEARCH/REPLACE blocks into [{file, search, replace}]. The file path is
 *  the most recent path-like line above each block. */
function parseSearchReplace(text) {
  const out = [];
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let lastPath = null;
  while (i < lines.length) {
    if (SR_HEAD.test(lines[i].trim())) {
      const file = lastPath;
      i++;
      const search = [];
      while (i < lines.length && !SR_DIV.test(lines[i].trim())) search.push(lines[i++]);
      i++; // skip =======
      const replace = [];
      while (i < lines.length && !SR_TAIL.test(lines[i].trim())) replace.push(lines[i++]);
      i++; // skip >>>>>>> REPLACE
      out.push({ file, search: search.join("\n"), replace: replace.join("\n") });
    } else {
      const p = _pathFrom(lines[i]);
      if (p) lastPath = p;
      i++;
    }
  }
  return out;
}

/** Resolve a repo-relative path and guarantee it stays inside the sandbox (no
 *  traversal / absolute escape). Returns the absolute path, or null if unsafe. */
function _resolveSafe(repoPath, file) {
  const clean = String(file).replace(/^[ab]\//, "").replace(/\\/g, "/").replace(/^\/+/, "");
  const root = path.resolve(repoPath);
  const full = path.resolve(root, clean);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/** Find the first index where `needle` lines appear consecutively in `hay`. Exact
 *  first; if `trimmed`, compares lines ignoring leading/trailing whitespace (the
 *  fuzz that lets a block land despite indentation drift). -1 if absent. */
function _indexOfLines(hay, needle, trimmed) {
  if (!needle.length || needle.length > hay.length) return -1;
  const eq = trimmed ? (a, b) => a.trim() === b.trim() : (a, b) => a === b;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (!eq(hay[i + j], needle[j])) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

/** Apply one SEARCH→REPLACE to a string. Preserves EOL style + trailing newline.
 *  Empty SEARCH prepends REPLACE. Returns {ok, content} or {ok:false, reason}. */
function applySearchReplaceToContent(content, search, replace) {
  const eol = /\r\n/.test(content) ? "\r\n" : "\n";
  const norm = content.replace(/\r\n/g, "\n");
  const trailingNL = norm === "" || /\n$/.test(norm);
  const fileLines = norm.split("\n");
  if (norm.endsWith("\n")) fileLines.pop();

  const searchLines = search.replace(/\r\n/g, "\n").split("\n");
  if (searchLines.length && searchLines[searchLines.length - 1] === "") searchLines.pop();
  const replaceLines = replace.replace(/\r\n/g, "\n").split("\n");
  if (replaceLines.length && replaceLines[replaceLines.length - 1] === "") replaceLines.pop();

  if (searchLines.length === 0) {
    const merged = [...replaceLines, ...fileLines];
    return { ok: true, content: merged.join(eol) + (trailingNL ? eol : "") };
  }
  let at = _indexOfLines(fileLines, searchLines, false);
  if (at === -1) at = _indexOfLines(fileLines, searchLines, true);
  if (at === -1) return { ok: false, reason: "search-block-not-found" };
  const merged = [...fileLines.slice(0, at), ...replaceLines, ...fileLines.slice(at + searchLines.length)];
  return { ok: true, content: merged.join(eol) + (trailingNL ? eol : "") };
}

/** Apply SEARCH/REPLACE blocks to the repo. Same result shape as applyPatch:
 *  {success, method, filesChanged, changed, errors}. Blocks apply in order, so a
 *  later block sees an earlier block's write to the same file. */
async function applySearchReplace(patchText, repoPath = REPO_ROOT) {
  const blocks = parseSearchReplace(patchText);
  if (!blocks.length) return { success: false, error: "No SEARCH/REPLACE blocks found", changed: [], errors: [] };

  const changed = [];
  const errors = [];
  for (const b of blocks) {
    if (!b.file) { errors.push({ file: null, error: "block missing a file-path header" }); continue; }
    const full = _resolveSafe(repoPath, b.file);
    if (!full) { errors.push({ file: b.file, error: "path escapes repo sandbox" }); continue; }

    let existed = true;
    let content = "";
    try { content = await fs.readFile(full, "utf-8"); } catch { existed = false; }
    const searchEmpty = b.search.replace(/\r\n/g, "\n").trim() === "";

    let outContent;
    if (!existed) {
      if (!searchEmpty) { errors.push({ file: b.file, error: "file not found for non-empty SEARCH" }); continue; }
      outContent = b.replace.replace(/\r\n/g, "\n").replace(/\n*$/, "") + "\n"; // create from REPLACE
    } else {
      const r = applySearchReplaceToContent(content, b.search, b.replace);
      if (!r.ok) { errors.push({ file: b.file, error: r.reason, search: b.search.slice(0, 200) }); continue; }
      outContent = r.content;
    }
    try {
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, outContent, "utf-8");
      changed.push({ path: b.file, status: existed ? "M" : "A" });
    } catch (e) {
      errors.push({ file: b.file, error: e.message });
    }
  }
  return {
    success: errors.length === 0 && changed.length > 0,
    method: "search-replace",
    filesChanged: changed.length,
    changed,
    errors,
  };
}

/**
 * Apply patch to repository.
 * Auto-detects the SEARCH/REPLACE format (content-matched, line-drift-proof) and
 * dispatches to it; otherwise uses `git apply` for unified diffs, falling back to
 * manual application.
 */
async function applyPatch(patchText, repoPath = REPO_ROOT) {
  if (looksLikeSearchReplace(patchText)) return applySearchReplace(patchText, repoPath);
  const validation = validatePatch(patchText);
  if (!validation.valid && validation.type !== "newfile") {
    return {
      success: false,
      error: validation.error,
    };
  }

  const changed = [];

  try {
    // Try git apply first (most reliable)
    try {
      const result = execSync(`git apply --reject`, {
        cwd: repoPath,
        input: patchText,
        encoding: "utf-8",
      });

      // Get list of changed files from git status
      const status = execSync("git status --porcelain", {
        cwd: repoPath,
        encoding: "utf-8",
      });

      const files = status.split("\n").filter(Boolean);
      for (const file of files) {
        const match = file.match(/^.\s+(.+)$/);
        if (match) {
          changed.push({
            path: match[1],
            status: file.charAt(0),
          });
        }
      }

      return {
        success: true,
        method: "git apply",
        filesChanged: changed.length,
        changed,
      };
    } catch (gitError) {
      // Fall through to manual application
    }

    // Manual application for newfile or simple patches
    if (patchText.includes("newfile")) {
      const result = await applyNewfiles(patchText, repoPath);
      return result;
    }

    // Parse and apply line by line
    const changes = parsePatch(patchText);

    for (const change of changes) {
      const filePath = path.join(repoPath, change.file);

      try {
        // Read current file
        let content;
        try {
          content = await fs.readFile(filePath, "utf-8");
        } catch (e) {
          // File doesn't exist, might be a new file
          content = "";
        }

        // Apply changes
        const lines = content.split("\n");
        let lineIdx = 0;
        let applied = false;

        for (const diffLine of change.lines) {
          if (diffLine.startsWith("+")) {
            // Add line
            const newLine = diffLine.substring(1);
            lines.splice(lineIdx, 0, newLine);
            lineIdx++;
            applied = true;
          } else if (diffLine.startsWith("-")) {
            // Remove line
            const toRemove = diffLine.substring(1);
            if (lines[lineIdx] === toRemove) {
              lines.splice(lineIdx, 1);
            }
            applied = true;
          } else {
            // Context line
            lineIdx++;
          }
        }

        if (applied) {
          // Write back
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, lines.join("\n"), "utf-8");
          changed.push({
            path: change.file,
            status: "M",
          });
        }
      } catch (e) {
        return {
          success: false,
          error: `Failed to apply change to ${change.file}: ${e.message}`,
          partialChanges: changed,
        };
      }
    }

    return {
      success: true,
      method: "manual",
      filesChanged: changed.length,
      changed,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * Apply newfile format patches.
 */
async function applyNewfiles(patchText, repoPath = REPO_ROOT) {
  const changed = [];
  const blocks = patchText.split(/(?=^newfile\n)/m);

  for (const block of blocks) {
    if (!block.trim().startsWith("newfile")) continue;

    const lines = block.split("\n");
    const filePathLine = lines.find((l) => l && !l.startsWith("newfile"));

    if (!filePathLine) continue;

    const filePath = path.join(repoPath, filePathLine.trim());
    const contentStart = lines.findIndex((l) => !l && l !== lines[0]) + 1;
    const content = lines.slice(contentStart).join("\n");

    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf-8");
      changed.push({
        path: path.relative(repoPath, filePath),
        status: "A",
      });
    } catch (e) {
      return {
        success: false,
        error: `Failed to create file ${filePathLine}: ${e.message}`,
        partialChanges: changed,
      };
    }
  }

  return {
    success: true,
    method: "newfile",
    filesChanged: changed.length,
    changed,
  };
}

module.exports = {
  validatePatch,
  parsePatch,
  applyPatch,
  looksLikeSearchReplace,
  parseSearchReplace,
  applySearchReplace,
  applySearchReplaceToContent,
};
