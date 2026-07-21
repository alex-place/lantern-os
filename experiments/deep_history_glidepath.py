"""Iteration 15 (Σ₀) — a decumulation GLIDEPATH: brake only the early-retirement danger zone.

Iter-14: the brake cuts worst-case ruin but costs median wealth (always-on gives up too much
upside over 30y). Sequence-of-returns risk is concentrated in the FIRST ~decade of retirement
— an early crash while withdrawing causes ruin; a late crash doesn't (you've already spent
down / the horizon is short). So test a glidepath: run the Conservative brake ONLY for the
first M years of retirement, then switch to buy&hold (let survivors ride for growth).

Hypothesis: front-loaded brake keeps most of the ruin protection while recovering median
wealth vs always-on. We splice the two books' aligned daily-return series at the switch
point (living off the braked book for M years, then buy&hold). Same $1M / 4%&5% real
withdrawal / 30y roll / block-bootstrap harness as iter-14. Honest if the glidepath doesn't
dominate. Measured; the 3%/5% figures are labeled assumptions.
"""
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_overlay as O
import deep_history_significance as S
import deep_history_decumulation as D


def spliced(rn, rb, s0, switch_yr, horizon):
    """braked returns for the first switch_yr years, then buy&hold — for the window at s0."""
    sw = int(switch_yr * 252)
    seg = np.empty(horizon)
    for t in range(horizon):
        src = rn if t < sw else rb
        j = s0 + t
        seg[t] = src[j] if j < src.size else 0.0
    return seg


def analyze(sym, days, rb, rn):
    print(f"\n# {sym}  ({rb.size} days)")
    out = {}
    for wrate in (0.04, 0.05):
        starts = list(range(0, rb.size - D.HORIZON_D, D.STEP))
        books = {"buy&hold": [], "always_brake": [], "glide_5y": [], "glide_10y": []}
        for s0 in starts:
            wb, rub = D.simulate(rb[s0:], wrate, D.HORIZON_D)
            wn, run = D.simulate(rn[s0:], wrate, D.HORIZON_D)
            g5, rg5 = D.simulate(spliced(rn, rb, s0, 5, D.HORIZON_D), wrate, D.HORIZON_D)
            g10, rg10 = D.simulate(spliced(rn, rb, s0, 10, D.HORIZON_D), wrate, D.HORIZON_D)
            books["buy&hold"].append((wb, rub)); books["always_brake"].append((wn, run))
            books["glide_5y"].append((g5, rg5)); books["glide_10y"].append((g10, rg10))
        print(f"  withdraw {wrate*100:.0f}%/yr (real):  {'book':<14}{'P(ruin)':>9}{'medianTerm':>12}")
        row = {}
        for name, rs in books.items():
            pr = float(np.mean([r for _, r in rs]))
            md = float(np.median([w for w, _ in rs]))
            row[name] = {"p_ruin": pr, "median_terminal": md}
            print(f"{'':<28}{name:<14}{pr:>8.0%}{md/1e6:>11.2f}M")
        out[f"wrate_{int(wrate*100)}"] = row
    # block-bootstrap ruin at 5% for the glidepaths vs always-brake vs buy&hold
    rng = np.random.default_rng(9191)
    cnt = {"buy&hold": 0, "always_brake": 0, "glide_5y": 0, "glide_10y": 0}
    NB = 1000
    for _ in range(NB):
        idx = S.block_boot_indices(D.HORIZON_D, rng)
        rb_b, rn_b = rb[idx], rn[idx]
        gl5 = np.where(np.arange(D.HORIZON_D) < 5 * 252, rn_b, rb_b)
        gl10 = np.where(np.arange(D.HORIZON_D) < 10 * 252, rn_b, rb_b)
        cnt["buy&hold"] += D.simulate(rb_b, 0.05, D.HORIZON_D)[1]
        cnt["always_brake"] += D.simulate(rn_b, 0.05, D.HORIZON_D)[1]
        cnt["glide_5y"] += D.simulate(gl5, 0.05, D.HORIZON_D)[1]
        cnt["glide_10y"] += D.simulate(gl10, 0.05, D.HORIZON_D)[1]
    print(f"  block-bootstrap P(ruin)@5%: " + "  ".join(f"{k} {v/NB:.0%}" for k, v in cnt.items()))
    out["bootstrap_ruin_5pct"] = {k: v / NB for k, v in cnt.items()}
    return out


def main():
    import json
    out = {}
    for sym in ("^GSPC", "^IXIC"):
        days, px = O.load_asset(sym)
        rb = O.run_overlay(days, px, **D.BH)["rets"]
        rn = O.run_overlay(days, px, **D.NR)["rets"]
        n = min(rb.size, rn.size)
        out[sym] = analyze(sym, days, rb[:n], rn[:n])
    (HERE / "deep_glidepath.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("\nwrote deep_glidepath.json")


if __name__ == "__main__":
    main()
