# Lantern OS Trading System Integration — Phase 1 Audit

**Audit Date:** 2026-06-10  
**Status:** Complete  
**Objective:** Evaluate feasibility of converting Lantern OS into a multi-agent trading orchestration layer while preserving existing dream journal functionality.

---

## Executive Summary

**Finding:** Lantern OS is **highly suitable** for trading system integration. The existing architecture provides:

- ✅ **Proven convergence loop** for multi-input decision-making
- ✅ **Agent persona system** with skill-based routing
- ✅ **CSF memory layer** for long-term pattern storage and retrieval
- ✅ **MCP server & tool registration** for agent tool discovery
- ✅ **Provider fallback chain** (10+ LLM providers with graceful degradation)
- ✅ **Streaming SSE infrastructure** for real-time decision feedback
- ✅ **PCSF safety frame** for capacity class labeling and risk boundary enforcement
- ✅ **Receipts and provenance** system ready for audit trail logging

**Risk Level:** Low-to-Medium  
**Estimated Integration Effort:** 4-6 weeks (design + implementation + testing)

---

## 1. Architecture Overview

### Current Lantern OS Layers

```
┌─────────────────────────────────────────────────────────────┐
│ Browser UI Layer                                            │
│ - Dream Journal (freeform chat)                             │
│ - Three Doors narrative engine                              │
│ - Status cubes visualization                                │
│ - Settings drawer (provider config)                         │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│ HTTP Router Layer (apps/lantern-garage/server.js)           │
│ - Static assets & PWA manifest                              │
│ - REST API routes (/api/dream, /api/convergence, etc.)     │
│ - SSE streaming handler (/api/dream/stream)                 │
│ - File serving with security boundaries                     │
│ - Environment variable loading                              │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│ Route Handlers (apps/lantern-garage/routes/*.js)            │
│ - dream.js         → LLM chat, door choices, convergence    │
│ - dreamer.js       → User notebook CRUD                     │
│ - status.js        → System readiness & health              │
│ - rag.js           → RAG document search                    │
│ - csf.js           → Memory archive operations              │
│ - cubes.js         → Status cube navigation                 │
│ - operator.js      → Operator notes & commands              │
│ - keystone.js      → Integration & pattern detection        │
│ - files.js         → Secure file serving                    │
│ - image.js         → Image generation (DALL-E, etc.)        │
│ - claims.js        → Evidence & claim mapping               │
│ - surfaces.js      → Public surface endpoints               │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│ Business Logic Layer (apps/lantern-garage/lib/*.js)         │
│ Core modules:                                               │
├─ dream-chat.js          → Agent selection, LLM routing      │
├─ stream-chat.js         → SSE streaming + context loading   │
├─ dreamer-store.js       → JSONL-based dream persistence    │
├─ csf-memory.js          → Memory tier injection             │
├─ conversation-store.js  → Chat log + RAG integration        │
├─ rag-house.js           → Flat document index builder       │
├─ convergence-os/        → Receipt generation                │
├─ mcp-bridge.js          → MCP server communication          │
├─ provider-cache.js      → Provider health & fallback        │
├─ status.js              → Health aggregation                │
├─ http-utils.js          → Security headers & boundaries     │
└─ pcsf-refresh.js        → Capacity class management         │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│ Data Persistence Layer                                      │
├─ data/dream_journal/*.jsonl         → User entries          │
├─ data/conversations/                → Chat history          │
├─ data/csf_memory/                   → Memory tiers          │
├─ data/pcsf/                         → Provider state        │
├─ data/rag-house/                    → Document index        │
└─ data/operator-notes/               → Free-form notes       │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│ External Services Layer                                     │
├─ LLM Providers (Anthropic, OpenAI, Gemini, Grok, Ollama)   │
├─ MCP Server (src/mcp_server/server.py @ port 8771)         │
├─ Convergence IO Engine (src/convergence_io_engine.py)      │
├─ Discord Bot (optional, src/discord_lounge_bot/bot.py)     │
├─ CSF Memory Engine (src/csf/memory_engine.py)              │
└─ Cloud Mirror (Railway deployment, CI/CD via GitHub)       │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Dependency Map

### Direct Dependencies

```
Node.js (v18+)
├─ http (built-in)
├─ https (built-in)
├─ fs (built-in)
├─ path (built-in)
├─ child_process (built-in)
└─ No NPM dependencies required for core server

