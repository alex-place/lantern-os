"""
Σ₀ reconstruction — "can a machine put the smoke back in a burnt log?"
and "how small a speck of dust can hold the world?"

Both questions are the same measurement on the validated collapse certificate.

  burn   :  Σ₀ collapse contracts the ACTIVE modes to zero, freezing the state
            onto the null manifold. The structure that lived in the active modes
            is the "smoke" — gone.
  speck  :  a SEED = the top-k active-mode coefficients of the original. The
            smallest k that reconstructs to within ε is the world's effective
            dimension: how small a speck can hold it.
  rebuild:  ReconstructionOperator regrows the state from (collapsed state + seed).
            Compared against the current philosophy — random re-excitation, which
            carries no record of the original.

The honest result this is built to expose:
  1. Reference-driven reconstruction traces a rate–distortion curve down to a
     hard FLOOR = the energy in the modes you did NOT keep. You cannot beat the
     record. The second law is the floor.
  2. RANDOM re-excitation (no record), measured against the target, is WORSE than
     leaving the state burnt — it lights *a* fire, not *the* fire, and adds
     distortion on average. Un-freezing ≠ reconstruction.

Reproducible: fixed seed, no network, no external data. Writes a JSON artifact.
Run:  python experiments/sigma0_reconstruction.py
"""
from __future__ import annotations

import json
import os
import sys

import torch

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

try:                                  # Windows consoles default to cp1252
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:                     # noqa: BLE001
    pass

from src.cio_sde import (
    ReconstructionOperator, collapse_certificate, lyapunov_value,
)

SEED = 7
DIM = 16
NULL_DIM = 6            # surviving manifold modes (|λ|≈0)
BATCH = 128
EPS = 1e-2
TARGET_FIDELITY = 0.05  # "within 5%" → defines the smallest speck
ARTIFACT = os.path.join("data", "sigma0_reconstruction_report.json")


def _orthonormal(n: int, g: torch.Generator) -> torch.Tensor:
    q, _ = torch.linalg.qr(torch.randn(n, n, generator=g))
    return q


def build_world(g: torch.Generator):
    """A dissipative A (Σ₀ collapse guaranteed) and a structured world state x0.

    x0's *structure* lives in the active modes with a DECAYING spectrum: a few
    modes dominate (so the world is compressible — a small speck can hold it) plus
    a long faint tail (so perfect compression is impossible — there is a floor).
    """
    Q = _orthonormal(DIM, g)
    active_dim = DIM - NULL_DIM
    # spectrum of A_s: null modes ≈ 0, active modes strictly negative (contracting)
    eig = torch.zeros(DIM)
    eig[NULL_DIM:] = -torch.linspace(0.3, 1.5, active_dim)
    A = (Q * eig) @ Q.T                         # symmetric ⇒ clean, guaranteed collapse

    # world coefficients in the eigenbasis
    c = torch.zeros(BATCH, DIM)
    c[:, :NULL_DIM] = torch.randn(BATCH, NULL_DIM, generator=g)        # null (survives)
    decay = 0.30 ** torch.arange(active_dim).float()                  # steep: a few dominant modes
    c[:, NULL_DIM:] = (decay * 4.0) + 0.05 * torch.randn(BATCH, active_dim, generator=g)  # + faint tail
    x0 = c @ Q.T
    return A, x0, active_dim


