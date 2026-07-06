"""Machine-checks for the Ouro honesty corpus builder
(experiments/sigma0_ouro_honesty_corpus.py) -- the honesty invariants of the S1 training
set for the updated Ouro: holdout discipline, no class inflation, the encoded
changelog-tuple purge (#2054), entity-level heldout contamination, and the balanced
negative-fraction design band."""
import json

from experiments.sigma0_ouro_honesty_corpus import (
    build, split_golden, heldout_entity_hits,
    CONJECTURE_AUGMENTS, NEGATIVE_ENTITY_KEYWORDS,
    INSTR, TRAIN_OUT, BALANCED_OUT, HELDOUT_OUT,
)
from experiments.sigma0_seed_facts import SEED

# The #2054 hand-added conjecture rows that taught HELDOUT entities (BSD, Navier-Stokes,
# P vs NP, odd/perfect numbers) -- the regression this suite pins down.
CONTAMINATED_2054_STATEMENTS = [
    "The Birch and Swinnerton-Dyer conjecture is true.",
    "Solutions to the Navier-Stokes equations always remain smooth in three dimensions.",
    "P is not equal to NP.",
    "There are infinitely many perfect numbers.",
    "Every odd perfect number question has been resolved.",
    "Every even perfect number has a Mersenne-prime form and infinitely many exist.",
]


def test_holdout_split_is_deterministic_and_disjoint():
    """The answer key is split train/heldout with ZERO overlap (no memorization), and the
    split is deterministic (same ids every run)."""
    t1, h1 = split_golden()
    t2, h2 = split_golden()
    assert [r[0] for r in t1] == [r[0] for r in t2]          # deterministic
    train_ids = {r[0] for r in t1}
    held_ids = {r[0] for r in h1}
    assert not (train_ids & held_ids)                        # disjoint
    assert len(held_ids) >= 0.25 * (len(train_ids) + len(held_ids))  # real holdout


def test_no_golden_heldout_row_is_ever_emitted_as_training():
    train_records, _, heldout_ids, _ = build()
    emitted_golden = {str(r["meta"]["source"]).split(":", 1)[1] for r in train_records
                      if str(r["meta"]["source"]).startswith("golden:")}
    assert not (emitted_golden & set(heldout_ids))


def test_training_targets_are_never_class_inflated():
    """A negative (open/refuted/thesis) trains 'CLASS: HEURISTIC / VERIFIED: no' -- never
    PROVEN/MEASURED; a verified positive trains its earned class."""
    train_records, _, _, _ = build()
    for r in train_records:
        out, m = r["output"], r["meta"]
        if m["negative"]:
            assert "CLASS: HEURISTIC" in out and "VERIFIED: no" in out, r["meta"]
        else:
            assert "VERIFIED: yes" in out
            assert "CLASS: HEURISTIC" not in out


def test_negative_fraction_in_design_band():
    """The golden train shard keeps a real negative floor, and the BALANCED corpus --
    the file training actually consumes -- sits in the design band of 40-55% honest
    negatives (#2032 oversample recipe + conjecture augments)."""
    _, _, _, summary = build()
    assert summary["negative_frac_of_golden_train"] >= 0.20, summary
    assert 0.40 <= summary["negative_frac_balanced"] <= 0.55, summary


def test_records_match_trainer_schema_and_bench_format():
    """Exactly the {'instruction','output'} keys train-qlora-ouro.py consumes, and the
    golden rows use the SAME structured task the live benchmark scores."""
    train_records, balanced_records, _, _ = build()
    assert len(train_records) > 50
    assert len(balanced_records) >= len(train_records)
    for r in train_records[:20]:
        assert set(r) == {"instruction", "output", "meta"}
        assert r["instruction"] and r["output"]
    g = [r for r in train_records if str(r["meta"]["source"]).startswith("golden:")][0]
    assert g["instruction"].startswith(INSTR.split("%s")[0][:40])
    assert g["output"].splitlines()[0].startswith("CLASS: ")


def test_changelog_tuples_stay_purged():
    """The #2054 purge is ENCODED, not hand-applied: every emitted row is a golden-shard
    row or a curated augment. The ~250 changelog/commit-message tuples that were
    mislabeled 'MEASURED / VERIFIED: yes' (and collapsed a run to always-assert) can
    never silently return."""
    train_records, balanced_records, _, _ = build()
    for r in train_records:
        src = str(r["meta"]["source"])
        assert src.startswith(("golden:", "augment:")), src
        assert "CITE:" not in r["output"]        # the old s1-tuple output format
    # the polluted build was 343 rows; golden shard + augments is far below that
    assert len(train_records) < 200
    assert len(balanced_records) < 300


