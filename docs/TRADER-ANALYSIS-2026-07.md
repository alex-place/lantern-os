# unisona.ai Trader — Deep Analysis, Competitive Comparison, and Improvement Plan

## 1. Executive Summary

The unisona.ai "trader" is a **Kalshi-prediction-market-centric swipe-deck + sizing + risk stack** (with secondary IBKR stock and ForecastEx paths), built as ~40 plain-Node `kalshi-*` modules behind `routes/trading.js` and the `kalshi-terminal.html` UI. It is best understood as **two systems wearing one coat**: (a) a genuinely rigorous *fair-value + money-management* core — an exogenous NWS/MOS weather model, a correct Kalshi fee model, and ask-based half-Kelly behind a multi-gate stack; and (b) a *microstructure/momentum + "convergence ML"* layer that ranges from unproven to outright non-functional.

- **Single biggest strength:** The **weather fair-value family is a real, price-independent informational edge**, and the money-management discipline around it is better than most open-source competitors — half-Kelly is sized against the **executable ask net of the real fee**, not a mid or model price (`kalshi-kelly.js:45-53`, `kalshi-fees.js:80`), and the weather oracle is genuinely calibrated out-of-sample (`weather-oracle-params.json`: n=1818, meanRPS 0.0309 fitted vs 0.0504 default, +38.6%; PIT chi² 6.36 vs 93.98).
- **Single most dangerous weakness:** **Real live orders have flowed to the exchange with no demonstrated net-of-fee edge and no realized-PnL tracking.** `data/kalshi/kalshi-live-ledger.jsonl` holds 66 `mode='live'`/`environment='prod'` submissions (29× HTTP 201 accepted) and **not one row carries a PnL or settlement field** — while the two backtests that could prove a fee-inclusive edge (`kalshi_pnl_backtest.py`, `kalshi_maker_backtest.py`) cannot even run because their input captures are absent ("No crypto-tight-band files found."). The one headline number, **61.3% crypto direction (`cio-train-report.json`: 65/106, avg_edge 0.3112)**, is in-sample, direction-only, and — at the real ~68¢ entry price — **negative EV** (0.613·32 − 0.387·68 ≈ **−6.7¢/contract before fees**).
- **One-line verdict:** *Promising research stack with a real weather edge and unusually honest money-management, but the traded edge is unproven out-of-sample net of fees, several risk gates are dead, and live orders have already fired — it is **not safe to size up live** until an OOS, fee-inclusive, settlement-graded edge exists.*

> Note on "paused" status: external research described the trader as self-paused via a `data/kalshi/TRADING-PAUSED` kill file. **That file does not exist in this checkout** — the structural protection that is actually live is the 7-gate dry-run boundary and the 1-contract cap, not a pause flag.

---

## 2. What It Does Well

These are genuine, verified strengths — not marketing.

**2.1 A real, price-independent weather edge.** `kalshi-weather-edge.js` builds a calibrated distribution of the daily-high ladder from an *exogenous* NWS/MOS forecast (`kalshi-mos.js`) and fires only on rows that survive the **entire** sigma/mean calibration band net of fees (`robustEdgeReport`, `worst_c` gate, `weather-edge.js:206`). Because the settlement source *is* the prediction source (NWS CLI Central Park), the fair value is price-independent by construction. The oracle fit is real and validated OOS: `weather-oracle-params.json` n=1818 pairs, meanRPS 0.0309 fitted vs 0.0504 default (**+38.6%**), PIT chi² 6.36 vs 93.98 on n=723. It correctly *stands down on efficient days* — the right output.

**2.2 Edge is always measured against the price actually paid, net of the real fee.** `kalshi-fees.js` prices Kalshi's `0.07·C·P·(1−P)` schedule (peak ~1.75¢/contract at P=0.50), uses the unrounded fraction for EV gating and round-**up** for real cost, and pushes a 50¢ contract's breakeven to ~51.75% win-prob (`kalshi-fees.js:44-74`). `bestSideNet` / `netEvCents` subtract the real ask and fee — no mid-price self-deception. The module explicitly encodes the "win 53% and still lose" trap (`kalshi-fees.js:6-8`).

