# Market-data vendors for a survivorship-free US equity backtest (checked 2026-07-18)

**Question:** is there a *free* data source that can build a survivorship-bias-free
single-stock backtest — i.e. delisted/bankrupt prices **plus** point-in-time index
membership? Pricing/coverage below were read from each vendor's live page on 2026-07-18.

## The one-line answer

**No fully-free API can do it.** Point-in-time *membership* is free
([fja05680/sp500](https://github.com/fja05680/sp500)), but every free *price* source is
survivorship-biased — it serves "what trades today" and drops the companies that died.
Proven empirically this session (see `experiments/survivorship_momentum/`): Yahoo, Alpaca,
IBKR = no delisted at all; **stooq free bulk = only 41% of the delisted cohort** (survivors
100%, but the truly-dead names — JCPenney, Heinz, Dean Foods, Big Lots, Avon, Safeway,
Windstream, Molex — are absent); Tiingo free = partial (good 2013+, missing Lehman/Enron/
WorldCom/Bear) **and** rate-capped (50 req/hr, 500 symbols/mo). Clean delisted prices live
only behind paid/gated products.

## Comparison

| Vendor | Price today | Free tier | Delisted prices | Point-in-time members | History | Fit | Link |
|---|---|---|---|---|---|---|---|
| **stooq (bulk)** 🟢 | **$0** | bulk ASCII dl | **partial (41%)** | no (pair w/ fja05680) | deep | best free, but biased + JS bot-gate | [db/h](https://stooq.com/db/h/) |
| **fja05680/sp500** 🟢 | **$0** | — | membership only | **yes (incl. delisted)** | 1996+ | free PIT membership | [github](https://github.com/fja05680/sp500) |
| **Tiingo** | Free / **Power $30/mo** | 50 req/hr, 500 sym/mo | **partial** (2013+) | no | 30+ yr | free=rate-capped, partial | [pricing](https://www.tiingo.com/pricing) |
| **Alpha Vantage** 🟢 | Free / prem ~$50/mo+ | 25 req/day | roster only (`LISTING_STATUS`) | no | 20+ yr | delisted *list*, spotty prices | [site](https://www.alphavantage.co/) |
| **EODHD** | **$19.99/mo** (All-World EOD) | 20 calls/day | **yes** (all paid tiers) | via separate endpoint | Ford=1972 | cheapest recurring that works | [pricing](https://eodhd.com/pricing) |
| **Sharadar / Nasdaq Data Link** | **~$30/mo** personal¹ | — | **yes** (CRSP-grade) | **yes** (S&P 500 1957–present) | 1998+ | best rigor/$ | [SEP](https://data.nasdaq.com/databases/SEP) |
| **Norgate Data** | **US$630/yr** (~$52/mo) | free trial | **yes** | **yes** | deep | survivorship-free, app/Python-bound | [prices](https://norgatedata.com/prices.php) |
| **HistoricalData.net** | **$299 one-time** | free sample | **yes** (50k+ delisted) | no | 2003+ | best value, no recurring | [site](https://historicaldata.net/) |
| **FMP** | ~$22 / ~$69 / ~$149 mo¹ | 250 calls/day | **yes** (delisted API) | **yes** (constituents w/ dates) | 30yr @ Premium | good API | [pricing](https://site.financialmodelingprep.com/pricing-plans) |
| **Databento** | PAYG $/GB; sub from **$179/mo** ($125 free credits) | trial credits | partial/unclear | no | 16+ yr | overkill (tick/intraday) | [pricing](https://databento.com/pricing) |
| **Intrinio** | **$150/mo** individual | no | not specified | not specified | 50+ yr | expensive, unclear fit | [pricing](https://intrinio.com/pricing) |
| **Polygon.io → Massive** | Free / $29 / $99 / $199 mo | 5 calls/min | **no** ("look elsewhere") | no | full @ Advanced | **fails** survivorship | [pricing](https://polygon.io/pricing) |
| **CRSP / WRDS** | institutional only² | — | **yes** (gold standard) | **yes** | 1925/1962+ | free *if* you have university WRDS | [WRDS](https://wrds-www.wharton.upenn.edu/pages/about/data-vendors/center-for-research-in-security-prices-crsp/) |

¹ Login/403-gated today — best-known figures, verify at signup.
² Not sold to individuals; **Morningstar acquired CRSP Feb 2026**, access/pricing shifting.

## Recommendation

- **Free & good-enough:** stooq bulk + fja05680 (what we used) — but understand it's a
  *survivorship-inflated upper bound*, not clean. Fine for a directional read; it already
  showed single-stock momentum ties SPY and loses to the champion.
- **Cheapest that's actually clean:** **Sharadar ~$30/mo** (CRSP-grade + PIT membership
  bundled) or **HistoricalData.net $299 one-time** (no recurring). EODHD $20/mo also works.
- **Avoid for this job:** Polygon/Massive (no delisted), Databento/Intrinio (overkill/pricey).

The repo pipeline (`experiments/survivorship_momentum/free_data/`) runs identically against
any of these — swap the price loader, keep the point-in-time engine.
