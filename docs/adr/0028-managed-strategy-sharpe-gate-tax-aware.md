# ADR-0028: Managed-strategy mode — Sharpe-mandate acceptance gate, tax-aware management, contained execution

- **Status:** Accepted (operator approval given in-session, 2026-07-15)
- **Date:** 2026-07-15
- **Loop stage:** Reason (objective selection, gating) + Verify (mandate measurement, tax accounting)
- **Related:** ADR-0020 (trading guards), ADR-0022 (per-user IBKR), ADR-0027 (one-click broker OAuth2), PR #2514 (Advisor tab)

## Context

The operator has set a standing mandate for managed strategies: **target Sharpe ≥ 2 and manage taxes**.

What the evidence says about that mandate (2026-07-15 research pass, `F:\arxiv-corpus\pdfs\REVIEW-2026-07-15.md`):

- Our own 26-year walk-forward record ($20/mo, 2000→2026, no look-ahead) never sustained Sharpe 2.0 on
  any book: max-Sharpe tangency 0.64, max-return long-only 0.60, **2× margin + shorts 0.64** (leverage
  scaled return 13.4%/yr, not risk-adjusted quality — two-fund separation held exactly).
- The protocol-clean published ceiling for daily systematic strategies is ≈ 2.4 (VSN+LSTM on ~50 futures
  markets, arXiv 2603.01820) — it requires multi-asset breadth and ML sequence models, and still had a
  −3.68-Sharpe worst quarter. Single-asset claims above ~2.5 (e.g. 2511.08571) are unreplicated.
- On short windows even SPY's Sharpe CI includes 0 (measured 5y: 0.82 [−0.06, 1.70]). A Sharpe-2 *promise*
  is not honest; a Sharpe-2 *acceptance gate* with CI evidence is.

Meanwhile Robinhood now offers first-party agent access (Agentic Trading MCP, 2026-05-27): a **dedicated
agentic account** funded separately, push notifications per trade, real-time activity feed, one-tap
disconnect. That is the right containment shape for agent-managed capital — better than sharing the
operator's primary brokerage account.

## Decision

1. **The mandate is a gate, not a promise.** Every strategy/proposal reports measured Sharpe with a Lo-CI
   against the mandate (`KEYSTONE_SHARPE_MANDATE`, default 2.0) in three honest states:
   `meets_ci` (CI lower bound ≥ mandate) · `meets_point` (point estimate ≥ mandate, CI does not clear) ·
   `below`. **Only `meets_ci` strategies are eligible for live capital.** Everything else runs paper/dry-run.
   No strategy is promoted on backtest alone: promotion additionally requires the IS–WFA–OOS protocol
   (purged walk-forward, majority-pass, parameter lock — arXiv 2603.09219).
2. **Objectives are explicit.** The one analytics engine (`lib/portfolio-analytics.js`) supports
   `objective: "sharpe"` (default, shrunk tangency) and `objective: "max_return"` (maximize expected
   return subject to a volatility ceiling, long-only, per-position cap) — the true efficient-frontier
   point, not concentration heuristics. Surfaced on the Advisor tab, the REST routes, and the chat tools.
3. **Taxes are a first-class constraint.**
   - Buy-only flows (contribution planner, DCA) realize nothing — they remain the default posture.
   - Any proposal with SELL rows carries an **estimated realized gain and tax cost** (worst-case
     short-term rate by default, `tax_rate` overridable), so after-tax merit is visible before acting.
   - Turnover is treated as a cost everywhere; tax-advantaged wrappers (IRA) are recommended in UI copy.
   - Future work: tax-lot tracking (dates per lot) for LT/ST split and loss-harvesting suggestions.
4. **Leverage/shorting stays out of the product's recommendation surface for now.** The measured record
   shows levered tangency is the only evidenced route toward the mandate's return ambitions, but a 2×
   book's true drawdown is understated by monthly data (intra-month margin calls) and its turnover is
   tax-hostile. Phase 2 (env-gated, dry-run only): levered max-return proposals for **margin-approved,
   tax-advantaged or dedicated agentic accounts only**, once per-lot tax tracking and intra-day risk
   monitoring exist.

   **Phase-2 overlay spec (validated 2026-07-15, `experiments/leverage_overlay_opt2.py`):** leverage is
   never static — it is reset **daily** as `gross = min(2.0, 0.20/vol20d) × trendGate(6mo) × brake(dd>15% → 1×)`,
   where vol20d is annualized 20-day realized vol of the tangency direction. Tuned on 2000–2012 ONLY,
   validated untouched on 2013–2026 (Sharpe 0.97; the 15%-vol variant reaches 1.00 but surrenders the
   SPY beat — a real frontier trade-off, both recorded). Evidence, $20/mo walk-forward 2000–2026:
   final **$49,460 vs SPY DCA $38,604 (+$10,856)**, worst drawdown **−28%** (vs −51% static 2× and SPY),
   min Reg-T maintenance cushion +22.9% (never near a call). Stress: 1,000 two-year block-bootstrap
   paths built only from the four worst downturns (dot-com, GFC, COVID, 2022), starting $25k:
   **0/1,000 margin calls, P(ending < $10k) 1.6% vs 70.2% for static 2×**, median $15.6k vs $7.6k,
   worst path $6.4k vs $337. Conclusion encoded here: margin calls are not the binding risk at 2× with
   frequent rebalancing — wipeout-grade drawdowns are, and the daily overlay is what removes them, so
   **Phase 2 ships with the overlay or not at all**. Day-level corrections only (4:1 intraday PDT leverage
   is not simulatable from daily bars and is out of scope); taxes still unmodeled → dry-run/IRA/dedicated
   accounts remain the boundary; 27 configs were searched, so deflated-Sharpe skepticism applies at the
   margin (2603.09219).
5. **Execution containment.** Agent-managed live capital, when a strategy earns it, goes through a
   **dedicated account the agent can reach and nothing else** — Robinhood Agentic Trading MCP (equities
   beta) or an isolated IBKR sub-account — with operator-set deposit limits, per-trade notifications, and
   one-tap disconnect. All existing ADR-0020 guards remain; the Advisor and tools continue to place nothing.

## Consequences

- The mandate becomes measurable and enforceable instead of aspirational; users see exactly how far a
  strategy is from earning live capital, with CIs.
- Until a strategy clears the gate, the system's live posture stays what it is today: buy-only,
  long-only, diversified — the measured-best risk-adjusted retail configuration.
- Honest expectation set in UI copy: clearing Sharpe 2 with CI evidence likely requires multi-asset
  breadth (futures/systematic machinery we have not built) or long accumulation of live track record;
  the gate is expected to hold strategies in paper mode for a long time. That is the point.
- Robinhood MCP integration is future work gated on: operator opening an agentic account, a protected-path
  review (money), and the same dry-run-first discipline.
