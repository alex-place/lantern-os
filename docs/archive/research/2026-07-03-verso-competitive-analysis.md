---
author: Alex Place
created: 2026-07-03
---

# Verso competitive analysis — how the Kalshi terminal wins

**Competitor:** [verso.trading](https://www.verso.trading/) — "the Bloomberg Terminal for
prediction markets." Sources:
[polymark.et/product/verso](https://polymark.et/product/verso),
[cryptobriefing](https://cryptobriefing.com/kalshi-bloomberg-terminal-prediction-markets/),
[Awesome-Prediction-Market-Tools](https://github.com/aarora4/Awesome-Prediction-Market-Tools).

## What Verso is (evidence)

A **data + intelligence terminal**. It *shows*; it does not ground a tradeable edge or execute.

- Live Kalshi **odds, depth, volume, smart alerts** across **15,000+ contracts** on one
  "institutional screen." *(their headline copy.)*
- **Market screener** — filter by category, price change, volume, expiry, custom timeframe.
- **AI news engine** — maps **30,000+ articles** to contracts via LLM embeddings + "GPT-5
  impact estimation" to score which headlines move markets. *(their standout feature.)*
- Full **mobile** interface; **Polymarket + multi-venue** planned.
- Solo-built (@agpkeleta). Minimalist, data-oriented. No pricing shown.

**The tell:** Verso's ceiling is *Observe*. Its AI answers "which headline matters," not
"what is this contract actually worth, and are we right over time." It hands the user data and
stops.

## Us vs Verso — where each wins

| Capability | Verso | Us (Kalshi terminal) |
|---|---|---|
| Live odds / volume | ✅ | ✅ (`kalshi-collector`, 6s) |
| **Order-book depth** | ✅ surfaced | ⚠️ fetched (`getOrderbook`) but not laddered in UI |
| **Screener** (filter/sort all contracts) | ✅ | ❌ curated decks only (weather/crypto/events) |
| **Configurable alerts** | ✅ | ❌ none |
| Coverage breadth | ✅ 15k+ | ⚠️ curated edges, not the full board |
| News → contract mapping | ✅ 30k articles, impact score | ⚠️ have news + grounding, not a systematic map |
| Mobile | ✅ full | ⚠️ responsive, not app-grade |
| **Grounded P(YES) vs market** | ❌ | ✅ `kalshi-grounding` — cited, web-grounded |
| **Real edge sources** | ❌ | ✅ NWS/MOS **weather** models, macro (FRED/AV) |
| **Fees / EV gate / Kelly sizing** | ❌ | ✅ `kalshi-fees`, `kalshi-kelly` |
| **Forward grading** (Brier / calibration) | ❌ | ✅ `kalshi-calibration`, `kalshi-winrate-tracker` |
| **Execution** (position-taker) | ❌ | ✅ grounded position-taker + adaptive exits |
| Σ₀ council + continual learning | ❌ | ✅ `kalshi-council`, convergence trainer/LoRA |

## The wedge — our moat is the whole loop, not the screen

Verso is **Observe**. We are **Observe → Remember → Reason → Act → Verify → Converge**. Their
AI scores *attention*; ours produces a **falsifiable, cited P(YES)** and only acts when it
**diverges from the market past the fee hurdle** — then grades itself forward by Brier score.

> **Positioning:** *"Verso shows you the odds. Unisona tells you which odds are **wrong** —
> with a cited source and a track record."*

That is a categorically higher-value product: an **edge engine**, not a data feed. Momentum on
efficient markets has no edge after fees (proven in PR #1765); the durable edge is
**information the thin market hasn't priced** — exactly what our grounding + weather/macro
models target. Verso literally cannot make that claim; it has no ground truth and no forward
score.

## How to be better — prioritized

**1. Surface the moat (highest ROI, mostly already built).** Put our unique columns *on the
screen* Verso can't match: for every contract show **market price · grounded P(YES) · edge (bps
after fees) · our Brier on similar calls**. A user glancing at our terminal sees *mispricings
ranked*, not just movers. This is our "one screen," and it's differentiated by alpha, not
density.

**2. Close the table-stakes gaps — but make each alpha-aware (don't just copy Verso):**
   - **Screener** across all `getMarkets` contracts — but the killer sort is **by our
     computed edge/EV**, not just volume/price-change. Verso sorts by *what moved*; we sort by
     *what's wrong*.
   - **Configurable alerts** — not "price crossed X" (Verso) but **"grounded edge on a
     contract exceeded N bps"** and **"a cited source shifted our P(YES) past the fee hurdle."**
     Alerts on *edge*, not noise.
   - **Depth ladder UI** — we already fetch the orderbook; render it. Table stakes.

**3. Beat their news engine on its own turf.** Verso maps news→contract and scores *impact*.
We map news→contract **and** emit a **cited P(YES) delta with a forward Brier** — "this Reuters
headline implies YES 62% vs market 55%; here's the source; here's our hit-rate on such calls."
Reuse `news-collector` + `kalshi-grounding`; the differentiator is verification, not embeddings.

**4. Multi-venue (match their roadmap).** Add Polymarket read + grounding so the edge engine
spans venues — and surface **cross-venue arbitrage** (same event, different price), which a
single-venue screener can't.

**5. Trust as a feature.** Publish the **calibration curve + Brier history** in-product (we
already compute them). Verso asks you to trust its impact score; we *show ours being right or
wrong over time* — the External-Reality Rule as a marketing asset.

## Honest scope

- We are behind on **breadth + polish** (screener, alerts, depth UI, mobile, 15k coverage) —
  these are real, buildable gaps, not moat.
- Our moat (grounded edge + EV + forward grading + execution) is **built but under-surfaced** —
  the fastest wins are exposure, not net-new capability.
- Verso is well-executed and fast-moving (solo founder, active). Competing on "prettier data
  terminal" is a losing race; competing on "the only one that's provably right" is ours to win.
</content>
