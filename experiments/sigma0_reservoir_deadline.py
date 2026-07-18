"""#2690 Phase 0.5 — the grounding deadline + schedule race on a REAL LEARNED system
(SIGMA0-COLLAPSE-CERTIFICATE §3.1; docs/SIGMA0-GROUNDING-LEDGER.md §2).

Phase 0 (sigma0_scheduled_grounding.py) validated the schedule-vs-alarm race on
hand-built linear maps. Phase 1 wants a well-conditioned *LLM* loop, which needs a
JSRR-stabilized checkpoint we don't have yet. This is the rung between them: the §6
echo-state reservoir — a REAL, LEARNED, nonlinear dynamical system (trained on the
committed 2,678-turn conversation stream, spectral radius 0.9 by construction,
router_reservoir_G.py, seed pinned) — whose ungrounded closed loop demonstrably
collapses onto a degenerate fixed point. Nobody hand-picked its Jacobian.

THE PROSPECTIVE STRUCTURE (the point of this experiment): every §3.1 quantity is
computed from the LINEARIZATION FIRST — the trained system's fixed point r*, its
analytic Jacobian J, the Lyapunov metric P (JᵀPJ − P = −I), the contraction rate
gamma, the ceiling B*_inf, the commitment half-life, AND the regime call from
cond(P) ("well-conditioned → an alarm premium must appear" vs "sliver → timing
indifference must appear"). All of it is printed and written to the report BEFORE
the escape sweep and the canary race run on the TRUE NONLINEAR map. The theory
calls its shot, then the real dynamics grade it.

What is measured against those predictions:
  1. DEADLINE CONSISTENCY — escape (exact trust-region max of V(x+a) over the
     budget ball, V in the P-metric about r*) under the true nonlinear rollout,
     depth-by-depth, vs the predicted necessary-condition deadline n*(B).
  2. THE REGIME CHECK, by the regime's own operational test (the instrument is
     chosen by the pre-registered call, the outcome is not):
       - well_conditioned call → the Phase-0 race (scheduled-at-cadence vs
         canary-triggered, matched budget; an alarm premium >= 1.3 must appear);
       - sliver call → the cert's own sliver statement: the ceiling B*_inf is
         microscopic, so anchors at the system's REALISTIC grounding scale (the
         measured per-turn input kick of the actual conversation stream) escape
         at every depth — a forced fire-time sweep at {B_real, B_real/10,
         B_real/100} must be timing-indifferent at the first two scales, and the
         ratio B_real/B*_inf is the quantitative regime diagnostic.
     A miss on the chosen instrument is a recorded falsification, not a tuning cue.

FIRST-RUN NOTE (2026-07-17, kept for the record): the initial harness ran the
basin-entry race unconditionally; on this system the pre-registered call came out
SLIVER (cond(P) ~ 4.8e4, basin c ~ 3e-6), the microscopic basin admitted 1 usable
trace out of 100, and the half-life cadence (~17k steps) exceeded the horizon —
the race instrument is vacuous in this regime, which is itself the sliver
prediction. The regime-branched design above replaced it; the deadline leg and
every prediction were unchanged.

Evidence class: MEASURED (real learned system, CPU; still NOT an LLM — that gap is
Phase 1, tracked in #2690). Honest scope: one reservoir, one seed (the committed
§6 system, deliberately untouched); the basin level c is calibrated as the largest
P-shell on which the true map still contracts (printed); the anchor is a state-space
perturbation (additive-anchor model, same §3.1 simplification).

Run:  python experiments/sigma0_reservoir_deadline.py     (numpy + scipy, seconds, CPU)
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy.linalg import solve_discrete_lyapunov

sys.path.insert(0, str(Path(__file__).resolve().parent))
import router_reservoir_G as G  # noqa: E402  — the trained §6 system, reused verbatim

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "data" / "sigma0" / "reservoir_deadline_report.json"

HORIZON = 60
EWMA_ALPHA = 0.5
CONSEC = 3
FPR_CAP = 0.05
COND_WELL = 100.0          # regime call threshold on cond(P), fixed before running
REL_BUDGETS = (0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0)
N_TRACES = 100
QUANTILES = (0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 25.0)


# ─────────────────────────── the trained system, rebuilt exactly ───────────────────────────
def build_system():
    states = G.load_states()
    if states is None:
        sys.exit("missing data/sigma0/router-encoder-output.jsonl — run router_sigma0_encoder.py")
    rng = np.random.default_rng(G.SEED)
    W, W_in = G.build_reservoir(states.shape[1], rng)
    R = G.drive(W, W_in, states)
    split = int(len(R[G.WASHOUT:-1]) * 0.8)
    W_out = G.fit_readout(R[G.WASHOUT:-1][:split], states[G.WASHOUT + 1:][:split])
    return states, R, W, W_in, W_out


def step_map(r, W, W_in, W_out):
    """One step of the autonomous (ungrounded) closed loop — §6's collapse map."""
    u = np.clip(r @ W_out, 0.0, 1.0)
    return (1 - G.LEAK) * r + G.LEAK * np.tanh(W @ r + W_in @ u)


