/**
 * lib/stream-chat/mcp-tools.js
 *
 * Give the keystone (dream) chat assistant access to the LOCAL MCP server's
 * *operational* tools — queue/task_run, research_*, the full github_* suite,
 * local_runner, local_git_*, convergence_run, mesh_*, mcp_capability_status — on
 * top of the built-in tool-runner surface it already has, for EVERY provider
 * (Ouro/Ollama, Grok, Gemini, Claude, OpenAI, Cohere).
 *
 * Design:
 *   augment(baseToolRunner) returns a thin wrapper that
 *     - appends the MCP operational tools to anthropicTools/openaiTools/geminiTools
 *       and renderToolPreamble — but ONLY when {operator:true} (these tools can
 *       drive GitHub writes and worktree execution), and
 *     - routes runTool(name, ...) for those names to the MCP server, leaving every
 *       built-in tool on the canonical tool-runner executor untouched.
 *
 * Execution goes through the MCP server's JSON-RPC `/messages` `tools/call`
 * endpoint (the same reliable path the stdio bridge uses). This module keeps its own
 * lightweight `_mcpRpc` for the operational-tool discovery + call flow; lib/mcp-client.js
 * now speaks the same `/messages` protocol too (it previously posted to a `/tool/<name>`
 * route the server never exposed — fixed in #2760).
 *
 * The operational tool DESCRIPTORS are discovered from the live server (tools/list,
 * filtered to `_meta.lantern.kind === "mcp_specific_operational"`), cached in
 * memory, and warm-started from data/mcp/operational-tools.json so the very first
 * chat turn after boot already has them.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const MCP_HOST = process.env.MCP_HOST || "127.0.0.1";       // #2759 configurable
const MCP_PORT = Number(process.env.MCP_PORT) || 8771;      // #2759 configurable
const WARM_FILE = path.resolve(__dirname, "../../data/mcp/operational-tools.json");
const REFRESH_INTERVAL_MS = 60_000;

let _descriptors = [];       // [{name, description, input_schema}]
let _names = new Set();
let _lastRefresh = 0;
let _refreshing = false;

// ── warm start: load the last-known operational descriptors synchronously ──
(function warmSync() {
  try {
    const raw = JSON.parse(fs.readFileSync(WARM_FILE, "utf8"));
    if (Array.isArray(raw)) _setDescriptors(raw);
  } catch { /* first boot / no file — cache fills on first refresh */ }
})();

function _setDescriptors(list) {
  _descriptors = list
    .filter((d) => d && typeof d.name === "string")
    .map((d) => ({
      name: d.name,
      description: String(d.description || ""),
      input_schema: d.input_schema || { type: "object", properties: {} },
    }));
  _names = new Set(_descriptors.map((d) => d.name));
}

function _mcpRpc(method, params, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || {} });
    const req = http.request(
      { host: MCP_HOST, port: MCP_PORT, path: "/messages", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error("mcp_invalid_json")); }
        });
        res.on("error", reject);
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("mcp_timeout")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Fire-and-forget refresh of the operational descriptor set from the live server.
async function _maybeRefresh() {
  const now = Date.now();
  if (_refreshing || now - _lastRefresh < REFRESH_INTERVAL_MS) return;
  _refreshing = true;
  try {
    const resp = await _mcpRpc("tools/list", {}, 4000);
    const tools = resp && resp.result && Array.isArray(resp.result.tools) ? resp.result.tools : [];
    const ops = tools
      .filter((t) => (t._meta && t._meta.lantern && t._meta.lantern.kind) === "mcp_specific_operational")
      .map((t) => ({ name: t.name, description: t.description || "", input_schema: t.inputSchema || { type: "object" } }));
    if (ops.length) {
      _setDescriptors(ops);
      _lastRefresh = now;
      try {
        fs.mkdirSync(path.dirname(WARM_FILE), { recursive: true });
        fs.writeFileSync(WARM_FILE, JSON.stringify(ops, null, 2) + "\n", "utf8");
      } catch { /* warm-file write is best-effort */ }
    }
  } catch { /* server offline — keep the warm cache */ }
  finally { _refreshing = false; }
}

function isMcpTool(name) { return _names.has(name); }

// ── schema cleaning for Gemini (mirrors tool-runner.geminiTools) ──
function _cleanSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const { additionalProperties, $schema, ...rest } = schema;
  if (rest.properties) {
    rest.properties = Object.fromEntries(
      Object.entries(rest.properties).map(([k, v]) => [k, _cleanSchema(v)])
    );
  }
  return rest;
}

