# Trading API Reference

All endpoints are served by `routes/trading.js` at `http://127.0.0.1:4177`.
Kalshi endpoints that require credentials are gated behind API key presence; unauthenticated calls return `{"error":"credentials_required"}`.

> **Broker = IBKR (Alpaca removed).** The stock broker is now the **IBKR Client
> Portal Web API** via a local gateway — read-only account/positions plus **gated,
> dry-by-default** order placement (`lib/trading-guard.js`; see
> [ADR-0019](adr/0019-ibkr-connectivity-client-portal-gateway.md) +
> [ADR-0020](adr/0020-ibkr-live-order-placement.md)). Market data is **keyless Yahoo**
> (`lib/market-data-yahoo.js`) and signals come from the **Node signal-engine**
> (`lib/signal-engine/`) — there is no Python trading service anymore. The former
> Alpaca AI-trader microservice and its `alpaca-trade-api` dependency have been removed;
> the `/api/trading/ai-trader/*` routes below are legacy compatibility shims.

---

## General Trading

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/trading/status` | Overall trading system health (API key presence, kill-switch state) |
| `GET` | `/api/trading/settings` | Key configuration: which API keys are set, env flags |
| `POST` | `/api/trading/settings` | Update runtime trading settings |
| `GET` | `/api/trading/market-status` | Market open/closed, session info |
| `GET` | `/api/trading/zones` | Support/resistance zones for watchlist tickers |
| `GET` | `/api/trading/positions` | Open positions across all brokers |
| `GET` | `/api/trading/watchlist` | Current watchlist tickers |
| `POST` | `/api/trading/watchlist` | Replace watchlist |
| `GET` | `/api/trading/watchlist-prices` | Live prices for all watchlist tickers |
| `GET` | `/api/trading/bars-multi` | OHLCV bars for multiple tickers (`?tickers=SPY,AAPL&timeframe=5m`) |
| `GET` | `/api/trading/agent-log` | Recent agent decision log entries |
| `POST` | `/api/trading/agent-log` | Append an agent log entry |
| `GET` | `/api/trading/orders` | Broker order history |
| `POST` | `/api/trading/orders` | Place a broker order |
| `POST` | `/api/trading/orders/place` | Alias for order placement |
| `GET` | `/api/trading/evaluate-asset` | Run TradingTesseract evaluation on one asset |
| `POST` | `/api/trading/evaluate-watchlist` | Evaluate full watchlist through tesseract |
| `GET` | `/api/trading/price-feed` | Latest price tick for default watchlist |
| `GET` | `/api/trading/price-feed/watchlist` | Price feed for custom watchlist (`?tickers=...`) |
| `GET` | `/api/trading/csf-records` | Recent CSF-archived trade records |
| `GET` | `/api/trading/memory/recent` | Recent trading memory entries |

---

## Kalshi Markets

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/trading/kalshi/events` | List Kalshi events (public, no auth) |
| `GET` | `/api/trading/kalshi/markets` | List Kalshi markets (public, no auth) |
| `GET` | `/api/trading/kalshi/live-markets` | Live open markets snapshot (`?status=open&limit=500`) |
| `GET` | `/api/trading/kalshi/events-list` | Paginated event list with filtering |
| `GET` | `/api/trading/kalshi/connection` | Kalshi API connectivity check |
| `GET` | `/api/trading/kalshi/balance` | Account cash balance and buying power |
| `GET` | `/api/trading/kalshi/positions` | Open Kalshi positions |
| `GET` | `/api/trading/kalshi/portfolio-orders` | Order history from portfolio |
| `GET` | `/api/trading/kalshi/fills` | Filled order history |
| `GET` | `/api/trading/kalshi/orderbook` | Orderbook depth for a ticker (`?ticker=KXMLB-25JUN14-T8.5`) |
| `POST` | `/api/trading/kalshi/order` | Place order (dry-run or live). Cash preflight check → returns Kalshi HTTP status |
| `POST` | `/api/trading/kalshi/order/cancel` | Cancel an open order (`{orderId}`) |

---

## Kalshi Swipe Deck

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/trading/kalshi/suggestions` | Kalshi-suggest tight-band entry candidates |
| `GET` | `/api/trading/kalshi/convergence-ranked` | Convergence cards ranked by CIO score |
| `GET` | `/api/trading/kalshi/impossibility-deck` | Impossibility Engine (IE) swipe deck |
| `GET` | `/api/trading/kalshi/decisive-deck` | Decisive-moment deck (combined IE + convergence + crypto) |
| `GET` | `/api/trading/kalshi/observer-frontier` | Observer engine frontier markets |

---

## Kalshi Convergence Model

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/trading/kalshi/convergence/train` | Trigger model training run |
| `GET` | `/api/trading/kalshi/convergence/model` | Current model weights and metadata |
| `GET` | `/api/trading/kalshi/convergence/accuracy` | Historical accuracy stats |
| `POST` | `/api/trading/kalshi/convergence/enhance/start` | Start LoRA enhancement pass |
| `POST` | `/api/trading/kalshi/convergence/enhance/stop` | Stop enhancement |
| `GET` | `/api/trading/kalshi/convergence/enhance/status` | Enhancement job status |
| `POST` | `/api/trading/kalshi/convergence/lora/start` | Start LoRA fine-tune |
| `POST` | `/api/trading/kalshi/convergence/lora/stop` | Stop LoRA |
| `GET` | `/api/trading/kalshi/convergence/lora/status` | LoRA job status |

