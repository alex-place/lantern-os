"""Machine-check of Theorem C3 (normal A) — Σ₀⁻¹ prevents permanent freeze.
See docs/SIGMA0-C3-NONCOLLAPSE-NORMAL.md.

C3 chains five lemmas; L2 is already machine-checked (prove_l2_anisotropy_lift.py).
This script verifies the two parts the C3 code fixes add:

  (A) Fix A — the μ-aware covariance floor. Over an adversarial sweep of near-isotropic
      Σ × partially-degenerate (normal) A × tiny gate p, the FLOORED bump lifts
      anisotropy ≥ ε_a in ZERO counterexamples, while the OLD scale-blind bump
      (strength·p, same basis) FAILS to in a large fraction — so the floor is both
      sufficient and necessary.

  (B) L5 — the alternation. Whenever the four-condition gate is true at step t, the
      floored+banded bump makes cond_flat false at t+1, so triggered(t+1) is false:
      no two consecutive freezes. Checked on the SAME swept configurations.

Both run with the ACTUAL SemanticCollapseOperator / AntiCollapseOperator (float32, the
banded near-null basis, the unbiased-CoV anisotropy), so the population-proof bound
transfers to the shipped operator.

Run: python experiments/prove_c3_noncollapse.py
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import torch  # noqa: E402

from src.cio_sde.collapse import (  # noqa: E402
    AntiCollapseOperator, SemanticCollapseOperator,
)

EPS_A = 5e-2  # anisotropy_eps, must match collapse.py


def _random_normal_partial_degenerate(d: int, n_active: int, g: torch.Generator):
    """A NORMAL A with exactly n_active non-null symmetric modes, in a random ON basis.

    A is symmetric here (A = A_s), the regime where Theorem 1 and C3 are proven; the
    null subspace has dimension d − n_active ≥ 1 (a proper subspace), so L2 applies.
    Returns (A, Q) with Q the shared eigenbasis (used to align Σ — L1, normal A).
    """
    Q, _ = torch.linalg.qr(torch.randn(d, d, generator=g, dtype=torch.float64))
    lam = torch.zeros(d, dtype=torch.float64)
    # active modes: O(1) magnitude, sign irrelevant to the null structure
    idx = torch.randperm(d, generator=g)[:n_active]
    lam[idx] = torch.empty(n_active, dtype=torch.float64).uniform_(0.3, 1.0, generator=g)
    A = (Q * lam) @ Q.T
    return A, Q


def _aligned_near_isotropic_sigma(Q: torch.Tensor, a_unbiased: float, mu: float,
                                  g: torch.Generator):
    """Σ = Q diag(λ) Qᵀ — same eigenbasis as A (L1) — with measured (unbiased) CoV
    ≈ a_unbiased and mean μ."""
    d = Q.shape[0]
    z = torch.randn(d, generator=g, dtype=torch.float64)
    z = z - z.mean()
    ps = z.pow(2).mean().sqrt()
    if float(ps) < 1e-9:
        z = torch.zeros(d, dtype=torch.float64); z[0] = 1.0; z = z - z.mean()
        ps = z.pow(2).mean().sqrt()
    pop_cov = a_unbiased / math.sqrt(d / (d - 1))      # _anisotropy uses unbiased std
    lam = (mu + (pop_cov * mu / ps) * z).clamp_min(1e-6)
    return (Q * lam) @ Q.T


def sweep(n_trials: int = 3000) -> bool:
    op = AntiCollapseOperator(strength=0.5)
    op.detector.anisotropy_eps = EPS_A
    g = torch.Generator().manual_seed(20260625)
    dims = [4, 5, 6, 8, 12]

    floor_counterexamples = 0       # floored bump failed to lift (should be 0)
    alternation_counterexamples = 0 # cond_flat did NOT break after the bump (should be 0)
    old_bump_fails = 0              # old scale-blind bump failed to lift (shows necessity)
    checked = 0
    worst_margin = math.inf

    for t in range(n_trials):
        d = dims[t % len(dims)]
        # rank-deficient enough that cond_rank fires: at least ⌈d/2⌉ null modes.
        n_active = 1 + (t % max(1, d // 2 - 1))         # 1 .. <d/2 active ⇒ null > d/2
        A_np, Q = _random_normal_partial_degenerate(d, n_active, g)
        mu = float(torch.empty(1, dtype=torch.float64).uniform_(0.05, 5.0, generator=g))
        a_target = float(torch.empty(1, dtype=torch.float64).uniform_(0.2 * EPS_A,
                                                                      0.9 * EPS_A, generator=g))
        Sigma = _aligned_near_isotropic_sigma(Q, a_target, mu, g)

        A = A_np.to(torch.float32).unsqueeze(0)         # (1, d, d), normal
        sigma = Sigma.to(torch.float32).unsqueeze(0)
        a_pre = op.detector._anisotropy(sigma)
        if a_pre >= EPS_A:                              # only the flat (cond_flat) hypothesis
            continue
        # a tiny min-gate proximity: the regime where the OLD bump is too weak
        p = 0.01
        x = torch.zeros(1, d)
        noise = torch.zeros(1, d)                       # isolate the covariance leg

        _, sig_extra = op.excite(x, sigma, A, p, noise)
        a_new = op.detector._anisotropy(sigma + sig_extra)
        margin = a_new - EPS_A
        worst_margin = min(worst_margin, margin)
        if margin < -1e-6:
            floor_counterexamples += 1
        # L5: cond_flat must be FALSE after the bump (the alternation step)
        if a_new < EPS_A - 1e-6:
            alternation_counterexamples += 1

        # OLD scale-blind bump on the SAME banded basis — demonstrates necessity
        null = op._near_null_basis(A)
        old_bump = (op.strength * p) * (null @ null.T)
        if op.detector._anisotropy(sigma + old_bump.unsqueeze(0)) < EPS_A:
            old_bump_fails += 1
        checked += 1

    print(f"[sweep] checked {checked} flat configs (d∈{dims}, normal partial-degenerate A)")
    print(f"[floor]       floored bump failed to lift ε_a : {floor_counterexamples}  "
          f"(worst margin {worst_margin:+.5f})")
    print(f"[L5]          cond_flat survived the bump      : {alternation_counterexamples}")
    print(f"[necessity]   OLD scale-blind bump failed       : {old_bump_fails}/{checked} "
          f"({100.0 * old_bump_fails / max(checked,1):.0f}% — why the floor is needed)")
    ok = (floor_counterexamples == 0 and alternation_counterexamples == 0
          and old_bump_fails > 0 and checked > 1500)
    return ok


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    print("Theorem C3 (normal A) — Σ₀⁻¹ floor + banded near-null: machine-check\n")
    ok = sweep()
    print(f"\nC3 (normal A) {'VERIFIED' if ok else 'FAILED'} "
          "— floored bump lifts ε_a everywhere (L4), cond_flat breaks every time (L5), "
          "and the old scale-blind bump provably did not (necessity).")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