Python (v3.10+)
├─ FastAPI (MCP server)
├─ httpx (async HTTP client)
├─ pydantic (data validation)
├─ discord.py (Discord bot, optional)
└─ Other: json, sys, os, pathlib, enum, dataclass, threading, subprocess
```

### External Dependencies

```
LLM Providers (no SDK required — HTTP clients)
├─ Anthropic (Claude)        → https://api.anthropic.com
├─ OpenAI (GPT)              → https://api.openai.com
├─ Google (Gemini)           → https://generativelanguage.googleapis.com
├─ xAI (Grok)                → https://api.x.ai
├─ Mistral                   → https://api.mistral.ai
├─ Cohere                    → https://api.cohere.com
├─ DeepSeek                  → https://api.deepseek.com
├─ Ollama (local)            → http://127.0.0.1:11434
└─ OpenRouter (gateway)      → https://openrouter.ai

Infrastructure
├─ GitHub (source control, Actions CI/CD)
├─ Railway (cloud deployment)
├─ Discord (optional bot integration)
├─ Google Drive (archive destination)
└─ Local filesystem (primary storage)
```

### Import Graph

```
server.js
├─ routes/* (all routed via deps bundle)
│  ├─ dream.js (LLM calls, agent selection)
│  ├─ status.js (health aggregation)
│  ├─ rag.js (RAG search)
│  ├─ csf.js (memory operations)
│  └─ [others]
└─ lib/*
   ├─ dream-chat.js (core agent routing + LLM call)
   ├─ stream-chat.js (SSE handler + context injection)
   ├─ dreamer-store.js (JSONL persistence)
   ├─ csf-memory.js (memory tier loading)
   ├─ conversation-store.js (chat log + RAG)
   ├─ mcp-bridge.js (MCP connector)
   ├─ provider-cache.js (fallback chain)
   ├─ status.js (health checks)
   └─ [convergence-os, qutrit, etc.]
```

---

## 3. Existing API Surface

### REST Endpoints (Categorized for Trading Adaptation)

#### 3.1 Status & Health (Foundation for Trading System Health)

```
GET /api/status
  Response: { readiness, models, git_version, agent_slots, pcsf_state, timestamp }
  Use-case: Pre-flight checks before executing trades

GET /api/health
  Response: { uptime, last_sync, provider_health, memory_load }
  Use-case: Verify system readiness before signal intake

GET /api/readiness
  Response: { ready_for_convergence, missing_providers, queue_depth }
  Use-case: Determine if system can accept new trading signals
```

#### 3.2 Chat & Convergence (Core Trading Decision Path)

```
POST /api/dream/stream (SSE stream)
  Payload: { userId, message, agent?, provider? }
  Response: Streaming text/event-stream with real-time LLM replies
  Use-case: Claude receives agent analysis, returns trade approval/rejection

POST /api/dream/door-choice
  Payload: { doorId, choice, context }
  Response: { persisted: true, updated_state }
  Use-case: Persist user decisions on trade direction options

POST /api/dream (legacy)
  Payload: { message, metadata }
  Response: { reply, suggestions, agent, source }
  Use-case: Alternative sync endpoint for trade decisions
```

#### 3.3 Memory & Learning (Long-Term Pattern Tracking)

```
GET /api/csf/memory?tier=anchor&query=breaking_trades
  Response: List of CSF memory records matching query
  Use-case: Retrieve historical patterns (e.g., "loss trades in high volatility")

POST /api/csf/ingest
  Payload: { entry_type, data, timestamp, priority }
  Response: { accepted: true, id }
  Use-case: Store trade results and lessons learned

GET /api/csf/search
  Response: Searchable historical memory
  Use-case: Query trading pattern database
```

#### 3.4 RAG & Evidence (Audit Trail)

```
GET /api/rag/search?q=trade_eurusd_2026-06-08
  Response: [{ file, relevance, snippet, timestamp }]
  Use-case: Find all evidence related to specific trade

POST /api/rag/ingest
  Payload: { source, content, class, ttl }
  Response: { id, indexed_timestamp }
  Use-case: Log trade execution proofs
```

#### 3.5 Operator & Configuration (Risk Management)

```
GET /api/operator/settings
  Response: { risk_per_trade, max_loss_per_day, approved_symbols, ... }
  Use-case: Load operator-defined risk boundaries

POST /api/operator/command
  Payload: { cmd, args }
  Response: { status, output }
  Use-case: Emergency kill switch, pause trading

GET /api/operator/notes
  Response: Recent operator notes + decisions
  Use-case: Context for Claude's final decision
```

#### 3.6 Files & Evidence (Receipts)

```
GET /api/files/repo/*
  Response: Secure file serving with boundary checks
  Use-case: Access trade manifests, documentation

POST /api/files/upload
  Payload: FormData with file
  Response: { id, path, processed }
  Use-case: Upload broker API keys, strategy docs (encrypted)
```

---

## 4. Core Components Suitable for Trading

### 4.1 Dream-Chat Router (Agent Selection) ✅ REUSABLE

**File:** `apps/lantern-garage/lib/dream-chat.js`

**Current:** Selects agent personas (Lantern, Blinkbug, Keystone, etc.) based on message keywords.

**Trading Adaptation:**
- Create 5-6 trading personas:
  - `TrendAgent` (long-term patterns)
  - `MomentumAgent` (velocity, breakouts)
  - `VolatilityAgent` (ATR, Bollinger bands)
  - `RiskAgent` (position sizing, drawdown)
  - `StrategyAgent` (rule-based entry/exit)
  - `Claude` (final arbiter)

- Replace keyword matching with signal classification (e.g., "signal" → route to all agents)
- Store agent responses in memory for Claude's reference

**Effort:** 2-3 days | **Risk:** Low

### 4.2 Stream-Chat Handler (Real-Time SSE Streaming) ✅ REUSABLE

**File:** `apps/lantern-garage/lib/stream-chat.js`

**Current:** Streams LLM responses to browser in real-time, injects CSF context, handles provider fallback.

**Trading Adaptation:**
- Inject trading context instead of dream memory
- Stream agent consensus scores as they complete
- Broadcast trade approval/rejection in real-time to UI
- No structural changes needed — just different context

**Effort:** 1 day | **Risk:** Low

### 4.3 CSF Memory Engine (Pattern Storage & Retrieval) ✅ HIGHLY REUSABLE

**File:** `src/csf/memory_engine.py` + `apps/lantern-garage/lib/csf-memory.js`

**Current:** Tiered memory system: trace → correction → anchor → entity → skill

**Trading Adaptation:**
```
Trade Tier Mapping:
  Trace          → Every trade execution (raw signal, entry, exit, P&L)
  Correction     → Mistakes and lessons (e.g., "didn't follow rules, +50pips loss")
  Anchor         → Proven patterns (e.g., "USD spike 50pips breakout → trend follows")
  Entity         → Market conditions (volatility regimes, sessions, volatility index)
  Skill          → Trading rules (e.g., "2% risk per trade", "no trading before news")
  Ritual         → Strategy checklist (pre-trade verification)
```

**Queries Enabled:**
- "Show all losing breakout trades in high volatility"
- "What's the average win rate for morning session trades?"
- "Which symbols have the highest R multiple performance?"

**Effort:** 2-3 days (mostly mapping) | **Risk:** Very Low (existing system)

### 4.4 Convergence Loop (Multi-Agent Decision Synthesis) ✅ HIGHLY REUSABLE

**File:** `src/convergence_io_engine.py`

**Current:** 12-step convergence loop with 36-slot agent matrix, 4D status cubes, Bayesian updates.

**Trading Adaptation:**
```
Convergence Flow for Trade Decisions:
Step 1:  Receive signal from TradingView webhook
Step 2:  Validate signal format & risk parameters
Step 3:  Load recent trades & market context from CSF
Step 4:  Route to agent fleet in parallel
Step 5:  Collect agent confidence scores
Step 6:  Compute consensus via Bayesian belief update
Step 7:  Load operator risk settings (5% per trade, drawdown limits)
Step 8:  Validate position size against available equity
Step 9:  Format decision packet for Claude
Step 10: Stream Claude's reasoning to UI
Step 11: Record all agent inputs + Claude decision as receipt
Step 12: Approve/reject trade, execute or queue
```

**Status Cube:** Already supports 4D state (layer × 3 views). Can extend to represent:
- Market conditions (volatility, session, news risk)
- Portfolio state (current positions, drawdown, margin usage)
- Agent consensus (agreement score across fleet)
- Risk headroom (available risk budget vs. position size)

**Effort:** 3-4 days (integration) | **Risk:** Low-to-Medium (complex system, well-tested)

### 4.5 PCSF (Provider Capacity Safety Frame) ✅ REUSABLE

**File:** `src/convergence_io/pcsf.py` + `apps/lantern-garage/lib/pcsf-refresh.js`

**Current:** Labels capacity class (local, private, provider-backed), privacy boundaries, fallback paths.

**Trading Adaptation:**
```
PCSF Labels for Trading Decisions:
{
  "generatedAt": "2026-06-10T14:32:00Z",
  "capacityClass": "trading_decision",
  "provider": "claude",              // Final decision maker
  "metered": true,                   // Uses paid API
  "privacyBoundary": "internal",     // No PII in signals
  "fallbackUsed": false,             // Did we fall back to GPT if Claude failed?
  "claimBoundary": "live",           // This is a real trade decision
  "riskApprovedBy": "operator",      // Operator enforced 5% limit
  "riskExecutionLimit": 500,         // $500 max per trade
  "receiptsPath": "data/trades/...",
  "rollbackPath": "cancel_position"  // How to undo if needed
}
```

All trades must include PCSF receipt. Enables audit trail and post-analysis.

**Effort:** 1-2 days (labeling + validation) | **Risk:** Very Low

### 4.6 MCP Server & Tool Registration ✅ REUSABLE

**File:** `src/mcp_server/server.py`

**Current:** FastAPI + SSE server registering tools like `queue_status`, `task_intake`, `dispatch_work`, `list_skills`.

**Trading Adaptation:**
```
New Tools for Trading:
  - queue_trade(signal)        → Add to execution queue
  - execute_trade(params)       → Submit order to broker
  - cancel_trade(tradeId)       → Revert pending order
  - get_market_data(symbol)     → Fetch current price, ATR, etc.
  - check_risk_budget()         → Verify available risk capacity
  - log_trade_result(outcome)   → Store result + lesson
  - query_historical(filter)    → Search trade database
```

**Effort:** 3-4 days (implementation) | **Risk:** Low

---

## 5. Extension Points for Trading

### 5.1 New Routes to Add

```
POST /api/trading/signal
  Receive signal from TradingView webhook
  Validate & queue for agent review
  
GET /api/trading/queue
  Show pending signals in review state
  
POST /api/trading/decision
  Claude approves/rejects trade
  Return entry, stop, take-profit
  
GET /api/trading/history
  Paginated list of executed trades
  With P&L, reason, agent scores
  
POST /api/trading/risk-config
  Update operator risk settings
  Per-symbol limits, daily drawdown, etc.
  
GET /api/trading/analytics
  Win rate, average R, max drawdown, profit factor
  Grouped by strategy, symbol, market condition
```

### 5.2 New Data Structures

```
data/trades/
  ├─ signals/                    (incoming webhook signals)
  │  ├─ 2026-06-10_eurusd_120730.json
  │  └─ [...]
  ├─ decisions/                  (agent analysis packets)
  │  ├─ signal_uuid_agent_analysis.json
  │  └─ [...]
  ├─ executions/                 (approved & executed trades)
  │  ├─ 2026-06-10_001.jsonl     (daily trade log)
  │  └─ [...]
  └─ outcomes/                   (closed trades with P&L)
     ├─ 2026-06-08_outcomes.jsonl
     └─ [...]

data/csf_memory/
  ├─ trade/                      (trade tier: raw executions)
  ├─ correction/                 (lessons learned)
  ├─ anchor/                     (proven winning patterns)
  ├─ entity/                     (market condition entities)
  └─ skill/                      (strategy rules)

data/strategies/
  ├─ configs/
  │  ├─ breakout_strategy.json   (entry/exit rules)
  │  └─ [...]
  └─ performance/
     ├─ strategy_performance.jsonl (metrics per strategy)
     └─ [...]
```

### 5.3 New Personas (Trading Agents)

```python
# apps/lantern-garage/lib/trading-agents.js (NEW)

const TRADING_AGENTS = [
  {
    id: "trend",
    name: "Trend Agent",
    role: "Identify long-term direction and momentum",
    keywords: ["trend", "direction", "momentum", "higher lows"],
    systemPrompt: "You are a trend analyst. Analyze multi-timeframe charts...",
  },
  {
    id: "momentum",
    name: "Momentum Agent",
    role: "Detect velocity and breakouts",
    keywords: ["momentum", "breakout", "acceleration", "squeeze"],
    systemPrompt: "You are a momentum specialist. Look for velocity clues...",
  },
  {
    id: "volatility",
    name: "Volatility Agent",
    role: "Assess market environment suitability",
    keywords: ["volatility", "range", "quiet", "wild"],
    systemPrompt: "You are a volatility analyst. Evaluate regime risk...",
  },
  {
    id: "risk",
    name: "Risk Agent",
    role: "Enforce position sizing and drawdown limits",
    keywords: ["risk", "size", "loss", "drawdown"],
    systemPrompt: "You are a risk manager. Calculate max loss...",
  },
  {
    id: "strategy",
    name: "Strategy Agent",
    role: "Validate signal against configured rules",
    keywords: ["rule", "entry", "exit", "condition"],
    systemPrompt: "You are a rules enforcer. Check checklist...",
  },
];
```

---

## 6. Safety & Risk Management Infrastructure

### 6.1 Hard Risk Limits (Enforced at Multiple Layers)

```javascript
// apps/lantern-garage/lib/trading-risk.js (NEW)

const RISK_BOUNDARIES = {
  // Per-trade
  maxRiskPerTrade: 0.05,              // 5% of account
  maxPositionSize: 10000,             // $10k max
  
  // Daily
  maxDailyLoss: 0.10,                 // 10% stop-loss for day
  maxTradesPerDay: 20,
  
  // Symbol-specific
  allowedSymbols: ["EURUSD", "GBPUSD", "USDJPY", ...],
  symbolLimits: { EURUSD: 5, GBPUSD: 3, ... },
  
  // Time-based
  noTradeBeforeMinutes: 15,           // Before important news
  quietPeriod: "17:00-22:00 UTC",     // Weekend risk off
  
  // Execution safety
  minConfidenceScore: 60,             // All agents must agree ≥60%
  requireOperatorApproval: false,     // Start with auto-approval in paper mode
};

function validateTradeRisk(signal, portfolio, riskSettings) {
  const checks = [
    checkRiskPercentage(signal.positionSize, portfolio.equity, riskSettings),
    checkSymbolAllowed(signal.symbol, riskSettings),
    checkSymbolLimit(signal.symbol, riskSettings),
    checkDailyLossLimit(portfolio, riskSettings),
    checkTimeWindow(riskSettings),
    checkConfidenceScore(signal.agentScores, riskSettings),
  ];
  
  return {
    approved: checks.every(c => c.pass),
    failures: checks.filter(c => !c.pass),
    fallbackAdvised: checks.some(c => c.warn),
  };
}
```

### 6.2 Emergency Kill Switch

```javascript
// POST /api/trading/emergency-stop
// Powers down all trading immediately
// Closes open positions (market order)
// Disables signal intake
// Alerts operator via email/Discord
```

### 6.3 Audit Trail

Every trade receives a PCSF receipt:

```json
{
  "tradeId": "EURUSD-2026-06-10-14:32:00Z-001",
  "signal": { /* incoming signal */ },
  "agentAnalysis": {
    "trend": { score: 75, reasoning: "..." },
    "momentum": { score: 68, reasoning: "..." },
    "volatility": { score: 55, reasoning: "..." },
    "risk": { score: 100, reasoning: "..." },
    "strategy": { score: 80, reasoning: "..." },
    "consensusScore": 73
  },
  "claudeDecision": {
    "approved": true,
    "entry": 1.12345,
    "stopLoss": 1.12100,
    "takeProfit": 1.12700,
    "rationale": "Strong trend + momentum alignment with low volatility risk..."
  },
  "riskApproval": {
    "positionSize": 5000,
    "maxRisk": 500,
    "riskReward": 2.5,
    "passed": true
  },
  "execution": {
    "status": "approved",
    "timestamp": "2026-06-10T14:32:45Z",
    "broker": "paper_trading",
    "orderRef": "PaperBroker-2026-06-10-001"
  },
  "pcsf": {
    "capacityClass": "trading_decision",
    "provider": "claude",
    "metered": true,
    "privacyBoundary": "internal",
    "fallbackUsed": false,
    "claimBoundary": "live"
  }
}
```

---

## 7. TradingView Integration Points

### 7.1 Webhook Receiver

```javascript
// apps/lantern-garage/routes/trading.js
// POST /api/trading/signal

