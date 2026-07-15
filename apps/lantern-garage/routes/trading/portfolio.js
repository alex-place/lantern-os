'use strict';
/**
 * routes/trading/portfolio.js — deterministic portfolio-advisor endpoints for the
 * trader dashboard (stock-trader.html "Advisor" tab).
 *
 * Loop stage: Reason. Thin HTTP surface over lib/portfolio-analytics.js — the SAME
 * engine the chat tools (portfolio_analysis / propose_rebalance / contribution_plan)
 * use, so the on-screen numbers and the model's tool-call numbers can never diverge.
 * Pure measurement + proposal: nothing here places orders (Act stays behind the
 * ADR-0020 trading gates), and nothing here calls an LLM — every figure is
 * deterministic math over positions + public daily history.
 *
 * Positions come from the same in-process loopback the chat tools use
 * (GET /api/trading/positions with the user id forwarded), so the advisor sees
 * exactly the broker account the Positions tab shows (IBKR per ADR-0022, else Alpaca).
 *
 *   GET /api/trading/portfolio/analysis?years=5
 *   GET /api/trading/portfolio/rebalance?years=5&max_weight=0.35
 *   GET /api/trading/portfolio/contribution?cash=20&years=5&max_weight=0.35
 *
 * Responses are always 200 with { ok, ... } — ok:false carries an honest `reason`
 * (broker not connected, no positions, no history) rather than an error status,
 * because "nothing to analyze" is a state, not a failure.
 */

const http = require('http');

const pa = require('../../lib/portfolio-analytics');

const OWNED = new Set([
  '/api/trading/portfolio/analysis',
  '/api/trading/portfolio/rebalance',
  '/api/trading/portfolio/contribution',
]);

// In-process hop to /api/trading/positions AS the original requester: the user's
// own auth (session cookie / test-auth headers) is forwarded so the hop passes the
// auth gate exactly like the browser's Positions-tab call, and the operator-trust
// identity pair (x-keystone-internal + x-keystone-user, PR #2450 / ADR-0022) rides
// along for chat-tool-style loopback callers with no cookie.
function _positionsFor(req, uid, timeoutMs = 9000) {
  const port = process.env.LANTERN_GARAGE_PORT || process.env.PORT || 4177;
  const headers = { 'x-keystone-internal': '1' };
  for (const h of ['cookie', 'x-test-auth', 'x-test-role', 'authorization', 'x-unisona-token']) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }
  if (process.env.UNISONA_LOCAL_TOKEN) headers['x-unisona-token'] = process.env.UNISONA_LOCAL_TOKEN;
  if (uid) headers['x-keystone-user'] = encodeURIComponent(String(uid));
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/trading/positions', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_e) { reject(new Error('bad JSON from positions endpoint')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('positions endpoint timeout')));
  });
}

function _num(url, name, fallback) {
  const v = Number(url.searchParams.get(name));
  return Number.isFinite(v) ? v : fallback;
}

module.exports = async function portfolioRoutes(req, res, url, ctx) {
  if (!OWNED.has(url.pathname) || req.method !== 'GET') return false;
  const { sendJson, getEffectiveUserId } = ctx;

  let d;
  try {
    d = await _positionsFor(req, getEffectiveUserId(req));
  } catch (e) {
    sendJson(res, { ok: false, reason: `positions unavailable (${e.message})` }, 200);
    return true;
  }
  if (!d || d.available === false) {
    sendJson(res, { ok: false, reason: (d && d.reason) || 'broker not connected' }, 200);
    return true;
  }
  const positions = Array.isArray(d.positions) ? d.positions : [];
  if (!positions.length) {
    sendJson(res, { ok: false, reason: 'no open positions' }, 200);
    return true;
  }

  const opts = {
    years: _num(url, 'years', 5),
    maxWeight: _num(url, 'max_weight', 0.35),
  };

  try {
    let out;
    if (url.pathname.endsWith('/analysis')) {
      out = await pa.analyzeHoldings(positions, opts);
      if (out && out._aligned) delete out._aligned; // internal reuse handle — not a wire field
    } else if (url.pathname.endsWith('/rebalance')) {
      out = await pa.proposeRebalance(positions, opts);
    } else {
      out = await pa.planContribution(positions, _num(url, 'cash', 0), opts);
    }
    sendJson(res, out, 200);
  } catch (e) {
    sendJson(res, { ok: false, reason: e.message }, 200);
  }
  return true;
};
