"""Holdout theater, measured on the Champion's own selection process (Σ-cert §8.4).

Question (operator, 2026-07-19): apply the Collapse Certificate's research to the
champion trader and MEASURE the outcome in a backtest, PDF-style.

The certificate's sharpest transferable result is §8.4: a FIXED validation set
reused across adaptive research queries inflates the reported edge (selection
chases holdout noise); a Thresholdout mechanism (Dwork arXiv:1506.02629) keeps
reported evidence honest; genuinely fresh data is the anchor. Our deep-history
program reused one validation window across many sweeps - exactly the exposure.

Design (free data, existing engine, no peeking):
  - Grid: tv x brake x trend_m x band = 3x3x3x3 = 81 configs (min_gross 0),
    each run ONCE over the full panel with the $2,000 + $20/mo premise
    (leverage_brake_to_cash.run_daily_cash, byte-identical engine). Cached.
  - Windows: TRAIN 2000-2012 | VAL 2013-2019 | TEST 2020-2026-07 (COVID + 2022
    + the 2026 rotation). TEST is touched exactly once, at grading time.
  - A simulated researcher hill-climbs the grid for K=40 accept/reject queries,
    starting from a deliberately mediocre corner, under three regimes:
      naive        query = exact VAL Sharpe every time (how research actually ran)
      thresholdout query answered from TRAIN unless |TRAIN-VAL| > T + Lap(sigma);
                   then VAL + Lap(sigma), spending one unit of an n/4-style budget
      fresh        query = VAL Sharpe on an independent moving-block bootstrap
                   resample per query (proxy for a fresh flow; labeled as proxy)
  - Grade: TRUE test-window Sharpe + growth of $1 over TEST for each regime's
    final pick (24 seeds for the stochastic arms), vs the ACTUAL champion config
    (tv .35 / brake .30 / trend 6 / band .08) graded the same way.
  - The honesty number: reported-vs-true Sharpe gap per regime (cert's metric).

Shape is the claim, not the constants (the certificate's own caveat).
Run: python experiments/champion_holdout_theater.py   (~5-10 min, multiprocess)
"""
import json
import math
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

TVS = [0.20, 0.35, 0.50]
BRAKES = [0.15, 0.30, 0.45]
TRENDS = [3, 6, 12]
BANDS = [0.0, 0.08, 0.16]
GRID = [(a, b, c, d) for a in range(3) for b in range(3) for c in range(3) for d in range(3)]
CHAMPION = (TVS.index(0.35), BRAKES.index(0.30), TRENDS.index(6), BANDS.index(0.08))
START_BAD = (TVS.index(0.20), BRAKES.index(0.45), TRENDS.index(3), BANDS.index(0.0))
K_QUERIES = 40
SEEDS = 24
VAL_LO, VAL_HI = "2013-01-01", "2020-01-01"
TEST_LO = "2020-01-01"
CACHE = HERE / "champion_holdout_grid_cache.npz"


PANEL_NPZ = HERE / "champion_holdout_panel.npz"
_PANEL = {}


def _get_panel():
    """Per-process lazy panel load from the pre-fetched npz (no network in workers)."""
    if not _PANEL:
        z = np.load(PANEL_NPZ, allow_pickle=True)
        days = [str(d) for d in z["days"]]
        px = {s: z[s] for s in ["SPY", "QQQ", "IWM", "EFA", "TLT", "GLD", "XMMO", "SPMO"]}
        _PANEL["days"], _PANEL["px"] = days, px
    return _PANEL["days"], _PANEL["px"]


def _run_config(args):
    idx, (ia, ib, ic, id_) = args
    import leverage_daily_overlay as D
    import leverage_brake_to_cash as DB
    D.UNIVERSE = ["SPY", "QQQ", "IWM", "EFA", "TLT", "GLD", "XMMO", "SPMO"]
    days, px = _get_panel()
    r = DB.run_daily_cash(days, px, TVS[ia], TRENDS[ic], BRAKES[ib], 0.0,
                          init_cash=2000.0, band=BANDS[id_], band_mode="sym")
    dates = [d for d, _ in r["path"]][1:]           # rets align to path[1:]
    return idx, r["final"], r["maxdd"], np.array(r["rets"]), dates


