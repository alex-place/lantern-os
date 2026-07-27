"""M4/L3 Kreiss-inflated canary thresholds -- RANDOM NON-NORMAL ENSEMBLE check (#2789).

The M4 conjecture (L3): inflating a canary threshold by the Kreiss constant of the
NOMINAL healthy model makes detection survive non-normal transient growth, closing
the collapse certificate's normal-operators-only gap. The existing probe
(owned_math_m4_kreiss_transient.py) shows this on ONE 2x2 Jordan block (77x
transient, naive 100% false-alarm vs L3 0%). This is the machine-check at scale:
verify the Kreiss bound holds across a random ensemble of non-normal operators, and
that the detection protocol separates healthy decay from true instability.

Facts used
----------
Kreiss constant  K(A) = sup_{|z|>1} (|z|-1) ||(zI-A)^{-1}||   (computed on a
resolvent grid over the exterior of the unit disc). Kreiss Matrix Theorem with
Spijker's sharp constant:  K(A) <= sup_t ||A^t|| <= e*n*K(A),  n = dim A.

- NAIVE spectral envelope assumes ||A^t|| <= rho(A)^t (true only for normal A);
  a non-normal transient VIOLATES it -> false alarm on healthy decay.
- L3 / Kreiss threshold  B = e*n*K(A)  bounds the whole transient -> no false
  alarm on healthy decay, while true instability (rho>1) grows past any fixed B.

Ensemble: A = Q (Lambda + s*N) Q^{-1}, Lambda diagonal (spectral radius set by
`rho`), N strictly-upper-triangular nilpotent (the non-normality), Q random
well-conditioned. Healthy rho<1, unstable rho>1.

Honest scope: synthetic operators, not the real Ouro loop Jacobians (that is
issue item (2), GPU/E2-gated). This validates the LEMMA's envelope + the
detection protocol at ensemble scale; it does not measure the deployed loop.

Run:  python experiments/owned_math_m4_kreiss_ensemble.py
"""

from __future__ import annotations

import json
import os

import numpy as np

OUT = os.path.join("experiments", "results", "owned_math_m4_kreiss_ensemble.json")

N = 6            # operator dimension
T = 200          # transient horizon (steps)
N_HEALTHY = 200  # healthy (rho<1) samples
N_UNSTABLE = 50  # unstable (rho>1) samples
E = float(np.e)


def _sample_A(rng, rho, nonnormality):
    """A = Q (Lambda + s N) Q^{-1}: eigenvalues on a circle of radius `rho`,
    N a strict-upper nilpotent scaled by `nonnormality`, Q well-conditioned."""
    angles = rng.uniform(0, 2 * np.pi, N)
    lam = rho * np.exp(1j * angles)
    M = np.diag(lam).astype(complex)
    # strict-upper nilpotent -> non-normal transient
    Nil = np.triu(rng.standard_normal((N, N)) + 1j * rng.standard_normal((N, N)), 1)
    M = M + nonnormality * Nil
    # well-conditioned similarity (keep Q from inflating the answer artificially)
    Q = rng.standard_normal((N, N)) + 1j * rng.standard_normal((N, N))
    Q = Q + N * np.eye(N)  # diagonally dominant -> modest condition number
    A = Q @ M @ np.linalg.inv(Q)
    return A


def _transient(A):
    """max_{0<=t<=T} ||A^t||_2 and the full power-norm curve."""
    P = np.eye(A.shape[0], dtype=complex)
    norms = np.empty(T + 1)
    for t in range(T + 1):
        norms[t] = np.linalg.norm(P, 2)
        P = P @ A
    return float(norms.max()), norms


def _kreiss(A, r_max=3.0, nr=60, nth=120):
    """K(A) = sup_{|z|>1} (|z|-1) ||(zI-A)^{-1}||_2 on a resolvent grid."""
    n = A.shape[0]
    I = np.eye(n, dtype=complex)
    rs = np.linspace(1.0001, r_max, nr)
    ths = np.linspace(0, 2 * np.pi, nth, endpoint=False)
    K = 0.0
    for r in rs:
        for th in ths:
            z = r * np.exp(1j * th)
            resolvent_norm = 1.0 / np.linalg.svd(z * I - A, compute_uv=False)[-1]
            K = max(K, (r - 1.0) * resolvent_norm)
    return float(K)