async function handleTradingSignal(req, res, url, deps) {
  const payload = await collectRequestBody(req);
  const signal = JSON.parse(payload);
  
  // Validate TradingView signature
  if (!validateTradingViewSignature(signal, process.env.TRADINGVIEW_WEBHOOK_SECRET)) {
    return sendJson(res, 403, { error: "Invalid signature" });
  }
  
  // Queue signal for agent review
  const signalId = generateId();
  await appendJsonlQueued(signalPath, { ...signal, id: signalId, timestamp: now() });
  
  // Return receipt immediately
  return sendJson(res, 202, { 
    accepted: true, 
    signalId,
    reviewUrl: `/api/trading/decision/${signalId}`
  });
}
```

### 7.2 Expected TradingView Payload

```json
{
  "symbol": "EURUSD",
  "timeframe": "15m",
  "action": "BUY",
  "price": 1.12345,
  "time": "2026-06-10T14:30:00Z",
  "strategy": "breakout_strategy_v2",
  "confidence": 0.78,
  "meta": {
    "lastSupport": 1.12100,
    "nextResistance": 1.12700,
    "atr": 0.00145
  }
}
```

---

## 8. Key Risks & Unknowns

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| **LLM hallucination on trade decisions** | Medium | High | Require consensus from 5+ agents before Claude approval; hard limits override LLM |
| **Provider outage during critical trade** | Low | Medium | PCSF fallback chain; multiple providers configured; paper trading allows safe iteration |
| **Race condition in concurrent trades** | Medium | High | JSONL append-only queue; per-symbol locks; post-trade audits |
| **Compliance/regulatory gaps** | Medium | Medium | Explicit "paper trading" mode first; full audit trail for future compliance review |
| **Broker API integration complexity** | Medium | Medium | Start with no real broker; mock broker for paper trading; broker abstraction layer designed upfront |
| **Data loss during backtest/analysis** | Low | Medium | Immutable JSONL append-only logs; CSF versioning; daily backups |
| **User misunderstanding of risk** | High | High | UI must show PCSF receipt; operator approval required for first 10 trades; clear risk labeling |

---

## 9. Existing Systems Ready for Reuse

### Reusable Components (Estimated at 40-50% of codebase)

| Component | Reusability | Effort Saved |
|-----------|------------|--------------|
| Dream-chat router | 90% | 2-3 days |
| Stream-chat SSE handler | 95% | 1 day |
| CSF memory engine | 85% | 3-4 days |
| Convergence loop | 70% | 4-5 days |
| PCSF safety frame | 80% | 1-2 days |
| MCP tool registration | 75% | 2-3 days |
| Status & health checks | 60% | 1-2 days |
| RAG house (document index) | 50% | 1 day |
| Provider fallback chain | 90% | 0.5 day |
| Receipt/provenance logging | 85% | 1 day |
| **Total Estimated Reuse** | **~75%** | **~17-22 days** |

---

## 10. Proposed Directory Structure for Trading

```
Existing:
  apps/lantern-garage/
    routes/dream.js (keep; extend for trading signals)
    lib/dream-chat.js (keep; extend with trading agents)
  src/convergence_io_engine.py (keep; reuse loop)
  src/csf/memory_engine.py (keep; map to trades)
  data/dream_journal/ (keep; separate from trades)

