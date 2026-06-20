# Lantern OS: 3 Key Items — Scope & Priority

**Date**: 2026-06-14  
**Status**: Tier 1 COMPLETE ✅ | Tier 2 Ready to Start  
**Approach**: Sequential priority-based execution with convergence routing

**Tier 1 Completion Summary (2026-06-14 Evening)**:
- ✅ **P2 FIXED**: Trading API endpoints added (/api/trading/ai-trader/watchlist, /zones)
- ✅ **P1 ADDED**: Trader persona + keyword routing (market/trade/signal/P&L/zones)
- ✅ **P3 ADDED**: Trade history logging (data/trading/trades.jsonl, signals.jsonl) + API endpoints
- ✅ **Chat ↔ Trading Integration**: Now possible via /api/trading/history/* endpoints
- **Unblocked**: P4-P7 (dashboard features), CREATOR MVP design

---

## Overview

Lantern OS has 3 core pillars:
1. **CHAT** — Conversational dream journal + agent personas
2. **TRADE** — Autonomous portfolio management + signal generation
3. **CREATOR** — Content creation, management, publishing

This document locks in scope for each, identifies blockers, and defines priority work.

---

## 1. CHAT (Dream Journal + Agent Routing)

### Current State
- ✅ 6 personas implemented (Lantern, Blinkbug, Keystone, Waterfall, Xenon, Founder)
- ✅ Keystone enhanced with Σ₀ framework + tool access
- ⚠️ Missing: Integration with trading system (Dream Chat ↔ Trade API)
- ⚠️ Missing: Memory persistence across sessions

### Priority Work

#### P1: Dream Chat Trading Agent Persona [NEXT]
**Issue**: Users can't query trading status from chat  
**Blockers**: P2 (Trading API 404 errors)  
**Work**:
- Add 7th persona: "Trader" (responds to market/trading keywords)
- Persona queries: `/api/trading/zones`, `/api/trading/ai-trader/signals`
- Interpret commands: "close BTCUSD", "what's my P&L", "show active zones"
- Effort: 2-3 hours (Medium)
- Status: BLOCKED until P2 fixed

#### P3: Trade History Persistence [AFTER P2]
**Issue**: Trading events not logged, can't reference history in chat  
**Files to create**:
- `data/trading/trades.jsonl` (entry, exit, P&L per trade)
- `data/trading/signals.jsonl` (all generated signals)
**Acceptance**: Chat can reference "what happened in trading"  
**Effort**: 2 hours (Low)

#### Future: Session Memory
- Persist conversation threads across sessions
- Search past dreams by symbol/emotion/archetype
- Integrate with CSF memory system

### KPIs
- Users can chat about trading naturally ✓
- Chat references trade history ✓
- Multiple personas available for different moods/needs ✓

---

## 2. TRADE (Quantitative Trading System)

### Current State
- ✅ Regime detector (TREND/MEAN/PIVOT/Shock/Liquidity)
- ✅ AI Trader backend (agents.py)
- ✅ Phase A logging (strategy-performance.jsonl)
- ✅ Phase C MVP (display fitness on cards)
- ✅ Tier 2 complete (#405, #425, #426)
- ❌ **CRITICAL**: API routes returning 404
- ❌ Dashboard not seeing live portfolio data

### Critical Blocker: P2 — Fix Trading API 404 Errors

**Affected Endpoints**:
```
❌ /api/trading/ai-trader/watchlist → 404
❌ /api/trading/ai-trader/zones → 404
❌ /api/trading/ai-trader/status → 404
❌ /api/trading/dashboard/zones → 404
```

**Root Cause**: Routes defined in trading.js but returning 404  
**Investigation Needed**:
- Check if TraderAgent initializing correctly
- Verify HTTP method matching (GET vs POST)
- Check request routing in server.js
- Confirm TradingAPIBridge connecting to AI Trader

**Work**:
1. Test each endpoint individually
2. Add debug logging to identify fail point
3. Fix routing or bridge integration
4. Verify all endpoints return 200 with valid data
5. Effort: 3-4 hours (High priority)

### Priority Work (After P2 Fixed)

#### P4: Enhanced Trading Dashboard UI [AFTER P2]
- Dark mode + responsive layout
- Color-coded P&L visualization
- Animated market status
- Effort: 3-4 hours

#### P5: Alerts & Notifications [AFTER P2]
- Position P&L thresholds (>5%)
- Stop loss / take profit hits
- Signal quality alerts (>85% confidence)
- Effort: 3 hours

#### P6: Real-Time Position Monitor
- WebSocket/SSE for live updates
- Price animation on entry → current
- Effort: 3-4 hours

#### P7: Trading Statistics Dashboard
- Win rate, Sharpe ratio, max drawdown
- Per-strategy performance
- Effort: 2-3 hours

### KPIs
- All trading APIs return 200 ✓
- Dashboard shows live portfolio ✓
- Regime detection accuracy > 70% ✓
- Signal generation < 500ms ✓
- C7 gate blocks <20% of signals (normal) ✓

---

## 3. CREATOR (Content Creation Tools)

### Current State
- ⚠️ **NOT DEFINED** — No current implementation
- Reference: `/create.html` mentioned in index but not built

### What This Should Be

A tool for users to:
1. **Create** media (dreams, articles, videos)
2. **Organize** collections (notebooks, galleries)
3. **Share** publicly (with permissioning)
4. **Export** as CSF/archive format

### Proposed Features

#### Core (MVP)
- Dream + notes capture (already have)
- Tag / organize by archetype, symbol, mood
- Export as Markdown + JSON
- Effort: 5 hours

#### Phase 2
- Image upload + gallery
- Collaborative dreaming (share with friends)
- Public profile / portfolio
- Effort: 8 hours

#### Phase 3
- Video clips from dream descriptions
- AI illustration generation
- Newsletter builder
- Effort: 10+ hours

### KPIs
- Users can save + export dreams ✓
- Multiple content types supported ✓
- Shareable public links ✓
- CSF-native archival ✓

---

## Priority Order (By Convergence Routing)

### TIER 1 (This Week)
1. **P2**: Fix Trading API 404 errors [BLOCKER] — 3-4 hours
   - Unblocks P1, P4, P5, P6, P7
   - Highest impact: enables dashboard

2. **P1**: Dream Chat Trading Agent Persona — 2-3 hours
   - Depends on P2 fixed
   - Natural language interface to trading

3. **P3**: Trade History Persistence — 2 hours
   - Enables chat memory references
   - Low effort, high value

### TIER 2 (Next Week)
4. **P4**: Enhanced Dashboard UI — 3-4 hours
5. **P5**: Alerts & Notifications — 3 hours
6. **CREATOR MVP** — 5 hours (proposal first)

### TIER 3 (Future)
7. **P6**: Real-Time Monitor — 3-4 hours
8. **P7**: Statistics Dashboard — 2-3 hours
9. **CREATOR Phase 2** — 8 hours
10. P8-P13 (advanced trading features)

---

## Convergence Routing Decision

**Current bottleneck**: P2 (Trading API 404)  
**Strategy**: Fix P2 first (unlocks 5 downstream issues)  

**Token efficiency**:
- P2 fix: High ROI (1 fix = 5 unblocked)
- P1 after: Depends on P2, natural follow-up
- P3 after: Requires P1 working, completes chat loop

**Recommendation**: Work P2 → P1 → P3 sequentially this session

---

## Scope Lock

This document represents locked scope for:
- ✅ Which features matter (3 key items)
- ✅ What's blocked and why
- ✅ Priority order (convergence-optimized)
- ✅ Effort estimates
- ✅ KPIs for success

**Not in scope** (for now):
- Advanced ML signal fusion (P13)
- Multi-broker support (P12)
- Backtesting framework (P8)
- Creator Phase 2+ (post-MVP)

**Next step**: Investigate P2 (Trading API 404), fix root cause.

---

**Owner**: Claude (Keystone)  
**Last Updated**: 2026-06-14T21:40:00Z
