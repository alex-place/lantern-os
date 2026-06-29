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
const { workspaceWrite, workspaceRead, workspaceList, getWorkspaceRoot } = require("./user-workspace");
const { createDocument, listTemplates } = require("./doc-generator");
const toolLogger = require("./tool-logger");
const entryStore = require("./entry-store");
const { getCreatorRuntime } = require("./creator-runtime");

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

function _runShell(command) {
  const cmd = String(command || "").trim();
  const resolved = resolveCommand(cmd);
  if (!resolved) throw _codedError(`command not allowlisted: ${cmd}`, "command_not_allowlisted");
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
    policy: "shell", desc: "Run an allowlisted shell command (git/tests/file-reads). Operator only.",
    schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    run(i) { return _runShell(i.command); },
  },
  PowerShell: {
    policy: "shell", desc: "Run an allowlisted command (same allowlist as Bash). Operator only.",
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

  // ── ADR-0008 user workspace tools ──────────────────────────────────────────
  workspace_write: {
    policy: "mutating",
    desc: "Write a file to the user workspace (~/.keystone/workspace/). Use for saving user artifacts: resumes, cover letters, documents. Path must be relative, no .. escapes. Operator only.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path, e.g. 'resumes/my-resume.md'" },
        content: { type: "string", description: "File content to write" },
      },
      required: ["path", "content"],
    },
    run(i) {
      const abs = workspaceWrite(String(i.path || ""), String(i.content || ""));
      return `wrote workspace:${i.path} (${String(i.content || "").length} bytes)\nfull path: ${abs}`;
    },
  },

  workspace_read: {
    policy: "read",
    desc: "Read a file from the user workspace (~/.keystone/workspace/). Path must be relative.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path to read" },
      },
      required: ["path"],
    },
    run(i) {
      const content = workspaceRead(String(i.path || ""));
      return content.length > MAX_OUT ? content.slice(0, MAX_OUT) + "\n…[truncated]" : content;
    },
  },

  workspace_list: {
    policy: "read",
    desc: "List files and directories in the user workspace (~/.keystone/workspace/) or a subdirectory.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative directory to list (default: root)" },
      },
      required: [],
    },
    run(i) {
      const entries = workspaceList(String(i.path || ""));
      const root = getWorkspaceRoot();
      if (!entries.length) return `workspace:${i.path || "/"} is empty\nroot: ${root}`;
      const lines = [`workspace:${i.path || "/"} — ${entries.length} entries (root: ${root})`];
      entries.forEach((e) => lines.push(`  ${e.type === "dir" ? "[dir]" : "[file]"} ${e.name}${e.type === "file" ? ` (${e.size}B)` : ""}`));
      return lines.join("\n");
    },
  },

  // ── ADR-0008 document generation (#1097) ────────────────────────────────────
  create_document: {
    policy: "mutating",
    desc: 'Generate a document from a template and save it to the user workspace. Templates: "resume", "cover_letter". Pass structured fields matching the template. Returns the workspace path of the created file. Operator only.',
    schema: {
      type: "object",
      properties: {
        template: { type: "string", description: '"resume" or "cover_letter"' },
        fields: { type: "object", description: "Template-specific fields (name, email, experience, etc.)" },
        output_path: { type: "string", description: "Optional workspace-relative output path (auto-generated if omitted)" },
      },
      required: ["template", "fields"],
    },
    run(i) {
      if (!i.template) return "[error: template is required]";
      if (!i.fields || typeof i.fields !== "object") return "[error: fields must be an object]";
      try {
        const result = createDocument(String(i.template), i.fields, i.output_path || null);
        return [
          `created ${result.template}: workspace:${result.path}`,
          `full path: ${result.fullPath}`,
          `size: ${result.byteLength} bytes`,
          "",
          "--- preview (first 500 chars) ---",
          result.content.slice(0, 500) + (result.content.length > 500 ? "\n…" : ""),
        ].join("\n");
      } catch (e) {
        const tmplList = listTemplates().map((t) => `  ${t.name}: ${t.description}`).join("\n");
        return `[create_document error: ${e.message}]\n\nAvailable templates:\n${tmplList}`;
      }
    },
  },
  // ── workspace tools (ADR-0008 §Decision 4): user-artifact area outside the repo ────
  // User artifacts (resumes, exports, generated docs) are written to WORKSPACE, never into
  // the repo. Each tool uses _safeWs() to reject path-escape attempts before touching disk.
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
    desc: "Run the Keystone eval harness (eval_keystone.py) against a local Ollama endpoint. Returns a structured receipt with accuracy and latency. Endpoint must be loopback-only.",
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
    let out = String((await entry.run(input || {})) || "");
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
  if (inner === null) { const b = text.match(/\{[\s\S]*?"name"[\s\S]*?\}/); if (b) inner = _firstJsonObject(b[0]); }
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