**2.3 Principled, non-degenerate sizing.** `kalshi-kelly.js` uses **half-Kelly against the ask, folding the entry fee into win-prob before sizing** (`:49`, `q_net = q − feeFraction(askCents)`), then caps at 10% of bankroll, 25 contracts, and a liquidity haircut that never takes >25% of resting size (`:26-34, 120-128`). Self-test passes. This is a *more* variance-aware bet than stock Freqtrade (fixed stake) or the OSS Kalshi bots that size off mid/model price (OctagonAI, ryanfrigo, Viprasol) — a systematic over-sizing bug this stack avoids.

**2.4 A safe-by-default live boundary enforced in code, not trust.** `kalshi-api.js placeOrder` (`:249-303`) AND-gates **seven** independent conditions before any real order — `KALSHI_TRADING_ENABLED==='1'`, an admin feature-flag, absence of the kill-switch file, credentials, a source allowlist (default `kalshi-weather-edge` only), a server-side ticker/source cross-check (KXHIGH* only), and per-order `confirmLive:true` — then clamps to `liveMaxContracts` (default **1**). Anything failing falls to a dry-run ledger. The UI hard-codes `count:1` behind a `window.confirm` (`kalshi-terminal.html:1352`). There is **no autonomous Kalshi execution** — the position-monitor only marks `readyToClose` and leaves the close to the user (`kalshi-position-monitor.js:136`).

**2.5 Honest degradation and honesty boundaries are coded throughout.** The calibrator degrades to identity under n<20 (`kalshi-calibration.js:98`); the grounded event-suggester refuses to claim edge on knowledge-only estimates and defers to the market (`kalshi-event-suggester.js:84-101`); `kalshi-edge.js` returns `{grounded:false}` when there's no web-grounded probability (`:39`); the MLB model states its own boundary — a tilt is mostly already priced, so it only flags wind/roof/temp tails (`kalshi-mlb-weather-model.js:11-29`); and `kalshi-suggest.js` hard-excludes the two market structures no model here can value (KXMV* parlays, range-band markets) at `isSupportedEntryMarket` (`:67`).

**2.6 Two methodologically-sound ML/backtest components exist.** `train_cio_kalshi.py` splits **by ticker** (held-out paths genuinely unseen, `:94-99`), uses an explicit persistence baseline (dp=0, `:147`), and only claims success if `model_rmse < baseline*0.999`. `kalshi_council_train.py` replays the *same* momentum signal (no invented second model), settles against real resolutions, sweeps configs for net-after-fee PnL, and defaults to a **"NO PROVEN EDGE"** verdict unless ≥0.5¢/trade over n≥100 (`:274-288`). This is the correct spirit — it's just not *run* in this checkout (input files absent).

---

## 3. The Core Problem: Is the Edge Real?

**Short answer: no edge is measured out-of-sample, net of fees, against true settlement anywhere in the files.** Every performance claim is either in-sample, unmeasured (empty PnL ledger), or the input data is missing.

**3.1 The 61.3% number is not what it looks like.** `cio-train-report.json crypto15m_eval` = **accuracy_direction 0.6132, 65/106 signals, avg_edge 0.3112** (verified). Its true status:
- **Direction-only** — not net of the 7% fee, not net of the real entry price.
- **In-the-loop walk-forward but in-sample** — outcome/`correct` labels are computed over the same observed windows; it's a single ~11-hour window (2026-06-14/15).
- **Written by `experiments/crypto_live_trader.py`, not the ML layer** — it reflects the deterministic OLS momentum model, whose p* is certified `{0,1}` by pure momentum extrapolation (`kalshi_cio_backtest.py:134`), so the model **only fires after price has already moved**. Real paper entries sit at a **median 68¢, not the 50¢ the ledger math assumes**.
- **At 68¢ entry, 61.3% is a losing strategy:** 0.613·(100−68) − 0.387·68 ≈ **−6.7¢/contract gross, before fees.** Profitability hinges entirely on a win-rate estimated from ~100 samples that itself disagrees 61%→72% between the report and the ledger reconstruction.