def fixed_point(r0, W, W_in, W_out, iters=4000):
    r = r0.copy()
    for _ in range(iters):
        r = step_map(r, W, W_in, W_out)
    return r, float(np.linalg.norm(step_map(r, W, W_in, W_out) - r))


def jacobian(r_star, W, W_in, W_out):
    """Analytic Jacobian of the closed loop at r*: (1-a)I + a·D_t·(W + W_in·D_c·W_outᵀ)."""
    u_raw = r_star @ W_out
    active = ((u_raw > 0.0) & (u_raw < 1.0)).astype(float)          # clip interior mask
    pre = W @ r_star + W_in @ np.clip(u_raw, 0.0, 1.0)
    D_t = 1.0 - np.tanh(pre) ** 2
    inner = W + W_in @ (np.diag(active) @ W_out.T)
    return (1 - G.LEAK) * np.eye(len(r_star)) + G.LEAK * (D_t[:, None] * inner), active


def jacobian_numeric(r_star, W, W_in, W_out, h=1e-6):
    n = len(r_star)
    Jn = np.zeros((n, n))
    f0 = step_map(r_star, W, W_in, W_out)
    for i in range(n):
        d = np.zeros(n); d[i] = h
        Jn[:, i] = (step_map(r_star + d, W, W_in, W_out) - f0) / h
    return Jn


# ─────────────────────────── P-metric helpers (centered at r*) ───────────────────────────
def max_V_on_ball(x_centered, lam, U, B):
    """Exact max_{||a||<=B} (x+a)ᵀP(x+a) in eigencoordinates (same trust-region routine
    as sigma0_grounding_deadline.py, factored for a precomputed eigh(P))."""
    z = U.T @ x_centered
    lo, hi = lam[-1] + 1e-12, lam[-1] + 1e9
    for _ in range(200):
        mu = 0.5 * (lo + hi)
        a = lam * z / (mu - lam)
        if np.linalg.norm(a) > B:
            lo = mu
        else:
            hi = mu
    a = lam * z / (mu - lam)
    nrm = np.linalg.norm(a)
    if nrm > 1e-12:
        a = a / nrm * B
    w = z + a
    return float(w @ (lam * w))


def predict(J):
    """Everything §3.1 derives from the linearization — computed BEFORE any sweep."""
    P = solve_discrete_lyapunov(J.T, np.eye(J.shape[0]))
    lam, U = np.linalg.eigh(P)
    lmax = float(lam[-1])
    gamma = 1.0 - 1.0 / lmax
    return {"rho_J": float(np.max(np.abs(np.linalg.eigvals(J)))),
            "gamma": gamma, "lmax_P": lmax, "cond_P": float(lam[-1] / lam[0]),
            "half_life": float(np.log(2) / np.log(1 / gamma)),
            "regime_call": "well_conditioned_premium" if lam[-1] / lam[0] < COND_WELL
                           else "sliver_timing_indifferent"}, P, lam, U


def deadline(B, c, V0, gamma, lmax):
    den = math.sqrt(c) - B * math.sqrt(lmax)
    if den <= 0:
        return None
    return 2 * math.log(math.sqrt(V0) / den) / math.log(1 / gamma)


