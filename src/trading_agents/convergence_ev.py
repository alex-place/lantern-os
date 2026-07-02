"""
convergence_ev.py — Σ₀ expected-value decision layer over Riley's signals.

Riley's WAIT/GOOD/PERFECT tiers and "extreme-zones-only" gates exist to manage
HUMAN error — they keep a discretionary trader from overtrading and from acting
on partial confirmation. Keystone doesn't need that crutch: it can weigh every
piece of evidence at once and act on EXPECTED VALUE.

This module turns a candidate trade into a Convergence Record (one of Keystone's
four core objects):  hypothesis + evidence + confidence + result.  Riley's
detectors (zone, 1-min structure shift, candle pattern, trend) stay — but as
WEIGHTED EVIDENCE, not pass/fail gates. The decision is:

    p_win   = base_rate + Σ wᵢ·(signalᵢ − 0.5)        # transparent linear model
    EV (R)  = p_win·target_R − (1 − p_win)·1R          # risk one R to make target_R
    ENTER   iff EV ≥ EV_MIN and p_win ≥ P_MIN          # no discretionary tiers

Every record carries `why` (the evidence that moved it) so the call is auditable
— the External-Reality Rule: [claim, evidence, confidence, source]. Pure +
dependency-free so it unit-tests without Alpaca or the rest of the engine.
"""

from __future__ import annotations

# Evidence weights. Each signal is normalised to [0,1] where 0.5 = neutral; the
# weight is how many probability-points a fully-confirming signal (1.0) adds.
# Tunable via the engine; they need not sum to 1 (p_win is clamped).
WEIGHTS = {
    "grok":      0.09,   # Grok analyst directional conviction (council member)
    "claude":    0.09,   # Claude decision conviction (council member, was a gate)
    "zone":      0.14,   # at a real S/R zone, scaled by strength/touches
    "structure": 0.16,   # 1-min structure shift confirmed (the key Riley trigger)
    "pattern":   0.12,   # A/B/C candle pattern grade
    "trend":     0.10,   # higher-tf trend agrees with the trade direction
    "news":      0.10,   # ticker news sentiment agrees with direction
    "backtest":  0.00,   # folded into base_rate instead (see below)
}

EV_MIN = 0.15   # require ≥ +0.15R edge after costs to act
P_MIN  = 0.45   # and at least a 45% hit-rate, so a huge target can't carry junk
P_CLAMP = (0.05, 0.95)


def _clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


EDGE_SENS = 5.0   # conviction sensitivity: full ±0.5× swing over p_win 0.40↔0.60


def edge_risk_multiplier(p_win, target_r=None) -> float:
    """Edge-proportional risk sizing — a bounded, risk-NEUTRAL conviction scaler
    on the flat-$ risk.

    The engine risks a flat $ per trade regardless of conviction; the old Kelly
    path that was meant to vary size is dead (place_order takes a qty_override).
    This revives the intent: lean in on high-conviction setups, lean out on
    marginal ones — but *centred on 1.0* so it does not net-inflate risk (a pure
    half-Kelly saturates the cap for almost every gate-passing p_win at 3R, which
    would just be a blanket +50%). Sizing is driven by the calibrated hit-rate
    p_win (target_r already governs the ENTER/SKIP decision in the EV gate):

        mult = clamp(1.0 + EDGE_SENS · (p_win − 0.5), 0.5, 1.5)

    So p_win 0.50 → 1.0× (neutral), 0.60 → 1.5× (cap), 0.40 → 0.5× (floor). Pure
    (no I/O), unit-tests standalone. Returns 1.0 on bad inputs; `target_r` is a
    validity guard only (≤0 or non-numeric → neutral 1.0).
    """
    try:
        p = float(p_win)
    except (TypeError, ValueError):
        return 1.0
    if target_r is not None:
        try:
            if float(target_r) <= 0:
                return 1.0
        except (TypeError, ValueError):
            return 1.0
    if not (0.0 < p < 1.0):
        return 1.0
    mult = 1.0 + EDGE_SENS * (p - 0.5)
    return _clamp(round(mult, 3), 0.5, 1.5)


def _grade_to_signal(grade):
    return {"A": 1.0, "B": 0.75, "C": 0.6}.get(str(grade or "").upper(), 0.5)


# ── Closed learning loop: adapt WEIGHTS from realized per-signal edge ───────────
# The council (sigma0-trader-council.js) already measures, for each signal, the
# win-rate when it fired "strong" (>0.55) vs "weak" — lift = strong − weak. A
# positive lift means the signal genuinely predicted wins and deserves more
# weight; ~0/negative means noise. These pure functions turn that lift into a
# BOUNDED re-weighting so the engine can close the loop on its own outcomes —
# never trusted until the sample is mature, never moved more than ±50%.

