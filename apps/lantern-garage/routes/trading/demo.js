/**
 * Trading routes — public demo-account spectator feed (#2548).
 *
 * GET /api/trading/demo-feed — a read-only, no-auth snapshot of the OPERATOR
 * demo (paper) account: sanitized account summary, open positions, the recent
 * autopilot entries/exits, and the engine's recent signals. Listed in
 * PUBLIC_TRADING_READS (server.js) so guests can watch the account trade live
 * without a sign-up — the "watch the live demo account" tier-matrix promise.
 *
 * Safety model:
 *   - READ-ONLY: this module serves exactly one GET; no order/config surface.
 *   - Field ALLOWLIST: every object is rebuilt key-by-key below — broker account
 *     ids, keys, and any field we haven't explicitly named can never leak, even
 *     if the upstream endpoints grow new ones.
 *   - The account/positions snapshot comes from an in-process loopback GET to
 *     /api/trading/positions with NO forwarded user — the same trusted-operator
 *     loopback the chat tools use — so it always reflects the operator demo
 *     account, never a visitor's linked broker.
 */

const http = require('http');

// One shared snapshot for all spectators — a page of N viewers polling every 5s
// must not multiply broker calls. 5s TTL keeps "live" honest.
let _cache = { at: 0, body: null };
const TTL_MS = 5000;

function loopbackPositions(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/trading/positions', headers: { accept: 'application/json' } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (_e) { resolve(null); } });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function sanitizeAccount(a) {
  if (!a || typeof a !== 'object') return {};
  return {
    equity: num(a.equity),
    cash: num(a.cash),
    buying_power: num(a.buying_power),
    pnl_today: num(a.pnl_today),
    pnl_pct: num(a.pnl_pct),
    unrealized: num(a.unrealized),
    realized_today: num(a.realized_today),
    currency: typeof a.currency === 'string' ? a.currency : 'USD',
  };
}

function sanitizePosition(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    symbol: String(p.symbol || '').slice(0, 12),
    side: p.side === 'short' ? 'short' : 'long',
    qty: num(p.qty),
    avg_entry: num(p.avg_entry_price ?? p.avg_entry ?? p.avg_price),
    current: num(p.current_price ?? p.current),
    unrealized_pl: num(p.unrealized_pl),
    unrealized_plpc: num(p.unrealized_plpc ?? p.unrealized_pl_pct),
  };
}

// Recent autopilot ledger events (entries/exits) — the "watch it trade" feed.
function recentLedger(limit) {
  try {
    const fs = require('fs');
    const path = require('path');
    const logPath = path.join(__dirname, '..', '..', '..', '..', 'data', 'lantern-garage', 'trading', 'autopilot-trades.jsonl');
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let r; try { r = JSON.parse(lines[i]); } catch (_e) { continue; }
      if (!r || (r.event !== 'entry' && r.event !== 'exit')) continue;
      out.push({
        ts: String(r.ts || ''),
        event: r.event,
        symbol: String(r.symbol || '').slice(0, 12),
        side: r.side === 'short' ? 'short' : 'long',
        qty: num(r.qty),
        price: num(r.event === 'entry' ? r.entry : r.exit),
        pnl: r.event === 'exit' ? num(r.pnl) : undefined,
        pnl_pct: r.event === 'exit' ? num(r.pnl_pct) : undefined,
        reason: r.reason ? String(r.reason).slice(0, 40) : undefined,
        p_win: r.event === 'entry' ? num(r.p_win) : undefined,
      });
    }
    return out;
  } catch (_e) {
    return [];
  }
}

function recentSignals(limit) {
  try {
    const tradingHistory = require('../../lib/trading-history-logger');
    return (tradingHistory.getSignalHistory({ limit }) || []).map((s) => ({
      ts: String(s.timestamp || s.ts || ''),
      symbol: String(s.symbol || '').slice(0, 12),
      action: String(s.action || s.signal || '').slice(0, 12),
      confidence: num(s.confidence),
      reason: s.reason ? String(s.reason).slice(0, 120) : undefined,
    }));
  } catch (_e) {
    return [];
  }
}

module.exports = async function demoRoutes(req, res, url, ctx) {
  const { sendJson } = ctx;

  if (url.pathname === '/api/trading/demo-feed' && req.method === 'GET') {
    const now = Date.now();
    if (_cache.body && now - _cache.at < TTL_MS) {
      sendJson(res, _cache.body, 200);
      return true;
    }
    const port = Number(process.env.LANTERN_GARAGE_PORT || process.env.PORT || 4177);
    const snap = await loopbackPositions(port);
    const body = {
      generatedAt: new Date().toISOString(),
      demo: true, // paper money — the page must label it as such
      account: sanitizeAccount(snap && snap.account),
      positions: Array.isArray(snap && snap.positions)
        ? snap.positions.map(sanitizePosition).filter(Boolean).slice(0, 50)
        : [],
      activity: recentLedger(25),
      signals: recentSignals(10),
    };
    _cache = { at: now, body };
    sendJson(res, body, 200);
    return true;
  }

  return false;
};
