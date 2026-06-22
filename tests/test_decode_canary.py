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


def test_entropy_signal_surfaced_and_tracked():
    """Feeding softmax entropy (the folded #793 signal) surfaces it + tracks a running EMA."""
    dc = DecodeCanary()
    out = dc.observe(3, entropy=2.5)
    assert out["entropy"] == 2.5, "fed entropy not surfaced in observation"
    assert dc.mean_entropy == 2.5, "first entropy must seed the EMA"
    dc.observe(4, entropy=2.0)
    assert dc.mean_entropy is not None and 2.0 < dc.mean_entropy < 2.5, \
        f"EMA did not track toward newer entropy: {dc.mean_entropy}"


def test_no_entropy_keeps_signal_inert():
    """Without an entropy arg the #793 signal stays inert: no events, null telemetry."""
    dc = DecodeCanary()
    for tid in range(10):
        out = dc.observe(tid)
    assert out["entropy"] is None and out["entropy_z"] is None
    assert dc.collapse_events == [] and dc.mean_entropy is None


def test_entropy_drop_records_collapse_event():
    """A sharp entropy drop after a steady run trips the two-sided z-alarm (over-confidence)."""
    dc = DecodeCanary(ent_z_thresh=2.0)
    for i in range(12):
        dc.observe(i, entropy=3.0)               # steady high-entropy baseline
    dc.observe(99, entropy=0.05, token_idx=12)   # sudden confidence spike → entropy collapse
    assert dc.collapse_events, "entropy collapse did not append a collapse_event"
    ev = dc.collapse_events[-1]
    assert ev["token"] == 12 and ev["z"] < 0, f"collapse event mis-recorded: {ev}"


def test_divergence_inert_when_absent():
    """Without a divergence arg the second-fate signal stays inert (None), exactly like entropy —
    so the model-free unit path and the certificate's collapse tests are unaffected."""
    out = DecodeCanary().observe(5)
    assert out["divergence"] is None
    assert out["proximity_any"] == out["proximity"], "proximity_any must reduce to collapse proximity"


def test_divergence_surfaced_and_distinct_from_collapse():
    """A supplied divergence (runaway) is surfaced and folded into proximity_any, but kept
    DISTINCT from the collapse `proximity` (the certificate §4 keeps the two fates separate)."""
    out = DecodeCanary().observe(5, divergence=0.8)        # varied token, no repetition
    assert out["divergence"] == 0.8, "supplied divergence not surfaced"
    assert out["proximity"] < 0.3, "a single varied token must not read as COLLAPSE"
    assert out["proximity_any"] >= 0.8, "proximity_any must reflect the divergence fate"


def test_knobs_respond_to_divergence_without_novelty():
    """Divergence must pull the decoder toward STOPPING (lower q, higher rep_penalty) but must
    NOT inject novelty (temperature) — novelty would feed a runaway."""
    dc = DecodeCanary()
    base = dc.knobs(q=0.5, rep_penalty=1.3, temperature=0.0, proximity=0.0, divergence=0.0)
    diverging = dc.knobs(q=0.5, rep_penalty=1.3, temperature=0.0, proximity=0.0, divergence=1.0)
    assert diverging["q"] < base["q"], "divergence did not lower q (exit/stop sooner)"
    assert diverging["rep_penalty"] > base["rep_penalty"], "divergence did not raise rep_penalty"
    assert diverging["temperature"] == base["temperature"], "divergence must NOT inject novelty"


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
