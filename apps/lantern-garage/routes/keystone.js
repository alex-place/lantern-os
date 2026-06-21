/**
 * Keystone Debug Agent — server-side execution routes
 *
 * Lets the Keystone persona actually DO things from the dream chat UX:
 * run tests, git status, commit, push, open PRs, read files, run scripts.
 *
 * Operator-gated (#837): only the local operator dashboard (un-proxied loopback) or a caller
 * presenting the OPERATOR_TOKEN header may invoke these. Commands are allowlisted; `node -e`
 * (arbitrary JS) is intentionally NOT allowed.
 */
const { tokenizeCommand, safeExec } = require("../lib/safe-exec");
const { isOperatorRequest } = require("../lib/request-auth");

const MAX_OUTPUT = 4000;

// The allowlist + resolver live in the shared lib/command-allowlist so the dream-chat
// tool registry (lib/tool-runner.js) runs Bash through the SAME single policy (#873).
const { ALLOWED, resolveCommand } = require("../lib/command-allowlist");

module.exports = async function keystoneRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, repoRoot } = deps;

  // #837: command execution + repo-state dump are operator-only. The local operator dashboard
  // hits loopback un-proxied; remote callers need the OPERATOR_TOKEN header. Without this the
  // allowlisted-but-porous exec (shell, capture groups) was unauthenticated RCE.
  if (url.pathname.startsWith("/api/keystone/") && !isOperatorRequest(req)) {
    sendJson(res, { error: "operator auth required" }, 403);
    return true;
  }

  // POST /api/keystone/exec — run an allowlisted command
  if (url.pathname === "/api/keystone/exec" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const { command } = JSON.parse(raw || "{}");
      const cmd = String(command || "").trim();

      if (!cmd) {
        sendJson(res, { error: "empty_command" }, 400);
        return true;
      }

      const resolved = resolveCommand(cmd);
      if (!resolved) {
        sendJson(res, {
          error: "command_not_allowed",
          message: `Keystone can only run allowlisted commands. "${cmd}" is not permitted.`,
          allowed_patterns: ALLOWED.map(a => a.match.source),
        }, 403);
        return true;
      }

      const output = safeExec(tokenizeCommand(resolved), {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });

      sendJson(res, {
        ok: true,
        command: cmd,
        output: output.slice(0, MAX_OUTPUT),
        truncated: output.length > MAX_OUTPUT,
      });
    } catch (err) {
      sendJson(res, {
        ok: false,
        command: String(err.cmd || ""),
        error: String(err.stderr || err.message || "").slice(0, MAX_OUTPUT),
        output: String(err.stdout || "").slice(0, MAX_OUTPUT),
        exit_code: err.status,
      });
    }
    return true;
  }

  // GET /api/keystone/status — quick repo state dump
  if (url.pathname === "/api/keystone/status" && req.method === "GET") {
    try {
      const git_status = safeExec(["git", "status", "--short"], { cwd: repoRoot, encoding: "utf-8", timeout: 5000 }).trim();
      // `git branch --show-current` is empty on a detached HEAD (CI checks out PRs detached),
      // which left `branch` blank. Fall back to the CI head-ref env vars, then the short SHA,
      // so the field is always a meaningful non-empty label.
      let branch = safeExec(["git", "branch", "--show-current"], { cwd: repoRoot, encoding: "utf-8", timeout: 5000 }).trim();
      if (!branch) {
        branch = (process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "").trim()
          || safeExec(["git", "rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf-8", timeout: 5000 }).trim()
          || "detached";
      }
      const log = safeExec(["git", "log", "--oneline", "-5"], { cwd: repoRoot, encoding: "utf-8", timeout: 5000 }).trim();
      const test_count = "Run: npm test or node tests/test_dream_journal_api.js + test_dream_journal_chat.js + test_dream_chat_multiturns.js + test_dream_journal_keystone.js";

      sendJson(res, {
        branch,
        dirty_files: git_status.split("\n").filter(Boolean).length,
        git_status: git_status.slice(0, 1000),
        recent_commits: log,
        tests: test_count,
        providers: ["GEMINI_API_KEY","ANTHROPIC_API_KEY","OPENAI_API_KEY","XAI_API_KEY"]
          .reduce((o, k) => { o[k] = !!process.env[k]; return o; }, {}),
      });
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }
};
