"""
The horse with blinders — surprise, reality-coupling, and the spook.

Two horses track the same world with a Kalman filter. Each runs predict → look →
update, and a SurpriseMonitor reads the innovation (surprise vs. uncertainty)
*before* each correction.

  full sight (high reality-coupling G=6/6):  observes every dimension.
  blinders   (low  reality-coupling G=5/6):  cannot see dimension 5 — the blind spot.

At t_bag a plastic bag blows into the blind spot: a jump in dimension 5. The true
dynamics couple dimension 5 into an observed dimension (0), so the bag eventually
"rustles" into view. What the run is built to show:

  • full-sight horse sees the bag directly → one surprise blip → corrects → calm.
  • blinders horse is CONFIDENTLY WRONG in the gap: its dim-5 estimate drifts from
    reality while its surprise stays LOW — it doesn't know it doesn't know.
  • when the coupling reaches the observed dimension, the blinders horse's NIS
    spikes far past the χ² threshold — the spook. It discovers, late and violently,
    that its model and reality stopped matching.

The moral is the convergence thesis from the other side: low reality-coupling
doesn't feel like danger from the inside — it feels like calm, right up until the
rustle. Surprise relative to uncertainty is the eyes on the back of the neck.

Reproducible: fixed seed, no network, no external data. Writes a JSON artifact.
Run:  python experiments/sigma0_horse_blinders.py
"""
from __future__ import annotations

import json
import os
import sys

import torch

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

from src.cio_sde import SurpriseMonitor, kalman_predict

SEED = 3
DIM = 6
BLIND = 5            # dimension the blinkered horse cannot observe
STEPS = 70
DT = 0.1
T_BAG = 25           # the plastic bag blows into the blind spot
BAG = 6.0            # impulse magnitude
COUPLING = 0.9       # A_true[0, BLIND]: the bag eventually "rustles" into dim 0
R_MEAS = 0.05        # measurement noise
Q_PROC = 0.01        # process noise
ARTIFACT = os.path.join("data", "sigma0_horse_blinders_report.json")


