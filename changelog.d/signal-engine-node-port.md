- **Trader signal engine ported to Node (no Python, no Alpaca in the scan path).**
  The support/resistance zones + technical signals on the stock trader
  (`/api/trading/zones`, the 60s autoscan) now run in-process from keyless Yahoo
  bars via a new `apps/lantern-garage/lib/signal-engine/` (SR zones, adaptive RSI,
  candle patterns, market-structure, TradingTesseract, convergence-EV) — a faithful
  Node port of the deterministic "Riley" TA from `src/trading_agents/agents.py`.
  A full watchlist scan now completes in ~1–2s instead of the old 45–60s
  Python→Alpaca subprocess, and no longer fails when Alpaca keys are absent.
  Autonomous decisioning is left to the Σ₀ council (follow-up), not a re-created
  LLM loop. Phase 1 of the Python-trader removal.
