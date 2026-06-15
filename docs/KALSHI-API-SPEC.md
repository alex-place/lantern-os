# Kalshi Trading API Specification

Lantern OS provides a comprehensive REST API for Kalshi trading, market analysis, and automated trading strategies.

## Base URL

```
http://localhost:4177/api/trading/kalshi
```

## Authentication

All endpoints require valid Kalshi credentials configured in the environment. The server handles authentication internally using `KALSHI_EMAIL` and `KALSHI_PASSWORD`.

---

## Connection & Status

### GET /connection
Check Kalshi exchange connection status and credentials.

**Response:**
```json
{
  "env": "prod" | "demo",
  "exchangeActive": true,
  "credentials": true,
  "canTradeLive": true
}
```

### GET /balance
Get account balance in cents.

**Response:**
```json
{
  "balance_cents": 10000,
  "balance_dollars": 100.00
}
```

---

## Market Data

### GET /events
List all available Kalshi events.

**Query Params:**
- `limit` (optional): Number of events to return

**Response:**
```json
{
  "events": [
    {
      "id": "event_id",
      "title": "Event Title",
      "category": "category_name"
    }
  ]
}
```

### GET /markets
List markets for a specific event.

**Query Params:**
- `event_id` (required): Event identifier

**Response:**
```json
{
  "markets": [
    {
      "id": "market_id",
      "title": "Market Title",
      "ticker": "KXBTCD-26JUN14-T64499.99",
      "close_time": "2026-06-26T00:00:00Z",
      "yes_ask": 85,
      "no_ask": 15
    }
  ]
}
```

### GET /live-markets
Get currently active markets with real-time pricing.

**Response:**
```json
{
  "markets": [
    {
      "ticker": "KXBTCD-26JUN14-T64499.99",
      "title": "Market Title",
      "yes_pct": 85,
      "no_pct": 15,
      "mins_to_close": 120
    }
  ]
}
```

### GET /orderbook
Get order book for a specific market.

**Query Params:**
- `ticker` (required): Market ticker

**Response:**
```json
{
  "yes": {
    "bids": [[85, 100], [84, 200]],
    "asks": [[86, 150], [87, 300]]
  },
  "no": {
    "bids": [[15, 100], [14, 200]],
    "asks": [[16, 150], [17, 300]]
  }
}
```

---

## Trading Operations

### POST /order
Place a limit order.

**Request Body:**
```json
{
  "ticker": "KXBTCD-26JUN14-T64499.99",
  "side": "yes" | "no",
  "action": "buy" | "sell",
  "type": "limit",
  "count": 1,
  "limit_cents": 85
}
```

**Response:**
```json
{
  "mode": "live" | "dry_run",
  "status": 201,
  "result": {
    "order_id": "order_id",
    "ticker": "KXBTCD-26JUN14-T64499.99",
    "side": "yes",
    "count": 1,
    "limit_cents": 85
  }
}
```

### POST /order/cancel
Cancel an existing order.

**Request Body:**
```json
{
  "order_id": "order_id"
}
```

**Response:**
```json
{
  "cancelled": true,
  "order_id": "order_id"
}
```

---

## Portfolio Management

### GET /positions
Get current open positions.

**Response:**
```json
{
  "positions": [
    {
      "ticker": "KXBTCD-26JUN14-T64499.99",
      "side": "yes",
      "count": 1,
      "entry_cents": 85,
      "current_cents": 87,
      "pnl_cents": 200,
      "pnl_pct": 2.35
    }
  ]
}
```

### GET /positions-deck
Get positions formatted for swipe deck UI (exit-only mode).

**Query Params:**
- `exitsOnly` (optional): Set to `true` to only show exitable positions

**Response:**
```json
{
  "cards": [
    {
      "ticker": "KXBTCD-26JUN14-T64499.99",
      "title": "Market Title",
      "kind": "exit",
      "qty": 1,
      "entry_cents": 85,
      "fav_side": "yes",
      "fav_ask": 87,
      "net_pnl_cents": 200,
      "net_pnl_pct": 2.35,
      "mins_to_close": 120,
      "exit_tag": "TAKE-PROFIT"
    }
  ]
}
```

### GET /portfolio-orders
Get order history for portfolio.

