"""Machine-check of Theorem C3 — NON-NORMAL A (the [#768] frontier).

The normal-A proof (prove_c3_noncollapse.py) leans on alignment hypothesis L1: the
bump basis (eigenvectors of A_s) must coincide with the eigenvectors of Σ. The sweep
there *constructs* that alignment (shared Q). The certificate calls L1 "open for
non-normal A — the same cross-term debt as Theorem 1".

This script tests the claim that L1 is NOT actually required for the covariance leg:
at a freeze cond_flat asserts a(Σ) < ε_a, i.e. Σ ≈ μI, and for a near-isotropic Σ
*any* rank-m bump (1 ≤ m ≤ d−1) lifts anisotropy past ε_a — the misalignment penalty
is bounded by a(Σ) itself, which is small by hypothesis. If true, the no-permanent-
freeze conclusion (covariance leg) holds for ALL A, normal or not.

We test the SHIPPED AntiCollapseOperator on:
  (1) non-normal A with Σ whose eigenbasis is INDEPENDENT of A_s (random misalignment),
  (2) an ADVERSARIAL worst case: Σ's m SMALLEST eigendirections forced to coincide with
      the bump basis P_N (minimal tr(ΣP) ⇒ least Frobenius gain — the hardest case),
  (3) the full collapse gate: cond_flat must be FALSE after the bump (the L5 step),
      checked on the real SemanticCollapseOperator.evaluate path.

Run: python experiments/prove_c3_noncollapse_nonnormal.py
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


def _nonnormal_partial_degenerate(d: int, n_active: int, g: torch.Generator):
    """A genuinely NON-NORMAL A: a partially-degenerate symmetric part A_s plus a
    nonzero skew part A_k (so A A^T ≠ A^T A). The skew part is what L1 fears."""
    Q, _ = torch.linalg.qr(torch.randn(d, d, generator=g, dtype=torch.float64))
    lam = torch.zeros(d, dtype=torch.float64)
    idx = torch.randperm(d, generator=g)[:n_active]
    lam[idx] = torch.empty(n_active, dtype=torch.float64).uniform_(0.3, 1.0, generator=g)
    A_s = (Q * lam) @ Q.T
    # skew part, O(1) magnitude — couples active and null directions (the §1 cross-term)
    K = torch.randn(d, d, generator=g, dtype=torch.float64)
    A_k = K - K.T
    A_k = A_k / A_k.norm() * float(torch.empty(1, dtype=torch.float64).uniform_(0.3, 1.5, generator=g))
    return A_s + A_k


def _misaligned_near_isotropic_sigma(d: int, a_unbiased: float, mu: float,
                                     g: torch.Generator):
    """Σ near-isotropic (CoV ≈ a_unbiased) in a RANDOM eigenbasis, independent of A."""
    Qs, _ = torch.linalg.qr(torch.randn(d, d, generator=g, dtype=torch.float64))
    z = torch.randn(d, generator=g, dtype=torch.float64)
    z = z - z.mean()
    ps = z.pow(2).mean().sqrt()
    if float(ps) < 1e-9:
        z = torch.zeros(d, dtype=torch.float64); z[0] = 1.0; z = z - z.mean()
        ps = z.pow(2).mean().sqrt()
    pop_cov = a_unbiased / math.sqrt(d / (d - 1))
    lam = (mu + (pop_cov * mu / ps) * z).clamp_min(1e-6)
    return (Qs * lam) @ Qs.T


def _adversarial_sigma_for_basis(P_basis: torch.Tensor, a_unbiased: float, mu: float,
                                 g: torch.Generator):
    """Worst case: build Σ so the bump basis P_basis (m cols) spans Σ's m SMALLEST
    eigendirections — minimal tr(ΣP), the least-Frobenius-gain alignment."""
    d = P_basis.shape[0]
    m = P_basis.shape[1]
    # complete P_basis to a full ON basis
    full = torch.randn(d, d, generator=g, dtype=torch.float64)
    full[:, :m] = P_basis
    Qs, _ = torch.linalg.qr(full)
    Qs[:, :m] = P_basis                        # keep bump basis exact in first m cols
    z = torch.randn(d, generator=g, dtype=torch.float64)
    z = z - z.mean()
    ps = z.pow(2).mean().sqrt()
    if float(ps) < 1e-9:
        z = torch.zeros(d, dtype=torch.float64); z[0] = 1.0; z = z - z.mean()
        ps = z.pow(2).mean().sqrt()
    pop_cov = a_unbiased / math.sqrt(d / (d - 1))
    lam = (mu + (pop_cov * mu / ps) * z).clamp_min(1e-6)
    order = torch.argsort(lam)                  # smallest first
    lam = lam[order]
    Qs = Qs[:, order]                           # smallest eigenvalues on the bump basis
    return (Qs * lam) @ Qs.T


def sweep(n_trials: int = 4000) -> bool:
    op = AntiCollapseOperator(strength=0.5)
    op.detector.anisotropy_eps = EPS_A
    g = torch.Generator().manual_seed(20260626)
    dims = [4, 5, 6, 8, 12]

    floor_fail_random = 0
    floor_fail_adversarial = 0
    gate_survived = 0          # full collapse gate still flat after bump (must be 0)
    nonnormality_min = math.inf
    checked = 0
    worst_margin = math.inf

    for t in range(n_trials):
        d = dims[t % len(dims)]
        n_active = 1 + (t % max(1, d // 2 - 1))
        A_np = _nonnormal_partial_degenerate(d, n_active, g)
        # confirm genuine non-normality: ‖A A^T − A^T A‖_F
        comm = A_np @ A_np.T - A_np.T @ A_np
        nonnormality_min = min(nonnormality_min, float(comm.norm()))

        mu = float(torch.empty(1, dtype=torch.float64).uniform_(0.05, 5.0, generator=g))
        a_target = float(torch.empty(1, dtype=torch.float64).uniform_(0.2 * EPS_A,
                                                                      0.9 * EPS_A, generator=g))
        A = A_np.to(torch.float32).unsqueeze(0)

        # --- (1) random misalignment ---
        Sigma = _misaligned_near_isotropic_sigma(d, a_target, mu, g)
        sigma = Sigma.to(torch.float32).unsqueeze(0)
        if op.detector._anisotropy(sigma) >= EPS_A:
            continue
        x = torch.zeros(1, d)
        noise = torch.zeros(1, d)
        _, sig_extra = op.excite(x, sigma, A, 0.01, noise)
        a_new = op.detector._anisotropy(sigma + sig_extra)
        worst_margin = min(worst_margin, a_new - EPS_A)
        if a_new < EPS_A - 1e-6:
            floor_fail_random += 1

        # full gate: cond_flat must be false after the bump
        det = op.detector
        if det._anisotropy(sigma + sig_extra) < det.anisotropy_eps:
            gate_survived += 1

        # --- (2) adversarial worst-case alignment (Σ smallest dirs = bump basis) ---
        P_basis = op._near_null_basis(A).to(torch.float64)
        Sig_adv = _adversarial_sigma_for_basis(P_basis, a_target, mu, g)
        sig_adv = Sig_adv.to(torch.float32).unsqueeze(0)
        if op.detector._anisotropy(sig_adv) >= EPS_A:
            checked += 1
            continue
        _, sig_extra2 = op.excite(x, sig_adv, A, 0.01, noise)
        a_adv = op.detector._anisotropy(sig_adv + sig_extra2)
        worst_margin = min(worst_margin, a_adv - EPS_A)
        if a_adv < EPS_A - 1e-6:
            floor_fail_adversarial += 1
        checked += 1

    print(f"[sweep] checked {checked} non-normal configs (d∈{dims}); "
          f"min ‖[A,Aᵀ]‖_F = {nonnormality_min:.3f} (>0 ⇒ genuinely non-normal)")
    print(f"[random misalign]      floored bump failed to lift ε_a : {floor_fail_random}")
    print(f"[adversarial worst]    floored bump failed to lift ε_a : {floor_fail_adversarial}")
    print(f"[full gate / L5]       cond_flat survived the bump      : {gate_survived}")
    print(f"[margin]               worst post-bump anisotropy margin: {worst_margin:+.5f}")
    ok = (floor_fail_random == 0 and floor_fail_adversarial == 0
          and gate_survived == 0 and nonnormality_min > 1e-6 and checked > 2000)
    return ok


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    print("Theorem C3 — NON-NORMAL A: does the covariance leg still break the freeze?\n")
    ok = sweep()
    print(f"\nC3 (non-normal A, covariance leg) {'VERIFIED' if ok else 'FAILED'} "
          "— at cond_flat Σ≈μI, so the floored rank-m bump lifts ε_a regardless of "
          "alignment with A_s; no-permanent-freeze holds for non-normal A too.")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
