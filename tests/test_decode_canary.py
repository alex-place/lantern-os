"""
Regression tests for the Σ₀ decode canary (#766 / G10).

Acceptance from the issue: "a deliberately looping prompt drives NIS past spook_threshold;
decode knobs respond to proximity." These exercise the instrument (DecodeCanary over a token
stream) and the actuator (knobs vs proximity) WITHOUT loading a model — pure CPU.

Run:  python -m pytest tests/test_decode_canary.py -q
  or: python tests/test_decode_canary.py   (self-running, no pytest needed)
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

import pytest  # noqa: E402

# sigma0.decode_canary imports torch at module load; CI does not install it.
# Skip the module rather than error collection where torch is unavailable.
pytest.importorskip("torch")
from sigma0.decode_canary import DecodeCanary  # noqa: E402


def test_looping_decode_spooks():
    """A degenerate single-token loop must push NIS past spook_threshold and proximity→collapse."""
    dc = DecodeCanary()
    spooked = False
    for _ in range(40):
        obs = dc.observe(7)  # the same token, forever — full loop collapse
        spooked = spooked or obs["spook"]
    assert spooked, "a single-token loop never tripped the spook flag"
    assert dc.last["proximity"] > 0.7, f"proximity stayed low under loop: {dc.last['proximity']}"
    assert dc.last["signal"] == "inject_novelty", f"unexpected anti-collapse signal: {dc.last['signal']}"


def test_two_cycle_loop_detected():
    """An A-B-A-B 2-cycle (many tokens 'fresh' per step) must still be caught."""
    dc = DecodeCanary()
    for i in range(40):
        obs = dc.observe(1 if i % 2 == 0 else 2)
    assert obs["spook"], "2-cycle loop did not spook"
    assert obs["proximity"] > 0.7


def test_healthy_decode_no_spook():
    """Varied, non-repeating output must NOT spook and must read far from collapse."""
    dc = DecodeCanary()
    for tid in range(40):  # all distinct ids
        obs = dc.observe(tid)
    assert not obs["spook"], "healthy varied decode false-positived the spook flag"
    assert obs["proximity"] < 0.3, f"healthy decode read too close to collapse: {obs['proximity']}"
    assert obs["signal"] == "none"


def test_low_margin_raises_degeneracy():
    """Even with distinct tokens, a collapsing argmax margin should lift degeneracy/NIS."""
    confident = DecodeCanary().observe(5, margin=0.95)
    unsure = DecodeCanary().observe(5, margin=0.01)
    assert unsure["degeneracy"] > confident["degeneracy"]
    assert unsure["nis"] > confident["nis"]


def test_knobs_respond_to_proximity():
    """Decode knobs must move monotonically with Σ₀ proximity (the actuator side)."""
    dc = DecodeCanary()
    calm = dc.knobs(q=0.5, rep_penalty=1.3, temperature=0.0, proximity=0.0)
    panic = dc.knobs(q=0.5, rep_penalty=1.3, temperature=0.0, proximity=1.0)
    assert panic["rep_penalty"] > calm["rep_penalty"], "rep_penalty did not rise with proximity"
    assert panic["temperature"] > calm["temperature"], "temperature did not rise with proximity"
    assert panic["q"] < calm["q"], "q did not drop (exit sooner) with proximity"
    assert calm["rep_penalty"] == 1.3 and calm["q"] == 0.5, "zero proximity must be a no-op"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
