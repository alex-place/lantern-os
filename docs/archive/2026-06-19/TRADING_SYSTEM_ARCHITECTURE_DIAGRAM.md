# Trading System Architecture Diagram
## Lantern OS Trading Integration Reference

---

## 1. Complete System Architecture (Layers)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         BROWSER LAYER                                   │
│ ┌────────────────────┐  ┌─────────────────────────────────────────────┐ │
│ │ Trading Dashboard  │  │ Dream Journal (UNCHANGED)                   │ │
│ │ • Signal queue     │  │ • Chat interface                            │ │
│ │ • Trade history    │  │ • Three doors game                          │ │
│ │ • Risk config      │  │ • Status cubes                              │ │
│ │ • Analytics        │  │ • Dream export                              │ │
│ └────────────────────┘  └─────────────────────────────────────────────┘ │
└────────────────┬──────────────────────────────────────────────────────────┘
                 │ HTTPS
┌────────────────▼──────────────────────────────────────────────────────────┐
│                         HTTP ROUTER (Node.js)                             │
│ apps/lantern-garage/server.js                                             │
│ • Load routes                                                              │
│ • Load environment                                                         │
│ • Bind to 127.0.0.1:4177                                                  │
│ • Serve static assets                                                      │
└────────────────┬──────────────────────────────────────────────────────────┘
                 │
        ┌────────┴─────────┐
        │                  │
┌───────▼────────┐  ┌──────▼──────────┐
│ DREAM ROUTES   │  │ TRADING ROUTES  │ (NEW)
│                │  │                 │
│ /api/dream     │  │ /api/trading/   │
│ /api/dreamer   │  │   signal        │
│ /api/csf       │  │   decision      │
│ /api/rag       │  │   history       │
│ /api/status    │  │ /api/trading-   │
│ ...            │  │   history       │
└────────────────┘  └────────┬────────┘
     │                       │
     │              ┌────────▼────────┐
     │              │ TRADING LOGIC   │
     │              │ (apps/lantern-  │
     │              │  garage/lib/)   │
     │              │                 │
     │              │ ┌─────────────┐ │
     │              │ │ trading-    │ │
     │              │ │ agents.js   │ │
     │              │ │             │ │
     │              │ │ 5 agents:   │ │
     │              │ │ • Trend     │ │
     │              │ │ • Momentum  │ │
     │              │ │ • Volatility│ │
     │              │ │ • Risk      │ │
     │              │ │ • Strategy  │ │
     │              │ └─────────────┘ │
     │              │                 │
     │              │ ┌─────────────┐ │
     │              │ │ trading-    │ │
     │              │ │ convergence │ │
     │              │ │ .js         │ │
     │              │ │             │ │
     │              │ │ Signal →    │ │
     │              │ │ Agents →    │ │
     │              │ │ Consensus → │ │
     │              │ │ Claude      │ │
     │              │ └─────────────┘ │
     │              │                 │
     │              │ ┌─────────────┐ │
     │              │ │ trading-    │ │
     │              │ │ risk.js     │ │
     │              │ │             │ │
     │              │ │ • Hard      │ │
     │              │ │   limits    │ │
     │              │ │ • Position  │ │
     │              │ │   sizing    │ │
     │              │ └─────────────┘ │
     │              └─────────────────┘
     │
     ▼─────────────────────────────────────────────────────────────┐