def main(argv=None):
    rng = np.random.default_rng(0)

    healthy = []
    kreiss_violations = 0     # times sup_t||A^t|| exceeds e*n*K  (must be 0)
    naive_false_alarms = 0    # times a healthy transient exceeds rho^t envelope
    max_amp = 0.0
    for i in range(N_HEALTHY):
        rho = rng.uniform(0.80, 0.98)
        A = _sample_A(rng, rho, nonnormality=rng.uniform(0.5, 2.5))
        sup_norm, norms = _transient(A)
        K = _kreiss(A)
        bound = E * N * K
        rho_actual = max(abs(np.linalg.eigvals(A)))
        naive_env = rho_actual ** np.arange(T + 1)
        # a "false alarm" = transient pokes above the naive spectral envelope
        # (times a small tolerance) at any t -> a naive threshold would fire.
        naive_fire = bool(np.any(norms > 1.05 * np.maximum(naive_env, 1e-12)))
        kreiss_ok = sup_norm <= bound * (1 + 1e-6)
        naive_false_alarms += int(naive_fire)
        kreiss_violations += int(not kreiss_ok)
        max_amp = max(max_amp, sup_norm)
        if i < 5:
            healthy.append({"rho": round(rho_actual, 4), "sup_norm": round(sup_norm, 3),
                            "kreiss_bound_enK": round(bound, 3), "kreiss_ok": kreiss_ok,
                            "naive_would_fire": naive_fire})

    # Unstable set: rho>1 -> the transient grows unboundedly; a fixed healthy-model
    # Kreiss threshold is eventually exceeded (detection preserved).
    unstable_detected = 0
    for _ in range(N_UNSTABLE):
        rho = rng.uniform(1.01, 1.05)
        A = _sample_A(rng, rho, nonnormality=rng.uniform(0.5, 2.5))
        sup_norm, _ = _transient(A)
        # reference healthy Kreiss threshold (nominal model rho~0.95, same n)
        Aref = _sample_A(np.random.default_rng(999), 0.95, 1.5)
        thr = E * N * _kreiss(Aref)
        unstable_detected += int(sup_norm > thr)

    result = {
        "params": {"n": N, "T": T, "n_healthy": N_HEALTHY, "n_unstable": N_UNSTABLE},
        "kreiss_bound_violations_healthy": kreiss_violations,
        "naive_spectral_false_alarms_healthy": naive_false_alarms,
        "naive_false_alarm_rate": round(naive_false_alarms / N_HEALTHY, 4),
        "kreiss_false_alarm_rate": round(kreiss_violations / N_HEALTHY, 4),
        "max_transient_amplification": round(max_amp, 2),
        "unstable_detected": unstable_detected,
        "unstable_detection_rate": round(unstable_detected / N_UNSTABLE, 4),
        "healthy_examples": healthy,
        "verdict": _verdict(kreiss_violations, naive_false_alarms, N_HEALTHY,
                            unstable_detected, N_UNSTABLE, max_amp),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    print("[m4-kreiss] ensemble n=%d, T=%d, %d healthy + %d unstable" % (N, T, N_HEALTHY, N_UNSTABLE))
    print("[m4-kreiss] max transient amplification (healthy, non-normal): %.1fx" % max_amp)
    print("[m4-kreiss] NAIVE spectral envelope false alarms on healthy decay: %d/%d (%.0f%%)"
          % (naive_false_alarms, N_HEALTHY, 100.0 * naive_false_alarms / N_HEALTHY))
    print("[m4-kreiss] KREISS bound e*n*K violations on healthy decay:       %d/%d (%.0f%%)"
          % (kreiss_violations, N_HEALTHY, 100.0 * kreiss_violations / N_HEALTHY))
    print("[m4-kreiss] unstable (rho>1) detected by healthy-model Kreiss threshold: %d/%d"
          % (unstable_detected, N_UNSTABLE))
    print("[m4-kreiss] verdict: %s" % result["verdict"])
    print("[m4-kreiss] wrote %s" % OUT)
    return 0


def _verdict(kv, nfa, nh, ud, nu, max_amp):
    if kv == 0 and nfa >= 0.5 * nh and ud >= 0.9 * nu:
        return ("L3 HOLDS at ensemble scale: across %d random non-normal operators the Kreiss "
                "bound e*n*K(A) is NEVER violated (0 false alarms) despite transients up to %.0fx, "
                "while the naive spectral envelope false-alarms on %.0f%% of healthy decays; true "
                "instability (rho>1) is caught %d/%d by a fixed healthy-model Kreiss threshold. "
                "The nominal-model Kreiss inflation closes the non-normal gap without sacrificing "
                "detection -- reproducing the single-case 77x/100%%-vs-0%% finding at scale."
                % (nh, max_amp, 100.0 * nfa / nh, ud, nu))
    if kv > 0:
        return ("KILL-ish: the Kreiss bound was violated %d/%d times -- either the resolvent grid "
                "under-resolved K(A) (raise nr/nth/r_max) or the similarity Q is ill-conditioned "
                "(the bound is for the operator norm, and a bad Q inflates the transient beyond "
                "what K sees); investigate before claiming the envelope holds." % (kv, nh))
    return ("INCONCLUSIVE: Kreiss bound never violated, but the naive envelope false-alarm rate "
            "(%.0f%%) or unstable detection (%d/%d) is lower than expected -- widen the "
            "non-normality range or the horizon T." % (100.0 * nfa / nh, ud, nu))


if __name__ == "__main__":
    raise SystemExit(main())
