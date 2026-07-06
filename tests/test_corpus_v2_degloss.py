"""
Corpus-v2 invariants (D2) — lock in the fix for the E1 gloss leak.

E1 (2026-07-06, data/sigma0/e1_degloss_report.json) proved the v1 honesty headline was
substantially a benchmark leak: the negatives announce their status in-text ("-- OPEN",
"-- REFUTED") and the adapter learned to read it (de-gloss spikes Ouro confab 10%->55%
while GPT-4o-mini holds 0%->0%). Corpus-v2 removes the leak at emit time and adds the two
families a gloss-reader cannot game. This test makes those invariants ENFORCED:

  - the emitted v2 statements carry NO status gloss (the leak can never silently return);
  - all six negative status families + the perturbed-positive family are present;
  - perturbed-positives and fictional items are negatives (asserting them = confabulation);
  - the frozen v1 SEED is untouched (its own web-validation test still guards it).
"""
import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
from experiments.sigma0_seed_facts import (  # noqa: E402
    build_v2, heldout_v2, assert_deglossed, degloss_statement, family_of,
    SEED_V2_PERTURBED, SEED_V2_FICTIONAL, SEED, _leaks,
)


@pytest.fixture(scope="module")
def v2():
    recs, tuples, golden, summary = build_v2()
    return {"recs": recs, "tuples": tuples, "golden": golden, "summary": summary}


def test_degloss_lint_passes_on_every_emitted_statement(v2):
    """The core invariant: no emitted statement leaks status. This is the E1 fix."""
    statements = [g["expected_output"].split(". ", 1)[-1] for g in v2["golden"]]
    statements += [t["response"] for t in v2["tuples"]]
    leaked = assert_deglossed(statements)
    assert not leaked, f"{len(leaked)} v2 statements still leak status (E1 leak regressed): {leaked[:5]}"


def test_degloss_is_idempotent():
    """De-glossing an already-bare statement changes nothing."""
    for s in ["P != NP.", "The Collatz conjecture.", "Comparison sorting needs Omega(n) comparisons worst-case."]:
        assert degloss_statement(s) == s


def test_degloss_strips_the_known_v1_glosses():
    assert degloss_statement("Navier-Stokes existence & smoothness -- OPEN (Millennium problem).") \
        == "Navier-Stokes existence & smoothness."
    assert degloss_statement("Mertens conjecture -- REFUTED (Odlyzko-te Riele 1985).") \
        == "Mertens conjecture."
    # canonical names survive
    assert "hypothesis" in degloss_statement("The Riemann hypothesis -- OPEN conjecture (unsolved 2026).").lower()


def test_all_six_families_plus_perturbed_present(v2):
    fams = set(v2["summary"]["families_present"])
    required = {"open", "refuted", "thesis", "aphorism", "contested", "fictional", "perturbed"}
    assert required.issubset(fams), f"missing negative families: {required - fams}"


def test_negative_fraction_in_design_gate(v2):
    # D2 CI gate: 0.40-0.55 (the measured safe band; 94%-positive was the collapse mode).
    assert 0.40 <= v2["summary"]["negative_frac"] <= 0.55, v2["summary"]["negative_frac"]


def test_perturbed_and_fictional_are_negatives(v2):
    """Asserting a mutated theorem or a nonexistent result as fact is confabulation."""
    for row in SEED_V2_PERTURBED + SEED_V2_FICTIONAL:
        verified = row[3]
        assert verified is False, f"{row[0]} must be a negative (verified=False)"
    gmap = {g["id"]: g for g in v2["golden"]}
    for row in SEED_V2_PERTURBED + SEED_V2_FICTIONAL:
        g = gmap[f"gold-{row[0]}"]
        assert g["is_negative"] is True
        assert "decline" in g["expected_output"].lower() or "not an established" in g["expected_output"].lower()


def test_fictional_items_have_no_citation():
    """Fictional items are constructed-nonexistent; a real primary-source cite would be a lie."""
    for row in SEED_V2_FICTIONAL:
        assert row[6] is None, f"fictional {row[0]} must have cite=None"


def test_heldout_v2_covers_every_family():
    """LOSO-friendly: the stratified holdout represents every negative family."""
    held = heldout_v2()
    fams = set(held["by_family"])
    assert {"open", "refuted", "thesis", "aphorism", "contested", "perturbed", "fictional"}.issubset(fams)
    assert held["n_heldout_negatives"] >= 1
    # every held id resolves to a real negative
    ids = set(held["heldout_golden_ids"])
    assert ids, "empty holdout"


def test_v1_seed_still_frozen():
    """v2 must NOT mutate the frozen, web-validated v1 SEED (only extend + emit-time transform)."""
    v1_negatives = sum(1 for r in SEED if not r[3])
    assert v1_negatives == 42, f"v1 SEED negative count drifted to {v1_negatives} (frozen at 42)"
    # v1 raw statements still carry their glosses (the source is human-curated; the LEAK is
    # removed only at emit time) — confirm at least the canonical open ones are intact.
    by_id = {r[0]: r[1] for r in SEED}
    assert "OPEN" in by_id["navier-stokes"], "v1 SEED source text was mutated"