// Execute an MCP operational tool via the server's JSON-RPC tools/call.
// Returns a tool-runner-shaped outcome so the chat blocks can treat it uniformly.
async function runMcpTool(name, input, timeoutMs = 30_000) {
  try {
    const resp = await _mcpRpc("tools/call", { name, arguments: input || {} }, timeoutMs);
    if (resp && resp.error) {
      return { ok: false, status: "error", reason_code: "mcp_error", error: resp.error.message || "mcp error", receipt: null };
    }
    const result = resp && resp.result ? resp.result : {};
    const text = result.content && result.content[0] && result.content[0].text != null
      ? String(result.content[0].text) : "";
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* non-JSON text result */ }
    // Shared-tool receipts carry {ok,status,...}; operational tools return their own dicts.
    if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "ok")) {
      return {
        ok: parsed.ok !== false,
        status: parsed.status || (parsed.ok !== false ? "executed" : "error"),
        reason_code: parsed.reason_code || null,
        policy: parsed.policy || null,
        receipt: parsed.receipt || null,
        error: parsed.error || null,
        result: typeof parsed.result === "string" ? parsed.result : text,
      };
    }
    return {
      ok: !result.isError,
      status: result.isError ? "error" : "executed",
      reason_code: null,
      receipt: null,
      error: result.isError ? text.slice(0, 500) : null,
      result: text,
    };
  } catch (e) {
    return { ok: false, status: "unavailable", reason_code: "mcp_offline", error: e.message, receipt: null };
  }
}

// ── per-format descriptor lists (operator-gated by the caller) ──
function anthropicMcpTools() {
  return _descriptors.map((d) => ({ name: d.name, description: d.description, input_schema: d.input_schema }));
}
function openaiMcpTools() {
  return _descriptors.map((d) => ({ type: "function", function: { name: d.name, description: d.description, parameters: d.input_schema } }));
}
function geminiMcpDeclarations() {
  return _descriptors.map((d) => ({ name: d.name, description: d.description, parameters: _cleanSchema(d.input_schema) }));
}
function preambleAddendum() {
  if (!_descriptors.length) return "";
  const lines = ["", "Additional tools (local MCP server — operator only):"];
  for (const d of _descriptors) {
    lines.push(`Tool: ${d.name}`);
    lines.push(`Description: ${d.description}`);
    lines.push(`Input (JSON schema): ${JSON.stringify(d.input_schema)}`);
  }
  return lines.join("\n");
}

/**
 * Wrap a tool-runner module so every provider block in stream-chat.js gains the
 * MCP operational tools with a single-line require swap. Operator gating is honored
 * via the {operator} flag the blocks already pass to the *Tools() methods.
 */
function augment(base) {
  _maybeRefresh(); // fire-and-forget; never blocks the turn

  const wrapper = Object.create(base);

  wrapper.anthropicTools = function (opts = {}) {
    const baseTools = base.anthropicTools(opts);
    return opts.operator ? baseTools.concat(anthropicMcpTools()) : baseTools;
  };
  wrapper.openaiTools = function (opts = {}) {
    const baseTools = base.openaiTools(opts);
    return opts.operator ? baseTools.concat(openaiMcpTools()) : baseTools;
  };
  wrapper.geminiTools = function (opts = {}) {
    const baseTools = base.geminiTools(opts);
    if (!opts.operator || !_descriptors.length) return baseTools;
    // base returns [{functionDeclarations:[...]}]; merge our declarations in.
    const decls = geminiMcpDeclarations();
    if (Array.isArray(baseTools) && baseTools[0] && Array.isArray(baseTools[0].functionDeclarations)) {
      const merged = baseTools.map((t) => ({ ...t }));
      merged[0] = { ...merged[0], functionDeclarations: merged[0].functionDeclarations.concat(decls) };
      return merged;
    }
    return (baseTools || []).concat([{ functionDeclarations: decls }]);
  };
  wrapper.renderToolPreamble = function (opts = {}) {
    const basePreamble = base.renderToolPreamble();
    return opts.operator ? basePreamble + "\n" + preambleAddendum() : basePreamble;
  };
  wrapper.runTool = function (name, input, ctx = {}) {
    if (isMcpTool(name)) {
      // Operator-gated defense in depth: never execute an MCP operational tool for
      // a non-operator, and honor the disabled-probe (executionEnabled:false) path.
      if (ctx && ctx.operator === false) {
        return Promise.resolve({ ok: false, status: "denied", reason_code: "operator_required",
          policy: "mcp", error: `'${name}' requires operator access`, receipt: null });
      }
      if (ctx && ctx.executionEnabled === false) {
        return Promise.resolve({ ok: false, status: "proposed", reason_code: "execution_disabled",
          policy: "mcp", error: "execution disabled", receipt: null });
      }
      return runMcpTool(name, input);
    }
    return base.runTool(name, input, ctx);
  };

  return wrapper;
}

module.exports = { augment, isMcpTool, runMcpTool, _maybeRefresh, _setDescriptors };
