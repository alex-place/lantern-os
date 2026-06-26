"""EXPLORATORY — the contraction half of [#768]: does the spectral (Riesz) dichotomy
close Theorem 1 for non-normal A?

Theorem 1 (collapse onto the manifold) is proven only for normal A, via the orthogonal
split from the symmetric part A_s. For non-normal A the cross-term P_M A P_N ≠ 0 breaks
the energy bound, AND the A_s-null manifold isn't even invariant under the real flow.

Hypothesis: use A's OWN spectral split instead of A_s's. Active M = {Re λ < −δ},
slow/center N = {Re λ ≥ −δ}. The Riesz projector Π_M onto M (along N) is A-invariant, so
Π_M A = A Π_M — the cross-term vanishes BY CONSTRUCTION. Then:
  • active component ‖Π_M x(t)‖ → 0 at rate δ (Lyapunov on the Hurwitz active block),
    after a bounded transient (eigenvector conditioning / Kreiss);
  • the dichotomy: max Re λ(N) ≤ 0 ⇒ collapse onto the center manifold; > 0 ⇒ divergence.

This script falsifies (or supports) the three load-bearing claims on genuinely non-normal
A, and shows the small-gain `alpha` (the shipped collapse_certificate) over-rejects them.

Run: python experiments/explore_nonnormal_contraction.py
"""
from __future__ import annotations
import sys
from pathlib import Path
REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import numpy as np
from scipy.linalg import expm, solve_continuous_lyapunov
import torch

from src.cio_sde.collapse import collapse_certificate


def nonnormal_from_spectrum(real_eigs, complex_pairs, cond_target, seed):
    """A = S Λ S⁻¹, REAL by construction, with the EXACT prescribed spectrum and a
    deliberately ill-conditioned REAL similarity S (so A is genuinely non-normal).

    Λ is real block-diagonal: each real eigenvalue is a 1×1 block; each complex pair
    a±bi is the 2×2 real block [[a, b], [−b, a]]. Conjugating by a real S keeps A real."""
    rng = np.random.default_rng(seed)
    blocks = [np.array([[r]], float) for r in real_eigs]
    blocks += [np.array([[a, b], [-b, a]], float) for (a, b) in complex_pairs]
    Lam = np.zeros((sum(B.shape[0] for B in blocks),) * 2)
    i = 0
    for B in blocks:
        k = B.shape[0]; Lam[i:i + k, i:i + k] = B; i += k
    n = Lam.shape[0]
    # real S with controlled conditioning: U Σ Wᵀ, singular values stretched to cond_target
    U, _, Wt = np.linalg.svd(rng.standard_normal((n, n)))
    Up, _, Wtp = np.linalg.svd(rng.standard_normal((n, n)))
    S = U @ np.diag(np.linspace(1.0, cond_target, n)) @ Wtp
    A = S @ Lam @ np.linalg.inv(S)
    return A, S


def spectral_projector(A, delta):
    """Oblique Riesz projector Π_M onto the active subspace M = {Re λ < −δ}, via
    eigendecomposition (generic diagonalizable A). Real-valued for real A."""
    w, V = np.linalg.eig(A)
    mask = (w.real < -delta).astype(complex)
    Pi = V @ np.diag(mask) @ np.linalg.inv(V)
    return np.real_if_close(Pi, tol=1000).real, w


def active_decay_rate_and_transient(A, Pi_M, delta):
    """Certified active-block decay rate and Euclidean transient bound.

    On range(Π_M), A is Hurwitz with abscissa ≤ −δ. Solve the reduced Lyapunov eq on an
    orthonormal basis Bᵀ A B of the active subspace; √cond(P) bounds the transient."""
    # orthonormal basis of range(Π_M)
    U, s, _ = np.linalg.svd(Pi_M)
    r = int((s > 1e-9).sum())
    if r == 0:
        return 0.0, 1.0
    B = U[:, :r]
    A_M = B.T @ A @ B                       # active block in an ON basis of M
    rate = -float(np.linalg.eigvals(A_M).real.max())
    try:
        P = solve_continuous_lyapunov(A_M.T, -np.eye(r))
        pe = np.linalg.eigvalsh(0.5 * (P + P.T))
        transient = float(np.sqrt(pe.max() / pe.min())) if pe.min() > 0 else float("inf")
    except Exception:
        transient = float("inf")
    return rate, transient


