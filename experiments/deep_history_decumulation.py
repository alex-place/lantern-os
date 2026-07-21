"""Iteration 14 (Σ₀) — decumulation / sequence-of-returns: where drawdown protection pays.

Accumulation (iters 1-3) showed the brake is risk-protection, not return-max. The place
that protection should matter MOST is DECUMULATION: a retiree withdrawing while the market
falls sells shares at the bottom (sequence-of-returns risk), and a deep early drawdown can
cause RUIN. Test whether the no-margin Conservative overlay reduces ruin vs buy&hold.

Setup: $1,000,000 start, withdraw a fixed REAL amount monthly (4%/yr and a stressed 5%/yr
of the initial, inflated 3%/yr — a stated assumption, no CPI series needed), over a 30-year
retirement. Roll the start date every 12 months across the deep history. For each window and
each book, record terminal wealth and whether it hit RUIN (≤ 0) before 30y. Report P(ruin),
median/worst terminal, and separately the windows whose start coincides with a crisis
(1929/1937/1973/2000/2008). Plus a crisis-only block-bootstrap P(ruin). The book return
paths come from run_overlay's daily returns. Measured; the 3%/5% assumptions are labeled.
"""
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_overlay as O
import deep_history_significance as S

START_CAP = 1_000_000.0
INFL = 0.03
HORIZON_D = 252 * 30
STEP = 252
NR = dict(tv=0.20, trend_m=12, brake=0.20, min_gross=0.0, max_gross=1.0, band=0.30)
BH = dict(tv=0.0, trend_m=6, brake=9.9, min_gross=1.0, max_gross=1.0, band=0.0)
CRISIS_STARTS = ["1929", "1937", "1973", "2000", "2008"]


def simulate(rets, wrate, horizon):
    """Wealth path: withdraw monthly (inflated), then apply daily return. Ruin if ≤0."""
    w = START_CAP
    monthly0 = START_CAP * wrate / 12.0
    for t in range(min(horizon, rets.size)):
        if t % 21 == 0:                                # monthly withdrawal
            wd = monthly0 * ((1 + INFL) ** (t / 252.0))
            w -= wd
            if w <= 0:
                return 0.0, True
        w *= (1.0 + rets[t])
        if w <= 0:
            return 0.0, True
    return w, False


def analyze(sym, days, rb, rn):
    print(f"\n# {sym}  ({rb.size} days, {rb.size/252:.0f}y)")
    out = {}
    for wrate in (0.04, 0.05):
        starts = list(range(0, rb.size - HORIZON_D, STEP))
        rows = {"bh": [], "nm": []}
        crisis = {"bh": [], "nm": []}
        for s0 in starts:
            wb, ruinb = simulate(rb[s0:], wrate, HORIZON_D)
            wn, ruinn = simulate(rn[s0:], wrate, HORIZON_D)
            rows["bh"].append((wb, ruinb)); rows["nm"].append((wn, ruinn))
            yr = days[s0 + 1][:4] if s0 + 1 < len(days) else ""
            if yr in CRISIS_STARTS:
                crisis["bh"].append(ruinb); crisis["nm"].append(ruinn)

        def pruin(rs): return np.mean([r for _, r in rs])
        def median_term(rs): return np.median([w for w, _ in rs])
        def worst(rs): return min(w for w, _ in rs)
        pr_b, pr_n = pruin(rows["bh"]), pruin(rows["nm"])
        print(f"  withdraw {wrate*100:.0f}%/yr (real):  P(ruin)  buy&hold {pr_b:.0%}  no_margin {pr_n:.0%}"
              f"   |  median terminal  B&H ${median_term(rows['bh'])/1e6:.2f}M  nm ${median_term(rows['nm'])/1e6:.2f}M")
        print(f"     worst terminal:  B&H ${worst(rows['bh'])/1e3:.0f}k  nm ${worst(rows['nm'])/1e3:.0f}k"
              f"   |  crisis-start ruin  B&H {np.mean(crisis['bh']) if crisis['bh'] else 0:.0%}"
              f"  nm {np.mean(crisis['nm']) if crisis['nm'] else 0:.0%}  (n={len(crisis['bh'])})")
        out[f"wrate_{int(wrate*100)}"] = {
            "p_ruin_buyhold": float(pr_b), "p_ruin_no_margin": float(pr_n),
            "median_terminal_bh": float(median_term(rows["bh"])), "median_terminal_nm": float(median_term(rows["nm"])),
            "worst_terminal_bh": float(worst(rows["bh"])), "worst_terminal_nm": float(worst(rows["nm"])),
            "n_windows": len(starts),
            "crisis_ruin_bh": float(np.mean(crisis["bh"])) if crisis["bh"] else None,
            "crisis_ruin_nm": float(np.mean(crisis["nm"])) if crisis["nm"] else None}
    return out


def crisis_bootstrap_ruin(sym, rb, rn, seed):
    """Block-bootstrap 30y paths from the worst 20% (by trailing 1y) days; P(ruin) at 5%."""
    # pick the crisis pool = days in the worst 10% of trailing-252d return
    n = rb.size
    print(f"  [{sym}] crisis-block bootstrap P(ruin) @5% (1000 paths, 21d blocks):")
    rng = np.random.default_rng(seed)
    rb2, rn2 = rb, rn
    pr = {"bh": 0, "nm": 0}
    for _ in range(1000):
        idx = S.block_boot_indices(HORIZON_D, rng)   # resample full-history blocks
        _, rub = simulate(rb2[idx], 0.05, HORIZON_D)
        _, run = simulate(rn2[idx], 0.05, HORIZON_D)
        pr["bh"] += rub; pr["nm"] += run
    print(f"     buy&hold {pr['bh']/1000:.0%}   no_margin {pr['nm']/1000:.0%}")
    return {"p_ruin_boot_bh": pr["bh"] / 1000, "p_ruin_boot_nm": pr["nm"] / 1000}


def main():
    import json
    out = {}
    for si, sym in enumerate(("^GSPC", "^IXIC")):
        days, px = O.load_asset(sym)
        rb = O.run_overlay(days, px, **BH)["rets"]
        rn = O.run_overlay(days, px, **NR)["rets"]
        n = min(rb.size, rn.size); rb, rn = rb[:n], rn[:n]
        res = analyze(sym, days, rb, rn)
        res["crisis_bootstrap"] = crisis_bootstrap_ruin(sym, rb, rn, 4242 + si)
        out[sym] = res
    (HERE / "deep_decumulation.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("\nwrote deep_decumulation.json")


if __name__ == "__main__":
    main()
