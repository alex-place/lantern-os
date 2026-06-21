"""Σ₀-K1 component 8 — collapse certificate + NIS χ² canary, end-to-end (#852)."""
import pytest

torch = pytest.importorskip("torch")

from cio_sde.collapse import collapse_certificate, lyapunov_value
from cio_sde.surprise import SurpriseMonitor
from cio_sde.engine import CIO_SDE, rollout


# ── Collapse certificate (Lyapunov eig(A)) ───────────────────────────────────

def test_certificate_certifies_a_contracting_node():
    A = -2.0 * torch.eye(6)                      # eigenvalues all -2 < 0
    cert = collapse_certificate(A)
    assert cert.guaranteed is True
    assert cert.spectral_abscissa < 0 and cert.full_contracting is True


def test_certificate_refuses_an_unstable_node():
    A = torch.eye(6)                             # eigenvalues all +1 > 0
    cert = collapse_certificate(A)
    assert cert.guaranteed is False
    assert cert.spectral_abscissa > 0 and cert.full_contracting is False


def test_lyapunov_value_is_nonnegative_and_zero_at_origin():
    A = -1.5 * torch.eye(4)
    assert lyapunov_value(torch.zeros(1, 4), A) == pytest.approx(0.0, abs=1e-6)
    assert lyapunov_value(torch.randn(1, 4), A) >= 0.0


# ── NIS χ² canary (the "spook") ───────────────────────────────────────────────

def _kalman_inputs(m=4, pred=0.0, obs=0.0, cov=0.01, rnoise=0.01):
    x_pred = torch.full((1, m), float(pred))
    sigma = torch.eye(m).unsqueeze(0) * cov
    C = torch.eye(m).unsqueeze(0)
    R = torch.eye(m).unsqueeze(0) * rnoise
    y = torch.full((1, m), float(obs))
    return x_pred, sigma, y, C, R


def test_canary_quiet_when_observation_matches_prediction():
    mon = SurpriseMonitor(spook_sigmas=3.0)
    x_pred, sigma, y, C, R = _kalman_inputs(pred=0.0, obs=0.02)   # tiny innovation
    res = mon.evaluate(x_pred, sigma, y, C, R)
    assert not bool(res["spook"].any())
    assert float(res["nis"].item()) < float(res["spook_threshold"])


def test_canary_spooks_on_an_anomalous_jump():
    mon = SurpriseMonitor(spook_sigmas=3.0)
    quiet = mon.evaluate(*_kalman_inputs(pred=0.0, obs=0.02))
    anom = mon.evaluate(*_kalman_inputs(pred=0.0, obs=5.0))       # huge surprise
    assert bool(anom["spook"].any())
    assert float(anom["nis"].item()) > float(quiet["nis"].item())
    assert float(anom["nis"].item()) > float(anom["spook_threshold"])


def test_canary_runs_inside_the_engine_rollout():
    torch.manual_seed(0)
    m = CIO_SDE(dim=8, ctrl_dim=2, hidden=16)
    m.surprise_monitor = SurpriseMonitor(spook_sigmas=3.0)
    x0 = torch.zeros(1, 8)
    sigma0 = torch.eye(8).unsqueeze(0)
    _, _, trace = rollout(m, x0, sigma0, steps=10, dt=0.05, base_seed=0)
    # the canary is wired into forward_step; every step records a spook flag
    assert all("surprise_spook" in s for s in trace.steps)