---

## Kalshi Monitor & Dashboard

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/trading/kalshi/monitor/start` | Start position monitor |
| `POST` | `/api/trading/kalshi/monitor/stop` | Stop monitor |
| `GET` | `/api/trading/kalshi/monitor/positions` | Current monitored positions |
| `GET` | `/api/trading/kalshi/dashboard/progress` | Phase + loop progress for kalshi-dashboard.html |
| `GET` | `/api/trading/kalshi/dashboard/overview` | Full dashboard overview (metrics, loops, files) |
| `GET` | `/api/trading/kalshi/collector-status` | Tight-band collector health, backoff state, latest snapshot |
| `GET` | `/api/trading/kalshi/observer-status` | Observer engine health and today's snapshot count |
| `GET` | `/api/trading/kalshi/winrate-stats` | Win-rate statistics from trade history |

---

## Crypto

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/trading/kalshi/crypto-intraday` | Crypto intraday data via Kalshi markets |
| `GET` | `/api/trading/crypto/prices` | Latest crypto prices (BTC/ETH/SOL/XRP/DOGE) from Kalshi |
| `GET` | `/api/trading/crypto/prices/historical` | Historical price snapshots (`?limit=100`) |
| `GET` | `/api/trading/crypto/news` | CoinGecko trending crypto news |

---

## Trade History

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/trading/history/trades` | Completed trades log (`?symbol=BTCUSD&limit=20`) |
| `GET` | `/api/trading/history/signals` | Signal history (`?symbol=BTCUSD&min_confidence=0.7`) |
| `GET` | `/api/trading/history/stats` | Aggregate stats: win rate, avg P&L (`?symbol=BTCUSD`) |

---

## News

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/trading/news/recent` | Recent trading news items |
| `POST` | `/api/trading/news/record` | Record a news item |
| `POST` | `/api/trading/news/link-trade` | Link a news item to a trade |

---

## AI Trader (legacy shims)

> Alpaca has been removed. These paths are kept for backward compatibility; portfolio /
> positions now resolve through the IBKR bridge (`lib/trading-api-bridge.js` →
> `lib/ibkr-cpapi.js`), not Alpaca.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/trading/ai-trader/status` | AI trader process health |
| `GET` | `/api/trading/ai-trader/portfolio` | Current portfolio (via IBKR bridge) |
| `GET` | `/api/trading/ai-trader/trades` | Recent AI-executed trades |
| `POST` | `/api/trading/ai-trader/trades` | Record a manual trade |
| `GET` | `/api/trading/ai-trader/metrics` | Performance metrics |
| `POST` | `/api/trading/ai-trader/signals/generate` | Generate signals for a ticker |
| `POST` | `/api/trading/ai-trader/scanner/start` | Start market scanner |
| `POST` | `/api/trading/ai-trader/scanner/stop` | Stop scanner |
| `GET` | `/api/trading/ai-trader/scanner/status` | Scanner status |
| `GET` | `/api/trading/ai-trader/watchlist` | AI trader watchlist |
| `GET` | `/api/trading/ai-trader/zones` | AI trader support/resistance zones |

---

## Dashboard (non-Kalshi)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/trading/dashboard/orders` | Order summary for dashboard |
| `GET` | `/api/trading/dashboard/agent-log` | Agent log for dashboard |

---

## IBKR

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/trading/ibkr/account` | IBKR account summary |
| `GET` | `/api/trading/ibkr/positions` | IBKR positions |

---

## Key behaviours

**Order flow** (`POST /api/trading/kalshi/order`):
1. Cash preflight: fetches balance, rejects with HTTP 402 if `price × quantity > available_cash`
2. Calls `kalshi.placeOrder()` which is kill-switch gated
3. Returns the Kalshi HTTP status code directly (not always 200)
4. Dry-run mode returns `{mode:"dry_run", wouldBlock:[...]}` with HTTP 200

**Rate limit backoff** (kalshi-collector):
- On 429, collector reads `Retry-After` header (min 30 s) and pauses
- `/api/trading/kalshi/collector-status` exposes `{backoff:true, resumeAt:"<iso>"}` during pause

**Tab visibility** (kalshi-terminal.html):
- Page Visibility API pauses all 4 polling intervals when tab is hidden
- On tab focus: restores normal intervals + immediate refresh
