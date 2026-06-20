"""Machine-check of Lemma L2 (the one-step anisotropy lift) — see
docs/SIGMA0-L2-ANISOTROPY-LIFT-PROOF.md.

L2: for a near-isotropic PSD Σ (population CoV a < ε) and an orthogonal rank-k
projector P aligned with eigenvectors of Σ (1 ≤ k ≤ d-1),
    b ≥ Δ := (ε + a)·μ·d / (√(k(d-k)) - ε·k)   ⟹   anisotropy(Σ + bP) ≥ ε.

Two independent checks:
  (1) SYMBOLIC (sympy, optional): the inequality σ⁺ ≥ ε·μ⁺ from the proof's step (5)
      is equivalent to b ≥ Δ — confirms the closed-form threshold algebra.
  (2) NUMERICAL: adversarial search over random near-isotropic Σ × random aligned
      k-subsets × d, using the ACTUAL SemanticCollapseOperator._anisotropy (torch
      unbiased CoV ≥ population CoV, so the population-proof bound transfers). Asserts
      anisotropy(Σ+ΔP) ≥ ε_a with ZERO counterexamples.

Run: python experiments/prove_l2_anisotropy_lift.py
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import torch  # noqa: E402

from src.cio_sde.collapse import SemanticCollapseOperator  # noqa: E402

EPS_A = 5e-2  # anisotropy_eps, must match collapse.py


def delta_threshold(eps: float, a: float, mu: float, d: int, k: int) -> float:
    """Closed-form sufficient bump magnitude from Lemma L2."""
    denom = math.sqrt(k * (d - k)) - eps * k
    assert denom > 0, f"denominator non-positive: eps={eps} too large for k={k},d={d}"
    return (eps + a) * mu * d / denom


def symbolic_check() -> bool:
    """Confirm σ⁺ ≥ ε·μ⁺  ⟺  b ≥ Δ  (proof step 5) with sympy, if available."""
    try:
        import sympy as sp
    except Exception:
        print("[symbolic] sympy not installed — skipping (numerical check still runs).")
        return True
    b, eps, a, mu, k, d = sp.symbols("b eps a mu k d", positive=True)
    # σ⁺ lower bound (step 3) and μ⁺ (step 4) from the proof:
    sigma_plus_lb = sp.sqrt(k * (d - k)) / d * b - a * mu
    mu_plus = mu + k * b / d
    # The sufficient inequality σ⁺ ≥ ε μ⁺, rearranged, should give b ≥ Δ.
    expr = sp.simplify(sigma_plus_lb - eps * mu_plus)            # ≥ 0  ⟺  a(Σ⁺) ≥ ε
    delta = (eps + a) * mu * d / (sp.sqrt(k * (d - k)) - eps * k)
    # expr ≥ 0  ⟺  b ≥ delta : check expr factors as (coeff>0)·(b - delta)
    coeff = (sp.sqrt(k * (d - k)) - eps * k) / d                  # > 0 under hypothesis
    residual = sp.simplify(expr - coeff * (b - delta))
    ok = residual == 0
    print(f"[symbolic] σ⁺ - ε·μ⁺  ==  ({sp.simplify(coeff)})·(b - Δ)  :  {'CONFIRMED' if ok else 'MISMATCH ' + str(residual)}")
    return ok


def random_near_isotropic(d: int, a_target: float, mu: float, g: torch.Generator):
    """Σ = Q diag(λ) Qᵀ with population CoV(λ) == a_target, λ > 0, random orthonormal Q."""
    # standardized perturbation, scaled to exact population std = a_target*mu
    z = torch.randn(d, generator=g, dtype=torch.float64)
    z = z - z.mean()
    pop_std = z.pow(2).mean().sqrt()
    if float(pop_std) < 1e-9:
        z = torch.zeros(d, dtype=torch.float64); z[0] = 1.0; z = z - z.mean()
        pop_std = z.pow(2).mean().sqrt()
    lam = mu + (a_target * mu / pop_std) * z
    lam = lam.clamp_min(1e-6)
    # random orthonormal basis
    Arand = torch.randn(d, d, generator=g, dtype=torch.float64)
    Q, _ = torch.linalg.qr(Arand)
    Sigma = (Q * lam) @ Q.T
    return Sigma, Q, lam


def numerical_check(n_trials: int = 4000) -> bool:
    op = SemanticCollapseOperator(anisotropy_eps=EPS_A)
    g = torch.Generator().manual_seed(20260619)
    dims = [4, 5, 6, 8, 12, 16]
    worst_margin = math.inf
    counterexamples = 0
    checked = 0
    for t in range(n_trials):
        d = dims[t % len(dims)]
        k = 1 + (t % (d - 1))                       # 1..d-1
        mu = float(torch.empty(1, dtype=torch.float64).uniform_(0.05, 5.0, generator=g))
        a_target = float(torch.empty(1, dtype=torch.float64).uniform_(1e-3, 0.99 * EPS_A, generator=g))
        Sigma, Q, lam = random_near_isotropic(d, a_target, mu, g)

        # population CoV / mean actually realized (the proof's a, μ)
        ev = torch.linalg.eigvalsh(0.5 * (Sigma + Sigma.T))
        a = float((ev - ev.mean()).pow(2).mean().sqrt() / ev.mean())
        mu_real = float(ev.mean())
        if a >= EPS_A:                              # only the near-isotropic hypothesis
            continue
        # aligned rank-k projector: k random eigenvectors of Σ
        perm = torch.randperm(d, generator=g)[:k]
        V = Q[:, perm]
        P = V @ V.T
        b = delta_threshold(EPS_A, a, mu_real, d, k)
        Sigma_plus = Sigma + b * P
        # the ACTUAL implemented anisotropy (unbiased CoV), as float32 like the engine
        aniso_plus = op._anisotropy(Sigma_plus.to(torch.float32))
        margin = aniso_plus - EPS_A
        worst_margin = min(worst_margin, margin)
        checked += 1
        if margin < -1e-6:
            counterexamples += 1
            if counterexamples <= 5:
                print(f"  COUNTEREXAMPLE d={d} k={k} a={a:.4f} mu={mu_real:.3f} "
                      f"b=Δ={b:.4f} aniso+={aniso_plus:.5f} < {EPS_A}")
    print(f"[numerical] checked {checked} near-isotropic cases (d∈{dims}, k=1..d-1); "
          f"counterexamples={counterexamples}; worst (anisoΣ⁺ - ε_a) margin = {worst_margin:+.5f}")
    return counterexamples == 0


def main() -> int:
    try:  # the proof prints σ⁺/ε/μ/Δ; keep Windows cp1252 consoles from crashing
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    print("Lemma L2 — one-step anisotropy lift: machine-check\n")
    sym_ok = symbolic_check()
    num_ok = numerical_check()
    ok = sym_ok and num_ok
    print(f"\nL2 {'VERIFIED' if ok else 'FAILED'} "
          f"(symbolic={'ok' if sym_ok else 'FAIL'}, numerical={'ok' if num_ok else 'FAIL'})")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
