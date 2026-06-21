"use strict";

/**
 * safe-exec — run allowlisted commands WITHOUT a shell.
 *
 * The self-edit engine and the Keystone operator console both execute
 * allowlisted command strings. Running them through `execSync` (a shell) meant a
 * capture group like `git commit -m "(.+)"` or `pytest tests/(.+).py` could carry
 * `;`, `$(…)`, backticks, `|`, `>` etc. and inject arbitrary commands (#873).
 *
 * This module removes the shell entirely:
 *   tokenizeCommand() splits a command string into an argv array, honouring
 *     simple quotes and REJECTING any token that contains a shell metacharacter;
 *   safeExec() runs argv[0] with execFileSync({ shell:false }) so no token is
 *     ever re-interpreted by a shell.
 *
 * Defence in depth: the per-call allowlist still gates *which* commands run; this
 * guarantees that even an allowlisted-but-porous pattern can't escape to a shell.
 */

const { execFileSync } = require("child_process");

// Any of these in a token => refuse. Covers command chaining, substitution,
// redirection, globbing, history expansion, and escapes.
const SHELL_META = /[;&|`$(){}\[\]<>!*?~#\\]/;

// npm/npx/yarn/pnpm are `.cmd` shims on Windows; execFileSync can't launch a
// `.cmd` without a shell (Node blocks it since the 2024 spawn hardening), so we
// run them via `cmd.exe /c` with the tokens passed as DISCRETE argv entries —
// no shell string is built, and the tokens are already metacharacter-free.
const WIN_CMD_SHIMS = new Set(["npm", "npx", "yarn", "pnpm"]);

/**
 * Split a command string into argv. Quoted spans ("…" or '…') become one token.
 * Throws on shell metacharacters or unbalanced quotes.
 * @returns {string[]}
 */
function tokenizeCommand(cmd) {
  if (typeof cmd !== "string") throw new Error("invalid_command");
  const tokens = [];
  let cur = "";
  let inQuote = false;
  let quoteChar = null;
  let quotedToken = false; // this token came (at least partly) from a quoted span

  const flush = () => {
    if (cur === "" && !quotedToken) return;
    // Metacharacters are rejected even inside quotes — these commands never need
    // them, and a quoted `$(…)` is still dangerous if it ever reaches a shell.
    if (SHELL_META.test(cur)) throw new Error("shell_metacharacter_in_token: " + cur);
    tokens.push(cur);
    cur = "";
    quotedToken = false;
  };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (!inQuote && (ch === '"' || ch === "'")) {
      inQuote = true;
      quoteChar = ch;
      quotedToken = true;
    } else if (inQuote && ch === quoteChar) {
      inQuote = false;
      quoteChar = null;
    } else if (!inQuote && /\s/.test(ch)) {
      flush();
    } else {
      cur += ch;
    }
  }
  if (inQuote) throw new Error("unbalanced_quotes");
  flush();
  return tokens;
}

/**
 * Execute an argv array with no shell. Returns stdout (string, encoding utf8).
 * Throws the usual execFileSync error (with .stdout/.stderr/.status) on failure.
 * @param {string[]} argv
 * @param {object} [opts] execFileSync options (cwd, env, timeout, maxBuffer, encoding…)
 */
function safeExec(argv, opts = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("empty_command");
  const [bin, ...args] = argv;
  const options = {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 1024 * 1024,
    ...opts,
    shell: false, // never overridable — this is the whole point
  };
  if (process.platform === "win32" && WIN_CMD_SHIMS.has(bin)) {
    return execFileSync("cmd.exe", ["/c", bin, ...args], options);
  }
  return execFileSync(bin, args, options);
}

module.exports = { tokenizeCommand, safeExec, SHELL_META };
