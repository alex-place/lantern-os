# Kalshi + Ko-fi Watchlist Revenue Report

Generated: 2026-05-29T22:15:31.4060179-04:00

Status: current public-data manual-review candidates and outreach packet; no trades executed.

## Boundary

- This is not financial advice, investment advice, or a guarantee of profit.
- No Kalshi order was placed and no authenticated trading endpoint was used.
- No pooled capital, copy-trading, trade signals, or managed account offer.
- A market can become a trade candidate only after an independent probability estimate, max-loss budget, fee check, and manual review.

## Sources

- Kalshi public homepage: `https://kalshi.com/`
- Kalshi public markets endpoint: `https://external-api.kalshi.com/trade-api/v2/markets?status=open&mve_filter=exclude&limit=1000`
- Kalshi docs: `https://docs.kalshi.com/api-reference/market/get-markets`
- Kalshi public data quick start: `https://docs.kalshi.com/getting_started/quick_start_market_data`
- Ko-fi support link from existing repo reports: `https://ko-fi.com/alexplace`

## Snapshot

| Metric | Value |
|---|---:|
| Open markets pulled | 5000 |
| Public pages pulled | 5 / 5 |
| Cursor present | True |
| Empty/no-activity markets | 2833 |
| Wide-spread research-only markets | 776 |
| Excluded below 20-cent midpoint | 1295 |
| Excluded below $5.00 visible activity | 3188 |
| Watchlist rows emitted | 20 |
| Manual-approval queue rows | 3 |
| Executable trade recommendations | 0 |
| Trade readiness | research only; not actionable-trade ready |
| Manual review budget requested | $19 |

## Right Now Answer

Executable trades to make right now: **0**.

Best current use of this data: manually review the top watchlist rows, open the market rules in Kalshi, and build an independent probability note before any trade decision. Tight spread and activity make a market worth reading first; they do not prove edge.

Filters applied: do not include market values below 20 cents of YES midpoint, and do not include markets below $5.00 visible public activity.

Profit range is gross per contract if buying YES at the displayed ask: maximum loss is the ask paid; maximum gross profit is $1.00 minus the ask, before fees and slippage. Confidence is data-quality confidence only, not outcome probability.

After loading more data: Lantern can emit a manual-approval queue, but it still cannot place live trades. A human must approve any account action after independent probability, rule, fee, slippage, and max-loss checks.

Paper-ticket output: data/kalshi/kalshi-paper-trade-tickets-latest.json. Trade docs gate: manifests/evidence/kalshi-api-docs-and-trade-gate-2026-05-29.md.

Spread course: custom HFT/spread-capture research is preserved. Wider spreads can be desirable for a maker strategy, but only after orderbook depth, queue position, fees, latency, and cancel/fill risk are modeled.

## `$19` Manual Review Gate

Lantern is ready to prepare a public-data watchlist and research packet. It is not ready to make actionable trades, place orders, manage funds, or recommend that the operator buy or sell a market.

The $19 lane is a manual-review budget marker only:

- no authenticated Kalshi endpoint;
- no order placement;
- no automated execution;
- no claim of edge until independent probability, fees, spread, and max-loss notes exist;
- final trading decisions remain outside Lantern.

## Manual-Approval Queue

These rows are the closest thing to a trade queue after the deeper public-data load. They are not orders.

| Rank | Ticker | Mid | Gross P/L | Data Conf. | Required Before Trade |
|---:|---|---:|---|---:|---|
| 1 | KXMLBTOTAL-26MAY301605KCTEX-9 | 0.445 | -0.45 to +0.55 | 70% | independent probability + human approval + max-loss budget |
| 2 | KXSPOTIFYD-26MAY29-HAT | 0.955 | -0.96 to +0.04 | 70% | independent probability + human approval + max-loss budget |
| 3 | KXHIGHTPHX-26MAY30-B92.5 | 0.385 | -0.39 to +0.61 | 70% | independent probability + human approval + max-loss budget |

## Custom HFT / Spread-Capture Research Queue

This is the custom HFT direction: spread-aware, maker-style research. It is not live trading and it does not use account credentials.

