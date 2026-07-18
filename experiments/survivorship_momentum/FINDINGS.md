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

---

# Update 2026-07-18 — we got the data and MEASURED it (free path)

Follow-up to the above: a Tiingo key was provided, and we then ran the whole data-vendor
question to ground (`docs/research/2026-07-18-market-data-vendors-survivorship.md`, all 10
vendors, live pricing). Two corrections and a measured result. Pipeline:
`experiments/survivorship_momentum/free_data/` (point-in-time engine + loaders).

## Correction 1 — Tiingo is NOT the "accessible fix" the table claimed
Empirically probed: Tiingo's **free tier caps at 50 req/hr + 500 unique symbols/month** and
its delisted coverage is **spotty** — it has Twitter/Xilinx/Celgene/**SVB-through-collapse**
(2013+), but **not** Lehman/Enron/WorldCom/Bear/old-GM. A full survivorship-free S&P 500
backtest needs ~440 names (the whole cross-section each month, survivors *and* delisted) →
~9 hrs of dripping + the entire month's quota. **Not free-tier feasible.**

## Correction 2 — the free stooq bulk is survivorship-biased too
Downloaded the free `d_us_txt.zip` (13,165 US tickers, 2026-07-18). Coverage vs the S&P 500
ever-member universe (`stooq_coverage.json`): **survivors 501/503 = 100%, but the delisted
cohort only 120/292 = 41%** — and the "present" 120 are mostly *removed-but-still-trading*
names (ANF/CLF/GME); the **172 truly-dead** (JCPenney, Heinz, Dean Foods, Big Lots, Avon,
Safeway, Windstream, Molex…) are gone. stooq serves "what trades today." **No free price
source is survivorship-free** — free membership yes (fja05680), free prices no.

## The measured result (free data, point-in-time membership)
12-1 momentum, long top quintile, monthly, 1-mo skip, S&P 500 with **point-in-time
membership** (fixes the universe-selection bias that produced the earlier $2M mirage),
prices = stooq bulk (survivorship-**inflated** upper bound). `results_measured.json`:

| Window | Momentum Sharpe | Momentum CAGR | maxDD | SPY Sharpe (same window) |
|---|--:|--:|--:|--:|
| 2014–2026 (benign, no '08 crash) | 0.755 | 13.3% | −19% | **0.908** |
| **2002–2026 (full cycle)** | **0.60** | 11.1% | **−54%** | 0.598 |

- The 2014–2026 "win" was **entirely the benign window**; adding 2008–09 collapses momentum
  0.755 → **0.60**, **dead even with plain SPY (0.598)** and with a **−54% drawdown**.
- **survivors-only ≈ partial-debiased to 3 d.p. in BOTH windows** (`mid_hold_delist_frac
  ≈ 0.0002`). This is the *proof* you can't de-bias with free data: the bias-carrying names
  are exactly the ones missing, and a long-*top*-quintile book structurally avoids dying
  (low-momentum) names anyway. So 0.60 is an **upper bound** — the true figure is below it,
  at the published CRSP ~0.5.

## Verdict (now measured, not cited)
**Champion NOT upgraded.** Honest single-stock 12-1 momentum = **0.60 Sharpe full-cycle
(inflated; true ~0.5), −54% maxDD** — it ties buy-and-hold SPY and sits **below the
champion's 0.66**, which carries a fraction of the drawdown (brake-to-cash). Trustworthy
momentum stays via the **XMMO/SPMO ETFs already in the champion**. To get a *clean* number
(not an inflated upper bound) you need paid data — Sharadar ~$30/mo or HistoricalData.net
$299 one-time; the pipeline runs unchanged against either.
