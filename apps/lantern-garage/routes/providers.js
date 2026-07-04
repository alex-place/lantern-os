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
// The provider-router holds the in-process DISPATCH truth: which providers have
// actually succeeded/failed on real calls this run. Presence of a key is not
// validity — a key that 400s every call (depleted credits, revoked key) is
// "hasKey:true" but failing. Folding these records in is the #calm-while-wrong fix.
const { getProviderStatus } = require("../lib/provider-router");

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
  anthropic: { key: "ANTHROPIC_API_KEY", model: "claude-sonnet-5" },
  openai: { key: "OPENAI_API_KEY", model: "gpt-4o-mini" },
  gemini: { key: "GEMINI_API_KEY", model: "gemini-2.5-flash" },
  mistral: { key: "MISTRAL_API_KEY", model: "mistral-large-latest" },
  deepseek: { key: "DEEPSEEK_API_KEY", model: "deepseek-chat" },
  cohere: { key: "COHERE_API_KEY", model: "command-a-plus-05-2026" },
  perplexity: { key: "PERPLEXITY_API_KEY", model: "sonar-pro" },
  openrouter: { key: "OPENROUTER_API_KEY", model: "auto" },
  ollama: { key: null, model: "auto" },
  xai: { key: "XAI_API_KEY", model: "grok-3-mini" },
};

// Snapshot, at module load (server boot, before any request can lazily hydrate),
// which provider keys the process ACTUALLY started with. This is the dispatch
// baseline: the dispatcher reads process.env, so a key absent here was invisible
// to early requests no matter what a later status check pulls in. Surfacing this
// (vs. silently hydrating then reporting "connected") is the #1233 honesty fix.
const _envAtStartup = {};
for (const k of PROVIDER_KEY_ALLOWLIST) _envAtStartup[k] = !!process.env[k];

// ── Local model liveness (honest "ollama" availability) ─────────────────────
// /api/providers/status must tell the truth about the local Σ₀ model: it is
// "available" only when a model is actually being served on :11434, not merely
// configured. The status handler is synchronous (making it async would return a
// Promise for unmatched paths and break the (req,res)=>bool routing contract), so
// we keep a short-TTL cache refreshed by a NON-blocking background probe rather
// than awaiting a network call per request. Mirrors routes/status.js probeLocalModel.
const _LOCAL_TTL_MS = 4000;
let _localModel = { serving: false, served_models: [], active_model: null, pinned: null, pinned_served: false, ts: 0 };
let _localProbeInFlight = false;
function _refreshLocalModel() {
  if (_localProbeInFlight || Date.now() - _localModel.ts < _LOCAL_TTL_MS) return;
  const base = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const pinned = process.env.OLLAMA_MODEL || null;
  let u;
  try { u = new URL(base); } catch { return; }
  _localProbeInFlight = true;
  const done = (patch) => {
    _localModel = Object.assign(
      { serving: false, served_models: [], active_model: null, pinned, pinned_served: false },
      patch, { ts: Date.now() });
    _localProbeInFlight = false;
  };
  const r = require("http").request(
    { hostname: u.hostname, port: u.port || 11434, path: "/api/tags", method: "GET" },
    (up) => { let d = ""; up.on("data", (c) => (d += c)); up.on("end", () => {
      let served = [];
      try { served = (JSON.parse(d).models || []).map((m) => String(m.name || "")).filter(Boolean); } catch { /* bad json → no models */ }
      const norm = (s) => String(s || "").replace(/:latest$/, "").toLowerCase();
      const pinnedServed = !!pinned && served.some((m) => norm(m) === norm(pinned));
      done({ serving: true, served_models: served, pinned_served: pinnedServed,
             active_model: pinnedServed ? pinned : (served[0] || null) });
    }); });
  r.on("error", () => done({ serving: false }));
  r.setTimeout(800, () => { r.destroy(); });   // never hang the status endpoint
  r.end();
}
_refreshLocalModel(); // warm the cache at module load

