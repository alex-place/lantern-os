"""Regression test for the looped-recall input-dependence check
(experiments/looped_recall_input_dependence.py; grounds a real corpus claim,
arXiv:2604.15259). Pins the CORRECTED finding (H1'): recall + outer normalization gives a
reachable, input-dependent fixed point at every spectral regime, while the no-recall loop
fails reachability in the contracting/critical regime — i.e. recall (per-step grounding) is
what makes the latent-reasoning loop well-posed. Also pins that the pre-registered H1
(input-INDEPENDENCE collapse) was refuted and recorded, so the honest record can't be lost.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "experiments"))
import looped_recall_input_dependence as m  # noqa: E402


def _dep_conv(rho, recall, n=32, seed=7):
    rng = np.random.default_rng(seed)
    xs = [rng.standard_normal(m.D) for _ in range(n)]
    A = m.make_operator(m.D, rho, rng)
    B = np.eye(m.D)
    return m.input_dependence(A, B, xs, recall=recall)


def test_recall_gives_reachable_input_dependent_fixed_point():
    # recall + outer norm: converges AND stays input-dependent, even expansive rho=3
    for rho in (0.5, 1.0, 3.0):
        dep, conv = _dep_conv(rho, recall=True)
        assert conv >= 0.95, (rho, conv)
        assert dep > 0.4, (rho, dep)


def test_no_recall_fails_reachability_when_contracting():
    # the no-recall loop does not converge in the contracting/critical regime
    for rho in (0.5, 0.9, 1.0):
        _, conv = _dep_conv(rho, recall=False)
        assert conv <= 0.1, (rho, conv)


def test_recall_confers_something_not_a_null():
    # kill condition must NOT hold: recall must reach fixed points more reliably than no-recall
    _, conv_recall = _dep_conv(0.9, recall=True)
    _, conv_no = _dep_conv(0.9, recall=False)
    assert conv_recall - conv_no > 0.5, (conv_recall, conv_no)


def test_committed_report_records_refutation_and_correction():
    p = Path(__file__).resolve().parent.parent / "data" / "sigma0" / "looped_recall_report.json"
    if not p.exists():
        pytest.skip("run experiments/looped_recall_input_dependence.py first")
    r = json.loads(p.read_text(encoding="utf-8"))
    assert r["reproduced_corrected_claim"] is True
    # the honest record: original H1 refuted, kept on the record
    assert r["verdict"]["H1_original_input_independence_REFUTED"] is True
    assert "non-reachability" in r["honest_record"].lower() or "non-reachable" in r["honest_record"].lower()
