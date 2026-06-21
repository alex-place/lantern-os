---
author: Alex Place
created: 2026-06-11
updated: 2026-06-20
---

# Phase 2: Integrate Trader as Native Lantern Capability

**Status:** In Progress  
**Branch:** `integrate-interactive-trader`  
**Approach:** Integrated (not bounded service)  
**Updated:** 2026-06-12

---

## Strategic Shift

**Old approach:** Bounded service (`services/ai-trader/` on port 5001)
- Separate process, separate management
- "Lantern + Trader" = two apps

**New approach:** Integrated capability (within Lantern)
- Single Node.js process (4177/4178)
- Single dashboard, single memory model
- "Keystone OS IS the cockpit" — trader is just another capability

---

## Target Architecture

```
lantern-os/
├── apps/lantern-garage/
│   ├── public/
│   │   ├── dream-chat.html              (existing)
│   │   ├── trader-dashboard.html        (NEW — tab #2)
│   │   └── css/trader-ui.css            (NEW)
│   │
│   ├── lib/
│   │   ├── dream-chat.js                (existing)
│   │   ├── trader-agent.js              (NEW — Node wrapper for Python logic)
│   │   ├── trading-memory.js            (existing from PR #338)
│   │   ├── csf-memory-writer.js         (existing from PR #338)
│   │   └── status.js                    (existing)
│   │
│   └── routes/
│       ├── dream.js                     (existing)
│       ├── trading.js                   (existing from PR #338 + enhancements)
│       └── [no new external ports]
│
├── src/
│   ├── trading_agents/                  (NEW — Python trading logic)
│   │   ├── agents.py                    (copy from AI Trader, minimal refactor)
│   │   ├── signal_analyzer.py           (extracted trading logic)
│   │   ├── zone_detector.py             (extracted trading logic)
│   │   └── requirements.txt             (trading-specific deps)
│   │
│   ├── mcp_server/                      (existing)
│   └── discord_lounge_bot/              (existing)
│
└── data/
    ├── trading/                         (NEW — local trading state)
    │   ├── orders.jsonl                 (persisted orders)
    │   ├── signals.jsonl                (persisted signals)
    │   └── watchlist.json               (trading watchlist)
    │
    └── csf_memory/                      (existing, receives orders/signals via PR #338)
        └── [trading records auto-written by lib/trading-memory.js]
```

---

## Data Flow (Single App Model)

```
Lantern Server (single process, port 4177/4178)
│
├── Dream Journal Route
│   └── Dream Chat → CSF Memory (dreams, conversations)
│
├── Trader Route
│   ├── GET /api/trading/status      → trader-agent.js → Python agent → returns signals
│   ├── GET /api/trading/positions   → Alpaca API (via Python agent)
│   ├── GET /api/trading/orders      → local trading/ store
│   ├── POST /api/trading/orders     → local store → CSF Memory (via trading-memory.js)
│   └── GET /api/trading/memory      → CSF Memory query (from PR #338)
│
└── Shared Infrastructure
    ├── CSF Memory (trading-memory.js writes orders/signals)
    ├── Status endpoint (includes trading status)
    └── .env (Alpaca keys, shared config)
```

---

## Phase 2 Implementation Plan

### 2a. Create UI Layer (Day 1)

**Goal:** Trader dashboard integrated into Lantern

#### Step 1: Port HTML/CSS from AI Trader
```
Source: dashboard.py (1800 lines, includes inline HTML)
Target: apps/lantern-garage/public/trader-dashboard.html
        apps/lantern-garage/public/css/trader-ui.css
```

**What to extract:**
- Main dashboard layout
- Chart rendering logic (SVG/Canvas)
- Real-time update logic (fetch API calls)
- News feed widget (optional for MVP)

**What to skip (for MVP):**
- Telegram bot integration (handled separately)
- Historical backtest UI (advanced feature)

#### Step 2: Wire Trader Tab into Navbar
```javascript
// apps/lantern-garage/public/index.html or nav component
<nav class="site-nav">
  <a href="/dream-chat.html">Journal</a>
  <a href="/trader-dashboard.html">Trader</a>  {/* NEW */}
  <a href="/status.html">Status</a>
</nav>
```

#### Step 3: Create Client-side API Wrapper
```javascript
// apps/lantern-garage/public/js/trader-client.js (NEW)
class TraderClient {
  async getStatus() { /* GET /api/trading/status */ }
  async getPositions() { /* GET /api/trading/positions */ }
  async getSignals(limit) { /* GET /api/trading/signals */ }
  async getWatchlist() { /* GET /api/trading/watchlist */ }
  async getMarketStatus() { /* GET /api/trading/market-status */ }
  async getBars(ticker, timeframe) { /* GET /api/trading/bars/:ticker */ }
  async getNews(symbols) { /* GET /api/trading/news */ }
}
```

---

### 2b. Create Python Agent Wrapper (Day 1-2)

