# Auto-Trader Competitive Analysis — Retail AI Trading Software (2026-08-11)

**Scope.** Where the unisona.ai auto-trader stands against the seven retail "AI trading
software" products Alex flagged (Danelfin, Trade Ideas, TrendSpider, Tickeron,
Capitalise.ai, Coinrule, TradeZella), what the OSS field ships, what our research
corpus says, and a prioritized feature backlog. Companion to
[TRADER-ANALYSIS-2026-07.md](../TRADER-ANALYSIS-2026-07.md) (which covered the
Kalshi stack vs quant OSS); this one covers the **stock autopilot as a product**
vs the retail competitor set.

**Method.** Competitor sites fetched 2026-08-11 (Danelfin blocked fetch; profiled
via third-party 2026 reviews — pricing there is medium-confidence). OSS star
counts pulled live from the GitHub API 2026-08-11. Research notes from the local
arXiv corpus (`scripts/arxiv_query.js`). Current-state claims verified against
this checkout (`lib/auto-trader.js`, `lib/signal-engine/`, `lib/trader-scorecard.js`,
`docs/TRADER-GUIDE.md`).

---

## 1. Where we actually stand today (verified in-repo)

What ships now:

- **Autonomous stock autopilot** (`lib/auto-trader.js`, Pilot tier): Intraday book
  (washout entries + zone-ladder exits on liquid ETFs, OOS-validated on SPY/QQQ)
  and Champion book (diversified ETF allocation, scheduled rebalance). Risk-based
  sizing (`qty = equity·riskPct/(entry−stop)`), ATR protective stops at the broker,
  ratcheting trailing stop, 1R take-profit (backtest-selected), 2%-of-equity daily
  loss breaker, 20% cash reserve, anti-churn persistence gates, longs-only default.
- **Broker layer**: user-connected **Alpaca paper** (keys validated then stored
  encrypted; live keys refused), IBKR CPAPI for the operator book, a
  `broker-facade` abstraction over both.
- **Signal engine** (`lib/signal-engine/`): deterministic Node TA — indicators
  (MACD/RSI/EMA), S/R zones, candles, market structure, sectors, profiles,
  convergence-EV. Scans ~1/min in market hours. No keys, no Python.
- **Journal + scorecard** (Verify): every entry/exit with P&L *and every declined
  opportunity with its reason* (skip log) in `autopilot-trades.jsonl`;
  `trader-scorecard.js` reports win rate, expectancy, profit factor, per-exit-reason
  breakdown — with an honesty split (confirmed fills vs decisions) and a
  selection-artifact guard on profit-only exits.
- **UI**: `stock-trader.html` (Pro-gated; charts, watchlist, Σ₀ signals, journal),
  `trader-guide.html`, `kalshi-terminal.html` (weather-edge deck, fee-aware Kelly).
- **Chat cockpit**: the assistant has real trading tools (quotes, positions,
  portfolio analysis/what-if, options strategy, rebalance proposals).
- **Tiering**: paper trading = Pro ($20), autonomous trader = Pilot ($200).

**Our two real differentiators, named:** (1) we actually *execute* — most of the
competitor set stops at signals, and the ones that execute charge 2–25× our price;
(2) Σ₀ honesty — the skip log, the confirmed-vs-decisioned split, and
measured-not-marketed win rates. No competitor leads with honesty; several lead
with unverifiable win-rate claims.

---

## 2. Competitor cards

### Danelfin — "AI Score" stock picking (Best predictive analysis)
- **Product**: every US stock gets an explainable **AI Score 1–10 = P(beat S&P 500
  over next 3 months)**, computed from ~10,000 features/stock/day; sub-scores for
  fundamental / technical / sentiment / low-risk; screener, trade ideas, portfolio
  tracking + optimization; API on top tier.
- **Claims**: top-score (10/10) stocks beat market by +21.05% avg after 3mo since
  2017 (their number, not independently audited).
