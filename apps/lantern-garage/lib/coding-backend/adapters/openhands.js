"use strict";

// OpenHands adapter — wraps the OSS OpenHands agent (MIT) as a coding backend.
// See docs/OSS-BASELINE.md: OpenHands is the top "stand-on" execution backend —
// best headless story, uses LiteLLM → 100+ providers incl. Ollama, SWE-bench Verified 72%.
//
// Contract (identical to the Aider adapter): propose() runs OpenHands headless in the
// repo WITHOUT committing, captures the new contents of changed files, then REVERTS the
// working tree — so the change is HELD as a proposal and applied only on approval through
// the control plane. A raw agent applies+commits immediately; the control plane makes it
// propose-then-approve and attaches a receipt.
//
// NOTE: exercised only when `openhands` is on PATH — available() gates it, so the
// mock-backed tests never shell out. The exact headless flags are version-dependent
// (untested here since OpenHands isn't installed); adjust per the installed version.
// Install to activate: `pip install openhands-ai` (or pipx). It serves the registry-
// resolved local engine (Qwen2.5-Coder, #2171) via LiteLLM/Ollama.

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
  name: "openhands",
  installHint: "pip install openhands-ai  (serves the local engine via LiteLLM/Ollama)",
  async available() {
    return _has("openhands");
  },
  async propose({ task, repoPath, model }) {
    if (!_has("openhands")) return { ok: false, error: "openhands not installed" };
    const git = (args) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
    const changed = [];

    // Point OpenHands' LiteLLM at the registry-resolved local engine (#2171 → Qwen via
    // Ollama). LiteLLM ollama naming: `ollama/<model>`.
    const litellmModel = model ? `ollama/${String(model).replace(/:latest$/, "")}` : null;
    const env = { ...process.env };
    if (litellmModel) {
      env.LLM_MODEL = litellmModel;
      env.LLM_BASE_URL = env.LLM_BASE_URL || "http://127.0.0.1:11434";
    }

    try {
      // headless single task; OpenHands edits the working tree → we capture + revert.
      await pexec("openhands", ["--headless", "-t", String(task)], {
        cwd: repoPath,
        env,
        timeout: 300000,
        maxBuffer: 1 << 25,
      });
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
      // Revert EVERYTHING (staged/unstaged/untracked) so the proposal is genuinely HELD.
      // Each op independently fault-tolerant so `checkout` failing (empty repo) can't skip `clean`.
      const _try = (args) => { try { git(args); } catch { /* best effort */ } };
      _try(["reset", "-q"]);
      _try(["checkout", "--", "."]);
      _try(["clean", "-fdq"]);
    }
    if (!changed.length) return { ok: false, error: "openhands produced no changes" };
    return {
      ok: true,
      backend: "openhands",
      model: litellmModel || "(openhands-configured)",
      costUsd: null,
      filesChanged: changed,
      patchPreview: changed.map((c) => `+++ b/${c.path}`).join("\n"),
    };
  },
};
