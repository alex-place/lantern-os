"use strict";
/**
 * tool-runner.js — one canonical tool registry for the local Σ₀ Ouro coder in chat.
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
const { tokenizeCommand, safeExec } = require("./safe-exec");
const { resolveCommand } = require("./command-allowlist");

const REPO = path.resolve(__dirname, "..", "..", "..");
const MAX_OUT = 4000;
const SKIP_DIR = /(^|[\\/])(\.git|node_modules|\.venv|\.venv-train|hf-cache)([\\/]|$)/;

function _safe(p) {
  const abs = path.resolve(REPO, String(p == null ? "." : p));
  if (abs !== REPO && !abs.startsWith(REPO + path.sep)) throw new Error("path escapes repo");
  return abs;
}

function _globToRe(glob) {
  let re = String(glob || "*").replace(/[.+^${}()|[\]\\]/g, "\\$&");
  re = re.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + re + "$", "i");
}

function _runShell(command) {
  const cmd = String(command || "").trim();
  const resolved = resolveCommand(cmd);
  if (!resolved) { const e = new Error(`command not allowlisted: ${cmd}`); e.reason = "unsafe"; throw e; }
  return safeExec(tokenizeCommand(resolved), {
    cwd: REPO, encoding: "utf-8", timeout: 30000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

// ── canonical registry (names/schemas == training == Claude Code) ───────────────
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
};

const TOOL_NAMES = Object.keys(REGISTRY);

function renderToolPreamble() {
  const lines = [
    "You can use tools. To answer the user directly, reply in plain text.",
    "When you need a tool, respond with EXACTLY ONE tool call on a SINGLE LINE, nothing else, in this exact format (no code fences, no blank lines):",
    '<tool_call>{"name": "TOOL_NAME", "input": {"ARG": "VALUE"}}</tool_call>',
    'Rules: "name" must be one of the tools below, spelled exactly. "input" is a JSON object of arguments. Double quotes only, no trailing commas. Emit the call and STOP; do not explain it. Only call a tool if needed.',
    "",
    "Available tools:",
  ];
  for (const name of TOOL_NAMES) {
    const t = REGISTRY[name];
    const ex = {}; (t.schema.required || []).slice(0, 2).forEach((k) => { ex[k] = "..."; });
    lines.push(`Tool: ${name}`);
    lines.push(`Description: ${t.desc}`);
    lines.push(`Input (JSON schema): ${JSON.stringify(t.schema)}`);
    lines.push(`Example: <tool_call>${JSON.stringify({ name, input: ex })}</tool_call>`);
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
function runTool(name, input, ctx = {}) {
  const entry = REGISTRY[name];
  if (!entry) return { ok: false, reason: "unknown", error: `unknown tool '${name}' (available: ${TOOL_NAMES.join(", ")})` };
  if (entry.policy !== "read" && !ctx.operator) {
    return { ok: false, reason: "auth", policy: entry.policy, error: `'${name}' (${entry.policy}) requires operator access` };
  }
  try {
    let out = String(entry.run(input || {}) || "");
    if (out.length > MAX_OUT) out = out.slice(0, MAX_OUT) + "\n…[truncated]";
    return { ok: true, result: out, policy: entry.policy };
  } catch (e) {
    return { ok: false, reason: e.reason || "error", policy: entry.policy, error: String(e.stderr || e.message || e).slice(0, MAX_OUT) };
  }
}

// ── native Anthropic tool schemas (same single source of truth as the preamble) ──
// Renders the registry as `tools` for the Messages API. Cloud models (Haiku/Sonnet)
// emit native `tool_use` blocks, so they don't need the free-text preamble — they get
// the exact same name + input_schema. When !operator, advertise ONLY read-policy tools
// so the model never emits a shell/mutating call the policy would reject (runTool still
// enforces the policy regardless — this just keeps the advertised surface honest).
function anthropicTools({ operator = false } = {}) {
  return TOOL_NAMES
    .filter((name) => operator || REGISTRY[name].policy === "read")
    .map((name) => ({
      name,
      description: REGISTRY[name].desc,
      input_schema: REGISTRY[name].schema,
    }));
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

module.exports = { parseToolCall, runTool, renderToolPreamble, anthropicTools, REGISTRY, TOOL_NAMES };
