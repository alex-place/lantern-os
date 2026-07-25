"""TEST B — does maker edge scale inversely with volume? The MECHANISM test.

The weather maker candidate came with a stated mechanism: thin volume -> less market-maker
competition -> wider spreads -> liquidity provision pays. That is not a claim about weather; it
is a claim about ALL markets, and it makes a falsifiable cross-sectional prediction:

    maker net edge should DECREASE with volume.   (regression slope on log10(volume) < 0)

This is a stronger test than replicating one market type, because fitting a mechanism to the same
three observations that suggested it is circular. Here the mechanism is tested on a broad sample
spanning ~4 orders of magnitude of volume across many categories.

PRE-REGISTERED (fixed before this run):
  M1 (the mechanism): OLS slope of per-series maker net edge on log10(median volume) is
      NEGATIVE with p < 0.05.
  M2 (not one category): the sign of the slope survives dropping any single category
      (leave-one-category-out robustness).
  KILL: slope flat or positive -> the liquidity-provision explanation is REFUTED, whatever any
      individual series does.

Maker P&L identical to the earlier runs (W3 parameter lock): taker_side gives the maker's side,
settlement gives the value, full fee charged. Read-only. No orders.

Run:  python experiments/kalshi_maker_edge_vs_liquidity.py
"""

from __future__ import annotations

import json
import math
import os
import statistics as st
from collections import defaultdict

DIRS = [os.path.join("data", "kalshi", "mechanism"),
        os.path.join("data", "kalshi", "settled")]
CATS = os.path.join("data", "kalshi", "liquid_series.jsonl")
OUT = os.path.join("experiments", "results", "kalshi_maker_edge_vs_liquidity.json")
E = "utf-8-sig"


def fee_per_contract(p):
    x = max(0.0, min(1.0, p / 100.0))
    return 0.07 * x * (1 - x) * 100


def series_edge(dirpath, series):
    mp = os.path.join(dirpath, f"{series}.markets.jsonl")
    tp = os.path.join(dirpath, f"{series}.trades.jsonl")
    if not (os.path.exists(mp) and os.path.exists(tp)):
        return None
    V, vol = {}, []
    for line in open(mp, encoding=E):
        if not line.strip():
            continue
        m = json.loads(line)
        r = (m.get("result") or "").lower()
        if r in ("yes", "no"):
            V[m["ticker"]] = 100.0 if r == "yes" else 0.0
            try:
                v = float(m.get("volume_fp") or 0)
                if v > 0:
                    vol.append(v)
            except Exception:
                pass
    if not V or not vol:
        return None
    g = f = n = 0.0
    for line in open(tp, encoding=E):
        if not line.strip():
            continue
        t = json.loads(line)
        tk = t.get("ticker")
        if tk not in V:
            continue
        try:
            p = float(t["yes_price_dollars"]) * 100
            c = float(t.get("count_fp", 0) or 0)
        except Exception:
            continue
        if c <= 0 or not (0 < p < 100):
            continue
        s = (t.get("taker_side") or "").lower()
        if s == "yes":
            mk = p - V[tk]
        elif s == "no":
            mk = V[tk] - p
        else:
            continue
        g += mk * c; f += fee_per_contract(p) * c; n += c
    if n <= 0:
        return None
    return {"series": series, "median_volume": st.median(vol), "contracts": n,
            "maker_net_c": (g - f) / n, "maker_gross_c": g / n}


def ols(xs, ys):
    n = len(xs)
    mx, my = st.mean(xs), st.mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    a = my - b * mx
    resid = [y - (a + b * x) for x, y in zip(xs, ys)]
    if n <= 2:
        return {"slope": b, "intercept": a, "t": None, "p": None, "r2": None, "n": n}
    s2 = sum(r * r for r in resid) / (n - 2)
    se = math.sqrt(s2 / sxx) if sxx > 0 else float("inf")
    t = b / se if se > 0 else 0.0
    sst = sum((y - my) ** 2 for y in ys)
    r2 = 1 - sum(r * r for r in resid) / sst if sst > 0 else 0.0
    try:
        from statistics import NormalDist
        p = 2 * (1 - NormalDist().cdf(abs(t)))
    except Exception:
        p = float("nan")
    return {"slope": b, "intercept": a, "t": t, "p": p, "r2": r2, "n": n}