┌────────────────────────────────────────────────────────────────┐ │
│ DREAM BUSINESS LOGIC (apps/lantern-garage/lib/)               │ │
│                                                                 │ │
│ ┌──────────────────┐  ┌──────────────────────────────────────┐│ │
│ │ dream-chat.js    │  │ stream-chat.js                       ││ │
│ │ • Agent          │  │ • SSE handler                        ││ │
│ │   selection      │  │ • Context injection                  ││ │
│ │ • LLM routing    │  │ • Streaming response                 ││ │
│ │ • Provider       │  │ • Reuse for trading                  ││ │
│ │   selection      │  │   consensus streaming                ││ │
│ └──────────────────┘  └──────────────────────────────────────┘│ │
│                                                                 │ │
│ ┌──────────────────┐  ┌──────────────────────────────────────┐│ │
│ │ dreamer-store.js │  │ csf-memory.js                        ││ │
│ │ • JSONL I/O      │  │ • Memory tier loading                ││ │
│ │ • Per-user       │  │ • Context windows                    ││ │
│ │   notebooks      │  │ • 10-sec TTL cache                   ││ │
│ │                  │  │ • (REUSE for trades)                 ││ │
│ └──────────────────┘  └──────────────────────────────────────┘│ │
│                                                                 │ │
│ ┌──────────────────┐  ┌──────────────────────────────────────┐│ │
│ │ status.js        │  │ http-utils.js                        ││ │
│ │ • Health         │  │ • Security headers                   ││ │
│ │   aggregation    │  │ • CORS control                       ││ │
│ │ • Readiness      │  │ • Path traversal protection          ││ │
│ │   checks         │  │                                      ││ │
│ └──────────────────┘  └──────────────────────────────────────┘│ │
│                                                                 │ │
│ ┌──────────────────┐  ┌──────────────────────────────────────┐│ │
│ │ provider-cache   │  │ mcp-bridge.js                        ││ │
│ │ .js              │  │ • MCP connector                      ││ │
│ │ • 10-provider    │  │ • Tool discovery                     ││ │
│ │   fallback chain │  │ • Agent registration                 ││ │
│ │ • Health check   │  │                                      ││ │
│ │ • Rotation       │  │                                      ││ │
│ └──────────────────┘  └──────────────────────────────────────┘│ │
└────────────────────────────────────────────────────────────────┘ │
     │                                                               │
     └──────────────────────────────────────┬──────────────────────┘
                                            │
┌───────────────────────────────────────────▼──────────────────────┐
│ PERSISTENCE & MEMORY LAYER                                       │
│                                                                   │
│ ┌─────────────────┐  ┌────────────────────────────────────────┐ │
│ │ JSONL Stores    │  │ CSF Memory System                      │ │
│ │ (append-only)   │  │ (searchable archive)                   │ │
│ │                 │  │                                        │ │
│ │ dream_journal/  │  │ ┌──────────────────────────────────┐  │ │
│ │ • *.jsonl       │  │ │ Tier Structure:                  │  │ │
│ │   (dreams)      │  │ ├─ trace (raw events)             │  │ │
│ │                 │  │ ├─ correction (lessons)           │  │ │
│ │ conversations/  │  │ ├─ anchor (patterns)              │  │ │
│ │ • garage-       │  │ ├─ entity (conditions)            │  │ │
│ │   conversations │  │ ├─ skill (rules)                  │  │ │
│ │   .jsonl        │  │ └─ ritual (checklists)            │  │ │
│ │                 │  │                                    │  │ │
│ │ trades/         │  │ For Trading:                       │  │ │
│ │ • signals/      │  │ • Trace: Every trade execution   │  │ │
│ │ • decisions/    │  │ • Correction: Mistakes & lessons │  │ │
│ │ • executions/   │  │ • Anchor: Winning patterns       │  │ │
│ │ • outcomes/     │  │ • Entity: Market conditions      │  │ │
│ │   (NEW)         │  │ • Skill: Trading rules           │  │ │
│ │                 │  │ • Ritual: Pre-trade checklist    │  │ │
│ │ rag-house/      │  │ └──────────────────────────────────┘  │ │
│ │ • index         │  │                                        │ │
│ │ • evidence      │  │ src/csf/memory_engine.py:              │ │
│ │                 │  │ • Tier promotion logic                │ │
│ │ pcsf/           │  │ • Bayesian updates                     │ │
│ │ • state files   │  │ • (REUSE for trades)                  │ │
│ └─────────────────┘  └────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
                                │
                ┌───────────────┴───────────────┐
                │                               │
