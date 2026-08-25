"""Candidate B -- the Cross-Timescale Missing-Term Theorem -- attacked, and the term found.

THE CLAIM UNDER TEST. Two individually valid certificates (fast-state C_x, slow-weight C_theta)
do not compose (section 9 finding). The research target: find a coupling quantity K such that

    C_x  AND  C_theta  AND  K <= K_max   =>   C_{x,theta}

and show it is both necessary (omit it, composition fails) and sufficient (bound it, it holds).

THE MODEL.  x_{k+1} = A x_k + B theta_k ;  theta_{k+1} = theta_k + eps (c^T x_k + d theta_k).
joint map M(eps) = [[A, B], [eps c^T, 1 + eps d]].  Let G(z) = c^T (zI - A)^{-1} B be the fast
block's transfer function from theta to the slow loop's sensing c^T x.

WHAT THE SLOW CERTIFICATE SEES.  Substituting the frozen-theta fixed point x* = (I-A)^{-1} B
theta gives the reduced slow map theta <- (1 + eps a_red) theta with  a_red = d + G(1).
That is the QUASI-STATIC reduced coefficient: the fast block's DC response to a slowly-held
theta. The slow gate reads a_red and nothing else.

THE EXACT RESULT (derived, then checked to machine precision below).  The joint characteristic
polynomial factors as  det(zI - A) * [ z - 1 - eps (d + G(z)) ].  The slow root therefore solves
        z - 1 = eps ( d + G(z) )        exactly, no expansion.
With a_red < 0 the slow root moves LEFT from 1 as eps grows and instability sets in when it
reaches z = -1 (the alternating mode: theta flips sign every step).  Put z = -1:
        -2 = eps ( d + G(-1) )    =>    eps_c = 2 / | d + G(-1) |.

THE MISSING TERM IS THE TRANSFER FUNCTION AT THE NYQUIST POINT, G(-1).
The slow gate measures  a_red = d + G(1).  Stability is governed by  a_nyq = d + G(-1).
These agree only when the fast block has no frequency dependence (G constant), i.e. when
the fast dynamics are instantaneous -- which is precisely the timescale-separation assumption
section 9 invokes and never quantifies.  In general |G(-1)| is LARGE relative to |G(1)| when
the fast block has poles near z=1 (slow fast dynamics), which is exactly when separation is weak.
The cancellation that hid the section-9 failure is now explicit: d can cancel G(1) (tame a_red)
while leaving d + G(-1) enormous.

This file's first attempt used a first-order expansion around z=1 and got g1 = G'(1). It was
WRONG -- eps*|g1| ~ 2.5-3 at the critical point, so the expansion was invalid, and a 2-pole
construction with G(1), G'(1) pinned still moved eps_c by 26%. The exact Nyquist-point result
explains every one of those systems to 0.000%. Kept in the history because the wrong derivation
being killed by its own pre-registered B3 is the point of pre-registering.

WHAT THIS MEANS FOR THE CERTIFICATE.  The composition statement becomes, exactly in this
linear regime:
        C_x  AND  C_theta  AND  eps < 2 / |d + G(-1)|   =>   composed system stable.
K is  |d + G(-1)|, the reduced coefficient evaluated at the alternating frequency.  It is
NECESSARY (section 9: omit it and both certificates pass while the system diverges 1000x) and
SUFFICIENT (this file: it predicts the exact boundary).  The slow gate should read G at z=-1,
not only at z=1.  In a neural-training setting, that is: measure how the fast state responds to
a theta perturbation that ALTERNATES every forward pass, not only to one that is held.

PRE-REGISTERED TESTS (this revision, fixed before running):
  B1 (DC gain is NOT sufficient): two systems with identical rho(A), a_red, G(1) but different
     G(-1); eps_c must differ by > 20%.
  B2 (G(-1) is exact): over 40 random systems, 2/|d+G(-1)| matches bisection eps_c to < 0.1%
     median error.
  B3 (nothing else matters, first check): a 3-pole G with G(1) AND G'(1) pinned and G''(1)
     varying -- the construction that killed the first derivation -- must be predicted to <0.1%.
  B4 (the limit of the claim, stated): this is the LINEAR, SINGLE-SLOW-VARIABLE, CONSTANT-A
     regime. With a vector theta the slow root is a matrix eigenvalue problem and the scalar
     G(-1) becomes the matrix C (-I - A)^{-1} B; with nonlinearity it is a local statement at
     the operating point. Reported, not claimed beyond.

Read-only; exact linear algebra; no sampling.
Run:  python experiments/sigma0_composition_coupling_term.py
"""

