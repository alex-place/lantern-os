"""
sigma0_scheduled_grounding.py — the scheduled-vs-reactive grounding race
(SIGMA0-COLLAPSE-CERTIFICATE.md §3.1 design consequence; issue #2690 Phase 0;
docs/SIGMA0-GROUNDING-LEDGER.md §2).

Question measured: given ONE decisive grounding event of budget B inside a certified
basin, does WHEN it fires decide whether it works — and is a critical-slowing-down
alarm structurally late relative to the window the certificate's own quantities define?

Design (timing is the only variable):
  - Basin per the deadline driver (sigma0_grounding_deadline.py): V = x^T P x with
    V(Ax) <= gamma*V(x), boundary {V = c}, start on the V0 = 0.9c shell, small noise.
  - HEALTHY reference = the grounded twin: same loop, DRIVEN by fresh external input
    each step (evidence keeps arriving) and restored to the V0 shell (grounding
    cadence 1). The drive keeps the healthy step signal stationary — without it the
    twin slowly aligns with the slowest mode and its signal declines forever, making
    every threshold false-alarm. Collapsing trace = same loop, undriven, ungrounded.
  - CANARY = EWMA of the step displacement ||x_k - x_{k-1}|| (critical slowing down:
    contraction starves the step signal). Swept over thresholds taken from healthy
    quantiles — no cherry-picked calibration; each threshold is scored (per-trace
    false-positive rate on healthy traces, alarm time on collapsing traces).
  - RACE: each policy gets exactly one escape attempt with the full budget B
    (exact trust-region max of V(x+a) over ||a||<=B — verified against the basin,
    not against our own bound):
      scheduled  -> fires at the cadence tick k = round(half_life/2)
      reactive   -> fires when the canary alarms (no alarm in horizon = no grounding)
  - Headline: the ALARM PREMIUM = (min budget for >=90% reactive success) /
    (same for scheduled). Well-conditioned basin: premium > 1 — waiting for the alarm
    forfeits the cheap part of the window. Sliver basin (cond(P) huge): a forced
    fire-time sweep shows TIMING-INDIFFERENCE — any realistic anchor escapes at every
    depth, retro-dicting the measured Ouro anchoring null
    (experiments/ouro_canary_vs_logprob.py).

Evidence class: MEASURED (synthetic maps, CPU-only; a design-consequence check, NOT a
theorem). Honest scope: the canary is charitable (thresholds calibrated on the true
healthy distribution, which real systems don't have — this strengthens a lateness
verdict and weakens an earliness one); one detector family (step-displacement EWS);
additive-anchor model of grounding; single-shot policies isolate timing but forgo
multi-injection strategies; the printed n*(B) deadlines are the inequality's
NECESSARY-condition curve (alignment-optimistic in early steps) shown for context —
the race verdicts come from the exact escape check, not the formula. Prior art for
the schedule side: self-triggered control (Heemels-Johansson-Tabuada, CDC 2012;
arXiv:1803.08980) — this experiment applies that recipe to the certificate's basin
objects; the reactive side mirrors uncertainty-triggered retrieval (FLARE
arXiv:2305.06983, DRAGIN arXiv:2403.10081).

Run:  python experiments/sigma0_scheduled_grounding.py     (numpy + scipy, seconds, CPU)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from scipy.linalg import solve_discrete_lyapunov

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "data" / "sigma0" / "scheduled_grounding_report.json"

HORIZON = 40
NOISE = 0.001
DRIVE = 0.05        # fresh-evidence input magnitude for the healthy (grounded) twin
CONSEC = 3          # consecutive sub-threshold EWMA steps required to alarm
EWMA_ALPHA = 0.5
FPR_CAP = 0.05      # a usable threshold must false-alarm on <=5% of healthy traces
REL_BUDGETS = (0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0)
QUANTILES = (0.05, 0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 25.0)


def max_V_on_ball(x, P, B):
    """Exact max_{||a||<=B} (x+a)^T P (x+a) — trust-region subproblem via secular
    equation (same routine as experiments/sigma0_grounding_deadline.py)."""
    lam, U = np.linalg.eigh(P)
    z = U.T @ x
    lo, hi = lam[-1] + 1e-12, lam[-1] + 1e6
    for _ in range(200):
        mu = 0.5 * (lo + hi)
        a = lam * z / (mu - lam)
        if np.linalg.norm(a) > B:
            lo = mu
        else:
            hi = mu
    a = lam * z / (mu - lam)
    n = np.linalg.norm(a)
    if n > 1e-12:
        a = a / n * B
    w = z + a
    return float(w @ (lam * w))


def make_case(A, c=4.0, label=""):
    P = solve_discrete_lyapunov(A.T, np.eye(A.shape[0]))
    lmax = float(np.max(np.linalg.eigvalsh(P)))
    gamma = 1.0 - 1.0 / lmax
    half_life = float(np.log(2) / np.log(1 / gamma))
    cadence = max(1, min(int(round(half_life / 2)), HORIZON - 1))
    return {"A": A, "P": P, "c": c, "V0": 0.9 * c, "lmax": lmax,
            "gamma": gamma, "cond_P": float(np.linalg.cond(P)),
            "B_star_inf": float(np.sqrt(c / lmax)), "half_life": half_life,
            "cadence": cadence, "label": label}


def _shell_state(case, rng):
    x = rng.standard_normal(case["A"].shape[0])
    return x / np.sqrt(x @ case["P"] @ x) * np.sqrt(case["V0"])


def healthy_signal(case, n_steps, rng):
    """EWMA step displacement of the grounded twin: externally driven each step
    (fresh evidence arriving) and restored to the V0 shell (grounding cadence 1)."""
    A, P, V0 = case["A"], case["P"], case["V0"]
    x, out, ema = _shell_state(case, rng), [], None
    for _ in range(n_steps):
        u = rng.standard_normal(x.shape)
        u = u / np.linalg.norm(u) * DRIVE
        x_new = A @ x + u + NOISE * rng.standard_normal(x.shape)
        x_new = x_new / np.sqrt(x_new @ P @ x_new) * np.sqrt(V0)
        s = float(np.linalg.norm(x_new - x))
        ema = s if ema is None else EWMA_ALPHA * s + (1 - EWMA_ALPHA) * ema
        out.append(ema)
        x = x_new
    return out


def collapse_trace(case, n_steps, rng):
    """Ungrounded rollout: states (index 0..n_steps) plus EWMA step-displacement signal."""
    A = case["A"]
    x, xs, sig, ema = _shell_state(case, rng), [], [], None
    xs.append(x.copy())
    for _ in range(n_steps):
        x_new = A @ x + NOISE * rng.standard_normal(x.shape)
        s = float(np.linalg.norm(x_new - x))
        ema = s if ema is None else EWMA_ALPHA * s + (1 - EWMA_ALPHA) * ema
        sig.append(ema)
        xs.append(x_new.copy())
        x = x_new
    return xs, sig


def gen_traces(case, seeds, n_steps=HORIZON):
    healthy = [healthy_signal(case, n_steps, np.random.default_rng(10_000 + s))
               for s in range(seeds)]
    collapse = [collapse_trace(case, n_steps, np.random.default_rng(20_000 + s))
                for s in range(seeds)]
    return healthy, collapse


def alarm_time(sig, theta, consec=CONSEC):
    """First state index with `consec` consecutive sub-theta EWMA hits; None if never."""
    run = 0
    for i, s in enumerate(sig):
        run = run + 1 if s < theta else 0
        if run >= consec:
            return i + 1
    return None


def threshold_sweep(healthy, collapse):
    """Score every healthy-quantile threshold: per-trace FPR and collapse alarm times."""
    pool = np.concatenate(healthy)
    rows = []
    for q in QUANTILES:
        theta = float(np.percentile(pool, q))
        fpr = float(np.mean([alarm_time(h, theta) is not None for h in healthy]))
        alarms = [alarm_time(sig, theta) for _, sig in collapse]
        fired = [a for a in alarms if a is not None]
        rows.append({"quantile_pct": q, "theta": round(theta, 6), "fpr": round(fpr, 3),
                     "fire_rate": round(len(fired) / len(collapse), 3),
                     "median_alarm": float(np.median(fired)) if fired else None})
    return rows


def pick_theta(sweep_rows):
    """Most charitable usable threshold: highest theta (earliest alarms) with FPR <= cap."""
    ok = [r for r in sweep_rows if r["fpr"] <= FPR_CAP and r["median_alarm"] is not None]
    return max(ok, key=lambda r: r["theta"]) if ok else None


def race(case, B, theta, collapse):
    """One decisive grounding event per policy; success = escape (V(x+a) > c) at fire time."""
    P, c, k = case["P"], case["c"], case["cadence"]
    sched_ok = react_ok = 0
    alarms = []
    for xs, sig in collapse:
        if max_V_on_ball(xs[k], P, B) > c:
            sched_ok += 1
        a = alarm_time(sig, theta)
        alarms.append(a)
        if a is not None and max_V_on_ball(xs[a], P, B) > c:
            react_ok += 1
    n = len(collapse)
    fired = [a for a in alarms if a is not None]
    return {"budget": round(B, 4), "rel_budget": round(B / case["B_star_inf"], 3),
            "scheduled_success": round(sched_ok / n, 3),
            "reactive_success": round(react_ok / n, 3),
            "median_alarm": float(np.median(fired)) if fired else None}


def timing_sweep(case, budgets, times, collapse):
    """Escape success at forced fire times — the timing-(in)difference measurement."""
    P, c = case["P"], case["c"]
    grid = {}
    for B in budgets:
        row = {}
        for t in times:
            ok = sum(max_V_on_ball(xs[t], P, B) > c for xs, _ in collapse)
            row[str(t)] = round(ok / len(collapse), 3)
        grid[str(B)] = row
    return grid


def deadline(case, B):
    """n*(B): the inequality's NECESSARY-condition deadline (alignment-optimistic;
    context only). None when B >= ceiling or the basin barely contracts."""
    if B >= case["B_star_inf"] or case["gamma"] > 0.999:
        return None
    num = np.sqrt(case["V0"])
    den = np.sqrt(case["c"]) - B * np.sqrt(case["lmax"])
    return float(2 * np.log(num / den) / np.log(1 / case["gamma"]))


def min_budget_for(rows, key, target=0.9):
    hits = [r["budget"] for r in rows if r[key] >= target]
    return min(hits) if hits else None


def run_race_case(case, budgets, seeds=200):
    print(f"== {case['label']}: gamma={case['gamma']:.3f}  cond(P)={case['cond_P']:.1f}  "
          f"B*_inf={case['B_star_inf']:.4f}  half-life={case['half_life']:.1f}  "
          f"cadence k={case['cadence']} ==")
    healthy, collapse = gen_traces(case, seeds)
    sweep = threshold_sweep(healthy, collapse)
    chosen = pick_theta(sweep)
    if chosen is None:
        print("  no canary threshold satisfies the FPR cap — reactive has no usable alarm")
    else:
        print(f"  canary: theta={chosen['theta']} (healthy q{chosen['quantile_pct']}%, "
              f"FPR={chosen['fpr']}, median alarm step {chosen['median_alarm']})")
    rows = []
    for B in budgets:
        r = race(case, B, chosen["theta"] if chosen else -1.0, collapse)
        nstar = deadline(case, B)
        r["necessary_deadline"] = None if nstar is None else round(nstar, 1)
        rows.append(r)
        print(f"  B={r['budget']:.4f} ({r['rel_budget']:.2f}xB*inf)  "
              f"scheduled {r['scheduled_success']:.2f}  reactive {r['reactive_success']:.2f}  "
              f"necessary-deadline {r['necessary_deadline']}")
    mb_s = min_budget_for(rows, "scheduled_success")
    mb_r = min_budget_for(rows, "reactive_success")
    premium = (mb_r / mb_s) if (mb_s and mb_r) else None
    label = ("unbounded (reactive never reaches 90%)" if mb_s and mb_r is None
             else (round(premium, 2) if premium else None))
    print(f"  min budget @90%: scheduled={mb_s}  reactive={mb_r}  ALARM PREMIUM = {label}")
    return {"label": case["label"], "gamma": round(case["gamma"], 4),
            "cond_P": round(case["cond_P"], 1), "B_star_inf": round(case["B_star_inf"], 4),
            "half_life": round(case["half_life"], 2), "cadence": case["cadence"],
            "canary": chosen, "threshold_sweep": sweep, "race": rows,
            "min_budget_scheduled": mb_s, "min_budget_reactive": mb_r,
            "alarm_premium": None if premium is None else round(premium, 2),
            "alarm_premium_unbounded": bool(mb_s and mb_r is None)}


def run_sliver_case(case, budgets=(0.05, 0.2, 0.4), times=(1, 5, 10, 20, 39), seeds=200):
    print(f"== {case['label']}: gamma={case['gamma']:.6f}  cond(P)={case['cond_P']:.0f}  "
          f"B*_inf={case['B_star_inf']:.4f} — forced fire-time sweep (timing-indifference) ==")
    _, collapse = gen_traces(case, seeds)
    grid = timing_sweep(case, budgets, times, collapse)
    indifferent = all(v >= 0.95 for row in grid.values() for v in row.values())
    for B, row in grid.items():
        print(f"  B={B}: " + "  ".join(f"t={t}:{v:.2f}" for t, v in row.items()))
    print(f"  timing-indifferent (all cells >= 0.95): {indifferent}")
    return {"label": case["label"], "gamma": round(case["gamma"], 6),
            "cond_P": round(case["cond_P"], 0), "B_star_inf": round(case["B_star_inf"], 4),
            "fire_time_grid": grid, "timing_indifferent": bool(indifferent)}


def main() -> None:
    report = {"claim": "one decisive grounding event: firing on the certificate-derived "
                       "cadence succeeds at a fraction of the budget that firing on a "
                       "critical-slowing-down alarm needs (the alarm premium); in the "
                       "sliver regime timing is indifferent (the Ouro-null retrodiction)",
              "verification": "exact trust-region escape check at fire time; canary swept "
                              "over healthy-quantile thresholds (no cherry-picked "
                              "calibration); n*(B) shown as the necessary-condition curve, "
                              "context only",
              "evidence_class": "MEASURED (synthetic maps; design-consequence check, not a theorem)",
              "issue": "#2690", "cases": []}

    well = make_case(np.diag([0.9, 0.92, 0.95]), label="well_conditioned")
    rep_w = run_race_case(well, [round(r * well["B_star_inf"], 4) for r in REL_BUDGETS])
    report["cases"].append(rep_w)

    print()
    sliver = make_case(np.array([[0.6, 9.0, 3.0], [0.0, 0.7, 9.0], [0.0, 0.0, 0.8]]),
                       label="nonnormal_sliver")
    rep_s = run_sliver_case(sliver)
    report["cases"].append(rep_s)

    prem_ok = rep_w["alarm_premium_unbounded"] or \
        (rep_w["alarm_premium"] is not None and rep_w["alarm_premium"] >= 1.3)
    ok = prem_ok and rep_w["min_budget_scheduled"] is not None and rep_s["timing_indifferent"]
    verdict = ("VERDICT: alarm premium confirmed in the well-conditioned regime; timing-"
               "indifference confirmed in the sliver regime" if ok else
               "VERDICT: design consequence NOT supported — reconcile before citing")
    report["verdict_ok"] = bool(ok)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\n{verdict}\n-> {OUT.relative_to(REPO)}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
