/**
 * Provider Management Routes
 *
 * GET  /api/providers/status   — provider availability, keys, health
 * GET  /api/providers/keys     — list all provider keys (masked)
 * POST /api/providers/keys     — save a provider API key
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { loadClaudeSessionUsage } = require("../lib/claude-session-usage");

// Normalize a leaderboard agentId (a model OR provider name) to a provider
// bucket so local models and cloud providers consolidate into one reliance
// table. Anything not matching a known cloud name is an Ollama-hosted local.
const CLOUD_NAME_MAP = {
  anthropic: "claude", claude: "claude",
  openai: "openai", gpt: "openai",
  gemini: "gemini", google: "gemini",
  mistral: "mistral", deepseek: "deepseek", cohere: "cohere",
  perplexity: "perplexity", openrouter: "openrouter",
  xai: "xai", grok: "xai",
};
function normProvider(agentId) {
  const a = String(agentId || "").toLowerCase();
  for (const [needle, provider] of Object.entries(CLOUD_NAME_MAP)) {
    if (a.includes(needle)) return { provider, kind: "cloud" };
  }
  return { provider: "local", kind: "local" };
}
function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n); }

// Windows User environment sync — reads provider API keys from User scope
const PROVIDER_KEY_ALLOWLIST = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "COHERE_API_KEY",
  "PERPLEXITY_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
];

const PROVIDER_CONFIGS = {
  anthropic: { key: "ANTHROPIC_API_KEY", model: "claude-opus-4-8" },
  openai: { key: "OPENAI_API_KEY", model: "gpt-4o-mini" },
  gemini: { key: "GEMINI_API_KEY", model: "gemini-2.5-flash" },
  mistral: { key: "MISTRAL_API_KEY", model: "mistral-large-latest" },
  deepseek: { key: "DEEPSEEK_API_KEY", model: "deepseek-chat" },
  cohere: { key: "COHERE_API_KEY", model: "command-r-plus" },
  perplexity: { key: "PERPLEXITY_API_KEY", model: "sonar-pro" },
  openrouter: { key: "OPENROUTER_API_KEY", model: "auto" },
  ollama: { key: null, model: "auto" },
  xai: { key: "XAI_API_KEY", model: "grok-3-mini" },
};

function _readWindowsUserEnv(key) {
  try {
    const val = execFileSync("powershell", [
      "-NonInteractive", "-Command",
      `[System.Environment]::GetEnvironmentVariable('${key}', 'User')`,
    ], { timeout: 5_000, encoding: "utf8" }).trim();
    return val || "";
  } catch { return ""; }
}

let _keysSynced = false;
function _syncUserEnvKeys() {
  if (_keysSynced) return;
  _keysSynced = true;
  for (const k of PROVIDER_KEY_ALLOWLIST) {
    if (!process.env[k]) {
      const val = _readWindowsUserEnv(k);
      if (val) process.env[k] = val;
    }
  }
}

function maskValue(val) {
  if (!val || val.length < 8) return "•••";
  return val.substring(0, 4) + "•".repeat(Math.max(3, val.length - 8)) + val.substring(val.length - 4);
}

// Provider chains by task type (mirrors provider-router.js)
const PROVIDER_CHAINS = {
  kernel: [
    { provider: "ollama", models: ["keystone-ft", "ouro:latest"] },
    { provider: "anthropic", models: ["claude-opus-4-8"] },
  ],
  coding: [
    { provider: "ollama", models: ["qwen2.5-coder", "deepseek"] },
    { provider: "mistral", models: ["mistral-large-latest"] },
    { provider: "anthropic", models: ["claude-opus-4-8", "claude-sonnet-4-6"] },
    { provider: "openai", models: ["gpt-4-turbo", "gpt-4o-mini"] },
    { provider: "deepseek", models: ["deepseek-chat"] },
  ],
  reasoning: [
    { provider: "anthropic", models: ["claude-opus-4-8", "claude-sonnet-4-6"] },
    { provider: "openai", models: ["gpt-4-turbo"] },
    { provider: "gemini", models: ["gemini-2.5-pro"] },
    { provider: "deepseek", models: ["deepseek-chat"] },
    { provider: "mistral", models: ["mistral-large-latest"] },
  ],
  creative: [
    { provider: "ollama", models: ["lantern-csf-dream"] },
    { provider: "mistral", models: ["mistral-large-latest"] },
    { provider: "openai", models: ["gpt-4o"] },
    { provider: "gemini", models: ["gemini-2.5-flash"] },
    { provider: "cohere", models: ["command-r-plus"] },
  ],
  default: [
    { provider: "ollama", models: ["lantern-csf-dream", "qwen2.5-coder"] },
    { provider: "gemini", models: ["gemini-2.5-flash"] },
    { provider: "anthropic", models: ["claude-sonnet-4-6"] },
    { provider: "openai", models: ["gpt-4o-mini"] },
    { provider: "mistral", models: ["mistral-large-latest"] },
  ],
};

module.exports = async function providerRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody } = deps;

  _syncUserEnvKeys();

  // ── GET /api/providers/status ──────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/providers/status") {
    const providers = {};
    const chainsByType = {};

    for (const [provider, cfg] of Object.entries(PROVIDER_CONFIGS)) {
      const keyVal = cfg.key ? process.env[cfg.key] : null;
      const hasKeyVal = !!keyVal;

      providers[provider] = {
        hasKey: hasKeyVal,
        available: hasKeyVal || provider === "ollama",
        model: cfg.model,
        lastCheck: new Date().toISOString(),
      };
    }

    for (const [taskType, chain] of Object.entries(PROVIDER_CHAINS)) {
      chainsByType[taskType] = chain.map(c => ({
        provider: c.provider,
        models: c.models,
        available: providers[c.provider]?.available || false,
      }));
    }

    const available = Object.values(providers).filter(p => p.available).length;
    const hasKeys = Object.values(providers).filter(p => p.hasKey).length;

    sendJson(res, {
      providers,
      chains: chainsByType,
      summary: { available, hasKeys, total: Object.keys(providers).length },
    });
    return true;
  }

  // ── GET /api/providers/reliance ────────────────────────────────────────
  // Consolidated "who is actually doing the AI work" view. Merges cloud-Claude
  // reliance (from Claude Code transcripts) with chat-model outcomes (from
  // agent-performance.jsonl), normalized to one provider table with share +
  // reliability. Σ₀: every unit is a real recorded turn or call.
  if (req.method === "GET" && url.pathname === "/api/providers/reliance") {
    const band = url.searchParams.get("band") || "all";
    const bandDays = { "24h": 1, "7d": 7, "30d": 30 }[band] || null;
    const cutoff = bandDays ? Date.now() - bandDays * 86400000 : 0;

    let claude = null;
    try { claude = loadClaudeSessionUsage(process.cwd()); } catch { /* no transcripts */ }
    const claudeUnits = claude ? (claude.bandTurns?.[band] ?? claude.bandTurns?.all ?? claude.turns) : 0;

    // Chat-model reliance from the leaderboard log.
    const perfPath = path.resolve(__dirname, "..", "..", "data", "agent-performance.jsonl");
    const chat = {};
    try {
      const raw = fs.readFileSync(perfPath, "utf8").replace(/^﻿/, "");
      for (const line of raw.split(/\r?\n/)) {
        if (!line) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        const ts = r.timestamp ? new Date(r.timestamp).getTime() : 0;
        if (cutoff && ts < cutoff) continue;
        const { provider, kind } = normProvider(r.agentId);
        if (!chat[provider]) chat[provider] = { units: 0, successes: 0, kind, models: new Set() };
        chat[provider].units += 1;
        if (r.success) chat[provider].successes += 1;
        if (r.agentId) chat[provider].models.add(r.agentId);
      }
    } catch { /* no chat data yet */ }

    const rows = [];
    if (claude && claudeUnits > 0) {
      const detail = Object.entries(claude.byModel || {})
        .sort((a, b) => b[1].turns - a[1].turns)
        .map(([m, v]) => `${m.replace(/^claude-/, "").replace(/-\d.*$/, "")} ${fmtK(v.turns)}`)
        .join(" · ");
      rows.push({
        provider: "claude", label: "Claude", kind: "cloud",
        source: "Claude Code (engineering)",
        units: claudeUnits, successRate: null, detail,
        outputTokens: claude.outputTokens, sessions: claude.sessions,
      });
    }
    for (const [provider, c] of Object.entries(chat)) {
      rows.push({
        provider,
        label: provider === "local" ? "Local (Ollama)" : provider[0].toUpperCase() + provider.slice(1),
        kind: c.kind, source: "chat serving",
        units: c.units,
        successRate: c.units ? c.successes / c.units : null,
        detail: [...c.models].slice(0, 4).join(", "),
      });
    }
    const total = rows.reduce((s, r) => s + r.units, 0) || 1;
    rows.forEach(r => { r.share = r.units / total; });
    rows.sort((a, b) => b.units - a.units);

    sendJson(res, {
      generatedAt: new Date().toISOString(),
      band,
      totalUnits: rows.reduce((s, r) => s + r.units, 0),
      hasClaudeSessions: !!claude,
      providers: rows,
      note: claude ? null : "No Claude Code transcripts found on this host — Claude reliance unavailable here.",
    });
    return true;
  }

  // ── GET /api/providers/keys ────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/providers/keys") {
    const keys = PROVIDER_KEY_ALLOWLIST.map(k => ({
      env: k,
      set: !!process.env[k],
      masked: process.env[k] ? maskValue(process.env[k]) : null,
    }));
    sendJson(res, { keys });
    return true;
  }

  // ── POST /api/providers/keys ───────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/providers/keys") {
    let body;
    try {
      body = await collectRequestBody(req);
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
      return true;
    }
    try {
      const data = JSON.parse(body || "{}");
      const { provider, key, value } = data;

      if (!provider || !key || !value) {
        sendJson(res, { error: "provider, key, and value required" }, 400);
        return true;
      }

      if (!PROVIDER_KEY_ALLOWLIST.includes(key)) {
        sendJson(res, { error: "invalid key name" }, 400);
        return true;
      }

      // Save to session env
      process.env[key] = value;
      _keysSynced = false; // re-sync on next check

      // Try to save to Windows user environment (best-effort)
      let persisted = false;
      try {
        const escaped = value.replace(/"/g, '`"');
        execFileSync("powershell", [
          "-NonInteractive", "-Command",
          `[System.Environment]::SetEnvironmentVariable('${key}', "${escaped}", 'User')`,
        ], { timeout: 10_000 });
        persisted = true;
      } catch {
        // Silent fail; key is still in session
      }

      sendJson(res, {
        ok: true,
        provider,
        key,
        persisted,
        masked: maskValue(value),
      });
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }

  return false;
};