def build_grid_cache():
    if CACHE.exists():
        z = np.load(CACHE, allow_pickle=True)
        return z["finals"], z["maxdds"], z["rets"], list(z["dates"])
    if not PANEL_NPZ.exists():
        print("# fetching panel once (Yahoo daily)...")
        import leverage_daily_overlay as D
        D.UNIVERSE = ["SPY", "QQQ", "IWM", "EFA", "TLT", "GLD", "XMMO", "SPMO"]
        days, px = D.build_panel()
        np.savez_compressed(PANEL_NPZ, days=np.array(days),
                            **{s: px[s] for s in D.UNIVERSE})
    print(f"# running {len(GRID)} configs (multiprocess)...")
    finals = np.zeros(len(GRID))
    maxdds = np.zeros(len(GRID))
    rets_list = [None] * len(GRID)
    dates = None
    with ProcessPoolExecutor(max_workers=min(6, os.cpu_count() or 4)) as ex:
        for idx, fin, dd, rr, dts in ex.map(_run_config, list(enumerate(GRID))):
            finals[idx], maxdds[idx], rets_list[idx] = fin, dd, rr
            dates = dates or dts
            if idx % 10 == 0:
                print(f"  config {idx}/{len(GRID)} done")
    L = min(len(r) for r in rets_list)
    rets = np.stack([r[-L:] for r in rets_list])
    dates = dates[-L:]
    np.savez_compressed(CACHE, finals=finals, maxdds=maxdds, rets=rets,
                        dates=np.array(dates))
    return finals, maxdds, rets, dates


def sharpe(r):
    r = np.asarray(r)
    return float(r.mean() / r.std(ddof=1) * math.sqrt(252)) if r.size > 2 and r.std(ddof=1) > 0 else 0.0


def neighbors(cfg):
    out = []
    for dim, size in enumerate((3, 3, 3, 3)):
        for step in (-1, 1):
            v = list(cfg)
            v[dim] += step
            if 0 <= v[dim] < size:
                out.append(tuple(v))
    return out


def hill_climb(query, rng):
    """Greedy adaptive researcher: K accept/reject queries against `query(cfg)`."""
    cur = START_BAD
    cur_score = query(cur)
    n_q = 1
    while n_q < K_QUERIES:
        cands = neighbors(cur)
        rng.shuffle(cands)
        improved = False
        for c in cands:
            if n_q >= K_QUERIES:
                break
            s = query(c)
            n_q += 1
            if s > cur_score:
                cur, cur_score, improved = c, s, True
                break
        if not improved:
            break
    return cur, cur_score