def main():
    cat = {}
    if os.path.exists(CATS):
        for line in open(CATS, encoding=E):
            if line.strip():
                r = json.loads(line)
                cat[r["series"]] = r["category"]

    seen, rows = set(), []
    for d in DIRS:
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if not fn.endswith(".markets.jsonl"):
                continue
            s = fn[: -len(".markets.jsonl")]
            if s in seen:
                continue
            r = series_edge(d, s)
            if r and r["contracts"] >= 500:
                r["category"] = cat.get(s, "Weather" if s.startswith("KXHIGH")
                                        else "Crypto" if "BTC" in s or "ETH" in s
                                        else "Sports" if "GAME" in s else "Other")
                rows.append(r); seen.add(s)

    rows.sort(key=lambda r: r["median_volume"])
    xs = [math.log10(max(1.0, r["median_volume"])) for r in rows]
    ys = [r["maker_net_c"] for r in rows]
    fit = ols(xs, ys)

    # M2: leave-one-category-out
    loco = {}
    cats = sorted({r["category"] for r in rows})
    for c in cats:
        sub = [(x, y) for x, y, r in zip(xs, ys, rows) if r["category"] != c]
        if len(sub) >= 5:
            f2 = ols([a for a, _ in sub], [b for _, b in sub])
            loco[c] = {"slope": round(f2["slope"], 4), "t": round(f2["t"], 2) if f2["t"] else None, "n": f2["n"]}

    m1 = bool(fit and fit["slope"] < 0 and fit["p"] is not None and fit["p"] < 0.05)
    m2 = bool(loco and all(v["slope"] < 0 for v in loco.values()))
    verdict = ("MECHANISM SUPPORTED — maker edge falls significantly with volume, sign robust to dropping any category"
               if (m1 and m2) else
               "MECHANISM SUPPORTED BUT FRAGILE — significant overall, sign flips when a category is dropped"
               if m1 else
               "MECHANISM REFUTED — no significant negative volume relationship; the liquidity-provision story does not hold")

    rep = {"date": "2026-07-25", "test": "B — maker edge vs liquidity (mechanism)",
           "n_series": len(rows),
           "volume_span": [round(min(r["median_volume"] for r in rows)),
                           round(max(r["median_volume"] for r in rows))],
           "regression_net_on_log10_volume": {k: (round(v, 4) if isinstance(v, float) else v) for k, v in fit.items()} if fit else None,
           "leave_one_category_out": loco,
           "series": [{"series": r["series"], "category": r["category"],
                       "median_volume": round(r["median_volume"]),
                       "maker_net_c": round(r["maker_net_c"], 3),
                       "maker_gross_c": round(r["maker_gross_c"], 3)} for r in rows],
           "gates": {"M1_negative_slope_p05": m1, "M2_sign_robust_loco": m2, "VERDICT": verdict}}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(rep, f, indent=2)

    print("=== TEST B: maker edge vs liquidity (the MECHANISM) ===\n")
    print(f"{'series':26} {'category':22} {'medVol':>10} {'net':>9} {'gross':>9}")
    for r in rows:
        print(f"{r['series'][:26]:26} {r['category'][:22]:22} {r['median_volume']:>10,.0f} "
              f"{r['maker_net_c']:>+8.2f}c {r['maker_gross_c']:>+8.2f}c")
    if fit:
        print(f"\nOLS  net ~ log10(volume):  slope={fit['slope']:+.4f} c per decade   "
              f"t={fit['t']:+.2f}  p={fit['p']:.4f}  R2={fit['r2']:.3f}  n={fit['n']}")
    print("\nleave-one-category-out slopes:")
    for c, v in loco.items():
        print(f"  drop {c:24} slope={v['slope']:+.4f}  t={v['t']}")
    print(f"\nGATES: M1={m1}  M2={m2}\nVERDICT: {verdict}")
    print("->", OUT)


if __name__ == "__main__":
    main()
