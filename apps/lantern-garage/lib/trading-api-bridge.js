/**
 * Trading API Bridge
 * Connects to IBKR, KALSHI, and independent AI trader agents
 * Provides real-time market data and AI recommendations
 */

const http = require('http');
const https = require('https');
const IbkrCpapi = require('./ibkr-cpapi');

class TradingAPIBridge {
  constructor() {
    // IBKR — real Client Portal Web API (CPAPI) via the local gateway.
    // The earlier "direct REST, no Gateway" path (Bearer token → api.ibkr.com/v1)
    // was fictional: IBKR exposes no such endpoint, so it silently returned null
    // 100% of the time. lib/ibkr-cpapi.js talks to the actual gateway and fails
    // soft when it isn't running. Constructed lazily via ibkr().
    this._ibkr = null;


    this.kalshiApiKey = process.env.KALSHI_API_KEY || '';
    this.anthropicKey = process.env.ANTHROPIC_API_KEY || '';

    this.marketCache = {};
    this.adviceCache = {};
    this.cacheExpiry = 30000; // 30 seconds
  }

  /** Lazily build the CPAPI client (reads IBKR_GATEWAY_URL / IBKR_ACCOUNT_ID). */
  ibkr() {
    if (!this._ibkr) this._ibkr = new IbkrCpapi();
    return this._ibkr;
  }

  /**
   * Account summary from the IBKR Client Portal gateway (CPAPI). Returns null
   * when the gateway is absent or unauthenticated — it never fabricates a value.
   */
  async getIBKRAccount() {
    const client = this.ibkr();
    const status = await client.getStatus();
    if (!status.connected) return null;
    const summary = await client.getAccountSummary(status.accountId);
    if (!summary) return null;
    const { equity, cash, buyingPower, unrealizedPnl } = summary;
    return {
      account_id: status.accountId,
      equity: equity != null ? equity : 0,
      cash: cash != null ? cash : 0,
      pnl_today: unrealizedPnl != null ? unrealizedPnl : 0,
      pnl_pct: (unrealizedPnl != null && equity) ? (unrealizedPnl / equity) * 100 : 0,
      buying_power: buyingPower != null ? buyingPower : 0,
      mode: status.mode,
      source: 'ibkr-cpapi',
    };
  }

  /**
   * Open positions from the IBKR gateway (CPAPI). Returns [] when disconnected.
   */
  async getIBKRPositions() {
    const client = this.ibkr();
    const status = await client.getStatus();
    if (!status.connected) return [];
    const positions = await client.getPositions(status.accountId);
    return positions.map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      avg_fill_price: p.avgPrice != null ? p.avgPrice : 0,
      current_price: p.currentPrice != null ? p.currentPrice : 0,
      unrealized_pl: p.unrealizedPnl != null ? p.unrealizedPnl : 0,
      conid: p.conid,
      asset_class: p.assetClass,
    }));
  }

  /** Honest, evidence-bearing IBKR connection status for UI badges + settings. */
  async getIBKRStatus() {
    return this.ibkr().getStatus();
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
