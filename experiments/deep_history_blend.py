"""Iteration 5 — does diversification + the brake beat either alone? (1962+)

Builds a diversified deep-history panel and separates the two effects:
  (a) diversification alone   : 60/40 S&P/bond buy&hold vs S&P-only buy&hold
  (b) the Conservative brake   : no-margin overlay on S&P-only vs S&P buy&hold
  (c) both together            : no-margin overlay on the 60/40 blend

Bond total-return proxy from ^TNX (10Y yield, 1962+): a constant-maturity 10Y note's
daily total return ≈ carry − duration·Δyield, i.e.
    r_bond_t = y_{t-1}/252  −  D·(y_t − y_{t-1})        (y in decimal, D≈8.0)
This is the standard first-order CMT approximation (convexity dropped); it is a PROXY,
not a real bond index — stated plainly. Gold (GC=F) only starts 2000 so it's excluded
from the 1962 blend and checked separately in a 2000+ sub-test.

The 60/40 blend is turned into a synthetic price series (cumulative product of the
daily 0.6·SPX + 0.4·bond return, i.e. daily-rebalanced 60/40) so the SAME `run_overlay`
brake applies unchanged. Lump-sum $25k, 2bp/turnover, no-margin config from iter 2
(band 0.30 / brake 0.20 / trend 12mo). Everything measured; nothing synthesised.
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_cache as C
import deep_history_overlay as O

DUR = 8.0  # modified duration proxy for a constant-maturity 10Y note


def bond_index_from_tnx(days, tnx):
    """Daily total-return price index for a constant-maturity 10Y note."""
    idx = np.ones(len(days))
    y = np.array([tnx.get(d, np.nan) for d in days]) / 100.0  # percent -> decimal
    # forward-fill yield gaps
    for i in range(1, len(y)):
        if np.isnan(y[i]):
            y[i] = y[i - 1]
    for i in range(1, len(days)):
        if np.isnan(y[i]) or np.isnan(y[i - 1]):
            idx[i] = idx[i - 1]; continue
        r = y[i - 1] / 252.0 - DUR * (y[i] - y[i - 1])
        idx[i] = idx[i - 1] * (1.0 + r)
    return idx


def blend_price(spx, bond, w_spx=0.6):
    """Synthetic price of a daily-rebalanced w/1-w SPX/bond portfolio."""
    rs = np.diff(np.log(spx)); rb = np.diff(np.log(bond))
    # arithmetic daily returns
    ars = np.exp(rs) - 1; arb = np.exp(rb) - 1
    blend_r = w_spx * ars + (1 - w_spx) * arb
    px = np.ones(len(spx))
    for i in range(1, len(spx)):
        px[i] = px[i - 1] * (1.0 + blend_r[i - 1])
    return px


def line(name, r):
    print(f"{name:<24}{r['final']:>13,.0f}{r['cagr']*100:>7.1f}%{r['sharpe']:>8.2f}"
          f"{r['maxdd']*100:>7.0f}%{r['trade_days_per_yr']:>10.1f}")


def main():
    data = C.build_cache()
    s = data["series"]
    # common calendar for S&P + bond, from 1962 (bond proxy start)
    spx_raw, tnx_raw = s["^GSPC"], s["^TNX"]
    days = [d for d in sorted(spx_raw) if d >= "1962-01-02"]
    spx = np.array([spx_raw.get(d, np.nan) for d in days])
    for i in range(1, len(spx)):
        if np.isnan(spx[i]):
            spx[i] = spx[i - 1]
    bond = bond_index_from_tnx(days, tnx_raw)
    blend = blend_price(spx, bond, 0.6)

    NR = dict(tv=0.20, trend_m=12, brake=0.20, min_gross=0.0, max_gross=1.0, band=0.30)
    BH = dict(tv=0.0, trend_m=6, brake=9.9, min_gross=1.0, max_gross=1.0, band=0.0)
    print(f"# blended panel  {days[0]}..{days[-1]}  (bond proxy D={DUR})\n")
    print(f"{'book':<24}{'final':>13}{'cagr':>8}{'sharpe':>8}{'maxdd':>8}{'trades/yr':>10}")
    res = {}
    res["spx_buyhold"]    = O.run_overlay(days, spx,   **BH)
    res["6040_buyhold"]   = O.run_overlay(days, blend, **BH)
    res["spx_no_margin"]  = O.run_overlay(days, spx,   **NR)
    res["6040_no_margin"] = O.run_overlay(days, blend, **NR)
    for k in ("spx_buyhold", "6040_buyhold", "spx_no_margin", "6040_no_margin"):
        line(k, res[k])

    # sub-test: add gold as a third sleeve, 2000+ (where GC=F exists)
    gold_raw = s["GC=F"]
    gd = [d for d in days if d >= "2000-08-30"]
    gg = np.array([gold_raw.get(d, np.nan) for d in gd])
    for i in range(1, len(gg)):
        if np.isnan(gg[i]):
            gg[i] = gg[i - 1]
    spx2 = np.array([spx_raw.get(d, np.nan) for d in gd]);
    for i in range(1, len(spx2)):
        if np.isnan(spx2[i]): spx2[i] = spx2[i - 1]
    bond2 = bond_index_from_tnx(gd, tnx_raw)
    # 50/30/20 SPX/bond/gold daily-rebalanced
    ars = np.diff(spx2) / spx2[:-1]; arb = np.diff(bond2) / bond2[:-1]; arg = np.diff(gg) / gg[:-1]
    br = 0.5 * ars + 0.3 * arb + 0.2 * arg
    tri = np.ones(len(gd))
    for i in range(1, len(gd)):
        tri[i] = tri[i - 1] * (1 + br[i - 1])
    print(f"\n# +gold sub-test  {gd[0]}..{gd[-1]}  (50/30/20 SPX/bond/gold)")
    print(f"{'book':<24}{'final':>13}{'cagr':>8}{'sharpe':>8}{'maxdd':>8}{'trades/yr':>10}")
    res["tri_buyhold_2000"]   = O.run_overlay(gd, tri, **BH)
    res["tri_no_margin_2000"] = O.run_overlay(gd, tri, **NR)
    res["spx_buyhold_2000"]   = O.run_overlay(gd, spx2, **BH)
    for k in ("spx_buyhold_2000", "tri_buyhold_2000", "tri_no_margin_2000"):
        line(k, res[k])

    out = {"range": [days[0], days[-1]], "bond_duration": DUR,
           "books": {k: {kk: vv for kk, vv in v.items() if kk != "path"} for k, v in res.items()}}
    (HERE / "deep_blend.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("\nwrote deep_blend.json")


if __name__ == "__main__":
    main()
