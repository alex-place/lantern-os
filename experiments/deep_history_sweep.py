"""Iteration 2 — tune the NON-RISKY (no-margin) overlay on deep history.

Question: how FEW trades can the cash-defensive overlay make while keeping the
risk-adjusted edge? Sweep the no-trade `band` and drawdown `brake` for the
max_gross=1.0 (never-borrow) book, with an honest train/validate split so the
choice isn't overfit:
  TRAIN   : first half of each series (S&P 1927-1999, Nasdaq 1971-1999)
  VALIDATE: 2000-2026 (unseen dot-com, GFC, COVID, 2022)

Selection rule: among configs whose TRAIN Sharpe >= buy-and-hold TRAIN Sharpe,
pick the FEWEST-trades config (ties broken by Sharpe). Then report its VALIDATE
behaviour. Everything measured from deep_history.json; nothing synthesised.
"""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_overlay as O

SPLIT = "2000-01-01"


def sweep(sym):
    days, px = O.load_asset(sym)
    bh_tr = O.run_overlay(days, px, tv=0.0, trend_m=6, brake=9.9, min_gross=1.0,
                          max_gross=1.0, band=0.0, end=SPLIT)
    print(f"\n# {sym}  {days[0]}..{days[-1]}   buy&hold TRAIN Sharpe {bh_tr['sharpe']:.2f}")
    print(f"{'band':>6}{'brake':>7}{'trend':>7} | {'tr.Sh':>6}{'tr.DD':>7}{'tr/yr':>6} | "
          f"{'va.Sh':>6}{'va.DD':>7}{'va.final':>11}{'va.tr/yr':>9}")
    rows = []
    for band in (0.05, 0.10, 0.15, 0.20, 0.30):
        for brake in (0.10, 0.15, 0.20):
            for trend_m in (6, 9, 12):
                tr = O.run_overlay(days, px, tv=0.20, trend_m=trend_m, brake=brake,
                                   min_gross=0.0, max_gross=1.0, band=band, end=SPLIT)
                va = O.run_overlay(days, px, tv=0.20, trend_m=trend_m, brake=brake,
                                   min_gross=0.0, max_gross=1.0, band=band, start=SPLIT)
                rows.append((band, brake, trend_m, tr, va))
    # selection: train Sharpe >= buy&hold train Sharpe, then fewest trades/yr
    elig = [r for r in rows if r[3]["sharpe"] >= bh_tr["sharpe"]] or rows
    elig.sort(key=lambda r: (r[3]["trade_days_per_yr"], -r[3]["sharpe"]))
    best = elig[0]
    for band, brake, trend_m, tr, va in rows:
        star = " *" if (band, brake, trend_m) == best[:3] else ""
        print(f"{band:>6.2f}{brake:>7.2f}{trend_m:>7} | {tr['sharpe']:>6.2f}{tr['maxdd']*100:>6.0f}%"
              f"{tr['trade_days_per_yr']:>6.0f} | {va['sharpe']:>6.2f}{va['maxdd']*100:>6.0f}%"
              f"{va['final']:>11,.0f}{va['trade_days_per_yr']:>9.0f}{star}")
    b, bk, tm, tr, va = best
    bh_va = O.run_overlay(days, px, tv=0.0, trend_m=6, brake=9.9, min_gross=1.0,
                          max_gross=1.0, band=0.0, start=SPLIT)
    print(f"\nselected no-margin config: band={b} brake={bk} trend={tm}mo")
    print(f"  VALIDATE (2000+): Sharpe {va['sharpe']:.2f} (buy&hold {bh_va['sharpe']:.2f}) "
          f"maxDD {va['maxdd']*100:.0f}% (buy&hold {bh_va['maxdd']*100:.0f}%) "
          f"final ${va['final']:,.0f} (buy&hold ${bh_va['final']:,.0f}) trades/yr {va['trade_days_per_yr']:.0f}")
    return {"symbol": sym, "split": SPLIT,
            "selected": {"band": b, "brake": bk, "trend_m": tm},
            "train": {k: tr[k] for k in ("sharpe", "maxdd", "final", "trade_days_per_yr")},
            "validate": {k: va[k] for k in ("sharpe", "maxdd", "final", "trade_days_per_yr")},
            "buyhold_validate": {k: bh_va[k] for k in ("sharpe", "maxdd", "final")}}


def main():
    out = {}
    for sym in ("^GSPC", "^IXIC"):
        out[sym] = sweep(sym)
    (HERE / "deep_sweep_nomargin.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("\nwrote deep_sweep_nomargin.json")


if __name__ == "__main__":
    main()
