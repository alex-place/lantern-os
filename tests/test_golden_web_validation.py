"""
Enforce that the sigma0 golden answer-key stays externally web-validated.

data/sigma0/golden_web_validation.json records a 2026-07-05 web-validation (three
independent validators, primary-source citations, zero flags). This test turns that
record from prose into an ENFORCED invariant against the live SEED:

  - every id in the manifest is a real SEED fact (no typo / stale id);
  - the batches' claimed classes match SEED (refuted/aphorism -> HEURISTIC, spot-check -> PROVEN);
  - 100% of the status-sensitive classes (every HEURISTIC negative + every MEASURED
    constant/law) are covered -- these are exactly the labels the confabulation-rate
    metric depends on, so adding a new negative WITHOUT re-validating it fails CI;
  - a "clean" result (flags == 0) is consistent with an empty corrections list.

If someone adds/renames a HEURISTIC or MEASURED fact and doesn't extend the manifest,
this test goes red -- the answer-key can't drift ungrounded.
"""
import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
from experiments.sigma0_seed_facts import SEED  # noqa: E402

MANIFEST = REPO / "data" / "sigma0" / "golden_web_validation.json"
CLS_OF = {t[0]: t[2] for t in SEED}


@pytest.fixture(scope="module")
def manifest():
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def validated_ids(manifest):
    ids = []
    for b in manifest["batches"]:
        ids.extend(b["ids"])
    return ids


def test_manifest_exists_and_parses(manifest):
    assert manifest["dataset"].endswith("SEED")
    assert manifest["result"].startswith("clean")  # the web pass was clean; later probes tracked separately


def test_every_manifest_id_is_a_real_seed_fact(validated_ids):
    unknown = [i for i in validated_ids if i not in CLS_OF]
    assert not unknown, f"manifest references ids not in SEED (typo/stale): {unknown}"


def test_no_duplicate_validated_ids(validated_ids):
    dupes = [i for i in set(validated_ids) if validated_ids.count(i) > 1]
    assert not dupes, f"id validated in more than one batch: {dupes}"


def test_batch_classes_match_seed(manifest):
    """The refuted/aphorism batch must be HEURISTIC in SEED; the spot-check must be PROVEN."""
    by_name = {b["name"]: b for b in manifest["batches"]}
    b3 = by_name["refuted-aphorisms-proven-spotcheck"]["ids"]
    # first 18 are refuted+aphorism (HEURISTIC), last 7 are the PROVEN spot-check
    spot = set(by_name["refuted-aphorisms-proven-spotcheck"].get("id_sources", {}))  # all have sources
    proven_spot = [i for i in b3 if CLS_OF[i] == "PROVEN"]
    heur_neg = [i for i in b3 if CLS_OF[i] == "HEURISTIC"]
    assert len(proven_spot) == 7, proven_spot
    assert len(heur_neg) == 18, heur_neg
    assert spot == set(b3), "every batch-3 id must carry a primary-source citation"


def test_all_status_sensitive_classes_are_100pct_covered(validated_ids):
    """The load-bearing invariant: every negative and every empirical datum was web-validated."""
    validated = set(validated_ids)
    heuristic = {i for i, c in CLS_OF.items() if c == "HEURISTIC"}
    measured = {i for i, c in CLS_OF.items() if c == "MEASURED"}
    missing_h = heuristic - validated
    missing_m = measured - validated
    assert not missing_h, f"HEURISTIC negatives NOT web-validated: {sorted(missing_h)}"
    assert not missing_m, f"MEASURED constants/laws NOT web-validated: {sorted(missing_m)}"


def test_coverage_counts_are_honest(manifest, validated_ids):
    cov = manifest["coverage"]
    assert cov["total_facts"] == len(SEED)
    assert cov["individually_validated"] == len(set(validated_ids)) == 83
    # the manifest must NOT claim to have individually validated all 159
    assert cov["individually_validated"] < len(SEED)


def test_web_pass_record_is_intact(manifest):
    """The web pass genuinely found zero flags -- that historical record stays exact."""
    assert manifest["flags"] == 0
    assert manifest["corrections"] == []


def test_post_web_findings_reference_real_facts_and_stay_negatives(manifest):
    """Anything a later probe found must name a real SEED id; a corrected negative
    (e.g. continuum-hypothesis) must STILL be a HEURISTIC negative in SEED, so the fix
    didn't quietly turn a negative into an asserted fact."""
    findings = manifest.get("post_web_findings", [])
    negatives = {t[0] for t in SEED if not t[3]}  # verified == False
    for f in findings:
        assert f["id"] in CLS_OF, f"post_web_finding names unknown id: {f['id']}"
        assert {"found_by", "issue", "fix"} <= set(f), f"finding {f['id']} missing provenance"
    # the one we know about: continuum-hypothesis was reworded but stays a HEURISTIC negative
    if any(f["id"] == "continuum-hypothesis" for f in findings):
        assert CLS_OF["continuum-hypothesis"] == "HEURISTIC"
        assert "continuum-hypothesis" in negatives
