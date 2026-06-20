"""
Sigma0-inverse regime sweep -- upgrade anti-collapse from N=1 heuristic to
MEASURED-over-distribution (#658).

Section 3 of the collapse certificate labels Sigma0^-1 (the anti-collapse operator) a
CONTROL-DESIGN HEURISTIC backed by a single forced-collapse run (N=1). This script
generalizes that one trial into a sweep over a parameter grid and reports the MEASURED
collapse-prevention rate over the distribution -- option (b) of the issue.

What actually triggers Sigma0 collapse (verified against src/cio_sde/collapse.py):
SemanticCollapseOperator fires when the drift Jacobian A is effectively RANK-DEFICIENT
(eff_rank(A) < rank_frac*dim) together with a small gradient, flat covariance, and
control-insensitivity. So a system collapses precisely when it is UNDERDETERMINED -- it
has a non-trivial null subspace. A=alpha*I is full effective rank and never collapses;
the N=1 experiment used one worst-case rank-deficient real Jacobian.

Design (deterministic, CPU-only, no network):
  * Fix the underdetermined structure: a NULL_DIM-dimensional null subspace plus one
    active stable mode -- A = diag(alpha, 0, ..., 0) + nu * N, where N is strictly
    upper-triangular (nilpotent), so N adds NON-NORMALITY (A != A^T) and the active
    eigenvalue stays = alpha. This is the regime where collapse is on the table, the
    distribution-level analogue of the single worst-case Jacobian.
  * Sweep the three axes the issue names: spectral abscissa alpha (the active mode),
    non-normality nu, and diffusion noise.
  * For each cell, run M trials (deterministic per-trial seed). Each trial runs the
    engine rollout TWICE from the SAME init/seed: once WITHOUT Sigma0^-1, once WITH it.
  * Report per cell:
      collapse_rate_without_anti -- fraction of trials that collapse with no protection
      prevention_rate_with_anti  -- fraction of trials where Sigma0^-1 yields no collapse
                                    AND the state re-excites (escapes the attractor)
  * Headline metric = prevention rate CONDITIONAL on collapse-prone trials (trials that
    actually collapse without protection). A cell that never collapses cannot demonstrate
    prevention, so it is excluded from the conditional rate (and flagged).

HONESTY: the saved numbers are whatever the rollouts produce. Regimes where Sigma0^-1
does NOT prevent collapse are reported as-is -- that negative evidence is the entire
point of moving from N=1 to a measured distribution.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import torch  # noqa: E402

from src.cio_sde import (  # noqa: E402
    CIO_SDE, LinearDynamics, rollout,
    SemanticCollapseOperator, AntiCollapseOperator,
)

DIM = 4
CTRL = 2
BATCH = 8
STEPS = 30
DT = 0.05
M_TRIALS = 100
EXCITE_STRENGTH = 0.5
INIT_SCALE = 0.01            # small init -> underdetermined / collapse-prone regime
NULL_DIM = 3                 # fixed null subspace (DIM-NULL_DIM active modes)
BASE_SEED = 20260619

# Grid axes
ALPHAS = [-0.5, -0.2, -0.05]        # active-mode spectral abscissa
NON_NORMALITIES = [0.0, 0.5, 1.0]   # off-diagonal (nilpotent) magnitude
NOISES = [0.01, 0.05, 0.2]          # diffusion noise level

OUT_PATH = REPO_ROOT / "data" / "sigma0_regime_sweep_report.json"


def build_A(alpha: float, non_normality: float) -> torch.Tensor:
    """A = diag(alpha, 0, ..., 0) + nu*N, N strictly upper-triangular (nilpotent).

    DIM-NULL_DIM active eigenvalues = alpha, NULL_DIM null eigenvalues = 0; the
    nilpotent off-diagonal adds non-normality without moving the spectrum.
    """
    diag = [alpha] * (DIM - NULL_DIM) + [0.0] * NULL_DIM
    A = torch.diag(torch.tensor(diag, dtype=torch.float32))
    if non_normality:
        A = A + non_normality * torch.triu(torch.ones(DIM, DIM), diagonal=1)
    return A


def make_model(alpha: float, non_normality: float, noise: float) -> CIO_SDE:
    m = CIO_SDE(dim=DIM, ctrl_dim=CTRL, hidden=16)
    m.graph.active = LinearDynamics(build_A(alpha, non_normality),
                                    B=torch.zeros(DIM, CTRL), noise=noise)
    m.collapse_op = SemanticCollapseOperator()
    return m


def one_trial(alpha, non_normality, noise, trial_seed):
    """Run the same forced-collapse rollout with and without Sigma0^-1.

    Returns (collapsed_without, prevented_with).
    """
    torch.manual_seed(trial_seed)
    x0 = INIT_SCALE * torch.randn(BATCH, DIM)
    s0 = torch.eye(DIM).expand(BATCH, DIM, DIM).clone()

    m_off = make_model(alpha, non_normality, noise)
    _, _, tr_off = rollout(m_off, x0.clone(), s0.clone(), steps=STEPS, dt=DT, base_seed=trial_seed)
    collapsed_without = len(tr_off.collapses) > 0

    m_on = make_model(alpha, non_normality, noise)
    m_on.anti_collapse_op = AntiCollapseOperator(strength=EXCITE_STRENGTH)
    _, _, tr_on = rollout(m_on, x0.clone(), s0.clone(), steps=STEPS, dt=DT, base_seed=trial_seed)
    norms = tr_on.x_norms()
    re_excited = norms[-1] > norms[0]
    prevented_with = (len(tr_on.collapses) == 0) and re_excited

    return collapsed_without, prevented_with


def main() -> None:
    cells = []
    cond_prevented = 0   # prevented among collapse-prone trials
    cond_total = 0       # collapse-prone trials
    for ai, alpha in enumerate(ALPHAS):
        for ni, nn_mag in enumerate(NON_NORMALITIES):
            for noi, noise in enumerate(NOISES):
                collapses_off = 0
                prevented_on = 0
                prevented_among_prone = 0
                for t in range(M_TRIALS):
                    seed = BASE_SEED + 1000 * ai + 100 * ni + 10 * noi + t
                    c_off, p_on = one_trial(alpha, nn_mag, noise, seed)
                    collapses_off += int(c_off)
                    prevented_on += int(p_on)
                    if c_off:
                        cond_total += 1
                        if p_on:
                            cond_prevented += 1
                            prevented_among_prone += 1
                cells.append({
                    "alpha": alpha,
                    "non_normality": nn_mag,
                    "noise": noise,
                    "n_trials": M_TRIALS,
                    "collapse_rate_without_anti": round(collapses_off / M_TRIALS, 3),
                    "prevention_rate_with_anti": round(prevented_on / M_TRIALS, 3),
                    "collapse_prone_trials": collapses_off,
                    "prevented_among_prone": prevented_among_prone,
                })

    conditional_rate = round(cond_prevented / cond_total, 4) if cond_total else None
    collapse_prone_cells = sum(1 for c in cells if c["collapse_prone_trials"] > 0)
    report = {
        "issue": 658,
        "description": ("Sigma0^-1 anti-collapse prevention rate measured over an "
                        "alpha x non-normality x noise grid, with a fixed underdetermined "
                        f"({NULL_DIM}-dim null) Jacobian structure"),
        "config": {
            "dim": DIM, "batch": BATCH, "steps": STEPS, "dt": DT,
            "trials_per_cell": M_TRIALS, "excite_strength": EXCITE_STRENGTH,
            "init_scale": INIT_SCALE, "null_dim": NULL_DIM, "base_seed": BASE_SEED,
            "alphas": ALPHAS, "non_normalities": NON_NORMALITIES, "noises": NOISES,
        },
        "headline_conditional_prevention_rate": conditional_rate,
        "conditional_note": ("prevention rate over trials that ACTUALLY collapse without "
                             "Sigma0^-1; cells that never collapse are excluded (cannot "
                             "demonstrate prevention)"),
        "collapse_prone_trials_total": cond_total,
        "collapse_prone_cells": collapse_prone_cells,
        "total_cells": len(cells),
        "cells": cells,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")

    # Human-readable table (ASCII only -- Windows consoles are cp1252).
    print(f"Sigma0^-1 regime sweep -- {len(cells)} cells x {M_TRIALS} trials, "
          f"null_dim={NULL_DIM}")
    print(f"{'alpha':>6} {'non_norm':>9} {'noise':>6} {'collapse_off':>13} {'prevent_on':>11} {'prone':>6}")
    for c in cells:
        print(f"{c['alpha']:>6} {c['non_normality']:>9} {c['noise']:>6} "
              f"{c['collapse_rate_without_anti']:>13} {c['prevention_rate_with_anti']:>11} "
              f"{c['collapse_prone_trials']:>6}")
    print(f"\nCollapse-prone trials: {cond_total} (in {collapse_prone_cells}/{len(cells)} cells)")
    print(f"HEADLINE conditional prevention rate (Sigma0^-1, over collapse-prone trials): "
          f"{conditional_rate}")
    print(f"Report written to {OUT_PATH.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
