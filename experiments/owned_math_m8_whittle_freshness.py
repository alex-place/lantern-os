"""M8 — the freshness index: claim re-verification IS Age-of-Information scheduling.

The discovery is an isomorphism + what it unlocks. Each ledger claim is a restless-bandit
arm with state = PAID age tau (steps since evidence was last attributed to it — the M7
vocabulary). Passive: age increments, expected error cost c_e*s(tau) where s(tau) =
1 - (1-rho)^tau is the staleness probability (M2's per-claim flip rate rho). Active
(audit / re-ground): pay c_v, reset age. This is the Age-of-Information restless bandit
(Tripathi & Modiano, arXiv:1908.10438: indexability + closed-form Whittle index for
nondecreasing age costs) PLUS a verification price c_v — the inspection-cost variant
(maintenance-index tradition, Glazebrook et al.).

Closed form derived for our variant (proofs note, Lemma 5):

    W(tau) = c_e * [ tau*s(tau) - S(tau-1) ] - c_v ,   S(k) = sum_{u=1..k} s(u)

    geometric staleness s(tau) = 1 - beta^tau, beta = 1-rho:
    W(tau) = c_e * [ 1 - tau*beta^tau + (beta - beta^tau)/(1-beta) ] - c_v

Checked here, exactly:
  A. OPTIMALITY + INDEXABILITY — (i) the optimal threshold is nondecreasing along a dense
     lambda sweep (indexability witnessed on the exact renewal-cost scan); (ii) the
     indifference subsidy recovered by bisection matches W(tau) to ~1e-12; (iii) EXACT
     policy iteration over all stationary policies (deterministic chain — relative VI
     oscillates on the periodic optimal cycle, so PI with closed-form evaluation is the
     sound check) recovers the same threshold. Threshold optimality also has a one-line
     structural proof: any stationary policy's recurrent class is the cycle 1..A for
     A = its smallest audit age, so every policy's average cost is g_lam(A).
  B. EOQ UNIFICATION — the index's zero-crossing reproduces the shipped M2 cadence:
     W(T)=0  =>  T* -> sqrt(2*(c_v/c_e)/rho) as rho -> 0 (measured convergence), and a
     budget shadow price lambda enters as a uniform SURCHARGE on the verification price:
     crossing(lambda) -> sqrt(2*((c_v+lambda)/c_e)/rho). Corollary: the shipped 30-min
     tick, read through the index at the ledger's measured rho, IMPLIES a verification
     price of ~1.6-11% of an error-step — the magic constant becomes an economic claim.
  C. ATTRIBUTION COROLLARY (M7 inside M8) — computing the index on EXPRESSED freshness
     instead of PAID age reproduces audit starvation: laundered arms (expressed age ~ 0
     forever) get index -c_v < 0 and are never audited; on paid age they are scheduled
     like everyone else. Policy contest under a binding audit budget (exact expected
     costs, deterministic aging, no RNG): Whittle-on-paid-age vs EOQ-overdue-ratio vs
     expressed-confidence gating vs round-robin.

Run:  python experiments/owned_math_m8_whittle_freshness.py
"""

from __future__ import annotations

import json
import math
import os

OUT = os.path.join("experiments", "results", "owned_math_m8_whittle_freshness.json")


# ---------------------------------------------------------------- closed form
def s_geom(tau: int, rho: float) -> float:
    return 1.0 - (1.0 - rho) ** tau


def W_closed(tau: int, rho: float, c_e: float, c_v: float) -> float:
    beta = 1.0 - rho
    val = 1.0 - tau * beta**tau + (beta - beta**tau) / (1.0 - beta)
    return c_e * val - c_v


def W_sum(tau: int, rho: float, c_e: float, c_v: float) -> float:
    S = sum(s_geom(u, rho) for u in range(1, tau))
    return c_e * (tau * s_geom(tau, rho) - S) - c_v


