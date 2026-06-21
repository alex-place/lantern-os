---
author: Alex Place
created: 2026-06-11
updated: 2026-06-20
---

# Phase 2 Progress: Integrated Trader Capability

**Status:** Phase 2a Complete (UI & Wrapper Framework)  
**Branch:** `integrate-interactive-trader`  
**Date:** 2026-06-12 01:45 UTC

---

## ✅ Completed (Phase 2a)

### 1. Trader Dashboard UI
- **File:** `apps/lantern-garage/public/trader-dashboard.html` ✅
- **Status:** Extracted from AI Trader dashboard.py
- **Features:**
  - 3-panel layout (sidebar watchlist, main ticker cards, footer panels)
  - Zone ladder visualization (pure CSS/HTML, zero dependencies)
  - Real-time data updates (30s refresh for zones, 5s for logs, 60s for orders)
  - Market status, P&L display, agent log, recent orders
  - Full responsive design with dark theme

### 2. Trader Agent Wrapper
- **File:** `apps/lantern-garage/lib/trader-agent.js` ✅
- **Status:** Core framework complete
- **API Surface:**
  - `scanMarket()` — Market-wide signal generation + zones
  - `getZones(ticker)` — Support/resistance analysis
  - `analyzeSignal(signal)` — Enrich signal with ticker extraction
  - `getMarketStatus()` — VIX, SPY trend, market hours
  - `getWatchlistPrices()` — Live prices for monitored tickers
  - `getPositions()` — Open positions from Alpaca
  - `getBars(ticker, timeframe)` — OHLCV data
  - Automatic caching (30-60s per endpoint)
  - 30s Python process timeout with graceful fallback

### 3. Analysis & Architecture
- **File:** `docs/TRADER-PHASE2-INTEGRATED.md` ✅
- **File:** `docs/TRADER-PHASE2-PROGRESS.md` (this file) ✅

---

## ⏳ Remaining (Phase 2b-2d)

### Phase 2b: Python CLI Wrapper (Day 2)

**Critical:** Create `src/trading_agents/cli.py` to bridge Node.js → Python

This module will be spawned by `trader-agent.js` to execute trading logic:

```python
# src/trading_agents/cli.py
#!/usr/bin/env python3
import sys, json, os
from agents import scan_all, get_zones, get_portfolio_equity, ...

def main():
    action = sys.argv[1]  # e.g., 'scan_market', 'get_zones'
    args = json.loads(sys.argv[2])  # e.g., {"watchlist": ["SPY", "AAPL"]}
    
    if action == 'scan_market':
        result = scan_all(args['watchlist'])
        print(json.dumps({"signals": [...], "zones": {...}}))
    elif action == 'get_zones':
        result = get_zones(args['ticker'])
        print(json.dumps(result))
    # ... etc
```

**Status:** NOT STARTED
**Effort:** 4-6 hours (depends on agents.py complexity)

### Phase 2c: Update Trading Routes (Day 2)

**Critical:** Refactor `apps/lantern-garage/routes/trading.js` to use trader-agent

Current routes call external AI Trader service (port 5050/5555).
Need to update to call `trader-agent.js` instead:

```javascript
// routes/trading.js (MODIFY)
const TraderAgent = require('../lib/trader-agent');
const traderAgent = new TraderAgent({
  cacheExpiry: 60000,
  pythonTimeout: 30000
});

// GET /api/trading/zones
if (url.pathname === '/api/trading/zones' && req.method === 'GET') {
  try {
    const scan = await traderAgent.scanMarket();
    sendJson(res, { zones: scan.zones }, 200);
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
  return true;
}

// GET /api/trading/watchlist-prices
if (url.pathname === '/api/trading/watchlist-prices' && req.method === 'GET') {
  try {
    const prices = await traderAgent.getWatchlistPrices();
    sendJson(res, prices, 200);
  } catch (error) {
    sendJson(res, [], 500);
  }
  return true;
}

// ... similar for /positions, /market-status, /agent-log, /orders
```

**Status:** NOT STARTED
**Effort:** 2-3 hours (mechanical refactor)

### Phase 2d: Wiring & Testing (Day 2-3)

**Critical:** Connect everything and validate

```bash
# 1. Copy Python trading logic
cp -r /d/ai-trader-new/ai\ trader/agents.py src/trading_agents/
cp -r /d/ai-trader-new/ai\ trader/price_watcher.py src/trading_agents/

# 2. Create src/trading_agents/requirements.txt
alpaca-trade-api
pytz
apscheduler

# 3. Update .env
ALPACA_API_KEY=pk_...
ALPACA_SECRET_KEY=...
TRADER_WATCHLIST=["SPY","AAPL","TSLA","NVDA","AMD"]

# 4. Start dev server
npm run dev --prefix apps/lantern-garage

# 5. Test endpoints
curl http://127.0.0.1:4177/api/trading/zones
curl http://127.0.0.1:4177/api/trading/watchlist-prices
curl http://127.0.0.1:4177/api/trading/positions
curl http://127.0.0.1:4177/api/trading/market-status

# 6. Open dashboard
http://127.0.0.1:4177/trader-dashboard.html
```

**Status:** NOT STARTED
**Effort:** 2-3 hours (testing, debugging, integration)

