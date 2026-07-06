"""Contamination gates for the Track B grounding/calibration corpus (#2143).

The v1 (untracked) builder shipped a corpus that leaked all 66 heldout golden statements,
echoed 3 of the 4 eval no-evidence probes near-verbatim, re-injected the stale
continuum-hypothesis mislabel from un-regenerated JSONL exports, carried 84 degenerate
one-word changelog rows, and taught `confidence: 0.85` on 45% of rows. The adapter trained
on it (ouro-sigma0-grounding-v1, 2026-07-05) is unbenchmarkable on the 66-fact heldout.

These tests turn each defect into a CI invariant. They recompute every check
independently of the builder's own gates (a builder bug can't vouch for itself).
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SIG = REPO / "data" / "sigma0"
sys.path.insert(0, str(REPO / "scripts"))

from experiments import sigma0_seed_facts as sf  # noqa: E402
import build_sigma0_grounding_corpus as builder  # noqa: E402
from eval_sigma0_adapter import NO_EVIDENCE_PROMPTS, is_abstention  # noqa: E402


def _jsonl(path):
    return [json.loads(l) for l in path.open(encoding="utf-8") if l.strip()]


# ── the stale-export gate the audit asked for ────────────────────────────────────────


def test_seed_jsonl_exports_match_build_output():
    """data/sigma0/seed_facts.jsonl + golden_dataset.jsonl must EQUAL what
    experiments/sigma0_seed_facts.py build() emits today. This is exactly how the
    continuum-hypothesis mislabel got back into training: the fix landed in the module
    but the JSONL exports were never regenerated, and the corpus builder read the stale
    files. Red here means: run `python experiments/sigma0_seed_facts.py` and commit."""
    recs, _tuples, golden, _summary = sf.build()
    assert _jsonl(SIG / "seed_facts.jsonl") == recs, (
        "seed_facts.jsonl is stale — regenerate with `python experiments/sigma0_seed_facts.py`")
    assert _jsonl(SIG / "golden_dataset.jsonl") == golden, (
        "golden_dataset.jsonl is stale — regenerate with `python experiments/sigma0_seed_facts.py`")


# ── corpus hygiene, recomputed independently of the builder's own asserts ────────────


@pytest.fixture(scope="module")
def corpus():
    rows, report = builder.build_corpus(allow_v1_key=True)
    return rows, report


def test_no_heldout_fact_appears_in_training(corpus):
    rows, _ = corpus
    held = json.loads((SIG / "ouro_honesty_heldout_ids.json").read_text(encoding="utf-8"))
    hyp_by_id = {r[0]: r[1] for r in sf.SEED}
    missing = [h for h in held["heldout_golden_ids"] if h not in hyp_by_id]
    assert not missing, f"heldout manifest names unknown fact ids: {missing}"
    all_text = "\n".join(r["instruction"] + "\n" + r["output"] for r in rows)
    leaked = [h for h in held["heldout_golden_ids"] if hyp_by_id[h] in all_text]
    assert not leaked, f"heldout facts present in training corpus: {leaked[:5]}"


def test_no_eval_probe_phrasing_in_training(corpus):
    rows, _ = corpus

    def norm(s):
        return " ".join(s.lower().replace("`", "").split())

    probe_cores = [norm(p.replace("State your confidence.", "")) for p in NO_EVIDENCE_PROMPTS]
    # these identifiers exist ONLY as eval fillers -> banned anywhere in the corpus
    probe_tokens = ["retry_budget_ms", "dark_launch"]
    # generic probe bigrams occur in real claim text; banned only in no-evidence QUESTIONS
    question_sigs = ["config key", "primary database table", "staging server", "feature flag"]
    for r in rows:
        ins = norm(r["instruction"])
        for core in probe_cores:
            assert core not in ins, f"eval probe leaked into training: {r['instruction'][:100]}"
        for tok in probe_tokens:
            assert tok not in ins, f"eval-probe token '{tok}' in: {r['instruction'][:100]}"
        if r["instruction"].endswith(builder.ABSTAIN_SUFFIX):
            for sig in question_sigs:
                assert sig not in ins, (
                    f"abstention question echoes eval probe '{sig}': {r['instruction'][:100]}")


def test_no_degenerate_short_claims(corpus):
    """Applies to the s1 (changelog-derived) templates only — key facts may legitimately
    be short ('The Riemann hypothesis.')."""
    rows, _ = corpus
    quoted = re.compile(
        r"(?:epistemic status of:|claim externally verified, and what is its evidence class\?) '(.*)'\n",
        re.S)
    for r in rows:
        m = quoted.search(r["instruction"])
        if m:
            claim = m.group(1)
            assert len(claim.split()) >= builder.MIN_CLAIM_WORDS, (
                f"degenerate claim survived: {claim!r}")


def test_no_conflicting_supervision(corpus):
    """One instruction must map to exactly one output (the balanced epistemic slice
    oversamples identical rows, which is fine — identical, not conflicting)."""
    rows, _ = corpus
    outs = {}
    for r in rows:
        outs.setdefault(r["instruction"], set()).add(r["output"])
    conflicted = {k[:80] for k, v in outs.items() if len(v) > 1}
    assert not conflicted, f"conflicting supervision: {sorted(conflicted)[:3]}"


def test_confidence_targets_are_not_a_monoculture(corpus):
    rows, _ = corpus
    hist = Counter()
    for r in rows:
        m = re.search(r"confidence:\s*([0-9.]+)\s*$", r["output"])
        if m:
            hist[m.group(1)] += 1
    total = sum(hist.values())
    assert total > 0
    val, n = hist.most_common(1)[0]
    assert n / total <= builder.MAX_CONF_FRACTION, (
        f"confidence monoculture: {val} on {n}/{total} rows ({n / total:.0%})")


def test_epistemic_slice_survives_dedup_with_balance_intact(corpus):
    """The balanced 2-line slice is intentionally oversampled; global dedup used to
    collapse it 147->103 and flip its class balance."""
    rows, report = corpus
    epi_disk = _jsonl(SIG / "ouro_honesty_train_balanced.jsonl")
    epi_in_corpus = [r for r in rows if r["instruction"].startswith("You classify the epistemic status")]
    # allow only heldout-driven removals, never dedup collapse
    assert len(epi_in_corpus) == len(epi_disk) - report["excluded"]["epi_heldout"]
    balance = Counter(r["output"].splitlines()[0] for r in epi_in_corpus)
    disk_balance = Counter(r["output"].splitlines()[0] for r in epi_disk)
    for cls, n_disk in disk_balance.items():
        assert balance[cls] >= n_disk - report["excluded"]["epi_heldout"], (
            f"{cls} collapsed: {n_disk} on disk -> {balance[cls]} in corpus")


def test_abstention_slice_reads_as_abstention_to_the_eval(corpus):
    """Every abstention output must trip eval_sigma0_adapter.is_abstention — otherwise
    the slice trains phrasing the eval doesn't credit."""
    for out in builder.ABSTAIN_OUTPUTS:
        assert is_abstention(out), f"abstention wording not recognized by eval: {out[:80]}"


def test_build_is_deterministic():
    r1, _ = builder.build_corpus(allow_v1_key=True)
    r2, _ = builder.build_corpus(allow_v1_key=True)
    assert r1 == r2


def test_builder_refuses_v1_key_by_default():
    """Retraining is gated on the corpus-v2 de-glossed key (PR #2165): without it the
    negatives announce their own status in-text and the adapter learns to read the gloss.
    Once build_v2 lands, the default build uses it and this guard is moot."""
    if builder.HAS_V2_KEY:
        pytest.skip("corpus-v2 key present — default build uses it")
    with pytest.raises(RuntimeError, match="corpus-v2"):
        builder.build_corpus(allow_v1_key=False)