**3.2 The paper ledger cannot adjudicate this — its PnL field is hardcoded-broken.** In `crypto_live_trader.py:123`, both the win and loss branches of `pnl_pct` evaluate to +1.0 for exit∈{0,100}, so **every** close logs pnlPct=+100% regardless of outcome (measured avg pnlPct=1.0 across all matched closes). Accuracy is also **survivorship-filtered**: of 194 closes only 100 RESOLVED carry a `correct` label; 81 EXPIRED + 13 STOP-LOSS (48%) are silently excluded, and the "outcome" itself is a *final-observed-mid ≥ 0.92* proxy, not actual Kalshi settlement.

**3.3 The honest backtests that would settle it cannot run.** `kalshi_pnl_backtest.py` and `kalshi_maker_backtest.py` both charge the real `ceil(0.07·p·(1−p)·100)` fee, compare against bet-favorite/always/random baselines, and (maker) model adverse-selection fills — but both print **"No crypto-tight-band files found."** because their `crypto-tight-band-*.jsonl` inputs are absent (0 files). The council backtests are n=0/NOT RUNNABLE. So the only measured trading numbers in the repo are the broken ledger and the in-sample CIO report.

**3.4 The "convergence ML" layer is largely theater.** `kalshi-convergence-lora.js` makes predictions with **`Math.random()`** (`:269-270`, verified), its `finetuneModel()` is a stub with the real call commented (`:294-326`), and its training **label is a hand rule over the *current* spread/time/price**, not a realized outcome (`getConvergenceTarget:222-233`) — 96% positive (10,840 target=1 vs 409 target=0), 26 fake cycles logged. The enhancer's "web search" is a static hardcoded dict (`:186-200`) and its input file doesn't exist. This is a **closed self-referential loop** that can only entrench a heuristic while presenting escalating cycle counts as progress. It runs 24/7 from boot (`server.js:797`).

**3.5 The microstructure deck has no informational edge, and its protective gate is inert.** `kalshi-suggest.js` picks a side from the live tick, ties broken by spread; "fair value" is the market's own bid/ask **mid** and the ±5% bound is off that mid (`:153-160`), and `conviction` is explicitly "NOT a probability" (`:347`). For the default series KXMLBGAME, `getCategoryStats('other')` is null, so the negative-EV suppression never fires and confidence is hardcoded 0.25. **Worse, `kalshi-crypto-suggester.js` gates on win-rate only** — `winRate < 45` is the sole guard (`:70-71, :179-180`, verified) — **while ignoring expectancy, and its own ledger shows crypto at 54% win-rate but −45¢/trade expectancy** (avgProfit 1¢ vs avgLoss 100¢). Its "convergence-profit" card buys the 80–90¢ favorite to "collect the spread to 100¢" (`profitCents = 100 − favAsk`, `conviction: favAsk`, `:134,154`) — the classic short-premium trap: fair value **is** the market ask, so there is no independent information and the skew is fully negative.

**Verdict on §3:** The weather family is a real edge that correctly abstains most days; **everything crypto/momentum/convergence is unproven or negative-EV**, and no component has an OOS, fee-inclusive, settlement-graded track record. The look-ahead *discipline* is genuinely good (signals see only `traj[:i]`); the problem is not leakage, it's that **the measured edge doesn't survive the real entry price and fee.**

---

## 4. Where We Stand vs the Field

