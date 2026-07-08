/**
 * Trading API Bridge
 * Connects to IBKR, KALSHI, and independent AI trader agents
 * Provides real-time market data and AI recommendations
 */

const http = require('http');
const https = require('https');
const IbkrCpapi = require('./ibkr-cpapi');
const ibkrCreds = require('./ibkr-credentials');

// Module-level so the short-lived cache is SHARED across bridge instances — the
// trading routes build a fresh TradingAPIBridge per request, so an instance-level
// cache would never survive between polls. key -> { val, exp }.
const _RESP_CACHE = new Map();

class TradingAPIBridge {
  constructor() {
    // IBKR — real Client Portal Web API (CPAPI) via the local gateway.
    // The earlier "direct REST, no Gateway" path (Bearer token → api.ibkr.com/v1)
    // was fictional: IBKR exposes no such endpoint, so it silently returned null
    // 100% of the time. lib/ibkr-cpapi.js talks to the actual gateway and fails
    // soft when it isn't running. Constructed lazily via ibkr().
    this._ibkr = null;
    // Per-user IBKR clients (ADR-0022) — each keeps its own cached Live Session
    // Token, so we reuse instances instead of re-handshaking every request.
    this._userClients = new Map(); // userId -> { client, expiresAt }

    this.kalshiApiKey = process.env.KALSHI_API_KEY || '';
    this.anthropicKey = process.env.ANTHROPIC_API_KEY || '';

    this.marketCache = {};
    this.adviceCache = {};
    this.cacheExpiry = 30000; // 30 seconds
    // Short-lived response cache so the polling trader UI (account/positions every
    // few seconds) and the symbol-search box don't re-hit IBKR's remote API on
    // every call. Account/positions: 4s (fresh enough for a live view); symbol
    // search: 60s (a symbol's listings barely change). Invalidated on order place.
  }

  /** Memoize an async result for ttlMs in the shared cache. Caches null too (e.g.
   *  "not connected"), which is fine for a few seconds and avoids hammering a down
   *  gateway. */
  async _cached(key, ttlMs, fn) {
    const hit = _RESP_CACHE.get(key);
    if (hit && hit.exp > Date.now()) return hit.val;
    const val = await fn();
    _RESP_CACHE.set(key, { val, exp: Date.now() + ttlMs });
    return val;
  }

  /** Drop a user's cached account/positions (call right after an order changes them). */
  _invalidateUser(userId) {
    _RESP_CACHE.delete('acct:' + userId);
    _RESP_CACHE.delete('pos:' + userId);
  }

  /** Lazily build the CPAPI client (reads IBKR_GATEWAY_URL / IBKR_ACCOUNT_ID). */
  ibkr() {
    if (!this._ibkr) this._ibkr = new IbkrCpapi();
    return this._ibkr;
  }

  /** A user's OWN IBKR client from their stored self-service creds, or null if
   *  they haven't connected. Cached (LST lives on the instance). ADR-0022. */
  ibkrForUser(userId) {
    if (!userId) return null;
    // Re-check the store on every resolve so a disconnect (creds file removed)
    // takes effect immediately rather than lingering for the cache TTL.
    if (!ibkrCreds.has(userId)) { this._userClients.delete(userId); return null; }
    const hit = this._userClients.get(userId);
    if (hit && hit.expiresAt > Date.now()) return hit.client;
    const signer = ibkrCreds.buildSigner(userId);
    if (!signer) { this._userClients.delete(userId); return null; }
    const creds = ibkrCreds.load(userId);
    const client = new IbkrCpapi({ oauth1: signer, accountId: creds && creds.accountId });
    this._userClients.set(userId, { client, expiresAt: Date.now() + 15 * 60 * 1000 });
    return client;
  }

  /**
   * Resolve the IBKR client for a request context:
   *   - a signed-in user → THEIR client (null if they haven't connected — we
   *     must NEVER fall back to the operator's account for a real user);
   *   - no user (server-side / operator / autonomous) → the env client.
   * Drop the userId cache entry on disconnect via forgetUser().
   */
  _clientFor(userId) {
    if (userId) return this.ibkrForUser(userId); // null when not connected
    return this.ibkr();
  }

