# Survivorship bias in single-stock momentum — measured, not asserted (2026-07-18)

**Question:** can the champion be upgraded with 12-1 single-stock momentum, and were we
"kneecapped by Yahoo"? Built the point-in-time universe to find out.

## The data reality (proven by the workflow, all three sources fail)

A survivorship-free single-stock backtest needs two things Yahoo lacks: **point-in-time
index membership** and **prices for delisted/bankrupt tickers**. We checked whether the
broker APIs close the gap:

| Source | Delisted prices | History | Verdict |
|---|---|---|---|
| **Yahoo** | none | — | drops delisted; no PIT membership |
| **Alpaca** | **none** (returns empty bars for `status=inactive` symbols) | ~2016+ | cannot help |
| **IBKR** | **none** (structural — no data for non-tradeable securities) | listed only | cannot help (+ creds stale) |
| stooq | partial | 20y+ | free CSV endpoint hard-blocks "Access denied" |
| **Tiingo** | **yes** | deep | free key required — the accessible fix |
| **Sharadar** (Nasdaq Data Link) | **excellent** | 1998+ | paid ~$tens/mo — the gold standard |
| fja05680/sp500 (GitHub) | membership only | 1996+ | **free PIT S&P 500 membership incl. delisted** |

So the broker APIs genuinely **cannot** build a survivorship-free universe — they are
execution/data APIs, not research databases. The free zero-key path is blocked (stooq
denied, Yahoo has no dead companies). The real fix costs a free Tiingo key or ~$tens/mo.

## What we could build, and the wall we hit

Reconstructed the rules-based S&P 500 **ever-member** universe (1996→now) — deliberately
including the tickers that later died: **Enron, WorldCom, Lehman, Bear Stearns, Merrill,
Countrywide, Fannie/Freddie, GM (old), Nortel, Kodak, Circuit City, RadioShack, SunEdison,
Wachovia, Wyeth**, …

**Coverage gap: 84%.** Of a 50-name point-in-time slice, only **8 survivors**
(AAPL, MSFT, XOM, GE, C, INTC, CSCO, AIG) have obtainable free price history. All 42
delisted names return `no-data` from Yahoo. So even the "honest" run is still survivor-heavy.

## The bias, quantified (the deliverable)

| Universe | 12-1 momentum, 2005→now | Sharpe | maxDD | Note |
|---|--:|--:|--:|---|
| Hand-picked winners (the mirage) | **+33,937%** | 1.19 | −44% | 100% survivorship-selected by construction |
| Partial survivors-only ("honest") | +8,490% | 0.91 | −53% | still inflated — 84% of the real universe missing |
| **Published CRSP truth** (Jegadeesh-Titman / AQR / Daniel-Moskowitz) | — | **~0.5** | **−50%+ crashes** | the actual ceiling |

Clean survivorship-free 12-1 momentum: gross premium ~5–14%/yr, **Sharpe only ~0.5**,
defined by **momentum crashes** (2009: −50%+ in months, forecastable in post-decline
high-vol panic states), and ~100%+/month one-way turnover that costs eat.

## Verdict

The $2M "upgrade" was a **survivorship mirage**, now measured: even a partial de-biasing
cut the Sharpe 1.19 → 0.91, and the true ceiling (~0.5, crash-prone) is **below the
champion's own 0.66** with worse drawdowns. **The champion should not be upgraded with
single-stock momentum.** The only momentum harvestable cleanly is the momentum ETFs
(XMMO/SPMO) already in it — they do survivorship-free selection over real index
constituents internally. Grounding for the published numbers: PR #2735 added the CRSP /
momentum-crash / backtest-overfitting literature to the corpus.

Reproduce: `experiments/survivorship_momentum/momentum_backtest.py` (+ `coverage_yahoo.json`,
`results.json`). To do it *right*: a free Tiingo key or Sharadar + the fja05680 constituent CSV.
