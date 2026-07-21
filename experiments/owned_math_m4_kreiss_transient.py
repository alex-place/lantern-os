"""M4 (L3) first test — non-normal transient growth vs Kreiss-inflated thresholds.

The collapse certificate's Theorem 1 is proven for NORMAL operators; its stated
gap is the non-normal case, where ||A^t|| can grow transiently even though
spectral radius < 1. L3's candidate lemma: inflate canary thresholds by the
Kreiss constant K(A) (Kreiss matrix theorem: sup_t ||A^t|| <= e*n*K(A)) and the
detection guarantee survives non-normality.

This demo measures, on the Jordan-type family A(k) = [[r, k],[0, r]]:
  1. actual max transient amplification M(k) = max_t ||A^t||_2  (spectral bound
     says ||A^t|| <= r^t -> max 1.0 — false for k>0);
  2. an estimate of the Kreiss constant K(A) via resolvent scan;
  3. that the Kreiss-inflated envelope e*n*K(A) upper-bounds M(k) (lemma
     content), while the naive spectral envelope is violated;
  4. detection table: naive threshold false-alarms on healthy non-normal decay,
     the L3-inflated threshold does not, and both still catch true instability
     (r > 1).

Run:  python experiments/owned_math_m4_kreiss_transient.py
"""

from __future__ import annotations

import json
import os

import numpy as np

OUT = os.path.join("experiments", "results", "owned_math_m4_kreiss_transient.json")
E = float(np.e)
N = 2  # matrix dimension


def mat(r: float, k: float) -> np.ndarray:
    return np.array([[r, k], [0.0, r]])


def max_transient(A: np.ndarray, tmax: int = 400) -> tuple[float, int]:
    best, argt, P = 1.0, 0, np.eye(2)
    for t in range(1, tmax + 1):
        P = P @ A
        nrm = float(np.linalg.norm(P, 2))
        if nrm > best:
            best, argt = nrm, t
    return best, argt


def kreiss_constant(A: np.ndarray) -> float:
    """K(A) = sup_{|z|>1} (|z|-1) * ||(zI - A)^-1||_2, estimated on a grid."""
    best = 0.0
    I = np.eye(A.shape[0])
    for radius in np.concatenate([np.linspace(1.0005, 1.5, 260), np.linspace(1.5, 4.0, 120)]):
        for phi in np.linspace(0.0, 2.0 * np.pi, 180, endpoint=False):
            z = radius * np.exp(1j * phi)
            R = np.linalg.inv(z * I - A)
            val = (radius - 1.0) * float(np.linalg.norm(R, 2))
            if val > best:
                best = val
    return best


def detection_trial(A_true: np.ndarray, A_nominal: np.ndarray, kreiss_nominal: float,
                    trials: int = 200, t_horizon: int = 200, seed: int = 7) -> dict:
    """Monitor ||x_t|| of trajectories from A_true, with thresholds set from the
    NOMINAL healthy model (the monitor cannot know the true A — v1 of this demo
    computed K from the monitored matrix itself, so the unstable case inflated
    its own threshold to infinity and could never fire; fixed here).
      naive threshold: c * r_nominal^t   (spectral decay envelope)
      L3 threshold:    e*n*K(A_nominal) * c   (transient-aware envelope)"""
    rng = np.random.default_rng(seed)
    r_nom = float(np.abs(np.linalg.eigvals(A_nominal)).max())
    naive_alarms = 0
    l3_alarms = 0
    for _ in range(trials):
        x = rng.standard_normal(2)
        c = float(np.linalg.norm(x))
        naive_hit = l3_hit = False
        for t in range(1, t_horizon + 1):
            x = A_true @ x
            nrm = float(np.linalg.norm(x))
            if nrm > c * (r_nom ** t) * 1.05:
                naive_hit = True
            if nrm > E * N * kreiss_nominal * c * 1.05:
                l3_hit = True
        naive_alarms += naive_hit
        l3_alarms += l3_hit
    return {"naive_alarm_rate": naive_alarms / trials, "l3_alarm_rate": l3_alarms / trials}


def main():
    rows = []
    for r, k in [(0.9, 0.0), (0.9, 1.0), (0.9, 5.0), (0.9, 20.0), (1.02, 5.0)]:
        A = mat(r, k)
        A_nom = mat(0.9, k)          # monitor's healthy model: same coupling, stable r
        M, argt = max_transient(A)
        K = kreiss_constant(A)
        K_nom = kreiss_constant(A_nom)
        envelope = E * N * K
        det = detection_trial(A, A_nom, K_nom)
        rows.append({
            "r": r, "k": k,
            "spectral_radius": r,
            "max_transient_M": round(M, 2),
            "argmax_t": argt,
            "kreiss_K_est": round(K, 2),
            "kreiss_envelope_e_n_K": round(envelope, 2),
            "lemma_bound_holds (M <= e*n*K)": bool(M <= envelope + 1e-6),
            "naive_spectral_bound_holds (M <= 1)": bool(M <= 1.0 + 1e-6),
            "healthy (r<1)": r < 1.0,
            "naive_alarm_rate": det["naive_alarm_rate"],
            "l3_alarm_rate": det["l3_alarm_rate"],
        })

    report = {
        "family": "A(r,k) = [[r,k],[0,r]] — non-normal for k>0",
        "rows": rows,
        "reading": (
            "For k>0 the naive spectral envelope is violated (transient growth) and "
            "the naive monitor false-alarms on HEALTHY decay; the Kreiss-inflated "
            "envelope e*n*K(A) bounds every healthy transient (lemma content) while "
            "still firing on genuine instability r>1."
        ),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(rows, indent=2))


if __name__ == "__main__":
    main()
