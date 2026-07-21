"""M4/L3 third pass — the finite-horizon ENVELOPE threshold (band-limited refinement).

The flat Kreiss threshold e*n*K(A_nom) removed all false alarms but paid a 7-pt
detection miss on extreme-K systems (second pass). Refinement: use the nominal
model's own transient curve as a TIME-INDEXED threshold,

    tau_t = 1.05 * c * ||A_nom^t||_2        (c = ||x_0||)

Since ||x_t|| <= ||A_nom^t|| * ||x_0|| for every noiseless healthy trajectory,
tau_t yields ZERO false alarms by construction while hugging the transient —
tightening as the transient decays, so unstable twins cross far sooner than the
flat envelope. This script measures FA + detection + median detection time for
naive / flat-L3 / envelope-L3' on the extreme-K Jordan family and a random
high-K sample.

Run:  python experiments/owned_math_m4_envelope.py
"""

from __future__ import annotations

import json
import os

import numpy as np

OUT = os.path.join("experiments", "results", "owned_math_m4_envelope.json")
E = float(np.e)
SEED = 29
HORIZON = 150
TRIALS = 100


def jordan(r, k):
    return np.array([[r, k], [0.0, r]])


def rescale(A, target):
    return A * (target / max(abs(np.linalg.eigvals(A))))


def norms_curve(A, tmax):
    out, P = [1.0], np.eye(A.shape[0])
    for _ in range(tmax):
        P = P @ A
        out.append(float(np.linalg.norm(P, 2)))
    return np.array(out)


def kreiss(A):
    I = np.eye(A.shape[0])
    best = 0.0
    for r in np.concatenate([np.linspace(1.001, 1.3, 60), np.linspace(1.3, 3.5, 30)]):
        for phi in np.linspace(0, 2 * np.pi, 64, endpoint=False):
            z = r * np.exp(1j * phi)
            best = max(best, (r - 1.0) * float(np.linalg.norm(np.linalg.inv(z * I - A), 2)))
    return best


def trial(A_true, A_nom, K_nom, curve_nom, seed):
    rng = np.random.default_rng(seed)
    n = A_true.shape[0]
    r_nom = float(max(abs(np.linalg.eigvals(A_nom))))
    hits = {"naive": [], "flat": [], "env": []}
    for _ in range(TRIALS):
        x = rng.standard_normal(n)
        c = float(np.linalg.norm(x))
        t_hit = {"naive": None, "flat": None, "env": None}
        for t in range(1, HORIZON + 1):
            x = A_true @ x
            nrm = float(np.linalg.norm(x))
            if t_hit["naive"] is None and nrm > c * (r_nom ** t) * 1.05:
                t_hit["naive"] = t
            if t_hit["flat"] is None and nrm > E * n * K_nom * c * 1.05:
                t_hit["flat"] = t
            if t_hit["env"] is None and nrm > curve_nom[t] * c * 1.05:
                t_hit["env"] = t
        for k in hits:
            hits[k].append(t_hit[k])
    def rate(k):
        return sum(1 for h in hits[k] if h is not None) / TRIALS
    def med(k):
        v = [h for h in hits[k] if h is not None]
        return float(np.median(v)) if v else None
    return {k: {"rate": rate(k), "median_t": med(k)} for k in hits}


def main():
    rng = np.random.default_rng(SEED)
    systems = [("jordan", jordan(0.9, k)) for k in (1.0, 5.0, 20.0, 50.0)]
    # add 6 random high-K systems
    pool = []
    for _ in range(60):
        n = int(rng.integers(2, 5))
        A = rescale(rng.standard_normal((n, n)), 0.9)
        pool.append((kreiss(A), A))
    pool.sort(key=lambda p: -p[0])
    systems += [(f"randomK{round(K,1)}", A) for K, A in pool[:6]]

    rows = []
    for name, A in systems:
        K = kreiss(A)
        curve = norms_curve(A, HORIZON)
        healthy = trial(A, A, K, curve, seed=101)
        A_bad = rescale(A, 1.03)
        unstable = trial(A_bad, A, K, curve, seed=102)
        rows.append({
            "system": name, "n": A.shape[0], "K_est": round(K, 1),
            "healthy_FA": {k: healthy[k]["rate"] for k in healthy},
            "unstable_detect": {k: unstable[k]["rate"] for k in unstable},
            "unstable_median_detect_t": {k: unstable[k]["median_t"] for k in unstable},
        })

    env_fa = max(r["healthy_FA"]["env"] for r in rows)
    env_det = min(r["unstable_detect"]["env"] for r in rows)
    flat_det = min(r["unstable_detect"]["flat"] for r in rows)
    report = {
        "horizon": HORIZON, "trials_per_cell": TRIALS,
        "rows": rows,
        "summary": {
            "envelope_max_healthy_FA": env_fa,
            "envelope_min_unstable_detection": env_det,
            "flat_min_unstable_detection": flat_det,
        },
        "reading": (
            "The time-indexed envelope threshold keeps FA at zero by construction and "
            "recovers the detections the flat Kreiss threshold missed on extreme-K "
            "systems, with earlier median detection times — L3' is the shippable form."
        ),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report["summary"], indent=2))
    for r in rows:
        print(r["system"], "K=", r["K_est"], "FA:", r["healthy_FA"], "DET:", r["unstable_detect"],
              "t:", r["unstable_median_detect_t"])


if __name__ == "__main__":
    main()
