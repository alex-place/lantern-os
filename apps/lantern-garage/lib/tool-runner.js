"use strict";
/**
 * tool-runner.js — one canonical tool registry for the local Σ₀ Ouro coder in chat.
 * ADR-0008: capabilities are Tools in this registry — advertised == executed == trainable.
 *
 * CONSISTENCY RULE (how Claude Code / OpenAI / any tool-calling LLM works): a tool is
 * defined ONCE — name + input_schema + executor + policy — and that single definition
 * both (a) renders the prompt preamble and (b) dispatches execution. The names here are
 * the EXACT names the adapter was trained on (harvested Claude Code sessions: Read, LS,
 * Glob, Grep, Bash, PowerShell, Write, Edit), so advertised == emitted == executed.
 * No name canonicalization, no input-key aliasing, no per-tool mappers — those were
 * patches over a vocabulary mismatch (an invented read_file/list_dir set). Removed.
 *
 * The only adapter we keep is parseToolCall(): the local model emits a <tool_call> as
 * free text rather than a native tool_use block, so the proxy parses it (with light
 * JSON repair). That's the equivalent of the API layer parsing model output — not a hack.
 *
 * POLICY (per-tool, enforced uniformly):
 *   read     (Read/LS/Glob/Grep)        — execute, repo-sandboxed.
 *   shell    (Bash/PowerShell)          — execute via the SHARED allowlist + safe-exec
 *                                          (lib/command-allowlist + lib/safe-exec); OPERATOR only.
 *   mutating (Write/Edit)               — execute, repo-sandboxed; OPERATOR only.
 * The master on/off switch (CHAT_TOOL_EXEC) is enforced by the caller (stream-chat).
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { tokenizeCommand, safeExec } = require("./safe-exec");
const { resolveCommand } = require("./command-allowlist");
const { webSearch } = require("./web-search-client");
const { render: renderDocument, listTemplates: listDocTemplates } = require("./document-templates");
const toolLogger = require("./tool-logger");
const entryStore = require("./entry-store");
const { getCreatorRuntime } = require("./creator-runtime");
const jobSearch = require("./job-search");

const REPO = path.resolve(__dirname, "..", "..", "..");
// User workspace: outside the repo, for user artifacts (resumes, exports, generated docs).
// Defaults to ~/.keystone/workspace; overrideable via KEYSTONE_WORKSPACE env var.
const WORKSPACE = process.env.KEYSTONE_WORKSPACE
  || path.join(require("os").homedir(), ".keystone", "workspace");
const MAX_OUT = 4000;
const SKIP_DIR = /(^|[\\/])(\.git|node_modules|\.venv|\.venv-train|hf-cache)([\\/]|$)/;

const CAPABILITY_SCHEMA_VERSION = 1;
const RECEIPT_SCHEMA_VERSION = 1;

function _codedError(message, reasonCode) {
  const error = new Error(message);
  error.reason = reasonCode;
  return error;
}

function _safe(p) {
  const abs = path.resolve(REPO, String(p == null ? "." : p));
  if (abs !== REPO && !abs.startsWith(REPO + path.sep)) {
    throw _codedError("path escapes repo", "unsafe_path");
  }
  return abs;
}

// #1096: workspace safe-path guard — mirrors _safe() but anchored to WORKSPACE root
function _safeWs(p) {
  const abs = path.resolve(WORKSPACE, String(p == null ? "." : p));
  if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + path.sep)) {
    throw _codedError("path escapes workspace", "unsafe_workspace_path");
  }
  return abs;
}

function _ensureWorkspace() {
  if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true });
}

function _globToRe(glob) {
  let re = String(glob || "*").replace(/[.+^${}()|[\]\\]/g, "\\$&");
  re = re.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + re + "$", "i");
}

// GET a JSON body from the server's OWN loopback /api/trading/* endpoint. The
// trader tools run inside the same process as the trading routes, so this reuses
// the exact live data path (and caches) the trader UI hits — no second data
// source, no Python spawn of its own. Bounded timeout so a slow feed degrades to
// an honest "unavailable" instead of hanging the chat turn (#1434 / #1560).
function _localTradingGet(pathAndQuery, timeoutMs = 9000, extraHeaders = null) {
  const port = process.env.LANTERN_GARAGE_PORT || process.env.PORT || 4177;
  const headers = { "x-keystone-internal": "1", ...(extraHeaders || {}) };
  // Desktop hardening (ADR-0014 G4): when the launcher gates operator trust on a
  // per-boot token, this in-process hop must carry it too or the forwarded user
  // id (below) would be refused by request-auth.internalUserId.
  if (process.env.UNISONA_LOCAL_TOKEN) headers["x-unisona-token"] = process.env.UNISONA_LOCAL_TOKEN;
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: pathAndQuery, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error("bad JSON from trading endpoint")); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("trading endpoint timeout")));
  });
}

// Prefer the co-located server's loopback endpoint (reuses its warm cache); if no
// server is listening — e.g. the tool runs inside the standalone MCP bridge with
// no lantern-garage on :4177 (ECONNREFUSED/timeout) — fall back to the SAME keyless
// feed directly so read-only market data still resolves instead of erroring. Same
// data source either way, so no divergence. Broker/account tools have no such
// fallback (they genuinely need the live account) and stay loopback-only.
async function _tradingDataOrDirect(pathAndQuery, directFn) {
  try {
    return await _localTradingGet(pathAndQuery);
  } catch (loopbackErr) {
    if (typeof directFn === "function") {
      try { return await directFn(); } catch (_e) { throw loopbackErr; }
    }
    throw loopbackErr;
  }
}

// The in-process loopback hop above carries no session cookie, so account-reading
// tools forward the chat user's id (from runTool ctx) as x-keystone-user. The
// trading routes honor it only on operator-trusted requests (request-auth.
// internalUserId) — this is what lets "my portfolio" in chat resolve the SAME
// per-user IBKR connection (ADR-0022) the trader UI shows.
function _userHeaders(ctx) {
  return ctx && ctx.userId ? { "x-keystone-user": encodeURIComponent(String(ctx.userId)) } : null;
}

// ── portfolio-tool formatting (portfolio_analysis / portfolio_whatif /
// propose_rebalance) — shared so all three speak the same evidence language. ──
function _pfPct(x, dp = 1) {
  return `${(x * 100).toFixed(dp)}%`;
}
function _pfSharpe(s) {
  return `${s.sharpe.toFixed(2)} [${s.lo.toFixed(2)}, ${s.hi.toFixed(2)}]`;
}
function _pfWindow(w) {
  return `${w.years}y daily total-return window, ${w.obs} trading days${w.from ? ` (${w.from} → ${w.to})` : ""}`;
}
function _pfExcluded(ex) {
  return ex && ex.length ? `Excluded: ${ex.map((e) => `${e.symbol} (${e.reason})`).join("; ")}` : "";
}
function _pfCorrMatrix(symbols, matrix, cap = 10) {
  const syms = symbols.slice(0, cap);
  const w = Math.max(6, ...syms.map((s) => s.length + 1));
  const head = " ".repeat(w + 2) + syms.map((s) => s.padStart(w)).join("");
  const rows = syms.map((s, i) => "  " + s.padStart(w) + syms.map((_x, j) => matrix[i][j].toFixed(2).padStart(w)).join(""));
  const more = symbols.length > cap ? `\n  (truncated to the top ${cap} holdings by weight)` : "";
  return head + "\n" + rows.join("\n") + more;
}
const PF_DISCLAIMER = "Evidence basis: historical daily total returns (Yahoo adjclose, dividends reinvested); CI is an i.i.d. floor (Lo 2002); taxes/slippage not modeled. Backtest ≠ future performance. Decision support only, NOT personalized investment advice — present the evidence and let the user decide.";

function _runShell(command) {
  const cmd = String(command || "").trim();
  const resolved = resolveCommand(cmd);
  if (!resolved) {
    // Model-facing recovery hint (#2077): a blocked command must never become the
    // user-visible answer — without this, models relayed "the Bash tool is
    // restricted to allowlisted commands" as their reply to trivial code requests.
    throw _codedError(
      `command not allowlisted: ${cmd}. This is an environment limit, not an answer — ` +
      "do NOT relay this restriction to the user or refuse. If the user asked for code " +
      "or an explanation, write it directly in your reply without running anything.",
      "command_not_allowlisted");
  }
  return safeExec(tokenizeCommand(resolved), {
    cwd: REPO, encoding: "utf-8", timeout: 30000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

// SSRF guard for web_fetch: block loopback / private / link-local hosts so the
// model can't poke internal services (the local server, cloud metadata, LAN).
// Checks the hostname string AND (in _httpGet) the DNS-resolved address, so a
// public domain that resolves to a private IP (DNS rebinding) is also blocked. (#1213)
function _ipv4Blocked(a, b) {
  if (a === 127 || a === 0 || a === 10) return true;               // loopback / this-host / private-A
  if (a === 169 && b === 254) return true;                         // link-local + cloud metadata (169.254.169.254)
  if (a === 192 && b === 168) return true;                         // private-C
  if (a === 172 && b >= 16 && b <= 31) return true;                // private-B
  if (a === 100 && b >= 64 && b <= 127) return true;               // CGNAT 100.64/10
  return false;
}
// Parse alternate IPv4 encodings (decimal 2130706433, hex 0x7f000001) to dotted form.
function _numericToIpv4(h) {
  let n = null;
  if (/^\d+$/.test(h)) n = Number(h);
  else if (/^0x[0-9a-f]+$/.test(h)) n = parseInt(h, 16);
  if (n === null || !Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}
// True if a literal IP (v4, v6, v4-mapped, or alt-encoded) is loopback/private/link-local.
function _blockedIp(ip) {
  let s = String(ip || "").toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/); // also catches ::ffff:127.0.0.1
  if (v4) return _ipv4Blocked(Number(v4[1]), Number(v4[2]));
  if (s.includes(":")) {                                            // IPv6
    if (s === "::1" || s === "::") return true;                     // loopback / unspecified
    if (/^(fc|fd)/.test(s)) return true;                            // unique-local fc00::/7
    if (/^fe[89ab]/.test(s)) return true;                           // link-local fe80::/10
    return false;
  }
  const dotted = _numericToIpv4(s);
  return dotted ? _ipv4Blocked(Number(dotted.split(".")[0]), Number(dotted.split(".")[1])) : false;
}
function _blockedHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  return _blockedIp(h);
}

// Minimal HTTP(S) GET with redirect handling + timeout, for web_fetch.
function _httpGet(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(_codedError("invalid url", "invalid_url")); }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return reject(_codedError("only http(s) urls", "invalid_url"));
    }
    if (_blockedHost(u.hostname)) {
      return reject(_codedError("host blocked (loopback/private/metadata)", "private_host_blocked"));
    }
    // Defeat DNS rebinding: also reject if the hostname RESOLVES to a private
    // address. (Residual TOCTOU — Node re-resolves on connect — is acceptable;
    // this blocks the common rebinding/misconfig + all literal-encoding bypasses.)
    require("dns").lookup(u.hostname, { all: true, verbatim: true }, (dnsErr, addrs) => {
      if (!dnsErr && Array.isArray(addrs) && addrs.some((a) => _blockedIp(a.address))) {
        return reject(_codedError("host resolves to a private address", "private_host_blocked"));
      }
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.get(u, {
        timeout: 12000,
        headers: { "User-Agent": "KeystoneOS/1.0 (+web_fetch tool)", "Accept": "text/html,text/plain,*/*" },
      }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(_httpGet(new URL(res.headers.location, u).toString(), redirects - 1));
        }
        if (code >= 400) { res.resume(); return reject(new Error(`http ${code}`)); }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { data += c; if (data.length > 600_000) { req.destroy(); } });
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(new Error("fetch timeout")); });
    });
  });
}

