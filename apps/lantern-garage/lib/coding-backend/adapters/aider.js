"use strict";

// Aider adapter — wraps the OSS Aider CLI (Apache-2.0) as a coding backend.
// See docs/OSS-BASELINE.md: Aider is a "stand-on" component (best diff engine).
//
// Contract: propose() RUNS aider without committing, captures the new contents of
// changed files, then REVERTS the working tree — so the change is HELD as a proposal,
// never applied until the user approves it through the control plane. This is the whole
// point: a raw coding agent applies+commits immediately; the control plane makes it
// propose-then-approve and attaches a receipt.
//
// NOTE: exercised only when `aider` is on PATH. available() gates it, so the mock-backed
// tests never shell out. Install to activate: `pipx install aider-chat` (+ a local coder
// via `ollama pull qwen2.5-coder`, per the baseline's ship-on-Qwen decision).

const { execFile, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const util = require("util");
const pexec = util.promisify(execFile);

function _has(cmd) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  name: "aider",
  installHint: "pipx install aider-chat  (then: ollama pull qwen2.5-coder)",
  async available() {
    return _has("aider");
  },
  async propose({ task, repoPath }) {
    if (!_has("aider")) return { ok: false, error: "aider not installed" };
    const git = (args) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
    const changed = [];
    try {
      // shell:false via execFile; no --auto-commit so nothing lands yet
      await pexec(
        "aider",
        ["--message", String(task), "--yes", "--no-auto-commit"],
        { cwd: repoPath, timeout: 180000, maxBuffer: 1 << 24 }
      );
      const status = git(["status", "--porcelain"]).split(/\r?\n/).filter(Boolean);
      for (const line of status) {
        const rel = line.slice(3).trim();
        try {
          changed.push({ path: rel, content: fs.readFileSync(path.join(repoPath, rel), "utf8") });
        } catch {
          /* deleted/binary — skip from the content proposal */
        }
      }
    } finally {
      // revert so the proposal is HELD, not applied
      try {
        git(["checkout", "--", "."]);
        git(["clean", "-fd"]);
      } catch {
        /* best effort */
      }
    }
    if (!changed.length) return { ok: false, error: "aider produced no changes" };
    return {
      ok: true,
      backend: "aider",
      model: "(aider-configured)",
      costUsd: null,
      filesChanged: changed,
      patchPreview: changed.map((c) => `+++ b/${c.path}`).join("\n"),
    };
  },
};
