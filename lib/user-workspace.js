"use strict";
/**
 * user-workspace.js — consent-gated non-repo file area for user artifacts.
 *
 * ADR-0008 §Decision 4: user documents (resumes, exports, downloads) must not
 * live in the repo sandbox. This module provides a separate root with its own
 * safe-path guard and the same operator/consent checks as the tool registry.
 *
 * Default root: ~/.keystone/workspace/
 * Override:     KEYSTONE_WORKSPACE env var
 *
 * The repo sandbox (_safe in tool-runner.js) is completely separate — neither
 * can escape into the other's tree.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const WORKSPACE_ROOT = path.resolve(
  process.env.KEYSTONE_WORKSPACE ||
  path.join(os.homedir(), ".keystone", "workspace")
);

// Ensure the workspace directory exists on first use.
function _ensureRoot() {
  if (!fs.existsSync(WORKSPACE_ROOT)) {
    fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  }
}

// Resolve a workspace-relative path; throw if it escapes the root.
function _safe(rel) {
  _ensureRoot();
  const abs = path.resolve(WORKSPACE_ROOT, String(rel == null ? "." : rel));
  if (abs !== WORKSPACE_ROOT && !abs.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  return abs;
}

/**
 * Write a file into the user workspace.
 * @param {string} relativePath  — e.g. "resumes/john-doe-2026.md"
 * @param {string|Buffer} content
 * @returns {string}  absolute path written
 */
function workspaceWrite(relativePath, content) {
  const abs = _safe(relativePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

/**
 * Read a file from the user workspace.
 * @param {string} relativePath
 * @returns {string} file contents
 */
function workspaceRead(relativePath) {
  const abs = _safe(relativePath);
  return fs.readFileSync(abs, "utf8");
}

/**
 * List entries at a workspace-relative directory path.
 * @param {string} [relativePath=""]  — defaults to root
 * @returns {Array<{name:string, type:'file'|'dir', size:number}>}
 */
function workspaceList(relativePath = "") {
  const abs = _safe(relativePath);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).map((e) => ({
    name: e.name,
    type: e.isDirectory() ? "dir" : "file",
    size: e.isFile() ? fs.statSync(path.join(abs, e.name)).size : 0,
  }));
}

/**
 * Check whether a workspace-relative path exists.
 */
function workspaceExists(relativePath) {
  try { return fs.existsSync(_safe(relativePath)); } catch { return false; }
}

/**
 * Delete a file from the workspace.
 */
function workspaceDelete(relativePath) {
  const abs = _safe(relativePath);
  fs.rmSync(abs, { force: true });
}

/**
 * Return the absolute workspace root for display purposes.
 */
function getWorkspaceRoot() {
  _ensureRoot();
  return WORKSPACE_ROOT;
}

module.exports = {
  workspaceWrite,
  workspaceRead,
  workspaceList,
  workspaceExists,
  workspaceDelete,
  getWorkspaceRoot,
  WORKSPACE_ROOT,
};