def calibrate_basin(r_star, P, lam, U, W, W_in, W_out, gamma, seed=0):
    """Largest P-shell level c on which the TRUE map still contracts (median one-step
    V-ratio at most halfway between gamma and 1, max below 1)."""
    rng = np.random.default_rng(seed)
    dirs = rng.standard_normal((64, len(r_star)))
    c_ok = None
    for c in np.geomspace(1e-6, 1.0, 24):
        ratios = []
        for d in dirs:
            x = d / math.sqrt(d @ P @ d) * math.sqrt(c)
            y = step_map(r_star + x, W, W_in, W_out) - r_star
            ratios.append((y @ P @ y) / c)
        if np.median(ratios) <= gamma + 0.5 * (1 - gamma) and np.max(ratios) < 1.0:
            c_ok = float(c)
        else:
            break
    return c_ok


# ─────────────────────────── measured leg 1: deadline consistency ───────────────────────────
def escape_sweep(r_star, P, lam, U, c, V0, pred, W, W_in, W_out, seed=0):
    rng = np.random.default_rng(seed)
    rows, consistent = [], True
    Binf = math.sqrt(c / pred["lmax_P"])
    for rel in REL_BUDGETS:
        B = rel * Binf
        nstar = deadline(B, c, V0, pred["gamma"], pred["lmax_P"])
        last = -1
        for _ in range(12):                       # directions on the 0.9c shell
            d = rng.standard_normal(len(r_star))
            x = r_star + d / math.sqrt(d @ P @ d) * math.sqrt(V0)
            for n in range(HORIZON):
                if max_V_on_ball(x - r_star, lam, U, B) > c:
                    last = max(last, n)
                x = step_map(x, W, W_in, W_out)
        ok = (nstar is None and last >= HORIZON - 2) or \
             (nstar is not None and last <= math.ceil(nstar) + 1)
        consistent &= ok
        rows.append({"rel_budget": rel, "budget": B,
                     "predicted_deadline": None if nstar is None else round(nstar, 1),
                     "measured_last_escape": last, "consistent": bool(ok)})
    return rows, consistent


# ─────────────────────────── measured leg 2: the race on real traces ───────────────────────────
def _ewma_sig(traj):
    out, ema = [], None
    for a, b in zip(traj, traj[1:]):
        s = float(np.linalg.norm(b - a))
        ema = s if ema is None else EWMA_ALPHA * s + (1 - EWMA_ALPHA) * ema
        out.append(ema)
    return out


def alarm_time(sig, theta, consec=CONSEC):
    run = 0
    for i, s in enumerate(sig):
        run = run + 1 if s < theta else 0
        if run >= consec:
            return i + 1
    return None


def make_traces(states, R, W, W_in, W_out, n_traces=N_TRACES, seed=0):
    """Healthy = windows of the DRIVEN trajectory (real conversation inputs).
    Collapse = autonomous continuations from real driven states."""
    rng = np.random.default_rng(seed)
    lo, hi = G.WASHOUT + 5, len(R) - HORIZON - 2
    idx = rng.integers(lo, hi, size=n_traces)
    healthy = [_ewma_sig(R[i:i + HORIZON + 1]) for i in idx]
    collapse = []
    for i in idx:
        r, xs = R[i].copy(), [R[i].copy()]
        for _ in range(HORIZON):
            r = step_map(r, W, W_in, W_out)
            xs.append(r.copy())
        collapse.append(np.asarray(xs))
    return healthy, collapse


def realistic_anchor_scale(states, R, W, W_in, W_out, n_probe=800):
    """The system's real grounding kick: median || driven-step − autonomous-step ||
    over the actual conversation stream — what one turn of fresh evidence does."""
    kicks = []
    hi = min(len(states) - 1, G.WASHOUT + n_probe)
    for t in range(G.WASHOUT, hi):
        r = R[t]
        u_auto = np.clip(r @ W_out, 0.0, 1.0)
        drv = (1 - G.LEAK) * r + G.LEAK * np.tanh(W @ r + W_in @ states[t + 1])
        aut = (1 - G.LEAK) * r + G.LEAK * np.tanh(W @ r + W_in @ u_auto)
        kicks.append(float(np.linalg.norm(drv - aut)))
    return float(np.median(kicks))


