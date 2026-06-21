"""Tests for the Σ₀-K1 CSF state snapshot {x, Σ, Trace} (component 7, #847)."""
import pytest

torch = pytest.importorskip("torch")

from cio_sde.engine import CIO_SDE, rollout
from sigma0.kernel_snapshot import save_snapshot, load_snapshot


def _model(dim=8, seed=0):
    torch.manual_seed(seed)
    return CIO_SDE(dim=dim, ctrl_dim=2, hidden=16)


def test_snapshot_roundtrip_fidelity(tmp_path):
    m = _model()
    x0 = torch.randn(1, 8)
    sigma0 = torch.eye(8).unsqueeze(0)
    _xf, _sf, trace = rollout(m, x0, sigma0, steps=12, dt=0.05, base_seed=123)

    p = str(tmp_path / "snap.csf")
    save_snapshot(p, x=x0, sigma=sigma0, trace=trace, active_id=m.graph.active_id, step=0)
    snap = load_snapshot(p)

    assert torch.allclose(snap["x"].float(), x0, atol=1e-6)
    assert torch.allclose(snap["sigma"].float(), sigma0, atol=1e-6)
    assert snap["base_seed"] == 123 and abs(snap["dt"] - 0.05) < 1e-9
    assert snap["active_id"] == m.graph.active_id
    # the Trace survives save/load exactly
    assert snap["trace"].x_norms() == trace.x_norms()
    assert snap["trace"].sigma_traces() == trace.sigma_traces()


def test_gate_d_replay_survives_save_load(tmp_path):
    """Gate D: resuming from a RESTORED snapshot reproduces an identical Trace."""
    m = _model(seed=7)
    x0 = torch.randn(1, 8)
    sigma0 = torch.eye(8).unsqueeze(0)
    _, _, trace = rollout(m, x0, sigma0, steps=15, dt=0.05, base_seed=999)

    p = str(tmp_path / "snap.csf")
    save_snapshot(p, x=x0, sigma=sigma0, trace=trace, base_seed=999, dt=0.05, step=0)
    snap = load_snapshot(p)

    # Resume from the restored state, same node + base_seed → identical trajectory.
    _, _, trace2 = rollout(m, snap["x"].float(), snap["sigma"].float(),
                           steps=15, dt=snap["dt"], base_seed=snap["base_seed"])
    assert trace2.x_norms() == trace.x_norms()
    assert trace2.sigma_traces() == trace.sigma_traces()


def test_snapshot_detects_tampering(tmp_path):
    m = _model()
    x0 = torch.randn(1, 8)
    sigma0 = torch.eye(8).unsqueeze(0)
    _, _, trace = rollout(m, x0, sigma0, steps=5, base_seed=1)
    p = tmp_path / "snap.csf"
    save_snapshot(str(p), x=x0, sigma=sigma0, trace=trace)
    # flip a byte in the blob region → CSF footer/sha256 must reject it
    raw = bytearray(p.read_bytes())
    raw[len(raw) // 2] ^= 0xFF
    p.write_bytes(bytes(raw))
    with pytest.raises(ValueError):
        load_snapshot(str(p))
