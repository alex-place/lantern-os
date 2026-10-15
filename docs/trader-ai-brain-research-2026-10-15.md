# The trader's missing brain: research, 2026-10-15

**The question.** The operator, 2026-10-15: no trader trades on charts alone; news, earnings and a human brain making the decision are what make Riley's strategy work, and our algorithm has no thinking part. The first version of the trader was designed with more than five models working together (a Strategist orchestrating a Technician, a Fundamentalist, a Sentiment analyst and a Quant, with a Trader, a Risk manager and an Auditor). That design never ran. Research how to add the missing brain.

**The short answer.** The house has already built three AI layers and measured them. None picked better trades than the rules. The newest one, the only one given news, has been switched off by an empty API balance since 2026-09-24 and has never produced a read. The outside evidence agrees with ours: language models are poor at predicting short-horizon price direction and good at reading text and spotting anomalies. So the brain worth adding is one reasoning step that knows when NOT to trade and audits the machine at every close, tested forward on live days. Not eight agents placing orders.

## 1. What we already built and measured

| layer | what it did | result |
|---|---|---|
| per-signal analyst (#3358, August) | a model scored every signal | correlation with the outcome 0.007: noise |
| entry judge (`lib/entry-judge.js`, #3390) | a model approved or rejected every entry | REVERSED at n=37: approved entries won 40%, rejected ones 69%; its most confident rejections were the nine best trades; switched off (`TRADER_ENTRY_JUDGE=0`) |
| day reader v1 (`lib/regime-shadow.js`, #3389) | read the day's character at 09:35 and 16:05, shadow only | the 09:35 read was fed a wrong gap from 08-21 to 09-30 (fixed in #3718); the 16:05 read lost to always-long (posture −0.68% vs −0.32%, correlation −0.17) |
| prices-only learners (2026-10-01) | logistic regression and a nearest-neighbour "similar situations" memory on price features, fit before 2024-07 and tested after | AUC 0.56 and 0.52 (the memory pointed the wrong way); a single volatility label beat both. The judgment is not in the prices the trader already sees |
| day reader v2 (#3719, live in shadow since 10-01) | given the scan universe, the indices against their noise bands, 18 hours of ranked headlines and its own track record; picks names at 09:35 and 10:35 | **has never produced a read.** Every Claude call since the 16:05 read on 2026-09-24 returned HTTP 400 (37 calls through 10-14); a diagnostic call on 10-15 returned `Your credit balance is too low to access the Anthropic API`. The local fallback model was unreachable on every read. Ten sessions lost; ledger row `live-stable-ai-day-reader-v2` (made 10-01, due 11-20, scored on the first 30 sessions) has no data |

## 2. What the outside evidence says

| study | setting | finding |
|---|---|---|
| [TradingAgents](https://arxiv.org/abs/2412.20138) (Xiao et al., 2024) | the multi-agent design in the operator's image: analysts, bull and bear researchers, a risk team, a trader | beats simple baselines in a three-month 2024 backtest; not run live |
| [StockBench](https://arxiv.org/abs/2510.02209) (2025) | multi-month stock trading on data after the models' training cutoffs, GPT-5, Claude 4, Qwen3 and others | most models fail to beat buy-and-hold |
| [LiveTradeBench](https://arxiv.org/abs/2511.03628) (2025) | 50 live days, 21 models, US stocks and prediction markets | high scores on general benchmarks do not predict trading results; each model has its own style |
| [Alpha Arena](https://forklog.com/en/four-out-of-six-ai-models-suffer-losses-in-trading-tournament/) season 1 (nof1, 2025) | six models, $10,000 each, real crypto trading on price data | Qwen3 Max +22%, DeepSeek +5%; the other four (Claude Sonnet 4.5, Grok 4, Gemini 2.5 Pro, GPT-5) lost 30-63% |
| [Agent Market Arena](https://arxiv.org/abs/2510.11695) (2025) | live multi-market benchmark of trading agents | the agent framework shaped behaviour (aggressive to conservative) more than the model behind it |
| AI-Trader (2025) | agents on US stocks, A-shares and crypto | most agents had poor returns and weak risk management |
| [HKU Agentic Trader](https://www.hkubs.hku.hk/media/press-release/testing-ai-in-the-real-world-hku-business-school-released-ai-agents-trading-performance/) (2026) | ten agents, the same $100,000 of simulated capital, live FX and index markets | Qwen led; simulated money |
| [What LLM trading agents actually do in production](https://arxiv.org/pdf/2609.05663) (2026 preprint) | 3,505 real-money vaults run by one model in a crypto market for 21 days | about how the system around the agent shapes its behaviour, not about profit |
| [Lopez-Lira and Tang](https://arxiv.org/abs/2304.07619) (2023) | a model scoring news headlines | headline scores predict next-day returns of individual stocks, strongest for smaller companies |
| [Glasserman and Lin](https://arxiv.org/abs/2309.17322) (2023) | the same, checking for bias | a model judging past headlines knows what happened next (look-ahead) and is distracted by what it knows about the company; anonymised headlines and post-cutoff data are needed |

Three lessons hold across all of it. A model asked to call direction does no better than a coin on liquid markets, and backtests of models are contaminated by hindsight. Where a model helps, it reads text that the price feed doesn't contain. And the only clean test is forward, on days the model has never seen. Real-money evidence on US stocks is close to nonexistent.

## 3. The image's roles, against the evidence

| role in the image | keep? | why |
|---|---|---|
| Technician (charts) | already exists as the rule engine | every minute-scale chart reading we tested, by model or by rule, carried no edge |
| Fundamentalist (news, macro) | **yes, as input** | the one thing the trader truly lacks: what is scheduled today (Fed, CPI, jobs, mega-cap earnings) and what happened overnight |
| Sentiment (social) | low priority | noisy and the least tested; headlines first |
| Quant (stats, backtesting) | already exists | the replay lab and the prediction ledger |
| Strategist (final decisions) | **yes, narrowed** | one reasoning step that decides posture (trade normally, trade small, stand aside), not individual entries; the entry judge proved that per-entry calls hurt |
| Trader (order execution) | **no model** | must stay deterministic code: latency, reliability, an audit trail |
| Risk manager (stops, kill switch) | **no model** | the rules must not be negotiable; a model can recommend, code enforces |
| Auditor (logs, feedback) | **yes, at the close** | the clearest win, and it already existed: the close review (`lib/session-review.js`, #3359) reads every session with one model call. It failed every day from 09-24 with the account empty, and nothing caught it. Checks in code that run without the model would have flagged the 100-share USO short open since 10-08, the SLV stop loss booked to the day its order was placed, three weeks of failed AI calls, and the watchdog tasks that only run while someone is logged in |

The project's rules forbid independent agent ecosystems and multi-agent swarms, and require models to be interchangeable (`CLAUDE.md`, Feature Gate). So the brain is one reasoning step inside the existing loop, built by extending the day reader rather than adding eight agents from five vendors. The models in the image are also a generation or more old.

## 4. What was built (2026-10-15): one model, three jobs, no new agents

1. **The pre-open stance, ~09:15 ET** (`lib/regime-shadow.js`, read `preopen`, prompt v3).
   - Inputs:
     - SPY's last 10 sessions, QQQ and IWM over 5 days, and the VIX;
     - SPY, QQQ and IWM in the pre-market against yesterday's close;
     - ES and NQ futures since their settlement;
     - every headline since the last close (17 hours on a weekday, the whole weekend on a Monday);
     - its own earlier pre-open calls, with SPY's day and the account's day that followed.
   - Output: the size of the day's new entries (normal, half or stand aside), the range it expects (quiet, normal or wide), a direction, its conviction, the scheduled events it saw, and a reason.
   - It is fired from the scan loop above the market-hours gate, because before the bell the loop only ticks.
   - On Riley's 10-15 stream, the setup fit his checklist but he passed because of how the market took the inflation news. This is that decision, asked of a model.
2. **The 09:35 and 10:35 reads** that day reader v2 already makes are unchanged. They resume now that the account has credit.
3. **The auditor is the close review that already existed** (`lib/session-review.js`, #3359), with machine checks added. These run in code before the model and need no network or key:
   - a short in the long-only book;
   - fractional dust left by an exit;
   - an exit found today but booked to an earlier day;
   - today's failed AI reads;
   - the review's own failure streak.

   They are journalled on every row, failed reviews included. They also reach the model as context it should not repeat, and they now trigger the close's `session_review` pointer row in the trade ledger.

**Checked on real data.**
- The machine checks, run on stable's 2026-10-14 ledger, return five findings:
  - USO held short at −100 shares (high);
  - the SLV −$8,132 stop fill found on 10-14 but booked to 10-12, against a session row that says realized +$196 and no stops (high);
  - 3 of 3 AI reads failed with HTTP 400 (medium);
  - the last 13 reviews failed (medium);
  - 0.8 shares of SOXS dust (low).
- One live pre-open call replayed 10-14 at 09:15 on `claude-opus-5-5`. It saw SPY −0.32%, QQQ −0.63% and IWM −1.14% in the pre-market, and 30 headlines over 17 hours. It answered: normal size, normal range, chop, conviction 60, "CPI risk has passed. A modest post-CPI dip with VIX 16.9 suits dip-buying." The account lost 1.73% that day. One day is not evidence, which is why the stance runs in shadow.

**Shadow first.** The pre-open stance only journals. It gets control of size only after it clears the day reader's bar from 10-01, registered before its first read: over at least 20 scored sessions, rho(stance, account day) ≥ +0.4, and the stance-sized total beats both always-normal and the VIX rule (half size when the VIX is 20 or higher). `experiments/regime_shadow_score.js` prints the test. The machine checks are live from the first close, because they never trade.

## 5. Cost, measured

| call | tokens in / out | model | cost per call |
|---|---|---|---|
| pre-open stance (the 10-14 replay) | 2,831 / 502 | claude-opus-5-5 ($4 / $20 per million) | $0.021 |
| close review (average of the 25 that ran in Aug-Sep) | 3,592 / 2,583 | claude-opus-5 ($5 / $25 per million) | $0.083 |
| open and mid reads (v2) | about 3,000 / 300, estimated from the prompt size | claude-opus-5-5 | about $0.02 each |
| close read (v1) | about 400 / 150 | claude-opus-5-5 | about $0.005 |

That comes to about $0.15 a trading day, so the $5 added on 10-15 covers about 33 sessions. That is enough for the 20-session test; the account needs topping up in late November. From now on every read's row records its tokens, so these numbers become measured.

## 6. What it still needs

- **An economic calendar.** None is built yet. The headlines carry the events for now: the 10-14 replay named CPI at 08:30 and the bank earnings from the headlines alone. The Fed and BLS publish their schedules, which can be loaded once a year from their official pages.
- **The fill-timestamp bug.** An exit's journal timestamp is its order's placement time, so the account's day P&L in the ledger is wrong on stop-fill days (10-14 reads −0.34% instead of −1.73%). The stance's score inherits that error until the bug is fixed.
- **Ledger.** The v2 row scores the first 30 sessions of reads; with none so far, its due date moves to 30 sessions after the first successful read. The stance and the checks each get a prediction row before their first live day.

## 7. Which chart rules can carry an edge for an algorithm

What has measured positive in our replays (13 recent windows and 30 quarters back to 2016) is statistical, broad and patient, not pattern reading:

- buying short-term weakness in the six index ETFs after a down close (the dip scan with the down-close gate, which passed both tiers);
- the close-IBS buy on 3x index funds (sleeve C, confirmed);
- the afternoon leg on index products, related to the published market intraday momentum effect (Gao, Han, Li and Zhou, 2018: the first half hour predicts the last);
- letting fast movers run: fast moves to +1R reached +2R 40% of the time against 31% for slow ones;
- the overnight drift (sleeve O), positive, but not what the operator wants the income to depend on.

Each has a small edge per trade that adds up over hundreds of trades, and each has a reason behind it in who is on the other side: someone selling an index fund in a hurry, flows into the close, a premium for holding risk overnight. What failed is discretionary pattern reading at minute scale (zones, double bottoms, confirmation candles, fair value gaps), per-entry AI judgment, and learners on prices alone. An algorithm's advantages are breadth, consistency and cost discipline, not imitating a human's eye.