function _htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}

// ── Creator Suite helpers (video tools) ─────────────────────────────────────────
// These let dream-chat drive the same pipeline as create.html: list projects,
// kick off highlight analysis, and poll a job — all on the server's LIVE JobQueue
// singleton (via creator-runtime) so the JobWorker actually processes them.
function _creatorCtx() {
  const { jobQueue, repoRoot } = getCreatorRuntime();
  if (!jobQueue || !repoRoot) {
    throw _codedError("creator runtime unavailable (server not initialized)", "creator_runtime_unavailable");
  }
  return { jobQueue, repoRoot };
}

// Thumbnails are served by routes/media at /media/<path>; renderMarkdown in the
// chat (safeUrl allows site-absolute paths) renders `![alt](/media/…)` inline.
// Return a markdown image for an entry that has a thumbnail, else null.
function _thumbMarkdown(entry) {
  const t = entry && entry.thumbnail;
  if (!t) return null;
  const rel = String(t).replace(/\\/g, "/"); // Windows store → URL separators
  const url = rel.startsWith("/") ? rel : "/media/" + rel.replace(/^\/+/, "");
  const alt = String(entry.title || "thumbnail").replace(/[\[\]]/g, "");
  return `![${alt}](${encodeURI(url)})`;
}

const REGISTRY = {
  Read: {
    policy: "read", desc: "Read a file from the filesystem (repo-relative).",
    schema: { type: "object", properties: { file_path: { type: "string" }, limit: { type: "integer" } }, required: ["file_path"] },
    run(i) {
      const p = _safe(i.file_path);
      if (!fs.statSync(p).isFile()) return `[not a file: ${i.file_path}]`;
      const n = Math.max(1, Math.min(400, parseInt(i.limit, 10) || 80));
      return fs.readFileSync(p, "utf8").split("\n").slice(0, n).join("\n");
    },
  },
  LS: {
    policy: "read", desc: "List the entries of a directory (repo-relative).",
    schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    run(i) {
      const p = _safe(i.path || ".");
      if (!fs.statSync(p).isDirectory()) return `[not a directory: ${i.path}]`;
      const e = fs.readdirSync(p).sort();
      return `${e.length} entries:\n` + e.slice(0, 100).join("\n");
    },
  },
  Glob: {
    policy: "read", desc: "Find files matching a glob pattern (e.g. **/*.js).",
    schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
    run(i) {
      const re = _globToRe(i.pattern || "*");
      const hits = [];
      (function walk(d) {
        if (hits.length > 500 || SKIP_DIR.test(d)) return;
        let items; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const it of items) {
          const full = path.join(d, it.name);
          if (it.isDirectory()) walk(full);
          else { const rel = path.relative(REPO, full).replace(/\\/g, "/"); if (re.test(rel) || re.test(it.name)) hits.push(rel); }
        }
      })(_safe(i.path || "."));
      return `${hits.length} match(es) for ${i.pattern}:\n` + hits.slice(0, 100).join("\n");
    },
  },
  Grep: {
    policy: "read", desc: "Search file contents for a regular expression.",
    schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
    run(i) {
      const re = new RegExp(String(i.pattern || ""), "i");
      const out = [];
      const scan = (f) => { try { fs.readFileSync(f, "utf8").split("\n").forEach((ln, n) => { if (out.length < 80 && re.test(ln)) out.push(`${path.relative(REPO, f).replace(/\\/g, "/")}:${n + 1}: ${ln.trim().slice(0, 160)}`); }); } catch {} };
      const p = _safe(i.path || ".");
      if (fs.statSync(p).isFile()) scan(p);
      else for (const it of fs.readdirSync(p, { withFileTypes: true })) { if (it.isFile() && out.length < 80) scan(path.join(p, it.name)); }
      return out.length ? out.join("\n") : "[no matches]";
    },
  },
  Bash: {
    policy: "shell", desc: "Run an allowlisted shell command (git/tests/file-reads). Operator only. NOT for authoring or executing code the user asked you to write — put that code directly in your reply instead; only allowlisted repo commands run here.",
    schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    run(i) { return _runShell(i.command); },
  },
  PowerShell: {
    policy: "shell", desc: "Run an allowlisted command (same allowlist as Bash). Operator only. NOT for authoring or executing code the user asked you to write — put that code directly in your reply instead.",
    schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    run(i) { return _runShell(i.command); },
  },
  Write: {
    policy: "mutating", desc: "Write a file (repo-relative), overwriting it. Operator only.",
    schema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] },
    run(i) { const p = _safe(i.file_path); fs.writeFileSync(p, String(i.content == null ? "" : i.content), "utf8"); return `wrote ${i.file_path} (${String(i.content || "").length} bytes)`; },
  },
  Edit: {
    policy: "mutating", desc: "Replace an exact unique string in a file (repo-relative). Operator only.",
    schema: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] },
    run(i) {
      const p = _safe(i.file_path);
      const src = fs.readFileSync(p, "utf8");
      const parts = src.split(String(i.old_string));
      if (parts.length === 1) return `[old_string not found in ${i.file_path}]`;
      if (parts.length > 2) return `[old_string is not unique in ${i.file_path} (${parts.length - 1} matches)]`;
      fs.writeFileSync(p, parts.join(String(i.new_string == null ? "" : i.new_string)), "utf8");
      return `edited ${i.file_path}`;
    },
  },

  // ── ADR-0008 capability tools ───────────────────────────────────────────────
  web_search: {
    policy: "read",
    guest_safe: true, // web-only: safe to advertise/run for non-operators on the public server (#1213)
    desc: "Search the web for real-time information. Returns top results with title, URL, and snippet. Each result is cited per the Σ₀ External Reality Rule.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        max_results: { type: "integer", description: "Max results to return (1–10, default 5)" },
      },
      required: ["query"],
    },
    async run(i) {
      const query = String(i.query || "").trim();
      if (!query) return "[error: query is required]";
      const maxResults = Math.max(1, Math.min(10, parseInt(i.max_results, 10) || 5));
      // webSearch() bounds the MCP call (timeout + 1 retry) and falls back to a
      // keyless direct DuckDuckGo search, so a slow/down MCP path doesn't make the
      // tool time out and the model silently answer from memory (#1212).
      const payload = await webSearch(query, maxResults);
      if (!payload.success) {
        // Explicit error so the model reports "search unavailable" instead of guessing.
        return `[web_search error: ${payload.error || "search failed"} — search is unavailable right now; say so rather than answering from memory]`;
      }
      const results = payload.results || [];
      if (!results.length) return `[no results for: ${query}]`;
      const lines = [`web_search("${query}") — ${results.length} result(s)${payload.source && payload.source !== "mcp" ? ` (${payload.source} fallback)` : ""}:\n`];
      results.forEach((r, idx) => {
        lines.push(`[${idx + 1}] ${r.title || "(untitled)"}`);
        lines.push(`    url: ${r.url || ""}`);
        if (r.snippet) lines.push(`    snippet: ${r.snippet}`);
      });
      return lines.join("\n");
    },
  },

  // ── Convergence orchestrator (observe) ──────────────────────────────────────
  // Wires the assistant directly onto convergence_io_engine.py via the guarded
  // convergence-adapter seam (circuit breaker + timeout), instead of the old
  // loose subprocess spawns. Read-only: reports the orchestrator's live state.
  convergence_inspect: {
    policy: "read",
    guest_safe: false, // exposes internal fleet/orchestrator state — operator only
    desc: "Inspect the convergence orchestrator's live state — registered cells, active agent/dream-journal slots, tripped circuits, pending CSF specs, and per-layer target latencies. Read-only; grounds Observe with real engine state instead of guessing.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const { runEngineCommand } = require("./convergence-adapter");
      const s = await runEngineCommand("inspect");
      if (s.error) {
        return `[convergence_inspect unavailable: ${s.error} — the orchestrator (convergence_io_engine.py) could not be reached; say so rather than inventing state]`;
      }
      const circuits = s.circuits && Object.keys(s.circuits).length
        ? JSON.stringify(s.circuits)
        : "none tripped";
      const lines = [
        `convergence orchestrator state (as of ${s.timestamp || "now"}):`,
        `  cells: ${s.cells ?? "?"}`,
        `  active slots: ${s.slots_active ?? "?"} (dream-journal: ${s.dream_journal_slots_active ?? "?"})`,
        `  circuits: ${circuits}`,
        `  pending CSF specs: ${s.csf_agent?.pending_specs ?? "?"} (${s.csf_agent?.status || "?"})`,
      ];
      if (s.target_latencies) {
        lines.push(`  target latencies (ms): ${Object.entries(s.target_latencies).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      }
      if (s.last_log) lines.push(`  last log: ${s.last_log}`);
      return lines.join("\n");
    },
  },

  // ── Coding control plane (#2185): propose → verify → HOLD for approval ──────
  // The idiomatic seam onto the coding backend (routes/coding.js is the HTTP twin).
  // The assistant PROPOSES; a human APPROVES via the approvals surface — the model
  // never applies a repo change itself. Operator-only (policy: mutating).
  propose_coding_change: {
    policy: "mutating",
    desc:
      "Propose a change to a repository's EXISTING code using the accountable coding backend. Use only when the user asked for a repo change — never to write example/new code the user just wants to see (answer that directly in your reply). Routes to the best-measured local backend, runs it WITHOUT applying (HELD for approval), verifies the proposed diff, and returns a receipt + verification verdict + a pending id. The change is NOT applied — a human approves it via the approvals surface. Operator only.",
    schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What the change should do." },
        repo_path: { type: "string", description: "Repo to change (default: this repo)." },
        backend: { type: "string", description: "Force a backend (mock|ollama|aider|openhands); default routes by measured per-repo outcome." },
      },
      required: ["task"],
    },
    async run(i) {
      const task = String(i.task || "").trim();
      if (!task) return "[error: task is required]";
      const cb = require("./coding-backend");
      const repoPath = i.repo_path || REPO;
      let r;
      try {
        r = i.backend
          ? await cb.runCodingTask({ task, repoPath, backend: String(i.backend), why: "chat tool" })
          : await cb.routeCodingTask({ task, repoPath, candidates: cb.listBackends(), defaultBackend: "aider", why: "chat tool" });
      } catch (e) {
        return `[propose_coding_change error: ${e.message}]`;
      }
      if (!r || !r.ok) {
        return `[propose_coding_change failed: ${(r && r.error) || "no proposal"}${r && r.hint ? " — " + r.hint : ""}] ` +
          "Backend unavailability is an environment limit, not an answer — do not open your reply " +
          "with it or refuse. If the user only asked for code, write the code directly in your reply.";
      }
      const v = r.verification || {};
      const files = (r.proposal && r.proposal.filesChanged) || [];
      const verdict = v.decisive ? (v.passed === false ? "FAILED" : "passed") : "not decisive (guard-only)";
      return [
        `Proposed ${files.length} file change(s) via backend '${r.backend}' — HELD for approval (NOT applied).`,
        files.length ? `Files: ${files.join(", ")}` : null,
        `Verification: ${verdict}${v.enforce ? " [enforced]" : ""}${r.blocked ? " — BLOCKED from apply until overridden" : ""}`,
        r.routing ? `Routing: ${r.routing.backend} (${r.routing.hasSignal ? "measured outcome" : "cold-start"})` : null,
        `Pending id: ${r.pendingId} — approve via POST /api/coding/approve (operator).`,
      ].filter(Boolean).join("\n");
    },
  },

  // Live job-openings search. The user asks the assistant to find jobs (e.g. via the
  // "🧭 Job search" chip, which just sends such a message) and the model calls this. It
  // returns REAL current postings with real apply URLs from public job boards — never
  // invents listings (Σ₀ External Reality Rule). guest_safe: read-only web data, no
  // per-user state. If the model has no role yet, it should ask the user for one.
  job_search: {
    policy: "read",
    guest_safe: true,
    desc: "Search LIVE job openings from real job boards (Jobicy + Remotive) and return real apply URLs — never invent listings. A useful search needs a job TITLE or KEYWORD (the `query`): use the user's stated role, or a role you already know from their profile/history; if you don't know it, ask them what role/field they want before calling this. Defaults to REMOTE roles open to US applicants; pass `location` (a US city/state/ZIP, or a region like 'uk'/'europe'/'canada') to narrow. If the tool reports the boards are unreachable, tell the user rather than making up jobs.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Job title or keywords — REQUIRED, e.g. 'backend engineer', 'registered nurse', 'ux designer'" },
        location: { type: "string", description: "Optional. US city/state/ZIP for a location, or a region ('uk','europe','canada'). Omit for remote roles open to US applicants (the default)." },
        limit: { type: "integer", description: "Max postings to return (1–15, default 6)" },
      },
      required: ["query"],
    },
    async run(i) {
      const out = await jobSearch.searchJobs({ query: i.query, location: i.location, limit: i.limit });
      if (out.needQuery) {
        return "[job_search: no job title/keyword given. Ask the user what role or field they want to search for (and, optionally, a location or ZIP — otherwise it defaults to remote roles open to US applicants).]";
      }
      if (out.error) {
        return `[job_search: the job boards are unreachable right now (${out.error}) — tell the user live search failed and to try again shortly. Do NOT fabricate listings.]`;
      }
      const where = out.location ? out.location : `remote · ${out.geo.toUpperCase()}-eligible`;
      if (!out.count) return `[job_search: no live postings matched "${out.query}" (${where}) — suggest broader keywords or a different location.]`;
      const lines = [`job_search("${out.query}", ${where}) via ${out.source} — ${out.count} live posting(s):\n`];
      out.jobs.forEach((j, idx) => {
        lines.push(`[${idx + 1}] ${j.title} — ${j.company}`);
        lines.push(`    ${j.location}${j.salary ? ` · ${j.salary}` : ""}${j.posted ? ` · posted ${j.posted}` : ""}`);
        lines.push(`    apply: ${j.url}`);
      });
      return lines.join("\n");
    },
  },

  // Generate an image from a text prompt via the OSS-first image-model-registry (Act stage,
  // #1847). This REPLACES the old client-side "draw me X" keyword intercept: the model calls
  // this tool natively, and the returned Markdown image auto-embeds in chat. Never fabricates
  // a URL — returns a clear error the model must relay if generation is unavailable.
  generate_image: {
    policy: "read",
    guest_safe: true,
    desc: "Generate an image from a text description and return a Markdown image link that renders inline in the chat. Use this whenever the user asks you to draw, paint, sketch, illustrate, or generate a picture/image of something — decide on your own initiative, don't wait to be told to 'use a tool'. Pass the subject to depict as `prompt`. On success you MUST include the returned ![...](url) Markdown in your reply so the user actually sees the image. If it reports generation is unavailable, tell the user plainly — never invent an image URL.",
    schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to depict, e.g. 'a lighthouse at dusk, watercolor style'" },
      },
      required: ["prompt"],
    },
    async run(i) {
      const prompt = String(i.prompt || "").trim();
      if (!prompt) return "[generate_image error: a prompt describing the image is required]";
      let registry, openaiImage;
      try {
        registry = require("./image-model-registry");
        openaiImage = require("./openai-image");
      } catch (e) {
        return `[generate_image error: image backend unavailable (${e.message})]`;
      }
      // Same provider chain + drivers the /api/image/ai-generate route uses (OSS-first).
      const drivers = {
        openai: (p) => openaiImage.generateImage(p),
        comfyui: async () => ({ ok: false, error: "comfyui provider not yet implemented" }),
        pollinations: async () => ({ ok: false, error: "pollinations is client-side only" }),
      };
      let chain = [];
      try { chain = registry.resolveImageChain("scene"); } catch { chain = []; }
      let result = { ok: false, error: "no image provider available" };
      for (const provider of chain) {
        const driver = drivers[provider.kind];
        if (!driver) continue;
        try { result = await driver(prompt); } catch (e) { result = { ok: false, error: e.message }; }
        if (result && result.ok) { result.provider = provider.id; break; }
      }
      if (!result || !result.ok) {
        return `[generate_image: image generation is unavailable right now (${(result && result.error) || "no provider reachable"}) — tell the user you couldn't generate the image. Do NOT invent an image URL.]`;
      }
      const label = prompt.length > 80 ? prompt.slice(0, 80) + "…" : prompt;
      return `generate_image ok — provider ${result.provider || result.model || "image"}.\n` +
        `Include this Markdown in your reply so the image renders inline for the user:\n\n![${label}](${result.url})`;
    },
  },

  // #1344: a first-class issue/PR lookup. Before this, "find issue #1342" had no tool —
  // the model fell back to Grep on repo files (issues don't live in the repo), found
  // nothing, and gave up, even though the live-context block already injects the top-8
  // open issues by title only. This fetches ONE specific issue/PR by number, with body,
  // via the same `gh` path keystone-context.js already uses (the reliable one). Read-only
  // + scoped to the configured repo (a public repo) → guest_safe like web_fetch.
  github_issue: {
    policy: "read",
    guest_safe: true,
    desc: "Look up a specific GitHub issue or pull request by number in this project's repo, returning its title, state, labels, and body. Use this whenever the user asks to find, show, view, read, or summarize an issue or PR by number (e.g. \"find issue #1342\", \"what's PR 1200 about\"). Do NOT grep the repo for issue numbers — issues live on GitHub, not in the files.",
    schema: {
      type: "object",
      properties: {
        number: { type: "integer", description: "The issue or PR number (without the # prefix)" },
      },
      required: ["number"],
    },
    async run(i) {
      const n = parseInt(String(i.number == null ? "" : i.number).replace(/^#/, ""), 10);
      if (!Number.isInteger(n) || n <= 0) return "[github_issue error: a positive issue/PR number is required]";
      const { execFile } = require("child_process");
      const repo = process.env.GH_REPO || "alex-place/lantern-os";
      const ghView = (kind) => new Promise((resolve) => {
        execFile("gh", [kind, "view", String(n), "--repo", repo, "--json",
          "number,title,state,labels,body,url"],
          { cwd: REPO, timeout: 10000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
          (err, stdout) => resolve(err ? null : stdout));
      });
      // `gh issue view` errors on a PR number and vice-versa, so try issue then PR.
      let raw = await ghView("issue");
      let kind = "issue";
      if (!raw) { raw = await ghView("pr"); kind = "pull request"; }
      if (!raw) return `[github_issue: #${n} not found in ${repo} (or gh CLI unavailable)]`;
      let d;
      try { d = JSON.parse(raw); } catch { return `[github_issue: could not parse gh output for #${n}]`; }
      const labels = (d.labels || []).map((l) => l.name).filter(Boolean).join(", ") || "none";
      const body = String(d.body || "").trim();
      const excerpt = body.length > 4000 ? body.slice(0, 4000) + "\n…[truncated]" : (body || "(no description)");
      return `${kind} #${d.number} — ${d.title}\nstate: ${d.state} · labels: ${labels}\nurl: ${d.url}\n\n${excerpt}`;
    },
  },

  list_pull_requests: {
    policy: "read",
    guest_safe: true,
    desc: "List the project's open GitHub pull requests (number, title, draft state, branch). Use this whenever the user asks to show, list, browse, or review the open PRs / pull requests (e.g. \"show me prs\", \"what PRs are open\", \"list pull requests\"). This is the correct tool for listing PRs — github_issue only looks up ONE issue/PR by number.",
    schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max PRs to return (default 20, max 50)" },
      },
    },
    async run(i) {
      const limit = Math.min(50, Math.max(1, parseInt(i && i.limit, 10) || 20));
      const repo = process.env.GH_REPO || "alex-place/lantern-os";
      let out;
      try {
        out = safeExec(
          ["gh", "pr", "list", "--repo", repo, "--state", "open",
            "--limit", String(limit), "--json", "number,title,isDraft,headRefName"],
          { timeout: 15000 }
        );
      } catch (e) {
        return `[list_pull_requests: gh CLI unavailable or not authenticated — ${(e && e.message) || e}]`;
      }
      let prs;
      try { prs = JSON.parse(out); } catch { return "[list_pull_requests: could not parse gh output]"; }
      if (!prs.length) return `No open pull requests in ${repo}.`;
      const lines = prs.map((p) =>
        `#${p.number} — ${p.title}${p.isDraft ? " [draft]" : ""} (${p.headRefName || "?"})`);
      return `Open pull requests in ${repo} (${prs.length}):\n${lines.join("\n")}`;
    },
  },

  web_fetch: {
    policy: "read",
    guest_safe: true, // web-only (SSRF-guarded): safe for non-operators on the public server (#1213)
    desc: "Fetch the text content of a public URL. HTML is stripped to readable plain text. Use for reading web pages, documentation, or articles. No internal/private IPs allowed.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The public https:// or http:// URL to fetch" },
        max_chars: { type: "integer", description: "Max characters of content to return (default 3000)" },
      },
      required: ["url"],
    },
    async run(i) {
      const url = String(i.url || "").trim();
      if (!url) return "[error: url is required]";
      const maxChars = Math.max(200, Math.min(MAX_OUT, parseInt(i.max_chars, 10) || 3000));
      let html;
      try { html = await _httpGet(url); }
      catch (e) {
        // Let coded block errors (private_host_blocked, etc.) propagate so runTool maps
        // them to status "blocked" + reason_code — consistent with Read/Bash. Swallowing
        // them into a plain string mis-reported a blocked SSRF attempt as "executed" (the
        // guard still worked — no request reached the private host — but the status lied).
        if (e && e.reason) throw e;
        return `[web_fetch error: ${e.message}]`;
      }
      const text = _htmlToText(html || "");
      const excerpt = text.length > maxChars ? text.slice(0, maxChars) + "\n…[truncated]" : text;
      return `web_fetch(${url})\n\n${excerpt}`;
    },
  },

  // ── System status (Observe/Verify) — a LIVE, guest-safe health probe ────────
  // Closes the Σ₀ fabricated-grounding gap: before this, "is the MCP server
  // connected?" had NO tool to call, so the model guessed ("offline") from the
  // docs while the port was actually up — and the UI stamped "grounded" on it.
  // This MEASURES instead: a real GET /health of the MCP server (127.0.0.1:8771
  // via mcp-client), the chat server's own uptime, and which providers hold
  // credentials (presence booleans only — never secret values). No secrets are
  // exposed → guest_safe like web_fetch. The model must cite THIS result.
  system_status: {
    policy: "read",
    guest_safe: true,
    desc: "Report the LIVE health of this system: whether the MCP server (127.0.0.1:8771) is up (real /health probe), the chat server's own uptime, and which AI providers have credentials configured (presence booleans only — never secret values). Use this WHENEVER the user asks whether the server, the MCP server, a provider, or the system is connected / up / online / running / working / healthy. It performs a real check — answer from THIS result, never from memory or documentation.",
    schema: { type: "object", properties: {} },
    async run() {
      const lines = [];
      // 1) MCP server — real GET /health on 127.0.0.1:8771 (2s timeout, 5s cache).
      let mcpUp = false;
      try { mcpUp = await require("./mcp-client").isAvailable(); }
      catch { mcpUp = false; }
      lines.push(`MCP server (127.0.0.1:8771): ${mcpUp
        ? "UP — /health responded"
        : "DOWN — /health did not respond on 127.0.0.1:8771"}`);
      // 2) This chat server — if this tool is running, the Node server is up.
      const port = process.env.LANTERN_GARAGE_PORT || process.env.PORT || 4177;
      lines.push(`Chat server (127.0.0.1:${port}): UP — uptime ${Math.round(process.uptime())}s`);
      // 3) Provider credentials — presence booleans only (mirrors status.js api_keys).
      const providers = {
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        openai: !!process.env.OPENAI_API_KEY,
        gemini: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
        xai: !!process.env.XAI_API_KEY,
      };
      const on = Object.keys(providers).filter((k) => providers[k]);
      const off = Object.keys(providers).filter((k) => !providers[k]);
      lines.push(`AI providers with credentials: ${on.length ? on.join(", ") : "none"}${off.length ? ` · missing: ${off.join(", ")}` : ""}`);
      // 4) Chat tool execution state (this very loop).
      lines.push(`Chat tool execution (CHAT_TOOL_EXEC): ${process.env.CHAT_TOOL_EXEC === "1" ? "ON" : "OFF"}`);
      return lines.join("\n");
    },
  },

  // ── Remember stage: agent-invoked memory recall (the "Grep" for user memory) ──
  // Retrieval is NOT a keyword gate in front of the model — the model DECIDES to recall,
  // calls this, and reasons over the result, exactly like Read/Grep over the repo. Backed
  // by the ONE canonical CSF memory + conversation log (lib/csf-memory.js::recallMemory) —
  // no new store. operator-only (not guest_safe): it reads the user's personal memory.
  recall_memory: {
    policy: "read",
    desc: "Recall what you ALREADY KNOW about THIS user across past sessions — their stated personal facts, background, preferences, and relevant excerpts from earlier conversations. Call this WHENEVER the user asks what you know or remember about them, says 'use what you know about me', refers to something you 'discussed before', or when personalizing help (job search, resume, planning) would benefit from prior context. Pass a `query` to focus the recall (e.g. 'job search preferences', 'family', 'resume'); OMIT it to get a general profile of recent facts + conversation topics. The result is memory you genuinely have — rely on it as prior context, do not treat it as a guess. If it returns 'no stored memories', say that honestly; never claim you 'cannot see past sessions' without calling this first.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional topic to focus recall on. Omit for a general 'what do you know about me' profile." },
      },
      required: [],
    },
    run(i) {
      const { recallMemory } = require("./csf-memory");
      return recallMemory({ query: String((i && i.query) || ""), limit: 8 });
    },
  },

  // ── ADR-0008 document generation (#1097) ────────────────────────────────────
  // Renders resume / cover-letter templates to the user workspace — HTML (print
  // to PDF from the browser) or Markdown. Backed by document-templates.js, the
  // single template library. The assistant calls this directly in conversation
  // (there is no persona or scripted skill flow in front of it).
  generate_document: {
    policy: "mutating",
    desc: 'Generate a resume or cover-letter and save it to the user workspace. template: "resume" or "cover-letter". format: "docx" (default — a real, submit-ready Word file; employers/ATS expect .docx) | "html" (open in browser, Print → Save as PDF) | "markdown". Every field is optional at render time: pass whatever you already know from the conversation and attachments; missing fields are omitted or given neutral defaults. Draft first and refine in conversation — never make the user fill in a field list, and never invent user facts (leave a visible "[add …]" gap instead). Returns a download link — repeat it in your reply as a Markdown link so the user can click it. Operator only.',
    schema: {
      type: "object",
      properties: {
        template: { type: "string", description: '"resume" or "cover-letter"' },
        fields: { type: "object", description: "Template-specific fields (name, email, experience, skills, company, role, …)" },
        format: { type: "string", enum: ["docx", "html", "markdown"], description: 'Output format (default: "docx")' },
        filename: { type: "string", description: "Workspace-relative base name without extension (default: the template name)" },
      },
      required: ["template", "fields"],
    },
    async run(i) {
      if (!i.template) return "[error: template is required]";
      if (!i.fields || typeof i.fields !== "object") return "[error: fields must be an object]";
      const format = ["html", "markdown", "docx"].includes(i.format) ? i.format : "docx";
      let rendered;
      try {
        // docx renders the template's markdown through the shared md→docx engine
        // (lib/document-builder.js) — a real Word file, not renamed HTML.
        rendered = renderDocument(String(i.template), i.fields, format === "docx" ? "markdown" : format);
      } catch (e) {
        const tmplList = listDocTemplates().map((t) => `  ${t.name}`).join("\n");
        return `[generate_document error: ${e.message}]\n\nAvailable templates:\n${tmplList}`;
      }
      _ensureWorkspace();
      const base = String(i.filename || i.template)
        .replace(/\.+\//g, "")
        .replace(/\.(html|md|markdown|docx)$/i, "");
      let finalName, bytes;
      if (format === "docx") {
        const { renderDocx } = require("./document-builder");
        // Title feeds the docx TITLE paragraph; for resumes use the bare name so
        // the template's leading "# Name" heading dedupes instead of doubling.
        const title = String(i.template) === "resume"
          ? String(i.fields.name || "Resume")
          : [i.fields.name, "Cover Letter", i.fields.company ? `(${i.fields.company})` : ""].filter(Boolean).join(" — ").replace(" — (", " (");
        const buffer = await renderDocx(rendered.content, title);
        finalName = base + ".docx";
        const p = _safeWs(finalName);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, buffer);
        bytes = buffer.length;
      } else {
        finalName = base + rendered.extension;
        const p = _safeWs(finalName);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, rendered.content, "utf8");
        bytes = Buffer.byteLength(rendered.content);
      }
      const lines = [
        `created workspace/${finalName} (${bytes} bytes)`,
        `Download link — give this to the user as a Markdown link: [${finalName}](/api/workspace/download?file=${encodeURIComponent(finalName)})`,
      ];
      if (format === "html") {
        lines.push("Tip: open it in the browser and use Print → Save as PDF to produce a submittable PDF.");
      }
      return lines.join("\n");
    },
  },
  list_document_templates: {
    policy: "read",
    guest_safe: true, // read-only template metadata (no I/O) — safe for non-operators (#1213)
    desc: "List available document templates (resume, cover-letter) and the field names each accepts. Every field is optional — generate_document renders whatever subset you pass, so build fields from the conversation and attachments instead of asking the user for this list.",
    schema: { type: "object", properties: {} },
    run() {
      const lines = listDocTemplates().map((t) => {
        const fields = (t.fields || []).map((f) => f.name).join(", ");
        return `${t.name} — accepts: ${fields}`;
      });
      lines.push("All fields are optional: missing ones are omitted or defaulted at render time. Draft from what the conversation and attachments already contain — don't ask the user to fill in this list.");
      return lines.join("\n");
    },
  },
  // ── real binary export (#1923): Markdown → downloadable .docx / .pdf / .xlsx / .pptx ──
  // generate_document (above) only renders the template library to HTML/Markdown in the
  // workspace — it CANNOT make a Word file, so the model used to flatly refuse "export it
  // as a word doc" despite the capability existing (document-builder.js, #1237). This tool
  // exposes that real generator to chat: it takes the content the model already wrote
  // (Markdown) and renders a true binary via the docx/exceljs/pptxgenjs libs, returning a
  // clickable download link. Use it when the user asks to export/download something AS a
  // specific file type (Word/.docx, PDF, Excel/.xlsx, PowerPoint/.pptx).
  export_document: {
    policy: "mutating",
    desc: 'Export already-written content to a downloadable FILE and return a download link. Use when the user asks to "export as a word doc", "download as PDF", "make it a .docx/.xlsx/.pptx", etc. content: the document body in Markdown (headings, lists, and one table → a spreadsheet/slides). format: "docx" | "pdf" | "xlsx" | "pptx" | "html" | "md". title: optional document title. Returns a Markdown download link the user can click. Operator only.',
    schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The document body as Markdown (draft it from the conversation — do NOT ask the user to paste it)." },
        format: { type: "string", enum: ["docx", "pdf", "xlsx", "pptx", "html", "md"], description: 'Target file type (e.g. "docx" for a Word document).' },
        title: { type: "string", description: "Optional document title (defaults to the first H1 or 'document')." },
      },
      required: ["content", "format"],
    },
    async run(i) {
      const content = String(i.content == null ? "" : i.content).trim();
      if (!content) return "[error: content is required — draft the document body as Markdown first]";
      const format = String(i.format || "").toLowerCase();
      const { generateDocument } = require("./document-builder");
      let result;
      try {
        result = await generateDocument({ markdown: content, title: String(i.title || ""), format });
      } catch (e) {
        return `[export_document error: ${e.message || String(e)}]`;
      }
      if (!result || !result.ok) {
        return `[export_document failed: ${(result && result.error) || "unknown error"}]`;
      }
      // Chat renders Markdown → the link is clickable and downloads the real file.
      return `Exported **${result.title}** as ${format.toUpperCase()} (${result.bytes} bytes).\n\n`
        + `[⬇ Download ${result.filename}](${result.url})`;
    },
  },
  // ── workspace tools (ADR-0008 §Decision 4): user-artifact area outside the repo ────
  // User artifacts (resumes, exports, generated docs) are written to WORKSPACE, never into
  // the repo. Each tool uses _safeWs() to reject path-escape attempts before touching disk.
  // Operator-only by design (no guest_safe): WORKSPACE is a SINGLE shared directory of
  // personal artifacts, so #1213's filesystem-tool gate keeps public-server guests from
  // enumerating or reading another user's files. Local users chat via loopback (operator)
  // and keep full access. (These superseded the shadowed ./user-workspace.js copies that
  // used a `path` param — removed, since duplicate object keys silently kept only these.)
  workspace_read: {
    policy: "read",
    desc: "Read a file from the user workspace (~/.keystone/workspace/). Use for user-owned artifacts: resumes, exports, generated docs.",
    schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
    run(i) {
      const p = _safeWs(i.file_path);
      if (!fs.existsSync(p)) throw _codedError(`workspace file not found: ${i.file_path}`, "not_found");
      const content = fs.readFileSync(p, "utf8");
      return content.length > MAX_OUT ? content.slice(0, MAX_OUT) + "\n…[truncated]" : content;
    },
  },
  workspace_write: {
    policy: "mutating",
    desc: "Write a file to the user workspace (~/.keystone/workspace/). Creates intermediate directories. Never writes to the repo.",
    schema: {
      type: "object",
      properties: { file_path: { type: "string" }, content: { type: "string" } },
      required: ["file_path", "content"],
    },
    run(i) {
      _ensureWorkspace();
      const p = _safeWs(i.file_path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(i.content == null ? "" : i.content), "utf8");
      return `wrote workspace/${i.file_path} (${String(i.content || "").length} bytes)`;
    },
  },
  workspace_list: {
    policy: "read",
    desc: "List files in the user workspace (~/.keystone/workspace/) under an optional subdirectory.",
    schema: { type: "object", properties: { path: { type: "string" } } },
    run(i) {
      _ensureWorkspace();
      const dir = _safeWs(i.path || ".");
      if (!fs.existsSync(dir)) return "(workspace directory is empty)";
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      if (!entries.length) return "(no files)";
      return entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
    },
  },
  create_document: {
    policy: "mutating",
    desc: "Create a formatted document (markdown, plaintext) in the user workspace. Returns the workspace-relative path.",
    schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Workspace-relative path, e.g. 'resume-2026.md'" },
        content: { type: "string" },
        format: { type: "string", enum: ["markdown", "text"], description: "File format hint (default: markdown)" },
      },
      required: ["filename", "content"],
    },
    run(i) {
      _ensureWorkspace();
      const ext = (i.format === "text") ? ".txt" : ".md";
      const filename = String(i.filename || "document").replace(/\.+\//g, "");
      const finalName = filename.endsWith(ext) ? filename : (filename.includes(".") ? filename : filename + ext);
      const p = _safeWs(finalName);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(i.content == null ? "" : i.content), "utf8");
      return `created workspace/${finalName} (${String(i.content || "").length} chars)`;
    },
  },
  // ── bounded eval recipe (issue #843) ──────────────────────────────────────
  // Runs scripts/eval_keystone.py against a local Ollama-compatible endpoint.
  // Inputs are validated and allowlisted; arbitrary command construction is
  // forbidden. Probes the endpoint before running; returns a blocked receipt
  // if unavailable. OPERATOR policy (shell execution).
  local_eval_keystone_run: {
    policy: "shell",
    desc: "Run the unisona.ai eval harness (eval_keystone.py) against a local Ollama endpoint. Returns a structured receipt with accuracy and latency. Endpoint must be loopback-only.",
    schema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Unique run label (alphanumeric, dash, dot, max 64 chars)" },
        base: { type: "string", description: "Ollama API base URL (loopback only, default: http://127.0.0.1:11434)" },
        model: { type: "string", description: "Model name passed to eval harness (default: ouro:latest)" },
        limit: { type: "integer", description: "Max prompts to evaluate (default: all; max: 65)" },
        timeout: { type: "integer", description: "Per-prompt timeout in seconds (default: 60; max: 300)" },
      },
      required: ["label"],
    },
    async run(i) {
      const os = require("os");
      const childProcess = require("child_process");
      const { promisify } = require("util");
      const execFile = promisify(childProcess.execFile);

      // ── Validate label ───────────────────────────────────────────────
      const label = String(i.label || "").trim();
      if (!label || !/^[\w.\-]{1,64}$/.test(label)) {
        throw _codedError("label must be 1-64 chars, alphanumeric/dash/dot", "invalid_label");
      }

      // ── Validate base URL (loopback only) ────────────────────────────
      const base = String(i.base || "http://127.0.0.1:11434").trim();
      let parsedBase;
      try { parsedBase = new URL(base); } catch {
        throw _codedError("base is not a valid URL", "invalid_base");
      }
      if (!["127.0.0.1", "::1", "localhost"].includes(parsedBase.hostname)) {
        throw _codedError("base must be a loopback address (127.0.0.1 / ::1 / localhost)", "non_loopback_base");
      }

      // ── Validate model ───────────────────────────────────────────────
      const model = String(i.model || "ouro:latest").trim();
      if (!/^[\w.:/-]{1,128}$/.test(model)) {
        throw _codedError("model contains invalid characters", "invalid_model");
      }

      // ── Validate limit ───────────────────────────────────────────────
      const rawLimit = parseInt(i.limit, 10);
      const limit = isNaN(rawLimit) ? null : Math.min(65, Math.max(1, rawLimit));

      // ── Validate timeout ─────────────────────────────────────────────
      const rawTimeout = parseInt(i.timeout, 10);
      const timeoutSec = isNaN(rawTimeout) ? 60 : Math.min(300, Math.max(10, rawTimeout));

      // ── Probe endpoint availability ──────────────────────────────────
      const tagsUrl = base.replace(/\/$/, "") + "/api/tags";
      let endpointAvailable = false;
      try {
        await _httpGet(tagsUrl); // will throw if unavailable
        endpointAvailable = true;
      } catch (probeErr) {
        return JSON.stringify({
          receipt: "blocked",
          label,
          base,
          model,
          cause: "endpoint_unavailable",
          probe_url: tagsUrl,
          probe_error: probeErr && probeErr.message ? probeErr.message : String(probeErr),
          ts: new Date().toISOString(),
        }, null, 2);
      }

      // ── Build validated argument list (no shell interpolation) ───────
      const evalScript = path.join(REPO, "scripts", "eval_keystone.py");
      if (!fs.existsSync(evalScript)) {
        throw _codedError("scripts/eval_keystone.py not found", "eval_script_missing");
      }
      const args = [evalScript, "--label", label, "--base", base, "--model", model];
      if (limit !== null) args.push("--limit", String(limit));

      // ── Run with explicit timeout ────────────────────────────────────
      const pythonBin = process.platform === "win32" ? "python" : "python3";
      const hardTimeout = (timeoutSec * (limit || 65) + 30) * 1000; // generous outer timeout
      let stdout = "", stderr = "", exitCode = 0;
      try {
        const result = await execFile(pythonBin, args, {
          cwd: REPO,
          encoding: "utf8",
          timeout: hardTimeout,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, PYTHONPATH: path.join(REPO, "apps") + path.delimiter + path.join(REPO, "src") },
        });
        stdout = result.stdout || "";
        stderr = result.stderr || "";
      } catch (err) {
        exitCode = err.code || 1;
        stdout = err.stdout || "";
        stderr = err.stderr || "";
        if (err.killed || err.signal === "SIGTERM") {
          return JSON.stringify({
            receipt: "error",
            label, base, model,
            exit_code: exitCode,
            cause: "timeout",
            timeout_ms: hardTimeout,
            ts: new Date().toISOString(),
          }, null, 2);
        }
      }

      // ── Try to parse leaderboard row ─────────────────────────────────
      const leaderboardPath = path.join(REPO, "data", "eval", "leaderboard.jsonl");
      let leaderboardRow = null;
      if (fs.existsSync(leaderboardPath)) {
        try {
          const rows = fs.readFileSync(leaderboardPath, "utf8").trim().split("\n").filter(Boolean);
          const last = rows[rows.length - 1];
          const parsed = JSON.parse(last);
          if (parsed.label === label) leaderboardRow = parsed;
        } catch {}
      }

      return JSON.stringify({
        receipt: exitCode === 0 ? "success" : "error",
        label, base, model,
        limit: limit || 65,
        exit_code: exitCode,
        stdout_hash: require("crypto").createHash("sha256").update(stdout).digest("hex").slice(0, 12),
        stderr_hash: require("crypto").createHash("sha256").update(stderr).digest("hex").slice(0, 12),
        leaderboard_row: leaderboardRow,
        accuracy_by_difficulty: leaderboardRow ? leaderboardRow.accuracy_by_difficulty || null : null,
        ts: new Date().toISOString(),
      }, null, 2);
    },
  },

  // ── Creator Suite: short-form video pipeline in chat (mirrors create.html) ──
  list_creator_projects: {
    policy: "read", desc: "List the user's Creator video projects as a markdown gallery (title, status, thumbnail image, id). Relay the markdown to the user so the thumbnails render; use the `id` for analyze_video.",
    schema: { type: "object", properties: { limit: { type: "integer", description: "max projects (default 20)" } } },
    run(i) {
      const { repoRoot } = _creatorCtx();
      const entries = entryStore.listEntries(repoRoot) || [];
      const sorted = [...entries].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      const limit = Math.max(1, Math.min(50, parseInt(i.limit, 10) || 20));
      const shown = sorted.slice(0, limit);
      if (!shown.length) return "No Creator projects yet. Upload a video on /create.html or pass a filePath to analyze_video to start one.";
      // Markdown so the chat renders each thumbnail inline (renderMarkdown → <img>).
      const blocks = shown.map((e, n) => {
        const title = e.title || "Untitled";
        const status = e.status || "uploaded";
        const thumb = _thumbMarkdown(e);
        return `${n + 1}. **${title}** — status: ${status} · \`${e.id}\`\n` +
          (thumb ? thumb : "_(no thumbnail yet — run analyze_video)_");
      });
      const header = `Found ${shown.length}${entries.length > shown.length ? " of " + entries.length : ""} Creator project${shown.length === 1 ? "" : "s"} (most recent first):`;
      return header + "\n\n" + blocks.join("\n\n");
    },
  },

  analyze_video: {
    policy: "action", desc: "Start highlight analysis (motion/scene/audio) on a Creator project. Pass entryId of an existing project, OR filePath (repo-relative video) to create one. Returns a jobId — poll it with creator_job_status.",
    schema: { type: "object", properties: {
      entryId: { type: "string", description: "existing project id (from list_creator_projects)" },
      filePath: { type: "string", description: "repo-relative path to an uploaded video; creates a new project" },
      title: { type: "string", description: "title for a new project (optional)" },
    } },
    run(i) {
      const { jobQueue, repoRoot } = _creatorCtx();
      let entryId = (i.entryId || "").trim() || null;
      let entry = null;

      if (entryId) {
        entry = entryStore.getEntry(repoRoot, entryId);
        if (!entry) return JSON.stringify({ error: `project not found: ${entryId}` });
      } else if (i.filePath) {
        const abs = _safe(i.filePath); // repo-sandboxed
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          return JSON.stringify({ error: `video file not found: ${i.filePath}` });
        }
        const base = path.basename(i.filePath).replace(/\.[^.]+$/, "").replace(/[_\-]+/g, " ").trim();
        entry = entryStore.createEntry(repoRoot, {
          title: (i.title || "").trim() || (base ? base.replace(/\b\w/g, (c) => c.toUpperCase()) : "Video Project"),
          type: "video",
          filePath: String(i.filePath).replace(/\\/g, "/"),
        });
        entryId = entry.id;
      } else {
        return JSON.stringify({ error: "provide entryId or filePath" });
      }

      const videoPath = entry.filePath;
      if (!videoPath) return JSON.stringify({ error: `project ${entryId} has no source video` });
      if (!fs.existsSync(path.join(repoRoot, videoPath))) {
        return JSON.stringify({ error: `source video missing on disk: ${videoPath}` });
      }

      const job = jobQueue.enqueue("analyze", { videoPath, entryId, options: {} });
      return JSON.stringify({
        ok: true, jobId: job.id, entryId, status: job.status,
        message: "Analysis queued. Poll creator_job_status with this jobId.",
      }, null, 2);
    },
  },

  creator_job_status: {
    policy: "read", desc: "Check a Creator analysis/render job by jobId. Returns status, progress, and (when complete) highlight count + the project thumbnail (markdown image — relay it so it renders inline).",
    schema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] },
    run(i) {
      const { jobQueue, repoRoot } = _creatorCtx();
      const job = jobQueue.getJob((i.jobId || "").trim());
      if (!job) return JSON.stringify({ error: `job not found: ${i.jobId}` });
      const ls = job.liveStats || {};
      const out = {
        jobId: job.id, type: job.type, status: job.status,
        progress: job.progress, message: job.progressMessage,
        etaSeconds: job.etaSeconds, error: job.error || null,
      };
      if (ls.highlightsFound != null) out.highlightsFound = ls.highlightsFound;
      if (ls.topScore != null) out.topScore = ls.topScore;
      if (job.status === "complete" && job.result && job.result.timeline) {
        const hl = job.result.timeline.highlights;
        out.highlights = Array.isArray(hl) ? hl.length : 0;
        if (job.input && job.input.entryId) {
          out.openProject = `/entry.html?id=${job.input.entryId}`;
          // Surface the (possibly render-derived) thumbnail so chat shows the result visually.
          const entry = entryStore.getEntry(repoRoot, job.input.entryId);
          const thumb = _thumbMarkdown(entry);
          if (thumb) out.thumbnail = thumb;
        }
      }
      return JSON.stringify(out, null, 2);
    },
  },

  // ── Trader tools (ADR-0008 / ADR-0013 / #1434 / #1560) ──────────────────────
  // The stock trader is kept as a *Tool inside the one chat loop*, not a separate
  // surface: chat can Observe live market state, a ticker's evidence, and the
  // operator's positions, then Reason/Verify over them (External Reality Rule —
  // reason from THIS evidence, cite it, never from memory). Each tool calls the
  // server's own loopback /api/trading/* endpoint, so it reuses the exact live
  // data path the trader UI uses (keyless + cached).
  trader_market_status: {
    policy: "read",
    guest_safe: true, // public market data (VIX / SPY), no account info
    desc: "Get the current live market state — VIX level + volatility regime, S&P 500 (SPY) 1-day/5-day trend, and whether the US equity session is open. Use whenever the user asks about 'the market', volatility, the VIX, or overall conditions. Data is live from the trader's keyless feed — cite it as evidence, don't answer from memory.",
    schema: { type: "object", properties: {} },
    async run() {
      try {
        const d = await _tradingDataOrDirect(
          "/api/trading/market-status",
          () => require("./market-data-yahoo").getMarketStatus(),
        );
        if (!d || d.available === false) {
          return `[trader_market_status: live market data unavailable${d && d.reason ? ` — ${d.reason}` : ""}. Say so rather than guessing.]`;
        }
        const sign = (v) => (v >= 0 ? "+" : "") + v;
        return [
          `Market status (source: ${d.source || "trader feed"}):`,
          `  US session: ${d.market_open ? "OPEN" : "CLOSED"}`,
          `  VIX: ${d.vix} (${d.vix_regime})`,
          `  SPY: 1d ${sign(d.spy_1d)}%, 5d ${sign(d.spy_5d)}% → ${d.market}`,
        ].join("\n");
      } catch (e) {
        return `[trader_market_status error: ${e.message} — market feed unreachable; say so rather than answering from memory.]`;
      }
    },
  },

  trader_quote: {
    policy: "read",
    guest_safe: true, // public per-ticker market data
    desc: "Get live price, returns, and technicals for a stock or crypto ticker (e.g. AAPL, NVDA, BTCUSD): current price, 1M/3M/YTD/1Y returns, volume vs average, 20/50-day moving averages, and a technical rating. Use whenever the user asks about a specific ticker's price, performance, or whether it looks like a buy — reason from THIS evidence, not memory.",
    schema: {
      type: "object",
      properties: { ticker: { type: "string", description: "Ticker symbol, e.g. AAPL or BTCUSD" } },
      required: ["ticker"],
    },
    async run(i) {
      const t = String(i.ticker || "").trim().toUpperCase();
      if (!t) return "[trader_quote error: a ticker is required]";
      try {
        const d = await _tradingDataOrDirect(
          `/api/trading/symbol-stats?ticker=${encodeURIComponent(t)}`,
          () => require("./market-data-yahoo").getSymbolStats(t),
        );
        if (!d || d.available === false) return `[trader_quote: no live data for ${t}. Say so rather than guessing.]`;
        const r = d.returns || {};
        const pct = (v) => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v}%`);
        const num = (v) => (v == null ? "?" : Number(v).toLocaleString("en-US"));
        const px = (v) => (v == null ? "?" : Number(v).toFixed(2));
        return [
          `${d.ticker} — $${px(d.price)} (technical: ${d.technical})`,
          `  Returns: 1M ${pct(r["1M"])}, 3M ${pct(r["3M"])}, YTD ${pct(r.YTD)}, 1Y ${pct(r["1Y"])}`,
          `  Volume: ${num(d.volume)} (avg ${num(d.avgVolume)})`,
          `  SMA20 $${d.sma20}, SMA50 $${d.sma50} — price is ${d.price > d.sma50 ? "above" : "below"} the 50-day`,
        ].join("\n");
      } catch (e) {
        return `[trader_quote error: ${e.message}]`;
      }
    },
  },

  trader_positions: {
    policy: "read", // operator-only (no guest_safe): private account data
    desc: "Get the operator's current paper-trading positions and account (equity, cash, buying power, day P&L). Use whenever the user asks about 'my positions', 'my portfolio', 'how am I doing', or their P&L. If the broker isn't connected, report that honestly — never invent holdings.",
    schema: { type: "object", properties: {} },
    async run(_i, ctx) {
      try {
        const d = await _localTradingGet("/api/trading/positions", 9000, _userHeaders(ctx));
        const acct = (d && d.account) || {};
        if (!d || d.available === false) {
          return `[trader_positions: broker not connected${d && d.reason ? ` (${d.reason})` : ""} — no live positions. Say so honestly; don't invent holdings.]`;
        }
        const pos = Array.isArray(d.positions) ? d.positions : [];
        const head = `Account: equity $${acct.equity ?? 0}, cash $${acct.cash ?? 0}, buying power $${acct.buying_power ?? 0}` +
          (acct.pnl_today != null ? `, day P&L ${acct.pnl_today >= 0 ? "+" : ""}$${acct.pnl_today}` : "");
        if (!pos.length) return `${head}\nOpen positions: none.`;
        const rows = pos.map((p) => {
          const sym = p.symbol || p.ticker || "?";
          const entry = p.avg_entry_price ?? p.avg_price ?? "?";
          const pnl = p.unrealized_pl != null ? ` (P&L ${p.unrealized_pl >= 0 ? "+" : ""}$${p.unrealized_pl})` : "";
          return `  ${sym}: ${p.qty ?? "?"} @ $${entry}${pnl}`;
        });
        return `${head}\nOpen positions (${pos.length}):\n${rows.join("\n")}`;
      } catch (e) {
        return `[trader_positions error: ${e.message}]`;
      }
    },
  },

  // ── Portfolio analytics (UNISONA-SHARPE-CERTIFICATE applied to real holdings) ──
  // Reason-stage tools: measured Sharpe/correlation evidence over the operator's
  // ACTUAL broker positions (ADR-0022 per-user IBKR), plus a covariance-aware
  // rebalance PROPOSAL. None of these place orders — Act stays behind
  // lib/trading-guard.js and the ADR-0020 gates. Every number carries its 95% CI
  // so overlapping allocations are reported as statistically indistinguishable,
  // never as directives.
  portfolio_analysis: {
    policy: "read", // operator-only (no guest_safe): reads the connected broker account
    desc: "Analyze the operator's ACTUAL broker holdings for risk-adjusted quality: current weights, per-holding and whole-portfolio annualized Sharpe with 95% CI, volatility, worst drawdown over the window, pairwise correlation matrix, and concentration (largest position, effective N, avg pairwise correlation). Use when the user asks how diversified or risky their portfolio is, what its Sharpe is, or whether their holdings overlap. Cite the window and CIs as evidence — this is historical measurement, never a promise, and never personalized advice.",
    schema: { type: "object", properties: { years: { type: "number", description: "history window in years (2–10, default 5)" } } },
    async run(i, ctx) {
      try {
        const d = await _localTradingGet("/api/trading/positions", 9000, _userHeaders(ctx));
        if (!d || d.available === false) {
          return `[portfolio_analysis: broker not connected${d && d.reason ? ` (${d.reason})` : ""} — no positions to analyze. Say so honestly.]`;
        }
        const pos = Array.isArray(d.positions) ? d.positions : [];
        if (!pos.length) return "[portfolio_analysis: no open positions — nothing to analyze.]";
        const pa = require("./portfolio-analytics");
        const a = await pa.analyzeHoldings(pos, { years: i.years });
        if (!a.ok) return `[portfolio_analysis: ${a.reason}.${a.excluded && a.excluded.length ? ` ${_pfExcluded(a.excluded)}` : ""}]`;
        const c = a.concentration;
        const rows = a.perSymbol.map((p) =>
          `  ${p.symbol.padEnd(6)} ${_pfPct(p.weight).padStart(6)}  vol ${_pfPct(p.volAnnual)}/yr  Sharpe ${_pfSharpe(p.sharpe)}`);
        return [
          `Portfolio analysis — ${_pfWindow(a.window)}:`,
          `Holdings (weight by market value; total ~$${Math.round(a.totalValue).toLocaleString("en-US")}):`,
          ...rows,
          `Portfolio at current weights (constant-mix): ex-ante Sharpe ${_pfSharpe(a.portfolio.sharpe)} · vol ${_pfPct(a.portfolio.volAnnual)}/yr · worst drawdown ${_pfPct(a.portfolio.maxDD)} · annualized return ${_pfPct(a.portfolio.annReturn)}`,
          `Concentration: largest position ${c.maxWeight.symbol} at ${_pfPct(c.maxWeight.weight)} · effective N ${c.effectiveN.toFixed(1)} of ${a.symbols.length} · avg pairwise ρ ${a.correlations.avgPairwise.toFixed(2)}`,
          "Correlation matrix (diversification only pays when off-diagonals are small — Thm 1):",
          _pfCorrMatrix(a.symbols, a.correlations.matrix),
          ...(a.notes.length ? [`Notes: ${a.notes.join("; ")}`] : []),
          _pfExcluded(a.excluded),
          PF_DISCLAIMER,
        ].filter(Boolean).join("\n");
      } catch (e) {
        return `[portfolio_analysis error: ${e.message}]`;
      }
    },
  },

  portfolio_whatif: {
    policy: "read",
    guest_safe: true, // public market data only — reads no account
    desc: "Score a hypothetical weight allocation over public tickers: annualized Sharpe with 95% CI, volatility, worst drawdown, per-symbol stats, and the correlation matrix, measured on daily total-return history. Use whenever the user proposes their own mix ('what if I went 60/20/20 SPY/GLD/TLT?') so they can compare THEIR idea against alternatives on equal evidence. When comparing allocations, check the CIs: if they overlap, say the options are statistically indistinguishable on this window — never oversell a small point-estimate gap.",
    schema: {
      type: "object",
      properties: {
        weights: {
          type: "object",
          description: "ticker → weight map, e.g. {\"SPY\": 60, \"GLD\": 20, \"TLT\": 20}. Percents or fractions — normalized by their sum. Max 15 symbols.",
          additionalProperties: { type: "number" },
        },
        years: { type: "number", description: "history window in years (2–10, default 5)" },
      },
      required: ["weights"],
    },
    async run(i) {
      try {
        const pa = require("./portfolio-analytics");
        const r = await pa.scoreWeights(i.weights, { years: i.years });
        if (!r.ok) return `[portfolio_whatif: ${r.reason}.${r.excluded && r.excluded.length ? ` ${_pfExcluded(r.excluded)}` : ""}]`;
        const rows = r.perSymbol.map((p) =>
          `  ${p.symbol.padEnd(6)} ${_pfPct(p.weight).padStart(6)}  vol ${_pfPct(p.volAnnual)}/yr  Sharpe ${_pfSharpe(p.sharpe)}`);
        return [
          `What-if allocation scored — ${_pfWindow(r.window)}:`,
          ...rows,
          `Blend (constant-mix): ex-ante Sharpe ${_pfSharpe(r.portfolio.sharpe)} · vol ${_pfPct(r.portfolio.volAnnual)}/yr · worst drawdown ${_pfPct(r.portfolio.maxDD)} · annualized return ${_pfPct(r.portfolio.annReturn)}`,
          `Avg pairwise ρ ${r.correlations.avgPairwise.toFixed(2)}:`,
          _pfCorrMatrix(r.symbols, r.correlations.matrix),
          ...(r.notes.length ? [`Notes: ${r.notes.join("; ")}`] : []),
          _pfExcluded(r.excluded),
          PF_DISCLAIMER,
        ].filter(Boolean).join("\n");
      } catch (e) {
        return `[portfolio_whatif error: ${e.message}]`;
      }
    },
  },

  propose_rebalance: {
    policy: "read", // operator-only; computes a PROPOSAL — places NOTHING (Act is gated by trading-guard/ADR-0020)
    desc: "Compute a covariance-aware rebalance PROPOSAL over the operator's existing holdings: shrunk tangency weights (w ∝ Σ⁻¹μ, long-only, per-position cap), ex-ante Sharpe of current vs proposed weights (both with 95% CIs), and a dry-run order list of whole-share deltas. It only reallocates among symbols already held — it never suggests new purchases and NEVER places orders; execution is a separate, human-gated action. If the two Sharpe CIs overlap, report the allocations as statistically indistinguishable on this window and say the user's other preferences (taxes, simplicity) may reasonably decide. The user always decides.",
    schema: {
      type: "object",
      properties: {
        years: { type: "number", description: "history window in years (2–10, default 5)" },
        max_weight: { type: "number", description: "per-position weight ceiling as a fraction (0.10–1.0, default 0.35)" },
      },
    },
    async run(i, ctx) {
      try {
        const d = await _localTradingGet("/api/trading/positions", 9000, _userHeaders(ctx));
        if (!d || d.available === false) {
          return `[propose_rebalance: broker not connected${d && d.reason ? ` (${d.reason})` : ""} — nothing to rebalance. Say so honestly.]`;
        }
        const pos = Array.isArray(d.positions) ? d.positions : [];
        if (!pos.length) return "[propose_rebalance: no open positions — nothing to rebalance.]";
        const pa = require("./portfolio-analytics");
        const r = await pa.proposeRebalance(pos, { years: i.years, maxWeight: i.max_weight });
        if (!r.ok) return `[propose_rebalance: ${r.reason}.${r.excluded && r.excluded.length ? ` ${_pfExcluded(r.excluded)}` : ""}]`;
        const wRows = r.symbols.map((s, idx) =>
          `  ${s.padEnd(6)} ${_pfPct(r.currentWeights[idx]).padStart(6)} → ${_pfPct(r.proposedWeights[idx]).padStart(6)}`);
        const oRows = r.orders.length
          ? r.orders.map((o) => `  ${o.action} ${o.shares} ${o.symbol} (~$${o.estDollars.toLocaleString("en-US")} @ $${o.price.toFixed(2)})`)
          : ["  none — current weights are already within 1% of the proposal"];
        const verdict = r.distinguishable
          ? "the proposed allocation's Sharpe CI clears the current one on this window — a measurable improvement"
          : "the 95% CIs OVERLAP — current and proposed are statistically indistinguishable on this window; taxes, simplicity, or preference may reasonably decide";
        return [
          `Rebalance PROPOSAL — ${_pfWindow(r.window)}. Nothing has been placed; execution is a separate, gated action.`,
          `Current : ex-ante Sharpe ${_pfSharpe(r.current.sharpe)} · vol ${_pfPct(r.current.volAnnual)}/yr · worst drawdown ${_pfPct(r.current.maxDD)}`,
          `Proposed: ex-ante Sharpe ${_pfSharpe(r.proposed.sharpe)} · vol ${_pfPct(r.proposed.volAnnual)}/yr · worst drawdown ${_pfPct(r.proposed.maxDD)}`,
          `Verdict: ${verdict}.`,
          "Weights (current → proposed):",
          ...wRows,
          "Dry-run order list (NOT placed):",
          ...oRows,
          `Method: ${r.method.objective}; ${r.method.constraints}; shrinkage: ${r.method.shrinkage}.`,
          ...(r.notes.length ? [`Notes: ${r.notes.join("; ")}`] : []),
          _pfExcluded(r.excluded),
          PF_DISCLAIMER,
        ].filter(Boolean).join("\n");
      } catch (e) {
        return `[propose_rebalance error: ${e.message}]`;
      }
    },
  },
};