| Rank | Ticker | Mid | Spread | Activity | Gross P/L | Required Before Live |
|---:|---|---:|---:|---:|---|---|
| 1 | KXITFMATCH-26MAY29SHIKIM-KIM | 0.240 | 0.020 | 9007.95 | -0.25 to +0.75 | orderbook depth + fee model + latency sim + human approval |
| 2 | KXAAAGASW-26JUN01-4.290 | 0.980 | 0.020 | 6557.6 | -0.99 to +0.01 | orderbook depth + fee model + latency sim + human approval |
| 3 | KXHIGHLAX-26MAY30-B68.5 | 0.220 | 0.020 | 4417.37 | -0.23 to +0.77 | orderbook depth + fee model + latency sim + human approval |
| 4 | KXMLBSPREAD-26MAY292005KCTEX-TEX8 | 0.680 | 0.020 | 4059.5 | -0.69 to +0.31 | orderbook depth + fee model + latency sim + human approval |
| 5 | KXHIGHAUS-26MAY30-T90 | 0.290 | 0.020 | 2677.12 | -0.30 to +0.70 | orderbook depth + fee model + latency sim + human approval |

## Top Watchlist

| Rank | Ticker | Title | Mid | Spread | Gross P/L | Data Conf. | Activity | 24h Vol | OI | Close | Gate |
|---:|---|---|---:|---:|---|---:|---:|---:|---:|---|---|
| 1 | KXMLBTOTAL-26MAY301605KCTEX-9 | Kansas City vs Texas Total Runs? | 0.445 | 0.010 | -0.45 to +0.55 | 70% | 728.33 | 709 | 675.33 | 2026-06-02T20:05:00Z | no execution |
| 2 | KXSPOTIFYD-26MAY29-HAT | Top USA Song on Spotify on May 29, 2026? | 0.955 | 0.010 | -0.96 to +0.04 | 70% | 2190.36 | 2096.6 | 1923.26 | 2026-05-30T03:59:00Z | no execution |
| 3 | KXHIGHTPHX-26MAY30-B92.5 | Will the maximum temperature be 92-93?? on May 30, 2026? | 0.385 | 0.010 | -0.39 to +0.61 | 70% | 923.51 | 923.51 | 640.81 | 2026-05-31T07:00:00Z | no execution |
| 4 | KXMLBTOTAL-26MAY302205NYYATH-10 | New York Y vs A's Total Runs? | 0.505 | 0.010 | -0.51 to +0.49 | 70% | 3112 | 3112 | 3059 | 2026-06-03T02:05:00Z | no execution |
| 5 | KXLOWTDEN-26MAY30-T48 | Will the minimum temperature be <48?? on May 30, 2026? | 0.295 | 0.010 | -0.30 to +0.70 | 70% | 1229.19 | 1229.19 | 476.17 | 2026-05-31T07:00:00Z | no execution |
| 6 | KXHIGHTATL-26MAY30-T85 | Will the maximum temperature be >85?? on May 30, 2026? | 0.315 | 0.010 | -0.32 to +0.68 | 70% | 3169.23 | 3169.23 | 1476.88 | 2026-05-31T05:00:00Z | no execution |
| 7 | KXHIGHTATL-26MAY30-B84.5 | Will the maximum temperature be 84-85?? on May 30, 2026? | 0.415 | 0.010 | -0.42 to +0.58 | 70% | 1742.43 | 1738.43 | 1206.38 | 2026-05-31T05:00:00Z | no execution |
| 8 | KXMLBSPREAD-26MAY301915ATLCIN-ATL2 | Atlanta wins by over 1.5 runs? | 0.435 | 0.010 | -0.44 to +0.56 | 70% | 1295.03 | 837.83 | 1295.03 | 2026-06-02T23:15:00Z | no execution |
| 9 | KXHIGHTSFO-26MAY30-T68 | Will the maximum temperature be >68?? on May 30, 2026? | 0.205 | 0.010 | -0.21 to +0.79 | 70% | 2746.96 | 2739.96 | 1968.37 | 2026-05-31T08:00:00Z | no execution |
| 10 | KXHIGHTSFO-26MAY30-B67.5 | Will the maximum temperature be 67-68?? on May 30, 2026? | 0.375 | 0.010 | -0.38 to +0.62 | 70% | 2139.42 | 2117.81 | 1168.97 | 2026-05-31T08:00:00Z | no execution |
| 11 | KXHIGHLAX-26MAY30-B72.5 | Will the **high temp in LA** be 72-73?? on May 30, 2026? | 0.215 | 0.010 | -0.22 to +0.78 | 70% | 2879.31 | 2879.31 | 1760.75 | 2026-05-31T07:59:00Z | no execution |
| 12 | KXHIGHTSEA-26MAY30-B64.5 | Will the maximum temperature be 64-65?? on May 30, 2026? | 0.235 | 0.010 | -0.24 to +0.76 | 70% | 854.09 | 828.09 | 606.08 | 2026-05-31T08:00:00Z | no execution |
| 13 | KXHIGHTSEA-26MAY30-B62.5 | Will the maximum temperature be 62-63?? on May 30, 2026? | 0.415 | 0.010 | -0.42 to +0.58 | 70% | 812.15 | 812.15 | 448.61 | 2026-05-31T08:00:00Z | no execution |
| 14 | KXSPOTIFYGLOBALD-26MAY29-HAT | Top Global Song on Spotify on May 29, 2026? | 0.975 | 0.010 | -0.98 to +0.02 | 70% | 3360.64 | 3360.64 | 3069.64 | 2026-05-30T03:59:00Z | no execution |
| 15 | KXITFMATCH-26MAY29MAGDEL-MAG | Will Alan Magadan win the Magadan vs Dellavedova: M15 Gimcheon Semifinal match? | 0.465 | 0.010 | -0.47 to +0.53 | 70% | 25186.29 | 7027.43 | 21730.8 | 2026-06-13T02:00:00Z | no execution |
| 16 | KXITFMATCH-26MAY29MAGDEL-DEL | Will Matthew Dellavedova win the Magadan vs Dellavedova: M15 Gimcheon Semifinal match? | 0.545 | 0.010 | -0.55 to +0.45 | 70% | 18008.48 | 1593.69 | 16662.16 | 2026-06-13T02:00:00Z | no execution |
| 17 | KXAPRPOTUS-26JUN05-39.4 | Will the President's approval rating be between 39.3 and 39.5 according to RealClearPolitics? | 0.225 | 0.010 | -0.23 to +0.77 | 70% | 654.42 | 654.42 | 623.42 | 2026-06-05T15:00:00Z | no execution |
| 18 | KXBRENTD-26JUN0117-T83.00 | Will the brent crude oil close price be above 83.00 USD/Bbl on June 01, 2026 at 5:00 PM EDT? | 0.945 | 0.010 | -0.95 to +0.05 | 70% | 777.71 | 777.71 | 768.71 | 2026-06-01T21:00:00Z | no execution |
| 19 | KXMLBSPREAD-26MAY301410DETCWS-CWS2 | Chicago WS wins by over 1.5 runs? | 0.295 | 0.010 | -0.30 to +0.70 | 70% | 601 | 601 | 601 | 2026-06-02T18:10:00Z | no execution |
| 20 | KXMLBTOTAL-26MAY301605KCTEX-8 | Kansas City vs Texas Total Runs? | 0.525 | 0.010 | -0.53 to +0.47 | 70% | 11298.5 | 11292.12 | 3460.74 | 2026-06-02T20:05:00Z | no execution |