| Capability | Our trader | Best-in-class OSS | Gap |
|---|---|---|---|
| **Backtest rigor / overfitting guards** | No walk-forward split, no Deflated Sharpe / PBO, single-window; constants (EDGE=0.08, WINDOW) fit & tested on one set. *But* honest baselines (bet-favorite/random) + no-look-ahead by construction | Freqtrade `lookahead-analysis` + `recursive-analysis` CLI; Jesse Monte-Carlo + Optuna CV; DSR/PBO/CPCV canon (Bailey–López de Prado) | **Large.** No automated bias detector, no OOS/CV machinery, no multiple-testing correction |
| **Execution / data architecture** | 6s REST poll of *one* series (KXMLBGAME); no WebSocket; no fill confirmation; no order-id capture; no idempotency (fresh UUID per call → 7× HTTP 409 in ledger) | NautilusTrader event-driven WS core, deterministic replay, reconciliation (trade_id dedup, overfill), own-order-book; Kalshi WS `orderbook_delta`+fill channel exists | **Large.** Poll-only, no reconciliation, double-order risk |
| **Risk engine** | Ask-based half-Kelly net of fee (**ahead**); 7-gate live boundary + 1-contract cap (**ahead**). *But* drawdown gate dead (`weather-edge-deck.js:71` never sets `drawdownFrac`), concentration gate blind to held positions (`:217`), no portfolio-level exposure/daily-loss cap, cash gate a no-op (`kalshi.js:556` reads absent `o.price`) | Nautilus mandatory pre-trade RiskEngine (max-notional, cash-impact, rate-limit, typed denials); OctagonAI 5-gate incl. correlation clusters + daily-loss + max-positions | **Mixed.** Sizing math ahead; *portfolio-level* controls behind & several gates dead |
| **Market-making / fee sign** | Taker-only → eats ~1.75¢/contract every trade (the reason no edge survives). Maker backtest exists but no live maker | ryanfrigo rests limit 1¢ inside ask (maker); Hummingbot A&S reservation-price + inventory skew; **Kalshi pays maker rebate + LIP** | **Large & high-ROI.** Flipping taker→maker flips the fee sign |
| **Strategy framework** | ~40 bespoke single-purpose modules; no unified signal→executor abstraction; convergence "ML" is mock | Freqtrade one-class-four-modes parity; Hummingbot V2 Controllers/Executors; Nautilus Actor/Strategy | **Medium.** Bespoke & lean, but no research↔live code-path parity |
| **Prediction-market specifics** | **Ahead of the field here:** correct Kalshi fee curve, ask-netted Kelly, a *closed* forward-calibration loop design, NWS/MOS + MLB fundamental priors, defense-in-depth dry-run boundary | OctagonAI/ryanfrigo (LLM P(YES) + Kelly, but size off mid/model price, fees not folded into breakeven, calibration never fed back); Polymarket/agents (RAG, thin risk) | **We lead** on fee/Kelly correctness & the calibration-loop *design*; the loop is currently **inert** (n=0 settled, Brier=null) |
| **Alpha source** | Genuine exogenous weather edge (n=1818, +38.6% RPS) — a source the price/TA-based field doesn't contemplate | Freqtrade/Hummingbot edges are price/TA/orderbook-derived | **We lead** on the weather niche |

**Fair read:** In the **narrow Kalshi + weather + fee-aware-Kelly niche we are genuinely ahead of the OSS field** on money-management correctness and on having a real exogenous signal. We are **behind on the entire research-to-live rigor spine** (OOS validation, event-driven execution, reconciliation, market-making, portfolio risk) that Freqtrade, NautilusTrader, and the quant canon treat as table stakes.

---

## 5. Prioritized Improvement Plan

### P0 — Correctness / Safety (could lose real money or is untrustworthy)