New:
  apps/lantern-garage/
    routes/
      trading.js           ← Signal intake, decision workflow
      trading-history.js   ← Trade query & analytics
    lib/
      trading-agents.js    ← Trend, Momentum, Volatility, Risk, Strategy agents
      trading-risk.js      ← Risk boundaries, position sizing validation
      trading-memory.js    ← Trade-specific CSF mappings
      trading-convergence.js ← Trade signal → agent fleet → Claude decision
      broker-abstraction.js ← Interface for paper/live brokers
  
  src/
    trading/
      signal_processor.py  ← Validate + enrich incoming signals
      agent_fleet.py       ← Parallel agent invocation
      trade_logger.py      ← Append-only trade journal
      risk_validator.py    ← Position sizing + boundary checks
      broker_adapter.py    ← Abstract broker interface
      analytics.py         ← Win rate, R multiple, drawdown calculations
  
  data/
    trades/
      signals/             ← Incoming webhook signals
      decisions/           ← Agent analysis results
      executions/          ← Approved trades
      outcomes/            ← Closed trades with P&L
      strategy-config/     ← Strategy rules (JSON)
  
  manifests/
    TRADING-SYSTEM-DESIGN.md    ← Architecture spec
    TRADING-SAFETY-GATES.md     ← Risk boundaries
    BROKER-INTEGRATION-PLAN.md  ← Broker adapter roadmap
  
  docs/
    TRADING-QUICKSTART.md       ← Getting started
    TRADING-API-ENDPOINTS.md    ← API reference
    TRADING-SYSTEM-OPERATIONS.md ← Day-to-day operations
