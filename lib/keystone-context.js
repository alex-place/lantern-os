"use strict";
/**
 * unisona.ai live project context — links unisona.ai chat to the project's real tools
 * and details so any provider (incl. Grok) can answer grounded in GitHub + MCP.
 *
 * Gathers (best-effort, cached 60s):
 *   - open GitHub issues + PRs (via `gh`; the reliable path)
 *   - the MCP server's tool inventory + status (via callMcpTool; degrades if MCP down)
 *   - current branch
 * Returns a compact context block injected into unisona.ai's system prompt.
 *
 * Everything is best-effort: any failure is omitted, never thrown.
 */
const { execFile } = require("child_process");
const path = require("path");
const { callMcpTool, isMcpAvailable } = require("./mcp-bridge");

const REPO_ROOT = path.resolve(__dirname, "..");
const GH_REPO = process.env.GH_REPO || "alex-place/lantern-os";
const CACHE_MS = 60_000;

let _cache = { at: 0, text: "" };

function gh(args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile("gh", args, { cwd: REPO_ROOT, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

async function gatherProjectContext({ maxItems = 8 } = {}) {
  if (Date.now() - _cache.at < CACHE_MS && _cache.text) return _cache.text;

  const parts = [];

  // GitHub issues + PRs (primary "project details from github")
  const [issuesRaw, prsRaw] = await Promise.all([
    gh(["issue", "list", "--repo", GH_REPO, "--state", "open", "--limit", String(maxItems), "--json", "number,title,labels"]),
    gh(["pr", "list", "--repo", GH_REPO, "--state", "open", "--limit", String(maxItems), "--json", "number,title,headRefName"]),
  ]);
  try {
    const issues = issuesRaw ? JSON.parse(issuesRaw) : [];
    if (issues.length) {
      parts.push("Open GitHub issues:\n" + issues.map((i) =>
        `  #${i.number} ${i.title}${(i.labels || []).length ? " [" + i.labels.map((l) => l.name).join(",") + "]" : ""}`).join("\n"));
    }
  } catch { /* skip */ }
  try {
    const prs = prsRaw ? JSON.parse(prsRaw) : [];
    if (prs.length) {
      parts.push("Open PRs:\n" + prs.map((p) => `  #${p.number} ${p.title} (${p.headRefName})`).join("\n"));
    }
  } catch { /* skip */ }

  // MCP tool inventory + status (the "project tools"). The ONLINE/offline line is
  // driven by the REAL /health probe (isMcpAvailable), NOT by whether a specific
  // tool call returns data — conflating the two is what injected "MCP server:
  // offline" into the chat context while port 8771 was answering 200, which the
  // model then faithfully repeated. Skill inventory is best-effort enrichment
  // layered on top of a confirmed-online server.
  const online = await isMcpAvailable();
  if (online) {
    const skills = await callMcpTool("list_skills", {}, 6000);
    const skillNames = skills && (skills.skills || skills.result?.skills);
    parts.push("MCP server: ONLINE." +
      (Array.isArray(skillNames) ? ` Skills: ${skillNames.map((s) => s.name || s).slice(0, 12).join(", ")}.` : "") +
      " GitHub tools available via MCP (issues, PRs, repo ops).");
  } else {
    parts.push("MCP project tools are temporarily unavailable; GitHub operations still work. " +
      "If the user asks, say the project tools are reconnecting — never tell them to run a terminal command.");
  }

  // Current branch
  const branch = await gh(["rev-parse", "--abbrev-ref", "HEAD"], 4000)
    || await new Promise((r) => execFile("git", ["branch", "--show-current"], { cwd: REPO_ROOT, windowsHide: true }, (e, o) => r(e ? null : o)));
  if (branch) parts.push(`Current branch: ${branch.trim()}`);

  const text = parts.length
    ? `Live project context (GitHub + MCP), as of now — use it; do not say you lack repo access:\n\n${parts.join("\n\n")}`
    : "";
  _cache = { at: Date.now(), text };
  return text;
}

module.exports = { gatherProjectContext };
