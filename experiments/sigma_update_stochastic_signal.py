"""#2692 / E-P — can RE-DRAWABLE MEASUREMENT NOISE substitute for re-drawn truth?

The §8.4.1 freshness law ("internal signals detect; only fresh truth selects") pins the
active ingredient on RE-DRAWABILITY: a deterministic checkpoint statistic cannot re-anchor
the selection ratchet because its error sticks with the champion. But a class of internal
signals is stochastic — self-consistency over re-drawn sampling seeds, MC-dropout,
resampled-prompt batteries: their sampling noise re-rolls per measurement while their BIAS
is still checkpoint-fixed. This experiment decomposes the internal signal accordingly:

    I = theta + b + m,   b ~ N(0, s_b) drawn ONCE per candidate (sticks — checkpoint-fixed
                          bias),  m ~ N(0, s_m) RE-DRAWN on every measurement (per gate).

The deterministic N1 arm (experiments/sigma_update_internal_signal_value.py) is the
s_m = 0 corner; a fresh unbiased measurement is the s_b = 0 corner.

PRE-REGISTERED HYPOTHESES (2026-07-17, before the run):
  H-P1 (mechanism): at FIXED TOTAL error (s_b^2 + s_m^2 = const), best-weight extraction
    increases as error mass moves from stuck bias to re-drawn noise; the zero-bias corner
    extends the fixed-holdout budget substantially (>= 3x fixed-alone at n = 50).
  H-P2 (kill test): at FIXED bias s_b = 0.5, adding re-drawn noise s_m rescues nothing —
    best-weight extraction never reaches 1.5x the deterministic (s_m = 0) corner. If it
    does, the law's active ingredient is mis-identified and §8.4.1 must be re-stated.
  Sharpened law if both hold: an internal signal's selection value is set by its
  checkpoint-fixed BIAS component alone — "re-drawable TRUTH, not re-drawable
  MEASUREMENT, is the active ingredient of grounding."

Charity discipline: every configuration is scored at its ORACLE weight (w_i swept over
{0, .1, .25, .5, .75, .9, 1.0}, best taken) so a null cannot be blamed on the combiner —
the same robustness N1 established for the deterministic corner, built in from the start.

MEASURED OUTCOME (2026-07-17, recorded after the run — the pre-registered text above is
unchanged): H-P1 CONFIRMED, **H-P2 REFUTED — the kill condition fired.** At fixed bias,
re-drawn measurement noise rescued extraction ~8x (n=50: 0.81 -> 6.43). The POST-HOC
control below (added after seeing that result, labeled as such) identifies the mechanism:
a ZERO-INFORMATION dither — fresh noise added to every score comparison, carrying no
signal at all — reproduces the rescue. So the selection process decomposes cleanly:
score = theta + STUCK error (w_h*e_h + w_i*b, sets the ratchet) + FRESH error (w_i*m,
breaks it). ANY fresh randomness in the comparison de-ratchets the champion's seat — the
same mechanism Thresholdout exploits deliberately with Laplace noise (§8.4 third road) —
while only re-drawn TRUTH also ranks candidates, which is why fresh-alone still strictly
dominates every internal arm (12.90 > 9.36 > 6.43 > 0.81 at n=50). The §8.4.1 law is
re-stated accordingly in the certificate: deterministic internal signals neither
de-ratchet nor inform; stochastic internal signals de-ratchet but do not inform; only
fresh external truth does both.

Model: same adaptive hill-climb as #2226/#2225 (K=8 candidates/round, 400 rounds, 32
seeds, deterministic LCG, pure Python). External holdout is FIXED (the scarce regime the
law addresses); champion e_h sticks, champion bias b sticks, champion m re-drawn per gate.
Baselines: fixed holdout alone; fresh holdout alone.

Evidence class: MEASURED-by-simulation (shape, not constants).
Run:  python experiments/sigma_update_stochastic_signal.py     (pure Python, ~1 min, CPU)
"""
import json
import math
import statistics
import sys
from pathlib import Path

K, ROUNDS, SIGMA_STEP, SEEDS = 8, 400, 0.05, 32
S_TOT = 0.5
WEIGHTS = (0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0)
REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "data" / "sigma0" / "stochastic_signal_report.json"


def run(n, s_b, s_m, w_i, fresh_holdout=False, seed=0, rounds=ROUNDS, k=K):
    """One selection process; returns the champion's TRUE quality after `rounds` gates."""
    state = (seed * 2654435761 + 12345) & 0xFFFFFFFF

    def u():
        nonlocal state
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        return (state + 1) / 0x80000000

    def g():
        return math.sqrt(-2 * math.log(u())) * math.cos(2 * math.pi * u())

    s_h = 1.0 / math.sqrt(n)
    w_h = 1.0 - w_i
    champ_theta, champ_eh, champ_b = 0.0, g() * s_h, g() * s_b
    for _ in range(rounds):
        if fresh_holdout:
            champ_eh = g() * s_h                     # fresh truth: holdout error re-drawn
        champ_m = g() * s_m                          # measurement noise ALWAYS re-drawn
        champ_score = w_h * (champ_theta + champ_eh) + w_i * (champ_theta + champ_b + champ_m)
        for _ in range(k):
            t = champ_theta + g() * SIGMA_STEP
            eh, b, m = g() * s_h, g() * s_b, g() * s_m
            score = w_h * (t + eh) + w_i * (t + b + m)
            if score > champ_score:
                champ_theta, champ_eh, champ_b, champ_score = t, eh, b, score
    return champ_theta