**Response:**
```json
{
  "orders": [
    {
      "order_id": "order_id",
      "ticker": "KXBTCD-26JUN14-T64499.99",
      "side": "yes",
      "action": "buy",
      "count": 1,
      "limit_cents": 85,
      "status": "filled",
      "created_at": "2026-06-15T00:00:00Z"
    }
  ]
}
```

### GET /fills
Get recent trade fills.

**Response:**
```json
{
  "fills": [
    {
      "order_id": "order_id",
      "ticker": "KXBTCD-26JUN14-T64499.99",
      "side": "yes",
      "count": 1,
      "price_cents": 85,
      "filled_at": "2026-06-15T00:00:00Z"
    }
  ]
}
```

---

## Paper Trading

### POST /paper-trade
Simulate a trade without real money.

**Request Body:**
```json
{
  "ticker": "KXBTCD-26JUN14-T64499.99",
  "side": "yes",
  "action": "buy",
  "count": 1,
  "limit_cents": 85
}
```

**Response:**
```json
{
  "mode": "paper",
  "status": "simulated",
  "result": {
    "ticker": "KXBTCD-26JUN14-T64499.99",
    "side": "yes",
    "count": 1,
    "limit_cents": 85,
    "simulated_pnl_cents": 200
  }
}
```

### GET /paper-positions
Get paper trading positions.

**Response:**
```json
{
  "positions": [
    {
      "ticker": "KXBTCD-26JUN14-T64499.99",
      "side": "yes",
      "count": 1,
      "entry_cents": 85,
      "current_cents": 87,
      "simulated_pnl_cents": 200
    }
  ]
}
```

### POST /paper-close
Close a paper trading position.

**Request Body:**
```json
{
  "ticker": "KXBTCD-26JUN14-T64499.99"
}
```

---

## AI & Convergence

### GET /suggestions
Get AI-generated trading suggestions.

**Response:**
```json
{
  "suggestions": [
    {
      "ticker": "KXBTCD-26JUN14-T64499.99",
      "title": "Market Title",
      "fav_side": "yes",
      "fav_ask": 85,
      "conviction": 75,
      "reason": "Strong bullish signal from price action",
      "kind": "signal"
    }
  ]
}
```

### GET /convergence-ranked
Get markets ranked by convergence probability.

**Response:**
```json
{
  "markets": [
    {
      "ticker": "KXBTCD-26JUN14-T64499.99",
      "title": "Market Title",
      "convergence_score": 0.92,
      "fav_side": "yes",
      "fav_ask": 85,
      "profit_cents": 15
    }
  ]
}
```

### GET /crypto-intraday
Get crypto-based intraday signals.

**Response:**
```json
{
  "cards": [
    {
      "ticker": "KXBTCD-26JUN14-T64499.99",
      "title": "Market Title",
      "kind": "crypto",
      "fav_side": "yes",
      "fav_ask": 85,
      "conviction": 70
    }
  ]
}
```

### GET /impossibility-deck
Get impossibility-engine trading cards.

**Response:**
```json
{
  "cards": [
    {
      "ticker": "KXBTCD-26JUN14-T64499.99",
      "title": "Market Title",
      "kind": "entry",
      "state_label": "DETERMINED",
      "fav_side": "yes",
      "fav_ask": 85,
      "conviction": 85
    }
  ]
}
```

### GET /decisive-deck
Get decisive-engine trading cards.

**Response:**
```json
{
  "cards": [
    {
      "ticker": "KXBTCD-26JUN14-T64499.99",
      "title": "Market Title",
      "kind": "entry",
      "fav_side": "yes",
      "fav_ask": 85,
      "conviction": 80
    }
  ]
}
```

### GET /observer-frontier
Get observer-engine frontier analysis.

**Response:**
```json
{
  "frontier": [
    {
      "ticker": "KXBTCD-26JUN14-T64499.99",
      "title": "Market Title",
      "observer_score": 0.88,
      "fav_side": "yes",
      "fav_ask": 85
    }
  ]
}
```

---

## Convergence Training

### POST /convergence/train
Train convergence model on historical data.

**Request Body:**
```json
{
  "epochs": 100,
  "learning_rate": 0.001
}
```

**Response:**
```json
{
  "training_id": "train_id",
  "status": "started",
  "epochs": 100
}
```

### GET /convergence/model
Get current convergence model metadata.

**Response:**
```json
{
  "model_id": "model_id",
  "version": "1.0",
  "trained_at": "2026-06-15T00:00:00Z",
  "accuracy": 0.85
}
```

