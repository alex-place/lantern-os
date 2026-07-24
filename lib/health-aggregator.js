"use strict";
/**
 * Single boot health-check + readiness gate (#1551).
 *
 * One signal for what is ACTUALLY running. Enumerates every moving part — this web
 * server, the local model (Ollama), the MCP server, the dev dual-server, the trader, and
 * the cloud providers — as up / down / disabled-with-reason, and rolls them into one
 * overall verdict. No more "lots of half-running machinery" with no way to tell what's live.
 *
 * The rollup + provider derivation are pure (testable); probeAll() does the live port
 * probes and env checks.
 */
const net = require("net");

// Is something listening on host:port? connect ok → in use; refused/timeout → free.
// (Inlined rather than depending on lib/port-guard so this stays self-contained.)
function probePort(port, host = "127.0.0.1", timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; try { sock.destroy(); } catch { /* noop */ } resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

// Pure rollup over a list of subsystem states. A `critical` subsystem being down takes the
// whole system to "down"; any non-critical down/absent → "degraded"; all up → "up".
function assembleHealth(subsystems) {
  const list = subsystems || [];
  const up = list.filter((s) => s.state === "up");
  const down = list.filter((s) => s.state === "down");
  const disabled = list.filter((s) => s.state === "disabled");
  const criticalDown = down.some((s) => s.critical);
  const overall = list.length === 0 ? "unknown" : (criticalDown ? "down" : (down.length ? "degraded" : "up"));
  return {
    overall,
    counts: { up: up.length, down: down.length, disabled: disabled.length, total: list.length },
    subsystems: list,
  };
}

// Which cloud providers are configured (key present) vs not — pure given an env-like object.
function providerStates(env) {
  const defs = [
    { name: "anthropic", key: "ANTHROPIC_API_KEY" },
    { name: "openai", key: "OPENAI_API_KEY" },
    { name: "gemini", key: "GEMINI_API_KEY" },
    { name: "google-vertex", key: "GOOGLE_API_KEY" },
    { name: "xai", key: "XAI_API_KEY" },
  ];
  return defs.map((d) => ({ name: d.name, configured: !!(env && env[d.key]) }));
}

// Run the live probes and assemble. Returns the health report. Never throws.
async function probeAll(opts = {}) {
  const env = opts.env || process.env;
  const host = "127.0.0.1";
  const webPort = Number(opts.webPort || env.LANTERN_GARAGE_PORT || env.PORT || 4177);
  const mcpPort = Number(env.MCP_SERVER_PORT || 8771);
  const traderPort = Number(env.TRADING_PORT || 5050);
  const ollamaPort = Number((env.OLLAMA_BASE_URL || "").match(/:(\d+)/)?.[1] || 11434);
  const devPort = 4178;

  const [mcpUp, traderUp, ollamaUp, devUp] = await Promise.all([
    probePort(mcpPort, host), probePort(traderPort, host), probePort(ollamaPort, host), probePort(devPort, host),
  ]);

  const providers = providerStates(env);
  const configured = providers.filter((p) => p.configured).map((p) => p.name);

  const subsystems = [
    { name: "web", label: "Lantern Garage", critical: true, state: "up", detail: `serving :${webPort}` },
    { name: "local-model", label: "Ollama (local model)", state: ollamaUp ? "up" : "down",
      reason: ollamaUp ? null : `nothing listening on :${ollamaPort} — start Ollama for offline AI` },
    { name: "mcp", label: "MCP server", state: mcpUp ? "up" : "down",
      reason: mcpUp ? null : `nothing listening on :${mcpPort}` },
    { name: "dev-server", label: "Dev dual-server", state: devUp ? "up" : "disabled",
      reason: devUp ? null : `:${devPort} not running (single-server mode)` },
    { name: "trader", label: "AI Trader", state: traderUp ? "up" : "disabled",
      reason: traderUp ? null : `:${traderPort} not running (trader off / Python unavailable)` },
    { name: "cloud-providers", label: "Cloud providers", state: configured.length ? "up" : "disabled",
      reason: configured.length ? null : "no cloud API keys set (local-only mode)",
      detail: configured.length ? `configured: ${configured.join(", ")}` : null,
      providers },
  ];
  return assembleHealth(subsystems);
}

module.exports = { assembleHealth, providerStates, probeAll };