  /** Invalidate a user's cached client (call on disconnect / creds change). */
  forgetUser(userId) { this._userClients.delete(userId); }

  /**
   * Account summary from the IBKR Client Portal gateway (CPAPI). Returns null
   * when the gateway is absent or unauthenticated — it never fabricates a value.
   * Cached 4s so the polling UI doesn't re-hit IBKR on every refresh.
   */
  async getIBKRAccount(userId) {
    return this._cached('acct:' + userId, 4000, () => this._getIBKRAccountRaw(userId));
  }
  async _getIBKRAccountRaw(userId) {
    const client = this._clientFor(userId);
    if (!client) return null;                 // user context, not connected
    const status = await client.getStatus();
    if (!status.connected) return null;
    const summary = await client.getAccountSummary(status.accountId);
    if (!summary) return null;
    const { equity, cash, buyingPower, unrealizedPnl } = summary;
    // Broker-authoritative P&L (dpl/upl/rpl) so the footer's Realized/Unrealized/Day
    // fields populate (they were "—" because these keys were never returned).
    const pnl = await client.getPnl(status.accountId).catch(() => null);
    const unrealized = pnl && pnl.unrealizedPnl != null ? pnl.unrealizedPnl : (unrealizedPnl != null ? unrealizedPnl : 0);
    const realized = pnl && pnl.realizedPnl != null ? pnl.realizedPnl : 0;
    const day = pnl && pnl.dailyPnl != null ? pnl.dailyPnl : unrealized;
    return {
      account_id: status.accountId,
      equity: equity != null ? equity : 0,
      cash: cash != null ? cash : 0,
      unrealized,                 // footer "Unrealized P&L" (was —)
      realized_today: realized,   // footer "Realized P&L" (was —)
      pnl_today: day,             // footer "Day P&L" (broker dpl)
      pnl_pct: equity ? (day / equity) * 100 : 0,
      buying_power: buyingPower != null ? buyingPower : 0,
      mode: status.mode,
      source: 'ibkr-cpapi',
    };
  }

  /**
   * Place an order on a user's OWN IBKR account (per-user OAuth, ADR-0022).
   * Returns null when the user hasn't connected an IBKR account — the caller then
   * falls back to its default order path. The order is still HARD-GATED inside
   * IbkrCpapi.placeOrder (DRY unless TRADER_LIVE=1; a live U… account additionally
   * needs TRADER_ALLOW_LIVE_ACCOUNT=1). Returns the same normalized shape the UI
   * already consumes: { status:'placed'|'dry_run'|'error', order_id, ticker, … }.
   */
  async placeIBKROrder(userId, { ticker, side, qty, type, limitPrice, stopPrice, timeInForce, stopLoss, takeProfit, equity }) {
    const client = this.ibkrForUser(userId);
    if (!client) return null;                 // not connected → caller falls back
    const status = await client.getStatus();
    if (!status.connected) return null;
    // Crypto pairs (BTCUSD/ETHUSD/SOLUSD…) don't trade through this path: IBKR's
    // hosted crypto (Paxos) requires cash-quantity orders on a US crypto-enabled
    // account, and the share-quantity order path here doesn't support it. Fail with
    // a clear reason instead of an opaque "could not resolve conid" / Bad Request.
    if (/^[A-Z]{2,5}USD$/.test(String(ticker || '').toUpperCase())) {
      const reason = `Crypto (${ticker}) can't be traded through this IBKR connection. IBKR crypto needs a US crypto-enabled account and cash-quantity orders — not supported on ${status.accountId || 'this account'} (paper, stocks/options).`;
      return { status: 'error', order_id: null, ticker, side, qty, type: type || 'market', dry: false, reason, error: reason, mode: status.mode, source: 'ibkr-cpapi' };
    }
    const t = String(type || 'market').toLowerCase();
    const orderType = t === 'limit' ? 'LMT' : t === 'stop' ? 'STP' : 'MKT';
    // A protective stop must survive the session → GTC by default; entries default DAY.
    const defaultTif = orderType === 'STP' ? 'gtc' : 'day';
    // Equity for the guard's %-of-portfolio cap: caller-supplied, else read it.
    let eq = Number(equity) || 0;
    if (!eq) { const acct = await this.getIBKRAccount(userId).catch(() => null); eq = (acct && acct.equity) || 0; }
    const r = await client.placeOrder({
      symbol: ticker,
      side,
      qty,
      orderType,
      price: orderType === 'STP' ? stopPrice : limitPrice,
      tif: String(timeInForce || defaultTif).toLowerCase() === 'gtc' ? 'GTC' : 'DAY',
      equity: eq,
    });
    const reason = r.note || r.error || (r.gate && r.gate.reason) || null;
    if (r.status === 'submitted') this._invalidateUser(userId); // fresh account/positions next read
    return {
      status: r.status === 'submitted' ? 'placed' : r.status, // placed | dry_run | error
      order_id: r.orderId || null,
      ticker, side, qty, type: type || 'market',
      dry: !!r.dry,
      reason,
      error: r.status === 'error' ? reason : undefined, // surfaced by the UI (result.error)
      mode: r.gate && r.gate.mode,
      stop_loss: stopLoss || null,
      take_profit: takeProfit || null,
      source: 'ibkr-cpapi',
    };
  }

