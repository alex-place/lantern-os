"""
Σ₀-K1 component 7 — CSF state-snapshot for {x, Σ, Trace, …}  (#847, spec §4.4).

Serializes the kernel state ``{x, Σ, Trace, active_id, base_seed, dt, step}`` as a
**CSF-Pack v0.8** archive (JSON manifest + per-member blobs + sha256 footer) so a
trajectory can be migrated / resumed / replayed. Because ``rollout`` seeds the noise
at global step ``s`` from ``base_seed + s`` (``engine.rollout``), a snapshot taken at
``step`` resumes deterministically by continuing a fresh rollout from the saved
``(x, Σ)`` with ``base_seed_continuation = base_seed + step`` — Gate D (replay
determinism) survives save/load.

The model *weights* are NOT stored (per North Star: models are interchangeable);
``active_id`` records which node was live, and resume rebuilds the model separately.
"""
from __future__ import annotations

import dataclasses
import io
import json
from typing import Any, Dict

import torch

from .engine import Trace, SwapRecord

try:  # repo-root on sys.path
    from src.csf import csf_pack
except ImportError:  # `src/` itself on sys.path
    from csf import csf_pack

SNAPSHOT_SCHEMA = "k1-snapshot-v1"


def _tensor_bytes(t: torch.Tensor) -> bytes:
    buf = io.BytesIO()
    torch.save(t.detach().cpu(), buf)
    return buf.getvalue()


def _load_tensor(b: bytes) -> torch.Tensor:
    return torch.load(io.BytesIO(b), weights_only=True)


def _trace_to_json(trace: Trace) -> Dict[str, Any]:
    return {
        "base_seed": trace.base_seed,
        "dt": trace.dt,
        "steps": trace.steps,                                    # already float dicts
        "swaps": [dataclasses.asdict(s) for s in trace.swaps],
        # collapse results carry tensors (x_star); keep only the step index for replay.
        "collapses": [{"step": c.get("step")} for c in trace.collapses],
        "running_cost": (float(trace.running_cost) if trace.running_cost is not None else None),
    }


def _trace_from_json(d: Dict[str, Any]) -> Trace:
    tr = Trace(base_seed=int(d["base_seed"]), dt=float(d["dt"]))
    tr.steps = list(d.get("steps", []))
    tr.swaps = [SwapRecord(**s) for s in d.get("swaps", [])]
    tr.collapses = list(d.get("collapses", []))
    tr.running_cost = d.get("running_cost")
    return tr


def snapshot_state(out_path: str, *, x: torch.Tensor, sigma: torch.Tensor,
                   trace: Trace, active_id: str, base_seed: int, dt: float,
                   step: int) -> Dict[str, Any]:
    """Pack the kernel state into a CSF-Pack archive at ``out_path``. Returns the manifest."""
    meta = {
        "schema": SNAPSHOT_SCHEMA,
        "active_id": active_id,
        "base_seed": int(base_seed),
        "dt": float(dt),
        "step": int(step),
        "x_shape": list(x.shape),
        "sigma_shape": list(sigma.shape),
        "trace": _trace_to_json(trace),
    }
    blobs = {
        "state.json": json.dumps(meta).encode("utf-8"),
        "x.pt": _tensor_bytes(x),
        "sigma.pt": _tensor_bytes(sigma),
    }
    return csf_pack.pack_blobs(blobs, out_path, extra_meta={"kind": SNAPSHOT_SCHEMA})


@dataclasses.dataclass
class ResumedState:
    x: torch.Tensor
    sigma: torch.Tensor
    trace: Trace
    active_id: str
    base_seed: int
    dt: float
    step: int

    def continuation_seed(self) -> int:
        """base_seed offset for a rollout that continues this trajectory deterministically."""
        return self.base_seed + self.step


def resume_state(archive: str) -> ResumedState:
    """Read a snapshot archive back into a ``ResumedState`` (sha256-verified by CSF-Pack)."""
    meta = json.loads(csf_pack.read_file(archive, "state.json").decode("utf-8"))
    if meta.get("schema") != SNAPSHOT_SCHEMA:
        raise ValueError(f"unexpected snapshot schema: {meta.get('schema')!r}")
    x = _load_tensor(csf_pack.read_file(archive, "x.pt"))
    sigma = _load_tensor(csf_pack.read_file(archive, "sigma.pt"))
    return ResumedState(
        x=x,
        sigma=sigma,
        trace=_trace_from_json(meta["trace"]),
        active_id=meta["active_id"],
        base_seed=int(meta["base_seed"]),
        dt=float(meta["dt"]),
        step=int(meta["step"]),
    )