const TOOL_NAMES = Object.keys(REGISTRY);

function capabilityManifest({
  executionEnabled = process.env.CHAT_TOOL_EXEC === "1",
} = {}) {
  return {
    schema_version: CAPABILITY_SCHEMA_VERSION,
    receipt_schema_version: RECEIPT_SCHEMA_VERSION,
    canonical_source: "apps/lantern-garage/lib/tool-runner.js",
    execution: {
      enabled: Boolean(executionEnabled),
      reason: executionEnabled ? null : "chat_tool_exec_disabled",
    },
    tools: TOOL_NAMES.map((name) => {
      const entry = REGISTRY[name];
      return {
        name,
        description: entry.desc,
        input_schema: entry.schema,
        policy: entry.policy,
        operator_required: entry.policy !== "read",
        surface_availability: {
          dream_chat: true,
          mcp: true,
        },
        execution_enabled: Boolean(executionEnabled),
        execution_disabled_reason: executionEnabled ? null : "chat_tool_exec_disabled",
        result_receipt_schema_version: RECEIPT_SCHEMA_VERSION,
      };
    }),
  };
}

function _outcome(status, tool, details = {}) {
  const reasonCode = details.reason_code || null;
  return {
    ok: status === "executed",
    status,
    tool,
    reason_code: reasonCode,
    reason: reasonCode,
    policy: details.policy || null,
    ...(details.result !== undefined ? { result: details.result } : {}),
    ...(details.error ? { error: details.error } : {}),
    receipt: {
      schema_version: RECEIPT_SCHEMA_VERSION,
      tool,
      status,
      reason_code: reasonCode,
    },
  };
}

