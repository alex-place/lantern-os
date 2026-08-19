"""Anchor + regression for research/epistemic_controller (the epistemic boundary MVP).

The research dir is deliberately NOT wired into the product -- it is a disposable instrument.
This test is its anchor for the sprawl tripwire (#2542) and, more importantly, pins the result
so it cannot silently regress: on held-out seeds with frozen thresholds, the controller enters
BOUNDARY on a real hidden-variable switch, refuses parameter updates there, picks the true
observable from four candidates well above chance, and does NOT hold a BOUNDARY on a null
(drift-only) world.

Small n here so it runs in seconds; the full 300-seed holdout is in the README. The bars are
looser than the README's precisely because n is small -- these catch a broken mechanism, not a
2pp drift.

Run:  python -m pytest tests/test_epistemic_controller.py -q
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..", "research", "epistemic_controller")
sys.path.insert(0, os.path.abspath(ROOT))

from controller import Controller, BOUNDARY, NOMINAL                      # noqa: E402
from environments.hidden_variable import HiddenVariableWorld              # noqa: E402
from agents.auditor import Auditor                                        # noqa: E402

# Holdout seeds -- never used while the thresholds were being set (those were 0-199).
SEEDS = list(range(900, 930))


def _run(seed, **kw):
    w = HiddenVariableWorld(seed, **kw)
    return w, Controller(w).run()


def test_enters_boundary_only_after_the_switch():
    early = 0
    entered = 0
    for s in SEEDS:
        w, r = _run(s)
        if r["entered_boundary"]:
            entered += 1
            if r["boundary_t"] < w.truth()["switch_at"]:
                early += 1
    assert early == 0, "BOUNDARY must never fire before the hidden variable exists"
    assert entered / len(SEEDS) >= 0.8


def test_refuses_parameter_updates_in_boundary():
    for s in SEEDS[:10]:
        _, r = _run(s)
        if r["entered_boundary"]:
            assert r["param_updates_refused"] >= 1


def test_chooses_true_hidden_variable_well_above_chance():
    hits = 0
    for s in SEEDS:
        w, r = _run(s)
        hits += w.truth()["true_z"] in r["features"]
    rate = hits / len(SEEDS)
    assert rate >= 0.7, f"true-z selection {rate:.2f} (chance 0.25)"


def test_beats_a_alone_on_final_error():
    twin, base = [], []
    for s in SEEDS:
        w, r = _run(s)
        twin.append(r["final_mse"])
        # A alone: refit forever on {x}, no boundary
        from agents.explorer import Explorer
        wb = HiddenVariableWorld(s); A = Explorer(["x"]); xs, ys = [], []
        while (o := wb.observe()) is not None:
            xs.append(o["x"]); ys.append(o["y"])
            if len(xs) >= 8:
                A.fit(np.array(xs)[:, None], np.array(ys))
        res = A.residuals(np.array(xs[-30:])[:, None], np.array(ys[-30:]))
        base.append(float(np.mean(res ** 2)))
    assert np.mean(twin) < 0.5 * np.mean(base)


def test_null_world_does_not_hold_a_boundary():
    held = 0
    for s in SEEDS:
        _, r = _run(s, switch_at=None, drift=0.002)
        held += r["boundary_held"]
    assert held / len(SEEDS) < 0.1, "a drift-only world must not lead to a held (expanded) BOUNDARY"


def test_auditor_sees_noise_as_noise_and_bands_as_structure():
    rng = np.random.default_rng(0)
    aud = Auditor()
    noise_calls = sum(aud.judge(rng.normal(0, 1, 30))["structured"] for _ in range(200))
    # Any-of-3 at alpha=0.05 is a ~15% family-wise false-positive rate on pure noise, by design:
    # the auditor is deliberately SENSITIVE (a hidden i.i.d. variable only trips one of the
    # three tests), and the false-alarm load is carried downstream by DESIGN's retraction, which
    # the null-world test below measures at ~0% HELD. So this pins the auditor's actual rate
    # (measured 15.0% on this seed), not a wish. If it climbs past 25% the tests have broken.
    assert noise_calls / 200 < 0.25, f"auditor false-positive rate {noise_calls/200:.2f} on pure noise (design ~0.15)"
    bands = rng.choice([-2.0, 2.0], 30) + rng.normal(0, 0.3, 30)
    assert aud.judge(bands)["structured"], "two residual bands (a hidden binary variable) are structure"


def test_evidence_log_cites_transitions():
    w, r = _run(SEEDS[0])
    kinds = {e["kind"] for e in r["evidence"]}
    assert "transition" in kinds
    for tr in r["transitions"]:
        if tr["to"] == BOUNDARY:
            assert tr["evidence"], "a BOUNDARY transition must cite the evidence it rests on"
