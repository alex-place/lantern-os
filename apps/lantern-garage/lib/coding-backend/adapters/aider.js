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

// Resolve the aider binary: an explicit AIDER_BIN (full path, e.g. an isolated venv)
// wins over a PATH lookup — so a locally-installed aider can drive the benchmark
// without polluting the global PATH.
function _bin() {
  return process.env.AIDER_BIN || "aider";
}
function _has(cmd) {
  if (cmd.includes("/") || cmd.includes("\\")) {
    try { return fs.existsSync(cmd); } catch { return false; }
  }
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  name: "aider",
  installHint: "pipx install aider-chat  (then: ollama pull qwen2.5-coder)",
  async available() {
    return _has(_bin());
  },
  async propose({ task, repoPath, model }) {
    const AIDER = _bin();
    if (!_has(AIDER)) return { ok: false, error: "aider not installed" };
    const git = (args) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
    const changed = [];
    // Serve the registry-resolved local engine (#2171 → Qwen2.5-Coder via Ollama).
    const aiderModel = model ? `ollama_chat/${String(model).replace(/:latest$/, "")}` : null;
    const env = {
      ...process.env,
      OLLAMA_API_BASE: process.env.OLLAMA_API_BASE || "http://127.0.0.1:11434",
      AIDER_ANALYTICS: "false",
    };
    try {
      // shell:false via execFile; --no-auto-commits so nothing lands yet (held for approval)
      const args = ["--message", String(task), "--yes", "--no-auto-commits", "--no-check-update"];
      if (aiderModel) args.push("--model", aiderModel);
      await pexec(AIDER, args, { cwd: repoPath, env, timeout: 180000, maxBuffer: 1 << 24 });
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
      // Revert EVERYTHING aider did so the proposal is genuinely HELD, not applied.
      // aider STAGES files it creates, so `reset` unstages; `checkout` reverts tracked
      // edits; `clean` removes untracked/new files. Each is independently fault-tolerant
      // so one failing (e.g. `checkout` in an empty repo with no HEAD) can't skip `clean`.
      const _try = (args) => { try { git(args); } catch { /* best effort */ } };
      _try(["reset", "-q"]);
      _try(["checkout", "--", "."]);
      _try(["clean", "-fdq"]);
    }
    if (!changed.length) return { ok: false, error: "aider produced no changes" };
    return {
      ok: true,
      backend: "aider",
      model: aiderModel || "(aider-configured)",
      costUsd: null,
      filesChanged: changed,
      patchPreview: changed.map((c) => `+++ b/${c.path}`).join("\n"),
    };
  },
};