// Match Python json.dumps() default separators (", " / ": ") so this preamble is
// BYTE-identical to the bridge's _render_tools (scripts/ouro_anthropic_bridge.py), which
// the FC training corpus is generated through. Train/serve parity is the #1 FC rule —
// a model trained on the bridge format must see the bridge format here too.
function _pyJson(o) {
  if (Array.isArray(o)) return "[" + o.map(_pyJson).join(", ") + "]";
  if (o && typeof o === "object") return "{" + Object.keys(o).map((k) => JSON.stringify(k) + ": " + _pyJson(o[k])).join(", ") + "}";
  return JSON.stringify(o);
}

function renderToolPreamble() {
  const lines = [
    "You can use tools. To answer the user directly, reply in plain text.",
    "When you need a tool, respond with EXACTLY ONE tool call on a SINGLE LINE, nothing else, in this exact format (no code fences, no blank lines):",
    '<tool_call>{"name": "TOOL_NAME", "input": {"ARG": "VALUE"}}</tool_call>',
    'Rules: "name" must be one of the tools below, spelled exactly. "input" is a JSON object of arguments (use {} if none). Double quotes only, no trailing commas. Emit the call and STOP; do not explain it. Only call a tool if needed.',
    "",
    "Available tools:",
  ];
  for (const name of TOOL_NAMES) {
    const t = REGISTRY[name];
    const ex = {}; (t.schema.required || []).slice(0, 2).forEach((k) => { ex[k] = "..."; });
    lines.push(`Tool: ${name}`);
    lines.push(`Description: ${t.desc}`);
    lines.push(`Input (JSON schema): ${JSON.stringify(t.schema)}`);
    lines.push(`Example: <tool_call>${_pyJson({ name, input: ex })}</tool_call>`);
  }
  lines.push("");
  lines.push("Remember: plain text OR exactly one single-line <tool_call>...</tool_call>. Never both.");
  return lines.join("\n");
}