### GET /convergence/accuracy
Get convergence model accuracy metrics.

**Response:**
```json
{
  "accuracy": 0.85,
  "precision": 0.82,
  "recall": 0.88,
  "f1_score": 0.85
}
```

---

## Convergence Enhancement

### POST /convergence/enhance/start
Start convergence enhancement process.

**Response:**
```json
{
  "enhancement_id": "enhance_id",
  "status": "started"
}
```

### POST /convergence/enhance/stop
Stop convergence enhancement process.

**Response:**
```json
{
  "status": "stopped"
}
```

### GET /convergence/enhance/status
Get convergence enhancement status.

**Response:**
```json
{
  "status": "running",
  "progress": 0.65,
  "iterations": 130
}
```

---

## LoRA Fine-Tuning

### POST /convergence/lora/start
Start LoRA fine-tuning.

**Request Body:**
```json
{
  "rank": 8,
  "alpha": 16
}
```

**Response:**
```json
{
  "lora_id": "lora_id",
  "status": "started"
}
```

### POST /convergence/lora/stop
Stop LoRA fine-tuning.

**Response:**
```json
{
  "status": "stopped"
}
```

### GET /convergence/lora/status
Get LoRA fine-tuning status.

**Response:**
```json
{
  "status": "running",
  "progress": 0.45,
  "step": 450
}
```

---

## Dashboard

### GET /dashboard/progress
Get training progress for dashboard.

**Response:**
```json
{
  "phases": [
    {
      "name": "Data Collection",
      "progress": 1.0,
      "status": "complete"
    },
    {
      "name": "Model Training",
      "progress": 0.65,
      "status": "in_progress"
    }
  ]
}
```

### GET /dashboard/overview
Get dashboard overview metrics.

**Response:**
```json
{
  "total_trades": 150,
  "win_rate": 0.68,
  "total_pnl_cents": 5000,
  "active_positions": 5
}
```

---

## Monitoring

### POST /monitor/start
Start position monitoring.

**Response:**
```json
{
  "status": "monitoring_started"
}
```

### POST /monitor/stop
Stop position monitoring.

**Response:**
```json
{
  "status": "monitoring_stopped"
}
```

### GET /monitor/positions
Get monitored positions.

**Response:**
```json
{
  "positions": [
    {
      "ticker": "KXBTCD-26JUN14-T64499.99",
      "side": "yes",
      "count": 1,
      "entry_cents": 85,
      "current_cents": 87,
      "pnl_cents": 200
    }
  ]
}
```

### GET /collector-status
Get Kalshi data collector status.

**Response:**
```json
{
  "status": "running",
  "last_collection": "2026-06-15T00:00:00Z",
  "markets_collected": 150
}
```

### GET /observer-status
Get observer engine status.

**Response:**
```json
{
  "status": "running",
  "last_analysis": "2026-06-15T00:00:00Z",
  "markets_analyzed": 120
}
```

---

## Win Rate Statistics

### GET /winrate-stats
Get historical win rate statistics.

**Response:**
```json
{
  "overall_win_rate": 0.68,
  "by_market": {
    "crypto": 0.72,
    "economic": 0.65
  },
  "by_timeframe": {
    "1h": 0.70,
    "24h": 0.68
  }
}
```

---

## Events List

### GET /events-list
Get paginated events list.

**Query Params:**
- `page` (optional): Page number
- `limit` (optional): Items per page

**Response:**
```json
{
  "events": [...],
  "page": 1,
  "total_pages": 10
}
```

---

## Error Codes

| Status Code | Description |
|-------------|-------------|
| 200 | Success |
| 201 | Created (order placed) |
| 400 | Bad Request (invalid parameters) |
| 401 | Unauthorized (invalid credentials) |
| 404 | Not Found (market/event not found) |
| 422 | Unprocessable Entity (order rejected by Kalshi) |
| 429 | Too Many Requests (rate limited) |
| 500 | Internal Server Error |

---

## Rate Limiting

The API implements exponential backoff for 429 errors using the `Retry-After` header from Kalshi. This prevents API quota exhaustion and ensures reliable operation under high load.

---

## Caching

Market data is cached in the Kalshi collector to prevent direct UI polling and reduce API quota usage. Cache TTL is configurable via environment variables.