# ------------------------------------------------- A. optimality + indexability checks
def opt_threshold(rho, c_e, c_v, lam, Tmax=4000):
    """Exact optimal threshold for the lambda-subsidy problem, by closed-form scan of the
    renewal-reward average cost g_lam(T) = [c_v + c_e*S(T-1) - lam*(T-1)]/T over T=1..Tmax,
    compared against never-audit (average cost c_e*s(inf) - lam = c_e - lam)."""
    best_T, best_g, S = None, c_e - lam, 0.0  # start with never-audit
    for T in range(1, Tmax + 1):
        g = (c_v + c_e * S - lam * (T - 1)) / T
        if g < best_g - 1e-15:
            best_g, best_T = g, T
        S += s_geom(T, rho)
    return best_T, best_g  # best_T None => never audit


def pi_policy(rho, c_e, c_v, lam, Tmax=150, max_iters=200):
    """EXACT policy iteration over ALL stationary deterministic policies.

    Note the chain is deterministic (passive: tau -> tau+1; audit: tau -> 1), so relative
    VALUE iteration is unreliable here — the optimal chain is a periodic cycle and
    synchronous relative VI oscillates. Policy iteration with exact evaluation is finite
    and exact. (Global threshold-optimality also has a one-line proof: any stationary
    policy's recurrent class is the cycle 1..A for A = its smallest audit age, so every
    policy's average cost is g_lam(A) — but we let PI discover that independently.)"""
    act = [0] * (Tmax + 1)
    act[Tmax] = 1  # start: audit only at the cap (proper unichain)
    for _ in range(max_iters):
        # --- exact evaluation: recurrent cycle from state 1 is 1..A, A = min audit age
        A = next(t for t in range(1, Tmax + 1) if act[t] == 1)
        cyc_cost = sum(c_e * s_geom(t, rho) - lam for t in range(1, A)) + c_v
        g = cyc_cost / A
        h = [0.0] * (Tmax + 2)
        # h on the cycle: anchor h[1] = 0, backward from the audit state
        # h[t] = c(t) - g + h[next]; audit state A: h[A] = c_v - g + h[1]
        h[A] = c_v - g
        for t in range(A - 1, 0, -1):
            h[t] = c_e * s_geom(t, rho) - lam - g + h[t + 1]
        # transient states above A (policy may say passive there): evaluate downward-safe:
        for t in range(Tmax, A, -1):
            if act[t] == 1:
                h[t] = c_v - g + h[1]
            else:
                nxt = t + 1 if t < Tmax else Tmax
                # at the cap, passive self-loops; treat as audit-at-cap to stay proper
                h[t] = (c_v - g + h[1]) if t == Tmax else (c_e * s_geom(t, rho) - lam - g + h[nxt])
        # --- improvement
        new = [0] * (Tmax + 1)
        changed = False
        for t in range(1, Tmax + 1):
            q_act = c_v + h[1]
            nxt = t + 1 if t < Tmax else Tmax
            q_pas = c_e * s_geom(t, rho) - lam + h[nxt] if t < Tmax else float("inf")
            new[t] = 1 if (q_act < q_pas - 1e-12 or t == Tmax) else 0
            if new[t] != act[t]:
                changed = True
        act = new
        if not changed:
            break
    return act[1:]