**Goal:** Node.js wrapper for Python trading agents (keep agents.py as-is)

#### Step 1: Copy & Organize Python Code
```
FROM: C:\Users\alexp\Downloads\ai-trader-new\ai trader\
TO:   src/trading_agents/

Files to copy:
  agents.py              → src/trading_agents/agents.py
  price_watcher.py       → src/trading_agents/price_watcher.py
  (skip: main.py, dashboard.py, telegram_bot.py for now)
```

#### Step 2: Create Node Wrapper (`trader-agent.js`)
```javascript
// apps/lantern-garage/lib/trader-agent.js (NEW)

const { spawn } = require('child_process');
const path = require('path');

class TraderAgent {
  constructor(config) {
    this.config = config;  // Alpaca keys, watchlist, etc.
    this.pythonPath = path.join(__dirname, '../../src/trading_agents');
    this.cache = {};
    this.cacheExpiry = 60000; // 60s
  }

  async scanMarket(watchlist) {
    /**
     * Calls Python agents.scan_all(watchlist)
     * Returns: { signals: [...], zones: {...}, metadata: {...} }
     * 
     * Flow:
     *  1. Spawn: python -m trading_agents.agents scan [symbols]
     *  2. Parse JSON output
     *  3. Cache for 60s
     *  4. Return to caller
     */
  }

  async getZones(ticker) {
    /**
     * Market analysis for a single ticker
     * Returns: { support, resistance, trend, volatility }
     */
  }

  async analyzeSignal(signal) {
    /**
     * Enrich a signal with ticker extraction, confidence scoring
     * Returns: { symbol, action, reason, confidence, timestamp }
     */
  }

  _callPython(action, args) {
    /**
     * Generic wrapper for spawning Python child process
     * - Timeout: 30s (prevent hanging)
     * - Error handling: graceful fallback
     * - Logging: all calls logged
     */
  }
}

module.exports = TraderAgent;
```

#### Step 3: Integrate into Lantern Server
```javascript
// apps/lantern-garage/server.js (MODIFY)

const TraderAgent = require('./lib/trader-agent');

// Initialize trader agent
const traderAgent = new TraderAgent({
  alpaca_key: process.env.ALPACA_API_KEY,
  alpaca_secret: process.env.ALPACA_SECRET_KEY,
  watchlist: JSON.parse(process.env.TRADER_WATCHLIST || '["SPY","AAPL"]')
});

// Store in shared state
sharedState.traderAgent = traderAgent;
```

---

### 2c. Wire Trading Routes (Day 2)

**Goal:** Expose trader endpoints through Lantern's REST API

#### Step 1: Enhance `/api/trading/` Routes
```javascript
// apps/lantern-garage/routes/trading.js (ENHANCE)

// Existing routes from PR #338:
//  GET /api/trading/dashboard/orders
//  GET /api/trading/dashboard/agent-log
//  POST /api/trading/orders
//  POST /api/trading/agent-log
//  GET /api/trading/memory/recent

// NEW routes (this phase):
router.get('/api/trading/status', async (req, res) => {
  // Call traderAgent.scanMarket()
  // Return: { market_open, equity, positions, signals_count, timestamp }
});

router.get('/api/trading/positions', async (req, res) => {
  // Get from Alpaca via trader agent
  // Return: { positions: [...], account: {...} }
});

router.get('/api/trading/watchlist', async (req, res) => {
  // Get configured watchlist + current prices
  // Return: { watchlist: [...], prices: {...} }
});

router.get('/api/trading/signals', async (req, res) => {
  // Get recent signals from trader agent
  // Return: { signals: [...], limit, offset }
});

router.get('/api/trading/zones', async (req, res) => {
  // Get market zones (support/resistance per ticker)
  // Return: { zones: { AAPL: {...}, TSLA: {...}, ... } }
});

router.get('/api/trading/bars/:ticker', async (req, res) => {
  // Get OHLCV bars (1m, 5m, 15m, 1h, 4h, 1d)
  // Return: { bars: [...], ticker, timeframe, count }
});
```

#### Step 2: Ensure Orders → CSF Memory
```javascript
// apps/lantern-garage/routes/trading.js (WIRE-UP)

router.post('/api/trading/orders', async (req, res) => {
  const { orders } = req.body;
  
  // Step 1: Save to local store
  await tradingStore.saveOrders(orders);
  
  // Step 2: Write to CSF memory (via trading-memory.js)
  await recordNewOrders(orders);  // from lib/trading-memory.js
  
  // Step 3: Return confirmation
  res.json({ success: true, count: orders.length });
});
```

---

### 2d. Wiring & Testing (Day 2-3)