| # | Change | Why | Effort | Borrow from |
|---|---|---|---|---|
| P0-1 | **Halt live submission until an OOS net-of-fee edge exists.** Reinstate a kill-file (or flip `KALSHI_TRADING_ENABLED` off) — the assumed `TRADING-PAUSED` file is *absent*. | 66 live orders fired with zero PnL tracking and no proven edge (`kalshi-live-ledger.jsonl`). | S | OctagonAI/our own dry-run boundary |
| P0-2 | **Add realized-PnL + settlement logging to both ledgers; log distinct events per outcome** (submitted/rejected/timeout) and capture `res.data.order.order_id`. | Ledger conflates 37 rejects with "submitted", carries no order_id → un-reconcilable (`kalshi-api.js:300-302`). | S | Nautilus FillReport/reconciliation |
| P0-3 | **Fix the crypto-suggester gate: replace win-rate-only with fee-aware expectancy** (`isPositiveEv`/`netEvCents`); suppress any category with expectancy ≤ 0. | Its own ledger shows crypto 54% win / **−45¢/trade** yet cards still show (`kalshi-crypto-suggester.js:70-71`). | S | `kalshi-fees.js` (already in repo) |
| P0-4 | **Drop the "convergence-profit" favorite card** (or require independent grounded P(YES) > ask net of fees). | Buying the 80–90¢ favorite is trading the market's own price with negative skew (`:134,154`). | S | — |
| P0-5 | **Cut or clearly label the mock convergence layer** (`-lora` `Math.random`, `-enhancer` static dict, `-trainer` broken EV); remove boot calls at `server.js:796-797`. | Non-functional code presented as a live learning model; self-referential synthetic-label loop. | S | — (delete) |
| P0-6 | **Fix the broken paper-ledger PnL formula** (`crypto_live_trader.py:123`): `gross=(100−entry) if win else −entry; net=gross−fee`. | Every close currently logs +100% regardless of outcome → no valid realized PnL anywhere. | S | — |
| P0-7 | **Revive the dead risk gates:** thread real session `drawdownFrac` and ledger-derived `openInGroup` into the deck ctx; add a **portfolio-notional cap + aggregate daily-loss halt** at the order endpoint; fix the no-op cash gate (`kalshi.js:556` → read `limitCents*count`). | Drawdown breaker can never fire; concentration blind to held positions; no portfolio cap; cash check always passes. | M | Nautilus RiskEngine; auto-trader's 2% daily-loss breaker |
| P0-8 | **Add order idempotency + post-submit reconciliation.** Deterministic `client_order_id` from (ticker,side,action,count,limit,source,time-bucket); on startup/timeout query `getOrders`/`getFills`. Stop blind auto-confirm of IBKR warnings (`ibkr-cpapi.js:447-450`). | Fresh UUID per call → double-order risk (7× HTTP 409 observed); timed-out fills are invisible. | M | Nautilus trade_id dedup / reconcile |

### P1 — Make the Edge Provable

| # | Change | Why | Effort | Borrow from |
|---|---|---|---|---|
| P1-1 | **Regenerate the crypto-tight-band captures and actually run `kalshi_pnl_backtest.py` / `kalshi_maker_backtest.py`.** Report **net-of-fee EV/contract at the real fill price**, not direction accuracy. | The only honest fee-inclusive backtests exist but have no input; the 61.3% number is negative-EV at 68¢. | M | (in-repo, unblock inputs) |
| P1-2 | **Walk-forward / OOS wrapper + Deflated Sharpe + PBO.** Fit thresholds on a train window, score only the untouched next window; add DSR column to `daily-backtest-harness.js summarize()` (it already knows trial count + skew/kurtosis). | Constants are fit & tested on one set; ~10 sleeves selected → un-deflated multiple-testing. | M | Freqtrade lookahead/recursive-analysis; Bailey–López de Prado DSR/PBO; Jesse Monte-Carlo |
| P1-3 | **Close the calibration loop for real.** Stamp `pPredicted` through paper open/close writes so `gradedPairs` populates; then re-verify Brier/bias before claiming the loop is closed. Add Brier + reliability diagram to `cio-accuracy-log.jsonl`. | The advertised differentiator is currently identity/Brier=null (n=0 settled). | M | quant calibration canon (Brier/Murphy) |
| P1-4 | **Swappable fill/slippage model + dry-run→live reconciliation ritual.** Replace the single optimistic "ask ≤ limit" maker rule with queue/partial-fill penalties; gate live promotion on paper fills matching backtest within tolerance. | Backtest ≠ live is currently unmeasured; realism gaps hidden. | M | LEAN FillModel/SlippageModel; Freqtrade dry-run parity |
| P1-5 | **Track a Brier/hit-rate on grounded LLM P(YES)** against settled outcomes before ranking capital on `edgeCents`; **size with round-trip fee** when the strategy exits before settlement (`kalshi-fees` already supports `roundTrip:true`). | Grounded probability is an ungraded model number; early-exit strategies pay a second unpriced taker fee. | M | — |

### P2 — Capability

