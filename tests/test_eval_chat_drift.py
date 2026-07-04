"""#1967 — long-session constraint-drift eval: coverage for the pure checker/summary."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
from eval_chat_drift import CONSTRAINT_TURN, FILLER_TURNS, TOKEN, adheres, summarize_adherence  # noqa: E402


def test_adheres_only_in_trailing_region():
    assert adheres("Sure!\n" + TOKEN)
    assert adheres("Sure!\n" + TOKEN + " \n")            # trailing whitespace tolerated
    assert not adheres("no token here")
    assert not adheres(TOKEN + " " + "x" * 200)          # token buried at the start ≠ adherent
    assert not adheres("")
    assert not adheres(None)


def test_constraint_turn_carries_token_and_fillers_do_not():
    assert TOKEN in CONSTRAINT_TURN
    # None of the ordinary turns mention the token, so adherence after turn 1 is
    # genuine instruction retention, not prompt echo.
    assert all(TOKEN not in t for t in FILLER_TURNS)
    assert len(FILLER_TURNS) >= 11                       # enough for the default 12-turn run


def test_summarize_adherence():
    assert summarize_adherence([True, True, False, True]) == (3, 3)
    assert summarize_adherence([True, True]) == (2, None)
    assert summarize_adherence([False]) == (0, 1)
    assert summarize_adherence([]) == (0, None)
