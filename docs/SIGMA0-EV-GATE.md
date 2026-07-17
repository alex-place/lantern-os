---
author: Alex Place
created: 2026-06-30
updated: 2026-06-30
---

# Σ₀ EV Gate — the trader's Converge stage

*How unisona.ai decides ENTER vs SKIP on a candidate trade: one transparent
expected-value model over weighted evidence, not a stack of discretionary gates.*

Source: [`apps/lantern-garage/lib/signal-engine/convergence-ev.js`](../apps/lantern-garage/lib/signal-engine/convergence-ev.js) (ported from the retired `src/trading_agents/convergence_ev.py`)
· council read side: [`apps/lantern-garage/lib/sigma0-trader-council.js`](../apps/lantern-garage/lib/sigma0-trader-council.js)
· API: `GET /api/trading/sigma0/calibration`

---

## Plain-language summary

The trader collects evidence from several detectors — Grok's read, Claude's read,
whether price is at a real support/resistance zone, a 1-minute structure shift, a
candle pattern, the higher-timeframe trend, and ticker news. The old design ran
these as **pass/fail gates** (Riley's WAIT/GOOD/PERFECT tiers, plus a Claude HOLD
veto), which exists to stop a *human* from overtrading. unisona.ai doesn't need that
crutch — it can weigh every piece at once and act on **expected value**.

