"""Iteration 8 (Σ₀) — is the edge REAL, or an artifact of testing many configs?

Σ₀ discipline: don't accept our own headline ("Conservative beats buy&hold on Sharpe")
without evidence of statistical significance. Two tests, both measured:

1. **Stationary block bootstrap** of the paired daily returns. Resample the history in
   ~21-day blocks (preserve autocorrelation), recompute each book's annualized Sharpe and
   the Sharpe DIFFERENCE (no_margin − buy&hold) on each resample, and report the 2.5/97.5
   percentile CI + the fraction of resamples where no_margin's Sharpe is higher. If the
   Sharpe-difference CI excludes 0, the edge is real at ~95%.

2. **Deflated Sharpe Ratio** (Bailey & López de Prod, 2014). Our config came from a sweep
   over N trials, so the in-sample Sharpe is upward-biased by selection. DSR = probability
   the TRUE Sharpe > 0 after deflating for N trials, skew, and kurtosis. We deflate the
   no_margin book against the ~45 configs tried per index in iteration 2.

Deterministic seed for reproducibility. Everything measured from deep_history.json.
"""
import math
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_overlay as O

SEED = 12345
N_BOOT = 2000
BLOCK = 21          # ~1 trading month, preserves monthly autocorrelation
N_TRIALS_SWEEP = 45  # band(5)×brake(3)×trend(3) = 45 configs per index in iter-2


def ann_sharpe(r):
    sd = r.std(ddof=1)
    return r.mean() / sd * math.sqrt(252) if r.size > 2 and sd > 0 else 0.0


def block_boot_indices(n, rng):
    """circular block bootstrap index vector of length n."""
    idx = np.empty(n, dtype=int)
    filled = 0
    while filled < n:
        start = rng.integers(0, n)
        take = min(BLOCK, n - filled)
        idx[filled:filled + take] = (start + np.arange(take)) % n
        filled += take
    return idx


def deflated_sharpe(r, n_trials):
    """Bailey & López de Prado (2014) Deflated Sharpe Ratio, daily returns in, prob out."""
    T = r.size
    sr = r.mean() / r.std(ddof=1) if r.std(ddof=1) > 0 else 0.0   # per-period (daily) SR
    # higher moments of returns
    z = (r - r.mean()) / (r.std(ddof=1) + 1e-12)
    skew = float(np.mean(z ** 3))
    kurt = float(np.mean(z ** 4))       # non-excess
    # expected max Sharpe under the null of N independent trials (variance of trial SRs ~ 1/T)
    emc = 0.5772156649
    sr_star = math.sqrt(1.0 / T) * ((1 - emc) * _norm_ppf(1 - 1.0 / n_trials)
                                    + emc * _norm_ppf(1 - 1.0 / (n_trials * math.e)))
    denom = math.sqrt(max(1e-12, 1 - skew * sr + (kurt - 1) / 4 * sr * sr))
    dsr_stat = (sr - sr_star) * math.sqrt(T - 1) / denom
    return _norm_cdf(dsr_stat), sr * math.sqrt(252), sr_star * math.sqrt(252)


def _norm_cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _norm_ppf(p):
    # Acklam's rational approximation to the inverse normal CDF
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    pl, ph = 0.02425, 1 - 0.02425
    if p < pl:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p <= ph:
        q = p - 0.5; r = q*q
        return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)
    q = math.sqrt(-2 * math.log(1 - p))
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)


def analyze(sym):
    days, px = O.load_asset(sym)
    NR = dict(tv=0.20, trend_m=12, brake=0.20, min_gross=0.0, max_gross=1.0, band=0.30)
    BH = dict(tv=0.0, trend_m=6, brake=9.9, min_gross=1.0, max_gross=1.0, band=0.0)
    nm = O.run_overlay(days, px, **NR); bh = O.run_overlay(days, px, **BH)
    rn, rb = nm["rets"], bh["rets"]
    n = min(rn.size, rb.size); rn, rb = rn[-n:], rb[-n:]   # align tails (same calendar)
    rng = np.random.default_rng(SEED)
    d_sharpe, nm_wins = [], 0
    for _ in range(N_BOOT):
        idx = block_boot_indices(n, rng)
        sn, sb = ann_sharpe(rn[idx]), ann_sharpe(rb[idx])
        d_sharpe.append(sn - sb)
        nm_wins += (sn > sb)
    d = np.array(d_sharpe)
    lo, hi = np.percentile(d, [2.5, 97.5])
    dsr, sr_ann, srstar_ann = deflated_sharpe(rn, N_TRIALS_SWEEP)
    print(f"\n# {sym}  ({n} days)")
    print(f"  point Sharpe: no_margin {nm['sharpe']:.2f}  buy&hold {bh['sharpe']:.2f}  "
          f"Δ {nm['sharpe']-bh['sharpe']:+.2f}")
    print(f"  bootstrap ΔSharpe 95% CI: [{lo:+.2f}, {hi:+.2f}]   "
          f"P(no_margin Sharpe > buy&hold) = {nm_wins/N_BOOT:.1%}")
    print(f"  CI excludes 0 → edge significant: {'YES' if lo > 0 else 'NO'}")
    print(f"  Deflated Sharpe (vs {N_TRIALS_SWEEP} trials): DSR = {dsr:.3f}  "
          f"(P[true Sharpe>0]); haircut {sr_ann:.2f}→need>{srstar_ann:.2f}")
    return {"symbol": sym, "n_days": int(n),
            "sharpe_no_margin": nm["sharpe"], "sharpe_buyhold": bh["sharpe"],
            "delta_sharpe_point": nm["sharpe"] - bh["sharpe"],
            "delta_sharpe_ci95": [float(lo), float(hi)],
            "p_no_margin_better": nm_wins / N_BOOT,
            "significant": bool(lo > 0),
            "deflated_sharpe_prob": float(dsr),
            "sharpe_ann": float(sr_ann), "sharpe_star_ann": float(srstar_ann)}


def main():
    import json
    out = {"seed": SEED, "n_boot": N_BOOT, "block": BLOCK, "n_trials": N_TRIALS_SWEEP,
           "results": {}}
    for sym in ("^GSPC", "^IXIC"):
        out["results"][sym] = analyze(sym)
    (HERE / "deep_significance.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("\nwrote deep_significance.json")


if __name__ == "__main__":
    main()