┌───────────────▼──────────────┐  ┌────────────▼──────────────┐
│ PYTHON BACKEND SERVICES      │  │ EXTERNAL SERVICES         │
│                              │  │                           │
│ src/convergence_io/          │  │ LLM Providers:            │
│ • engine.py                  │  │ • Anthropic (Claude)      │
│ • pcsf.py (safety frame)     │  │ • OpenAI (GPT)            │
│ • aapf.py (provenance)       │  │ • Google (Gemini)         │
│ • status_cube.py             │  │ • xAI (Grok)              │
│                              │  │ • Mistral                 │
│ src/csf/                     │  │ • Cohere                  │
│ • memory_engine.py           │  │ • DeepSeek                │
│ • search.py                  │  │ • Ollama (local)          │
│                              │  │ • OpenRouter (gateway)    │
│ src/mcp_server/              │  │                           │
│ • server.py (FastAPI)        │  │ Infrastructure:           │
│ • Tool registration          │  │ • GitHub (CI/CD)          │
│ • Agent dispatch             │  │ • Railway (cloud)         │
│                              │  │ • Discord (optional bot)  │
│ src/trading/ (NEW)           │  │ • Google Drive (archive)  │
│ • signal_processor.py        │  │                           │
│ • agent_fleet.py             │  │ TradingView Webhook       │
│ • trade_logger.py            │  │ (inbound signals)         │
│ • risk_validator.py          │  │                           │
│ • broker_adapter.py          │  │ Paper Broker API          │
│ • analytics.py               │  │ (mock orders)             │
│                              │  │                           │
│                              │  │ Future: Live Brokers      │
│                              │  │ • Interactive Brokers     │
│                              │  │ • OANDA                   │
│                              │  │ • Alpaca                  │
└──────────────────────────────┘  └───────────────────────────┘
```

---

## 2. Signal Processing Pipeline (Detailed View)

```
TradingView Webhook
(POST /api/trading/signal)
         │
         ▼
