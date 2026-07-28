# IS-WFA-OOS strategy validation: the harness, its gates, and Lean vs. ours (#2582)

**Date:** 2026-07-28 · **Status:** module landed (`experiments/lib/walk-forward.js`, tested); Lean adoption evaluated and deferred with reasons.

## The problem #2582 names

`experiments/trader_walkforward.js` proves the live signal engine has **no bar-by-bar look-ahead** — at bar *t* only bars `[0..t]` are visible. That is necessary but not sufficient. It still **optimizes and reports on one window**: the stop-width sweep (`atr2/3/4`) is chosen over the *same* ~30 days it is scored on, so the winning multiple is an in-sample fit. The question that actually gates capital is *"does a rule chosen on the past hold on data it never saw,"* and the standard answer is **walk-forward analysis (WFA)**.

## What landed

`experiments/lib/walk-forward.js` — a reusable IS-WFA-OOS engine, decoupled from any strategy or data source (`bars`, `simulate(bars, params) → trades`, the param `grid`, and the `score` objective are all injected; no network, no broker, no app import):

- **`makeFolds(total, isBars, oosBars, anchored)`** — sequential folds whose OOS segments **tile the series with no overlap and no gaps** (every out-of-sample bar scored exactly once). `anchored` = growing IS from 0 (anchored WFA) vs a fixed-width sliding IS (rolling WFA).
- **`walkForward(cfg)`** — for each fold: **optimize params on the IS window only**, then evaluate the chosen params on the **immediately-following OOS** segment the optimizer never saw. The concatenated OOS trades are the one honest track record; **Walk-Forward Efficiency** (OOS score / IS score) says how much fitted edge survived.
- **Pre-committed gates** (`DEFAULT_GATES`) — a strategy passes only if ALL hold: `minFolds ≥ 3`, `avgWFE ≥ 0.5` (half the IS edge survives OOS), `oosProfitFactor ≥ 1.0`, `positiveOosFraction ≥ 0.5` (the edge shows in a majority of folds, not one lucky one), `maxOosDrawdown ≤ 25%`. Stated up front so a disappointing run cannot move the goalposts — the same discipline the Σ₀ eval ledger imposes on model marks.

Tested (`experiments/lib/walk-forward.test.js`, 9/9): fold tiling (anchored & rolling), the cross-fold no-look-ahead invariant (OOS always strictly after its IS), optimize-on-IS/evaluate-on-OOS, an edge that inverts OOS is caught (negative WFE, gate fails), a robust edge passes, and the OOS record is a strict subset of the series (never leaks IS).

## Lean vs. ours — the adoption decision

QuantConnect **Lean** ships a mature WFA/optimization stack (`OptimizerNodePacket`, walk-forward via the CLI, parameter sweeps, a full backtest engine with corporate-actions/borrow/slippage models).

| | Lean | this module |
|---|---|---|
| WFA folds + optimize-on-IS | ✅ built-in | ✅ `walkForward` |
| Pre-committed pass/fail gates | ✋ you script them | ✅ `DEFAULT_GATES` in-repo |
| Strategy under test | Lean `QCAlgorithm` (C#/Python, rewrite) | the **existing** JS `simulate` (signal-engine, kalshi, …) as-is |
| Data | Lean's data feeds / subscriptions | whatever bars you pass (Yahoo, cached, synthetic) |
| Fills / costs / borrow | rich, realistic models | the caller's `simulate` owns them (today: 0.10% round-trip, next-bar-open) |
| Runtime footprint | full engine (.NET/Docker) | one zero-dep Node file, unit-tested |

**Decision: extend ours now; keep Lean as the escalation for realism, not methodology.** The methodology gap (#2582) is *walk-forward discipline + committed gates*, and that is what this module adds directly over the strategies we already run — with no rewrite of the signal engine into a Lean `QCAlgorithm` and no .NET/data-subscription dependency. Lean's genuine edge is **execution realism** (borrow, corporate actions, richer slippage), which matters when a rule has *passed* WFA and needs a higher-fidelity fill model before capital — that is the point to spike Lean, not before. Adopting Lean to get walk-forward would import a large runtime to replace ~150 lines and still require scripting the gates by hand.

## Follow-on

- Wire `trader_walkforward.js`'s `simulateSymbol` in as the `simulate` callback so the stop-width sweep runs through `walkForward` (needs the Yahoo fetch, so it stays a networked experiment, not a unit test).
- The pre-committed gate thresholds are defaults; calibrate `minAvgWfe` / `maxOosDrawdown` against a few real strategies before treating a pass as a green light.
