# Survivorship-free backtest research — corpus expansion & literature grounding

**Date:** 2026-07-18 · **Branch:** `claude/survivorship-free-backtest-research-b96611` ·
**Corpus:** 11-paper curated tranche added to `F:\arxiv-corpus` (see
`F:\arxiv-corpus\pdfs\REVIEW-2026-07-18-survivorship-backtest.md`), index rebuilt
114,275 → **114,286** docs, retrieval verified (each anchor ranks #1 on its themed query).

**The problem being grounded.** The "$2M" single-stock DCA figure (chat session 2026-07-18)
was computed over hand-picked, currently-alive winners from Yahoo — a data source with **no
delisted stocks and no point-in-time index membership**. A truly survivorship-free single-stock
backtest needs the dead companies with their prices, plus which tickers were in the index on
each historical date (CRSP-grade data). This doc records (1) what the corpus now contains to
ground that research, (2) the free-data recipe for a point-in-time universe, and (3) the
published bias magnitudes the measured inflation should be compared against.
The index-level deep-history work (`experiments/DEEP_HISTORY_RESEARCH_LOG.md`, PR #2728) is
*already* survivorship-immune at the asset level — `^GSPC`/`^IXIC` include the drag of every
constituent that later died — so this effort is about the **single-stock** claim only.
(`experiments/dca_walkforward_sim.py` likewise already gates ETFs on verifiable history — the
repo precedent for "no survivorship shortcut".)

---

## 1 · What was already in the corpus (2025-07→ harvest) — now citable for this work

BM25 sweeps (10 themed queries) over the 114k-doc corpus found real coverage in three clusters:

**Selection/overfitting protocols (measure the inflation):**
- `2606.01650` *Post Selection Estimation of Sharpe Ratios* — estimators for the true Sharpe of
  the asset picked for having the max in-sample Sharpe (polyhedral lemma, shrinkage, empirical
  Bayes). The direct modern tool for goal (b).
- `2603.09219` *AlgoXpert: rigorous IS/WFA/OOS protocol for mitigating overfitting*;
  `2602.00080` *GT-Score: robust objective reducing overfitting*; `2602.10785` *double
  out-of-sample parameter optimization* — protocol templates for re-running the backtest.
- `2604.08356` *Measuring Strategy-Decay Risk: minimum regime performance*; `2512.11913` *Not
  All Factors Crowd Equally: alpha decay* — durability framing for whatever survives.
- `2606.19550` *Which Portfolios? Construction Dependence of Factor Model Performance* — the
  result depends on universe construction; exactly the sensitivity we're testing.

**Survivorship/look-ahead measurement (named, recent, quantified):**
- `2603.19380` *Survivorship Bias in Emerging Market Small-Cap Indices (NIFTY Smallcap 250)* —
  the corpus's one direct index-survivorship quantification; template for measuring ours.
- `2603.20237` *Temporal Coverage Bias in Financial Panel Data* — coverage-aware panel
  structuring; the panel-level generalization of our missing-dead-tickers problem.
- LLM-era look-ahead cluster (relevant because our loop uses LLMs): `2601.13770`
  *Look-Ahead-Bench* (point-in-time LLMs), `2603.11838` *DatedGPT*, `2512.23847` *Detecting
  Lookahead Bias in LLM Forecasts*, `2510.11677` *Chronologically Consistent LMs*,
  `2605.24564` *Mitigating Look-Ahead Bias in Financial Backtesting with LLMs*.

**Strategy-adjacent:** `2601.06074` *Clarifying Note on Long-Horizon Investment and
Dollar-Cost Averaging*; `2603.01298` *Single-Asset Adaptive Leveraged Volatility Control*;
`2607.00883` *Tail Risk Management with Puts and Trend Following*; `2607.01550` *Is Trend
Still Your Friend?* (microstructural demise of short-term trend).

**The gap the sweeps exposed:** zero pre-2025 canon — no CFM long-history papers, no
max-Sharpe selection-bias inference, no drawdown-significance work, nothing on constituent
reconstruction. Hence the tranche.

## 2 · The 11-paper tranche (added 2026-07-18, PDFs in `F:\arxiv-corpus\pdfs\`)

All ids web-verified, then title-matched against the arXiv API before ingest
(`arxiv_add_papers.py --dry-run`; the dry-run also caught PowerShell double-parsing eating
trailing zeros from 3 unquoted ids — quote id lists).

| arXiv id | paper | grounds |
|---|---|---|
| `1906.00573` | Pav — *Conditional inference on the asset with maximum Sharpe ratio* | The core "you picked the winner" correction: post-selection inference on the max-Sharpe asset among correlated candidates, nominal type-I rate. |
| `1911.04090` | Pav — *A post hoc test on the Sharpe ratio* | Companion post-hoc Sharpe machinery. |
| `1905.08042` | Benhamou et al. — *Testing Sharpe ratio: luck or skill?* | The $2M question as a formal test. |
| `1107.0036` | Borodin et al. — *Can We Learn to Beat the Best Stock* | "Best stock in hindsight" as formal benchmark (online portfolio selection / regret); the theory frame for hindsight-picking value. |
| `1707.01457` | Rej, Seager, Bouchaud — *You are in a drawdown. When should you start worrying?* | Exact last-drawdown length/depth distributions vs assumed Sharpe; both managers and investors underestimate. |
| `1404.3274` | Lempérière et al. — *Two centuries of trend following* | Survivorship-immune anchor: trend t-stat ≈ 5 since 1960, ≈ 10 since 1800, four asset classes, spot/futures indices. |
| `1607.02410` | Dao et al. — *Tail protection for long investors: Trend convexity at work* | Trend P&L = long-term − short-term variance; the overlay's crisis convexity, measured. |
| `1409.7720` | Lempérière et al. — *Risk Premia: Asymmetric Tail Risks and Excess Returns* | Sharpe ≈ linear in negative skew; trend is the positive-skew exception (anomaly, not premium). |
| `1708.07637` | *Trends and Risk Premia: Update and Additional Plots* | Updated companion plots. |
| `2209.05559` | Gort, Liu et al. — *DRL for Crypto Trading: Addressing Backtest Overfitting* | Overfitting detection as a rejectable hypothesis test over variants (operational PBO-style filter). |
| `2412.14361` | Massaad et al. — *Refining and Robust Backtesting of A Century of Profitable Industry Trends* | A published 18.2%-CAGR / 1.39-Sharpe century strategy degrades under walk-forward re-testing — the cautionary template for our own headline numbers. |

**Not addable (not on arXiv) — cite directly:** Bailey, Borwein, López de Prado, Zhu
*Pseudo-Mathematics and Financial Charlatanism* (AMS Notices 2014; SSRN 2308659) — expected
max in-sample Sharpe grows with configurations tried, and under memory effects overfit
backtests have *negative* expected OOS returns; *The Deflated Sharpe Ratio* (SSRN 2460551);
Pav *A Short Sharpe Course* (SSRN 3036276); Bessembinder *Do Stocks Outperform Treasury
Bills?* (JFE 2018); Ammann, Burdorf, Liebi, Stöckl *Survivorship and Delisting Bias in
Cryptocurrency Markets* (SSRN 4287573); Brown-Goetzmann-Ross (1995) and
Elton-Gruber-Blake (1996) on fund survivorship.

## 3 · Free-data recipe for the point-in-time universe (goal a)

Not arXiv material — engineering references, recorded here:

- **Wikipedia "List of S&P 500 companies"** maintains a *selected changes* table
  (additions/removals with dates); the page's **revision history** gives point-in-time
  snapshots back to ~2007-2008. Two worked implementations:
  [teddykoker/survivorship-free-spy](https://github.com/teddykoker/survivorship-free-spy)
  (constituent CSVs + Python walkthrough) and
  [riazarbi's reconstruction](https://riazarbi.github.io/quant/backtesting-sp500-constituent-history/)
  (Wikipedia-revision method, documents its gaps).
- **Delisted-ticker roster:** Alpha Vantage `LISTING_STATUS` (free key, memory
  `options-iv-data-sources`) returns active *and delisted* symbols with listing/delisting
  dates — the roster of the dead, though **not** their price history.
- **Dead-company prices remain the hard part** on free data: Yahoo drops delisted tickers
  entirely. Stooq carries some; Alpaca (when :4177 is back) covers ~2016+ including many
  since-delisted symbols; IBKR historical data needs Alex to refresh stale creds
  (memory `ibkr-local-owner-creds-stale`). Anything unreachable gets bounded, not ignored:
  delisting-return assumptions bracketed per Shumway-style corrections (−30%/−55% NYSE/AMEX vs
  ~−90% Nasdaq performance-delistings are the literature's brackets; verify before using).
- **Honesty rule from the repo's own precedent** (`dca_walkforward_sim.py`): instruments enter
  the sim only when they verifiably existed with history; where the universe can't be
  reconstructed, the claim shrinks to the reconstructable window instead of extrapolating.

## 4 · Published bias magnitudes (goal b's comparison row)

Priors the measured hand-picked-winners inflation should be compared against — each
`[claim → source → confidence]`:

- Equity mutual-fund survivorship inflates annual returns **~1-2%/yr** (BGR 1995) /
  **~1.4%/yr, growing with horizon** (EGB 1996) → journal classics, abstract-level →
  **0.9** (magnitudes widely replicated).
- Crypto universe truncated by survivorship+delisting: **+0.93%/yr value-weighted, +62%/yr
  equal-weighted**; size premium overstated ~50% (Ammann et al., 3,904 coins 2014-21) → SSRN
  4287573 → **0.85**. The EW number is the cleanest warning for small hand-picked universes.
- **~4% of US stocks account for all net wealth creation above T-bills since 1926; the median
  stock's lifetime buy-and-hold return trails one-month T-bills** (Bessembinder JFE 2018) →
  **0.9**. This is the direct counterfactual to "the GEs, Ciscos, Lehmans, Nokias": a uniform
  draw from the historical universe most likely underperforms cash; hand-picking today's
  survivors samples the 4%.
- Expected max in-sample Sharpe of N unskilled configurations grows ~√(2·ln N); overfit
  selection ⇒ **negative** expected OOS under memory effects (Pseudo-Mathematics, AMS 2014)
  → **0.9**.
- Index-membership look-ahead (using today's constituents historically) is quantified for an
  EM small-cap index in-corpus (`2603.19380`) — read before citing numbers → **0.6** until read.
- What honest long-history looks like: trend on indices t-stat ≈ 10 over two centuries
  (`1404.3274`) — significance from breadth×time, not from picking winners → **0.85**.

**What this tranche does NOT license:** any alpha claim. It grounds *methodology and
magnitudes*. The measured $2M-deflation number must come from our own reconstruction
(Σ₀: our deployments' evidence must be our own measurements), with the literature as the
sanity band — mirroring how PR #2728 validated the overlay against published trend work.

## 5 · Next steps (for the follow-on iteration on this branch)

1. Rebuild the universe: Wikipedia-revision S&P 500 membership (2008→) + Alpha Vantage
   delisted roster; freeze as a point-in-time JSONL under `data/` with provenance per row.
2. Re-run the single-stock DCA on (i) hand-picked winners, (ii) point-in-time index members
   with delisting brackets — the spread between (i) and (ii) IS the measured inflation;
   deflate (i)'s Sharpe per the max-of-N corrections (`1906.00573`, `2606.01650`).
3. Log the convergence record: hypothesis (inflation ≥ X%/yr), evidence (both runs + corpus
   cites), confidence split (measured vs literature-bracketed), sources (this doc).