/**
 * Execute a parsed tool call under the policy.
 * @param {string} name  canonical tool name the model emitted
 * @param {object} input arguments
 * @param {{operator?:boolean}} ctx
 * @returns {{ok:boolean, result?:string, reason?:string, error?:string, policy?:string}}
 */
async function runTool(name, input, ctx = {}) {
  const startTime = Date.now();
  const entry = REGISTRY[name];

  if (!entry) {
    const result = _outcome("unavailable", name, {
      reason_code: "unknown_tool",
      error: `unknown tool '${name}' (available: ${TOOL_NAMES.join(", ")})`,
    });
    // Log the unavailable tool
    await _logToolExecution(name, input, "unavailable", "unknown_tool", startTime, ctx);
    return result;
  }

  if (ctx.executionEnabled === false) {
    const result = _outcome("unavailable", name, {
      reason_code: "chat_tool_exec_disabled",
      policy: entry.policy,
      error: "shared tool execution is disabled",
    });
    await _logToolExecution(name, input, "unavailable", "chat_tool_exec_disabled", startTime, ctx);
    return result;
  }

  // Non-operators (e.g. public-server guests) may run ONLY guest_safe tools —
  // the web-only set. This is the enforcement boundary behind the advertised-set
  // filter: even a crafted call to a read-policy filesystem tool (Read/Grep/
  // workspace_read/…) is denied for guests, so the public chat can't enumerate or
  // read local files. Operators (loopback/admin) are unrestricted. (#1213)
  if (!ctx.operator && entry.guest_safe !== true) {
    const result = _outcome("denied", name, {
      reason_code: "operator_required",
      policy: entry.policy,
      error: `'${name}' (${entry.policy}) requires operator access`,
    });
    await _logToolExecution(name, input, "denied", "operator_required", startTime, ctx);
    return result;
  }

  try {
    // run() may be sync (returns a string) or async (returns a Promise); await covers both.
    // ctx is passed through so account-reading tools can forward the requesting
    // user's identity (ctx.userId) on their internal loopback hops.
    let out = String((await entry.run(input || {}, ctx)) || "");
    const outputLength = out.length;
    if (out.length > MAX_OUT) out = out.slice(0, MAX_OUT) + "\n…[truncated]";

    const result = _outcome("executed", name, { result: out, policy: entry.policy });
    await _logToolExecution(name, input, "executed", null, startTime, ctx, outputLength);
    return result;
  } catch (e) {
    const reasonCode = e.reason || "execution_error";
    const status = reasonCode === "unsafe_path" ||
      reasonCode === "command_not_allowlisted" ||
      reasonCode === "private_host_blocked"
      ? "blocked"
      : "unavailable";
    const result = _outcome(status, name, {
      reason_code: reasonCode,
      policy: entry.policy,
      error: String(e.stderr || e.message || e).slice(0, MAX_OUT),
    });
    await _logToolExecution(name, input, status, reasonCode, startTime, ctx, null, e.message);
    return result;
  }
}