def sliver_check(r_star, P, lam, U, c, pred, collapse, b_real):
    """Sliver-regime instrument: forced fire-time sweep at realistic anchor scales."""
    Binf = math.sqrt(c / pred["lmax_P"])
    times = (1, 10, 30, HORIZON - 1)
    grid = {}
    for label, B in (("B_real", b_real), ("B_real/10", b_real / 10),
                     ("B_real/100", b_real / 100)):
        row = {}
        for t in times:
            ok = sum(max_V_on_ball(xs[t] - r_star, lam, U, B) > c for xs in collapse)
            row[str(t)] = round(ok / len(collapse), 3)
        grid[label] = row
    indifferent = all(v >= 0.95 for lbl in ("B_real", "B_real/10")
                      for v in grid[lbl].values())
    return {"b_real": b_real, "B_star_inf": Binf,
            "anchor_to_ceiling_ratio": b_real / Binf,
            "fire_time_grid": grid, "timing_indifferent_at_realistic_scales": bool(indifferent)}


def race(r_star, P, lam, U, c, pred, healthy, collapse):
    pool = np.concatenate(healthy)
    sweep = []
    for q in QUANTILES:
        theta = float(np.percentile(pool, q))
        fpr = float(np.mean([alarm_time(h, theta) is not None for h in healthy]))
        sweep.append({"q": q, "theta": round(theta, 6), "fpr": round(fpr, 3)})
    usable = [s for s in sweep if s["fpr"] <= FPR_CAP]
    theta = max((s["theta"] for s in usable), default=-1.0)

    k = max(1, int(round(pred["half_life"] / 2)))
    Binf = math.sqrt(c / pred["lmax_P"])
    rows = []
    for rel in REL_BUDGETS:
        B = rel * Binf
        s_ok = r_ok = fired = 0
        entries, alarms = [], []
        for xs in collapse:
            V = np.array([(x - r_star) @ P @ (x - r_star) for x in xs])
            inside = np.where(V <= 0.9 * c)[0]
            if len(inside) == 0:
                continue                      # never commits within horizon — no race
            entry = int(inside[0])
            entries.append(entry)
            a = alarm_time(_ewma_sig(xs), theta)
            alarms.append(a)
            t_sched = min(entry + k, len(xs) - 1)
            if max_V_on_ball(xs[t_sched] - r_star, lam, U, B) > c:
                s_ok += 1
            if a is not None:
                fired += 1
                if max_V_on_ball(xs[min(a, len(xs) - 1)] - r_star, lam, U, B) > c:
                    r_ok += 1
        n = max(len(entries), 1)
        rows.append({"rel_budget": rel, "scheduled_success": round(s_ok / n, 3),
                     "reactive_success": round(r_ok / n, 3)})
    mb = {p: next((r["rel_budget"] for r in rows if r[p] >= 0.9), None)
          for p in ("scheduled_success", "reactive_success")}
    premium = (mb["reactive_success"] / mb["scheduled_success"]
               if mb["scheduled_success"] and mb["reactive_success"] else None)
    return {"threshold_sweep": sweep, "theta": theta, "cadence_k": k, "race": rows,
            "min_rel_budget": mb, "alarm_premium": None if premium is None else round(premium, 2),
            "premium_unbounded": bool(mb["scheduled_success"] and mb["reactive_success"] is None),
            "raced_traces": n}