def run_case(name, real_eigs, complex_pairs, cond_target, delta=0.05, seed=0, T=40.0, dt=0.05):
    A, S = nonnormal_from_spectrum(real_eigs, complex_pairs, cond_target, seed)
    n = A.shape[0]
    nonnormality = float(np.linalg.norm(A @ A.T - A.T @ A))
    Pi_M, w = spectral_projector(A, delta)
    Pi_N = np.eye(n) - Pi_M

    commutator = float(np.linalg.norm(Pi_M @ A - A @ Pi_M))     # claim (a): ≈ 0
    rate, transient = active_decay_rate_and_transient(A, Pi_M, delta)

    rng = np.random.default_rng(seed + 99)
    x0 = rng.standard_normal(n)
    xa0, xn0 = Pi_M @ x0, Pi_N @ x0            # invariant components: evolve each cleanly
    ts = np.arange(0, T, dt)
    act, slow, full = [], [], []
    for t in ts:
        E = expm(A * t)
        act.append(np.linalg.norm(E @ xa0))    # active-only propagation (no slow contamination)
        slow.append(np.linalg.norm(E @ xn0))   # slow-only propagation
        full.append(np.linalg.norm(E @ x0))
    act, slow, full = map(np.array, (act, slow, full))

    # claim (b): the active component ALWAYS contracts — regardless of the slow fate
    act_contracted = act[-1] < 1e-6 * max(act[0], act.max())
    peak_amp = float(act.max() / act[0])       # observed transient overshoot
    # claim (c): the FATE is decided purely by the slow block's spectrum
    slow_max_re = float(w.real.max())
    diverged = slow[-1] > 1e3 * slow[0]
    fate = "DIVERGE" if diverged else "COLLAPSE-onto-N"

    cert = collapse_certificate(torch.tensor(A, dtype=torch.float32).unsqueeze(0))

    print(f"\n=== {name} ===")
    print(f"  spectrum Re λ: {np.round(np.sort(w.real), 3)}   ‖[A,Aᵀ]‖={nonnormality:.2f}  cond(V)≈{cond_target}")
    print(f"  (a) ‖Π_M A − A Π_M‖ = {commutator:.2e}   (cross-term in spectral split → 0?)")
    print(f"  (b) active ‖Π_M x‖: {act[0]:.3f} → peak {act.max():.3f} → {act[-1]:.2e}  "
          f"contracted={act_contracted} (rate δ≈{rate:.3f}; obs. overshoot {peak_amp:.2f}× ≤ certified {transient:.2f}×)")
    print(f"  (c) slow ‖Π_N x‖: {slow[0]:.3f} → {slow[-1]:.2e}   max Reλ(full)={slow_max_re:+.3f}  ⇒ {fate}")
    print(f"  shipped collapse_certificate: small-gain α={cert.alpha:+.3f} guaranteed={cert.guaranteed}  "
          f"| full-spectrum maxReλ={cert.spectral_abscissa:+.3f} contracting={cert.full_contracting}")
    return commutator, act_contracted, fate


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    print("Spectral-dichotomy exploration for the non-normal contraction half of #768")

    results = []
    # 1) non-normal, stable active modes + a marginal center pair (Re λ = 0): COLLAPSE
    results.append(run_case("non-normal: stable active + center pair (→collapse)",
                            real_eigs=[-0.8, -1.2, -2.0, -0.6], complex_pairs=[(0.0, 1.5)],
                            cond_target=30.0, seed=1))
    # 2) strongly non-normal, ALL active strictly stable but huge transient: COLLAPSE to 0
    results.append(run_case("strongly non-normal: all stable, big transient (→collapse)",
                            real_eigs=[-0.5, -0.6, -0.7, -0.8, -0.9, -1.0], complex_pairs=[],
                            cond_target=200.0, seed=2))
    # 3) non-normal with ONE right-half-plane mode: DIVERGE (active part still decays)
    results.append(run_case("non-normal: one RHP mode (→diverge)",
                            real_eigs=[-0.8, -1.2, -2.0, -0.6, -1.5, 0.3], complex_pairs=[],
                            cond_target=30.0, seed=3))

    commutators = [r[0] for r in results]
    print("\n--- verdict ---")
    print(f"max ‖Π_M A − A Π_M‖ across cases: {max(commutators):.2e}  "
          f"({'cross-term vanishes — spectral split is A-invariant' if max(commutators) < 1e-6 else 'NONZERO — claim (a) FALSE'})")
    print("dichotomy fates:", [r[2] for r in results])


if __name__ == "__main__":
    main()
