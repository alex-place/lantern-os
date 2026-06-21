"""Σ₀-K1 kernel serving-loop closure — issue #848.

Drives the closure with a stubbed continuation (and a CIO_SDE rollout standing in
as a deterministic continuation) and asserts one Convergence Record + one Memory
write-back, with the grounding gate routing trusted vs proposal entries. Local only;
the live served-Ouro half (#844 GPU dependency) is out of scope.
"""
import json

import pytest

from src.convergence.kernel_closure import close_kernel_loop
from src.convergence.memory import MemoryStore


def _count(path):
    return len([l for l in path.read_text(encoding="utf-8").splitlines() if l.strip()])


def test_grounded_continuation_writes_record_and_trusted_memory(tmp_path):
    records_path = tmp_path / "records.jsonl"
    mem = MemoryStore(str(tmp_path / "mem"))
    cont = {
        "prompt": "what is x in the kernel?",
        "reply": "x is the d-dim portable state vector",
        "confidence": 0.82,
        "evidence": ["src/cio_sde/engine.py:243"],
        "source": "kernel-test",
    }
    out = close_kernel_loop(cont, records_path=str(records_path), memory=mem)

    # exactly one Convergence Record, correct shape
    assert _count(records_path) == 1
    rec = json.loads(records_path.read_text(encoding="utf-8").strip())
    assert rec["claim"] == "x is the d-dim portable state vector"
    assert rec["type"] == "kernel-continuation"
    assert rec["agent"] == "Kernel"
    assert rec["sources"] == ["src/cio_sde/engine.py:243"]
    assert set(["timestamp", "claim", "evidence", "confidence", "source", "sources"]).issubset(rec)

    # grounded → trusted convergence log gets the write-back (not proposals)
    assert out["memory_entry"] is not None
    assert _count(mem.logs["convergence"]) == 1
    assert _count(mem.logs["proposals"]) == 0


def test_ungrounded_continuation_routes_to_proposals(tmp_path):
    records_path = tmp_path / "records.jsonl"
    mem = MemoryStore(str(tmp_path / "mem"))
    cont = {"prompt": "guess", "reply": "an ungrounded improvisation",
            "confidence": 0.95, "evidence": [], "source": "kernel-test"}
    close_kernel_loop(cont, records_path=str(records_path), memory=mem)

    # record is still emitted...
    assert _count(records_path) == 1
    # ...but the ungrounded memory write-back is clamped + partitioned to proposals
    assert _count(mem.logs["proposals"]) == 1
    assert _count(mem.logs["convergence"]) == 0


def test_cio_sde_rollout_stands_in_as_continuation(tmp_path):
    try:
        import torch  # noqa: F401
    except (ImportError, OSError):
        pytest.skip("torch unavailable (DLL or import error)")
    torch = __import__("torch")
    from src.cio_sde import CIO_SDE, rollout
    m = CIO_SDE(dim=4, ctrl_dim=2, hidden=16)
    x0 = torch.zeros(2, 4)
    s0 = torch.eye(4).expand(2, 4, 4).clone()
    xf, _, tr = rollout(m, x0, s0, steps=5, base_seed=1)
    cont = {
        "prompt": "advance the kernel state",
        "reply": f"converged: final ‖x‖={xf.norm().item():.4f} over {len(tr.steps)} steps",
        "confidence": 0.7,
        "evidence": ["src/cio_sde/engine.py:rollout"],
        "source": "cio_sde",
    }
    out = close_kernel_loop(cont, records_path=str(tmp_path / "r.jsonl"),
                            memory=MemoryStore(str(tmp_path / "m")))
    assert out["record"]["source"] == "cio_sde"
    assert out["memory_entry"] is not None