| # | Change | Why | Effort | Borrow from |
|---|---|---|---|---|
| P2-1 | **Move ingestion to Kalshi's authenticated WebSocket** (`orderbook_delta` + fill + `market_positions`, `get_snapshot` resync) behind an internal event interface; REST as fallback. | Kills 6s staleness/429 backoff; gives a real fill stream for the calibration ledger. | L | NautilusTrader event core; Kalshi WS docs |
| P2-2 | **Add a MAKER order mode** (rest 1¢ inside the ask) to capture the Kalshi maker rebate / LIP. | Flips the fee sign from −1.75¢ taker to +rebate — the single most direct fix for "no edge after fees". | M | ryanfrigo Safe-Compounder; Hummingbot A&S |
| P2-3 | **Cross-contract arbitrage scanner** over an event's mutually-exclusive markets (buy basket when Σ NO-asks < (n−1)·$1), fee-gated. | Near-risk-free, independent of forecast quality. | M | OctoBot / polybot arbitrage |
| P2-4 | **Clock abstraction (SimulatedClock vs real) + Parquet/Arrow data catalog** so backtest and live share one code path. | Structural research↔live parity; highest-leverage architectural pattern. | L | NautilusTrader; Freqtrade four-mode parity |
| P2-5 | **A&S inventory-aware quoting for binaries** — reservation price `r = mid − q·γ·σ²·(T−t)`, with T−t known exactly on Kalshi and σ² ≈ bounded p(1−p). | Principled two-sided market-making instead of always joining the favorite. | L | Hummingbot Avellaneda-Stoikov |

---

## 6. The One Thing to Do First

**Stop live submission and make the edge provable before anything else — concretely: land P0-1 + P0-2 + P1-1 together as a single "prove-or-pause" gate.**

Right now the trader is in the worst possible state: **real orders have gone to production (`kalshi-live-ledger.jsonl`, 29 accepted) while the one honest, fee-inclusive backtest that could justify them cannot run, the paper ledger's PnL is hardcoded-broken, and the headline 61.3% number is negative-EV at the real 68¢ entry.** No amount of WebSocket, market-making, or A&S sophistication matters until a single question is answered with a reproducible number: *does any strategy here earn positive EV per contract, out-of-sample, net of the Kalshi fee, graded against true settlement?*

So: (1) flip live trading off and add a real kill-file (the assumed `TRADING-PAUSED` is absent); (2) fix ledger PnL + settlement logging so results are measurable at all; (3) regenerate the tight-band captures and run `kalshi_pnl_backtest.py` to produce the first honest, baseline-relative, net-of-fee EV number. **Only when that number is positive out-of-sample does un-pausing become defensible.** The weather family is the most likely candidate to clear that bar; the crypto/momentum/convergence side, on current evidence, will not.

---

### Key evidence index
- Weather fit: `data/kalshi/weather-oracle-params.json` (n=1818; RPS 0.0309 vs 0.0504; PIT χ² 6.36 vs 93.98); `kalshi-weather-edge.js:193,206`
- Fees/Kelly: `kalshi-fees.js:6-8,44-74,80`; `kalshi-kelly.js:26-34,45-53,119-128`
- Live boundary: `kalshi-api.js:231-234,249-303`; `kalshi-terminal.html:1352`
- Dead gates / no-op cash: `kalshi-weather-edge-deck.js:71,217`; `routes/trading/kalshi.js:556`
- Crypto-suggester gate: `kalshi-crypto-suggester.js:70-71,134,154,179-180` (verified)
- Convergence mock: `kalshi-convergence-lora.js:222-233,269-270,294-326` (verified); `server.js:796-797`
- The 61.3% number: `data/kalshi/cio-train-report.json` (0.6132, 65/106, avg_edge 0.3112 — verified); `experiments/crypto_live_trader.py:123`; `kalshi_cio_backtest.py:134`
- Ledgers: `data/kalshi/kalshi-live-ledger.jsonl` (67 rows, verified); `data/kalshi/paper-positions.jsonl` (325 rows, verified); **`data/kalshi/TRADING-PAUSED` absent (verified)**
- External: Freqtrade (lookahead/recursive-analysis, four-mode parity), NautilusTrader (event core, reconciliation, RiskEngine, Polymarket adapter), Hummingbot (A&S), LEAN/Jesse (fill models, Monte-Carlo, DSR/PBO/CPCV), OctagonAI/ryanfrigo (Kelly + maker + Kalshi WS/rebate).