def avg(n, s_b, s_m, w_i, fresh_holdout=False, seeds=SEEDS, rounds=ROUNDS):
    return statistics.mean(run(n, s_b, s_m, w_i, fresh_holdout, seed=s, rounds=rounds)
                           for s in range(seeds))


def best_weight(n, s_b, s_m, seeds=SEEDS, rounds=ROUNDS, weights=WEIGHTS):
    """Oracle-weight extraction: the best any combiner could do with this signal."""
    scored = [(w, avg(n, s_b, s_m, w, seeds=seeds, rounds=rounds)) for w in weights]
    w, v = max(scored, key=lambda t: t[1])
    return {"best_w": w, "value": v, "sweep": {str(wi): round(vi, 3) for wi, vi in scored}}


def run_dither(n, s_d, seed=0, rounds=ROUNDS, k=K):
    """POST-HOC control: holdout-only selection with ZERO-INFORMATION fresh dither
    (noise added to every score comparison, champion and candidates alike). If this
    reproduces the sweep-B rescue, the rescue is pure de-ratcheting, not information."""
    state = (seed * 2654435761 + 12345) & 0xFFFFFFFF

    def u():
        nonlocal state
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        return (state + 1) / 0x80000000

    def g():
        return math.sqrt(-2 * math.log(u())) * math.cos(2 * math.pi * u())

    s_h = 1.0 / math.sqrt(n)
    champ_theta, champ_eh = 0.0, g() * s_h
    for _ in range(rounds):
        champ_score = champ_theta + champ_eh + g() * s_d
        for _ in range(k):
            t = champ_theta + g() * SIGMA_STEP
            eh = g() * s_h
            score = t + eh + g() * s_d
            if score > champ_score:
                champ_theta, champ_eh, champ_score = t, eh, score
    return champ_theta


def avg_dither(n, s_d, seeds=SEEDS, rounds=ROUNDS):
    return statistics.mean(run_dither(n, s_d, seed=s, rounds=rounds) for s in range(seeds))


