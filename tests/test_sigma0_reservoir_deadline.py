"""Regression tests for the #2690 Phase 0.5 prospective test on the trained §6 reservoir
(SIGMA0-COLLAPSE-CERTIFICATE §3.1; experiments/sigma0_reservoir_deadline.py).

Pins: the linearization is faithful (fixed point + analytic Jacobian), the pre-registered
regime call on this real learned system is SLIVER (cond(P) far above the threshold), the
realistic grounding kick dwarfs the escape ceiling by orders of magnitude, and the
regime's operational prediction (timing indifference at realistic anchor scales) holds on
the true nonlinear dynamics. Requires the committed encoder stream
(data/sigma0/router-encoder-output.jsonl).
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "experiments"))
pytest.importorskip("scipy")  # scipy-free CI must skip, not fail collection (#862 convention)
import sigma0_reservoir_deadline as m  # noqa: E402


@pytest.fixture(scope="module")
def system():
    states, R, W, W_in, W_out = m.build_system()
    r_star, resid = m.fixed_point(R[-1], W, W_in, W_out)
    J, _ = m.jacobian(r_star, W, W_in, W_out)
    pred, P, lam, U = m.predict(J)
    return dict(states=states, R=R, W=W, W_in=W_in, W_out=W_out,
                r_star=r_star, resid=resid, J=J, pred=pred, P=P, lam=lam, U=U)


def test_fixed_point_and_jacobian_faithful(system):
    assert system["resid"] < 1e-8
    Jn = m.jacobian_numeric(system["r_star"], system["W"], system["W_in"], system["W_out"])
    assert float(np.max(np.abs(system["J"] - Jn))) < 1e-3
    assert system["pred"]["rho_J"] < 1.0


def test_regime_call_is_sliver(system):
    # The measured fact this experiment pins: a REAL learned loop (design radius 0.9)
    # lands strongly non-normal — the sliver call, made prospectively from cond(P).
    assert system["pred"]["cond_P"] > m.COND_WELL
    assert system["pred"]["regime_call"] == "sliver_timing_indifferent"


def test_realistic_anchor_dwarfs_ceiling(system):
    c = m.calibrate_basin(system["r_star"], system["P"], system["lam"], system["U"],
                          system["W"], system["W_in"], system["W_out"],
                          system["pred"]["gamma"])
    assert c is not None
    b_real = m.realistic_anchor_scale(system["states"], system["R"], system["W"],
                                      system["W_in"], system["W_out"], n_probe=300)
    ratio = b_real / math.sqrt(c / system["pred"]["lmax_P"])
    assert ratio > 1e3, ratio


def test_timing_indifferent_at_realistic_scales(system):
    c = m.calibrate_basin(system["r_star"], system["P"], system["lam"], system["U"],
                          system["W"], system["W_in"], system["W_out"],
                          system["pred"]["gamma"])
    _, collapse = m.make_traces(system["states"], system["R"], system["W"],
                                system["W_in"], system["W_out"], n_traces=20)
    b_real = m.realistic_anchor_scale(system["states"], system["R"], system["W"],
                                      system["W_in"], system["W_out"], n_probe=300)
    sc = m.sliver_check(system["r_star"], system["P"], system["lam"], system["U"],
                        c, system["pred"], collapse, b_real)
    assert sc["timing_indifferent_at_realistic_scales"] is True, sc


def test_committed_report_shot_call_held():
    report_path = Path(__file__).resolve().parent.parent / "data" / "sigma0" / \
        "reservoir_deadline_report.json"
    if not report_path.exists():
        pytest.skip("run experiments/sigma0_reservoir_deadline.py to produce the report")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["all_ok"] is True
    assert report["deadline_consistent"] is True
    assert report["regime_call_held"] is True
    assert report["predictions_preregistered"]["regime_call"] == "sliver_timing_indifferent"