The EV gate turns each candidate trade into a **Convergence Record** (one of
unisona.ai's four core objects: hypothesis + evidence + confidence + result) and
makes a single, auditable ENTER/SKIP call.

---

## The model

Each signal is normalised to `[0, 1]` where `0.5` = neutral. The win probability
is a transparent linear model:

```
p_win  = base_rate + Σ wᵢ · (signalᵢ − 0.5) · 2
EV (R) = p_win · target_R − (1 − p_win) · 1R     # risk 1R to make target_R
ENTER  iff has_evidence AND EV ≥ EV_MIN AND p_win ≥ P_MIN
```

- **`base_rate`** — the realized win-rate for this ticker+direction (≥5 closed
  trades), else the 90-day backtest hit-rate, else a 0.5 prior. This is the
  External-Reality anchor: the prior is grounded in measured outcomes, not optimism.
- **`target_R`** — reward:risk (`tp% / |stop%|`).
- **`EV_MIN = 0.15`**, **`P_MIN = 0.45`** — require a real +0.15R edge *and* a 45%
  hit-rate, so a huge target alone can't carry junk.
- **`has_evidence`** — the evidence floor that replaces Riley's discipline tiers:
  at least one *grounding* signal must be real (a zone, a structure shift, a graded
  pattern, trend agreement, or a meaningful news lean). A bare +EV from an
  optimistic reward:risk is **not** enough to act.

### Evidence weights

Weights are how many probability-points a fully-confirming signal (`1.0`) adds.
They need not sum to 1 (`p_win` is clamped to `[0.05, 0.95]`), and the council
re-weights them from realized edge over time.

| signal | weight | meaning |
|---|---|---|
| `grok` | 0.09 | Grok analyst directional conviction (council member) |
| `claude` | 0.09 | Claude decision conviction (council member) |
| `zone` | 0.14 | at a real S/R zone, scaled by strength/touches |
| `structure` | 0.16 | 1-min structure shift confirmed (the key Riley trigger) |
| `pattern` | 0.12 | A/B/C candle-pattern grade |
| `trend` | 0.10 | higher-tf trend agrees with the trade direction |
| `news` | 0.10 | ticker news sentiment agrees with direction (signed to side) |

`backtest` is folded into `base_rate` rather than carried as a signal.

---

## Grok + Claude are council members, not gates

Grok and Claude used to be a single opaque `llm` signal, and Claude additionally
ran *after* the EV gate as a hard **HOLD veto** that could kill a trade the EV had
already approved. As of 2026-06-30 both are absorbed into this one council:

1. **Split signals.** `grok` and `claude` are separate, individually-graded
   signals (`llm_conf` stays a back-compat alias → `grok_conf`; `claude` defaults
   to neutral `50`). The per-signal realized-edge table now shows each model's
   edge on its own, so a model with no predictive lift gets re-weighted down.
2. **Σ₀ EV is the sole decider.** After Claude returns, the EV **re-scores** with
   both convictions — Claude `BUY/SELL` agreeing with direction → `78`, `HOLD` →
   `35` (a lean against, not a veto), opposing → `15` — and that combined EV makes
   the ENTER/SKIP call. A Claude HOLD now only lowers `p_win`; it no longer
   unilaterally vetoes a +EV trade.
3. **Risk stays enforced.** Portfolio risk (max positions, delta limits) is still
   enforced downstream by `agent_risk_manager` — which is what Claude's HOLD was
   redundant with.

A cheap **Grok-only pre-screen** (Claude neutral) runs first as a token-saver:
clearly-below-bar candidates SKIP before Claude is ever called. Set `SIGMA0_EV=0`
to restore the legacy Claude-as-hard-gate behavior.

---

## The Convergence loop (Observe → … → Converge)

Every executed ENTER persists a `ConvergenceRecord` to the shared store
(`data/convergence/records.jsonl`); on close, a Brier-graded outcome is appended
to `data/convergence/trader-outcomes.jsonl`:

```
brier = (confidence − outcome)²        # outcome = 1 win / 0 loss
```

The **Σ₀ council** (`sigma0-trader-council.js`) reads those outcomes and computes:

- **calibration** — canonical Brier / ECE / skill grader. Grades **only
  conviction-bearing rows** (`conviction_recorded !== false`): a trade backfilled
  with a 0.5 no-information prior (e.g. a cross-project trade whose system never
  logged its conviction) is excluded so it can't pile into the 0.5 Brier bin and
  fake calibration. Such rows still count toward `win_rate` / `avg_pnl_pct` as
  realized-outcome volume. The snapshot reports `graded` (all rows),
  `graded_with_conviction` (calibration set), and `graded_with_signals`
  (per-signal-edge set).
- **per-signal realized edge** — for each signal, the win-rate when it fired
  *strong* (>0.55) vs *weak*; `lift = strong_winrate − weak_winrate`. A positive
  lift means the signal genuinely predicted wins and earns (more) weight; ≈0 or
  negative means it's noise. This is the evidence for re-weighting the EV.

The council is `warming` until ≥20 **conviction-graded** trades, then `ready`. It
surfaces at `GET /api/trading/sigma0/calibration`.

### Warm-up from historical data

`scripts/warm_sigma0_council.py` backfills the council from **real** closed trades
so it starts `ready` with a live per-signal edge table instead of cold. Two
externally-grounded sources, every row tagged `source` and idempotent (re-runnable;
remove with `grep -v '"source": "warmup'`):

- **lanternOS `lessons.db`** — closed trades joined to `records.jsonl` by ticker +
  nearest timestamp for the full signal vector and the Σ₀ `p_win`. Outcomes are
  **recomputed from the actual Alpaca fill prices**, because the stored `pnl_pct`
  column is corrupted (sign-flipped on the TP-zone / EOD rows). These rows carry
  the signal vectors that drive `per_signal_edge` (the re-weighting evidence).
- **Independant AI Trader `trading.log`** — 54 `EOD closed TICKER: X%` outcomes
  over ~7 weeks (2026-05-11 → 06-30) from a *separate* system. No signal vector and
  no recorded conviction, so they carry `confidence = 0.5` (no-information prior)
  and `conviction_recorded: false`: they ground the win-rate/volume but the council
  **structurally excludes them from calibration and the maturity gate** (and they
  carry no `signals`, so per-signal edge already ignores them).

**External-Reality grounding.** Nothing synthetic is injected — each row is a real
realized outcome. The intraday fills are the broker's own record (the authoritative
external anchor); a second independent system corroborates the win-rate regime. The
council's strongest emergent signal — **news sentiment (lift ≈ +0.27)** — is
directionally consistent with the literature on short-term/intraday return
predictability (e.g. news sentiment ranking second only to volume in LSTM studies),
though that literature also cautions the economic significance is contested — fitting
a thin, early council. Treat the warmed edges as a **prior**, not a verdict, until
live closed trades accumulate.

---

## External-Reality Rule

Every record carries `why` — the signals that moved the decision, strongest first
— so the call is auditable: **[claim, evidence, confidence, source]**. Nothing is
accepted without evidence; the evidence floor and the realized-win-rate base rate
are where this rule bites.

---

## Tuning knobs

| env | default | effect |
|---|---|---|
| `SIGMA0_EV` | `1` | `0` disables the EV gate / restores Claude's hard veto |

Weights, `EV_MIN`, `P_MIN`, and `P_CLAMP` are module constants in
`convergence_ev.py`; the council's per-signal lift table is the data you use to
adjust them.

## Tests

`tests/test_convergence_ev.py` pins the contract: confirming evidence raises
`p_win` monotonically, the gate only fires on a real positive edge, news is signed
to direction, Grok and Claude are graded separately, `llm_conf` back-compat holds,
and every decision carries an auditable record + `why`.