## Stats Model

Model name: `liquidity_spread_watchlist_v0`.

Inputs used:

- YES bid / ask / midpoint.
- Bid-ask spread.
- 24h volume, total volume, liquidity, and open interest.
- Visible activity floor and custom HFT spread-capture queue.
- Days to close.
- Title clarity and combo-market penalty.

What the model does:

- ranks markets worth reading first;
- rejects empty no-activity markets from the top list;
- flags wide-spread markets as research-only;
- preserves the trading gate: no order without independent probability and bankroll limit.

What the model does not do:

- it does not estimate true probability;
- it does not predict profit;
- it does not place trades;
- it does not sell trade signals.

## Ko-fi Revenue Lane

Use Ko-fi for support and paid research operations, not trade pooling.

| Offer | Price | Deliverable | Boundary |
|---|---:|---|---|
| Public supporter note | `$5` | Early watchlist snapshot and methodology note | no trade signals |
| Founder/support tester | `$20` | Weekly public-data market watchlist plus Lantern setup support | no managed money |
| Custom stats cleanup sprint | `$99-$299` | One repo/data/source cleanup plus a reproducible report | no investment advice |

## Outreach Copy

Short Ko-fi post:

> I pulled a live Kalshi public-market snapshot and turned it into a no-hype watchlist report: liquidity, spreads, close dates, and model gates. No trade signals, no pooled money, no guaranteed profit. If you want more open-source local-first stats tooling like this, support Lantern OS here: https://ko-fi.com/alexplace

Warm DM:

> I am testing a Lantern OS stats workflow: public Kalshi markets in, clean watchlist/report out. It ranks what is worth researching and blocks actual trade claims until independent probability work is done. If that kind of transparent AI/data tool is useful, I have a `$20` support lane on Ko-fi: https://ko-fi.com/alexplace

## Next Manual Actions

1. Review the top 20 watchlist rows manually in Kalshi UI.
2. Choose 3 markets with clear rules and real liquidity.
3. Build independent probability notes for those 3 markets from public sources.
4. If any edge exists after fees and spread, record a max-loss budget before any trade.
5. Publish the Ko-fi support note as a support/product update, not a trading advice post.