ADAPT_MIN_ROWS = 20     # need this many graded rows before adapting at all
ADAPT_MIN_BUCKET = 5    # and this many in BOTH strong/weak buckets per signal
ADAPT_GAIN = 2.0        # weight × (1 + GAIN·lift), so lift ±0.25 → ×1.5 / ×0.5
ADAPT_BOUND = (0.5, 1.5)


def per_signal_lift(rows) -> dict:
    """Realized per-signal edge from graded convergence rows (pure).

    Each row: {"signals": {name: 0..1, ...}, "outcome": bool | "passed": bool,
    ...}. Mirrors the JS council's perSignalEdge: a signal counts "strong" when
    its value > 0.55. Returns {name: {strong_n, strong_wr, weak_n, weak_wr,
    lift}}. lift is None until both buckets have ≥1 sample.
    """
    acc = {}
    for r in rows or []:
        sig = (r or {}).get("signals")
        if not isinstance(sig, dict):
            continue
        win = 1 if (r.get("outcome") or r.get("passed")) else 0
        for k, v in sig.items():
            a = acc.setdefault(k, {"sN": 0, "sW": 0, "wN": 0, "wW": 0})
            try:
                strong = float(v) > 0.55
            except (TypeError, ValueError):
                continue
            if strong:
                a["sN"] += 1; a["sW"] += win
            else:
                a["wN"] += 1; a["wW"] += win
    out = {}
    for k, a in acc.items():
        sw = a["sW"] / a["sN"] if a["sN"] else None
        ww = a["wW"] / a["wN"] if a["wN"] else None
        out[k] = {
            "strong_n": a["sN"], "strong_wr": sw,
            "weak_n": a["wN"], "weak_wr": ww,
            "lift": (sw - ww) if (sw is not None and ww is not None) else None,
        }
    return out


def adapt_weights(rows, base=None, min_rows=ADAPT_MIN_ROWS,
                  min_bucket=ADAPT_MIN_BUCKET, gain=ADAPT_GAIN,
                  bound=ADAPT_BOUND):
    """Return WEIGHTS re-scaled by realized per-signal lift (pure).

    Conservative by construction: returns `base` UNCHANGED unless there are
    ≥min_rows graded rows carrying a signals vector; and per signal, only adjusts
    when BOTH strong/weak buckets have ≥min_bucket samples (else that weight is
    left at base). Each weight moves by clamp(1 + gain·lift, *bound) — capped at
    ±50% so one noisy streak can't hand a signal the whole book.
    """
    b = dict(base or WEIGHTS)
    graded = [r for r in (rows or []) if isinstance((r or {}).get("signals"), dict)]
    if len(graded) < min_rows:
        return b
    edge = per_signal_lift(graded)
    out = dict(b)
    for k, w in b.items():
        e = edge.get(k)
        if not e or e["lift"] is None:
            continue
        if e["strong_n"] < min_bucket or e["weak_n"] < min_bucket:
            continue
        factor = _clamp(1.0 + gain * e["lift"], bound[0], bound[1])
        out[k] = round(w * factor, 4)
    return out


