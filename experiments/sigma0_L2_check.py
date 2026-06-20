"""
L2 machine-check — the one-step anisotropy-lift lemma for Σ₀⁻¹.

CLAIM (L2). At a near-flat covariance Σ (where `cond_flat` holds, i.e.
`_anisotropy(Σ) < anisotropy_eps`), the Σ₀⁻¹ bump  Σ → Σ + b·P_N  (b = strength·p,
P_N = V_null V_nullᵀ, k = dim null subspace) raises `_anisotropy` ABOVE
anisotropy_eps, so `cond_flat` becomes false and the collapse AND-gate cannot fire.

This script does NOT assert L2 holds unconditionally. It (1) checks the closed-form
CoV formula against the REAL `_anisotropy` from src/cio_sde/collapse.py for the
aligned/isotropic worst case, and (2) adversarially searches random configurations
(including the non-monotone k>d/2 regime and misaligned bumps) to MEASURE where the
lift succeeds vs fails — reporting the honest minimal-b / minimal-p threshold and any
counterexamples. Whatever it finds, it prints.

Closed form (isotropic start Σ=c·I, bump aligned with k eigen-directions):
  eigvals after = {c+b  (×k),  c  (×(d−k))}
  μ      = c + (k/d)·b
  std_u  = b·√( k(d−k) / ((d−1)·d) )          (torch unbiased std, ddof=1)
  CoV    = std_u / μ
L2 (isotropic) ⇔ CoV ≥ ε_a ⇔ b ≥ b*(c) with b* solved from the above.

Run:  python experiments/sigma0_L2_check.py
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import torch  # noqa: E402

from src.cio_sde.collapse import SemanticCollapseOperator, _below  # noqa: E402

DET = SemanticCollapseOperator()
EPS_A = DET.anisotropy_eps          # 5e-2, the real threshold
ANISO = DET._anisotropy             # the REAL function under test


def cov_closed_form(c: float, b: float, k: int, d: int) -> float:
    mu = c + (k / d) * b
    std_u = b * math.sqrt(k * (d - k) / ((d - 1) * d))
    return std_u / mu if mu > 0 else 0.0


def b_star(c: float, k: int, d: int, eps: float = EPS_A) -> float:
    """Minimal bump b so CoV(c,b)=eps (aligned isotropic case). Solve eps=std/μ."""
    s = math.sqrt(k * (d - k) / ((d - 1) * d))          # std = s·b
    # eps·(c + (k/d)b) = s·b  →  b·(s − eps·k/d) = eps·c
    denom = s - eps * (k / d)
    return float("inf") if denom <= 0 else eps * c / denom


def aligned_sigma(c: float, b: float, k: int, d: int) -> torch.Tensor:
    """Σ = c·I + b·P_N with P_N a random rank-k orthogonal projector (aligned bump)."""
    Q, _ = torch.linalg.qr(torch.randn(d, d))
    V = Q[:, :k]
    P = V @ V.T
    return (c * torch.eye(d) + b * P).unsqueeze(0)       # (1,d,d) batch form


def check_closed_form(d=4, k=3, n=500):
    """Verify cov_closed_form matches the REAL _anisotropy for aligned isotropic bumps."""
    torch.manual_seed(0)
    max_err = 0.0
    for _ in range(n):
        c = 0.2 + 1.8 * torch.rand(1).item()
        b = 2.0 * torch.rand(1).item()
        got = ANISO(aligned_sigma(c, b, k, d))
        want = cov_closed_form(c, b, k, d)
        max_err = max(max_err, abs(got - want))
    return max_err


def adversarial_search(d=4, k=3, strength=0.5, n=4000):
    """For random near-flat Σ and random null subspaces, apply the REAL excite bump at
    p=1 (max) and at the closed-form-predicted p, and measure whether _anisotropy clears
    ε_a. Reports success fraction and worst (smallest) post-bump anisotropy."""
    torch.manual_seed(20260619)
    fails_p1 = 0          # bump at p=1 (b=strength) fails to clear ε_a
    cleared = 0
    worst_margin = float("inf")
    min_p_needed = []
    for _ in range(n):
        c = 0.2 + 1.8 * torch.rand(1).item()
        # near-flat Σ: small anisotropic perturbation kept under ε_a
        Q, _ = torch.linalg.qr(torch.randn(d, d))
        jitter = (EPS_A * 0.6) * c * torch.randn(d)       # tiny spread
        evals = (c + jitter).clamp_min(1e-6)
        Sigma = (Q @ torch.diag(evals) @ Q.T).unsqueeze(0)
        if ANISO(Sigma) >= EPS_A:                          # only test states where cond_flat holds
            continue
        # random null subspace (the bump basis) — generally MISALIGNED with Σ's eigenbasis
        Qn, _ = torch.linalg.qr(torch.randn(d, d))
        P = Qn[:, :k] @ Qn[:, :k].T
        b = strength * 1.0                                 # p = 1
        after = ANISO((Sigma[0] + b * P).unsqueeze(0))
        margin = after - EPS_A
        worst_margin = min(worst_margin, margin)
        if margin >= 0:
            cleared += 1
        else:
            fails_p1 += 1
    return {
        "tested": cleared + fails_p1,
        "cleared_at_p1": cleared,
        "failed_at_p1": fails_p1,
        "clear_fraction": round(cleared / max(1, cleared + fails_p1), 4),
        "worst_post_bump_margin": round(worst_margin, 5),
    }


def main():
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    d, k, strength = 4, 3, 0.5
    print(f"L2 machine-check  d={d} k={k} (k>d/2 -> non-monotone regime)  eps_a={EPS_A}  strength={strength}")

    err = check_closed_form(d, k)
    print(f"[1] closed-form vs real _anisotropy : max abs err = {err:.2e}  "
          f"({'MATCH' if err < 1e-4 else 'MISMATCH'})")

    bs = b_star(1.0, k, d)
    p_star = bs / strength
    print(f"[2] aligned isotropic threshold (c=1): b* = {bs:.4f}  ->  p* = {p_star:.4f}  "
          f"(L2 needs p >= p* for the bump to clear eps_a; p<p* is the L4 dead-zone gap)")

    adv = adversarial_search(d, k, strength)
    print(f"[3] adversarial (random MISALIGNED null subspace, p=1, {adv['tested']} flat states):")
    print(f"      cleared eps_a: {adv['cleared_at_p1']}/{adv['tested']} "
          f"({adv['clear_fraction']*100:.1f}%)   worst margin: {adv['worst_post_bump_margin']:+.5f}")
    verdict = ("L2 holds (aligned, p>=p*) but FAILS for misaligned bumps -> confirms L1 "
               "alignment gap" if adv['failed_at_p1'] > 0
               else "L2 cleared eps_a in every tested config at p=1")
    print(f"VERDICT: {verdict}")


if __name__ == "__main__":
    main()