def split_grid(s_tot=S_TOT, fracs=(1.0, 0.75, 0.5, 0.25, 0.0)):
    """(s_b, s_m) pairs at fixed total error, from all-bias to all-noise."""
    out = []
    for f in fracs:
        s_b = s_tot * f
        s_m = math.sqrt(max(s_tot ** 2 - s_b ** 2, 0.0))
        out.append((round(s_b, 4), round(s_m, 4)))
    return out


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ns = (50, 100, 200)
    report = {"issue": "#2692", "claim": "freshness-law decomposition: selection value of an "
                                         "internal signal is set by its checkpoint-fixed bias, "
                                         "not its total error; re-drawn measurement noise "
                                         "cannot rescue a stuck bias",
              "preregistered": {"H-P1": "zero-bias corner >= 3x fixed-alone at n=50; value "
                                        "increases as error moves bias -> noise at fixed total",
                                "H-P2": "at fixed s_b=0.5 no s_m reaches 1.5x the s_m=0 corner"},
              "evidence_class": "MEASURED-by-simulation (shape, not constants)",
              "baselines": {}, "sweep_A_fixed_total": {}, "sweep_B_fixed_bias": {}}

    print("== Baselines (holdout only) ==")
    for n in ns:
        fixed = avg(n, 0.0, 0.0, 0.0)
        fresh = avg(n, 0.0, 0.0, 0.0, fresh_holdout=True)
        report["baselines"][str(n)] = {"fixed_alone": round(fixed, 3), "fresh_alone": round(fresh, 3)}
        print(f"  n={n:>4}: fixed-alone {fixed:6.2f}   fresh-alone {fresh:6.2f}")

    print(f"\n== Sweep A — fixed total internal error s_tot={S_TOT}, bias->noise split "
          f"(oracle weight per cell) ==")
    grid = split_grid()
    for n in ns:
        row = {}
        for s_b, s_m in grid:
            cell = best_weight(n, s_b, s_m)
            row[f"s_b={s_b},s_m={s_m}"] = {"best_w": cell["best_w"], "value": round(cell["value"], 3)}
            print(f"  n={n:>4} s_b={s_b:<6} s_m={s_m:<6} -> best value {cell['value']:6.2f} "
                  f"(w_i={cell['best_w']})")
        report["sweep_A_fixed_total"][str(n)] = row

    print(f"\n== Sweep B — KILL TEST: fixed bias s_b={S_TOT}, adding re-drawn noise "
          f"(oracle weight per cell) ==")
    kill_rows = {}
    for n in (50, 100):
        row = {}
        for s_m in (0.0, 0.25, 0.5, 1.0):
            cell = best_weight(n, S_TOT, s_m)
            row[str(s_m)] = {"best_w": cell["best_w"], "value": round(cell["value"], 3)}
            print(f"  n={n:>4} s_b={S_TOT} s_m={s_m:<5} -> best value {cell['value']:6.2f} "
                  f"(w_i={cell['best_w']})")
        kill_rows[str(n)] = row
    report["sweep_B_fixed_bias"] = kill_rows

    print("\n== Sweep C — POST-HOC control: zero-information dither on a fixed holdout "
          "(added after sweep B fired the kill condition; labeled post-hoc) ==")
    dither_rows = {}
    for n in (50, 100):
        row = {}
        for s_d in (0.0, 0.05, 0.1, 0.2, 0.4):
            v = avg_dither(n, s_d)
            row[str(s_d)] = round(v, 3)
            print(f"  n={n:>4} dither s_d={s_d:<5} -> value {v:6.2f}")
        dither_rows[str(n)] = row
    report["sweep_C_posthoc_dither"] = dither_rows

    # --- Verdicts: pre-registered hypotheses scored as measured; exit reflects only
    # --- measurement sanity (a refutation is a valid result, not a failed run).
    a50 = report["sweep_A_fixed_total"]["50"]
    all_bias = a50[f"s_b={S_TOT},s_m=0.0"]["value"]
    no_bias = a50[f"s_b=0.0,s_m={S_TOT}"]["value"]
    fixed50 = report["baselines"]["50"]["fixed_alone"]
    fresh50 = report["baselines"]["50"]["fresh_alone"]
    hp1 = no_bias >= 3.0 * fixed50 and no_bias > all_bias
    b50 = kill_rows["50"]
    det_corner = b50["0.0"]["value"]
    rescue = max(b50[k]["value"] for k in b50 if k != "0.0")
    hp2 = rescue < 1.5 * det_corner
    d50 = dither_rows["50"]
    dither_rescue = max(v for k, v in d50.items() if k != "0.0")
    dither_attributes = dither_rescue >= 0.7 * rescue     # zero-info noise reproduces it
    fresh_dominates = fresh50 > max(no_bias, rescue, dither_rescue)
    report["verdicts"] = {
        "H-P1_mechanism_confirmed": bool(hp1),
        "H-P1_detail": f"n=50: zero-bias {no_bias:.2f} vs all-bias {all_bias:.2f} vs "
                       f"fixed-alone {fixed50:.2f}",
        "H-P2_no_rescue": bool(hp2),
        "H-P2_detail": f"n=50, s_b={S_TOT}: s_m=0 -> {det_corner:.2f}; best rescue with "
                       f"s_m>0 -> {rescue:.2f} ({rescue / max(det_corner, 1e-9):.2f}x) — "
                       f"{'no rescue' if hp2 else 'KILL CONDITION FIRED'}",
        "posthoc_dither_attribution": bool(dither_attributes),
        "posthoc_detail": f"zero-information dither alone reaches {dither_rescue:.2f} "
                          f"(vs stochastic-signal rescue {rescue:.2f}) — the rescue is "
                          f"{'de-ratcheting, not information' if dither_attributes else 'NOT fully explained by dither'}",
        "fresh_truth_still_dominates": bool(fresh_dominates),
        "ordering_n50": f"fresh-alone {fresh50:.2f} > zero-bias internal {no_bias:.2f} > "
                        f"noise-rescued stuck bias {rescue:.2f} > deterministic {det_corner:.2f} "
                        f"> fixed-alone {fixed50:.2f}",
    }
    report["restated_law"] = (
        "Selection error decomposes into a STUCK part (sets the ratchet) and a FRESH part "
        "(breaks it). Deterministic internal signals neither de-ratchet nor inform; "
        "stochastic internal signals de-ratchet but do not inform (zero-information dither "
        "reproduces their entire rescue); only re-drawn external truth does both — which is "
        "why fresh-alone still strictly dominates every internal arm.")
    print(f"\nH-P1 (mechanism): {'CONFIRMED' if hp1 else 'NOT CONFIRMED'} — "
          f"{report['verdicts']['H-P1_detail']}")
    print(f"H-P2 (kill test): {'NO RESCUE — law survives as stated' if hp2 else 'KILL CONDITION FIRED — law as stated is too strong'}")
    print(f"  {report['verdicts']['H-P2_detail']}")
    print(f"POST-HOC attribution: {report['verdicts']['posthoc_detail']}")
    print(f"ORDERING (n=50): {report['verdicts']['ordering_n50']}")
    print(f"\nRE-STATED LAW: {report['restated_law']}")
    sanity = (all(report["baselines"][str(n)]["fresh_alone"]
                  > report["baselines"][str(n)]["fixed_alone"] for n in ns)
              and no_bias > all_bias and fresh_dominates)
    report["sanity_ok"] = bool(sanity)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"-> {OUT.relative_to(REPO)}")
    sys.exit(0 if sanity else 1)


if __name__ == "__main__":
    main()