```

---

## 11. First Implementation Milestone

**Estimated Timeline:** 4-6 weeks

### Week 1: Foundation & Architecture
- [ ] Design trading agents (system prompts, input/output contracts)
- [ ] Create trading memory tier mapping (trace → skill)
- [ ] Design PCSF receipt for trade decisions
- [ ] Set up data directories and schema

### Week 2: Signal Intake & Routing
- [ ] Implement `POST /api/trading/signal` webhook receiver
- [ ] Add TradingView signature validation
- [ ] Create signal queue and status tracking
- [ ] Add rate limiting and input validation

### Week 3: Agent Fleet & Convergence
- [ ] Implement 5 trading agents (Trend, Momentum, Volatility, Risk, Strategy)
- [ ] Adapt convergence loop for trade decisions
- [ ] Add consensus scoring (Bayesian or weighted average)
- [ ] Create agent-to-Claude decision packet

### Week 4: Decision & Execution
- [ ] Implement Claude approval/rejection logic
- [ ] Add position sizing calculations
- [ ] Create mock broker interface (paper trading)
- [ ] Log all decisions + outcomes to JSONL

### Week 5: Memory & Analytics
- [ ] Map trade data to CSF memory tiers
- [ ] Build trade history query endpoint
- [ ] Implement win rate, R multiple, drawdown metrics
- [ ] Add search over historical trades

### Week 6: Safety & UI
- [ ] Implement hard risk limits and boundaries
- [ ] Add emergency kill switch
- [ ] Create risk config management endpoint
- [ ] Build operator dashboard for trade monitoring
- [ ] Write documentation and runbooks

---

## 12. Recommendations

### Phase 2 (Design) Deliverables

Before implementation begins, produce:

1. **Trading Agents Specification** (system prompts, input schema, output contract)
2. **Trading Memory Mapping** (how trades map to CSF tiers for querying)
3. **PCSF Receipt Template** (structure for every trade decision)
4. **Convergence Loop for Trading** (12-step or adapted version)
5. **Risk Boundaries Document** (hard limits, emergency procedures)
6. **Broker Abstraction Layer Design** (interface for paper/live brokers)
7. **TradingView Integration Spec** (webhook format, validation, error handling)
8. **Database Schema** (JSONL structure for signals, decisions, executions, outcomes)
9. **API Endpoint Specification** (full REST contract with examples)
10. **Security & Compliance Checklist** (audit trail, data retention, regulatory notes)

### Safest Implementation Path

1. **Start with Paper Trading Only**
   - No real broker integration in Phase 1
   - Mock broker returns fictional fills
   - Operator can see what "would have happened"
   - No financial risk; maximum learning

2. **Require Operator Approval for First 10 Trades**
   - Even in paper mode
   - Operator reviews agent reasoning, Claude decision, risk calculations
   - Builds confidence in system before automation

3. **Immutable Audit Trail**
   - Every signal, agent analysis, decision, execution logged to JSONL
   - Cannot be edited, only appended
   - Enables post-trade audits and strategy improvement

4. **CSF Memory from Day 1**
   - Map trade data to memory tiers immediately
   - Enables future queries like "show me all losing breakout trades"
   - Data is clean, structured, queryable from start

5. **Convergence Loop Engagement**
   - Use existing 12-step loop for trade releases
   - Each "promotion decision" (execute vs. hold vs. reject) uses convergence
   - Builds pattern of receipts and evidence trails

---

## Appendix A: File Inventory

### Critical Files for Trading Integration

```
✅ KEEP & EXTEND:
  apps/lantern-garage/server.js                  (main HTTP router)
  apps/lantern-garage/lib/dream-chat.js          (agent selection)
  apps/lantern-garage/lib/stream-chat.js         (SSE streaming)
  apps/lantern-garage/lib/csf-memory.js          (memory injection)
  apps/lantern-garage/lib/csf-delta-store.js     (memory persistence)
  apps/lantern-garage/lib/status.js              (health checks)
  apps/lantern-garage/lib/http-utils.js          (security headers)
  src/convergence_io_engine.py                   (convergence loop)
  src/csf/memory_engine.py                       (memory tier logic)
  src/mcp_server/server.py                       (tool registration)

