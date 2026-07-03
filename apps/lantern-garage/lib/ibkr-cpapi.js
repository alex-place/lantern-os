/**
 * IBKR Client Portal Web API (CPAPI) client — READ-ONLY.
 *
 * Grounds the Keystone trader's IBKR integration in the *real* Interactive
 * Brokers connectivity model, replacing the earlier fabricated "direct REST
 * API" (a `Bearer`-token call to `https://api.ibkr.com/v1` — an endpoint that
 * does not exist). IBKR exposes exactly two supported programmatic paths:
 *
 *   1. Client Portal Web API (CPAPI)  — REST/WebSocket via a *local gateway*
 *      at https://localhost:5000/v1/api, session-authenticated (browser SSO or
 *      a headless maintainer such as Voyz/IBeam), kept alive with POST /tickle.
 *   2. TWS socket API                 — ports 7496/7497 (TWS) or 4001/4002 (IB
 *      Gateway), requires the desktop app + a language client (@stoqey/ib,
 *      ib_async). Heavier: a Python/socket sidecar.
 *
 * This Node server already speaks HTTP, so CPAPI is the natural fit — no extra
 * runtime. See docs/IBKR-API-SETUP.md and docs/adr/0019 for the decision.
 *
 * Design contract (Σ₀):
 *   - Reads are unconditional; WRITES (order placement) are HARD-GATED. placeOrder
 *     runs through lib/trading-guard.js and is a DRY run by default — it never
 *     touches the broker unless TRADER_LIVE=1, the shared kill-switch is absent,
 *     size/notional caps pass, and (for a live account) TRADER_ALLOW_LIVE_ACCOUNT=1.
 *     See docs/adr/0020-ibkr-live-order-placement.md.
 *   - Fail-soft. Every method resolves to null / [] / {connected:false} when the
 *     gateway is absent or unauthenticated. It NEVER throws for "gateway down",
 *     and it NEVER fabricates a value — a disconnected gateway reports
 *     disconnected, honestly, with evidence.
 *   - No hidden TLS bypass. The gateway serves a self-signed cert on loopback,
 *     so certificate verification is skipped *only* for loopback hosts (or an
 *     explicit IBKR_TLS_INSECURE=1). A remote gateway is verified normally.
 *
 * Endpoints (relative to /v1/api), grounded against interactivebrokers.github.io/cpwebapi
 * and the Voyz/IBeam + Voyz/ibind reference clients:
 *   POST /tickle                              keep-alive; nests iserver.authStatus
 *   POST /iserver/auth/status                 authentication status
 *   GET  /portfolio/accounts                  accounts (call before other /portfolio)
 *   GET  /portfolio/{acctId}/summary          net-liq / cash / pnl
 *   GET  /portfolio/{acctId}/positions/{page} positions (0-indexed pages)
 */

'use strict';

const http = require('http');
const https = require('https');
const { orderGate } = require('./trading-guard');

const DEFAULT_GATEWAY = 'https://localhost:5000/v1/api';

/** True for loopback hostnames whose self-signed gateway cert can't be verified. */
function isLoopback(hostname) {
  if (!hostname) return false;
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || /^127\./.test(h);
}

/** Coerce a numeric-ish value (number, numeric string, or CPAPI {amount}) → number|null. */
function pickAmount(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  const lower = {};
  for (const k of Object.keys(obj)) lower[k.toLowerCase()] = obj[k];
  for (const key of keys) {
    const v = lower[String(key).toLowerCase()];
    if (v == null) continue;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'object' && typeof v.amount === 'number') return v.amount;
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  }
  return null;
}

function firstNum(...vals) {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  }
  return null;
}

/** CPAPI /portfolio/{acct}/summary → normalized account shape (defensive: keys vary by gateway build). */
function normalizeSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const equity = pickAmount(raw, ['netliquidation', 'netliquidationvalue', 'equitywithloanvalue', 'nlv']);
  const cash = pickAmount(raw, ['totalcashvalue', 'availablefunds', 'settledcash', 'cashbalance']);
  const buyingPower = pickAmount(raw, ['buyingpower']);
  const unrealizedPnl = pickAmount(raw, ['unrealizedpnl']);
  const realizedPnl = pickAmount(raw, ['realizedpnl']);
  const excessLiquidity = pickAmount(raw, ['excessliquidity']);
  // If none of the canonical keys were present the payload isn't a summary — say so.
  if (equity == null && cash == null && buyingPower == null) return null;
  return { equity, cash, buyingPower, unrealizedPnl, realizedPnl, excessLiquidity };
}

