/**
 * IBKR Web API client — hosted REST at https://api.ibkr.com/v1/api.
 *
 * Authenticates with an OAuth Bearer token (the "API key") sent on every
 * request, plus the session cookie the Web API requires: a POST /tickle returns
 * a `session` token which is echoed back as `Cookie: api={session}` on
 * subsequent calls (see IBKR Web API docs → "Cookie Management"). This is the
 * hosted path (direct to IBKR infrastructure) — NOT the local Client Portal
 * Gateway. Set IBKR_BASE_URL to point at a local gateway
 * (https://localhost:5000/v1/api) instead if desired; the endpoints are identical.
 *
 * Config (env):
 *   IBKR_API_KEY        OAuth bearer token (a.k.a. IBKR_OAUTH_TOKEN)
 *   IBKR_ACCOUNT_ID     account id (e.g. U1234567 live, DU… paper); else discovered
 *   IBKR_BASE_URL       override base (default https://api.ibkr.com/v1/api)
 *   IBKR_TIMEOUT_MS     per-request timeout (default 6000)
 *   IBKR_TLS_INSECURE=1 skip TLS verification (loopback gateways are skipped anyway)
 *
 * Endpoints used (grounded against interactivebrokers.com/campus IBKR Web API docs):
 *   POST /tickle                              session token (cookie) + auth status
 *   GET  /portfolio/accounts                  accounts (call before other /portfolio)
 *   GET  /portfolio/{acctId}/summary          equity / cash / pnl
 *   GET  /portfolio/{acctId}/positions/{page} positions (0-indexed pages)
 *   POST /iserver/secdef/search               symbol → conid
 *   POST /iserver/account/{acctId}/orders     place order (array body)
 *   POST /iserver/reply/{messageId}           confirm order reply ({confirmed:true})
 *   GET  /iserver/account/orders              live/working orders
 *   GET  /iserver/account/order/status/{id}   order status
 *
 * Design contract (Σ₀):
 *   - Reads are unconditional; WRITES (order placement) are HARD-GATED via
 *     lib/trading-guard.js — placeOrder is DRY by default and never contacts the
 *     broker unless TRADER_LIVE=1, the shared kill-switch is absent, size/notional
 *     caps pass, and (for a live account) TRADER_ALLOW_LIVE_ACCOUNT=1. See ADR-0020.
 *   - Fail-soft. Every method resolves to null / [] / {connected:false} when the
 *     API is unreachable or the token is missing/expired. It NEVER throws for
 *     "not connected" and NEVER fabricates a value — an honest status with evidence.
 */

'use strict';

const http = require('http');
const https = require('https');
const { orderGate } = require('./trading-guard');

const DEFAULT_BASE = 'https://api.ibkr.com/v1/api';

/** True for loopback hostnames whose self-signed gateway cert can't be verified. */
function isLoopback(hostname) {
  if (!hostname) return false;
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || /^127\./.test(h);
}

/** Coerce a numeric-ish value (number, numeric string, or {amount}) → number|null. */
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

/** /portfolio/{acct}/summary → normalized account shape (defensive: keys vary by build). */
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

/** position row → normalized position. */
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

/** IBKR account ids: DU/DI/DF = paper, U/F = live. */
function inferMode(accountId) {
  if (!accountId) return 'unknown';
  const id = String(accountId).toUpperCase();
  if (id.startsWith('DU') || id.startsWith('DI') || id.startsWith('DF')) return 'paper';
  if (/^[UF]\d/.test(id) || id.startsWith('U')) return 'live';
  return 'unknown';
}

class IbkrCpapi {
  constructor(opts = {}) {
    // OAuth bearer token ("API key"). Reads honor the read-only session; trading
    // (/iserver) additionally needs a brokerage session (established via /tickle).
    this.apiKey = opts.apiKey || process.env.IBKR_API_KEY || process.env.IBKR_OAUTH_TOKEN || '';
    this.baseUrl = (opts.baseUrl || opts.gatewayUrl || process.env.IBKR_BASE_URL || process.env.IBKR_GATEWAY_URL || DEFAULT_BASE).replace(/\/+$/, '');
    this.accountId = opts.accountId || process.env.IBKR_ACCOUNT_ID || '';
    this.timeoutMs = opts.timeoutMs || Number(process.env.IBKR_TIMEOUT_MS) || 6000;
    this.statusTtlMs = opts.statusTtlMs != null ? opts.statusTtlMs : 4000;
    this.tlsInsecure = process.env.IBKR_TLS_INSECURE === '1';
    this._sessionToken = null; // from POST /tickle → sent back as Cookie: api={token}
    this._statusCache = null; // { at, value }
    this._accountsCache = null;
    // Per-user self-service OAuth 1.0a (ADR-0022). When present, requests are
    // signed with a Live Session Token (the retail-supported path) instead of the
    // Bearer token. Pass an IbkrOAuth1 instance as opts.oauth1.
    this.oauth1 = opts.oauth1 || null;
    this._lst = null; // { token, expiresAt } — cached Live Session Token
    this._lstError = null; // last OAuth1 handshake failure reason (diagnostics)
  }

