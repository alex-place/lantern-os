"""M3 first test — hunt the silent set of the no-silent-collapse dichotomy.

Conjecture M3: for an UNGROUNDED linear loop x_{t+1} = rho*R(theta) x_t + w,
w ~ N(0, Q), every trajectory trips at least one of the two canary axes —
(i) degeneration (covariance isotropizes / trajectory freezes) or
(ii) surprise (NIS mis-calibrates vs chi^2_d under the monitor's stationary
Gaussian fit) — except a negligible edge set.

This probe SEARCHES for the counterexample: a (theta, kappa, rho) cell where
the loop is fully ungrounded yet BOTH toy canaries stay silent. Toy instrument
semantics only (like X4): running-window mean/cov fit, NIS band, anisotropy
band, freeze band. Finding a robust silent region does not kill M3 — it tells
us the third condition the theorem needs (expected: stationarity itself, i.e.
the boiling-frog hard-cadence #1012 is the patch the math demands).

Run:  python experiments/owned_math_m3_dichotomy_edgecase.py
"""

from __future__ import annotations

import json
import os

import numpy as np

OUT = os.path.join("experiments", "results", "owned_math_m3_dichotomy_edgecase.json")

T = 20_000
WINDOW = 2_000
SEED = 42

# canary bands (toy semantics, stated in the report)
NIS_BAND = (1.6, 2.4)        # mean NIS vs chi^2_2 mean = 2
ISOTROPY_A_MIN = 0.05        # a(Sigma) = 1 - lmin/lmax below this -> "isotropized"
FREEZE_STEP = 1e-3           # mean |x_t - x_{t-1}| below this -> frozen


def rot(theta: float) -> np.ndarray:
    c, s = np.cos(theta), np.sin(theta)
    return np.array([[c, -s], [s, c]])


def run_cell(theta: float, kappa: float, rho: float, rng) -> dict:
    A = rho * rot(theta)
    Q = np.diag([1.0, 1.0 / kappa])
    L = np.linalg.cholesky(Q)
    x = np.zeros(2)
    xs = np.empty((T, 2))
    for t in range(T):
        x = A @ x + L @ rng.standard_normal(2)
        xs[t] = x

    # PREQUENTIAL monitor: exponentially-weighted mean/cov updated from PAST
    # samples only; NIS_t scored one-step-ahead BEFORE the update. (v1 of this
    # probe fit mean/cov on the same window it scored — in-sample NIS = d by
    # construction, i.e. a self-refit ungrounded monitor is silent by design.
    # That circularity is reported in the doc; this is the corrected instrument.)
    lam = 0.995
    warmup = 500
    mu = np.zeros(2)
    Sigma = np.eye(2)
    nis_tail = []
    for t in range(T):
        v = xs[t]
        if t >= warmup and t >= T - WINDOW:
            d = v - mu
            nis_tail.append(float(d @ np.linalg.inv(Sigma + 1e-9 * np.eye(2)) @ d))
        d = v - mu
        mu = lam * mu + (1 - lam) * v
        Sigma = lam * Sigma + (1 - lam) * np.outer(d, d)
    mean_nis = float(np.mean(nis_tail)) if nis_tail else float("nan")

    tail = xs[-WINDOW:]
    evals = np.linalg.eigvalsh(np.cov(tail.T) + 1e-12 * np.eye(2))
    a_sigma = 1.0 - evals.min() / evals.max()          # 0 = isotropic

    steps = np.linalg.norm(np.diff(tail, axis=0), axis=1)
    mean_step = float(steps.mean())

    surprise_fires = bool(not (NIS_BAND[0] <= mean_nis <= NIS_BAND[1]))
    isotropized = bool(a_sigma < ISOTROPY_A_MIN)
    frozen = bool(mean_step < FREEZE_STEP)
    degeneration_fires = bool(isotropized or frozen)
    silent = bool((not surprise_fires) and (not degeneration_fires))

    return {
        "theta": round(theta, 4),
        "kappa": kappa,
        "rho": rho,
        "mean_NIS": round(mean_nis, 3),
        "a_sigma": round(float(a_sigma), 3),
        "mean_step": round(mean_step, 4),
        "surprise_fires": surprise_fires,
        "degeneration_fires": degeneration_fires,
        "SILENT": silent,
    }


def main():
    rng = np.random.default_rng(SEED)
    golden = 2.399963229728653
    thetas = [0.0, 0.1, golden, np.pi / 2, np.pi]
    kappas = [1.0, 10.0, 100.0]
    rhos = [1.0, 0.99, 0.9]

    cells = []
    for th in thetas:
        for k in kappas:
            for r in rhos:
                if r >= 1.0 and abs(th) < 1e-9 and False:
                    continue  # pure random walk kept: nonstationarity should fire NIS
                cells.append(run_cell(th, k, r, rng))

    silent = [c for c in cells if c["SILENT"]]
    report = {
        "toy_semantics": {
            "T": T, "window": WINDOW, "nis_band": NIS_BAND,
            "isotropy_a_min": ISOTROPY_A_MIN, "freeze_step": FREEZE_STEP,
        },
        "n_cells": len(cells),
        "n_silent": len(silent),
        "silent_cells": silent,
        "all_cells": cells,
        "reading": (
            "Silent cells = ungrounded dynamics both toy canaries miss. A robust "
            "silent set means M3 needs a third condition (expected: stationary "
            "self-consistency — exactly what the #1012 hard grounding cadence "
            "covers in production)."
        ),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(json.dumps({k: report[k] for k in ("n_cells", "n_silent", "silent_cells")}, indent=2))


if __name__ == "__main__":
    main()