/** CPAPI position row → normalized position. */
function normalizePosition(p) {
  if (!p || typeof p !== 'object') return null;
  const symbol = p.ticker || p.contractDesc || p.symbol || (p.conid != null ? String(p.conid) : '');
  return {
    symbol,
    conid: p.conid != null ? p.conid : null,
    qty: firstNum(p.position, p.qty) ?? 0,
    avgPrice: firstNum(p.avgPrice, p.avgCost, p.avg_fill_price),
    currentPrice: firstNum(p.mktPrice, p.currentPrice),
    marketValue: firstNum(p.mktValue, p.marketValue),
    unrealizedPnl: firstNum(p.unrealizedPnl, p.unrealized_pl),
    assetClass: p.assetClass || p.secType || null,
    currency: p.currency || null,
  };
}

/** IBKR account ids: DU/DI = paper, U/F = live. */
function inferMode(accountId) {
  if (!accountId) return 'unknown';
  const id = String(accountId).toUpperCase();
  if (id.startsWith('DU') || id.startsWith('DI') || id.startsWith('DF')) return 'paper';
  if (/^[UF]\d/.test(id) || id.startsWith('U')) return 'live';
  return 'unknown';
}

class IbkrCpapi {
  constructor(opts = {}) {
    this.baseUrl = (opts.gatewayUrl || process.env.IBKR_GATEWAY_URL || DEFAULT_GATEWAY).replace(/\/+$/, '');
    // IBKR_BASE_URL is the legacy var; honor it only if it points at a gateway path,
    // never the fabricated api.ibkr.com default.
    const legacy = process.env.IBKR_BASE_URL;
    if (!opts.gatewayUrl && !process.env.IBKR_GATEWAY_URL && legacy && !/api\.ibkr\.com/i.test(legacy)) {
      this.baseUrl = legacy.replace(/\/+$/, '');
    }
    this.accountId = opts.accountId || process.env.IBKR_ACCOUNT_ID || '';
    this.timeoutMs = opts.timeoutMs || Number(process.env.IBKR_TIMEOUT_MS) || 6000;
    this.statusTtlMs = opts.statusTtlMs != null ? opts.statusTtlMs : 4000;
    this.tlsInsecure = process.env.IBKR_TLS_INSECURE === '1';
    this._statusCache = null; // { at, value }
    this._accountsCache = null;
  }

  _verifyTls(hostname) {
    if (this.tlsInsecure) return false;
    return !isLoopback(hostname);
  }