  _verifyTls(hostname) {
    if (this.tlsInsecure) return false;
    return !isLoopback(hostname);
  }

  /** Pure HTTP with caller-supplied headers. Resolves { ok, status, json, error }
   *  — never rejects. (Auth-header assembly lives in _request.) */
  _rawRequest(method, apiPath, headers, body) {
    return new Promise((resolve) => {
      let u;
      try {
        u = new URL(this.baseUrl + apiPath);
      } catch (e) {
        return resolve({ ok: false, status: 0, json: null, error: 'bad_base_url' });
      }
      const isHttps = u.protocol === 'https:';
      const lib = isHttps ? https : http;
      const payload = body != null ? JSON.stringify(body) : null;
      const h = { Accept: 'application/json', 'User-Agent': 'keystone-ibkr-webapi/1.0', ...headers };
      if (payload) {
        h['Content-Type'] = 'application/json';
        h['Content-Length'] = Buffer.byteLength(payload);
      }
      const options = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: h,
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

  /**
   * Low-level request. Resolves { ok, status, json, error } — never rejects.
   * With OAuth 1.0a (per-user), obtains + caches a Live Session Token and signs
   * each request HMAC-SHA256. Otherwise falls back to the Bearer token + api=
   * session cookie (legacy/gateway path).
   */
  async _request(method, apiPath, body) {
    let headers = {};
    if (this.oauth1) {
      const lst = await this._ensureLst();
      if (!lst) return { ok: false, status: 0, json: null, error: 'ibkr_lst_unavailable' };
      const [path, query] = String(apiPath).split('?');
      const params = query ? Object.fromEntries(new URLSearchParams(query)) : null;
      headers = this.oauth1.signRequest(this.baseUrl + path, method, lst, params);
    } else {
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      if (this._sessionToken) headers.Cookie = `api=${this._sessionToken}`;
    }
    return this._rawRequest(method, apiPath, headers, body);
  }

  /**
   * Obtain (and cache) a Live Session Token via the OAuth 1.0a DH handshake, then
   * initialize the brokerage session. Returns the LST string, or null on failure
   * (fail-soft — the caller reports "disconnected", never fabricates).
   */
  async _ensureLst() {
    if (!this.oauth1) return null;
    if (this._lst && this._lst.expiresAt > Date.now() + 5000) return this._lst.token;
    const url = this.baseUrl + '/oauth/live_session_token';
    let req, r, lst;
    this._lstError = null;
    try {
      req = this.oauth1.buildLiveSessionTokenRequest(url);   // may throw on a bad key
    } catch (e) { this._lstError = { code: 'bad_key', detail: e.message }; return null; }
    r = await this._rawRequest('POST', '/oauth/live_session_token', req.headers);
    if (!r.ok) {
      // The most common failure for a fresh consumer: IBKR rejects the handshake
      // (401/403) until the OAuth consumer is activated (up to ~24h). Capture the
      // real HTTP status + any IBKR message so the UI can say which it is.
      const msg = (r.json && (r.json.error || r.json.message)) || r.error || null;
      // IBKR encodes the real reason in the body (e.g. "id: 164, error: invalid
      // consumer"). A 401 with "invalid consumer" means the consumer key was never
      // registered — waiting will NEVER fix it — so keep it distinct from a
      // genuinely-pending activation instead of lumping all 401s into "retry later".
      const lower = String(msg || '').toLowerCase();
      let code;
      if (r.status === 401 || r.status === 403) {
        code = /invalid consumer/.test(lower) ? 'invalid_consumer'
          : /invalid signature|signature/.test(lower) ? 'lst_signature_mismatch'
          : 'not_activated_or_unauthorized';
      } else {
        code = r.status ? `http_${r.status}` : 'unreachable';
      }
      this._lstError = { code, status: r.status, detail: msg };
      return null;
    }
    if (!r.json || !r.json.diffie_hellman_response) { this._lstError = { code: 'no_dh_response' }; return null; }
    try {
      lst = this.oauth1.computeLiveSessionToken(r.json.diffie_hellman_response, req.dhRandom, req.prepend);
    } catch (e) { this._lstError = { code: 'lst_compute_failed', detail: e.message }; return null; }
    if (r.json.live_session_token_signature &&
        !this.oauth1.validateLiveSessionToken(lst, r.json.live_session_token_signature)) {
      this._lstError = { code: 'lst_signature_mismatch' }; // key/prime/consumer mismatch
      return null;
    }
    // `live_session_token_expiration` is an ABSOLUTE epoch-ms timestamp (the LST
    // lives ~24h), not a duration. Trust it only if it lands in (now, now+24h];
    // anything else (past, absurdly far out, missing) falls back to a 10-minute
    // deadline so a malformed value can never pin a stale token.
    const now = Date.now();
    const exp = Number(r.json.live_session_token_expiration);
    const expiresAt = exp > now && exp <= now + 24 * 60 * 60 * 1000 ? exp : now + 10 * 60 * 1000;
    this._lst = { token: lst, expiresAt };
    // Best-effort brokerage session init (needed for /iserver reads + orders).
    try {
      const initHeaders = this.oauth1.signRequest(
        this.baseUrl + '/iserver/auth/ssodh/init', 'POST', lst, { compete: 'true', publish: 'true' });
      await this._rawRequest('POST', '/iserver/auth/ssodh/init?compete=true&publish=true', initHeaders);
    } catch (e) { /* reads still work without it; fail-soft */ }
    return this._lst.token;
  }

  /** POST /tickle — captures the session token (cookie) + reports auth status. */
  async probe() {
    const r = await this._request('POST', '/tickle');
    if (!r.ok || !r.json) {
      return { reachable: r.status !== 0, sessionAlive: false, authenticated: false, error: r.error };
    }
    if (r.json.session) this._sessionToken = r.json.session; // echoed as Cookie: api={session}
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

  /** GET /iserver/account/pnl/partitioned → { dailyPnl, unrealizedPnl, realizedPnl } for
   *  this account, or null. IBKR's `dpl` is the broker-authoritative DAY P&L (it reconciles
   *  with the day's equity change); `upl`/`rpl` are today's unrealized/realized. Response
   *  keys look like "U1234567.Core" and vary by build, so match defensively. */
  async getPnl(accountId) {
    const id = accountId || (await this.resolveAccountId());
    if (!id) return null;
    const r = await this._request('GET', '/iserver/account/pnl/partitioned');
    if (!r.ok || !r.json || typeof r.json !== 'object') return null;
    const rows = (r.json.upnl && typeof r.json.upnl === 'object') ? r.json.upnl : r.json;
    let row = null;
    for (const [k, v] of Object.entries(rows)) {
      if (!v || typeof v !== 'object' || !('dpl' in v || 'upl' in v)) continue;
      if (String(k).startsWith(id)) { row = v; break; } // our account's row wins
      if (!row) row = v;                                 // else first PnL-shaped row
    }
    if (!row) return null;
    return {
      dailyPnl: firstNum(row.dpl),
      unrealizedPnl: firstNum(row.upl),
      realizedPnl: firstNum(row.rpl),
    };
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
    // IBKR returns the same symbol on many venues/instrument types — e.g. "GLD"
    // yields a HK *index* [IND] AND the ARCA *ETF* [STK]. Pick the tradable one:
    // exact symbol + a section offering the requested secType (STK) + a primary US
    // venue, degrading gracefully. Prevents ordering an index/foreign listing.
    const US = /^(NASDAQ|NYSE|ARCA|NYSEARCA|BATS|AMEX|IEX|PINK)$/i;
    const offers = (c) => Array.isArray(c.sections) && c.sections.some((s) => String(s.secType).toUpperCase() === secType);
    const exact = (c) => String(c.symbol || '').toUpperCase() === sym;
    const venue = (c) => String(c.description || '');
    const match =
      r.json.find((c) => exact(c) && offers(c) && US.test(venue(c))) ||
      r.json.find((c) => exact(c) && offers(c)) ||
      r.json.find(offers) ||
      r.json.find(exact) ||
      r.json[0];
    return {
      conid: match.conid != null ? Number(match.conid) : null,
      symbol: match.symbol || sym,
      description: match.description || match.companyName || '',
    };
  }

  /**
   * Place an order — GATED by lib/trading-guard.js. DRY BY DEFAULT: with
   * TRADER_LIVE unset it returns {status:'dry_run'} and NEVER contacts the broker.
   * Body per the IBKR Web API: POST /iserver/account/{acct}/orders with a JSON
   * ARRAY of order tickets; handles the reply/confirm loop (POST /iserver/reply/{id}).
   * Returns { status:'dry_run'|'submitted'|'error', dry, gate, order, ibkr?, orderId?, error? }.
   */
  async placeOrder({ symbol, conid, side, qty, orderType = 'MKT', price, tif = 'DAY', equity, outsideRth = false, acceptWarnings = false } = {}) {
    const status = await this.getStatus();
    const mode = status.mode; // 'paper' | 'live' | 'unknown'
    // Prefer the caller-supplied equity; else read the account so the guard's
    // per-position cap scales with the portfolio (% of equity, not a flat $).
    let eq = Number(equity) || 0;
    if (!eq) { try { const s = await this.getAccountSummary(status.accountId); eq = (s && s.equity) || 0; } catch (_e) { /* fall back to flat cap */ } }
    const gate = orderGate({ mode, qty, price, symbol, side, equity: eq });
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
      return { status: 'error', dry: false, gate, order, error: 'ibkr not connected/authenticated (brokerage session required for orders)' };
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

    const ticket = {
      conid: Number(cid),
      orderType, // 'MKT' | 'LMT' | 'STP'
      side: order.side, // 'BUY' | 'SELL'
      quantity: order.qty,
      tif,
    };
    // LMT needs a limit price; STP (protective stop) needs a trigger price — both
    // ride the `price` field in IBKR's ticket. MKT carries none.
    if ((orderType === 'LMT' || orderType === 'STP') && order.price != null) ticket.price = order.price;
    // Extended-hours (pre-market / after-hours) fills require outsideRTH=true AND a LMT
    // order — IBKR rejects a market order outside RTH. The caller sets this when trading
    // pre/post market; regular-hours orders leave it off.
    if (outsideRth) ticket.outsideRTH = true;

    // Body must be { orders: [ticket, …] }. IBKR's Web API rejects a bare array
    // with 400 "Missing order parameters" — verified live against a paper account
    // (a bare [ticket] → 400, { orders:[ticket] } → 200 PreSubmitted).
    let r = await this._request('POST', `/iserver/account/${encodeURIComponent(accountId)}/orders`, { orders: [ticket] });
    // Order reply messages [{id, message, messageIds}] must be confirmed to proceed.
    // P0-8 (docs/TRADER-ANALYSIS-2026-07.md): do NOT blindly click through IBKR warnings
    // (outside-RTH, size-vs-ADV, margin, price-cap). Collect them; only auto-confirm when the
    // caller EXPLICITLY opts in via acceptWarnings:true. Otherwise surface them for a human.
    const warnings = [];
    let confirms = 0;
    while (r.ok && Array.isArray(r.json) && r.json[0] && r.json[0].id && r.json[0].message && confirms < 5) {
      warnings.push({ id: r.json[0].id, message: r.json[0].message });
      if (!acceptWarnings) break;
      r = await this._request('POST', `/iserver/reply/${encodeURIComponent(r.json[0].id)}`, { confirmed: true });
      confirms += 1;
    }
    if (warnings.length && !acceptWarnings) {
      return {
        status: 'needs_confirmation', dry: false, gate, order, warnings,
        note: 'IBKR returned order warnings; re-submit with acceptWarnings:true to confirm each',
      };
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
      time: firstNum(o.lastExecutionTime_r) || o.lastExecutionTime || o.orderTime || null,
    }));
  }

  /** GET /iserver/account/order/status/{id} → raw status object, or null. */
  async getOrderStatus(orderId) {
    if (!orderId) return null;
    const r = await this._request('GET', `/iserver/account/order/status/${encodeURIComponent(orderId)}`);
    return r.ok ? r.json : null;
  }

  /** DELETE /iserver/account/{acct}/order/{id} — cancel a working order. Returns
   *  { ok, status }. Used to cancel a protective stop when the position it guards
   *  is closed, so the stop can't later fire on a flat position and open a short. */
  async cancelOrder(orderId) {
    if (!orderId) return { ok: false, error: 'no_order_id' };
    const acct = await this.resolveAccountId();
    if (!acct) return { ok: false, error: 'no_account' };
    const r = await this._request('DELETE', `/iserver/account/${encodeURIComponent(acct)}/order/${encodeURIComponent(orderId)}`);
    return { ok: r.ok, status: r.status, json: r.json };
  }

  /**
   * Composite, honest, cached status. Always resolves; carries [claim, evidence,
   * source] provenance so the UI badge reflects reality instead of a hardcoded true.
   * connected = the token authenticates AND a brokerage session is up; for reads
   * alone, a successful /portfolio/accounts is also treated as reachable+usable.
   */
  async getStatus() {
    const now = Date.now();
    if (this._statusCache && now - this._statusCache.at < this.statusTtlMs) {
      return this._statusCache.value;
    }
    const probe = await this.probe();
    let accountId = null;
    let readsOk = false;
    if (probe.reachable && (probe.authenticated || probe.sessionAlive)) {
      accountId = await this.resolveAccountId().catch(() => null);
      readsOk = !!accountId;
    }
    // Even without a full brokerage session, a valid token that lists accounts is
    // usable for reads — reflect that honestly instead of a flat "not connected".
    const connected = !!(probe.reachable && probe.authenticated);
    const evidence = [];
    if (!this.apiKey) evidence.push('no IBKR_API_KEY / OAuth token set');
    if (!probe.reachable) evidence.push(`IBKR Web API unreachable at ${this.baseUrl} (${probe.error || 'no response'})`);
    else {
      evidence.push(`IBKR Web API reachable at ${this.baseUrl}`);
      evidence.push(probe.authenticated ? 'session authenticated' : (this.apiKey ? 'token present but NOT authenticated — token may be expired or need /tickle brokerage login' : 'not authenticated'));
      if (accountId) evidence.push(`account ${accountId} (${inferMode(accountId)})`);
    }
    // Map the OAuth1 handshake failure (if any) to a plain-English reason so the UI
    // can tell "not activated yet" apart from a real key/config error.
    const lstErr = this._lstError;
    const reason = connected ? null : (lstErr && lstErr.code) || (probe.reachable ? 'not_authenticated' : 'unreachable');
    const value = {
      connected,
      reachable: !!probe.reachable,
      authenticated: !!probe.authenticated,
      sessionAlive: !!probe.sessionAlive,
      readsOk,
      accountId: accountId || null,
      mode: inferMode(accountId),
      gatewayUrl: this.baseUrl,
      source: 'ibkr-webapi',
      reason,
      reasonText: connected ? null : reasonText(reason, lstErr),
      evidence,
      checkedAt: new Date().toISOString(),
    };
    this._statusCache = { at: now, value };
    return value;
  }
}

/** Plain-English reason for a not-connected IBKR status (drives the UI banner). */
function reasonText(reason, lstErr) {
  switch (reason) {
    case 'invalid_consumer':
      return "IBKR rejects your consumer key as unknown (error 164, “invalid consumer”). This is NOT an activation delay — waiting won’t help. Register the consumer in IBKR’s Self-Service OAuth portal and enter the EXACT consumer key IBKR accepts.";
    case 'not_activated_or_unauthorized':
      return "IBKR rejected the OAuth handshake — your consumer isn't active yet. IBKR can take up to ~24h to enable a new one; try Recheck later.";
    case 'lst_signature_mismatch':
      return 'The keys/DH prime don’t match what IBKR has registered. Regenerate your keys, re-upload the 3 files to IBKR, and reconnect.';
    case 'bad_key':
      return 'The stored private key is not valid PEM.' + (lstErr && lstErr.detail ? ` (${lstErr.detail})` : '');
    case 'no_dh_response':
      return 'IBKR accepted the request but returned no handshake data — try again shortly.';
    case 'unreachable':
      return 'Could not reach the IBKR Web API (network/endpoint issue).';
    case 'not_authenticated':
      return 'Handshake succeeded but no brokerage session — usually clears on the next Recheck.';
    default:
      return reason && reason.startsWith('http_')
        ? `IBKR returned an unexpected error (${reason.replace('http_', 'HTTP ')}).`
        : 'IBKR did not authenticate yet — check the keys and that your OAuth consumer is active (up to 24h).';
  }
}

module.exports = IbkrCpapi;
module.exports.isLoopback = isLoopback;
module.exports.pickAmount = pickAmount;
module.exports.normalizeSummary = normalizeSummary;
module.exports.normalizePosition = normalizePosition;
module.exports.inferMode = inferMode;
module.exports.DEFAULT_BASE = DEFAULT_BASE;
