"""
Seeing the wall by knowing where it isn't — canaries, the qutrit, and the horizon.

Three claims, made measurable on a system whose true wall is known analytically:

  "put canaries through from outside even if you can't see them"
      → fire a grid of probe trajectories; never observe the boundary directly,
        infer it from where the canaries END UP.
  "see the wall by knowing where it isn't"  (your Impossibility Engine:
        Knowledge = remaining states after constraint elimination)
      → the wall is the NEGATIVE SPACE — the cells where neighboring canaries land
        in different basins. You carve it out by complement, never by direct sight.
  "a third state beyond in/out"  (the qutrit intuition)
      → label every cell ternary: basin-A (0), basin-B (1), ON-THE-WALL (2).
        The third state is the separatrix itself.

The test system is the double well  V(x,y) = (x²−1)² + y²,  gradient flow
  ẋ = 4x − 4x³,  ẏ = −2y.
Two stable wells at x=±1, a saddle at x=0. **The true separatrix is exactly x=0** —
so the recovered wall can be CHECKED against ground truth, not just asserted.

It also marks the honest ceiling (the event horizon): a one-way ABSORBING trap.
Canaries that enter it never return a basin. From outside you can locate the trap's
EDGE (where canaries start disappearing — the "shadow") but never classify its
INTERIOR. That is exactly how a black hole is actually imaged: the photon ring from
outside, the inside dark — because nothing comes back, not because you lack cleverness.

Reproducible: deterministic grid, no network, no external data. Writes a JSON artifact.
Run:  python experiments/sigma0_boundary_qutrit.py
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

DOMAIN = 1.5
DT = 0.01
STEPS = 1500
ARTIFACT = os.path.join("data", "sigma0_boundary_qutrit_report.json")

# qutrit labels (+ an "unknown" for the one-way interior)
A, B, WALL, UNKNOWN = 0, 1, 2, 3


def fire_canaries(N, trap=None):
    """Integrate the gradient flow from an N×N grid of starting points (the canaries).

    Returns (basin, absorbed, Xgrid). basin = sign-of-final-x well; absorbed = entered
    a one-way trap and never returned.
    """
    axis = np.linspace(-DOMAIN, DOMAIN, N)
    X0, Y0 = np.meshgrid(axis, axis, indexing="xy")
    x, y = X0.copy(), Y0.copy()
    absorbed = np.zeros_like(x, dtype=bool)
    for _ in range(STEPS):
        live = ~absorbed
        x[live] = x[live] + DT * (4.0 * x[live] - 4.0 * x[live] ** 3)
        y[live] = y[live] + DT * (-2.0 * y[live])
        if trap is not None:
            cx, cy, r = trap
            inside = ((x - cx) ** 2 + (y - cy) ** 2 < r * r) & live
            absorbed |= inside                       # one-way: once in, never reported
    basin = np.where(x < 0.0, A, B)
    return basin, absorbed, X0


def label_qutrit(basin, absorbed):
    """Negative-space wall detection: a cell is WALL iff a 4-neighbor's basin differs."""
    diff = np.zeros_like(basin, dtype=bool)
    diff[:-1, :] |= basin[:-1, :] != basin[1:, :]
    diff[1:, :] |= basin[:-1, :] != basin[1:, :]
    diff[:, :-1] |= basin[:, :-1] != basin[:, 1:]
    diff[:, 1:] |= basin[:, :-1] != basin[:, 1:]
    label = basin.astype(int).copy()
    label[diff] = WALL
    label[absorbed] = UNKNOWN
    return label