// ── native Anthropic tool schemas (same single source of truth as the preamble) ──
// Renders the registry as `tools` for the Messages API. Cloud models (Haiku/Sonnet)
// emit native `tool_use` blocks, so they don't need the free-text preamble — they get
// the exact same name + input_schema. When !operator, advertise ONLY guest_safe
// (web-only) tools so a public-server guest's model never even sees the filesystem/
// shell/mutating tools (runTool still enforces guest_safe regardless — this just keeps
// the advertised surface honest). (#1213)
function anthropicTools({ operator = false } = {}) {
  return TOOL_NAMES
    .filter((name) => operator || REGISTRY[name].guest_safe === true)
    .map((name) => ({
      name,
      description: REGISTRY[name].desc,
      input_schema: REGISTRY[name].schema,
    }));
}

// Same single source of truth, rendered for the OpenAI / xAI function-calling API
// (chat/completions `tools`). OpenAI-compatible providers (GPT, Grok) emit native
// `tool_calls`, so they use this instead of the free-text preamble. Operator filter
// matches anthropicTools — runTool still enforces policy regardless.
function openaiTools({ operator = false } = {}) {
  return TOOL_NAMES
    .filter((name) => operator || REGISTRY[name].guest_safe === true)
    .map((name) => ({
      type: "function",
      function: {
        name,
        description: REGISTRY[name].desc,
        parameters: REGISTRY[name].schema,
      },
    }));
}