def test_augments_are_guarded_negatives_tied_to_train_shard():
    """Every emitted augment: (a) anchors to a SEED entity in the TRAIN shard, (b) clears
    the heldout-entity guard, (c) trains declination (HEURISTIC/no)."""
    train_records, _, heldout_ids, summary = build()
    g_train, _ = split_golden()
    train_ids = {r[0] for r in g_train}
    augments = [r for r in train_records
                if str(r["meta"]["source"]).startswith("augment:")]
    assert augments, "conjecture augments missing entirely"
    assert len(augments) == summary["augments"]
    for r in augments:
        seed_id = str(r["meta"]["source"]).split(":", 1)[1]
        assert seed_id in train_ids, f"augment {seed_id} not anchored in train shard"
        assert not heldout_entity_hits(r["instruction"], heldout_ids)
        assert r["output"] == "CLASS: HEURISTIC\nVERIFIED: no"


def test_2054_contaminated_statements_are_flagged_and_gone():
    """The guard actually catches the #2054 rows (BSD, Navier-Stokes, P vs NP, perfect
    numbers), and none of them is emitted anymore."""
    train_records, _, heldout_ids, _ = build()
    for stmt in CONTAMINATED_2054_STATEMENTS:
        assert heldout_entity_hits(stmt, heldout_ids), f"guard misses: {stmt}"
        assert not any(stmt in r["instruction"] for r in train_records), stmt


def test_no_heldout_entity_leaks_via_nongolden_rows():
    """Entity-level contamination check: no builder-added (non-golden) row may mention a
    heldout entity. Golden rows are governed by the id-disjoint split itself."""
    train_records, _, heldout_ids, _ = build()
    for r in train_records:
        if str(r["meta"]["source"]).startswith("golden:"):
            continue
        hits = heldout_entity_hits(r["instruction"] + "\n" + r["output"], heldout_ids)
        assert not hits, (hits, r["instruction"][-120:])


def test_no_heldout_statement_appears_verbatim_in_training():
    """Belt-and-suspenders for heldout POSITIVES too: no heldout SEED hypothesis text
    appears in any emitted training row."""
    train_records, _, _, _ = build()
    _, g_held = split_golden()
    blob = "\n".join(r["instruction"] + "\n" + r["output"] for r in train_records)
    for row in g_held:
        assert row[1] not in blob, row[0]


def test_entity_keyword_map_covers_every_seed_negative():
    """The guard can only catch what it has keywords for: every negative in SEED (either
    shard -- the split can drift) must have an entry, so a new negative without keywords
    fails here instead of silently escaping the guard."""
    for row in SEED:
        if not row[3]:      # verified=False -> negative
            assert row[0] in NEGATIVE_ENTITY_KEYWORDS, row[0]
            assert NEGATIVE_ENTITY_KEYWORDS[row[0]], row[0]


def test_augments_avoid_epistemic_eval_entities():
    """The separate epistemic eval (data/eval/epistemic-heldout.jsonl, #2054) scores
    Riemann/Goldbach/twin-prime/P-vs-NP phrasings -- augments must not teach those
    either (its runtime guard only catches verbatim statements)."""
    for kw in ("riemann", "goldbach", "twin prime", "p equals np",
               "premature optimization", "earth is flat", "vaccine"):
        for _, stmt in CONJECTURE_AUGMENTS:
            assert kw not in stmt.lower(), (kw, stmt)


def test_shipped_artifacts_match_builder_output():
    """Reproducibility: the tracked corpus files are EXACTLY what build() emits today.
    Editing the artifacts by hand, or changing the builder without regenerating them in
    the same PR, fails here."""
    train_records, balanced_records, heldout_ids, _ = build()

    def slim(records):
        return [{"instruction": r["instruction"], "output": r["output"]}
                for r in records]

    on_disk_train = [json.loads(l) for l in
                     TRAIN_OUT.read_text(encoding="utf-8").splitlines() if l.strip()]
    on_disk_balanced = [json.loads(l) for l in
                        BALANCED_OUT.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert on_disk_train == slim(train_records)
    assert on_disk_balanced == slim(balanced_records)
    manifest = json.loads(HELDOUT_OUT.read_text(encoding="utf-8"))
    assert manifest["heldout_golden_ids"] == heldout_ids
