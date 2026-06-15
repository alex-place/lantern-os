# Lantern OS API Reference

**Version:** 1.5 (Comet Leap)  
**Base URL:** `http://localhost:4177` (local) or `https://lantern-os.railway.app` (cloud)  
**Authentication:** Environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)

---

## Core Systems

### Dream Chat API

**Dream Journal conversation endpoint with multi-agent routing**

#### POST `/api/dream/stream`
Stream dream chat responses with server-sent events.

```bash
curl -X POST http://localhost:4177/api/dream/stream \
  -H "Content-Type: application/json" \
  -d '{
    "message": "I had a dream about flying",
    "agent": "lantern",
    "provider": "anthropic"
  }'
```

**Response (SSE):**
```
data: {"type":"start","agent":"Lantern"}
data: {"type":"text","content":"Your dream of flying..."}
data: {"type":"end","citations":[]}
```

#### GET `/api/dreams`
Retrieve recent dream entries with tags.

**Query Parameters:**
- `limit` (default: 10) - Number of recent dreams
- `agent` (optional) - Filter by agent ID
- `tags` (optional) - Filter by tags (comma-separated)

**Response:**
```json
{
  "dreams": [
    {
      "id": "dream-2026-06-15-001",
      "timestamp": "2026-06-15T10:30:00Z",
      "text": "I was in a garden...",
      "agent": "lantern",
      "tags": ["nature", "peace"],
      "csfMemory": true
    }
  ]
}
```

---

### Token Audit API

**LLM usage tracking and cost analysis**

#### GET `/api/token-audit/stats`
Overall token usage statistics.

**Response:**
```json
{
  "totalRequests": 1250,
  "totalTokens": 125000,
  "totalCost": 1.85,
  "byProvider": {
    "anthropic": {
      "requests": 800,
      "tokens": 80000,
      "cost": 1.20
    },
    "openai": {
      "requests": 450,
      "tokens": 45000,
      "cost": 0.65
    }
  },
  "byAgent": {
    "lantern": { "requests": 500, "tokens": 50000, "cost": 0.75 },
    "keystone": { "requests": 750, "tokens": 75000, "cost": 1.10 }
  }
}
```

#### GET `/api/token-audit/daily`
Daily summary of token usage.

**Response:**
```json
{
  "daily": [
    {
      "date": "2026-06-14",
      "requests": 250,
      "tokens": 25000,
      "cost": 0.375
    },
    {
      "date": "2026-06-15",
      "requests": 200,
      "tokens": 20000,
      "cost": 0.300
    }
  ]
}
```

#### GET `/api/token-audit/provider/{name}`
Provider-specific statistics (e.g., `anthropic`, `openai`).

---

### Trading API

**Kalshi market data, orders, and signals**

#### GET `/api/trading/positions`
Current portfolio and open positions.

**Response:**
```json
{
  "account": {
    "cash": 5000.00,
    "totalValue": 12500.00,
    "buyingPower": 8500.00
  },
  "positions": [
    {
      "ticker": "TSLA",
      "shares": 10,
      "avgPrice": 250.00,
      "currentPrice": 265.00,
      "gain": 150.00
    }
  ]
}
```

#### POST `/api/trading/order`
Place a market or limit order.

**Request:**
```json
{
  "ticker": "AAPL",
  "side": "buy",
  "action": "limit",
  "count": 5,
  "limitCents": 17500
}
```

**Response (201 Created):**
```json
{
  "orderId": "order-123456",
  "ticker": "AAPL",
  "side": "buy",
  "status": "filled",
  "filledPrice": 175.00,
  "cost": 875.00
}
```

#### GET `/api/trading/signals`
AI trading signals and recommendations.

**Query Parameters:**
- `limit` (default: 5) - Number of recent signals

---

### Creator Dashboard API

**Content creation and analytics**

#### GET `/api/creator/entries`
List creator entries (videos, shorts, posts).

**Query Parameters:**
- `page` (default: 1) - Pagination
- `limit` (default: 20) - Items per page
- `type` (optional) - Filter by `video`, `short`, `post`

**Response:**
```json
{
  "entries": [
    {
      "id": "entry-001",
      "title": "Trading Psychology Guide",
      "type": "video",
      "createdAt": "2026-06-15T09:00:00Z",
      "views": 1250,
      "engagement": 0.85,
      "status": "published"
    }
  ],
  "pagination": {
    "page": 1,
    "total": 45,
    "pages": 3
  }
}
```

#### POST `/api/creator/entries`
Create a new content entry.

**Request:**
```json
{
  "title": "Market Breakdown",
  "type": "short",
  "description": "Daily market analysis",
  "content": "..."
}
```

---

### Three-Doors Kingdome API

**Infinitely replayable game with archetype personalization**

#### POST `/api/three-doors/start`
Initialize a new game session.

**Response:**
```json
{
  "gameId": "game-2026-06-15-001",
  "userId": "user-123",
  "stage": 1,
  "scene": "Welcome to the Kingdome of Hearts",
  "doors": [
    {
      "id": "A",
      "name": "The Path",
      "description": "A well-worn trail through mist"
    },
    {
      "id": "B",
      "name": "The Threshold",
      "description": "A shimmering gateway"
    },
    {
      "id": "C",
      "name": "The Unknown",
      "description": "Darkness beckoning"
    }
  ]
}
```

#### POST `/api/three-doors/choose`
Make a choice in the game.

**Request:**
```json
{
  "gameId": "game-2026-06-15-001",
  "choice": "A"
}
```

**Response:**
```json
{
  "stage": 2,
  "text": "You follow the path...",
  "doors": [...],
  "convergenceScore": 65
}
```

#### GET `/api/three-doors/convergence`
Game convergence metrics and improvement suggestions.

---

## Error Handling

All endpoints return errors in standard format:

```json
{
  "error": "invalid_request",
  "message": "Missing required field: message",
  "status": 400
}
```

**Common Status Codes:**
- `200 OK` - Success
- `201 Created` - Resource created
- `400 Bad Request` - Invalid request
- `402 Payment Required` - Insufficient trading cash
- `429 Too Many Requests` - Rate limited (auto-retries with backoff)
- `500 Internal Server Error` - Server error

---

## Rate Limiting

- **Standard endpoints:** 100 requests/minute
- **Streaming endpoints:** 10 concurrent connections
- **Trading endpoints:** 50 requests/minute (Kalshi limit)

Rate limit info in response headers:
```
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1687000000
Retry-After: 30 (if rate limited)
```

---

## Authentication

Use environment variables at startup:

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
KALSHI_API_KEY=...
```

No API key header needed for local endpoints; credentials passed via env.

---

## Examples

### Complete Dream Chat Flow

```bash
# 1. Stream dream response
curl -X POST http://localhost:4177/api/dream/stream \
  -H "Content-Type: application/json" \
  -d '{"message":"Tell me about convergence","agent":"keystone"}'

# 2. Check token usage
curl http://localhost:4177/api/token-audit/stats

# 3. View dream history
curl http://localhost:4177/api/dreams?limit=5

# 4. Play Three-Doors game
curl -X POST http://localhost:4177/api/three-doors/start
```

---

## Related Documentation

- [Architecture Overview](./ARCHITECTURE.md)
- [Convergence Workflow](./COMET-LEAP-1.5-CONVERGENCE-WORKFLOW.md)
- [Security Considerations](../SECURITY.md)
- [Development Guide](../QUICKSTART.md)