⚠️ REFERENCE (DO NOT MODIFY CORE):
  apps/lantern-garage/routes/dream.js            (study for streaming pattern)
  apps/lantern-garage/lib/mcp-bridge.js          (study for MCP calls)
  apps/lantern-garage/lib/provider-cache.js      (study for fallback chain)

🆕 CREATE FOR TRADING:
  apps/lantern-garage/routes/trading.js          (signal intake)
  apps/lantern-garage/routes/trading-history.js  (query)
  apps/lantern-garage/lib/trading-agents.js      (5 agents)
  apps/lantern-garage/lib/trading-risk.js        (boundaries)
  apps/lantern-garage/lib/trading-convergence.js (signal → decision)
  src/trading/signal_processor.py                (validation)
  src/trading/agent_fleet.py                     (parallel invocation)
  src/trading/trade_logger.py                    (JSONL append)
  src/trading/analytics.py                       (metrics)
```

---

## Appendix B: References

- **README.md** — Project overview, capabilities, architecture
- **CLAUDE.md** — Agent workflow, testing commands
- **SECURITY.md** — Security fixes, input validation best practices
- **SKILLS.md** — Available providers, agent personas
- **docs/CONVERGENCE-LOOP.md** — 12-step operating method
- **docs/TESSERACT-CONVERGENCE-LOOP.md** — 20-step advanced loop
- **docs/CSF-FORMAT-SPECIFICATION.md** — Memory archive format
- **docs/MCP-CONNECTOR.md** — Tool registration and dispatch
- **manifests/CONVERGENCE-LOOP-AGENT-FLEET.md** — 36-slot matrix design
- **src/convergence_io/pcsf.py** — Provider capacity safety frame

---

## Conclusion

**Verdict:** Lanterns OS is well-architected for trading system integration. The convergence loop, CSF memory, PCSF safety frame, and agent routing all translate directly to trading workflows.

**Next Steps:**
1. Review this audit for any corrections or clarifications
2. Approve Phase 2 deliverables list
3. Design trading agents and memory mapping
4. Begin implementation when design review complete

**Estimated Total Effort:** 4-6 weeks for Phase 2 (design) + implementation + testing

---

**Audit Complete**  
**Next Action:** Proceed to Phase 2 — Trading Architecture Design
