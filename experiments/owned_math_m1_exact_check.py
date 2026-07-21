"""M1 third pass — EXACT-arithmetic machine check of the lemma's two inequalities.

Floats convinced (0/9,000); this closes the numerical-tolerance loophole with
rational arithmetic (fractions.Fraction), the L2 machine-check pattern:

  (1) Minkowski core:  det(M + Q) >= det(M)   for PSD rational M, Q  (n<=4)
  (2) Filter chain:    det(A S A^T + Q) >= det(A)^2 det(S)  exactly — the step that
      yields dynamics_term <= 2 log(1/|det A|) in the decomposition.

Determinants via exact fraction Gaussian elimination. Any violation exits 1.

Run:  python experiments/owned_math_m1_exact_check.py
"""

from __future__ import annotations

import json
import os
import random
import sys
from fractions import Fraction

OUT = os.path.join("experiments", "results", "owned_math_m1_exact_check.json")
TRIALS = 200
random.seed(41)


def rand_frac():
    return Fraction(random.randint(-6, 6), random.randint(1, 6))


def matmul(X, Y):
    n, m, p = len(X), len(Y), len(Y[0])
    return [[sum(X[i][k] * Y[k][j] for k in range(m)) for j in range(p)] for i in range(n)]


def transpose(X):
    return [list(r) for r in zip(*X)]


def madd(X, Y):
    return [[a + b for a, b in zip(rx, ry)] for rx, ry in zip(X, Y)]


def det_exact(M):
    n = len(M)
    A = [row[:] for row in M]
    d = Fraction(1)
    for c in range(n):
        piv = next((r for r in range(c, n) if A[r][c] != 0), None)
        if piv is None:
            return Fraction(0)
        if piv != c:
            A[c], A[piv] = A[piv], A[c]
            d = -d
        d *= A[c][c]
        inv = Fraction(1) / A[c][c]
        for r in range(c + 1, n):
            f = A[r][c] * inv
            if f:
                A[r] = [a - f * b for a, b in zip(A[r], A[c])]
    return d


def rand_psd(n):
    B = [[rand_frac() for _ in range(n)] for _ in range(n)]
    return matmul(B, transpose(B))


def main():
    viol_minkowski = 0
    viol_chain = 0
    for _ in range(TRIALS):
        n = random.randint(2, 4)
        M, Q = rand_psd(n), rand_psd(n)
        if det_exact(madd(M, Q)) < det_exact(M):
            viol_minkowski += 1

        A = [[rand_frac() for _ in range(n)] for _ in range(n)]
        S, Q2 = rand_psd(n), rand_psd(n)
        lhs = det_exact(madd(matmul(matmul(A, S), transpose(A)), Q2))
        rhs = det_exact(A) ** 2 * det_exact(S)
        if lhs < rhs:
            viol_chain += 1

    report = {
        "trials": TRIALS,
        "arithmetic": "exact rational (fractions.Fraction), no tolerances",
        "violations_minkowski_det(M+Q)>=det(M)": viol_minkowski,
        "violations_chain_det(ASA'+Q)>=detA^2 detS": viol_chain,
        "verdict": "EXACT PASS" if not (viol_minkowski or viol_chain) else "VIOLATION — lemma step false",
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))
    sys.exit(0 if not (viol_minkowski or viol_chain) else 1)


if __name__ == "__main__":
    main()