def check_A():
    grid = [(0.02, 1.0, 0.5), (0.1, 1.0, 0.5), (0.1, 1.0, 0.05), (0.3, 2.0, 1.0)]
    rows, worst_gap, indexable, vi_agrees = [], 0.0, True, True
    for rho, c_e, c_v in grid:
        lam_hi = c_e / rho - c_v  # sup_tau W(tau): above this, never audit
        # (i) indexability witness: optimal threshold nondecreasing along a dense lambda sweep
        prev = 0
        for k in range(0, 200):
            lam = (k / 199.0) * lam_hi * 0.999
            T, _ = opt_threshold(rho, c_e, c_v, lam)
            T = T if T is not None else 10**9
            if T < prev:
                indexable = False
            prev = max(prev, T)
        # (ii) indifference subsidy at tau (bisection on the exact scan) == W(tau)?
        gaps = []
        for tau in (1, 2, 3, 5, 8, 13, 21):
            lo, hi = -c_v - 1.0, lam_hi * 1.01
            for _ in range(80):
                mid = 0.5 * (lo + hi)
                T, _ = opt_threshold(rho, c_e, c_v, mid)
                if T is not None and T <= tau:  # still audits by tau -> subsidy too low
                    lo = mid
                else:
                    hi = mid
            lam_star = 0.5 * (lo + hi)
            gaps.append(abs(lam_star - W_closed(tau, rho, c_e, c_v)))
        worst_gap = max(worst_gap, max(gaps))
        # (iii) exact-policy-iteration spot-check: global optimality of the scan threshold
        for lam in (0.0, 0.3 * lam_hi, 0.7 * lam_hi):
            pol = pi_policy(rho, c_e, c_v, lam)
            T, _ = opt_threshold(rho, c_e, c_v, lam, Tmax=149)
            firsts = [i + 1 for i, a in enumerate(pol) if a == 1]
            T_pi = firsts[0] if firsts else None
            if T_pi != T:
                vi_agrees = False
        rows.append({
            "rho": rho, "c_e": c_e, "c_v": c_v,
            "max_|lambda_star - W(tau)|": round(max(gaps), 9),
            "closed_form_vs_sum_form_max_gap": round(
                max(abs(W_closed(t, rho, c_e, c_v) - W_sum(t, rho, c_e, c_v)) for t in range(1, 60)), 12),
        })
    return {"what": "exact-scan indexability witness + indifference == W(tau) + exact-PI global-optimality spot-check",
            "grid": rows, "worst_indifference_gap": worst_gap,
            "passive_set_monotone_in_lambda": indexable, "exact_policy_iteration_agrees_with_threshold_scan": vi_agrees,
            "PASS": bool(indexable and vi_agrees and worst_gap < 1e-5)}


# ------------------------------------------------- B. EOQ unification + implied economics
def crossing(rho, c_e, c_v, lam=0.0):
    tau = 1
    while W_closed(tau, rho, c_e, c_v) < lam:
        tau += 1
        if tau > 10**7:
            return None
    return tau


def check_B():
    conv = []
    for rho in (0.1, 0.03, 0.01, 0.003, 0.001, 0.0003):
        t_idx = crossing(rho, 1.0, 0.1)
        t_eoq = math.sqrt(2 * 0.1 / rho)
        conv.append({"rho": rho, "T_index": t_idx, "T_eoq": round(t_eoq, 2),
                     "rel_err": round(abs(t_idx - t_eoq) / t_eoq, 4)})
    # budget shadow price = uniform surcharge on the verification price
    surcharge = []
    for lam in (0.0, 0.05, 0.2, 0.5):
        t_l = crossing(0.001, 1.0, 0.1, lam)
        t_s = math.sqrt(2 * (0.1 + lam) / 0.001)
        surcharge.append({"lambda": lam, "T_index(lambda)": t_l,
                          "T_eoq(c_v + lambda)": round(t_s, 2),
                          "rel_err": round(abs(t_l - t_s) / t_s, 4)})
    # ledger-measured economics of the shipped 30-min tick (M2: rho_hat raw/de-burst per hour)
    ledger = []
    for label, rho_h in (("raw (48h half-life)", 0.0144), ("de-burst (337h half-life)", 0.0021)):
        rho_min = rho_h / 60.0
        implied = rho_min * 30.0**2 / 2.0  # c_v/c_e implied by T*=30min at lambda=0
        row = {"rho_source": label, "rho_per_min": round(rho_min, 8),
               "implied_c_v_over_c_e_at_30min_tick": round(implied, 4)}
        for r in (0.01, 0.1, 1.0):
            row[f"T*_minutes_at_c_v/c_e={r}"] = crossing(rho_min, 1.0, r)
        ledger.append(row)
    return {"what": "index zero-crossing -> EOQ law; budget lambda -> price surcharge; tick's implied economics",
            "eoq_convergence": conv, "budget_surcharge": surcharge, "ledger_tick_economics": ledger,
            "PASS": bool(conv[-1]["rel_err"] < 0.02 and surcharge[-1]["rel_err"] < 0.02)}


