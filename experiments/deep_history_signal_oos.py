"""Iteration 13 (Σ₀-critical) — does the 200d-SMA gate beat momentum OUT OF SAMPLE?

Iter-12's SMA dominance was full-history (in-sample). The shipped config earned its place
on a train/validate split; the SMA claim must clear the same bar before any live change.
Split: TRAIN pre-2000, VALIDATE 2000-2026 (unseen dot-com/GFC/COVID/2022). For each signal
(mom/sma/dual) in the no-margin Conservative config, report train + validate Sharpe/maxDD/
final/trades. Then block-bootstrap the VALIDATE paired daily Sharpe difference (sma−mom and
dual−mom) for a 95% CI. Only if sma beats mom on validate Sharpe AND drawdown, with a CI
that excludes 0, is it a real improvement. Honest if it decays. Measured; nothing synthesised.
"""
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_overlay as O
import deep_history_significance as S   # ann_sharpe, block_boot_indices

SPLIT = "2000-01-01"
BASE = dict(tv=0.20, trend_m=12, brake=0.20, min_gross=0.0, max_gross=1.0, band=0.30)


def boot_ci(ra, rb, seed):
    n = min(ra.size, rb.size); ra, rb = ra[-n:], rb[-n:]
    rng = np.random.default_rng(seed)
    d, wins = [], 0
    for _ in range(2000):
        idx = S.block_boot_indices(n, rng)
        sa, sb = S.ann_sharpe(ra[idx]), S.ann_sharpe(rb[idx])
        d.append(sa - sb); wins += (sa > sb)
    d = np.array(d)
    return float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5)), wins / 2000


def main():
    import json
    out = {}
    for si, sym in enumerate(("^GSPC", "^IXIC")):
        days, px = O.load_asset(sym)
        res = {}
        print(f"\n# {sym}  {days[0]}..{days[-1]}   split {SPLIT}")
        print(f"{'signal':<7}| {'trSh':>5}{'trDD':>6}{'trFin':>10} | {'vaSh':>5}{'vaDD':>6}{'vaFin':>10}{'va tr/yr':>9}")
        va_rets = {}
        for sig in ("mom", "sma", "dual"):
            tr = O.run_overlay(days, px, signal=sig, end=SPLIT, **BASE)
            va = O.run_overlay(days, px, signal=sig, start=SPLIT, **BASE)
            va_rets[sig] = va["rets"]
            res[sig] = {"train": {k: tr[k] for k in ("sharpe", "maxdd", "final")},
                        "validate": {k: va[k] for k in ("sharpe", "maxdd", "final", "trade_days_per_yr")}}
            print(f"{sig:<7}| {tr['sharpe']:>5.2f}{tr['maxdd']*100:>5.0f}%{tr['final']:>10,.0f} | "
                  f"{va['sharpe']:>5.2f}{va['maxdd']*100:>5.0f}%{va['final']:>10,.0f}{va['trade_days_per_yr']:>9.1f}")
        # significance of the validate Sharpe difference vs the shipped mom
        for cand in ("sma", "dual"):
            lo, hi, p = boot_ci(va_rets[cand], va_rets["mom"], seed=777 + si)
            sig_flag = "YES" if lo > 0 else "no"
            res[f"{cand}_minus_mom_validate"] = {"ci95": [lo, hi], "p_better": p, "significant": bool(lo > 0)}
            print(f"  validate ΔSharpe {cand}−mom: [{lo:+.2f}, {hi:+.2f}]  P({cand}>mom)={p:.0%}  sig={sig_flag}")
        # verdict
        va = {s: res[s]["validate"] for s in ("mom", "sma", "dual")}
        sma_wins = va["sma"]["sharpe"] > va["mom"]["sharpe"] and va["sma"]["maxdd"] >= va["mom"]["maxdd"]
        res["verdict_sma_beats_mom_oos"] = bool(sma_wins)
        print(f"  VERDICT: sma beats mom OOS on Sharpe AND drawdown? {'YES' if sma_wins else 'NO'}")
        out[sym] = res
    (HERE / "deep_signal_oos.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("\nwrote deep_signal_oos.json")


if __name__ == "__main__":
    main()