  /**
   * Search IBKR's own contract universe for the symbol-search popup — so ANY
   * tradable US stock/ETF is findable, not just a hardcoded seed list. Returns
   * tradable STK listings (stocks + ETFs; this account's classes), or null when
   * no IBKR account is connected (caller falls back to the Yahoo probe).
   */
  async searchIBKRSymbols(userId, q) {
    return this._cached('search:' + userId + ':' + String(q || '').trim().toLowerCase(), 60000, () => this._searchIBKRSymbolsRaw(userId, q));
  }
  async _searchIBKRSymbolsRaw(userId, q) {
    const client = this.ibkrForUser(userId);
    if (!client) return null;
    const status = await client.getStatus();
    if (!status.connected) return null;
    const query = String(q || '').trim();
    if (!query) return [];
    const US = /^(NASDAQ|NYSE|ARCA|NYSEARCA|BATS|AMEX|IEX|PINK)$/i;
    const seen = new Set();
    const out = [];
    const add = (sym, name, conid) => {
      const s = String(sym || '').toUpperCase();
      if (!s || seen.has(s) || !/^[A-Z]{1,6}$/.test(s)) return;
      seen.add(s);
      out.push({ symbol: s, name: name || s, exchange: '', class: 'us_equity', conid, tradable: true });
    };
    // Symbol search: keep only listings that offer STK on a primary US venue.
    const rs = await client._request('POST', '/iserver/secdef/search', { symbol: query, name: false, secType: 'STK' }).catch(() => ({}));
    for (const c of (Array.isArray(rs.json) ? rs.json : [])) {
      const secs = Array.isArray(c.sections) ? c.sections.map((s) => String(s.secType).toUpperCase()) : [];
      if (secs.includes('STK') && US.test(String(c.description || ''))) {
        add(c.symbol, c.companyName || c.companyHeader || '', c.conid);
      }
    }
    // Thin symbol match → add company-name matches (name search has no sections).
    if (out.length < 5) {
      const rn = await client._request('POST', '/iserver/secdef/search', { symbol: query, name: true, secType: 'STK' }).catch(() => ({}));
      for (const c of (Array.isArray(rn.json) ? rn.json : [])) {
        add(c.symbol, c.companyName || c.companyHeader || c.description || '', c.conid);
        if (out.length >= 20) break;
      }
    }
    return out;
  }

  /** Broker-authoritative day P&L for a user's account (IBKR `dpl`), or null.
   *  The daily-loss circuit breaker reads this before opening new positions. */
  async getIBKRDayPnl(userId) {
    const client = this.ibkrForUser(userId);
    if (!client) return null;
    const status = await client.getStatus();
    if (!status.connected) return null;
    const pnl = await client.getPnl(status.accountId).catch(() => null);
    if (pnl && typeof pnl.dailyPnl === 'number') return pnl.dailyPnl;
    // Fall back to the account summary's day figure when partitioned P&L is absent.
    const acct = await this.getIBKRAccount(userId).catch(() => null);
    return acct && typeof acct.pnl_today === 'number' ? acct.pnl_today : null;
  }