# ------------------------------------------------- C. policy contest with laundered arms
def contest(horizon=20000, burn=500):
    # 6 honest arms + 2 laundered arms (expressed freshness ~ always fresh; true rho HIGH).
    # Costs are exact expectations (deterministic aging), budget M = 1 audit/step, binding.
    arms = [
        {"rho": 0.02, "c_e": 1.0, "laundered": False},
        {"rho": 0.05, "c_e": 1.0, "laundered": False},
        {"rho": 0.01, "c_e": 3.0, "laundered": False},
        {"rho": 0.08, "c_e": 0.5, "laundered": False},
        {"rho": 0.03, "c_e": 2.0, "laundered": False},
        {"rho": 0.005, "c_e": 1.0, "laundered": False},
        {"rho": 0.10, "c_e": 2.0, "laundered": True},
        {"rho": 0.06, "c_e": 1.5, "laundered": True},
    ]
    C_V = 0.5

    def tstar(a):
        return math.sqrt(2 * (C_V / a["c_e"]) / a["rho"])

    def run(policy):
        ages = [1] * len(arms)
        total = 0.0
        for step in range(horizon):
            pick = policy(ages, step)
            cost = 0.0
            for i, a in enumerate(arms):
                if i == pick:
                    cost += C_V
                    ages[i] = 1
                else:
                    cost += a["c_e"] * s_geom(ages[i], a["rho"])
                    ages[i] += 1
            if step >= burn:
                total += cost
        return total / (horizon - burn)

    def pol_whittle(ages, _):
        best, best_w = None, 0.0
        for i, a in enumerate(arms):
            w = W_closed(ages[i], a["rho"], a["c_e"], C_V)
            if w > best_w:
                best, best_w = i, w
        return best

    def pol_eoq_overdue(ages, _):
        best, best_r = None, 1.0
        for i, a in enumerate(arms):
            r = ages[i] / tstar(a)
            if r > best_r:
                best, best_r = i, r
        return best

    def pol_expressed(ages, _):
        # audits by EXPRESSED staleness risk; laundered arms always express age ~ 0
        best, best_u = None, 0.0
        for i, a in enumerate(arms):
            expr_age = 0 if a["laundered"] else ages[i]
            u = a["c_e"] * s_geom(expr_age, a["rho"]) if expr_age else 0.0
            if u > best_u:
                best, best_u = i, u
        return best

    def pol_rr(ages, step):
        return step % len(arms)

    res = {}
    for name, pol in (("whittle_paid_age", pol_whittle), ("eoq_overdue_ratio", pol_eoq_overdue),
                      ("expressed_confidence_gate", pol_expressed), ("round_robin", pol_rr)):
        res[name] = round(run(pol), 4)
    res["contention"] = round(sum(1 / tstar(a) for a in arms), 3)
    res["laundered_arm_note"] = ("expressed gate never audits laundered arms -> their cost saturates at c_e; "
                                 "whittle on PAID age schedules them like any arm (M7 corollary inside the index)")
    order = sorted((v, k) for k, v in res.items() if isinstance(v, float) and k != "contention")
    res["ranking_best_to_worst"] = [k for _, k in order]
    res["PASS"] = bool(order[0][1] == "whittle_paid_age")
    return res


def main():
    A, B, C = check_A(), check_B(), contest()
    report = {
        "date": "2026-07-24",
        "index_closed_form": "W(tau) = c_e*[tau*s(tau) - S(tau-1)] - c_v ; geometric: c_e*[1 - tau*b^tau + (b-b^tau)/(1-b)] - c_v",
        "A_value_iteration_crosscheck": A,
        "B_eoq_unification_and_tick_economics": B,
        "C_policy_contest": C,
        "reading": (
            "Claim re-verification is the AoI restless bandit with a verification price. The index "
            "imports (Tripathi-Modiano indexability; maintenance-index tradition for the c_v term); "
            "what it unlocks here: (1) M2's EOQ cadence is the index's zero-crossing — the shipped "
            "30-min tick, at the ledger's measured rho, implies verification is priced at ~1.6-11% of "
            "an error-step; (2) a binding audit budget enters as a uniform surcharge on the "
            "verification price (never a starvation of high-rho claims); (3) the index is measurable "
            "w.r.t. PAID age alone — computing it on expressed freshness reproduces audit starvation "
            "(M7), and on paid age it beats EOQ-overdue, expressed-confidence, and round-robin "
            "scheduling under a binding budget."
        ),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(json.dumps({"A_PASS": A["PASS"], "worst_gap": A["worst_indifference_gap"],
                      "B_PASS": B["PASS"], "C": C}, indent=1))
    print("full report ->", OUT)


if __name__ == "__main__":
    main()
