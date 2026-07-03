- **Removed the Python trading subsystem + Alpaca entirely.** Deleted
  `src/trading_agents/` (the 9,448-line `agents.py` autonomous trader, `cli.py`,
  `trading_tesseract.py`, `convergence_ev.py`, `price_watcher.py`), the
  `ai-trader-*.py` bridges, `scripts/start-ai-trader.js`, and the port-5050 trading
  microservice (`start-trading-service.js` + `lib/trading-service.js`). Ripped the
  boot-time spawns out of `server.js` and the Python-subprocess machinery + Alpaca
  credentials out of `trader-agent.js` / `trading-api-bridge.js` / `routes/trading.js`.
  The trader now runs 100% in Node: signals from `lib/signal-engine`, market data
  from keyless Yahoo, broker from the IBKR Client Portal gateway, order placement
  gated dry-by-default. Docs (`trading-api-reference`, `TRADING-VALIDATION`,
  `TRADING-NORMIE-UPDATE`, `IBKR-API-SETUP`), `.env.example`, and `Set-TradingKeys.ps1`
  updated; obsolete Python trading tests removed. Phase 4 (final) of the port.