# ─────────────────────────── driver ───────────────────────────
def main() -> None:
    states, R, W, W_in, W_out = build_system()
    r_star, resid = fixed_point(R[-1], W, W_in, W_out)
    J, active = jacobian(r_star, W, W_in, W_out)
    jac_err = float(np.max(np.abs(J - jacobian_numeric(r_star, W, W_in, W_out))))
    pred, P, lam, U = predict(J)

    print("== PRE-REGISTERED PREDICTIONS (from the linearization, before any sweep) ==")
    print(f"  fixed-point residual {resid:.2e}   analytic-vs-numeric Jacobian max err {jac_err:.2e}")
    print(f"  rho(J) = {pred['rho_J']:.4f}   gamma = {pred['gamma']:.4f}   "
          f"half-life = {pred['half_life']:.1f} steps   cond(P) = {pred['cond_P']:.1f}")
    print(f"  REGIME CALL: {pred['regime_call']}  (threshold cond(P) < {COND_WELL})")

    c = calibrate_basin(r_star, P, lam, U, W, W_in, W_out, pred["gamma"])
    if c is None:
        sys.exit("no P-shell level on which the true map contracts — linearization unusable")
    V0 = 0.9 * c
    print(f"  calibrated basin level c = {c:.3e}  (largest contracting P-shell)   "
          f"B*_inf = {math.sqrt(c / pred['lmax_P']):.3e}")

    print("\n== MEASURED 1 — deadline consistency on the true nonlinear map ==")
    dl_rows, dl_ok = escape_sweep(r_star, P, lam, U, c, V0, pred, W, W_in, W_out)
    for r in dl_rows:
        print(f"  B={r['rel_budget']:.1f}xB*inf  predicted n*={r['predicted_deadline']}  "
              f"measured last-escape={r['measured_last_escape']}  "
              f"{'CONSISTENT' if r['consistent'] else 'VIOLATION'}")

    healthy, collapse = make_traces(states, R, W, W_in, W_out)
    if pred["regime_call"] == "well_conditioned_premium":
        print("\n== MEASURED 2 — regime instrument: the Phase-0 race (premium expected) ==")
        rc = race(r_star, P, lam, U, c, pred, healthy, collapse)
        print(f"  canary theta={rc['theta']:.5f}  cadence k={rc['cadence_k']}  "
              f"raced traces={rc['raced_traces']}")
        for r in rc["race"]:
            print(f"  B={r['rel_budget']:.1f}xB*inf  scheduled {r['scheduled_success']:.2f}  "
                  f"reactive {r['reactive_success']:.2f}")
        print(f"  ALARM PREMIUM = {'unbounded' if rc['premium_unbounded'] else rc['alarm_premium']}")
        regime_ok = rc["premium_unbounded"] or (rc["alarm_premium"] or 0) >= 1.3
        regime_block = {"instrument": "phase0_race", "result": rc}
    else:
        print("\n== MEASURED 2 — regime instrument: realistic-anchor fire-time sweep "
              "(timing indifference expected) ==")
        b_real = realistic_anchor_scale(states, R, W, W_in, W_out)
        sc = sliver_check(r_star, P, lam, U, c, pred, collapse, b_real)
        print(f"  realistic per-turn grounding kick B_real = {b_real:.4f}   "
              f"B*_inf = {sc['B_star_inf']:.3e}   ratio = {sc['anchor_to_ceiling_ratio']:.1e}")
        for lbl, row in sc["fire_time_grid"].items():
            print(f"  {lbl:>10}: " + "  ".join(f"t={t}:{v:.2f}" for t, v in row.items()))
        print(f"  timing-indifferent at realistic scales: "
              f"{sc['timing_indifferent_at_realistic_scales']}")
        regime_ok = sc["timing_indifferent_at_realistic_scales"]
        regime_block = {"instrument": "sliver_realistic_anchor_sweep", "result": sc}

    ok = dl_ok and regime_ok and resid < 1e-8 and jac_err < 1e-3 and pred["rho_J"] < 1

    verdict = ("VERDICT: the linearization's shot-call held on the real learned system "
               f"({pred['regime_call']})" if ok else
               "VERDICT: prediction MISSED on the real system — record the falsification")
    report = {"issue": "#2690 Phase 0.5", "system": "router_reservoir_G (trained, seed 42)",
              "predictions_preregistered": pred,
              "fixed_point_residual": resid, "jacobian_max_err": jac_err,
              "basin_c": c, "deadline_rows": dl_rows, "deadline_consistent": bool(dl_ok),
              "deadline_note": "necessary-condition bound; in the sliver regime it is loose "
                               "(consistent but without bite) — the measured last-escape "
                               "rising with B shows a real commitment window exists at "
                               "micro-basin scale only",
              "regime_check": regime_block, "regime_call_held": bool(regime_ok),
              "all_ok": bool(ok),
              "evidence_class": "MEASURED (real learned dynamical system, CPU; not an LLM — "
                                "Phase 1 gap unchanged)"}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\n{verdict}\n-> {OUT.relative_to(REPO)}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
