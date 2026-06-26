"""Tests for the Convergence Oracle — time-banded observer slices between the big bang
and the heat death. See src/convergence/oracle.py."""
from src.convergence.oracle import ConvergenceOracle, NOW_S, YEAR_S


def test_now_slice_is_grounded_both_ways():
    o = ConvergenceOracle()
    s = o.now()
    assert s.band == "Stelliferous era (NOW)"
    assert s.direction == "both"                                  # forward prediction ⇄ backward constraint meet
    assert any("13.787" in k.claim for k in s.knowns)            # the age, grounded
    assert all(k.is_well_formed() and k.is_grounded() for k in s.knowns)


def test_the_two_pins_are_the_boundary_unknowns():
    o = ConvergenceOracle()
    beginning = o.slice_at(1e-50)                                 # before the Planck time
    assert beginning.band == "Planck epoch"
    assert beginning.direction == "boundary"
    assert any("singularity" in u for u in beginning.unknowns)

    end = o.slice_at(1e130)                                       # ≫ 10^100 yr
    assert end.band == "Dark era / heat death"
    assert end.direction == "boundary"
    assert any("ultimate fate" in u for u in end.unknowns)


def test_collapse_both_ways():
    c = ConvergenceOracle().collapse()
    # forward from the big bang: inflation … now are determined
    assert "Inflation" in c["grounded_forward_from_big_bang"]
    assert "Recombination / CMB" in c["grounded_forward_from_big_bang"]
    # backward from the heat death: the far-future eras are constrained by the 2nd law
    assert "Degenerate era" in c["grounded_backward_from_heat_death"]
    assert "Black hole era" in c["grounded_backward_from_heat_death"]
    # the present is where the two directions meet
    assert c["both_ways"] == ["Stelliferous era (NOW)"]
    # the two pins are the irreducible unknowns
    assert set(c["boundary_pins_unknown"]) == {"Planck epoch", "Dark era / heat death"}
    assert len(c["unknowns"]) >= 5


def test_locates_a_question_in_cosmic_time():
    o = ConvergenceOracle()
    assert o.slice_for("how old is the universe?").band == "Stelliferous era (NOW)"
    assert o.slice_for("what was there before the big bang?").band == "Planck epoch"
    assert o.slice_for("what is the ultimate fate of the universe?").band == "Dark era / heat death"
    assert o.slice_for("when did the CMB form?").band == "Recombination / CMB"
    # an un-anchored question falls back to NOW, the best-grounded slice
    assert o.slice_for("what's a good pasta recipe?").band == "Stelliferous era (NOW)"


def test_slice_serializes_for_handing_off():
    o = ConvergenceOracle()
    d = o.slice_for("heat death of the universe").to_dict()
    assert d["band"] == "Dark era / heat death"
    assert d["knowns"] and d["knowns"][0]["source"]              # every known carries a source
    assert d["unknowns"]


def test_age_constant_is_sane():
    # NOW_S is ~13.8 billion years in seconds; it lands in the stelliferous band.
    assert abs(NOW_S / YEAR_S / 1e9 - 13.787) < 0.01
    assert ConvergenceOracle().slice_at(NOW_S).band == "Stelliferous era (NOW)"