┌─────────────────────────────────┐
│ Signal Validation               │
├─────────────────────────────────┤
│ • Check signature (HMAC-SHA256) │
│ • Validate format               │
│ • Check symbol allowed          │
│ • Rate limiting                 │
└──────────┬──────────────────────┘
           │
           ├─ INVALID? → 400/403 Error
           │
           ├─ VALID? ▼
           │
        [Signal queued to JSONL]
    data/trades/signals/*.json
           │
           ▼
┌─────────────────────────────────┐
│ Agent Fleet (Parallel)          │
├─────────────────────────────────┤
│ Each agent receives:            │
│ • Current price & OHLCV         │
│ • Recent trade history          │
│ • Current positions             │
│ • CSF memory (anchors)          │
│ • Operator risk settings        │
└──────────┬──────────────────────┘
           │
    ┌──────┼──────┬──────┬──────┐
    │      │      │      │      │
    ▼      ▼      ▼      ▼      ▼
  ┌──┐ ┌──┐ ┌──────┐ ┌──┐ ┌──────┐
  │T1│ │M1│ │V1    │ │R1│ │S1    │
  │ren │ om │Vol  │isk │ tra  │
  │d  │ent │    │  │ tegy │
  └─┬┘ └─┬┘ └──┬──┘ └─┬┘ └──┬──┘
    │    │    │     │    │
    │    │    │     │    │     [Store analysis]
    │    │    │     │    │  → data/trades/
    │    │    │     │    │     decisions/
    │    │    │     │    │
    └────┼────┼─────┼────┘
         │    │     │
         ▼    ▼     ▼
    [All agents return score 0-100 + reasoning]
         │
         ▼
┌──────────────────────────────────┐
│ Convergence Engine               │
│ (src/convergence_io_engine.py)   │
├──────────────────────────────────┤
│ 1. Collect agent scores          │
│ 2. Compute consensus             │
│    (weighted average or voting)  │
│ 3. Apply Bayesian update         │
│ 4. Generate decision packet      │
└──────────┬───────────────────────┘
           │
           ▼ [Score: 73%]
┌──────────────────────────────────┐
│ Claude Final Decision             │
│ (POST to Anthropic API)           │
├──────────────────────────────────┤
│ Receives:                        │
│ • Original signal                │
│ • All agent analyses             │
│ • Consensus score (73%)          │
│ • Recent trade history           │
│ • Operator notes                 │
│                                  │
│ Returns:                         │
│ • APPROVED / REJECTED            │
│ • Entry price                    │
│ • Stop loss                      │
│ • Take profit                    │
│ • Rationale                      │
└──────────┬───────────────────────┘
           │
           ├─ REJECTED? → Queue as held
           │
           ├─ APPROVED? ▼
           │
┌──────────▼───────────────────────┐
│ Risk Validation                  │
│ (lib/trading-risk.js)            │
├──────────────────────────────────┤
│ Hard Boundary Checks:            │
│ • 5% per-trade limit OK?         │
│ • Position size valid?           │
│ • Daily loss limit OK?           │
│ • Symbol allowed?                │
│ • Margin available?              │
│ • Time window OK?                │
└──────────┬───────────────────────┘
           │
           ├─ ANY FAIL? → REJECTED
           │
           ├─ ALL PASS? ▼
           │
┌──────────▼───────────────────────┐
│ Paper Broker Execution           │
│ (broker-abstraction.js)          │
├──────────────────────────────────┤
│ Place order:                     │
│ • Symbol: EURUSD                 │
│ • Type: MARKET                   │
│ • Entry: 1.12345                 │
│ • Stop: 1.12100 (-245 pips)      │
│ • Target: 1.12700 (+355 pips)    │
│                                  │
│ Mock broker returns:             │
│ • Order reference                │
│ • Fill price                     │
│ • Timestamp                      │
└──────────┬───────────────────────┘
           │
           ▼ [Order filled]
┌──────────────────────────────────┐
│ Receipt Generation (PCSF)        │
│ (src/convergence_io/pcsf.py)     │
├──────────────────────────────────┤
│ Create immutable receipt:        │
│ • Capacity class: trading        │
│ • Provider: claude               │
│ • Agents: trend, momentum, ...   │
│ • Risk approved: yes             │
│ • Execution: success             │
│ • Broker ref: PB-2026-06-10-001  │
│ • Timestamp, signatures, etc.    │
└──────────┬───────────────────────┘
           │
           ▼ [Store receipt]
┌──────────────────────────────────┐
│ Memory Storage (CSF)             │
│ (src/csf/memory_engine.py)       │
├──────────────────────────────────┤
│ Append to memory tiers:          │
│                                  │
│ Trace:                           │
│ • Raw trade signal, entry, stop, TP │
│                                  │
│ (Will move to higher tiers       │
│  as outcome becomes known)       │
└──────────┬───────────────────────┘
           │
           ▼ [LIVE POSITION]
        
[At closure, after market action:]
         │
         ▼
┌──────────────────────────────────┐
│ Outcome Logging                  │
├──────────────────────────────────┤
│ • Close price                    │
│ • P&L (+ pips, + $ amount)       │
│ • Reason (TP hit, SL hit, manual)│
│ • Duration                       │
│ • Agent accuracy score           │
└──────────┬───────────────────────┘
           │
           ▼
┌──────────────────────────────────┐
│ Memory Tier Promotion            │
├──────────────────────────────────┤
│ If profitable:                   │
│ trace → anchor (proven pattern)  │
│                                  │
│ If loss:                         │
│ trace → correction (lesson)      │
│                                  │
│ Extract to Skill:                │
│ "USD morning breakouts in low    │
│  volatility have 65% win rate"   │
└──────────────────────────────────┘
```

---

## 3. Agent Fleet Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ FIVE TRADING AGENTS (Parallel Execution)                       │
└────────────────────────────────────────────────────────────────┘

Agent 1: TREND AGENT
┌─────────────────────────────────────────┐
│ Role: Multi-timeframe direction analysis│
├─────────────────────────────────────────┤
│ Inputs:                                 │
│ • OHLCV (15m, 1h, 4h, 1d)               │
│ • Support/resistance levels             │
│ • Moving averages (20, 50, 200)         │
│ • ADX (trend strength)                  │
│ • Higher lows/lows pattern              │
│                                         │
│ Outputs:                                │
│ • Confidence: 0-100 (bull, bear, range) │
│ • Reasoning (2-3 key technical points)  │
│ • Next resistance/support               │
│                                         │
│ Example: "EURUSD: 72% bullish"         │
│ "Trend: Higher lows intact, daily       │
│  above 50-MA, hourly in breakout"       │
└─────────────────────────────────────────┘

Agent 2: MOMENTUM AGENT
┌─────────────────────────────────────────┐
│ Role: Velocity and acceleration detect  │
├─────────────────────────────────────────┤
│ Inputs:                                 │
│ • RSI (14-period)                       │
│ • MACD (histogram, signal)              │
│ • Bollinger Bands squeeze               │
│ • ATR expansion                         │
│ • Volume profile                        │
│                                         │
│ Outputs:                                │
│ • Confidence: 0-100 (acceleration)      │
│ • Reasoning                             │
│ • Momentum type (breakout, continuation)│
│                                         │
│ Example: "EURUSD: 68% momentum"        │
│ "Breakout: Squeezed Bollinger bands,    │
│  MACD histogram expanding"              │
└─────────────────────────────────────────┘

Agent 3: VOLATILITY AGENT
┌─────────────────────────────────────────┐
│ Role: Market environment suitability    │
├─────────────────────────────────────────┤
│ Inputs:                                 │
│ • ATR (normalized to 20-MA)             │
│ • Historical volatility (20, 50 period) │
│ • Implied volatility (news calendar)    │
│ • Session characteristics               │
│ • Time to news events                   │
│                                         │
│ Outputs:                                │
│ • Confidence: 0-100 (risk/reward ratio) │
│ • Volatility regime (low, normal, high) │
│ • Risk warning level                    │
│                                         │
│ Example: "EURUSD: 55% suitable"        │
│ "Volatility normal. 3.4 hrs to ECB      │
│  decision (CAUTION)"                    │
└─────────────────────────────────────────┘

Agent 4: RISK AGENT
┌─────────────────────────────────────────┐
│ Role: Position sizing & loss boundaries │
├─────────────────────────────────────────┤
│ Inputs:                                 │
│ • Account equity                        │
│ • Daily loss limit (10%)                │
│ • Per-trade risk (5%)                   │
│ • Entry + stop prices                   │
│ • Pip value × contract size             │
│                                         │
│ Outputs:                                │
│ • Confidence: 0-100 (risk mgmt OK?)     │
│ • Max position size                     │
│ • Actual loss if SL hit                 │
│ • Risk/reward ratio                     │
│                                         │
│ Example: "EURUSD: 100% risk OK"        │
│ "Max position: 5000 EUR, max loss: $500"│
│ "Risk/reward: 1:2.5 (favorable)"        │
└─────────────────────────────────────────┘

Agent 5: STRATEGY AGENT
┌─────────────────────────────────────────┐
│ Role: Rule enforcement & checklist      │
├─────────────────────────────────────────┤
│ Inputs:                                 │
│ • Trading rules config (JSON)           │
│ • Current setup vs. rules               │
│ • Recent trade history                  │
│ • Symbol-specific rules                 │
│ • Time-based restrictions               │
│                                         │
│ Outputs:                                │
│ • Confidence: 0-100 (rules met?)        │
│ • Checklist status (pass/fail per rule) │
│ • Violations found (if any)             │
│                                         │
│ Example: "EURUSD: 80% rules OK"        │
│ "✓ Symbol allowed (EURUSD)"             │
│ "✓ Morning session (high volatility ok)"│
│ "✓ No trades last 2 hours"              │
│ "✓ Risk within limits"                  │
└─────────────────────────────────────────┘

                    │
                    ▼
    ┌───────────────────────────────┐
    │ Consensus Calculation         │
    ├───────────────────────────────┤
    │ Trend:      72%               │
    │ Momentum:   68%               │
    │ Volatility: 55%               │
    │ Risk:      100%               │
    │ Strategy:   80%               │
    │ ────────────────────────────  │
    │ CONSENSUS:  73% ← (weighted)  │
    │                               │
    │ All agents passed (≥50%)?     │
    │ YES → Send to Claude          │
    │ NO → Hold/reject              │
    └───────────────────────────────┘
```

---

## 4. Data Flow During Trade Execution

```
INCOMING SIGNAL                 DATA FILES              AGENT ANALYSIS
──────────────────             ──────────────            ──────────────
{                              
  symbol: EURUSD   ───┐        signal.json      ┌──→  agent analysis.json
  timeframe: 15m     │          + metadata      │        (trend, momentum,
  price: 1.12345     │          + timestamp     │         volatility, risk,
  signal: BUY        │                          │         strategy)
  confidence: 0.78   │                          │
}                    │                          │
                     ▼                          │
            data/trades/signals/                │
            2026-06-10_eurusd_...json           │
                                                ▼
                            data/trades/decisions/
                            signal_UUID_agent_analysis.json

                                                │
                                                ▼
                                    
                                CONVERGENCE PACKET
                                ─────────────────
                                {
                                  signal_id: "...",
                                  timestamp: "...",
                                  agents: [
                                    { name: "Trend", score: 72 },
                                    { name: "Momentum", score: 68 },
                                    { name: "Volatility", score: 55 },
                                    { name: "Risk", score: 100 },
                                    { name: "Strategy", score: 80 }
                                  ],
                                  consensus_score: 73,
                                  recommendation: "SEND_TO_CLAUDE"
                                }
                                │
                                ▼
                        
                        CLAUDE API CALL
                        (Anthropic)
                        
                        Prompt includes:
                        • Original signal
                        • All agent analyses
                        • Consensus score
                        • Recent trade history
                        • Operator notes
                        │
                        ▼
                        
                        CLAUDE RESPONSE
                        ──────────────
                        {
                          decision: "APPROVED",
                          entry: 1.12345,
                          stop_loss: 1.12100,
                          take_profit: 1.12700,
                          position_size: 5000,
                          rationale: "Strong consensus with favorable
                                     risk/reward. Trend + momentum aligned.",
                          risk_approved: true,
                          max_loss: "$500"
                        }
                        │
                        ▼
                        
                    PCSF RECEIPT
                    (Multi-signature & capacity labeling)
                    {
                      trade_id: "EURUSD-...",
                      signal_id: "...",
                      agents: { trend: 72, momentum: 68, ... },
                      claude_decision: { entry: 1.12345, ... },
                      pcsf: {
                        capacity_class: "trading_decision",
                        provider: "claude",
                        metered: true,
                        privacy_boundary: "internal",
                        fallback_used: false,
                        claim_boundary: "live"
                      },
                      signatures: {
                        trade_agent_ids: ["claude", "trend_agent", ...],
                        approval_timestamp: "2026-06-10T14:32:45Z"
                      }
                    }
                    │
                    ▼
                    
                RISK CHECK
                ──────────
                • 5% per-trade limit: $500 → PASS
                • 10% daily loss limit: $4,500 → PASS
                • Symbol allowed: EURUSD → PASS
                • Margin available: $10,000 → PASS
                • Time window OK: 14:32 UTC → PASS
                
                ALL CHECKS PASS ✓
                │
                ▼
                
            PAPER BROKER
            (Mock execution)
            
            Order submitted:
            • Broker API: PaperBroker
            • Symbol: EURUSD
            • Entry: 1.12345 (filled)
            • Stop: 1.12100
            • Target: 1.12700
            • Size: 5000 EUR
            
            Order confirmed:
            {
              order_id: "PB-2026-06-10-001",
              fill_price: 1.12345,
              fill_time: "2026-06-10T14:32:46Z",
              status: "OPEN"
            }
            │
            ▼
            
        TRADE LOGGER
        (JSONL append)
        
        data/trades/executions/
        2026-06-10_001.jsonl
        
        Appended entry:
        {
          trade_id: "EURUSD-2026-06-10-14:32:00Z-001",
          signal: { ... },
          agent_analysis: { ... },
          claude_decision: { ... },
          risk_approval: { ... },
          execution: {
            status: "OPEN",
            entry: 1.12345,
            stop: 1.12100,
            target: 1.12700,
            broker_ref: "PB-2026-06-10-001",
            timestamp: "2026-06-10T14:32:46Z"
          }
        }
        │
        ▼
        
    CSF MEMORY INJECTION
    
    data/csf_memory/
    
    Trace tier:
    • Raw trade signal
    • Entry price & time
    • Stop & target levels
    
    (Will be promoted to anchor/skill
     after outcome is known)
```

---

## 5. Memory Query Examples (CSF Searchable)

```
USER QUERY: "Show all losing breakout trades"

Query Execution:
1. Search CSF Correction tier (mistakes)
   → Find: "Breakout entry too late, signal faded, -150 pips"
   → Find: "Breakout into news, lost $250"
   → Find: "Fake breakout, retested lower, stopped out"

2. Return with context:
   [
     {
       trade_id: "EURUSD-2026-06-01-...",
       type: "breakout",
       entry: 1.12500,
       exit: 1.12350,
       pips_lost: -150,
       lesson: "Breakout signal came after major move; pullback was natural",
       market_condition: "high_volatility_london_session",
       timestamp: "2026-06-01T08:15:00Z"
     },
     { ... more trades ... }
   ]

3. Operator can extract pattern:
   "Breakout trades in high volatility during London session have
    60% win rate. Entry at exact breakout candle (not after)
    improves to 75%. Plan: Tighten entry timing."

═══════════════════════════════════════════════════════════════════

USER QUERY: "What market conditions produce the highest win rate?"

Query Execution:
1. Scan Entity tier (market conditions)
   → Find: "low_volatility_asian_session"
   → Find: "trend_continuation_setup"
   → Find: "mean_reversion_range_bound"

2. For each condition, calculate metrics:
   
   low_volatility_asian_session:
   • Win rate: 68%
   • Avg R multiple: 1.8
   • Max consecutive wins: 5
   • Total trades: 23
   
   trend_continuation_setup:
   • Win rate: 65%
   • Avg R multiple: 2.1
   • Max consecutive wins: 4
   • Total trades: 31
   
   mean_reversion_range_bound:
   • Win rate: 58%
   • Avg R multiple: 1.2
   • Max consecutive wins: 3
   • Total trades: 19

3. Result: "Focus on low volatility Asian session.
           Enter on break of range, not early fades."

═══════════════════════════════════════════════════════════════════

USER QUERY: "Which symbols have the best R multiple?"

Query Execution:
1. Scan Anchor tier (proven patterns)
   Group by symbol

2. Calculate R multiple (profit/risk):
   
   EURUSD:
   • Total trades: 45
   • Win rate: 62%
   • Avg win: 250 pips
   • Avg loss: 150 pips
   • Avg R multiple: 1.67
   
   GBPUSD:
   • Total trades: 38
   • Win rate: 58%
   • Avg win: 320 pips
   • Avg loss: 160 pips
   • Avg R multiple: 2.0 ← BEST
   
   USDJPY:
   • Total trades: 22
   • Win rate: 55%
   • Avg win: 180 pips
   • Avg loss: 200 pips
   • Avg R multiple: 0.9 ← Avoid

3. Result: "GBPUSD offers best risk/reward.
           Increase allocation to GBPUSD setups."
```

---

## 6. Failover & Provider Fallback

```
PRIMARY PATH: Claude (Anthropic)
│
├─ API Call: /api.anthropic.com
│
├─ Success? ─YES→ Return decision ✓
│
└─ Failure? ─→ [Log event to PCSF]
               {
                 provider: "claude",
                 status: "failed",
                 fallbackUsed: true
               }
               │
               ▼
            FALLBACK 1: GPT-4 (OpenAI)
            │
            ├─ API Call: /api.openai.com
            │
            ├─ Success? ─YES→ Return decision ✓
            │                  [Note: fallback used]
            │
            └─ Failure? ─→ FALLBACK 2: Gemini
                           │
                           ├─ Success? → Return ✓
                           │
                           └─ Failure? → FALLBACK 3: Ollama (local)
                                        │
                                        ├─ Success? → Return ✓
                                        │             [Reduced capability]
                                        │
                                        └─ Failure? → HOLD TRADE
                                                      Manual operator review

Final PCSF Receipt:
{
  decision_provider: "gpt4",
  primary_failed: true,
  fallback_chain: [
    { provider: "claude", status: "timeout", latency_ms: 5000 },
    { provider: "openai", status: "success", latency_ms: 2100 }
  ],
  claimed_boundary: "degraded_but_operational"
}
```

---

## 7. Risk Boundary Enforcement (Hard Stops)

```
Every trade must pass these checks. NO EXCEPTIONS.

┌────────────────────────────────────────────────────┐
│ PRE-EXECUTION VALIDATION GATES                     │
└────────────────────────────────────────────────────┘

Gate 1: PER-TRADE RISK
├─ Max loss = Account × 0.05
├─ Example: $10,000 account → Max loss $500 per trade
├─ CHECK: Claude's suggested stop loss
│         Position size × (entry - stop) × pip value ≤ $500
├─ PASS? → Continue
└─ FAIL? → REJECTED (Claude notified, trade held)

Gate 2: DAILY LOSS LIMIT
├─ Today's losses ≥ Account × 0.10?
├─ Example: $10,000 account → Stop trading after -$1,000 loss
├─ CHECK: Sum of closed P&L today + open position risk
├─ PASS? → Continue
└─ FAIL? → REJECTED (Emergency mode, no new trades)

Gate 3: SYMBOL CHECK
├─ Is symbol in approved list?
├─ EURUSD, GBPUSD, USDJPY, AUDUSD, NZDUSD → OK
├─ CADJPY, NZDCAD → NOT ALLOWED
├─ PASS? → Continue
└─ FAIL? → REJECTED (Symbol not approved)

Gate 4: SYMBOL DAILY LIMIT
├─ Max trades per symbol per day = 3
├─ Example: Already 3 EURUSD trades today?
├─ CHECK: Count open + closed EURUSD trades today
├─ PASS? → Continue
└─ FAIL? → REJECTED (Daily symbol limit reached)

Gate 5: MARGIN AVAILABLE
├─ Enough margin for this trade?
├─ Example: Position size 5000 EUR at 1.12345
│           Margin required: ~$562 (typical 1% margin)
├─ Available margin: $8,000?
├─ PASS? → Continue
└─ FAIL? → REJECTED (Insufficient margin)

Gate 6: TIME WINDOW CHECK
├─ Is this outside quiet hours?
├─ Quiet: Friday 17:00 UTC - Sunday 22:00 UTC
├─ Before major news? (Last 15 minutes allowed)
├─ CHECK: Calendar against trade time
├─ PASS? → Continue
└─ FAIL? → REJECTED (Outside safe trading window)

Gate 7: CONSENSUS SCORE
├─ All agents agree ≥ 60%?
├─ Example: Trend 72%, Momentum 68%, Vol 55%, Risk 100%, Strategy 80%
│           Average: 75% → PASS
├─ If any < 50% → HOLD (Manual review)
├─ PASS? → Continue
└─ FAIL? → REJECTED (Low agent confidence)

┌────────────────────────────────────────────────────┐
│ ALL GATES PASS? ✓                                  │
│ → Execute trade                                    │
│                                                    │
│ ANY GATE FAILS? ✗                                  │
│ → REJECTED                                         │
│ → Reason logged to JSONL                           │
│ → Operator notified                                │
│ → Manual review required                           │
└────────────────────────────────────────────────────┘
```

---

## 8. File Relationships (Dependency Graph)

```
                    server.js
                       │
         ┌─────────────┼─────────────┐
         │             │             │
    routes/        routes/        routes/
    dream.js       status.js   trading.js (NEW)
         │             │             │
         └─────────────┼─────────────┘
                       │
         ┌─────────────┼──────────────────────┐
         │             │                      │
      lib/         lib/               lib/
    dream-chat    status.js       trading-agents.js (NEW)
      .js          .js            trading-convergence.js (NEW)
         │         │              trading-risk.js (NEW)
         │         │
      ┌──┴─────────┴──────────┐
      │                       │
  lib/               lib/
stream-chat       csf-memory.js
  .js             
                       │
      ┌────────────────┼─────────────────────┐
      │                │                     │
  src/            src/               src/
convergence_io   csf/            trading/
/engine.py     memory_engine.py   (NEW)
      │                │
      └────────────────┼─────────────────────┐
                       │                     │
                    data/                 data/
                  csf_memory/            trades/
                   *.jsonl              *.jsonl
```

---

**This architecture diagram is a living reference.**  
Update as Phase 2 design progresses.