def main():
    torch.manual_seed(SEED)

    # true dynamics: stable, with dim 5 leaking into observed dim 0
    A = -0.2 * torch.eye(DIM)
    A[BLIND, BLIND] = -0.05               # the bag's effect lingers in the blind spot
    A[0, BLIND] = COUPLING                # ...then rustles into an observed dimension
    F = torch.eye(DIM) + DT * A
    Q = Q_PROC * torch.eye(DIM)

    # observation models — C selects which dims each horse can see
    C_full = torch.eye(DIM)
    keep = [i for i in range(DIM) if i != BLIND]
    C_blind = torch.eye(DIM)[keep]        # (5, 6): every dim except the blind spot

    def mk(C):  # batched (B=1) tensors for the monitor
        m = C.shape[0]
        return {"C": C.unsqueeze(0), "R": R_MEAS * torch.eye(m).unsqueeze(0),
                "x": w.clone().unsqueeze(0), "sigma": (0.1 * torch.eye(DIM)).unsqueeze(0)}

    mon = SurpriseMonitor(spook_sigmas=3.0)
    w = torch.zeros(DIM)                  # true world state
    horses = {"full_sight": mk(C_full), "blinders": mk(C_blind)}

    series = {name: [] for name in horses}
    first_spook = {name: None for name in horses}

    for t in range(STEPS):
        # advance the true world; drop the bag into the blind spot at t_bag
        w = w @ F.T + Q_PROC ** 0.5 * torch.randn(DIM)
        if t == T_BAG:
            w[BLIND] += BAG

        for name, h in horses.items():
            C, R = h["C"], h["R"]
            x_pred, sig_pred = kalman_predict(h["x"], h["sigma"], F, Q)
            # observe only the dimensions this horse can see
            m = C.shape[1]
            y = (C @ w.unsqueeze(0).unsqueeze(-1)).squeeze(-1) + R_MEAS ** 0.5 * torch.randn(1, m)
            s = mon.evaluate(x_pred, sig_pred, y, C, R)
            x_upd, sig_upd = mon.update(x_pred, sig_pred, y, C, R)
            h["x"], h["sigma"] = x_upd, sig_upd

            err = (x_upd.squeeze(0) - w).norm().item()
            blind_err = abs(x_upd.squeeze(0)[BLIND].item() - w[BLIND].item())
            nis = s["nis"].item()
            spook = bool(s["spook"].item())
            if spook and first_spook[name] is None and t >= T_BAG:
                first_spook[name] = t
            series[name].append({"t": t, "nis": round(nis, 3),
                                  "surprise": round(s["surprise"].item(), 3),
                                  "err": round(err, 3), "blind_err": round(blind_err, 3),
                                  "spook": spook})

    dof = {"full_sight": DIM, "blinders": DIM - 1}
    report = {
        "config": {"dim": DIM, "blind_dim": BLIND, "steps": STEPS, "t_bag": T_BAG,
                   "bag": BAG, "coupling": COUPLING, "seed": SEED},
        "reality_coupling_G": {"full_sight": round(DIM / DIM, 3),
                               "blinders": round((DIM - 1) / DIM, 3)},
        "spook_threshold": {n: round(dof[n] + 3.0 * (2 * dof[n]) ** 0.5, 2) for n in dof},
        "first_spook_step": first_spook,
        "series": series,
    }
    os.makedirs(os.path.dirname(ARTIFACT), exist_ok=True)
    with open(ARTIFACT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    # ── human-readable: key moments ──
    def row(name, t):
        r = series[name][t]
        flag = "  SPOOK" if r["spook"] else ""
        return (f"  {name:<11} NIS={r['nis']:8.2f}  surprise={r['surprise']:8.2f}  "
                f"err={r['err']:6.3f}  blind_err={r['blind_err']:6.3f}{flag}")

    print("horse with blinders — reality-coupling and the spook")
    print(f"  full_sight G=1.00 (sees 6/6)   blinders G=0.83 (sees 5/6, blind to dim {BLIND})")
    print(f"  spook threshold:  full_sight NIS>{report['spook_threshold']['full_sight']}  "
          f"blinders NIS>{report['spook_threshold']['blinders']}")
    bspook = first_spook["blinders"]
    marks = [T_BAG - 1, T_BAG, T_BAG + 3, T_BAG + 6]
    if bspook is not None:
        marks += [bspook]
    for t in sorted(set(m for m in marks if 0 <= m < STEPS)):
        tag = ("  ← bag drops in blind spot" if t == T_BAG else
               "  ← blinders SPOOK" if t == bspook else "")
        print(f"\nt={t}{tag}")
        print(row("full_sight", t))
        print(row("blinders", t))

    print("\n— summary —")
    print(f"  full_sight first spook after bag: {first_spook['full_sight']}  "
          "(sees the bag directly, corrects, no late blow-up)")
    print(f"  blinders   first spook after bag: {first_spook['blinders']}  "
          f"(blind during the gap — calm while wrong — then spikes when it rustles in)")
    gap = (bspook - T_BAG) if bspook is not None else None
    print(f"  the gap (bag → spook) for the blinkered horse: {gap} steps of confident error.")
    print(f"\nartifact: {ARTIFACT}")

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        ts = [r["t"] for r in series["full_sight"]]
        fig, ax = plt.subplots(2, 1, figsize=(8, 6), sharex=True)
        for name, style in (("full_sight", "o-"), ("blinders", "x--")):
            ax[0].plot(ts, [r["nis"] for r in series[name]], style, ms=3, label=name)
            ax[1].plot(ts, [r["blind_err"] for r in series[name]], style, ms=3, label=name)
        ax[0].axhline(report["spook_threshold"]["blinders"], color="red", ls=":", lw=1,
                      label="spook threshold")
        for a in ax:
            a.axvline(T_BAG, color="grey", ls=":", lw=1)
            if bspook is not None:
                a.axvline(bspook, color="green", ls=":", lw=1)
            a.legend(fontsize=8)
        ax[0].set_ylabel("NIS (surprise vs. uncertainty)")
        ax[0].set_yscale("log")
        ax[1].set_ylabel("error in the blind dimension")
        ax[1].set_xlabel("step  (grey = bag drops, green = blinders spook)")
        ax[0].set_title("The horse with blinders: calm while wrong, then the spook")
        plt.tight_layout()
        png = os.path.join("data", "sigma0_horse_blinders.png")
        plt.savefig(png, dpi=120)
        print(f"plot:     {png}")
    except Exception as e:  # noqa: BLE001
        print(f"(plot skipped: {e})")


if __name__ == "__main__":
    main()
