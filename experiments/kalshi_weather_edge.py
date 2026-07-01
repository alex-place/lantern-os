"""
Σ₀ weather-event edge probe for Kalshi KXHIGH* daily-high-temperature markets.

ONE loop, four objects — this is the Reason+Verify stage of the existing
Convergence Core applied to a weather Task; it does NOT add a subsystem:

    Observe  — NWS gridpoint forecast + live ASOS obs        (adapters below; need egress)
    Reason   — calibrated bucket distribution for the day's high   (this module, pure)
    Verify   — edge vs live market, net of fees, ROBUST across the calibration band
    Converge — feeds the existing kalshi-suggest / council EV gate (handoff)

Why this market is the cleanest Σ₀ grounding we have: Kalshi KXHIGHNY settles on
the NWS Daily Climatological Report for Central Park (KNYC) — the prediction target
and the settlement source are the SAME external measurement, so the "observation
channel poisoning" gap (ANTI-COLLAPSE-HARDENING.md G1) is closed by construction.

CALIBRATION IS MEASURED, not assumed (see
docs/research/2026-06-30-sigma0-weather-oracle-kalshi-edge.md for the pulls):
  - KNYC daily normal high, early July ≈ 83.8 °F        (NCEI 1991–2020 normals)
  - Early-July daily-high 90th pct ≈ 92 °F              (WeatherSpark)
  - Central-Park cool bias + large-anomaly regression   (downshifts the forecast)
  - ≥100 °F is a hard CEILING: 60 days in 157 yrs, only ~5 since 2001, and the
    LAST 100 °F at Central Park was 2012-07-18; the 2019/2022/2025 heat waves
    all stalled at 99 °F.  (NWS OKX 100-Degree-Days record.)
    => the naive-Gaussian upper tail is refuted; we cap it and pile mass at 98–99.

HONESTY BY CONSTRUCTION: an edge is reported ONLY if it survives the whole
calibration band (σ and downshift uncertainty). A point-estimate "edge" that
flips sign when the high turns out more/less predictable is noise, not signal —
that is precisely how the naive model hallucinated a +13¢ edge on the routine
day. The band is the seam where a measured forecast-conditional bias (IEM/MOS
forecast↔obs pairing, run on the server that HAS egress) tightens it to a line.

Run:   python experiments/kalshi_weather_edge.py            # demo on live Jul-1 + hot-day
       python experiments/kalshi_weather_edge.py --selfcheck  # assert measured conclusions
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

REPO = Path(__file__).resolve().parents[1]
RECORD_LOG = REPO / "data" / "convergence" / "weather-edge-records.jsonl"

# ── Measured calibration constants (see research note for provenance) ─────────
NORMAL_HIGH_F: Dict[Tuple[int, int], float] = {   # NCEI 1991-2020 KNYC daily-max normals
    (6, 25): 82.5, (6, 26): 82.7, (6, 27): 82.9, (6, 28): 83.2, (6, 29): 83.4,
    (6, 30): 83.6, (7, 1): 83.8, (7, 2): 83.9, (7, 3): 84.1, (7, 4): 84.3, (7, 5): 84.4,
}
DEFAULT_SUMMER_NORMAL_F = 84.0

COOL_BIAS_F = 1.2       # Central-Park sensor runs cool vs the gridded forecast
REGRESSION_K = 0.06     # large positive anomalies verify less extreme (regression)
SIGMA_BASE_F = 2.4      # day-AHEAD (lead>=1) summer max-temp forecast σ (NWS MAE ≈ a few °F)
SIGMA_PER_LEAD_F = 0.5  # error spread grows with lead time
# SAME-DAY nowcast σ: for a market on TODAY's high, much of the day's heating is
# already observed, so the remaining spread is far tighter than a day-ahead forecast.
# Using the day-ahead 2.4 for a same-day high over-spreads the distribution and
# manufactures a phantom edge against the (well-calibrated, tight) live same-day
# market — the exact false positive found on the live 2026-07-01 KXHIGHNY board.
SIGMA_NOWCAST_F = 1.5   # same-day high; physically ~NWS same-day MAE, not curve-fit

# Calibration-band half-widths — the honest uncertainty in the calibration itself.
MEAN_UNC_F = 0.8        # ± downshift uncertainty (until IEM measures it)
# The high may be MUCH more predictable than the nominal day-ahead σ when the
# synoptic pattern is stable — a liquid market peaked on one bucket implies an
# effective σ ~1.5F (well below 2.4). SIGMA_LO must reach that low so a routine-day
# "edge" only counts if it beats even the market's own tight-σ view; otherwise the
# band rubber-stamps model-vs-market noise (the phantom NO 94-95 on the live board).
SIGMA_LO, SIGMA_HI = 0.6, 1.30    # 0.6*2.4 = 1.44F floor covers the tight liquid market

# P(actual KNYC high ≥ 100 °F | NWS forecast high), from the ≥100 record + the
# 2013-2025 near-miss streak (many 99 °F, zero 100 °F). Interpolated.
CEILING_TABLE: List[Tuple[float, float]] = [
    (99.0, 0.03), (100.0, 0.08), (101.0, 0.13),
    (102.0, 0.19), (103.0, 0.27), (104.0, 0.38),
]

# Kalshi buckets: (label, lo_F, hi_F) — a whole-°F high h scores in [lo, hi];
# None = open end. ">=100"-style buckets (lo >= 100) are ceiling-capped.
Bucket = Tuple[str, Optional[int], Optional[int]]

JUL1_LADDER: List[Bucket] = [
    ("<=91", None, 91), ("92-93", 92, 93), ("94-95", 94, 95),
    ("96-97", 96, 97), ("98-99", 98, 99), (">=100", 100, None),
]
HOT_LADDER: List[Bucket] = [   # ladder Kalshi likely sets for a ~101-102 °F forecast
    ("<=95", None, 95), ("96-97", 96, 97), ("98-99", 98, 99),
    ("100-101", 100, 101), (">=102", 102, None),
]

# ── math (stdlib only) ───────────────────────────────────────────────────────
def _norm_cdf(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def _interp(table: List[Tuple[float, float]], x: float) -> float:
    if x <= table[0][0]:
        return table[0][1]
    if x >= table[-1][0]:
        return table[-1][1]
    for (x0, y0), (x1, y1) in zip(table, table[1:]):
        if x0 <= x <= x1:
            return y0 + (x - x0) / (x1 - x0) * (y1 - y0)
    return table[-1][1]


def normal_high(month: int, day: int) -> float:
    return NORMAL_HIGH_F.get((month, day), DEFAULT_SUMMER_NORMAL_F)


def calibrated_mean(forecast_high: float, month: int, day: int) -> float:
    """Forecast high, downshifted for Central-Park cool bias + anomaly regression."""
    anomaly = forecast_high - normal_high(month, day)
    return forecast_high - COOL_BIAS_F - REGRESSION_K * max(0.0, anomaly)


def sigma_for_lead(lead_days: int) -> float:
    # lead_days<=0 == same-day nowcast (settles tonight): tight spread, so the model
    # does NOT out-spread the market and invent a routine-day edge. The model's real
    # edge lives in the >=100 F CEILING on extreme days, not in σ-width on routine days.
    if lead_days <= 0:
        return SIGMA_NOWCAST_F
    return SIGMA_BASE_F + SIGMA_PER_LEAD_F * (lead_days - 1)


def _bucket_just_below_100(ladder: List[Bucket]) -> Optional[str]:
    best, best_hi = None, -999
    for (lbl, _, hi) in ladder:
        if hi is not None and hi < 100 and hi > best_hi:
            best, best_hi = lbl, hi
    return best


def _distribution(mean: float, sigma: float, ladder: List[Bucket], forecast_high: float) -> Dict[str, float]:
    """P(high in bucket) for an explicit (mean, σ), with the ≥100 °F ceiling enforced.

    The record shows Central Park stalls at 98-99 far more than it crosses 100,
    so Gaussian mass above the ceiling is moved down into the 98-99 band —
    reproducing the observed hard ceiling rather than a fat normal tail.
    """
    def band(lo, hi):
        plo = _norm_cdf(((lo - 0.5) - mean) / sigma) if lo is not None else 0.0
        phi = _norm_cdf(((hi + 0.5) - mean) / sigma) if hi is not None else 1.0
        return max(0.0, phi - plo)

    dist = {lbl: band(lo, hi) for (lbl, lo, hi) in ladder}
    ceiling = _interp(CEILING_TABLE, forecast_high)
    above = [lbl for (lbl, lo, _) in ladder if lo is not None and lo >= 100]
    raw_above = sum(dist[l] for l in above)
    if above and raw_above > ceiling:
        excess = raw_above - ceiling
        scale = ceiling / raw_above if raw_above > 0 else 0.0
        for l in above:
            dist[l] *= scale
        sink = _bucket_just_below_100(ladder)
        if sink:
            dist[sink] += excess
    total = sum(dist.values()) or 1.0
    return {l: p / total for l, p in dist.items()}


def calibrated_distribution(forecast_high: float, lead_days: int, ladder: List[Bucket],
                            month: int = 7, day: int = 1) -> Dict[str, float]:
    """Nominal calibrated distribution (center of the band)."""
    return _distribution(calibrated_mean(forecast_high, month, day),
                         sigma_for_lead(lead_days), ladder, forecast_high)


def calibration_band(forecast_high: float, lead_days: int, month: int, day: int) -> List[Tuple[float, float]]:
    """The (mean, σ) scenarios spanning the honest calibration uncertainty. Center first."""
    m, s = calibrated_mean(forecast_high, month, day), sigma_for_lead(lead_days)
    out = [(m, s)]
    for dm in (-MEAN_UNC_F, 0.0, MEAN_UNC_F):
        for fs in (SIGMA_LO, SIGMA_HI):
            out.append((m + dm, s * fs))
    return out


# ── Verify: robust edge vs market, net of Kalshi fees ────────────────────────
def kalshi_fee_cents(price: float) -> int:
    """Kalshi general trading fee, per contract: round_up(0.07 · P · (1-P)) in cents."""
    return max(1, math.ceil(7.0 * price * (1.0 - price)))


def _best_side_net(fair: float, ask: float) -> Tuple[str, float]:
    fair_c = 100.0 * fair
    yes = (fair_c - 100.0 * ask) - kalshi_fee_cents(ask)
    no_ask = 1.0 - ask
    no = ((100.0 - fair_c) - 100.0 * no_ask) - kalshi_fee_cents(no_ask)
    return ("yes", yes) if yes >= no else ("no", no)


def robust_edge_report(forecast_high: float, lead_days: int, ladder: List[Bucket],
                       market_ask: Dict[str, float], month: int = 7, day: int = 1,
                       min_edge_cents: float = 5.0) -> Dict:
    """Per-bucket edge that must SURVIVE THE WHOLE calibration band to count.

    For each bucket we take the best side in every band scenario; it is actionable
    only if the side is the same across all scenarios AND the worst-case net edge
    still clears fees + `min_edge`. `worst_c` is that worst-case (what you can
    actually rely on); `best_c` is the optimistic corner.
    """
    scen = calibration_band(forecast_high, lead_days, month, day)
    dists = [_distribution(m, s, ladder, forecast_high) for (m, s) in scen]
    nominal = dists[0]
    rows, actionable = [], []
    for (lbl, _, _) in ladder:
        a = market_ask.get(lbl)
        if a is None:
            continue
        outcomes = [_best_side_net(d[lbl], a) for d in dists]
        sides = {s for s, _ in outcomes}
        nets = [n for _, n in outcomes]
        consistent = len(sides) == 1
        worst, best = min(nets), max(nets)
        robust = consistent and worst >= min_edge_cents
        row = {"bucket": lbl, "fair_pct": round(100 * nominal[lbl], 1),
               "ask_c": round(100 * a, 1), "side": outcomes[0][0] if consistent else "mixed",
               "worst_c": round(worst, 1), "best_c": round(best, 1), "robust": robust}
        rows.append(row)
        if robust:
            actionable.append(row)
    rows.sort(key=lambda r: r["worst_c"], reverse=True)
    verdict = ("robust: " + ", ".join(f"{r['side'].upper()} {r['bucket']} "
               f"(≥{r['worst_c']:+.0f}¢)" for r in actionable)) if actionable else "no certified edge"
    return {"rows": rows, "actionable": actionable, "verdict": verdict}


def convergence_record(market_date: str, forecast_high: float, dist: Dict[str, float],
                       report: Dict, sources: List[str]) -> Dict:
    """A ConvergenceRecord (hypothesis + evidence + result + confidence) for the log.

    Confidence stays modest — the calibration center is measured but the
    forecast-conditional bias is still inferred (the open handoff) — so this
    cannot launder to high confidence. External grounding = the NWS settlement.
    """
    modal = max(dist, key=dist.get)
    return {
        "type": "convergence_record", "domain": "kalshi-weather-edge",
        "hypothesis": (f"KXHIGHNY {market_date}: NWS forecast {forecast_high:.0f}°F → "
                       f"calibrated modal high {modal}; verdict: {report['verdict']}"),
        "evidence_ids": sources,
        "result": {"forecast_high": forecast_high,
                   "distribution": {k: round(v, 3) for k, v in dist.items()},
                   "actionable": report["actionable"]},
        "confidence": 0.6 if report["actionable"] else 0.5,
        "grounding": "NWS Daily Climatological Report (Central Park / KNYC) settles the market",
    }


def log_record(rec: Dict) -> None:
    RECORD_LOG.parent.mkdir(parents=True, exist_ok=True)
    with RECORD_LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")


# ── demo / self-check ────────────────────────────────────────────────────────
# Live asks pulled 2026-06-30 (see research note). Jul-1 = routine day; the
# hot-day asks are a HYPOTHETICAL (markets not open yet) to show the fade.
JUL1_ASK = {"<=91": .09, "92-93": .27, "94-95": .45, "96-97": .20, "98-99": .06, ">=100": .01}
HOTDAY_ASK_HYPO = {"<=95": .05, "96-97": .12, "98-99": .18, "100-101": .40, ">=102": .18}


def _print_case(title, fc, lead, ladder, ask, month=7, day=1):
    rep = robust_edge_report(fc, lead, ladder, ask, month, day)
    print(f"\n=== {title} — NWS forecast {fc:.0f}°F, lead {lead}d "
          f"(calibrated mean {calibrated_mean(fc, month, day):.1f}, σ {sigma_for_lead(lead):.1f}) ===")
    print("  bucket    fair%   ask¢   side  worst¢  best¢  robust")
    for r in rep["rows"]:
        print(f"  {r['bucket']:<8} {r['fair_pct']:5.1f}  {r['ask_c']:5.1f}  {r['side']:>5}  "
              f"{r['worst_c']:+6.1f}  {r['best_c']:+5.1f}   {'YES' if r['robust'] else '·'}")
    print(f"  VERDICT: {rep['verdict']}")
    return calibrated_distribution(fc, lead, ladder, month, day), rep


def selfcheck() -> int:
    fails = []
    # 1) routine day: cool tail thin, modal 94-95 (matches the liquid market)
    d1 = calibrated_distribution(96, 1, JUL1_LADDER)
    if not d1[">=100"] < 0.03:
        fails.append(f"Jul1 P(>=100)={d1['>=100']:.3f} not < 0.03")
    if max(d1, key=d1.get) != "94-95":
        fails.append(f"Jul1 modal={max(d1, key=d1.get)} not 94-95")
    # 2) routine day is EFFICIENT: the point-estimate '94-95' edge must NOT survive the band
    r1 = robust_edge_report(96, 1, JUL1_LADDER, JUL1_ASK)
    if r1["actionable"]:
        fails.append(f"Jul1 should be 'no certified edge', got {r1['verdict']}")
    # 3) hot day: ≥100 ceiling active (0.05 < P < 0.20, NOT the naive ~0.5)
    d3 = calibrated_distribution(102, 3, HOT_LADDER)
    p100 = d3["100-101"] + d3[">=102"]
    if not 0.05 < p100 < 0.20:
        fails.append(f"Jul3 P(>=100)={p100:.3f} outside measured ceiling (0.05,0.20)")
    # 4) hot day fade IS robust: ≥100 priced 40¢ → NO side survives whole band
    r3 = robust_edge_report(102, 3, HOT_LADDER, HOTDAY_ASK_HYPO)
    fade = next((r for r in r3["actionable"] if r["bucket"] == "100-101"), None)
    if not (fade and fade["side"] == "no" and fade["worst_c"] > 15):
        fails.append(f"hot-day fade not robust: {fade}")
    # 5) fees
    if kalshi_fee_cents(0.40) != 2 or kalshi_fee_cents(0.09) != 1:
        fails.append("fee formula off")
    if fails:
        print("SELFCHECK FAILED:\n  - " + "\n  - ".join(fails))
        return 1
    print("SELFCHECK PASSED — routine day efficient (no band-robust edge), "
          "hot-day ≥100 ceiling + fade robust, fees correct.")
    return 0


if __name__ == "__main__":
    if "--selfcheck" in sys.argv:
        raise SystemExit(selfcheck())
    _print_case("Jul 1 (routine, LIVE market)", 96, 1, JUL1_LADDER, JUL1_ASK, 7, 1)
    _print_case("Jul 3 (extreme, HYPOTHETICAL asks)", 102, 3, HOT_LADDER, HOTDAY_ASK_HYPO, 7, 3)
    print("\n(Handoff: run the Observe adapters + IEM forecast-pairing on the server "
          "that has egress; feed band-robust `actionable` into kalshi-suggest / the council.)")