def score_convergence(ev: dict, weights: dict = None) -> dict:
    """
    Score one candidate trade. `ev` (all optional, neutral defaults):
      direction:        "BULLISH" | "BEARISH"
      grok_conf:        0..100   Grok analyst directional confidence
      claude_conf:      0..100   Claude decision conviction (neutral 50 pre-Claude)
      llm_conf:         0..100   DEPRECATED alias → grok_conf (back-compat)
      in_zone:          bool
      zone_strength:    0..100
      zone_touches:     int
      structure_shifted:bool
      structure_conf:   0..100
      pattern_grade:    "A"|"B"|"C"|None
      trend_aligned:    bool      higher-tf trend matches direction
      trend_conflicts:  bool      higher-tf trend OPPOSES direction (counter-trend)
      news_sentiment:   -1..1     +ve = bullish news (signed to direction below)
      backtest_winrate: 0..1      historical hit-rate of this setup (base rate)
      target_r:         float     reward/risk multiple (tp% / |stop%|)

    Returns: {p_win, ev_r, target_r, decision: "ENTER"|"SKIP", signals, why, record}
    """
    direction = str(ev.get("direction", "NEUTRAL")).upper()
    target_r = float(ev.get("target_r") or 2.0)

    # ── Normalise each piece of evidence to [0,1] (0.5 = neutral) ──────────────
    # Grok and Claude are now SEPARATE council members, each graded on realized
    # edge. `llm_conf` stays a back-compat alias for grok_conf; claude defaults to
    # neutral (50) so the cheap pre-Claude screen runs Grok-only without penalty.
    grok = _clamp((float(ev.get("grok_conf", ev.get("llm_conf", 50))) / 100.0), 0.0, 1.0)
    claude = _clamp((float(ev.get("claude_conf", 50)) / 100.0), 0.0, 1.0)

    if ev.get("in_zone"):
        strength = _clamp(float(ev.get("zone_strength", 50)) / 100.0, 0.0, 1.0)
        touch_bonus = min(0.15, 0.05 * max(0, int(ev.get("zone_touches", 0)) - 1))
        zone = _clamp(0.5 + 0.5 * strength + touch_bonus, 0.0, 1.0)
    else:
        zone = 0.4  # not at a level — mild negative, not disqualifying

    if ev.get("structure_shifted"):
        structure = _clamp(0.6 + 0.4 * (float(ev.get("structure_conf", 60)) / 100.0), 0.0, 1.0)
    else:
        structure = 0.45

    pattern = _grade_to_signal(ev.get("pattern_grade"))

    if ev.get("trend_conflicts"):
        trend = 0.2          # fighting the higher-tf trend
    elif ev.get("trend_aligned"):
        trend = 0.85
    else:
        trend = 0.5

    # News sentiment is signed to the trade direction: bullish news helps a long,
    # hurts a short. Magnitude in [0,1] from |sentiment|.
    raw_news = _clamp(float(ev.get("news_sentiment", 0.0)), -1.0, 1.0)
    signed = raw_news if direction == "BULLISH" else -raw_news if direction == "BEARISH" else 0.0
    news = _clamp(0.5 + 0.5 * signed, 0.0, 1.0)

    signals = {"grok": grok, "claude": claude, "zone": zone, "structure": structure,
               "pattern": pattern, "trend": trend, "news": news}

    # ── p_win = base_rate + Σ wᵢ·(signalᵢ − 0.5) ──────────────────────────────
    # `weights` lets the caller pass realized-edge-adapted weights (adapt_weights);
    # defaults to the static base so the pure/unit-test path is unchanged.
    W = weights if isinstance(weights, dict) and weights else WEIGHTS
    base_rate = _clamp(float(ev.get("backtest_winrate", 0.5)), 0.2, 0.8)
    p = base_rate
    for k, s in signals.items():
        p += W.get(k, 0.0) * (s - 0.5) * 2.0  # ×2 → a full signal moves ~1·weight
    p_win = _clamp(p, *P_CLAMP)

    ev_r = p_win * target_r - (1.0 - p_win) * 1.0

    # External-Reality Rule: nothing is accepted without evidence. A bare +EV from
    # an optimistic reward:risk is NOT enough — require at least ONE grounding
    # signal (a real level, a structure shift, a pattern, trend agreement, or a
    # meaningful news lean). This replaces Riley's WAIT/PERFECT discipline tiers
    # with a single evidence floor, not a checklist.
    has_evidence = (
        bool(ev.get("in_zone"))
        or bool(ev.get("structure_shifted"))
        or _grade_to_signal(ev.get("pattern_grade")) > 0.5
        or bool(ev.get("trend_aligned"))
        or abs(raw_news) >= 0.2
    )
    decision = "ENTER" if (has_evidence and ev_r >= EV_MIN and p_win >= P_MIN) else "SKIP"

    # ── Evidence string: the signals that pulled the decision, strongest first ──
    contrib = sorted(
        ((k, W.get(k, 0.0) * (s - 0.5)) for k, s in signals.items()),
        key=lambda kv: abs(kv[1]), reverse=True,
    )
    label = {"grok": "Grok conviction", "claude": "Claude conviction",
             "zone": "zone", "structure": "1-min structure",
             "pattern": "pattern", "trend": "trend", "news": "news"}
    why = []
    for k, c in contrib:
        if abs(c) < 0.005:
            continue
        why.append(("+" if c > 0 else "-") + label[k])

    record = {
        "type": "convergence_record",
        "hypothesis": {"direction": direction, "target_r": round(target_r, 2)},
        "evidence": {k: round(v, 3) for k, v in signals.items()},
        "confidence": {"p_win": round(p_win, 4), "base_rate": round(base_rate, 3)},
        "ev_r": round(ev_r, 3),
        "decision": decision,
        "result": None,   # filled on close (Verify/Converge)
        "source": "convergence_ev",
    }

    return {
        "p_win": round(p_win, 4),
        "ev_r": round(ev_r, 4),
        "target_r": round(target_r, 3),
        "decision": decision,
        "signals": {k: round(v, 3) for k, v in signals.items()},
        "why": why[:4],
        "record": record,
    }