// Same registry rendered for the Gemini API (`tools[].functionDeclarations`). Gemini
// accepts an OpenAPI-subset schema; our schemas are already that subset, but we strip
// any keys Gemini rejects (e.g. additionalProperties) defensively. One element with all
// declarations, matching Gemini's expected shape.
function geminiTools({ operator = false } = {}) {
  const clean = (schema) => {
    if (!schema || typeof schema !== "object") return schema;
    const { additionalProperties, $schema, ...rest } = schema;
    if (rest.properties) {
      rest.properties = Object.fromEntries(
        Object.entries(rest.properties).map(([k, v]) => [k, clean(v)])
      );
    }
    return rest;
  };
  const functionDeclarations = TOOL_NAMES
    .filter((name) => operator || REGISTRY[name].guest_safe === true)
    .map((name) => ({
      name,
      description: REGISTRY[name].desc,
      parameters: clean(REGISTRY[name].schema),
    }));
  return [{ functionDeclarations }];
}

// ── parse the model's free-text <tool_call> (light JSON repair; not a vocab hack) ──
function parseToolCall(text) {
  if (!text || typeof text !== "string") return null;
  let inner = null;
  const m = text.match(/<\s*tool_call\s*>/i);
  if (m) {
    let rest = text.slice(m.index + m[0].length);
    const close = rest.search(/<\s*\/\s*tool_call\s*>/i);
    if (close !== -1) rest = rest.slice(0, close);
    inner = _firstJsonObject(rest);
  }
  if (inner === null) {
    // Fallback: many local models emit the call as a bare or ```json-fenced object
    // with NO <tool_call> wrapper, e.g. {"name":"web_search","input":{"query":"…"}}.
    // The `input` is itself a nested object, so the old non-greedy regex
    // (/\{…?"name"…?\}/) stopped at the first INNER "}" and handed _firstJsonObject a
    // truncated, unbalanceable string → every nested-input tool silently failed to
    // parse. Instead, scan each "{" and brace-balance to find the first COMPLETE
    // object that actually carries a string "name" (#1127 item 4: local tool-calling).
    for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
      const candidate = _firstJsonObject(text.slice(i));
      if (!candidate) continue;
      const probe = _loadsLenient(candidate);
      if (probe && typeof probe === "object" && typeof probe.name === "string" && probe.name.trim()) {
        inner = candidate;
        break;
      }
    }
  }
  if (inner === null) {
    // Final fallback: small local models often drop the {"name","input"} envelope
    // entirely and emit `<knownTool>{…args…}` — the tool name as a bare prefix with
    // the arguments inline as the object, e.g. web_search{"query":"…"}. Recognize it
    // ONLY for a name that is an actual registry tool (bounded → low false-positive),
    // mapping the inline object straight to `input`. (#1127 item 4.)
    for (const toolName of TOOL_NAMES) {
      const idx = text.indexOf(toolName);
      if (idx === -1) continue;
      const after = text.slice(idx + toolName.length).replace(/^[\s:>"'`]*/, "");
      if (!after.startsWith("{")) continue;
      const objStr = _firstJsonObject(after);
      if (!objStr) continue;
      const args = _loadsLenient(objStr);
      if (args && typeof args === "object") {
        // If the inline object is itself a {"name","input"} envelope, defer to the
        // standard path below instead of nesting it under input.
        if (typeof args.name === "string") { inner = objStr; break; }
        return { name: toolName, input: args };
      }
    }
  }
  if (inner === null) return null;
  const obj = _loadsLenient(inner);
  if (!obj || typeof obj !== "object") return null;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) return null;
  const input = (obj.input && typeof obj.input === "object") ? obj.input : {};
  return { name, input };
}

