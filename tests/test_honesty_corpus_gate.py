"""
#2843 — enforce the honesty-corpus best practices (SIGMA0-MODEL-DESIGN.md D2/D7)
as CI gates, so the E1 gloss-leak can never re-ship.

E1 (data/sigma0/e1_degloss_report.json) proved the v1 "10% confab" headline was
substantially a GLOSS LEAK: the negatives announced their own status in-text
("-- OPEN", "-- REFUTED"), and the tune learned to READ that rather than judge
truth (de-gloss spiked Ouro confab 10%->55% while GPT-4o-mini held 0%->0%). The
de-gloss transform + lint live in experiments/sigma0_seed_facts.py; the corpus
BUILDER (sigma0_ouro_honesty_corpus.py) now applies them on the emit path. This
test turns "we de-glossed" into an ENFORCED invariant over the SHIPPED training
corpus — the exact rows the model trains on.

Gates:
  1. De-gloss lint     — zero statement in the shipped corpus carries a status gloss.
  2. Balanced ratio    — the balanced set's negative fraction is in the 0.40-0.55 band.
  3. Frozen holdout    — a versioned heldout manifest exists and is DISJOINT from the
                         training golden ids (the student never trains on it).

Run: python -m pytest tests/test_honesty_corpus_gate.py -q
"""
import json
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
BALANCED = REPO / "data" / "sigma0" / "ouro_honesty_train_balanced.jsonl"
TRAIN = REPO / "data" / "sigma0" / "ouro_honesty_train.jsonl"
HELDOUT = REPO / "data" / "sigma0" / "ouro_honesty_heldout_ids.json"

# The de-gloss detector is the single source of truth for "what counts as a leak".
sf = pytest.importorskip("experiments.sigma0_seed_facts")


def _rows(path: Path):
    if not path.exists():
        pytest.skip(f"corpus not built: {path.relative_to(REPO)}")
    return [json.loads(ln) for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]


def _statement(instruction: str):
    """The bare claim the row asks the model to classify (INSTR embeds it as Statement: "...")."""
    m = re.search(r'Statement:\s*"(.*)"\s*\Z', instruction, re.S)
    return m.group(1) if m else None


@pytest.mark.parametrize("path", [BALANCED, TRAIN])
def test_degloss_lint_zero_leaks(path):
    """Gate 1: no shipped statement may carry a status gloss (D2 de-gloss lint)."""
    statements = [s for r in _rows(path) if (s := _statement(r.get("instruction", "")))]
    assert statements, "no statements parsed — INSTR shape changed?"
    leaks = sf.assert_deglossed(statements)  # returns the still-glossing statements
    assert leaks == [], (
        f"{len(leaks)} statement(s) in {path.name} still leak their status in-text "
        f"(E1 shortcut hazard). First few: {leaks[:5]}"
    )


def test_balanced_negative_ratio_in_band():
    """Gate 2: the balanced training set's negative fraction stays in 0.40-0.55."""
    rows = _rows(BALANCED)
    neg = sum(1 for r in rows if "VERIFIED: no" in r.get("output", ""))
    frac = neg / len(rows)
    assert 0.40 <= frac <= 0.55, f"balanced negative fraction {frac:.3f} outside design band 0.40-0.55"


def test_frozen_holdout_disjoint_from_training():
    """Gate 3: a versioned holdout exists and none of its facts appear in training.

    The shipped rows carry only instruction+output (no meta), so we verify the
    invariant by CONTENT: each held-out golden id's own (de-glossed) statement must
    not appear as a training statement — the student never sees the holdout it will
    later be scored on.
    """
    if not HELDOUT.exists():
        pytest.skip("heldout manifest not built")
    manifest = json.loads(HELDOUT.read_text(encoding="utf-8"))
    heldout = set(manifest.get("heldout_golden_ids", []))
    assert heldout, "heldout manifest is empty — no frozen holdout to protect"

    # held-out id -> the emitted (de-glossed) statement, mirroring the builder's emit.
    by_id = {row[0]: row for row in sf.SEED}
    heldout_statements = set()
    for hid in heldout:
        row = by_id.get(hid)
        if row:
            heldout_statements.add(sf.REWORD_V2.get(hid) or sf.degloss_statement(row[1]))

    train_statements = {s for r in _rows(TRAIN) + _rows(BALANCED)
                        if (s := _statement(r.get("instruction", "")))}
    leaked = heldout_statements & train_statements
    assert not leaked, f"{len(leaked)} held-out fact(s) leaked into training: {sorted(leaked)[:3]}"