// Probe the OS registry for ALL allowlisted keys in ONE PowerShell call (per-key
// spawns were ~20 serial processes — slow enough to hang the status endpoint).
// User scope preferred, then Machine — Start-DualServers.ps1 hydrates BOTH at
// boot, so the lazy fallback must check both or a Machine-only key never loads
// (a root cause of #1233). Snapshot cached with a TTL.
const _REG_TTL_MS = 60_000;
let _registrySnapshot = null;
let _registryAt = 0;
function _loadRegistrySnapshot() {
  if (_registrySnapshot && Date.now() - _registryAt < _REG_TTL_MS) return _registrySnapshot;
  const list = PROVIDER_KEY_ALLOWLIST.map((k) => `'${k}'`).join(",");
  const ps = `$o=@{}; foreach($k in @(${list})){ $o[$k]=@{User=[Environment]::GetEnvironmentVariable($k,'User'); Machine=[Environment]::GetEnvironmentVariable($k,'Machine')} }; $o | ConvertTo-Json -Compress`;
  const snap = {};
  try {
    const out = execFileSync("powershell", ["-NonInteractive", "-Command", ps], { timeout: 8_000, encoding: "utf8" });
    const parsed = JSON.parse(out);
    for (const k of PROVIDER_KEY_ALLOWLIST) {
      const e = parsed[k] || {};
      const u = (e.User || "").trim();
      const m = (e.Machine || "").trim();
      const value = u || m;
      snap[k] = { present: !!value, scope: u ? "User" : (m ? "Machine" : null), value };
    }
  } catch {
    for (const k of PROVIDER_KEY_ALLOWLIST) snap[k] = { present: false, scope: null, value: "" };
  }
  _registrySnapshot = snap;
  _registryAt = Date.now();
  return snap;
}
function _probeRegistry(key) {
  return _loadRegistrySnapshot()[key] || { present: false, scope: null, value: "" };
}

