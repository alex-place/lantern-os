"""Tests for the skill-acquisition harness (#2783).

The instrument must isolate procedural LEARNING (accuracy rising with exposures via retrieved
memory) from RETENTION, and detect the spacing effect only where it exists (bounded memory).
The reference affine learner has a sharp, known acquisition threshold (2 examples pin y=ax+b mod m),
so these assertions are exact, not statistical.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "experiments"))

from skill_acquisition_harness import (  # noqa: E402
    Skill, make_skills, affine_learner_solve, run_schedule, acquisition_slope,
    distributed_schedule, massed_schedule, retention_probe, measure,
)


def test_affine_learner_cannot_solve_before_two_examples_and_can_after():
    sk = Skill("s0", a=5, b=11)
    assert affine_learner_solve(3, []) is None                 # nothing learned yet
    assert affine_learner_solve(3, [(1, sk.output(1))]) is None  # one example under-determines
    two = [(1, sk.output(1)), (2, sk.output(2))]
    assert affine_learner_solve(3, two) == sk.output(3)        # two distinct examples pin the rule


def test_memory_off_never_accumulates_experience():
    skills = make_skills(3)
    sbid = {s.sid: s for s in skills}
    sched = distributed_schedule(skills, reps=5)
    off = run_schedule(sched, sbid, affine_learner_solve, memory_on=False)
    assert off.accuracy() == 0.0, "with no memory the learner can never acquire the rule"


def test_acquisition_slope_positive_with_memory_flat_without():
    skills = make_skills(6)
    sbid = {s.sid: s for s in skills}
    sched = distributed_schedule(skills, reps=6)
    on = run_schedule(sched, sbid, affine_learner_solve, memory_on=True)
    off = run_schedule(sched, sbid, affine_learner_solve, memory_on=False)
    assert acquisition_slope(on) > 0.05, "memory ON must show a rising acquisition curve"
    assert abs(acquisition_slope(off)) < 0.02, "memory OFF must be flat"


def test_acquisition_curve_steps_up_exactly_at_the_second_exposure():
    skills = make_skills(8)
    rep = measure(skills, affine_learner_solve, reps=6)
    curve = rep["acquisition"]["curve_by_exposure"]
    assert curve[0] == 0.0 and curve[1] == 0.0, "cannot solve before 2 examples"
    assert curve[2] == 1.0, "solves from the 3rd exposure on (2 prior examples retrieved)"
    assert rep["acquisition"]["learned"] is True


def test_spacing_effect_appears_under_bounded_memory():
    # distributed practice keeps every skill's examples recent; massed strands the early skills
    # outside a half-size retrieval window → distributed retains more. Lossless memory shows no gap.
    skills = make_skills(8)
    dist = retention_probe(skills, affine_learner_solve, "distributed", reps=6, window=24)
    mass = retention_probe(skills, affine_learner_solve, "massed", reps=6, window=24)
    assert dist["retention_accuracy"] > mass["retention_accuracy"], "spacing effect: distributed > massed"
    # null check: with unbounded memory the spacing gap vanishes
    dist_full = retention_probe(skills, affine_learner_solve, "distributed", reps=6, window=None)
    mass_full = retention_probe(skills, affine_learner_solve, "massed", reps=6, window=None)
    assert dist_full["retention_accuracy"] == mass_full["retention_accuracy"] == 1.0


def test_schedules_have_the_right_shape():
    skills = make_skills(3)
    massed = massed_schedule(skills, 4)
    # massed: s0,s0,s0,s0, s1,s1,s1,s1, s2,... — same skill back-to-back
    assert [sid for sid, _ in massed[:4]] == ["s0", "s0", "s0", "s0"]
    dist = distributed_schedule(skills, 4)
    # distributed: s0,s1,s2, s0,s1,s2, ... — round-robin
    assert [sid for sid, _ in dist[:3]] == ["s0", "s1", "s2"]
