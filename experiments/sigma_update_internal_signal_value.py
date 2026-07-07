"""#2225 / N1 — does a FREE internal signal extend the scarce external-holdout budget?

PRE-REGISTERED HYPOTHESIS (H1, 2026-07-07): combining the external holdout score with an
independent *internal* signal (a checkpoint-intrinsic measurement — collapse canary, perplexity,
entropy — that consumes NO held-out data) extends the fixed-holdout budget measured in #2226
(experiments/sigma_update_holdout_staleness.py). Mechanism: holdout staleness is driven by the
champion's STUCK lucky draw; an inverse-variance combination shrinks the stuck-luck variance
(w_h^2*s_h^2 + w_i^2*s_i^2 < s_h^2), so selection ratchets toward truth instead of luck.
FALSIFIED IF: fixed-holdout + internal extracts no more true quality than fixed-holdout alone
at small n. NOVEL OUTPUT IF CONFIRMED: the "verification-equivalent value" of an internal
signal — how many fresh verified examples a signal of quality s_i is worth.

Model (same adaptive hill-climb as #2226, 32 seeds, deterministic LCG):
  candidate true quality theta; external score H = theta + e_h, e_h ~ N(0, 1/sqrt(n));
  internal score I = theta + e_i, e_i ~ N(0, s_i)  — INTRINSIC to the checkpoint, so the
  champion's e_i is as stuck as its e_h (measuring the same checkpoint twice returns the same
  number). Selection on S = w_h*H + w_i*I with inverse-variance weights. The gate accepts the
  higher S. FIXED holdout: champion's e_h sticks. FRESH: e_h re-drawn per gate.
"""
import math, statistics, json

K, ROUNDS, SIGMA_STEP, SEEDS = 8, 400, 0.05, 32

def run(n, s_i=None, fresh=False, seed=0):
    state = (seed * 2654435761 + 12345) & 0xFFFFFFFF
    def u():
        nonlocal state
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        return (state + 1) / 0x80000000
    def gauss():
        return math.sqrt(-2 * math.log(u())) * math.cos(2 * math.pi * u())
    s_h = 1.0 / math.sqrt(n)
    if s_i is None:
        w_h, w_i = 1.0, 0.0
    else:
        w_h = (1 / s_h ** 2) / (1 / s_h ** 2 + 1 / s_i ** 2)
        w_i = 1.0 - w_h
    champ_theta = 0.0
    champ_eh = gauss() * s_h
    champ_ei = gauss() * s_i if s_i else 0.0
    champ_score = w_h * (champ_theta + champ_eh) + w_i * (champ_theta + champ_ei)
    for _ in range(ROUNDS):
        if fresh:                                  # fresh holdout re-measures the champion
            champ_eh = gauss() * s_h
            champ_score = w_h * (champ_theta + champ_eh) + w_i * (champ_theta + champ_ei)
        for _ in range(K):
            c_theta = champ_theta + gauss() * SIGMA_STEP
            c_eh = gauss() * s_h
            c_ei = gauss() * s_i if s_i else 0.0
            c_score = w_h * (c_theta + c_eh) + w_i * (c_theta + c_ei)
            if c_score > champ_score:
                champ_theta, champ_eh, champ_ei, champ_score = c_theta, c_eh, c_ei, c_score
    return champ_theta

def avg(n, s_i=None, fresh=False):
    return statistics.mean(run(n, s_i, fresh, seed=s) for s in range(SEEDS))

