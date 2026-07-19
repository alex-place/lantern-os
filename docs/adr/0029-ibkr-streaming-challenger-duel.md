# ADR-0029: The IBKR streaming Challenger — a return-seeking duel against the Champion on accurate intraday data

- **Status:** Proposed (awaiting Alex's approval)
- **Date:** 2026-07-19
- **Loop stage:** Act (streaming risk reaction + paper execution) + Verify (duel measurement)
- **Related:** ADR-0019 (IBKR CPAPI via local gateway), ADR-0020 (order placement, gated, dry-by-default — still Proposed), ADR-0022/0027 (per-user broker auth), ADR-0028 (Sharpe mandate gate — unchanged by this ADR), `apps/lantern-garage/lib/brake-monitor.js`, `apps/lantern-garage/lib/champion-book.js`, `apps/lantern-garage/lib/kalshi-adaptive-poll.js`, `experiments/DEEP_HISTORY_RESEARCH_LOG.md`, PR #2744 (the monthly Leap report, where the duel scoreboard will publish)

## Context

The operator asked for **a real-time / streaming trader on IBKR designed to beat the Champion in
returns, using more accurate historical data**.

The incumbent ("the Champion"): the 8-ETF shrunk-tangency book (SPY/QQQ/IWM/EFA/TLT/GLD/XMMO/SPMO)
× the streaming brake (35% vol-target × 6-mo trend gate × −30% dd-taper, gross 0–2×), marked on a
$25k paper book and deployed dry on Alpaca paper. Walk-forward 2000→2026-07: **$91,537 on $8,380
paid in, 12.6%/yr, Sharpe 0.65, maxDD −25.5%** (run 2026-07-17).

Σ₀ discipline first: **"beats the Champion" is a hypothesis, not a design property.** This ADR
designs a challenger plus the duel that would prove or refute it. Every expected gain below is
pre-registered as an estimate, to be measured, with a fold path if it fails.

**Measured facts this design stands on (receipts):**

1. **Reaction lag is a real, measured return leak.** The hourly brake beat the daily brake
   **$51,355 vs $47,077** over 2.5y at *identical turnover* (Sharpe 1.32 vs 1.18, maxDD −19.8% vs
   −22.2%), and de-levered **71 hours earlier** on the worst crash day in the window
   (`experiments/brake_intraday_evidence.json`). Faster, accurate reaction has already paid once;
   the challenger buys the residual minute-scale slice.
2. **The current model's frictions are cruder than reality — in both directions.**
   `brake-monitor.js` charges a **flat 3% T-bill proxy** (`BRAKE_TBILL_RATE` default) and a **flat
   T-bill+150bp funding spread**; real 2026 bill ETFs yield materially more than 3%, and IBKR
   publishes an actual tiered margin schedule. Cash-yield and funding accuracy are *mechanical*
   return deltas — the truth may help or hurt, and either way the Champion's book gets truer.
3. **Accurate history is buyable; free intraday is not trustworthy.** Yahoo intraday equity bars
   have measured corrupt wicks (we clamp per-side vs 4× median). Full-history, split/dividend-correct
   **minute** aggregates exist (Polygon, back to ~2003, ~$29/mo); **survivorship-free** daily exists
   (Sharadar, ~$30/mo). The Champion was tuned on Yahoo *daily* adjclose — fine for its ETF universe,
   blind at intraday horizon.
4. **Retired paths stay retired unless new evidence appears.** Single-stock 12-1 momentum on
   survivorship-clean data measured **Sharpe 0.60 ≈ SPY, below the Champion's 0.66 — not an
   upgrade** (2026-07 sweep). Gross above 2× was rejected by the deep-history study (worse Sharpe,
   3× the trades, margin risk; iters 1–2). Neither returns here.

## Decision (proposed)

Build **the Challenger**: the Champion's allocation core, unchanged, plus exactly three upgrades,
run on IBKR paper, in a formal duel.

### 1. True streaming signal plane (Act)

- Market data from **IBKR CPAPI via the local gateway** (ADR-0019): websocket streaming (or 5s REST
  polling fallback through the existing `ibkr-cpapi.js` client) for the 8 ETFs.
- Evaluation cadence goes **send-on-delta**: reuse `kalshi-adaptive-poll.js#createScheduler`
  (β/σ² control-engineering cadence, floor 5s, cap 60s) instead of the fixed 60s clock — evaluate
  when prices actually move, sleep when they don't.
- Intraday realized-vol estimator: gap-aware EWMA over minute returns blended with the 20d daily
  window (the brake's tuned thresholds keep their daily calibration; the estimator just stops being
  a day late). **Trend gate and dd-taper are unchanged** — they are the validated core.
- If IBKR market data is unavailable, the Challenger **halts and marks the gap** — it never falls
  back silently to Yahoo intraday (known wick corruption).

### 2. Accurate frictions, both directions (Act + Verify)

New pure module `funding-model.js`:
- **Borrow side:** IBKR's real tiered margin schedule, pulled live and cached, charged in both
  backtest and live marking (replaces flat +150bp).
- **Cash side:** de-levered cash modeled as swept to a bill ETF (BIL/SGOV) at its real yield
  (replaces flat 3%).
- **Fills:** slippage model calibrated from the Challenger's own paper fills once live (starts at
  the backtest's 2bp assumption, updated monthly).

### 3. Accurate history for tuning and verdicts (Verify)

- **Walk-forward substrate:** minute-level, dividend/split-correct bars 2004→present (Polygon flat
  files). Tune ONLY on 2004–2015; validate 2016–2026; no peeking.
- **Survivorship cross-check:** Sharadar daily (optional until any single-name work returns — the
  8-ETF universe has no delisting exposure, stated honestly).
- **Seam reconciliation:** IBKR's own historical bars must reconcile Polygon's last 6–12 months so
  the backtest's data equals the live pipeline's data at the boundary.
- The Champion keeps its own production pipeline (Yahoo daily) in the duel — each book fights with
  the data it actually runs on.

**Non-goals:** no new alpha sleeve; no gross > 2.0×; no change to turnover character (the band and
~monthly rebalance cadence stay — streaming changes *risk reaction speed*, not trading frequency;
day-trade-pattern behavior is explicitly out); **no live capital** (Phase C below is unchanged
ADR-0028).

## The duel protocol (Verify)

| Phase | What | Win condition |
|---|---|---|
| **A — backtest duel** | Minute walk-forward 2004→2026, both premises ($25k book; $2k+$20 DCA), Challenger vs Champion-as-is | Higher final value AND maxDD ≤ Champion's AND block-bootstrap ΔCAGR/ΔSharpe CI excludes 0 AND survives TC 2–20bp and data-vintage sensitivity (pattern: `deep_history_significance.py` / `deep_history_tcost.py`) |
| **B — live paper duel** | ≥ 3 months side-by-side: Challenger on IBKR paper (DU account) vs Champion on Alpaca paper; daily marks to `data/trading/duel/duel-ledger.jsonl` | Phase-A ranking reproduced in sign; scoreboard published monthly in the Leap report |
| **C — real dollars** | Unchanged **ADR-0028**: live `meets_ci` vs the 0.79 lifetime-Buffett bar, protected paths, a human clicks | Nothing in this ADR loosens any gate |

**Pre-registered expected sizes** (estimates, not results): reaction-lag residual 0–1%/yr (the
hourly step already captured ≈ +1.5%/yr relative in its window; minute-scale marginal gain may be
small); cash-sweep accuracy ≈ +0.4–0.5%/yr at the Champion's historical average cash fraction;
funding accuracy sign unknown until the real schedule is pulled. **Net target: +1–3%/yr at ≤ equal
drawdown.**

**Honest exits (the fold path):** if Phase A shows < +0.5%/yr expected lift, or Phase B contradicts
Phase A's sign, the Challenger folds: the funding/cash-sweep corrections are adopted into the
Champion (they are model-accuracy fixes, not strategy changes), the streaming cadence is retired as
measured-negative, and the data subscriptions are cancelled. A negative verdict is a publishable
result, not a failure of the project.

## Architecture (extend, don't sprawl)

```
ibkr-stream.js (new, thin)        ws/5s ticks for 8 ETFs via ADR-0019 gateway
        │
brake-monitor.js (extended)       injectable tick source + send-on-delta scheduler
        │                         (kalshi-adaptive-poll.createScheduler) + funding-model.js
        ▼
challenger-book.js (new)          mirrors champion-book.js: SAME targetWeights /
        │                         computeRebalance imports; IBKR adapter conforming to
        │                         alpaca-adapter's interface over ibkr-cpapi.js;
        │                         PAPER-ONLY hard refuse; ADR-0020 guard untouched;
        │                         CHALLENGER_ARM env mirrors CHAMPION_ARM (default dry)
        ▼
data/trading/duel/duel-ledger.jsonl   daily marks, both books, append-only (gate-scoreable)

experiments/challenger_minute_walkforward.py   Phase A harness (train 2004-15 / validate 2016-26)
```

Feature-gate check: improves **Act** (reaction accuracy, execution realism) and **Verify** (truer
frictions, truer data, a scored duel). No new memory systems, no new agents, no parallel strategy
engine — the allocation math is imported from the Champion, not forked.

## Costs

Polygon minute history ~$29/mo + Sharadar ~$30/mo (deferrable) + IBKR paper $0 (live market-data
subscriptions only if/when Phase C ever arrives). **≤ ~$60/mo during the duel, cancel-on-fold.**

## Risks

- **IBKR gateway fragility.** Local-gateway session drops; local owner creds were stale as of
  2026-07-14 (`lst_signature_mismatch` — only Alex can refresh). Mitigation: REST 5s fallback,
  halt-and-mark on data loss, duel clock pauses rather than fabricates.
- **Intraday overfitting.** Mitigation: three upgrades only, tuned thresholds inherited from the
  daily-validated brake, train/validate split, deflated-Sharpe + bootstrap CIs, pre-registered
  targets written here before any run.
- **Marginal-gain illusion.** Minute-over-hourly may add ~nothing; the fold path treats that as a
  clean verdict and still banks the friction-accuracy fixes.
- **Two data planes, one seam.** Polygon-vs-IBKR reconciliation is a hard requirement, not a nice-
  to-have; unreconciled seams void Phase A.

## Consequences

- (+) The Champion's own book gets truer funding/cash numbers regardless of who wins.
- (+) The IBKR execution path (ADR-0019/0020) gets exercised end-to-end on paper, de-risking any
  future approval of ADR-0020.
- (+) The monthly Leap report gains a live duel scoreboard — a user-visible, honest race.
- (−) ~$60/mo data spend for the duel's duration; one more long-running process on the fleet host.
- (−) If approved, ~3 modules + 1 experiment harness of new code to maintain (mitigated by reuse of
  the Champion's math and the existing scheduler/client).