#### Step 1: Create Integration Test
```javascript
// tests/test_trading_integration.js (NEW)

describe('Trader Integration', () => {
  test('Dashboard can reach /api/trading/status', async () => {
    const res = await fetch('http://localhost:4177/api/trading/status');
    assert(res.ok);
    const data = await res.json();
    assert(data.market_open !== undefined);
  });

  test('Orders posted to /api/trading/orders flow to CSF memory', async () => {
    const order = { id: 'test-123', symbol: 'AAPL', qty: 10, price: 150 };
    const res = await fetch('http://localhost:4177/api/trading/orders', {
      method: 'POST',
      body: JSON.stringify({ orders: [order] })
    });
    assert(res.ok);
    
    // Check CSF memory has it
    const memory = await fetch('http://localhost:4177/api/trading/memory/recent');
    const { records } = await memory.json();
    assert(records.some(r => r.id === 'test-123'));
  });

  test('Dream Journal can query trader memory', async () => {
    // Test: dream-chat asks "what happened with AAPL today?"
    // Should hit /api/trading/memory/recent, get orders from CSF
  });
});
```

#### Step 2: Smoke Test
```bash
# Start dev server
npm run dev --prefix apps/lantern-garage

# Test endpoints
curl http://127.0.0.1:4177/api/trading/status
curl http://127.0.0.1:4177/api/trading/positions
curl http://127.0.0.1:4177/api/trading/watchlist

# Check Alpaca connection
curl http://127.0.0.1:4177/api/trading/market-status
```

#### Step 3: UI Test
- Open `http://127.0.0.1:4177/trader-dashboard.html`
- Verify:
  - Dashboard loads
  - Real-time data updates
  - Charts render
  - No console errors

---

## Files to Create/Modify

### NEW Files
```
apps/lantern-garage/public/trader-dashboard.html          (+800 lines)
apps/lantern-garage/public/css/trader-ui.css              (+300 lines)
apps/lantern-garage/public/js/trader-client.js            (+150 lines)
apps/lantern-garage/lib/trader-agent.js                   (+250 lines)
apps/lantern-garage/routes/trading-routes.js              (+400 lines, if separate file)
src/trading_agents/agents.py                              (copy, ~400KB)
src/trading_agents/__init__.py                            (+10 lines)
src/trading_agents/requirements.txt                       (+20 lines)
data/trading/.gitkeep                                     (directory marker)
tests/test_trading_integration.js                         (+200 lines)
```

### MODIFIED Files
```
apps/lantern-garage/server.js                             (+30 lines, init trader agent)
apps/lantern-garage/routes/trading.js                     (+200 lines, new endpoints)
apps/lanterns-garage/public/index.html or nav             (+2 lines, nav link)
.env.example                                              (+3 lines, TRADER_WATCHLIST, etc.)
package.json                                              (no new deps needed)
```

---

## Configuration

Add to `.env`:
```bash
# Trading
ALPACA_API_KEY=pk_...
ALPACA_SECRET_KEY=...
ALPACA_ENV=paper                    # or 'live'
TRADER_ENABLED=true
TRADER_WATCHLIST=["SPY","AAPL","TSLA","NVDA","AMD"]
TRADER_SCAN_INTERVAL=300            # 5 minutes
TRADER_PYTHON_TIMEOUT=30000         # 30 seconds
```

---

## Success Criteria

- [x] Trader dashboard loads at `/trader-dashboard.html`
- [ ] `/api/trading/status` returns market data
- [ ] `/api/trading/positions` shows open positions
- [ ] `/api/trading/signals` returns recent signals
- [ ] Orders posted to `/api/trading/orders` → CSF memory (via PR #338)
- [ ] Dream Journal can query trading memory via `/api/trading/memory/recent`
- [ ] Single Node process (4177/4178) — no external ports
- [ ] All tests passing
- [ ] No console errors in browser

---

## Effort Breakdown

| Task | Hours | Notes |
|------|-------|-------|
| Port HTML/CSS | 2-3 | Extract from dashboard.py |
| Create trader-agent.js wrapper | 3-4 | Python subprocess bridge |
| Wire routes + integration | 2-3 | Connect everything |
| Testing + docs | 2-3 | Unit + integration tests |
| **Total** | **9-13** | 2-3 days solo |

---

## Risk Mitigation

**Risk:** Python agent spawn hangs
- **Mitigation:** 30s timeout, graceful error handling, fallback to cached data

**Risk:** Alpaca API failures
- **Mitigation:** Circuit breaker, return last-known state, log all errors

**Risk:** CSF memory writes fail
- **Mitigation:** Orders still stored locally, CSF write is best-effort

**Risk:** Memory leak from repeated Python spawns
- **Mitigation:** Proper cleanup in spawn, max-retry on failure, monitoring

---

## Next Steps (When Ready)

1. **Confirm structure** — Does this integrated approach feel right?
2. **Extract HTML/CSS** — Start with UI port from dashboard.py
3. **Build trader-agent.js** — Node wrapper for Python
4. **Wire routes** — Connect everything
5. **Test** — Smoke test + integration test
6. **Commit & PR** — Single-app integration complete

---

**Status:** Ready for Phase 2a (UI extraction)

*Generated by Claude Code | 2026-06-12*
