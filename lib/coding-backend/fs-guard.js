"use strict";

// Sandbox containment guard for proposal file paths.
//
// A coding backend's proposal is untrusted (LLM-influenced) output. Both the
// verifier's tests-run layer (which materialises the proposal to run tests) and
// approveCodingPatch (which writes it on approval) join the proposal-relative
// `path` onto the repo root. Without a containment check, a `../…`, an absolute
// path, or a symlink whose target leaves the repo would let a proposal write
// OUTSIDE the repo — the verifier whose job is to sandbox the proposal would be
// the escape hatch. This resolves a proposal path and REFUSES anything that
// escapes the repo root.

const fs = require("fs");
const path = require("path");

// Returns { ok:true, abs } for a contained path, or { ok:false, reason } if it
// escapes repoPath via '..', an absolute path, a symlink at the target, or a
// symlinked parent directory that resolves outside the repo.
function resolveInsideRepo(repoPath, relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    return { ok: false, reason: `invalid path: ${JSON.stringify(relPath)}` };
  }
  let root;
  try {
    root = fs.realpathSync(repoPath);
  } catch {
    root = path.resolve(repoPath);
  }
  const abs = path.resolve(root, relPath);
  const rel = path.relative(root, abs);
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    return { ok: false, reason: `path escapes repo: ${relPath}` };
  }
  // An existing symlink at the target is a write-through escape.
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) return { ok: false, reason: `path is a symlink: ${relPath}` };
  } catch {
    /* target doesn't exist yet — fine, it'll be created inside root */
  }
  // A symlinked parent directory whose real path leaves the repo is also an escape.
  try {
    const parentReal = fs.realpathSync(path.dirname(abs));
    const prel = path.relative(root, parentReal);
    if (prel !== "" && (prel === ".." || prel.startsWith(".." + path.sep) || path.isAbsolute(prel))) {
      return { ok: false, reason: `parent dir escapes repo: ${relPath}` };
    }
  } catch {
    /* parent doesn't exist yet — mkdir will create it inside root */
  }
  return { ok: true, abs };
}

module.exports = { resolveInsideRepo };