def main():
    finals, maxdds, rets, dates = build_grid_cache()
    gi = {g: i for i, g in enumerate(GRID)}
    dates = [str(d) for d in dates]
    val_mask = np.array([VAL_LO <= d < VAL_HI for d in dates])
    test_mask = np.array([d >= TEST_LO for d in dates])
    train_mask = np.array([d < VAL_LO for d in dates])
    print(f"# windows: train {train_mask.sum()}d, val {val_mask.sum()}d, test {test_mask.sum()}d")

    val_sh = np.array([sharpe(rets[i][val_mask]) for i in range(len(GRID))])
    tr_sh = np.array([sharpe(rets[i][train_mask]) for i in range(len(GRID))])
    te_sh = np.array([sharpe(rets[i][test_mask]) for i in range(len(GRID))])
    te_growth = np.array([float(np.prod(1 + rets[i][test_mask])) for i in range(len(GRID))])

    val_idx = np.where(val_mask)[0]

    def q_naive(cfg):
        return val_sh[gi[cfg]]

    def make_q_fresh(rng):
        def q(cfg):
            # moving-block bootstrap resample of the val window (fresh-flow proxy)
            block = 63
            nblk = int(np.ceil(val_idx.size / block))
            starts = rng.integers(0, val_idx.size - block, size=nblk)
            sel = np.concatenate([val_idx[s:s + block] for s in starts])[:val_idx.size]
            return sharpe(rets[gi[cfg]][sel])
        return q

    def make_q_thresh(rng, T=0.25, sig=0.15, budget=10):
        state = {"spent": 0}
        def q(cfg):
            i = gi[cfg]
            if state["spent"] >= budget:
                return tr_sh[i]                        # budget gone -> pool only
            if abs(tr_sh[i] - val_sh[i]) > T + rng.laplace(0, sig):
                state["spent"] += 1
                return val_sh[i] + rng.laplace(0, sig)
            return tr_sh[i]
        return q

    results = {}
    # naive is deterministic
    pick, rep = hill_climb(q_naive, np.random.default_rng(0))
    results["naive"] = {"picks": [pick], "reported": [rep]}
    for name, maker in (("thresholdout", make_q_thresh), ("fresh", make_q_fresh)):
        picks, reps = [], []
        for s in range(SEEDS):
            rng = np.random.default_rng(1000 + s)
            p, r = hill_climb(maker(rng), rng)
            picks.append(p)
            reps.append(r)
        results[name] = {"picks": picks, "reported": reps}

    def grade(name):
        rr = results[name]
        idxs = [gi[p] for p in rr["picks"]]
        rep = np.array(rr["reported"])
        true = np.array([te_sh[i] for i in idxs])
        valtrue = np.array([val_sh[i] for i in idxs])
        gap = rep - valtrue                       # inflation of the report vs the val truth
        gen = valtrue - true                      # val -> test generalization drop (regime-independent noise)
        growth = np.array([te_growth[i] for i in idxs])
        fin = np.array([finals[i] for i in idxs])
        dd = np.array([maxdds[i] for i in idxs])
        return {"n": len(idxs),
                "picked_modal": GRID[max(set(idxs), key=idxs.count)],
                "reported_sharpe": float(rep.mean()),
                "val_true_sharpe": float(valtrue.mean()),
                "report_inflation": float(gap.mean()),
                "test_sharpe": float(true.mean()),
                "test_growth_x": float(growth.mean()),
                "full_final_usd": float(fin.mean()),
                "full_maxdd": float(dd.mean())}

    graded = {k: grade(k) for k in results}
    ci = gi[CHAMPION]
    champ = {"config": CHAMPION, "val_sharpe": float(val_sh[ci]), "test_sharpe": float(te_sh[ci]),
             "test_growth_x": float(te_growth[ci]), "full_final_usd": float(finals[ci]),
             "full_maxdd": float(maxdds[ci])}
    oracle_i = int(np.argmax(te_sh))

    def fmt(cfg):
        return f"tv{TVS[cfg[0]]}/bk{BRAKES[cfg[1]]}/tr{TRENDS[cfg[2]]}/bd{BANDS[cfg[3]]}"

    print("\n=== HOLDOUT THEATER ON THE CHAMPION'S SELECTION (PDF-style) ===")
    print(f"{'regime':14s} {'modal pick':28s} {'reported':>9s} {'val-true':>9s} "
          f"{'inflate':>8s} {'TEST Sh':>8s} {'TEST x':>7s} {'full $':>10s} {'maxDD':>7s}")
    for k, g in graded.items():
        print(f"{k:14s} {fmt(g['picked_modal']):28s} {g['reported_sharpe']:9.3f} "
              f"{g['val_true_sharpe']:9.3f} {g['report_inflation']:8.3f} {g['test_sharpe']:8.3f} "
              f"{g['test_growth_x']:7.2f} {g['full_final_usd']:10,.0f} {g['full_maxdd']*100:6.1f}%")
    print(f"{'CHAMPION(ref)':14s} {fmt(CHAMPION):28s} {'-':>9s} {champ['val_sharpe']:9.3f} "
          f"{'-':>8s} {champ['test_sharpe']:8.3f} {champ['test_growth_x']:7.2f} "
          f"{champ['full_final_usd']:10,.0f} {champ['full_maxdd']*100:6.1f}%")
    print(f"{'oracle(test)':14s} {fmt(GRID[oracle_i]):28s} "
          f"{'':9s} {val_sh[oracle_i]:9.3f} {'':8s} {te_sh[oracle_i]:8.3f} "
          f"{te_growth[oracle_i]:7.2f} {finals[oracle_i]:10,.0f} {maxdds[oracle_i]*100:6.1f}%")

    out = {"grid": {"tv": TVS, "brake": BRAKES, "trend": TRENDS, "band": BANDS},
           "windows": {"train": "<2013", "val": "2013-2019", "test": ">=2020"},
           "k_queries": K_QUERIES, "seeds": SEEDS,
           "regimes": graded, "champion_ref": champ,
           "oracle_test": {"config": GRID[oracle_i], "test_sharpe": float(te_sh[oracle_i])},
           "notes": ["fresh = moving-block bootstrap proxy for a fresh flow",
                     "thresholdout: T=0.25, sigma=0.15 Sharpe units, budget 10 - "
                     "shape is the claim, not the constants",
                     "engine identical to the published champion walk-forward"]}
    (HERE / "champion_holdout_theater.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("\nwrote experiments/champion_holdout_theater.json")


if __name__ == "__main__":
    main()