function _firstJsonObject(s) {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false, q = "";
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; }
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return s.slice(start);
}

function _loadsLenient(raw) {
  if (raw == null) return null;
  raw = String(raw).trim();
  try { return JSON.parse(raw); } catch {}
  let r = raw.replace(/,\s*([}\]])/g, "$1");           // trailing commas
  try { return JSON.parse(r); } catch {}
  r = r.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");         // invalid escapes -> literal backslash
  try { return JSON.parse(r); } catch {}
  return null;
}

async function _logToolExecution(name, input, status, errorCode, startTime, ctx = {}, outputLength = null, errorMessage = null) {
  const duration = Date.now() - startTime;
  try {
    await toolLogger.log({
      tool: name,
      input,
      status,
      error_code: errorCode,
      error_message: errorMessage,
      output_length: outputLength,
      duration_ms: duration,
      operator: ctx.operator ?? false,
      provider: ctx.provider || null,
      session_id: ctx.sessionId || null,
      user: ctx.user || null,
    });
  } catch (err) {
    // Logging errors should not crash tool execution
    console.warn(`[ToolRunner] Failed to log ${name}: ${err.message}`);
  }
}

module.exports = {
  parseToolCall,
  runTool,
  renderToolPreamble,
  anthropicTools,
  openaiTools,
  geminiTools,
  capabilityManifest,
  REGISTRY,
  TOOL_NAMES,
  CAPABILITY_SCHEMA_VERSION,
  RECEIPT_SCHEMA_VERSION,
};