if __name__ == "__main__":
    NS = [50, 100, 200, 500, 1000, 2000]
    SIS = [None, 2.0, 1.0, 0.5, 0.25, 0.1]
    print("H1 test: TRUE quality extracted by a FIXED holdout + internal signal of noise s_i")
    print("(s_i=None -> holdout alone; internal is checkpoint-intrinsic, its luck sticks too)\n")
    hdr = f"{'n':>6} | " + " ".join(f"{'alone' if s is None else 's_i='+str(s):>9}" for s in SIS) + f" | {'FRESH alone':>11}"
    print(hdr); print("-" * len(hdr))
    table = {}
    for n in NS:
        row = [avg(n, s) for s in SIS]
        fr = avg(n, None, fresh=True)
        table[n] = {"alone": row[0], **{f"s_i={s}": r for s, r in zip(SIS[1:], row[1:])}, "fresh_alone": fr}
        print(f"{n:>6} | " + " ".join(f"{r:>9.2f}" for r in row) + f" | {fr:>11.2f}")
    # verification-equivalent value: what n' does holdout-ALONE need to match (n, s_i)?
    alone = [(n, table[n]["alone"]) for n in NS]
    def equiv_n(target):
        for (n1, v1), (n2, v2) in zip(alone, alone[1:]):
            if v1 <= target <= v2:
                return n1 + (n2 - n1) * (target - v1) / (v2 - v1 + 1e-12)
        return float('nan') if target < alone[0][1] else float('inf')
    print("\nVERIFICATION-EQUIVALENT VALUE (holdout-alone size n' matching n + internal):")
    for n in [50, 100, 200]:
        for s in [1.0, 0.5, 0.25]:
            e = equiv_n(table[n][f"s_i={s}"])
            mult = (e / n) if e == e and e != float('inf') else float('nan')
            print(f"  n={n:>4} + internal(s_i={s}) ~= holdout-alone n'={e:9.0f}  ({mult:5.1f}x)")
    gain50 = table[50]["s_i=0.5"] / max(table[50]["alone"], 1e-9)
    verdict = ("H1 CONFIRMED — internal signal extends the fixed-holdout budget"
               if table[50]["s_i=0.5"] > table[50]["alone"] * 1.5 else
               "H1 WEAK/FALSIFIED — no meaningful budget extension at small n")
    print(f"\nVERDICT: {verdict} (n=50: alone={table[50]['alone']:.2f} vs +s_i=0.5 -> {table[50]['s_i=0.5']:.2f}, {gain50:.1f}x)")

    # Robustness: maybe inverse-variance is the wrong combiner under ratchet dynamics — sweep the
    # weight directly. MEASURED outcome (2026-07-07): extraction is FLAT then strictly WORSE as
    # weight shifts to the internal signal (n=50, s_i=0.5: w_i 0->.1->.25->.5->.9 gives
    # 0.64->0.65->0.49->0.18->0.10) — the falsification is not a weighting artifact.
    def run_w(n, s_i, w_i, seed=0):
        state = (seed * 2654435761 + 12345) & 0xFFFFFFFF
        def u():
            nonlocal state
            state = (1103515245 * state + 12345) & 0x7FFFFFFF
            return (state + 1) / 0x80000000
        def g():
            return math.sqrt(-2 * math.log(u())) * math.cos(2 * math.pi * u())
        s_h = 1.0 / math.sqrt(n); w_h = 1.0 - w_i
        ct, ceh, cei = 0.0, g() * s_h, g() * s_i
        cs = w_h * (ct + ceh) + w_i * (ct + cei)
        for _ in range(ROUNDS):
            for _ in range(K):
                t = ct + g() * SIGMA_STEP; eh = g() * s_h; ei = g() * s_i
                s = w_h * (t + eh) + w_i * (t + ei)
                if s > cs:
                    ct, ceh, cei, cs = t, eh, ei, s
        return ct
    print("\nROBUSTNESS — weight sweep at n=50 (is the null a combiner artifact?):")
    for s_i in (0.5, 0.25):
        vals = [(w, statistics.mean(run_w(50, s_i, w, seed=s) for s in range(SEEDS)))
                for w in (0.0, 0.1, 0.25, 0.5, 0.75, 0.9)]
        print(f"  s_i={s_i}: " + "  ".join(f"w_i={w:.2f}->{v:.2f}" for w, v in vals))
    print("\nREFINED LAW (the novel negative): FRESHNESS, not externality, is the active ingredient")
    print("of grounding — any checkpoint-INTRINSIC signal (its error sticks with the champion just")
    print("like a fixed holdout's luck) cannot substitute for re-drawn external measurements.")
    print(json.dumps({str(n): {k: round(v, 3) for k, v in d.items()} for n, d in table.items()}))