  /**
   * Low-level request. Resolves { ok, status, json, error } — never rejects.
   */
  _request(method, apiPath, body) {
    return new Promise((resolve) => {
      let u;
      try {
        u = new URL(this.baseUrl + apiPath);
      } catch (e) {
        return resolve({ ok: false, status: 0, json: null, error: 'bad_gateway_url' });
      }
      const isHttps = u.protocol === 'https:';
      const lib = isHttps ? https : http;
      const payload = body != null ? JSON.stringify(body) : null;
      const headers = { Accept: 'application/json', 'User-Agent': 'keystone-ibkr-cpapi/1.0' };
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const options = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
        timeout: this.timeoutMs,
      };
      if (isHttps) options.rejectUnauthorized = this._verifyTls(u.hostname);

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch (e) { json = null; }
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          resolve({ ok, status: res.statusCode, json, error: ok ? null : `http_${res.statusCode}` });
        });
      });
      req.on('error', (e) => resolve({ ok: false, status: 0, json: null, error: e.code || e.message || 'request_error' }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, json: null, error: 'timeout' }); });
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** POST /tickle — keep-alive; the most informative single probe. */
  async probe() {
    const r = await this._request('POST', '/tickle');
    if (!r.ok || !r.json) {
      return { reachable: r.status !== 0, sessionAlive: false, authenticated: false, error: r.error };
    }
    const auth = (r.json.iserver && r.json.iserver.authStatus) || {};
    return {
      reachable: true,
      sessionAlive: !!r.json.session,
      authenticated: !!auth.authenticated,
      connected: !!auth.connected,
      competing: !!auth.competing,
      error: null,
    };
  }

  /** GET /portfolio/accounts — must precede other /portfolio calls. Returns [] on failure. */
  async getAccounts() {
    if (this._accountsCache) return this._accountsCache;
    const r = await this._request('GET', '/portfolio/accounts');
    if (!r.ok || !Array.isArray(r.json)) return [];
    this._accountsCache = r.json;
    return r.json;
  }

  /** Configured account id, else first discovered. null if none resolvable. */
  async resolveAccountId() {
    if (this.accountId) return this.accountId;
    const accts = await this.getAccounts();
    const first = accts[0];
    const id = first && (first.accountId || first.id || first.acctId);
    if (id) this.accountId = id;
    return id || null;
  }

  /** GET /portfolio/{acct}/summary → normalized account, or null. */
  async getAccountSummary(accountId) {
    const id = accountId || (await this.resolveAccountId());
    if (!id) return null;
    const r = await this._request('GET', `/portfolio/${encodeURIComponent(id)}/summary`);
    if (!r.ok) return null;
    return normalizeSummary(r.json);
  }

  /** GET /portfolio/{acct}/positions/{page} (paginated) → normalized positions[]. */
  async getPositions(accountId, { maxPages = 5 } = {}) {
    const id = accountId || (await this.resolveAccountId());
    if (!id) return [];
    const out = [];
    for (let page = 0; page < maxPages; page += 1) {
      const r = await this._request('GET', `/portfolio/${encodeURIComponent(id)}/positions/${page}`);
      if (!r.ok || !Array.isArray(r.json) || r.json.length === 0) break;
      for (const row of r.json) {
        const n = normalizePosition(row);
        if (n) out.push(n);
      }
      if (r.json.length < 30) break; // short page → last page
    }
    return out;
  }

  // ── Contracts + orders (Act stage — gated) ─────────────────────────────────

  /** POST /iserver/secdef/search → resolve a symbol to its primary conid. */
  async searchContract(symbol, { secType = 'STK' } = {}) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return null;
    const r = await this._request('POST', '/iserver/secdef/search', { symbol: sym, name: false, secType });
    if (!r.ok || !Array.isArray(r.json) || r.json.length === 0) return null;
    const match = r.json.find((c) => String(c.symbol || '').toUpperCase() === sym) || r.json[0];
    return {
      conid: match.conid != null ? Number(match.conid) : null,
      symbol: match.symbol || sym,
      description: match.description || match.companyName || '',
    };
  }

  /**
   * Place an order via CPAPI — GATED by lib/trading-guard.js. DRY BY DEFAULT:
   * with TRADER_LIVE unset it returns {status:'dry_run'} and NEVER contacts the
   * broker. Handles the CPAPI reply/confirm loop (POST /iserver/reply/{id}).
   * Returns { status:'dry_run'|'submitted'|'error', dry, gate, order, ibkr?, orderId?, error? }.
   */
  async placeOrder({ symbol, conid, side, qty, orderType = 'MKT', price, tif = 'DAY' } = {}) {
    const status = await this.getStatus();
    const mode = status.mode; // 'paper' | 'live' | 'unknown'
    const gate = orderGate({ mode, qty, price, symbol, side });
    const order = {
      symbol: symbol || null,
      conid: conid != null ? Number(conid) : null,
      side: String(side || '').toUpperCase(),
      qty: Number(qty) || 0,
      orderType,
      price: price != null ? Number(price) : null,
      tif,
    };

    // DRY: never touches the broker — surfaces the intent + why it wasn't sent.
    if (!gate.allowed) {
      return { status: 'dry_run', dry: true, gate, order, note: gate.reason };
    }
    if (!status.connected) {
      return { status: 'error', dry: false, gate, order, error: 'ibkr gateway not connected/authenticated' };
    }

    let cid = order.conid;
    if (cid == null && symbol) {
      const c = await this.searchContract(symbol);
      cid = c && c.conid;
    }
    if (cid == null) {
      return { status: 'error', dry: false, gate, order, error: `could not resolve conid for ${symbol || '(none)'}` };
    }
    const accountId = await this.resolveAccountId();
    if (!accountId) return { status: 'error', dry: false, gate, order, error: 'no account id' };

    const leg = {
      conid: Number(cid),
      orderType,
      side: order.side,
      quantity: order.qty,
      tif,
    };
    if (orderType === 'LMT' && order.price != null) leg.price = order.price;

    let r = await this._request('POST', `/iserver/account/${encodeURIComponent(accountId)}/orders`, { orders: [leg] });
    // CPAPI often replies with confirmation questions [{id, message:[...]}]; answer them.
    let confirms = 0;
    while (r.ok && Array.isArray(r.json) && r.json[0] && r.json[0].id && r.json[0].message && confirms < 5) {
      r = await this._request('POST', `/iserver/reply/${encodeURIComponent(r.json[0].id)}`, { confirmed: true });
      confirms += 1;
    }
    if (!r.ok) return { status: 'error', dry: false, gate, order, error: r.error || 'order_rejected', ibkr: r.json };
    const first = Array.isArray(r.json) ? r.json[0] : r.json;
    return {
      status: 'submitted',
      dry: false,
      gate,
      order,
      ibkr: first,
      orderId: (first && (first.order_id || first.orderId || first.id)) || null,
    };
  }

  /** GET /iserver/account/orders → normalized live/working orders ([] on failure). */
  async getLiveOrders() {
    const r = await this._request('GET', '/iserver/account/orders');
    if (!r.ok || !r.json) return [];
    const orders = Array.isArray(r.json.orders) ? r.json.orders : (Array.isArray(r.json) ? r.json : []);
    return orders.map((o) => ({
      orderId: o.orderId || o.order_id || o.id || null,
      symbol: o.ticker || o.symbol || '',
      side: o.side || '',
      qty: firstNum(o.totalSize, o.quantity, o.qty) ?? 0,
      filledQty: firstNum(o.filledQuantity, o.filled) ?? 0,
      status: o.status || o.order_status || '',
      orderType: o.orderType || o.order_type || '',
      price: firstNum(o.price, o.limit_price),
      avgPrice: firstNum(o.avgPrice, o.average_price),
    }));
  }

  /** GET /iserver/account/order/status/{id} → raw status object, or null. */
  async getOrderStatus(orderId) {
    if (!orderId) return null;
    const r = await this._request('GET', `/iserver/account/order/status/${encodeURIComponent(orderId)}`);
    return r.ok ? r.json : null;
  }

  /**
   * Composite, honest, cached status. Always resolves; carries [claim, evidence,
   * source] provenance so the UI badge reflects reality instead of a hardcoded true.
   */
  async getStatus() {
    const now = Date.now();
    if (this._statusCache && now - this._statusCache.at < this.statusTtlMs) {
      return this._statusCache.value;
    }
    const probe = await this.probe();
    let accountId = null;
    if (probe.reachable && (probe.authenticated || probe.sessionAlive)) {
      accountId = await this.resolveAccountId().catch(() => null);
    }
    const connected = !!(probe.reachable && probe.authenticated);
    const evidence = [];
    if (!probe.reachable) evidence.push(`gateway unreachable at ${this.baseUrl} (${probe.error || 'no response'})`);
    else {
      evidence.push(`gateway reachable at ${this.baseUrl}`);
      evidence.push(probe.authenticated ? 'session authenticated' : 'gateway up but NOT authenticated — log in via the Client Portal Gateway');
      if (accountId) evidence.push(`account ${accountId} (${inferMode(accountId)})`);
    }
    const value = {
      connected,
      reachable: !!probe.reachable,
      authenticated: !!probe.authenticated,
      sessionAlive: !!probe.sessionAlive,
      accountId: accountId || null,
      mode: inferMode(accountId),
      gatewayUrl: this.baseUrl,
      source: 'ibkr-cpapi',
      evidence,
      checkedAt: new Date().toISOString(),
    };
    this._statusCache = { at: now, value };
    return value;
  }
}

module.exports = IbkrCpapi;
module.exports.isLoopback = isLoopback;
module.exports.pickAmount = pickAmount;
module.exports.normalizeSummary = normalizeSummary;
module.exports.normalizePosition = normalizePosition;
module.exports.inferMode = inferMode;
module.exports.DEFAULT_GATEWAY = DEFAULT_GATEWAY;
