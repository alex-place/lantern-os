"""Audit Starvation — machine check for the starve-or-spend dichotomy (M7 public form).

Claim family attacked: "confidence-gated verification concentrates audit effort where it
is needed" — the design premise of threshold-gated retrieval (FLARE: retrieve iff any
token prob < theta), uncertainty-proportional auditing (uncertainty sampling), and
agreement/entropy gates.

Counterexample dynamics (the M6 lasing model, publicly: a self-reinforcing belief):
confidence odds o_t = o0 * g^t with g > 1 and ZERO evidence ever paid to the belief.
The gate reads expressed confidence c_t = o_t / (1 + o_t) — provenance-blind.

Everything below is EXACT (closed forms + convergent products; no RNG, no clock):

  A. Threshold gate (FLARE form; audit iff c_t < theta): the region {c >= theta} is
     absorbing because c_t is increasing. All catch opportunity is confined to the
     finite prefix t < t* = ceil(log_g(theta/((1-theta)*o0))). With per-audit catch
     power rho < 1 (lock-in: the audit can return the same defective neighborhood),
     P(never caught) >= (1-rho)^{t*} > 0; if o0 >= theta/(1-theta) (born confident,
     the measured RLHF-overconfidence regime) it is 1. Survive the window once ->
     immortal.
  B. Proportional gate (audit w.p. q_t = alpha*(1-c_t)): sum q_t < inf (endogenous
     summability -> the Rothschild incomplete-learning trap, self-manufactured), so
     P(never even audited) = prod(1-q_t) > 0 REGARDLESS of verifier power, and
     E[lifetime audits] is a small constant.
  C. Audit inversion: an honest belief at calibrated c stays audited at constant rate
     alpha*(1-c) forever -> expected audits grow linearly while the confabulator's
     total is bounded. Scrutiny concentrates on honesty.
  D. Starve-or-spend dichotomy: any provenance-blind gate emits the SAME audit
     schedule on the laundered belief and on its genuinely-anchored twin (identical
     observable trajectories — the two-world construction of Lemma 3 / M7). Either
     sum q_t < inf (starves: positive escape probability for the false belief) or
     sum q_t = inf (spends: audits the settled-true twin infinitely often). The
     attribution gate (audit iff no PAID evidence this step) escapes: constant hazard
     on the laundered belief (catch ~ Geometric, E = 1/(alpha*rho)), zero redundant
     audits on the paid twin.

Boundary of the trap (reported): threshold gates absorb whenever c_t crosses theta at
any growth rate; proportional gates starve iff sum(1-c_t) < inf, i.e. iff sum 1/o_t
< inf — ANY superlinear odds growth suffices, geometric g>1 is just the M6 instance.

Run:  python experiments/audit_starvation_theorem.py
"""

from __future__ import annotations

import json
import math
import os

OUT = os.path.join("experiments", "results", "audit_starvation_theorem.json")

G = 1.4          # odds gain per step (M6 lasing ratio)
O0 = 1.0         # initial odds (c0 = 0.5)
ALPHA = 0.5      # audit-rate scale for proportional/attribution gates
THETA = 0.9      # threshold gate: audit iff c < THETA
HORIZON = 40     # display horizon for finite-T numbers
TAIL = 400       # series cutoff; geometric tail below double precision long before this


def conf(t: float, o0: float = O0, g: float = G) -> float:
    o = o0 * (g ** t)
    return o / (1.0 + o)


def q_prop(t: int) -> float:
    return ALPHA * (1.0 - conf(t))


# ---------- A. Threshold gate: absorption ----------
def part_a():
    crit = THETA / (1.0 - THETA) / O0
    t_star = max(0, math.ceil(math.log(crit) / math.log(G))) if crit > 1 else 0
    # audits happen at every t < t_star (c_t < theta), never after (c_t increasing)
    audits_forever = t_star
    grid = []
    for rho in (1.0, 0.5, 0.2):
        for o0 in (O0, crit + 1e-9):  # normal start vs born-confident
            ts = max(0, math.ceil(math.log(THETA / (1 - THETA) / o0) / math.log(G))) if THETA / (1 - THETA) / o0 > 1 else 0
            grid.append({
                "rho_catch_power": rho,
                "o0": round(o0, 4),
                "t_star_window": ts,
                "P_never_caught": round((1 - rho) ** ts, 6),
            })
    return {
        "what": "threshold gate (FLARE form): {c >= theta} is absorbing; catch opportunity confined to a finite window",
        "theta": THETA, "g": G, "o0": O0,
        "t_star": t_star,
        "lifetime_audits": audits_forever,
        "P_never_caught_grid": grid,
        "immortality": "survive the t* window once (rho<1 or born-confident) -> never audited again, ever",
    }


# ---------- B. Proportional gate: endogenous summability ----------
def part_b():
    s = sum(q_prop(t) for t in range(TAIL))
    tail_bound = ALPHA / (O0 * (G ** TAIL)) / (1 - 1 / G)  # sum_{t>=TAIL} alpha/(o0 g^t)
    p_never = 1.0
    for t in range(TAIL):
        p_never *= (1.0 - q_prop(t))
    e_audits_by_T = sum(q_prop(t) for t in range(HORIZON))
    closed_bound = ALPHA * (1 / (1 + O0) + 1 / (O0 * (G - 1)))  # E[audits] upper bound
    return {
        "what": "proportional gate q_t = alpha*(1-c_t): the belief's own gain makes sum q_t finite",
        "alpha": ALPHA, "g": G, "o0": O0,
        "E_lifetime_audits": round(s, 6),
        "E_lifetime_audits_closed_form_bound": round(closed_bound, 6),
        "series_tail_bound_after_cutoff": tail_bound,
        "P_never_audited": round(p_never, 6),
        "E_audits_by_T40": round(e_audits_by_T, 6),
        "note": "P(never CAUGHT) >= P(never audited) for ANY per-audit catch power rho <= 1",
    }