- **Pricing**: Free / Plus $22 / Pro $59 / **Elite $134/mo** (API, historical
  scores) — [review sources](https://www.wallstreetzen.com/blog/danelfin-review/).
- **Target**: stock pickers, swing-to-position horizon. Sells *scores*, doesn't trade.
- **Lesson for us**: there is proven willingness-to-pay ($22–59/mo) for a single
  **explainable daily number with a published track record**. We already compute
  the ingredients (signal verdicts + convergence-EV); we don't productize them as
  a ranked, calibrated score.

### Trade Ideas — "Holly" AI scanning (Best for professionals)
- **Product**: real-time scanner + **Holly AI** — a stable of strategies backtested
  nightly, issuing entry/exit signals with risk levels; TI Wave EMA-band chart
  signals; paper trading; **auto-execution** via TradeStation/IBKR/CenterPoint/Cobra;
  new "Money Machine" fully-automated tier launching at **$5,000** early-access.
- **Pricing**: Standard **$127/mo**, Premium (Holly, backtesting, autotrade)
  **$254/mo** ($89/$178 annual).
- **Target**: active day traders.
- **Lesson**: the autotrading market clears at $254+/mo (and they think $5k for
  full autonomy). Our Pilot at $200 with an *actual* autopilot is priced right in
  that window — the missing piece is the **real-time scanner/alert surface** that
  makes the product feel alive between fills.

### TrendSpider — automated TA (Best for technical analysis)
- **Product**: auto-drawn trendlines/Fibonacci/chart patterns, 200+ indicators,
  multi-timeframe analysis, no-code backtesting with natural-language condition
  entry (50y data), dynamic alerts, **no-code trading bots**, scanner, **Sidekick
  AI assistant** (reads charts/filings, analyzes backtests, builds scanners/alerts),
  ML "Quant Lab", AI coding assistant for custom JS indicators. Equities, ETFs,
  options, futures, forex, crypto.
- **Pricing**: ~$54 / $91 / $122/mo tiers (+$214/$399 enterprise); Sidekick
  messages metered (25 free/mo, paid add-on).
- **Target**: TA-driven retail through institutional.
- **Lesson**: they turned *automating the analyst's drawing work* into a platform,
  and their AI assistant is metered as a separate revenue line. We already compute
  S/R zones, market structure, and candles server-side — we just don't *draw* them
  or let users act on them. Natural-language → backtest is table stakes there.

### Tickeron — AI robots (Best for beginners/pros)
- **Product**: subscribable "AI trading robots" (adaptive 5/15/60-min ML
  timeframes) generating daily trade ideas with **advertised 70–80% win rates /
  "+241% return"**; pattern search engine with confidence levels; trend prediction;
  AI screener; daily buy/sell signals; paper trading; copy-trading framing.
- **Pricing**: ~$60–$250/mo tiers + $35/mo crypto pack (review-sourced).
- **Target**: beginners and copy-traders.
- **Lesson**: this is the cautionary competitor — headline win rates without
  audited, settlement-graded ledgers. Our answer is not to copy the claims but to
  ship the **public, honest, live track record** they can't: our books' scorecards
  with skip logs and confirmed-fill accounting.

### Capitalise.ai — plain-English automation (Best no-code)
- **Product**: write trading scenarios in everyday English → backtest → simulate →
  **live auto-execution** through partner brokers; TradingView indicator + alert
  integration; DCA, trailing take-profit, time-based triggers; smart notifications.
  Free to end users via broker partnerships (B2B2C); acquired by Kraken.
- **Lesson**: proof that **plain-English → validated strategy → execution** is a
  shippable product, and that brokers will pay to embed it. This is the closest
  overlap with our chat-first architecture — for us it's a *chat skill over the
  existing engine*, not a new platform.

### Coinrule — rule templates (Best for crypto)
- **Product**: visual IF-THEN rule builder, **350+ template strategies** (DCA,
  grid, trailing, rebalancing, mean reversion), 20+ crypto exchanges + onchain +
  stocks via Alpaca/Webull/Trading 212, demo exchange, leverage,
  TradingView Pine import, and — notably — an **MCP server so Claude/ChatGPT/Gemini
  can create and manage bots in natural language**.
- **Pricing**: Free / $29.99 / $59.99 / $449.99/mo + 0.02% of traded volume.
- **Lesson**: templates solve the blank-page problem (350 canned strategies), and
  they've already conceded the UI to AI assistants via MCP. Validates both our
  chat-native direction and a **strategy template library** as onboarding.

### TradeZella — journaling + improvement (the retention product)
- **Product**: auto-import from **500+ brokers/prop firms** (real-time sync,
  auto-tagging/setup detection), 50+ analytics reports (win rate, profit factor,
  drawdown, behavioral/tilt detection), tick-level backtesting + bar-by-bar trade
  replay, playbooks (strategy rules + adherence tracking), notes/screenshots/voice,
  education + community, and **Zella AI** — conversational Q&A grounded in *your*
  trades, with Habit/Risk/Sentiment/Custom agents.
- **Pricing**: Essential $35 / Pro $59 / Ultra $99/mo ($26/$44/$74 annual); AI
  credits metered per tier; replay + AI agents gated to Pro+.
- **Target**: every trader trying to get better; prop-firm evaluees.
- **Lesson**: journaling is the **retention** business in this market (100k+ users
  at $26–74/mo), and they're bolting AI onto the journal. We *generate* the journal
  automatically — including the skip log, a counterfactual record TradeZella
  structurally cannot have (they only see executed trades). Our gap is purely the
  analytics/UI layer on data we already write.

### Market structure summary

| Segment | Who | Price point | Do they execute? |
|---|---|---|---|
| Scores/picks | Danelfin, Tickeron | $22–250/mo | No (Tickeron: paper/copy) |
| Scanning/TA | Trade Ideas, TrendSpider | $54–254/mo | Via broker partners / bots |
| No-code automation | Capitalise.ai, Coinrule | Free–$450/mo | Yes (user's broker/exchange) |
| Journal/improvement | TradeZella | $26–99/mo | No |
| **Us** | unisona.ai | $20 Pro / $200 Pilot | **Yes — genuine autopilot** |

Nobody in the set combines **execution + honest measurement + a conversational
cockpit**. That triangle is open.

---

## 3. OSS landscape (stars verified 2026-08-11)

**LLM trading agents** (the mindshare explosion):
- [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) — 97.5k★, multi-agent LLM trading framework (analyst/researcher/trader/risk roles)
- [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) — 62.8k★, persona-agent hedge fund team
- [AI4Finance/FinGPT](https://github.com/AI4Finance-Foundation/FinGPT) — 21.1k★, financial LLMs; [FinRL](https://github.com/AI4Finance-Foundation/FinRL) — 16.0k★, RL trading
- [pipiku915/FinMem](https://github.com/pipiku915/FinMem-LLM-StockTrading) — 0.9k★, layered-memory LLM trader (closest to our Remember stage)

**Research/data platforms**: [OpenBB](https://github.com/OpenBB-finance/OpenBB) 71.8k★ (open data terminal, now "for AI agents"); [microsoft/qlib](https://github.com/microsoft/qlib) 47.3k★ (AI quant platform).

**Backtesting**: [backtrader](https://github.com/mementum/backtrader) 22.8k★, [QuantConnect/Lean](https://github.com/QuantConnect/Lean) 21.2k★, [backtesting.py](https://github.com/kernc/backtesting.py) 8.8k★, [vectorbt](https://github.com/polakowo/vectorbt) 8.6k★.

**Execution engines/bots**: [freqtrade](https://github.com/freqtrade/freqtrade) 53.2k★ (crypto bot; the reference for config-driven retail bots + lookahead-bias tooling), [NautilusTrader](https://github.com/nautechsystems/nautilus_trader) 25.4k★ (event-driven, reconciliation — already our architecture reference), [hummingbot](https://github.com/hummingbot/hummingbot) 19.4k★, [StockSharp](https://github.com/StockSharp/StockSharp) 10.5k★, [jesse](https://github.com/jesse-ai/jesse) 8.3k★, [OctoBot](https://github.com/Drakkar-Software/OctoBot) 6.4k★, [openalgo](https://github.com/marketcalls/openalgo) 2.4k★ (self-hosted broker-agnostic execution).

**Direct product analogs (smaller, most instructive)**:
- [austin-starks/NextTrade](https://github.com/austin-starks/NextTrade) 1.8k★ — open predecessor of NexusTrade: no-code strategies, optimizer, paper trading. The one-founder blueprint for "Capitalise-style" product.
- [Eleven-Trading/TradeNote](https://github.com/Eleven-Trading/TradeNote) 0.9k★ — open trading journal (TradeZella analog; useful for import formats + report checklist).
- [ghostfolio/ghostfolio](https://github.com/ghostfolio/ghostfolio) 9.1k★ — wealth tracking UX patterns.
- [tradingview/lightweight-charts](https://github.com/tradingview/lightweight-charts) 16.9k★ — the chart substrate for overlay work.
- [white07S/TradingPatternScanner](https://github.com/white07S/TradingPatternScanner) 0.3k★ — deterministic chart-pattern detection (head-and-shoulders, wedges) — the TrendSpider-style overlay logic, in Python, MIT.

**Takeaways.** (a) The OSS gravity moved to LLM multi-agent trading (TradingAgents
+ ai-hedge-fund = 160k combined stars in ~18 months) — exactly our council
architecture, but almost none of it is verification-gated; our Σ₀ discipline is
the differentiator, not the agent pattern. (b) Every UI/analytics gap we have
(patterns, journal reports, charts) has a permissively-licensed reference
implementation to borrow from. (c) Nobody needs us to rebuild backtesting
infrastructure — walk-forward + honest baselines in-repo already beat what the
retail competitors expose.

---

## 4. What the research corpus says (local arXiv, queried 2026-08-11)

- **LLM agents can trade, but evals are contaminated**: memory-controlled
  benchmarking shows long backtests overlap frontier-model knowledge cutoffs —
  memorized tickers/dates inflate results (arXiv:2605.28359). Any LLM-driven
  strategy we ship must be graded **forward, on settled fills** — which is what our
  ledger already does. This is a moat argument, not just hygiene.
- **Multi-agent + self-reflection frameworks** (TradingGroup, arXiv:2508.17565;
  expert-team decompositions, arXiv:2602.23330) mirror our council; the deltas they
  report come from structured reflection over *own trading history* — our journal
  is that substrate.
- **LLMs for backtest generation** are now benchmarked (BacktestBench,
  arXiv:2605.17937) and used as strategy-evolvers (MadEvolve, arXiv:2605.23007) —
  supports the plain-English → strategy-spec → backtest pipeline as feasible, with
  the caveat that generated strategies need overfitting guards (DSR/PBO — already
  on our P1 list from the July analysis).
- **LLMs reading charts is unreliable** (technical-analysis evals,
  arXiv:2607.15414; candlestick-understanding audits, arXiv:2606.17423) — pattern
  overlays should stay **deterministic** (our signal engine / TradingPatternScanner
  approach), with the LLM narrating, not detecting.
- **News-sentiment alpha is real but modest and decays** (arXiv:2602.00086,
  arXiv:2507.03350) — a sentiment *sub-score* is worth adding as an explainable
  input, only behind calibration gating.

---

## 5. Feature matrix — us vs the field

✅ have · 🟡 partial/inferior · ❌ missing · ⛔ deliberate non-goal

| Capability | Us | Danelfin | TradeIdeas | TrendSpider | Tickeron | Capitalise | Coinrule | TradeZella |
|---|---|---|---|---|---|---|---|---|
| Autonomous execution (user's broker) | ✅ Pilot | ❌ | 🟡 $254+ | 🟡 bots | 🟡 paper | ✅ | ✅ | ❌ |
| Risk engine (sizing, stops, breakers) | ✅ | ❌ | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | ❌ |
| Honest measured track record | ✅ ledger | 🟡 self-reported | 🟡 | ❌ | ❌ hype | ❌ | ❌ | n/a |
| Auto journal + skip log | ✅ unique | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 imports only |
| Journal analytics (50+ reports, replay) | 🟡 scorecard only | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Daily explainable score/ranking | ❌ (ingredients exist) | ✅ core | ❌ | ❌ | 🟡 | ❌ | ❌ | ❌ |
| Real-time scanner + user alerts | 🟡 scan w/o alerts | 🟡 | ✅ core | ✅ | ✅ | 🟡 | 🟡 | ❌ |
| Auto-drawn patterns/trendlines on charts | 🟡 computed, not drawn | ❌ | 🟡 | ✅ core | ✅ | ❌ | ❌ | ❌ |
| Plain-English strategy → backtest → execute | ❌ | ❌ | ❌ | 🟡 NL conditions | ❌ | ✅ core | ✅ via MCP | ❌ |
| Strategy template library | 🟡 2 books | ❌ | 🟡 Holly set | 🟡 | ✅ robots | 🟡 | ✅ 350+ | 🟡 playbooks |
| User-tweakable backtesting UI | ❌ (harness exists) | ❌ | 🟡 | ✅ | 🟡 | ✅ | 🟡 | ✅ |
| Conversational AI grounded in *your* trades | 🟡 chat+tools | ❌ | ❌ | 🟡 Sidekick | ❌ | ❌ | 🟡 MCP | ✅ Zella AI |
| News/sentiment signal input | ❌ | ✅ sub-score | 🟡 | 🟡 | 🟡 | ❌ | ❌ | 🟡 |
| Multi-broker import/connect | 🟡 Alpaca+IBKR | n/a | 🟡 4 | n/a | n/a | 🟡 partners | ✅ 20+ | ✅ 500+ |
| Options/futures | 🟡 tools+backlog | ❌ | 🟡 | ✅ | 🟡 | 🟡 | ❌ | ✅ journal |
| Crypto exchanges | ⛔ (Kalshi crypto refuted) | ❌ | ❌ | 🟡 data | 🟡 | 🟡 Kraken | ✅ core | 🟡 |
| Copy-trading marketplace | ⛔ | ❌ | ❌ | ❌ | ✅ | ❌ | 🟡 | ❌ |

---

## 6. Prioritized feature backlog

Ordering principle: **(1) monetize what already works** (the ledger, the books,
the scan) before adding surfaces; **(2) the flagship bet is chat-native
automation** — our architecture is uniquely shaped for it; **(3) nothing ships a
predictive claim without a calibration/track-record page** (Σ₀ rule; also our
sharpest marketing weapon against Tickeron-style hype). Loop-stage per CLAUDE.md.

### P0 — monetize the existing loop (weeks, mostly UI over existing data)

| # | Feature | Competitor answered | Loop stage | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| P0-1 | **Journal analytics v1**: equity curve, calendar view, win rate × setup/hour/symbol, expectancy, drawdown, MFE/MAE, skip-log analytics ("what declining saved you") | TradeZella core | Verify/Remember | Pro | M | Data already in `autopilot-trades.jsonl`; borrow report checklist from TradeNote (908★). Skip-log counterfactuals are a feature nobody else can copy. |
| P0-2 | **Public live track-record page** for Champion + Intraday books: settlement-graded scorecard, confirmed-fills-only, drawdown, updated daily | Tickeron's fake version | Converge | Free (marketing) | S | `trader-scorecard.js` already computes it. This is the honest "AI robot with a track record" page. |
| P0-3 | **Watchlist alerts**: user rules on the existing 1-min scan (signal fired, zone touched, washout proximity) → web push/email | Trade Ideas core | Observe | Pro | S–M | Scan loop exists; needs rule store + delivery. Makes Pro feel alive daily. |
| P0-4 | **Ship the open revenue/gating fixes**: [#3008](https://github.com/alex-place/lantern-os/issues/3008) guest showroom vs Pro modal, [#2985](https://github.com/alex-place/lantern-os/issues/2985)/[#2989](https://github.com/alex-place/lantern-os/issues/2989)/[#2991](https://github.com/alex-place/lantern-os/issues/2991) CTA wiring | — | Act (funnel) | — | S | Already triaged in backlog; blocks conversion measurement of everything above. |

### P1 — the flagship differentiator (a quarter)

| # | Feature | Competitor answered | Loop stage | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| P1-1 | **Plain-English strategy builder in chat**: NL → bounded strategy spec (constrained DSL over signal-engine primitives: entry/exit/size/stop/schedule) → auto-backtest with walk-forward + DSR guard → paper slot → explicit arm | Capitalise.ai, Coinrule-MCP, TrendSpider NL | Reason+Act | Pilot flagship | L | The whole competitor set converges here; we have chat tool-calling, the engine, and the harness. Research: BacktestBench 2605.17937, MadEvolve 2605.23007. LLM writes *specs*, never raw orders — every spec passes the same trading-guard. |
| P1-2 | **Daily explainable Edge Score** on watchlist names (rank + evidence: which signals, zones, EV), with a **published calibration page** (Brier, hit-rate by score decile) | Danelfin core | Reason | Pro | M | Ingredients = signal verdicts + convergence-EV. The calibration page is the Σ₀ answer to Danelfin's self-reported +21%. Do NOT ship the score before the calibration ledger has n. |
| P1-3 | **Strategy template gallery**: curated presets over the DSL (washout, ladder variants per [#3165](https://github.com/alex-place/lantern-os/issues/3165) hold horizons, inverse-ETF regime per [#3164](https://github.com/alex-place/lantern-os/issues/3164)), each shipping WITH its OOS backtest card | Coinrule 350 templates, Tickeron robots | Reason | Pro browse / Pilot run | M | Solves blank-page; honest version of "robots": every template shows its measured, dated OOS card, not a win-rate banner. |
| P1-4 | **Pattern/zone overlays on charts**: draw the S/R zones, market structure, and candlestick patterns the engine already computes; deterministic detection only (LLM narrates) | TrendSpider core | Observe | Free tease / Pro | M | lightweight-charts substrate + TradingPatternScanner (MIT) for classical patterns. Research says keep LLMs out of detection (2607.15414, 2606.17423). |

### P2 — expansion (evidence-gated)

| # | Feature | Competitor answered | Loop stage | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| P2-1 | **Backtest-on-demand UI**: expose harness knobs (stop %, ladder, horizon) per user, walk-forward + DSR always on | TrendSpider/TradeZella backtesting | Verify | Pilot | M–L | Reuses P1-1 plumbing. |
| P2-2 | **News/sentiment sub-score** as explainable Edge Score input, calibration-gated before it can move rank | Danelfin sentiment | Observe | Pro | M | Alpha is modest/decaying (2602.00086, 2507.03350); gate hard. |
| P2-3 | **Journal import** (broker CSV/Flex from IBKR, Alpaca live fills) so non-autopilot trades join the journal | TradeZella 500 brokers | Remember | Pro | M | Start with 2 brokers we already touch, not 500. |
| P2-4 | **Capacity/instrument expansion** already in backlog: leverage [#3166](https://github.com/alex-place/lantern-os/issues/3166), futures MES/MNQ [#3218](https://github.com/alex-place/lantern-os/issues/3218), CSP options shadow book [#3219](https://github.com/alex-place/lantern-os/issues/3219) | TrendSpider asset breadth | Act | Pilot | M–L | Sequence after the operator book saturates ETF capacity (per #3218's own gate). |
| P2-5 | **AI session review**: scheduled chat digest grounded in the journal ("this week you made $X, the skip log declined Y, tilt flag on Z") | Zella AI agents | Verify | Pilot | S–M | Chat + recall over the ledger; TradingGroup-style self-reflection (2508.17565) with real fills. |

### Non-goals (explicit, so they don't creep back)

- **Copy-trading marketplace / advertised win-rate "robots"** — Tickeron's lane;
  incompatible with Σ₀ honesty and a regulatory magnet.
- **Crypto exchange integrations** — Coinrule's moat; our crypto edge was
  measured negative (see memory/TRADER-ANALYSIS §3).
- **Building a 500-broker import network or a standalone screener** — TradeZella's
  and OpenBB's moats respectively; integrate, don't compete.
- **A separate "strategy IDE"** — everything routes through chat + the one engine
  (single Convergence Core; no parallel product surface).

---

## 7. Backlog discussion — how this changes the product story

**The gap is packaging, not capability.** Against seven funded competitors, our
engine-level capabilities (execution, risk, honest measurement) are already at or
above the retail bar — what's missing is almost entirely *surface*: reports,
alerts, overlays, a score, a template gallery. P0 is deliberately UI-over-existing-
data for that reason; it should also be the cheapest revenue we ever buy.

**Sequencing logic.** P0-2 (public track record) is the keystone: every later
feature (score, templates, autopilot marketing) needs the honest-evidence page to
point at, and it's ~days of work. P0-1/P0-3 give Pro a daily-use reason to exist
(currently Pro's trader value is mostly "you may look at it"). P1-1 is the bet
that turns Pilot from "trust our two books" into "your strategies, our discipline"
— it's also the feature the entire competitor set is converging toward
(Capitalise free-via-brokers, Coinrule via MCP, TrendSpider via NL conditions),
so the window for doing it *with verification as the differentiator* is now.

**Pricing read.** Competitors monetize signals at $22–254/mo with no execution
and no honesty guarantees. Pro at $20 underprices the segment once P0 lands
(alerts + journal analytics + score alone match $50–100/mo bundles elsewhere);
Pilot at $200 sits exactly at Trade Ideas Premium — but delivers actual
autonomous execution they gate behind a $5k product. There's likely a future
middle tier (journal+alerts+score without autopilot) but that's a pricing
decision for after P0 conversion data exists.

**Risk note.** P1-2 and P1-3 put predictive numbers in front of users; both carry
an explicit calibration gate before launch. That's slower than competitors and
the point: the only durable position this analysis found is *the honest one* —
everyone else in the market is structurally unable to publish a skip log.