def main():
    report = {"true_separatrix": "x = 0", "resolution_scan": [], "horizon": {}}

    # ── Part A: map the wall from outside, verify against the true separatrix x=0 ──
    print("seeing the wall by where it isn't — verified against ground truth (x=0)")
    print(f"\n{'grid N':>6} | {'spacing':>9} | {'max|x| on wall':>14} | "
          f"{'mean|x| on wall':>15} | {'within 1 cell?':>14}")
    print("-" * 74)
    for N in [20, 40, 80, 160]:
        basin, absorbed, X0 = fire_canaries(N)
        label = label_qutrit(basin, absorbed)
        spacing = 2.0 * DOMAIN / (N - 1)
        wall_x = np.abs(X0[label == WALL])
        max_x, mean_x = float(wall_x.max()), float(wall_x.mean())
        ok = max_x <= spacing + 1e-9
        report["resolution_scan"].append(
            {"N": N, "spacing": round(spacing, 4), "max_abs_x_on_wall": round(max_x, 4),
             "mean_abs_x_on_wall": round(mean_x, 4), "within_one_cell": bool(ok)})
        print(f"{N:>6} | {spacing:>9.4f} | {max_x:>14.4f} | {mean_x:>15.4f} | "
              f"{str(ok):>14}")
    print("→ recovered wall sits on x=0 to within one grid cell, and sharpens as you")
    print("  fire more canaries. Resolution = sampling = coupling. Never seen directly.")

    # ── Part B: the one-way horizon — a trap whose interior cannot be mapped ──
    trap = (0.5, 0.6, 0.18)                       # localized one-way region in basin B
    #                                               (off both wells, so it's an obstacle,
    #                                                not a basin-swallowing sink)
    N = 120
    basin, absorbed, X0 = fire_canaries(N, trap=trap)
    label = label_qutrit(basin, absorbed)
    n_unknown = int((label == UNKNOWN).sum())
    # the "shadow edge": live cells touching an absorbed neighbor (detectable from outside)
    edge = np.zeros_like(absorbed)
    edge[:-1, :] |= absorbed[1:, :] & ~absorbed[:-1, :]
    edge[1:, :] |= absorbed[:-1, :] & ~absorbed[1:, :]
    edge[:, :-1] |= absorbed[:, 1:] & ~absorbed[:, :-1]
    edge[:, 1:] |= absorbed[:, :-1] & ~absorbed[:, 1:]
    n_edge = int((edge & ~absorbed).sum())
    report["horizon"] = {"trap": {"cx": trap[0], "cy": trap[1], "r": trap[2]},
                         "unmappable_interior_cells": n_unknown,
                         "detectable_shadow_edge_cells": n_edge}

    print(f"\nthe one-way horizon (absorbing trap at x={trap[0]}, r={trap[2]}):")
    print(f"  interior cells that returned NO canary (unmappable): {n_unknown}")
    print(f"  shadow-edge cells you CAN locate from outside:       {n_edge}")
    print("  → you map the boundary (the shadow), never the interior — because nothing")
    print("    comes back, not because you lack cleverness. The photon ring, not the inside.")

    os.makedirs(os.path.dirname(ARTIFACT), exist_ok=True)
    with open(ARTIFACT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print("\n— what this does and doesn't buy you —")
    print("  DOES:  map a basin wall from outside, verified to a grid cell; ternary")
    print("         {A, B, wall} labelling; the wall as pure negative space.")
    print("  DOESN'T: remove the energy cost of RIDING the wall (see sigma0_saddle_ride —")
    print("         the map says WHERE the ridge is; control still pays to stay on it),")
    print("         and DOESN'T see inside a one-way region. The qutrit is a 3-state")
    print("         classifier here, not a quantum bypass of a causal horizon.")
    print(f"\nartifact: {ARTIFACT}")

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.colors import ListedColormap
        cmap = ListedColormap(["#3b6fb0", "#b07a3b", "#111111", "#cc3333"])  # A,B,wall,unknown
        plt.figure(figsize=(5.4, 5.0))
        plt.imshow(label, origin="lower", extent=[-DOMAIN, DOMAIN, -DOMAIN, DOMAIN],
                   cmap=cmap, vmin=0, vmax=3, interpolation="nearest")
        plt.axvline(0.0, color="white", ls=":", lw=1)        # true separatrix
        plt.title("canaries map the wall (black=x≈0) by negative space;\n"
                  "red trap = one-way interior, unmappable", fontsize=9)
        plt.xlabel("x"); plt.ylabel("y")
        png = os.path.join("data", "sigma0_boundary_qutrit.png")
        plt.tight_layout(); plt.savefig(png, dpi=120)
        print(f"plot:     {png}")
    except Exception as e:  # noqa: BLE001
        print(f"(plot skipped: {e})")


if __name__ == "__main__":
    main()
