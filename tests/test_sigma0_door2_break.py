"""
ADR-0012 step 2 — door-2 inner-break DECISION core (src/sigma0/loop_lm.py).

The break consumes the collapse certificate's per-step CONTRACT/DIVERGE fate. Producing that
per-step certificate needs torch (out of scope here); the DECISION — "break when non-contract
persists for `patience` consecutive steps" — is a pure patience counter, unit-tested here on
synthetic verdict sequences so the policy is proven before the on-box wiring + bench.

loop_lm imports torch lazily, so this runs with no torch installed.

Run: python tests/test_sigma0_door2_break.py    (also pytest-compatible)
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from sigma0.loop_lm import Sigma0LoopLM as S, door2_enabled, DOOR2_DEFAULT_PATIENCE  # noqa: E402


def test_breaks_after_patience_consecutive_noncontract():
    # steps: contract, diverge, diverge → 2nd consecutive non-contract is step index 2 (1-indexed 3)
    step, reason = S.stability_break_step([True, False, False], patience=2)
    assert step == 3 and reason == "certified_divergence", (step, reason)


def test_no_break_when_contracting():
    step, reason = S.stability_break_step([True, True, True, True], patience=2)
    assert step is None and reason == "no_break"


def test_noncontract_must_be_consecutive():
    # False, True (reset), False → never 2-in-a-row → no break
    step, reason = S.stability_break_step([False, True, False], patience=2)
    assert step is None, step


def test_uncertifiable_none_resets_run_not_breaks():
    # a None between two diverges breaks the consecutive run → no break (honest-unknown ≠ diverge)
    assert S.stability_break_step([False, None, False], patience=2)[0] is None
    # …but two clean consecutive diverges after the None DO break
    assert S.stability_break_step([False, None, False, False], patience=2) == (4, "certified_divergence")


def test_patience_one_breaks_on_first_noncontract():
    assert S.stability_break_step([True, False], patience=1) == (2, "certified_divergence")


def test_patience_three_needs_three_in_a_row():
    assert S.stability_break_step([False, False], patience=3)[0] is None
    assert S.stability_break_step([False, False, False], patience=3) == (3, "certified_divergence")


def test_empty_and_all_none_never_break():
    assert S.stability_break_step([], patience=2)[0] is None
    assert S.stability_break_step([None, None, None], patience=2)[0] is None


def test_first_break_wins_when_multiple_runs():
    # diverge,diverge (break at 2) even though a later run also qualifies
    assert S.stability_break_step([False, False, True, False, False], patience=2) == (2, "certified_divergence")


def test_kill_switch_defaults_off():
    saved = os.environ.pop("SIGMA0_DOOR2", None)
    try:
        assert door2_enabled() is False              # default OFF ⇒ baseline behavior
        os.environ["SIGMA0_DOOR2"] = "1"
        assert door2_enabled() is True
        os.environ["SIGMA0_DOOR2"] = "0"
        assert door2_enabled() is False
    finally:
        if saved is None:
            os.environ.pop("SIGMA0_DOOR2", None)
        else:
            os.environ["SIGMA0_DOOR2"] = saved
    assert DOOR2_DEFAULT_PATIENCE == 2


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ok  - {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL- {fn.__name__}\n       {e}")
    print(f"\n{'all passed' if not failed else str(failed) + ' FAILED'} ({len(fns)} tests)")
    sys.exit(1 if failed else 0)
