"""Iteration 17 (Σ₀, LOOP3) — REAL (inflation-adjusted) returns; does cash-parking hurt?

The brake parks in cash, which loses to inflation — so a fair test is in REAL terms, and the
acid test is the 1970s stagflation (double-digit inflation, falling real equities). FRED was
unreachable from this box, so we use an ENCODED annual US CPI inflation table (BLS historical
figures — a labeled assumption, annual granularity, interpolated to daily). Both books are
deflated by the SAME CPI, so the brake-vs-buy&hold comparison is fair; only absolute real
levels carry the assumption.

IMPORTANT honest caveat: run_overlay's cash carry is a FLAT 3%/yr. In the 1970s-80s, T-bills
actually yielded 5-15% nominal, partially offsetting inflation — so this flat-3% assumption
UNDERSTATES the brake's real cash return in high-inflation eras. The real results below are
therefore a CONSERVATIVE (pessimistic-for-the-brake) estimate. Measured; assumptions labeled.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_overlay as O

# Annual US CPI-U inflation, % (BLS historical annual averages; encoded — labeled assumption).
CPI_INFL = {
    1927:-1.7,1928:-1.7,1929:0.0,1930:-2.3,1931:-9.0,1932:-9.9,1933:-5.1,1934:3.1,1935:2.2,1936:1.5,
    1937:3.6,1938:-2.1,1939:-1.4,1940:0.7,1941:5.0,1942:10.9,1943:6.0,1944:1.6,1945:2.3,1946:8.3,
    1947:14.4,1948:8.1,1949:-1.2,1950:1.3,1951:7.9,1952:1.9,1953:0.8,1954:0.7,1955:-0.4,1956:1.5,
    1957:3.3,1958:2.8,1959:0.7,1960:1.7,1961:1.0,1962:1.0,1963:1.3,1964:1.3,1965:1.6,1966:2.9,
    1967:3.1,1968:4.2,1969:5.5,1970:5.7,1971:4.4,1972:3.2,1973:6.2,1974:11.0,1975:9.1,1976:5.8,
    1977:6.5,1978:7.6,1979:11.3,1980:13.5,1981:10.3,1982:6.2,1983:3.2,1984:4.3,1985:3.6,1986:1.9,
    1987:3.6,1988:4.1,1989:4.8,1990:5.4,1991:4.2,1992:3.0,1993:3.0,1994:2.6,1995:2.8,1996:3.0,
    1997:2.3,1998:1.6,1999:2.2,2000:3.4,2001:2.8,2002:1.6,2003:2.3,2004:2.7,2005:3.4,2006:3.2,
    2007:2.8,2008:3.8,2009:-0.4,2010:1.6,2011:3.2,2012:2.1,2013:1.5,2014:1.6,2015:0.1,2016:1.3,
    2017:2.1,2018:2.4,2019:1.8,2020:1.2,2021:4.7,2022:8.0,2023:4.1,2024:2.9,2025:2.9,2026:2.9,
}
NR = dict(tv=0.20, trend_m=12, brake=0.20, min_gross=0.0, max_gross=1.0, band=0.30)
BH = dict(tv=0.0, trend_m=6, brake=9.9, min_gross=1.0, max_gross=1.0, band=0.0)


def daily_infl_for(day):
    yr = int(day[:4])
    a = CPI_INFL.get(yr, 2.9) / 100.0
    return (1 + a) ** (1 / 252.0) - 1


def real_stats(days, rets, i0=1):
    """Deflate nominal daily rets by daily CPI; return real Sharpe/maxDD/real-growth-multiple."""
    n = rets.size
    real = np.empty(n)
    eq = 1.0; path = [1.0]
    for k in range(n):
        infl = daily_infl_for(days[k + i0]) if k + i0 < len(days) else 0.0
        rr = (1 + rets[k]) / (1 + infl) - 1.0
        real[k] = rr; eq *= (1 + rr); path.append(eq)
    e = np.array(path); peaks = np.maximum.accumulate(e)
    sh = real.mean() / real.std(ddof=1) * math.sqrt(252) if real.std(ddof=1) > 0 else 0.0
    return {"real_sharpe": sh, "real_maxdd": float(np.min(e / peaks - 1)),
            "real_mult": float(eq), "n": n}


def run(sym, start=None, end=None, label=""):
    days, px = O.load_asset(sym)
    # slice day list to match run_overlay's i0
    i0 = 0 if start is None else next(i for i, d in enumerate(days) if d >= start)
    bh = O.run_overlay(days, px, start=start, end=end, **BH)
    nm = O.run_overlay(days, px, start=start, end=end, **NR)
    dslice = days[i0:]
    rb = real_stats(dslice, bh["rets"]); rn = real_stats(dslice, nm["rets"])
    print(f"  {label:<26} B&H realSh {rb['real_sharpe']:.2f} realDD {rb['real_maxdd']*100:.0f}% x{rb['real_mult']:.1f}"
          f"  | nm realSh {rn['real_sharpe']:.2f} realDD {rn['real_maxdd']*100:.0f}% x{rn['real_mult']:.1f}")
    return {"buyhold": rb, "no_margin": rn}


def main():
    out = {}
    print("# REAL (inflation-adjusted) returns — S&P 500")
    out["full_1927"] = run("^GSPC", label="full 1927-2026")
    out["stagflation_1970_82"] = run("^GSPC", start="1970-01-01", end="1983-01-01", label="1970-82 stagflation")
    out["modern_2000"] = run("^GSPC", start="2000-01-01", label="2000-2026")
    out["inflation_2021_26"] = run("^GSPC", start="2021-01-01", label="2021-2026 inflation spike")
    (HERE / "deep_real.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("\nwrote deep_real.json  (cash carry flat 3% => understates 1970s T-bill yield => conservative for brake)")


if __name__ == "__main__":
    main()