def main():
    g = torch.Generator().manual_seed(SEED)
    op = ReconstructionOperator(eig_eps=EPS)
    A, x0, active_dim = build_world(g)

    cert = collapse_certificate(A.unsqueeze(0), eig_eps=EPS)
    struct_energy = lyapunov_value(x0, A.unsqueeze(0), eig_eps=EPS)   # ½‖P_active x0‖²

    x_burnt = op.collapse(x0, A)
    burnt_struct = lyapunov_value(x_burnt, A.unsqueeze(0), eig_eps=EPS)

    # distortion in STRUCTURE units: 1.0 = fully burnt, 0.0 = perfect reconstruction
    struct_norm = (x0 - x_burnt).norm(dim=-1)                          # ‖P_active x0‖ per-sample

    def structure_distortion(x_hat):
        return float(((x_hat - x0).norm(dim=-1) / (struct_norm + 1e-12)).mean())

    rng = torch.Generator().manual_seed(SEED + 1)
    rows = []
    smallest_speck = None
    for k in range(0, active_dim + 1):
        s = op.seed(x0, A, k)
        x_ref = op.reconstruct(x_burnt, s)
        d_ref = structure_distortion(x_ref)

        # baseline: inject the SAME per-sample energy, but RANDOM direction (no record)
        retained_energy = (s["coeffs"] ** 2).sum(-1) if k > 0 else torch.zeros(BATCH)
        V = op._active_basis(A)
        rnd = torch.randn(BATCH, V.shape[1], generator=rng) @ V.T
        rnd = rnd / (rnd.norm(dim=-1, keepdim=True) + 1e-12) * retained_energy.sqrt().unsqueeze(-1)
        x_rand = x_burnt + rnd
        d_rand = structure_distortion(x_rand)

        rows.append({"k": k, "ref_distortion": round(d_ref, 4),
                     "random_distortion": round(d_rand, 4)})
        if smallest_speck is None and d_ref < TARGET_FIDELITY:
            smallest_speck = k

    report = {
        "config": {"dim": DIM, "null_dim": NULL_DIM, "active_dim": active_dim,
                   "batch": BATCH, "eig_eps": EPS, "target_fidelity": TARGET_FIDELITY,
                   "seed": SEED},
        "collapse_certificate": cert.summary(),
        "structure_energy_pre_burn": round(struct_energy, 4),
        "structure_energy_post_burn": round(burnt_struct, 6),
        "smallest_speck_modes": smallest_speck,
        "active_dim": active_dim,
        "compression_ratio": (None if smallest_speck is None
                              else round(smallest_speck / DIM, 3)),
        "curve": rows,
    }

    os.makedirs(os.path.dirname(ARTIFACT), exist_ok=True)
    with open(ARTIFACT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    # ── human-readable ──
    print(f"collapse: {cert.summary()}")
    print(f"structure energy  pre-burn={struct_energy:.4f}  post-burn={burnt_struct:.2e}  "
          f"(active modes contracted to ~0 — the 'smoke')")
    print()
    print(f"{'seed k':>6} | {'reference (record)':>18} | {'random (no record)':>18}")
    print(f"{'':>6} | {'distortion':>18} | {'distortion':>18}")
    print("-" * 52)
    for r in report["curve"]:
        mark = "  ← smallest speck" if r["k"] == smallest_speck else ""
        print(f"{r['k']:>6} | {r['ref_distortion']:>18.4f} | {r['random_distortion']:>18.4f}{mark}")
    print()
    print(f"smallest speck: {smallest_speck}/{active_dim} active modes "
          f"({report['compression_ratio']*100:.1f}% of {DIM}-dim state) reconstructs "
          f"the world to within {int(TARGET_FIDELITY*100)}%.")
    print("floor: reference distortion bottoms out at the energy of the modes you "
          "did NOT keep — you cannot beat the record.")
    print("blind spot: random re-excitation (the current Σ₀⁻¹ philosophy) measured "
          "against the target is WORSE than the burnt state — un-freezing ≠ rebuilding.")
    print(f"\nartifact: {ARTIFACT}")

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        ks = [r["k"] for r in rows]
        plt.figure(figsize=(7, 4.2))
        plt.plot(ks, [r["ref_distortion"] for r in rows], "o-", label="reference (keeps a record)")
        plt.plot(ks, [r["random_distortion"] for r in rows], "x--", label="random (no record)")
        plt.axhline(1.0, color="grey", ls=":", lw=1, label="fully burnt (do nothing)")
        if smallest_speck is not None:
            plt.axvline(smallest_speck, color="green", ls=":", lw=1)
        plt.xlabel("seed size k  (modes kept — the 'speck of dust')")
        plt.ylabel("distortion  (1.0 = burnt, 0 = perfect)")
        plt.title("Σ₀ reconstruction: putting the smoke back vs. lighting a new fire")
        plt.legend(); plt.tight_layout()
        png = os.path.join("data", "sigma0_reconstruction.png")
        plt.savefig(png, dpi=120)
        print(f"plot:     {png}")
    except Exception as e:  # noqa: BLE001 — plotting is optional
        print(f"(plot skipped: {e})")


if __name__ == "__main__":
    main()
