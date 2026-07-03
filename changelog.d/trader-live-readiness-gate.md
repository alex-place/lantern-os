### Added — Real-money readiness card + live-trading safety gate

The paper→real-money decision is now surfaced and enforced.

- **Readiness card** in the Keystone Stock Trader header (`stock-trader.html`), next to the
  ON/OFF button: shows **Live-ready: READY/NO** with a tooltip breaking down the four criteria
  vs their thresholds (trades ≥20, days active ≥30, win-rate ≥55%, Sharpe ≥1.0). Backed by
  `GET /api/trading/ai-trader/readiness` → `trader-agent.getReadiness()` → new `cli.py graduation`
  action → `get_graduation_analysis()`.
- **Live-trading gate** (`agents.py resolve_alpaca_base_url`): the broker client is PAPER by
  default; switching to real money requires **both** an explicit `ALPACA_LIVE=1` opt-in **and**
  a passing readiness assessment. Not opted in, not ready, or any error → stays on PAPER, logged
  CRITICAL. The orchestrator imports the same gated client so paper-vs-live can never disagree.

Current readiness (measured 2026-07-02): **NOT ready** — 104 trades ✓, Sharpe 3.17 ✓, but 19/30
days and 36.5%/55% win-rate. Real-money safety lives in code, not config.
</content>
