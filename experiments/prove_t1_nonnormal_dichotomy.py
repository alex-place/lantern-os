"""Machine-check — the contraction half of [#768]: Theorem 1's spectral-dichotomy
extension to NON-NORMAL A.

Theorem 1 (collapse onto the manifold) was proven only for normal A, via the orthogonal
A_s split, which fails for non-normal A (the §1 cross-term P_M A P_N ≠ 0). The fix is to
split by A's OWN spectrum (the oblique Riesz projector), which is A-invariant, so the
cross-term is identically zero. This script verifies, over a random ensemble of genuinely
non-normal A, the three claims that constitute the dichotomy:

  (a) INVARIANCE — Π_M (Riesz projector onto {Re λ < −δ}) commutes with A: ‖Π_M A−A Π_M‖≈0.
  (b) ACTIVE DECAY (bounded transient) — ‖e^{tA} Π_M x‖ ≤ √cond(P_M)·e^{−δ_M t}·‖Π_M x‖ for
      all sampled t, where δ_M = −max Re λ(A_M) ≥ δ and P_M solves the reduced Lyapunov eq.
      The active modes ALWAYS die, at the certified rate, within the certified overshoot —
      regardless of what the slow block does.
  (c) DICHOTOMY (no third fate) — the long-time fate of ‖e^{tA} x‖ is decided purely by
      β = max Re λ(N): β < −tol ⇒ full decay; |β| ≤ tol ⇒ bounded (collapse onto center);
      β > tol ⇒ divergence. In every trial the active part decays AND the observed fate
      matches the sign of β — there is no run where the system neither collapses nor
      diverges-while-the-active-part-persists.

Run: python experiments/prove_t1_nonnormal_dichotomy.py
"""
from __future__ import annotations
import sys
from pathlib import Path
REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import numpy as np
from scipy.linalg import expm, solve_continuous_lyapunov

DELTA = 0.25          # split threshold: active = {Re λ < −δ}, slow = {Re λ ≥ −δ}
GAP = 0.1             # keep the spectrum clear of the split line so Π_M stays well-conditioned
TOL_COMMUTE = 1e-8
TOL_FATE = 1e-3


def random_nonnormal(n, rng):
    """Real non-normal A with a random spectrum (real eigenvalues + complex pairs), no
    eigenvalue within GAP of the split line −δ, conjugated by an ill-conditioned real S."""
    re_parts = []
    blocks = []
    k = 0
    while k < n:
        # draw a real part avoiding the [−δ−GAP, −δ+GAP] band
        r = rng.uniform(-3.0, 1.0)
        if abs(r + DELTA) < GAP:
            continue
        if k <= n - 2 and rng.random() < 0.5:
            w = rng.uniform(0.3, 2.0)            # complex pair r ± wi
            blocks.append(np.array([[r, w], [-w, r]], float)); re_parts += [r, r]; k += 2
        else:
            blocks.append(np.array([[r]], float)); re_parts.append(r); k += 1
    Lam = np.zeros((n, n)); i = 0
    for B in blocks:
        b = B.shape[0]; Lam[i:i + b, i:i + b] = B; i += b
    cond = rng.uniform(5.0, 300.0)
    U, _, _ = np.linalg.svd(rng.standard_normal((n, n)))
    _, _, Wt = np.linalg.svd(rng.standard_normal((n, n)))
    S = U @ np.diag(np.linspace(1.0, cond, n)) @ Wt
    return S @ Lam @ np.linalg.inv(S), np.array(re_parts)


def riesz_projector(A, delta):
    w, V = np.linalg.eig(A)
    Pi = V @ np.diag((w.real < -delta).astype(complex)) @ np.linalg.inv(V)
    return Pi.real, w


def reduced_lyapunov(A, Pi_M):
    U, s, _ = np.linalg.svd(Pi_M)
    r = int((s > 1e-9).sum())
    if r == 0:
        return None, 0.0, 1.0
    B = U[:, :r]
    A_M = B.T @ A @ B
    rate = -float(np.linalg.eigvals(A_M).real.max())
    try:
        P = solve_continuous_lyapunov(A_M.T, -np.eye(r))
        pe = np.linalg.eigvalsh(0.5 * (P + P.T))
        transient = float(np.sqrt(pe.max() / pe.min())) if pe.min() > 0 else float("inf")
    except Exception:
        transient = float("inf")
    return B, rate, transient