---

## API Routes Status

### ✅ Already Implemented (via trading.js)
- `/api/trading/dashboard/positions` (proxy to AI Trader)
- `/api/trading/dashboard/market-status` (proxy to AI Trader)
- `/api/trading/dashboard/zones` (proxy to AI Trader)
- `/api/trading/dashboard/watchlist-prices` (proxy to AI Trader)
- `/api/trading/dashboard/agent-log` (proxy to AI Trader)
- `/api/trading/dashboard/orders` (proxy to AI Trader)
- `/api/trading/csf-records` (local CSF memory query)
- `/api/trading/settings` (API key config)

### ⏳ Need to Add/Refactor for Integrated Approach
- `/api/trading/zones` → Call `traderAgent.scanMarket()`
- `/api/trading/watchlist-prices` → Call `traderAgent.getWatchlistPrices()`
- `/api/trading/positions` → Call `traderAgent.getPositions()`
- `/api/trading/market-status` → Call `traderAgent.getMarketStatus()`
- `/api/trading/agent-log` → Store locally + CSF (from trading-memory.js)
- `/api/trading/orders` → Store locally + CSF (from trading-memory.js)

---

## Dashboard HTML API Calls

The trader-dashboard.html expects these endpoints:

```javascript
// Called on load + every 30s
fetch('/api/trading/zones')
fetch('/api/trading/watchlist-prices')
fetch('/api/trading/positions')
fetch('/api/trading/market-status')

// Called every 5s
fetch('/api/trading/agent-log')

// Called every 60s
fetch('/api/trading/orders')
```

**Response shapes required:**

```javascript
// /api/trading/zones
{ zones: { AAPL: { mid, top, bottom, type, strength, touches, ... }, ... } }

// /api/trading/watchlist-prices
[{ ticker, price, chg_pct, is_crypto }, ...]

// /api/trading/positions
{ positions: [...], account: { equity, cash, buying_power, pnl_today } }

// /api/trading/market-status
{ vix, vix_regime, market, spy_1d, spy_5d, day_pnl_pct, market_open }

// /api/trading/agent-log
[{ time, type, agent, body }, ...]

// /api/trading/orders
[{ id, symbol, side, qty, type, status, filled_at, filled_avg }, ...]
```

---

## Next Steps (When Ready)

1. **Copy Python files**
   ```bash
   cp C:\Users\alexp\Downloads\ai-trader-new\ai\ trader\agents.py src/trading_agents/
   cp C:\Users\alexp\Downloads\ai-trader-new\ai\ trader\price_watcher.py src/trading_agents/
   ```

2. **Create Python CLI wrapper**
   - `src/trading_agents/cli.py` (4-6 hours)
   - Bridge Node.js subprocess calls to Python functions

3. **Refactor trading routes**
   - Update `apps/lantern-garage/routes/trading.js` (2-3 hours)
   - Use `TraderAgent` instead of external service calls

4. **Wire configuration**
   - Add to `.env`: ALPACA_API_KEY, ALPACA_SECRET_KEY, TRADER_WATCHLIST

5. **Test end-to-end**
   - Start dev server
   - Open `/trader-dashboard.html`
   - Verify real-time data flow
   - Check CSF memory writes (via PR #338)

---

## Architectural Status

| Component | Status | Location |
|-----------|--------|----------|
| **UI Dashboard** | ✅ Complete | `public/trader-dashboard.html` |
| **Node Wrapper** | ✅ Framework complete | `lib/trader-agent.js` |
| **Python CLI** | ⏳ Not started | `src/trading_agents/cli.py` |
| **Routes** | ⏳ Refactor needed | `routes/trading.js` |
| **Integration** | ⏳ Pending | All of above + testing |

---

## Key Decisions Made

✅ **Single app structure** — One Lantern process, no external ports  
✅ **Python as subprocess** — agents.py logic called on-demand  
✅ **Local caching** — 30-60s TTL per endpoint  
✅ **Graceful fallback** — Empty/error responses if Python fails  
✅ **CSF integration** — Orders/signals flow to memory (via PR #338)  
✅ **Configuration** — .env for Alpaca keys + watchlist  

---

## Effort Summary

| Phase | Task | Hours | Status |
|-------|------|-------|--------|
| 2a | UI + wrapper framework | 3 | ✅ Done |
| 2b | Python CLI module | 4-6 | ⏳ Pending |
| 2c | Route refactoring | 2-3 | ⏳ Pending |
| 2d | Testing + integration | 2-3 | ⏳ Pending |
| **Total** | | **11-15** | **3 hours complete** |

---

## Risk Mitigation

**Risk:** agents.py is 400KB and complex
- **Mitigation:** Wrap specific functions only (scan_all, get_zones, etc.), don't refactor

**Risk:** Python subprocess hangs
- **Mitigation:** 30s timeout, graceful fallback to error responses

**Risk:** Alpaca API unavailable
- **Mitigation:** Cache responses, return last-known state

**Risk:** CSF memory writes fail
- **Mitigation:** Orders still stored locally, CSF write is best-effort

---

**Ready to proceed to Phase 2b when confirmed.**

*Generated by Claude Code | 2026-06-12 01:45 UTC*