let _keysSynced = false;
function _syncUserEnvKeys() {
  if (_keysSynced) return;
  _keysSynced = true;
  for (const k of PROVIDER_KEY_ALLOWLIST) {
    if (!process.env[k]) {
      const reg = _probeRegistry(k);
      if (reg.value) process.env[k] = reg.value;
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
    { provider: "anthropic", models: ["claude-sonnet-5"] },
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
    { provider: "cohere", models: ["command-a-plus-05-2026"] },
  ],
  default: [
    { provider: "ollama", models: ["lantern-csf-dream", "qwen2.5-coder"] },
    { provider: "gemini", models: ["gemini-2.5-flash"] },
    { provider: "anthropic", models: ["claude-sonnet-4-6"] },
    { provider: "openai", models: ["gpt-4o-mini"] },
    { provider: "mistral", models: ["mistral-large-latest"] },
  ],
};

// Fold the provider-router's in-process dispatch state into an HONEST health
// verdict for one provider. `hasKey`/`inProcessEnv` is presence; this is validity.
// Precedence: no_key → blocked (rate-limited) → failing (last call failed, none since)
// → ok (a real success on record) → untested (key present, nothing dispatched yet).
function _computeDispatchHealth(rstate, inProcessEnv, nowMs) {
  const st = rstate || {};
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const lastFailure = st.lastFailure || 0;
  const lastSuccess = st.lastSuccess || 0;
  const blocked = !!st.blockedUntil && st.blockedUntil > now;
  let health;
  if (!inProcessEnv) health = "no_key";
  else if (blocked) health = "blocked";
  else if (lastFailure > 0 && lastFailure >= lastSuccess) health = "failing";
  else if (lastSuccess > 0) health = "ok";
  else health = "untested";
  return {
    health,
    // A caller that only wants a boolean: untested keys are optimistically usable;
    // a recorded failure with no later success is NOT.
    healthy: health === "ok" || health === "untested",
    lastError: st.lastError || null,
    consecutiveFailures: st.consecutiveFailures || 0,
    lastFailureAt: lastFailure ? new Date(lastFailure).toISOString() : null,
    lastSuccessAt: lastSuccess ? new Date(lastSuccess).toISOString() : null,
    blockedUntil: blocked ? new Date(st.blockedUntil).toISOString() : null,
  };
}

module.exports = async function providerRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody } = deps;

  _syncUserEnvKeys();

  // ── GET /api/providers/models ──────────────────────────────────────────
  // Per-provider model choices for the chat UI's model dropdown (#1127 work
  // item 1). Keyed by the UI's provider names (claude/openai/gemini/grok);
  // `default` is the effective modelFor() resolution (env override included)
  // so the dropdown reflects what Auto would actually run.
  if (req.method === "GET" && url.pathname === "/api/providers/models") {
    const { CHAT_MODEL_OPTIONS, modelFor } = require("../lib/provider-models");
    const UI_NAME = { anthropic: "claude", openai: "openai", gemini: "gemini", xai: "grok" };
    const out = {};
    for (const [internal, options] of Object.entries(CHAT_MODEL_OPTIONS)) {
      out[UI_NAME[internal] || internal] = { default: modelFor(internal), options };
    }
    sendJson(res, { providers: out }, 200);
    return true;
  }

  // ── GET /api/providers/status ──────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/providers/status") {
    const providers = {};
    const chainsByType = {};
    const warnings = [];
    // Snapshot the in-process dispatch record once (provider name keys match
    // PROVIDER_CONFIGS: anthropic/openai/gemini/xai/…). Never let a router hiccup
    // break the status endpoint.
    let routerState = {};
    try { routerState = getProviderStatus() || {}; } catch { routerState = {}; }
    const nowMs = Date.now();

    for (const [provider, cfg] of Object.entries(PROVIDER_CONFIGS)) {
      if (!cfg.key) { // ollama — the local Σ₀ model server (keyless)
        _refreshLocalModel(); // non-blocking; returns the cached probe result
        const L = _localModel;
        providers[provider] = {
          hasKey: false,
          // Honest: "available" only when a model is genuinely being served on
          // :11434, not merely configured (was hardcoded true — the fake-option bug).
          available: L.serving && L.served_models.length > 0,
          model: L.active_model || cfg.model,
          serving: L.serving,
          served_models: L.served_models,
          pinned: L.pinned,
          pinned_served: L.pinned_served,
          inProcessEnv: false, startedWithKey: false, inRegistry: false,
          registryScope: null, mismatch: false, lastCheck: new Date().toISOString(),
          // Local model has no key; treat "is it serving" as its dispatch presence
          // so a crashed-mid-serve local model reads as failing, not silently ok.
          ...(() => {
            const d = _computeDispatchHealth(routerState[provider], L.serving && L.served_models.length > 0, nowMs);
            return { health: d.health, dispatch: d };
          })(),
        };
        continue;
      }
      // process.env is the DISPATCH SOURCE OF TRUTH. startedWithKey is what the
      // process booted with; inRegistry is what the OS has. A key in the registry
      // the process did NOT start with = the #1233 mismatch (early dispatch sees
      // nothing even though the UI would otherwise say "connected").
      const inProcessEnv = !!process.env[cfg.key];
      const startedWithKey = !!_envAtStartup[cfg.key];
      const reg = _probeRegistry(cfg.key);
      const mismatch = reg.present && !startedWithKey;
      // Validity, not just presence: fold in the last real dispatch outcome so a
      // present-but-depleted/revoked key reads as health:"failing" (+ lastError),
      // instead of the calm-while-wrong "ok". hasKey/available stay presence-based
      // for back-compat; `health`/`dispatch` are the honest signal.
      const dispatch = _computeDispatchHealth(routerState[provider], inProcessEnv, nowMs);
      providers[provider] = {
        hasKey: inProcessEnv,                 // back-compat: reflects process.env
        available: inProcessEnv,              // dispatch-ready only if the process can see the key
        health: dispatch.health,              // no_key | blocked | failing | ok | untested
        dispatch,                             // { lastError, consecutiveFailures, lastFailureAt, … }
        model: cfg.model,
        inProcessEnv,
        startedWithKey,
        inRegistry: reg.present,
        registryScope: reg.scope,
        mismatch,
        lastCheck: new Date().toISOString(),
      };
      if (mismatch) {
        warnings.push({
          provider, key: cfg.key, registryScope: reg.scope, hydratedAtRuntime: inProcessEnv,
          message: `${cfg.key} is set in ${reg.scope || "OS"} env but the running process did not start with it`
            + (inProcessEnv ? " (hydrated on-demand; early requests before this check may have failed)."
                            : " — the dispatcher will report \"all providers failed\". Restart via Start-DualServers.ps1 to hydrate at boot."),
        });
      }
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

    // envConsistent is the #1233 key/registry-mismatch signal ONLY — capture it
    // before folding in dispatch-failure warnings so a bad key doesn't masquerade
    // as an "inconsistent env".
    const envConsistent = warnings.length === 0;
    const failingProviders = Object.entries(providers)
      .filter(([, p]) => p.health === "failing" || p.health === "blocked")
      .map(([name]) => name);
    // A present key that FAILS on dispatch is the calm-while-wrong case — surface it
    // as a warning too, not only as a per-provider field.
    for (const name of failingProviders) {
      const p = providers[name];
      warnings.push({
        provider: name,
        health: p.health,
        lastError: p.dispatch && p.dispatch.lastError,
        message: `${name} has a key but its last dispatch ${p.health === "blocked" ? "was rate-limited/blocked" : "FAILED"}`
          + (p.dispatch && p.dispatch.lastError ? ` (${p.dispatch.lastError})` : "")
          + " — key present is not key valid.",
      });
    }

    sendJson(res, {
      providers,
      chains: chainsByType,
      warnings,
      summary: {
        available, hasKeys,
        failing: failingProviders.length,
        total: Object.keys(providers).length,
        envConsistent,
        allHealthy: failingProviders.length === 0,
      },
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
    // #1946 G3: on the desktop app, a key stored in the DPAPI vault counts as "set"
    // even when it isn't in process.env (tenant.js reads the vault as a fallback).
    const keyVault = require("../lib/key-vault");
    const appPaths = require("../lib/app-paths");
    const vaultOn = appPaths.isDesktop() && keyVault.isSupported();
    const keys = PROVIDER_KEY_ALLOWLIST.map(k => {
      const reg = _probeRegistry(k);
      const vaulted = vaultOn && keyVault.hasKey(k);
      return {
        env: k,
        set: !!process.env[k] || vaulted, // dispatch source of truth (process.env) + vault
        vaulted,
        startedWith: !!_envAtStartup[k],  // booted with it?
        inRegistry: reg.present,          // present in User/Machine env?
        registryScope: reg.scope,
        mismatch: reg.present && !_envAtStartup[k],
        masked: process.env[k] ? maskValue(process.env[k]) : null,
      };
    });
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

      // Save to session env so it's usable immediately.
      process.env[key] = value;
      _keysSynced = false; // re-sync on next check

      // #1946 G3: on the desktop app persist the key DPAPI-ENCRYPTED in the OS key
      // vault — NEVER plaintext, so no Windows User-env write. lib/tenant.js already
      // reads the vault as a fallback, so a vault-stored key survives restart.
      // Servers keep the existing best-effort plaintext User-env persistence.
      const keyVault = require("../lib/key-vault");
      const appPaths = require("../lib/app-paths");
      let persisted = false, vaulted = false;
      if (appPaths.isDesktop() && keyVault.isSupported()) {
        try { keyVault.setKey(key, value); vaulted = true; } catch { /* stays in session env */ }
      } else {
        try {
          const escaped = value.replace(/"/g, '`"');
          execFileSync("powershell", [
            "-NonInteractive", "-Command",
            `[System.Environment]::SetEnvironmentVariable('${key}', "${escaped}", 'User')`,
          ], { timeout: 10_000 });
          persisted = true;
        } catch { /* Silent fail; key is still in session */ }
      }

      sendJson(res, {
        ok: true,
        provider,
        key,
        persisted,
        vaulted,
        masked: maskValue(value),
      });
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }

  return false;
};

// Exposed for unit testing (the calm-while-wrong health verdict is pure logic).
module.exports._computeDispatchHealth = _computeDispatchHealth;