def sweep(n_trials=600):
    rng = np.random.default_rng(20260626)
    dims = [4, 5, 6, 8]
    ts = np.array([0.5, 1, 2, 4, 8, 16, 32.0])

    commute_fail = invariance_checked = 0
    transient_violations = 0
    fate_mismatch = 0
    active_not_decayed = 0
    checked = 0
    worst_commute = 0.0
    worst_transient_ratio = 0.0

    for t in range(n_trials):
        n = dims[t % len(dims)]
        A, re_parts = random_nonnormal(n, rng)
        Pi_M, w = riesz_projector(A, DELTA)
        Pi_N = np.eye(n) - Pi_M

        # (a) invariance: Π_M commutes with A
        comm = float(np.linalg.norm(Pi_M @ A - A @ Pi_M))
        worst_commute = max(worst_commute, comm)
        invariance_checked += 1
        if comm > TOL_COMMUTE:
            commute_fail += 1

        B, rate, transient = reduced_lyapunov(A, Pi_M)
        x0 = rng.standard_normal(n)
        xa0 = Pi_M @ x0

        # (b) active decay within the certified transient envelope √cond(P_M)·e^{−δ_M t}
        a0 = np.linalg.norm(xa0)
        if a0 > 1e-9 and B is not None:
            for tt in ts:
                at = np.linalg.norm(expm(A * tt) @ xa0)
                bound = transient * np.exp(-rate * tt) * a0
                if at > bound * (1 + 1e-6):
                    transient_violations += 1
                worst_transient_ratio = max(worst_transient_ratio, at / (bound + 1e-300))
            a_final = np.linalg.norm(expm(A * 60.0) @ xa0)
            if a_final > 1e-4 * a0:           # active modes must die (rate>0 ⇒ decay)
                active_not_decayed += 1

        # (c) dichotomy: fate from β = max Re λ(N), verified against the real flow
        beta = float(w.real.max())            # slow block dominates the long-time fate
        xn0 = Pi_N @ x0
        n_final = np.linalg.norm(expm(A * 80.0) @ xn0) if np.linalg.norm(xn0) > 1e-9 else 0.0
        n_init = np.linalg.norm(xn0)
        if beta > TOL_FATE:
            observed = "diverge" if n_final > 1e3 * max(n_init, 1e-9) else "other"
        elif beta < -TOL_FATE:
            observed = "decay" if n_final < 1e-2 * max(n_init, 1e-9) else "other"
        else:
            observed = "bounded" if (1e-3 < n_final / max(n_init, 1e-9) < 1e3) else "other"
        if observed == "other":
            fate_mismatch += 1
        checked += 1

    print(f"[sweep] checked {checked} random non-normal A (d∈{dims}, δ={DELTA})")
    print(f"(a) invariance    Π_M A = A Π_M failures : {commute_fail}/{invariance_checked}  "
          f"(worst ‖[Π_M,A]‖ = {worst_commute:.2e})")
    print(f"(b) active decay  certified-envelope violations : {transient_violations}  | "
          f"active-not-decayed : {active_not_decayed}  (worst obs/bound ratio {worst_transient_ratio:.3f})")
    print(f"(c) dichotomy     fate ≠ sign(β) mismatches : {fate_mismatch}  (no third fate ⇒ 0)")
    ok = (commute_fail == 0 and transient_violations == 0 and active_not_decayed == 0
          and fate_mismatch == 0 and checked > 400 and worst_transient_ratio <= 1.0 + 1e-6)
    return ok


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    print("Theorem 1 — non-normal spectral-dichotomy machine-check (#768 contraction half)\n")
    ok = sweep()
    print(f"\nT1 NON-NORMAL DICHOTOMY {'VERIFIED' if ok else 'FAILED'} — in A's own spectral "
          "split the cross-term vanishes; active modes decay at the certified rate within the "
          "certified transient; the fate is exactly sign(max Reλ on the slow block). No third fate.")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