from __future__ import annotations

import json
import os

import numpy as np

OUT = os.path.join("experiments", "results", "sigma0_composition_coupling_term.json")
A_RED = -1.0


def joint(A, B, c, d, eps):
    n = A.shape[0]
    M = np.zeros((n + 1, n + 1))
    M[:n, :n] = A; M[:n, n] = B; M[n, :n] = eps * c; M[n, n] = 1 + eps * d
    return M


def rho(M):
    return float(max(abs(np.linalg.eigvals(M))))


def eps_c(A, B, c, d, hi=8.0, lo=1e-9, it=90):
    if rho(joint(A, B, c, d, hi)) < 1: return hi
    if rho(joint(A, B, c, d, lo)) >= 1: return 0.0
    for _ in range(it):
        m = 0.5 * (lo + hi)
        if rho(joint(A, B, c, d, m)) < 1: lo = m
        else: hi = m
    return lo


def G(A, B, c, z):
    return complex(c @ np.linalg.solve(z * np.eye(A.shape[0]) - A, B))


def predict(A, B, c, d):
    a_nyq = d + G(A, B, c, -1.0).real
    return 2.0 / abs(a_nyq) if a_nyq < 0 else float("inf")


def main():
    rep = {"date": "2026-07-27", "theorem": "eps_c = 2/|d + G(-1)|; slow gate reads d + G(1)",
           "B1": {}, "B2": [], "B3": [], "B4": {}}
    B2v = np.array([0.0, 1.0])

    # ── B1 ────────────────────────────────────────────────────────────────────────────
    r, s, g = 0.9, 0.5, 10.0
    sysP = (np.diag([r, r]), np.array([0.0, g * (1 - r)]))
    sysQ = (np.diag([r, s]), np.array([0.0, g * (1 - s)]))
    print("=== B1: same rho(A), same a_red = d+G(1), same G(1) -- different G(-1) ===")
    print(f"{'sys':>4} {'rho':>5} {'G(1)':>7} {'a_red':>7} {'G(-1)':>8} {'d+G(-1)':>9} {'eps_c':>9} {'2/|d+G(-1)|':>12}")
    for name, (A, c) in (("P", sysP), ("Q", sysQ)):
        d = A_RED - G(A, B2v, c, 1).real
        ec = eps_c(A, B2v, c, d); pr = predict(A, B2v, c, d)
        rep["B1"][name] = {"rho": rho(A), "G1": G(A, B2v, c, 1).real, "a_red": d + G(A, B2v, c, 1).real,
                           "Gm1": G(A, B2v, c, -1).real, "a_nyq": d + G(A, B2v, c, -1).real, "eps_c": ec, "pred": pr}
        v = rep["B1"][name]
        print(f"{name:>4} {v['rho']:>5.2f} {v['G1']:>7.2f} {v['a_red']:>7.2f} {v['Gm1']:>8.3f} {v['a_nyq']:>9.3f} {v['eps_c']:>9.5f} {v['pred']:>12.5f}")
    P, Q = rep["B1"]["P"], rep["B1"]["Q"]
    b1 = abs(P["eps_c"] - Q["eps_c"]) / max(P["eps_c"], Q["eps_c"]) > 0.20
    print(f"  eps_c differ by {100*abs(P['eps_c']-Q['eps_c'])/max(P['eps_c'],Q['eps_c']):.0f}% with G(1) pinned -> DC gain is {'NOT' if b1 else ''} sufficient; G(-1) predicts both exactly\n")

    # ── B2 ────────────────────────────────────────────────────────────────────────────
    print("=== B2: G(-1) exact over 40 random systems ===")
    rng = np.random.default_rng(0); errs = []
    for i in range(40):
        r = rng.uniform(0.3, 0.95); s = rng.uniform(0.0, r); g = rng.uniform(0.5, 50); a_red = -rng.uniform(0.2, 3.0)
        A = np.diag([r, s]); c = np.array([0.0, g * (1 - s)]); d = a_red - G(A, B2v, c, 1).real
        ec = eps_c(A, B2v, c, d); pr = predict(A, B2v, c, d); err = abs(pr - ec) / ec
        errs.append(err); rep["B2"].append({"r": r, "s": s, "G1": g, "a_red": a_red, "Gm1": G(A, B2v, c, -1).real, "eps_c": ec, "pred": pr, "err": err})
    med = float(np.median(errs)); b2 = med < 1e-3
    print(f"  median |pred - eps_c|/eps_c = {100*med:.6f}%   max = {100*max(errs):.6f}%   -> {'PASS' if b2 else 'FAIL'}\n")

    # ── B3 ────────────────────────────────────────────────────────────────────────────
    print("=== B3: the systems that KILLED the first derivation -- G(1), G'(1) pinned, G''(1) varying ===")
    errs3 = []
    for (s1, s2) in ((0.5, 0.5), (0.3, 0.7), (0.1, 0.8), (0.0, 0.85)):
        tg, tg1 = 10.0, -10.0 / (1 - 0.5)
        if s1 == s2:
            w = np.array([tg * (1 - s1), 0.0]); s2 = s1 + 1e-9
        else:
            Mw = np.array([[1 / (1 - s1), 1 / (1 - s2)], [-1 / (1 - s1) ** 2, -1 / (1 - s2) ** 2]])
            w = np.linalg.solve(Mw, [tg, tg1])
        A = np.diag([0.9, s1, s2]); c = np.array([0.0, w[0], w[1]]); Bv = np.array([0.0, 1.0, 1.0])
        d = A_RED - G(A, Bv, c, 1).real
        ec = eps_c(A, Bv, c, d); pr = predict(A, Bv, c, d); err = abs(pr - ec) / ec; errs3.append(err)
        rep["B3"].append({"s1": s1, "s2": s2, "Gm1": G(A, Bv, c, -1).real, "eps_c": ec, "pred": pr, "err": err})
        print(f"  poles ({s1},{s2:.2f})  G(-1)={G(A,Bv,c,-1).real:8.4f}  eps_c={ec:.6f}  pred={pr:.6f}  err {100*err:.4f}%")
    b3 = max(errs3) < 1e-3

    # ── B4 ────────────────────────────────────────────────────────────────────────────
    # Where the scalar form ends: show the cancellation explicitly and the separation ratio.
    print("\n=== B4: the cancellation, made explicit ===")
    print(f"{'fast pole s':>12} {'G(1)':>8} {'G(-1)':>8} {'|G(-1)/G(1)|':>13} {'a_red':>6} {'a_nyq':>9} {'eps_c':>9}  (pinned a_red=-1)")
    for s in (0.0, 0.5, 0.8, 0.9, 0.95, 0.99):
        A = np.diag([0.3, s]); c = np.array([0.0, 5.0]); d = A_RED - G(A, B2v, c, 1).real
        g1_ = G(A, B2v, c, 1).real; gm = G(A, B2v, c, -1).real
        rep["B4"][str(s)] = {"G1": g1_, "Gm1": gm, "a_nyq": d + gm, "eps_c": eps_c(A, B2v, c, d)}
        print(f"{s:>12.2f} {g1_:>8.2f} {gm:>8.3f} {abs(gm/g1_):>13.3f} {A_RED:>6.1f} {d+gm:>9.3f} {eps_c(A,B2v,c,d):>9.5f}")
    print("  as the fast pole s -> 1 (weak timescale separation) G(1) grows, d cancels it, a_red stays -1,")
    print("  but G(-1) -> c/(-1-s) stays bounded while d -> -inf: a_nyq explodes and eps_c -> 0.")
    print("  That IS the section-9 failure: both certificates constant, true threshold collapsing.")

    rep["gates"] = {"B1_DC_gain_not_sufficient": bool(b1), "B2_Gm1_exact_median_err": med, "B2_PASS": bool(b2),
                    "B3_explains_first_attempts_killers": bool(b3),
                    "VERDICT": ("CANDIDATE B: THE MISSING TERM IS G(-1). Exact: eps_c = 2/|d + G(-1)| in the "
                                "linear single-slow-variable regime; the slow gate reads d + G(1). Necessary "
                                "(section 9) and sufficient (this file)." if (b1 and b2 and b3) else "PARTIAL")}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(rep, f, indent=2, default=float)
    print(f"\nGATES: B1={b1}  B2={b2}  B3={b3}")
    print("VERDICT:", rep["gates"]["VERDICT"])
    print("->", OUT)


if __name__ == "__main__":
    main()