# ---------- C. Audit inversion ----------
def part_c():
    honest_c = 0.5  # calibrated, no self-gain
    honest_rate = ALPHA * (1 - honest_c)
    honest_by_T = honest_rate * HORIZON
    laundered_lifetime = sum(q_prop(t) for t in range(TAIL))
    return {
        "what": "the gate audits the honest belief forever and the confabulator a bounded number of times",
        "honest_expected_audits_by_T40": round(honest_by_T, 4),
        "laundered_expected_audits_LIFETIME": round(laundered_lifetime, 4),
        "inversion_ratio_by_T40": round(honest_by_T / laundered_lifetime, 2),
        "P_honest_never_audited_by_T40": round((1 - honest_rate) ** HORIZON, 8),
        "asymptotic": "honest audits ~ alpha*(1-c)*T -> infinity; laundered total stays a constant",
    }


# ---------- D. Starve-or-spend dichotomy: four gates x two worlds ----------
def catch_by_T(qs, rho=1.0):
    """P(caught by horizon) for independent audit events with catch power rho — exact."""
    p_alive = 1.0
    for q in qs:
        p_alive *= (1.0 - rho * q)
    return 1.0 - p_alive


def part_d():
    # identical observable trajectory in both worlds (two-world construction):
    # W_L laundered (focal belief NEVER paid), W_G anchored twin (paid every step).
    qs_threshold = [1.0 if conf(t) < THETA else 0.0 for t in range(HORIZON)]
    qs_prop = [q_prop(t) for t in range(HORIZON)]
    qs_uniform = [ALPHA * 0.5] * HORIZON  # provenance-blind flat auditor (case ii)
    gates = []
    for name, qs, blind in (
        ("threshold (FLARE form)", qs_threshold, True),
        ("proportional (uncertainty sampling)", qs_prop, True),
        ("uniform (flat rate)", qs_uniform, True),
        ("attribution (audit iff no PAID evidence)", None, False),
    ):
        if blind:
            row = {
                "gate": name,
                "provenance_blind": True,
                # identical schedule on BOTH worlds — that is the dichotomy's premise
                "P_catch_WL_by_T40_rho1": round(catch_by_T(qs, 1.0), 6),
                "P_catch_WL_by_T40_rho0.5": round(catch_by_T(qs, 0.5), 6),
                "expected_audits_on_anchored_twin_by_T40": round(sum(qs), 4),
                "anchored_twin_audits_unbounded": bool(sum(qs[-5:]) > 1e-9),  # still auditing at the horizon?
            }
        else:
            # W_L: no paid evidence ever -> hazard ALPHA every step; W_G: paid every step -> zero audits
            qs_attr_WL = [ALPHA] * HORIZON
            row = {
                "gate": name,
                "provenance_blind": False,
                "P_catch_WL_by_T40_rho1": round(catch_by_T(qs_attr_WL, 1.0), 6),
                "P_catch_WL_by_T40_rho0.5": round(catch_by_T(qs_attr_WL, 0.5), 6),
                "E_steps_to_catch_rho1": round(1 / ALPHA, 2),
                "expected_audits_on_anchored_twin_by_T40": 0.0,
                "anchored_twin_audits_unbounded": False,
            }
        gates.append(row)
    return {
        "what": "any provenance-blind gate emits the same schedule on the laundered belief and its anchored twin; it must starve (finite sum -> escape probability) or spend (infinite sum -> audits settled truth forever); attribution does neither",
        "gates": gates,
        "boundary": "threshold gates absorb whenever c_t ever crosses theta; proportional gates starve iff sum(1/o_t) < inf (any superlinear odds growth); geometric g>1 is the M6 instance",
    }


def main():
    report = {
        "date": "2026-07-24",
        "model": {"odds": "o_t = o0 * g^t", "g": G, "o0": O0, "confidence": "c_t = o_t/(1+o_t)"},
        "A_threshold_absorption": part_a(),
        "B_proportional_starvation": part_b(),
        "C_audit_inversion": part_c(),
        "D_starve_or_spend_dichotomy": part_d(),
        "reading": (
            "In bandits, summable exploration is a designer's mistake (Rothschild 1974 incomplete "
            "learning). Under confidence-gated verification the false belief manufactures the "
            "summability itself: its own gain schedule turns every vanishing-in-confidence audit "
            "rule into an incomplete-learning trap. The empirical face of this is retrieval-state "
            "lock-in (arXiv:2606.22728: 42-59% of RAG errors silent at N=5). The escape is not a "
            "better function of the same observables (two-world impossibility, Lemma 3/M7) but a "
            "richer vocabulary: per-belief PAID-evidence accounting."
        ),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(json.dumps({k: report[k] for k in ("A_threshold_absorption", "B_proportional_starvation", "C_audit_inversion")}, indent=1))
    print("dichotomy gates:")
    for g in report["D_starve_or_spend_dichotomy"]["gates"]:
        print(" ", g)
    print("full report ->", OUT)


if __name__ == "__main__":
    main()
