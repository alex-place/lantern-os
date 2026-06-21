"""Σ₀-K1 CSF state-snapshot replay determinism — issue #847, Gate D.

snapshot → migrate → resume must reproduce an identical Trace: a rollout split at a
snapshot boundary and resumed from the packed {x, Σ, …} reproduces the uninterrupted
trajectory exactly (replay survives save/load). Local, synthetic — no GPU/Ouro.
"""
import os
import tempfile

import pytest

try:
    import torch
except (ImportError, OSError):
    pytest.skip("torch unavailable (DLL or import error)", allow_module_level=True)

from src.cio_sde import CIO_SDE, rollout
from src.cio_sde.snapshot import snapshot_state, resume_state

SEED = 123
DT = 0.05


def _model():
    torch.manual_seed(0)
    return CIO_SDE(dim=4, ctrl_dim=2, hidden=16)


def _state(b=8, dim=4):
    torch.manual_seed(7)
    x0 = torch.randn(b, dim)
    s0 = torch.eye(dim).expand(b, dim, dim).clone()
    return x0, s0


@pytest.mark.synthetic
def test_snapshot_resume_reproduces_trajectory(tmp_path):
    m = _model()
    x0, s0 = _state()

    # Reference: one uninterrupted 40-step rollout.
    xf_ref, sf_ref, tr_ref = rollout(m, x0, s0, steps=40, dt=DT, base_seed=SEED)

    # Leg 1: roll 20 steps, snapshot the state.
    x20, s20, tr20 = rollout(m, x0, s0, steps=20, dt=DT, base_seed=SEED)
    archive = os.path.join(tmp_path, "snap.csfpack")
    snapshot_state(archive, x=x20, sigma=s20, trace=tr20,
                   active_id=m.graph.active_id, base_seed=SEED, dt=DT, step=20)
    assert os.path.exists(archive)

    # Migrate/resume: read the state back (sha256-verified by CSF-Pack).
    r = resume_state(archive)
    assert torch.allclose(r.x, x20)                 # exact tensor round-trip
    assert torch.allclose(r.sigma, s20)
    assert r.base_seed == SEED and r.dt == DT and r.step == 20
    assert r.active_id == m.graph.active_id
    assert r.trace.steps == tr20.steps              # Trace JSON round-trip
    assert r.continuation_seed() == SEED + 20

    # Leg 2: continue from the resumed state with the continuation seed.
    xf2, sf2, tr2 = rollout(m, r.x, r.sigma, steps=20, dt=DT, base_seed=r.continuation_seed())

    # Replay survives save/load: resumed continuation == uninterrupted run.
    assert torch.allclose(xf2, xf_ref)
    assert torch.allclose(sf2, sf_ref)
    joined = [s["x_norm"] for s in r.trace.steps] + [s["x_norm"] for s in tr2.steps]
    ref = [s["x_norm"] for s in tr_ref.steps]
    assert joined == ref


@pytest.mark.synthetic
def test_resume_rejects_foreign_archive(tmp_path):
    # A non-snapshot CSF-Pack archive is rejected by schema check.
    from src.csf import csf_pack
    archive = os.path.join(tmp_path, "foreign.csfpack")
    csf_pack.pack_blobs({"state.json": b'{"schema":"something-else"}'}, archive)
    with pytest.raises(ValueError):
        resume_state(archive)