  /**
   * Open positions from the IBKR gateway (CPAPI). Returns [] when disconnected.
   */
  async getIBKRPositions(userId) {
    return this._cached('pos:' + userId, 4000, () => this._getIBKRPositionsRaw(userId));
  }
  async _getIBKRPositionsRaw(userId) {
    const client = this._clientFor(userId);
    if (!client) return [];                   // user context, not connected
    const status = await client.getStatus();
    if (!status.connected) return [];
    const positions = await client.getPositions(status.accountId);
    return positions.map((p) => {
      const qty = Number(p.qty) || 0;
      const avg = p.avgPrice != null ? p.avgPrice : 0;
      const cur = p.currentPrice != null ? p.currentPrice : 0;
      const upl = p.unrealizedPnl != null ? p.unrealizedPnl : 0;
      const cost = Math.abs(qty) * avg;
      const mktVal = p.marketValue != null ? p.marketValue : qty * cur;
      return {
        symbol: p.symbol,
        qty,
        side: qty < 0 ? 'short' : 'long',        // was missing → UI mislabeled shorts as "Long"
        avg_entry_price: avg,                     // the name the UI reads (was avg_fill_price → "$—")
        avg_fill_price: avg,                      // back-compat alias
        current_price: cur,
        unrealized_pl: upl,
        pnl_pct: cost > 0 ? (upl / cost) * 100 : 0, // was missing → UI showed +0.00%
        trade_value: cost,                          // |qty|·avg — was $0.00
        market_value: mktVal,                       // was $—
        conid: p.conid,
        asset_class: p.assetClass,
      };
    });
  }

  /** Working/open IBKR orders for a user ([] when disconnected). */
  async getIBKROpenOrders(userId) {
    const client = this._clientFor(userId);
    if (!client) return [];
    const status = await client.getStatus();
    if (!status.connected) return [];
    return client.getLiveOrders();
  }

  /** Cancel a working IBKR order (e.g. an orphaned protective stop). */
  async cancelIBKROrder(userId, orderId) {
    const client = this._clientFor(userId);
    if (!client) return { ok: false };
    const status = await client.getStatus();
    if (!status.connected) return { ok: false };
    const r = await client.cancelOrder(orderId);
    if (r.ok) this._invalidateUser(userId);
    return r;
  }

  /** Honest, evidence-bearing IBKR connection status for UI badges + settings.
   *  Per-user when a userId is given (their own connection), else the env client. */
  async getIBKRStatus(userId) {
    const client = this._clientFor(userId);
    if (!client) return { connected: false, authenticated: false, source: 'ibkr-cpapi', mode: 'unknown' };
    return client.getStatus();
  }

  /**
   * Fetch open events from KALSHI
   */
  async getKALSHIEvents() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.kalshi.com',
        path: '/v1/events?status=open&limit=10',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.kalshiApiKey}`,
          'Accept': 'application/json'
        },
        timeout: 5000
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            resolve(result.events || []);
          } catch (e) {
            resolve([]);
          }
        });
      });

      req.on('error', err => {
        console.error('KALSHI error:', err.message);
        resolve([]);
      });
      req.on('timeout', () => {
        req.destroy();
        resolve([]);
      });

      req.end();
    });
  }

  /**
   * Aggregate all API data into a single dashboard response.
   *
   * `marketData` is intentionally null. The previous version returned hardcoded
   * static quotes (`sp500: '$5,843.25'`, `vix: '14.32'`, …) that never changed —
   * fabricated numbers presented as live market data, a direct Σ₀ external-reality
   * violation. Wire a real index/quote feed to populate it honestly.
   */
  async getDashboardData() {
    const [ibkrStatus, ibkrAccount, ibkrPos, kalshiEvents] = await Promise.all([
      this.getIBKRStatus().catch(() => null),
      this.getIBKRAccount().catch(() => null),
      this.getIBKRPositions().catch(() => []),
      this.getKALSHIEvents().catch(() => [])
    ]);

    return {
      timestamp: new Date().toISOString(),
      apis: {
        ibkr: {
          connected: !!(ibkrStatus && ibkrStatus.connected),
          status: ibkrStatus || null,
          account: ibkrAccount || null,
          positions: ibkrPos || []
        },
        kalshi: { connected: kalshiEvents.length > 0, events: kalshiEvents || [] }
      },
      marketData: null
    };
  }
}

module.exports = TradingAPIBridge;
