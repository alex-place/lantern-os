"""ADR-0034 MoE admission gate tooling — the switched-system certificates in unit form.

The load-bearing physics this pins: STABLE PIECES DO NOT MAKE A STABLE SWITCH.
Two modes, each individually contracting (rho = 0.7), diverge under per-step
alternation — and the same pair is provably safe when switching respects the
certified dwell time tau*. That asymmetry is the entire reason cert §1.2.2 voids
Part I for routed loops, and the reason ADR-0034's gate exists.

Deterministic throughout (no RNG): the canonical counterexample is closed-form.
Run:  python -m pytest tests/test_sigma0_switched_gate.py -q
"""

import math

import numpy as np
import pytest

from sigma0.switched_gate import (
    DwellMonitor,
    common_lyapunov_attempt,
    dwell_time_certificate,
    per_mode_receipts,
    solve_discrete_lyapunov,
)

# The canonical pair: shear right / shear down, each scaled to rho = 0.7 (stable),
# whose one-step alternation has rho(A1@A2) = 0.49 * (3 + 2*sqrt(2)) ~= 2.856 > 1.
A1 = 0.7 * np.array([[1.0, 2.0], [0.0, 1.0]])
A2 = 0.7 * np.array([[1.0, 0.0], [2.0, 1.0]])
UNSTABLE = np.array([[1.2, 0.0], [0.0, 0.3]])


def _simulate(modes, schedule, x0, steps):
    """Apply modes per the schedule (list of mode indices, cycled) for `steps`."""
    x = np.asarray(x0, dtype=float)
    for k in range(steps):
        x = modes[schedule[k % len(schedule)]] @ x
    return x


def test_stable_pieces_diverge_under_fast_switching():
    # Each mode alone contracts...
    receipts = per_mode_receipts([A1, A2])
    assert all(r["verdict"] == "accept" for r in receipts)
    assert all(abs(r["rho"] - 0.7) < 1e-9 for r in receipts)
    # ...alternation has spectral radius ~2.856 per pair of steps:
    assert np.max(np.abs(np.linalg.eigvals(A1 @ A2))) > 2.8
    # and the trajectory blows up — the fact the whole gate exists to catch.
    x = _simulate([A1, A2], [0, 1], x0=[1.0, 1.0], steps=40)
    assert np.linalg.norm(x) > 1e6


def test_dwell_certificate_stabilizes_the_same_pair():
    cert = dwell_time_certificate([A1, A2])
    assert cert["certifiable"] is True
    tau = cert["tau_star"]
    assert tau >= 2, "per-step alternation must NOT be certified for this pair"
    # Respecting tau*: stay tau steps in each mode -> the switched trajectory
    # contracts (the ADT guarantee, checked empirically over many blocks).
    schedule = [0] * tau + [1] * tau
    x = _simulate([A1, A2], schedule, x0=[1.0, 1.0], steps=20 * tau)
    assert np.linalg.norm(x) < 1.0, "dwell-respecting switching must contract"


def test_unstable_mode_is_never_certifiable():
    receipts = per_mode_receipts([A1, UNSTABLE])
    assert receipts[1]["verdict"] == "reject"
    cert = dwell_time_certificate([A1, UNSTABLE])
    assert cert["certifiable"] is False
    assert cert["tau_star"] is None
    assert cert["reason"] == "per-mode contraction receipt failed"


def test_lyapunov_series_matches_equation():
    p = solve_discrete_lyapunov(A1)
    assert p is not None
    # A^T P A - P = -I within numerical tolerance:
    residual = A1.T @ p @ A1 - p + np.eye(2)
    assert float(np.linalg.norm(residual)) < 1e-8
    # and diverges (returns None) for an unstable mode:
    assert solve_discrete_lyapunov(UNSTABLE) is None


def test_common_lyapunov_for_commuting_modes_certifies_arbitrary_switching():
    d1 = np.diag([0.8, 0.5])
    d2 = np.diag([0.6, 0.9])
    clf = common_lyapunov_attempt([d1, d2])
    assert clf["found"] is True
    # And the honest negative: the shear pair's mean-P candidate must NOT pass
    # (per-step alternation genuinely diverges, so no valid CLF can be reported).
    assert common_lyapunov_attempt([A1, A2])["found"] is False


def test_margin_semantics_mirror_jsrr():
    # rho = 0.7 fails a margin of 0.35 (needs rho < 0.65) — same inequality shape
    # as the JSRR gate's accept-iff rho < 1 - margin.
    receipts = per_mode_receipts([A1], margin=0.35)
    assert receipts[0]["verdict"] == "reject"
    assert dwell_time_certificate([A1, A2], margin=0.35)["certifiable"] is False


def test_dwell_monitor_alarms_on_fast_switching_and_passes_slow():
    tau = 3
    fast = DwellMonitor(tau_star=tau)
    for k in range(12):  # switch every step: 0,1,0,1,...
        fast.observe(k % 2)
    v = fast.verdict()
    assert v["ok"] is False and v["violations"] > 0
    assert v["churn"] > 0.5

    slow = DwellMonitor(tau_star=tau)
    for k in range(24):  # switch every 4 steps >= tau*
        slow.observe((k // 4) % 2)
    v = slow.verdict()
    assert v["ok"] is True and v["violations"] == 0
    assert v["switches"] == 5


def test_router_entropy_canary():
    m = DwellMonitor(tau_star=1, window=16)
    for _ in range(16):
        m.observe("e0")
    assert m.entropy() == pytest.approx(0.0), "single-expert routing has zero entropy"
    m2 = DwellMonitor(tau_star=1, window=16)
    for k in range(16):
        m2.observe(f"e{k % 4}")
    assert m2.entropy() == pytest.approx(2.0, abs=1e-9), "uniform over 4 experts = 2 bits"


def test_verdict_receipt_shape():
    m = DwellMonitor(tau_star=2)
    m.observe(0)
    keys = set(m.verdict().keys())
    assert {"ok", "violations", "switches", "steps", "tau_star", "entropy_bits", "churn"} <= keys
