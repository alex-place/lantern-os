// Financial Account Keys — broker/exchange credentials for the trading system
// GET  /api/financial-keys        — allowlisted key set-status (masked)
// POST /api/financial-keys        — { key, value } persist one credential
//
// Mirrors routes/gpu-training.js's key-storage pattern (Windows User env
// persistence, never logged/uploaded) so the two "connect an account" panels
// on orchestration.html behave identically.

const { execFileSync } = require("child_process");

// Only these keys may be set via the UI — prevents arbitrary env injection.
// Names match what lib/kalshi-api.js and lib/trading-api-bridge.js already
// read from process.env.
const FINANCIAL_KEY_ALLOWLIST = [
  // Interactive Brokers — direct REST API (lib/trading-api-bridge.js)
  "IBKR_ACCOUNT_ID",
  "IBKR_API_KEY",
  "IBKR_API_SECRET",
  // Alpaca — stocks/options/crypto (lib/trader-agent.js, lib/trading-api-bridge.js)
  "ALPACA_API_KEY",
  "ALPACA_SECRET_KEY",
  // Kalshi — RSA-PSS signed requests (lib/kalshi-api.js)
  "KALSHI_API_KEY_ID",
  "KALSHI_PRIVATE_KEY_PATH",
  // ── Market-data APIs (read-only; feed the EV council + suggest engines) ──
  // Finnhub — real-time stocks/forex/crypto + news/sentiment + fundamentals
  "FINNHUB_API_KEY",
  // Alpha Vantage — stocks/options/forex/crypto + technical indicators + history
  "ALPHA_VANTAGE_API_KEY",
  // FRED — Federal Reserve macro series (CPI, rates, unemployment)
  "FRED_API_KEY",
];

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
  for (const k of FINANCIAL_KEY_ALLOWLIST) {
    if (!process.env[k]) {
      const val = _readWindowsUserEnv(k);
      if (val) process.env[k] = val;
    }
  }
}

module.exports = async function financialKeysRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody } = deps;

  if (url.pathname !== "/api/financial-keys") return false;

  if (req.method === "GET") {
    _syncUserEnvKeys();
    const keys = FINANCIAL_KEY_ALLOWLIST.map(k => {
      const val = process.env[k] || "";
      const set = val.length > 0;
      return { key: k, set, masked: set ? val.substring(0, 8) + "…" : null };
    });
    sendJson(res, { keys });
    return true;
  }

  if (req.method === "POST") {
    let body = {};
    try { body = JSON.parse(await collectRequestBody(req)); } catch {}
    const { key, value = "" } = body;
    if (!key || !FINANCIAL_KEY_ALLOWLIST.includes(key)) {
      sendJson(res, { error: "key_not_allowed", allowed: FINANCIAL_KEY_ALLOWLIST }, 400);
      return true;
    }
    process.env[key] = value;
    let persisted = false;
    try {
      execFileSync("powershell", [
        "-NonInteractive", "-Command",
        `[System.Environment]::SetEnvironmentVariable('${key}', $env:__FIN_KEY_VAL, 'User')`,
      ], { timeout: 10_000, env: { ...process.env, __FIN_KEY_VAL: value } });
      persisted = true;
    } catch {}
    sendJson(res, { ok: true, key, persisted, session_only: !persisted });
    return true;
  }

  return false;
};

// Exposed so the server can sync Windows User-env keys into process.env at STARTUP —
// not just lazily when the keys route is first hit. Without this, a freshly-started
// server has no FINNHUB_API_KEY etc., so the news collector silently falls back to
// Yahoo-only and the market-data (Finnhub/AlphaVantage/FRED) sources go dark.
module.exports.syncUserEnvKeys = _syncUserEnvKeys;
