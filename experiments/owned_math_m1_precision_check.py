"""M1 second pass — machine-check the No-Free-Confidence decomposition + ledger test.

Lemma (linear-Gaussian form, checked here numerically over random systems):
With information-filter updates, the justified-confidence proxy J = logdet(precision)
decomposes EXACTLY per step as

    dJ = evidence_term + dynamics_term
    evidence_term = logdet(L_pred + sum H'R^-1 H) - logdet(L_pred)  >= 0   (paid growth)
    dynamics_term = logdet(L_pred) - logdet(L_prev) <= 2*log(1/|det A|)    (contraction cap)

i.e. ALL internal confidence growth is either PAID (measurement/evidence) or is
contraction-driven — bounded by the log-volume contraction of the dynamics, which is
exactly the collapse-suspect mode the canaries watch (ties M1 to M3). "Free"
confidence beyond those two channels cannot exist in this model class.

Part B: longitudinal ledger test — same-hypothesis consecutive records whose
confidence ROSE while the evidence set did not grow = candidate violations of
paid-growth in the product ledger.

Run:  python experiments/owned_math_m1_precision_check.py
"""

from __future__ import annotations

import json
import os
from collections import defaultdict

import numpy as np

OUT = os.path.join("experiments", "results", "owned_math_m1_precision_check.json")
RECORDS = [
    os.path.join("data", "convergence", "records.jsonl"),
    r"C:\dev\lantern-os\data\convergence\records.jsonl",
]


def part_a(trials: int = 300, steps: int = 30, seed: int = 11) -> dict:
    rng = np.random.default_rng(seed)
    viol_evidence = 0      # evidence_term < 0
    viol_monotone = 0      # eigmin(L_post - L_pred) < 0
    viol_capbound = 0      # dynamics_term > 2*log(1/|detA|) (requires Q PSD)
    viol_decomp = 0        # dJ != evidence + dynamics (exactness)
    n_steps = 0
    dyn_pos_share_contracting = 0
    n_contracting = 0

    for _ in range(trials):
        n = int(rng.integers(2, 6))
        A = rng.standard_normal((n, n))
        sr = max(abs(np.linalg.eigvals(A)))
        A *= rng.uniform(0.5, 1.1) / sr          # mix of contracting & near-unit
        Qh = rng.standard_normal((n, n)) * 0.3
        Q = Qh @ Qh.T + 1e-6 * np.eye(n)
        m = int(rng.integers(0, 3))              # 0..2 measurements per step
        Sigma = np.eye(n)
        for _ in range(steps):
            L_prev = np.linalg.inv(Sigma)
            Sigma_pred = A @ Sigma @ A.T + Q
            L_pred = np.linalg.inv(Sigma_pred)
            L_post = L_pred.copy()
            for _k in range(m):
                H = rng.standard_normal((1, n))
                R = np.array([[rng.uniform(0.1, 2.0)]])
                L_post = L_post + H.T @ np.linalg.inv(R) @ H
            sJprev = np.linalg.slogdet(L_prev)[1]
            sJpred = np.linalg.slogdet(L_pred)[1]
            sJpost = np.linalg.slogdet(L_post)[1]
            evidence_term = sJpost - sJpred
            dynamics_term = sJpred - sJprev
            dJ = sJpost - sJprev
            cap = 2.0 * np.log(1.0 / abs(np.linalg.det(A)))
            n_steps += 1
            if evidence_term < -1e-9:
                viol_evidence += 1
            if np.linalg.eigvalsh(L_post - L_pred).min() < -1e-9:
                viol_monotone += 1
            if dynamics_term > cap + 1e-9:
                viol_capbound += 1
            if abs(dJ - (evidence_term + dynamics_term)) > 1e-9:
                viol_decomp += 1
            if abs(np.linalg.det(A)) < 1.0:
                n_contracting += 1
                if dynamics_term > 0:
                    dyn_pos_share_contracting += 1
            Sigma = np.linalg.inv(L_post)

    return {
        "n_systems": trials,
        "n_steps_checked": n_steps,
        "violations_evidence_term_negative": viol_evidence,
        "violations_precision_monotone": viol_monotone,
        "violations_contraction_cap (dyn > 2log 1/|detA|)": viol_capbound,
        "violations_exact_decomposition": viol_decomp,
        "contracting_steps": n_contracting,
        "contracting_steps_with_positive_dynamics_term": dyn_pos_share_contracting,
        "reading": (
            "0 violations expected on the first four rows = the lemma's inequalities "
            "hold numerically; positive dynamics terms occur ONLY via contraction — "
            "the collapse-suspect channel, never a third source."
        ),
    }


def part_b() -> dict:
    path = next((p for p in RECORDS if os.path.exists(p)), None)
    if not path:
        return {"error": "records.jsonl not found"}
    groups = defaultdict(list)
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            key = str(r.get("hypothesis") or r.get("claim") or "").strip().lower()
            if not key or key == "model interaction":   # generic chat heartbeats excluded
                continue
            ev = r.get("evidence_ids") or r.get("evidence") or r.get("sources") or []
            ev = frozenset(map(str, ev)) if isinstance(ev, list) else frozenset()
            groups[key].append((str(r.get("timestamp", "")), float(r.get("confidence") or 0.0),
                                ev, str(r.get("id", ""))))

    multi = {k: sorted(v) for k, v in groups.items() if len(v) >= 2}
    violations = []
    n_pairs = 0
    for key, recs in multi.items():
        for (t0, c0, e0, id0), (t1, c1, e1, id1) in zip(recs, recs[1:]):
            n_pairs += 1
            if c1 > c0 + 1e-9 and not (e1 - e0):
                violations.append({
                    "hypothesis": key[:90], "conf": [c0, c1],
                    "ids": [id0, id1],
                })
    return {
        "n_hypotheses_with_repeats": len(multi),
        "n_consecutive_pairs": n_pairs,
        "n_paid_growth_violations (conf up, evidence not grown)": len(violations),
        "examples": violations[:8],
    }


def main():
    report = {"part_a_lemma_check": part_a(), "part_b_ledger_longitudinal": part_b()}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2)[:3000])


if __name__ == "__main__":
    main()
