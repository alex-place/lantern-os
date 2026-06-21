"""
Σ₀-K1 component 7 — CSF state snapshot of the kernel state {x, Σ, Trace}.

Serializes the live kernel state — the d-dim state vector x (component 6), its covariance
Σ, the replayable Trace, plus {active_id, base_seed, dt, step} — into a single CSF-Pack
archive so a run can be migrated, resumed, or replayed bit-for-bit on another machine.

Gate D (replay determinism) must survive the save/load: resuming a rollout from a restored
snapshot, with the snapshot's base_seed, reproduces an IDENTICAL Trace. That is what makes
the kernel's convergence portable rather than tied to one process.

Layout inside the archive (CSF-Pack v0.8 container, sha256-verified):
  meta.json   {active_id, base_seed, dt, step, format, x_shape, sigma_shape}
  x.npy       the state vector(s) x ∈ Rᵈ  (numpy — portable, no pickle)
  sigma.npy   the covariance Σ
  trace.json  {base_seed, dt, steps[], swaps[], collapses[]}

Tensors are stored as numpy `.npy` (portable across torch builds); x/Σ are reloaded as
torch tensors. The execution NODE (its weights) is referenced by `active_id`, not embedded —
the node registry/adapter is restored separately (CSF carries STATE, not the model).
"""
from __future__ import annotations

import io
import json
from dataclasses import asdict
from typing import Optional

import numpy as np
import torch

from csf.csf_pack import pack_blobs, unpack_blobs
from cio_sde.engine import Trace, SwapRecord

FORMAT = "sigma0-kernel-snapshot/1"


def _npy_bytes(t: torch.Tensor) -> bytes:
    buf = io.BytesIO()
    np.save(buf, t.detach().cpu().numpy(), allow_pickle=False)
    return buf.getvalue()


def _npy_load(b: bytes) -> torch.Tensor:
    arr = np.load(io.BytesIO(b), allow_pickle=False)
    return torch.from_numpy(np.ascontiguousarray(arr))


def _trace_to_dict(trace: Trace) -> dict:
    return {
        "base_seed": trace.base_seed,
        "dt": trace.dt,
        "steps": trace.steps,                              # list of {step, x_norm, ...} floats
        "swaps": [asdict(s) for s in trace.swaps],         # SwapRecord dataclasses
        # collapse results carry tensors (x_star); keep the JSON-safe summary only.
        "collapses": [{"step": c.get("step"),
                       "outcome": str(getattr(c.get("result"), "outcome", ""))}
                      for c in trace.collapses],
    }


def _trace_from_dict(d: dict) -> Trace:
    tr = Trace(base_seed=int(d["base_seed"]), dt=float(d["dt"]))
    tr.steps = list(d.get("steps", []))
    tr.swaps = [SwapRecord(**s) for s in d.get("swaps", [])]
    tr.collapses = list(d.get("collapses", []))
    return tr


def save_snapshot(path: str, *, x: torch.Tensor, sigma: torch.Tensor, trace: Trace,
                  active_id: str = "v0", base_seed: Optional[int] = None,
                  dt: Optional[float] = None, step: int = 0, compress: bool = True) -> dict:
    """Pack {x, Σ, Trace, active_id, base_seed, dt, step} into a CSF-Pack at `path`.
    base_seed/dt default to the Trace's own values. Returns the archive manifest."""
    base_seed = trace.base_seed if base_seed is None else base_seed
    dt = trace.dt if dt is None else dt
    meta = {"format": FORMAT, "active_id": active_id, "base_seed": int(base_seed),
            "dt": float(dt), "step": int(step),
            "x_shape": list(x.shape), "sigma_shape": list(sigma.shape)}
    blobs = {
        "meta.json": json.dumps(meta).encode("utf-8"),
        "x.npy": _npy_bytes(x),
        "sigma.npy": _npy_bytes(sigma),
        "trace.json": json.dumps(_trace_to_dict(trace)).encode("utf-8"),
    }
    return pack_blobs(blobs, path, compress=compress)


def load_snapshot(path: str) -> dict:
    """Restore a snapshot. Returns {x, sigma, trace, active_id, base_seed, dt, step}."""
    blobs = unpack_blobs(path)
    meta = json.loads(blobs["meta.json"].decode("utf-8"))
    if meta.get("format") != FORMAT:
        raise ValueError(f"unexpected snapshot format {meta.get('format')!r}")
    trace = _trace_from_dict(json.loads(blobs["trace.json"].decode("utf-8")))
    return {
        "x": _npy_load(blobs["x.npy"]),
        "sigma": _npy_load(blobs["sigma.npy"]),
        "trace": trace,
        "active_id": meta["active_id"],
        "base_seed": int(meta["base_seed"]),
        "dt": float(meta["dt"]),
        "step": int(meta["step"]),
    }
