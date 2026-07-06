#!/usr/bin/env python3
"""
Build the consolidated Σ₀ grounding/calibration corpus for the Track B honesty adapter (#2143).

Targets what scripts/eval_sigma0_adapter.py rewards:
  - stated `confidence: <0-1>` that tracks correctness (ECE/Brier)
  - abstention ("insufficient evidence" + low confidence) on no-evidence prompts
  - claim/evidence/confidence/source structure (format adherence)

This is builder v2. The v1 builder (untracked) produced a contaminated corpus that
ouro-sigma0-grounding-v1 was trained on (2026-07-05); that adapter is unbenchmarkable on
the 66-fact heldout. v2 closes every leak the contamination audit found:

  1. HELDOUT EXCLUSION — every id in data/sigma0/ouro_honesty_heldout_ids.json (and the
     corpus-v2 stratified holdout, when available) is excluded from every slice, and a
     final text-level assert proves no heldout hypothesis appears anywhere in the corpus.
     (v1 leaked all 66 heldout golden statements verbatim.)
  2. EVAL-PROBE EXCLUSION — the NO_EVIDENCE_PROMPTS from eval_sigma0_adapter are imported
     and asserted absent; the abstention slice uses a disjoint prompt bank.
     (v1's abstention slice reproduced 3 of the 4 eval probes near-verbatim.)
  3. FRESH KEY, NEVER STALE EXPORTS — seed/golden slices are regenerated in-memory from
     experiments/sigma0_seed_facts.py build()/build_v2(), never read from the JSONL
     exports. (v1 re-injected the continuum-hypothesis mislabel from stale exports.)
  4. NO DEGENERATE ROWS — s1-derived rows require >= MIN_CLAIM_WORDS words of claim text,
     and instructions with conflicting outputs are dropped entirely.
     (v1 carried 84 one-word "Fixed/Added/Changed" rows with conflicting outputs.)
  5. CONFIDENCE DIVERSITY — targets are banded by evidence class with deterministic
     index jitter; the build fails if any single value exceeds MAX_CONF_FRACTION.
     (v1 taught `confidence: 0.85` on 45% of rows, gaming ECE/Brier.)
  6. BALANCE-PRESERVING DEDUP — the balanced epistemic slice is appended after dedup so
     its intentional oversampling survives. (v1's dedup collapsed it 147->103, flipping
     the class balance.)

By default the build REQUIRES the corpus-v2 de-glossed key (experiments/sigma0_seed_facts
build_v2, PR #2165): E1 showed the v1 key's negatives announce their own status in-text,
so an adapter trained on them learns to read the gloss, not to judge truth. Pass
--allow-v1-key to build from the v1 key anyway (do NOT retrain on that output).

Deterministic (no RNG, no timestamps) — index-based variation only.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SIG = REPO / "data" / "sigma0"
OUT = SIG / "sigma0_grounding_train.jsonl"
REPORT = SIG / "sigma0_grounding_build_report.json"

sys.path.insert(0, str(REPO / "experiments"))
sys.path.insert(0, str(REPO / "scripts"))
import sigma0_seed_facts as sf  # noqa: E402
from eval_sigma0_adapter import NO_EVIDENCE_PROMPTS  # noqa: E402

HAS_V2_KEY = hasattr(sf, "build_v2") and hasattr(sf, "heldout_v2")

MIN_CLAIM_WORDS = 4          # s1 claims shorter than this are changelog noise, not facts
MAX_CONF_FRACTION = 0.30     # no single confidence value may exceed this share of rows

# Deterministic confidence bands per evidence situation: (base, lo, hi).
CONF_BANDS = {
    "PROVEN": (0.97, 0.92, 1.0),
    "MEASURED": (0.88, 0.82, 0.94),
    "NEGATIVE": (0.18, 0.12, 0.30),   # open/refuted/fictional -> decline with low conf
    "S1_CORRECT": (0.80, 0.72, 0.90),
    "ABSTAIN": (0.10, 0.05, 0.20),
}
_JITTER = (0.0, 0.02, -0.02, 0.04, -0.04, 0.06, -0.03)


def banded_conf(kind, i, ceiling=None):
    base, lo, hi = CONF_BANDS[kind]
    if ceiling is not None:
        try:
            hi = min(hi, float(ceiling))
        except (TypeError, ValueError):
            pass
    v = max(lo, min(hi, base + _JITTER[i % len(_JITTER)]))
    return round(v, 2)


def load_jsonl(name):
    p = SIG / name
    if not p.exists():
        return []
    return [json.loads(l) for l in p.open(encoding="utf-8") if l.strip()]


def heldout_fact_ids():
    """Union of every holdout manifest this corpus must never train on."""
    v1 = json.loads((SIG / "ouro_honesty_heldout_ids.json").read_text(encoding="utf-8"))
    ids = set(v1["heldout_golden_ids"])
    if HAS_V2_KEY:
        ids |= set(sf.heldout_v2()["heldout_golden_ids"])
    return ids


def heldout_hypothesis_texts(held_ids):
    """Every surface form of a heldout fact (raw v1 text + de-glossed v2 text)."""
    texts = set()
    key_rows = list(sf.SEED) + (list(getattr(sf, "SEED_V2_EXT", [])) if HAS_V2_KEY else [])
    for row in key_rows:
        fid, hyp = row[0], row[1]
        if fid in held_ids:
            texts.add(hyp)
            if HAS_V2_KEY:
                texts.add(sf._degloss_row(row)[1])
    return {t for t in texts if t}


# Abstention prompt bank — DISJOINT from eval_sigma0_adapter.NO_EVIDENCE_PROMPTS by
# construction (different scenarios, none of the eval fillers or surface forms).
ABSTAIN_TEMPLATES = [
    "Without being shown the deployment environment, what is {X} currently set to?",
    "What timeout in seconds did the operator configure for {X}?",
    "How many rows did last night's {X} export contain?",
    "Which internal hostname serves the {X} dashboard?",
    "What did the team decide about {X} in yesterday's standup?",
    "What is the exact version string of the {X} binary installed on the ops box?",
    "What percentage of traffic is the {X} experiment receiving right now?",
    "What alert threshold is set for {X} this week?",
]
ABSTAIN_FILLERS = [
    "WORKER_POOL_SIZE", "the ingest service", "the sessions archive", "the metrics relay",
    "CACHE_EVICT_SECS", "the billing cron", "the vendor ledger", "TELEMETRY_SAMPLE_PCT",
    "the export scheduler", "GC_PAUSE_TARGET_MS", "the review queue", "the checkout rollout",
]
# Abstention wording variety — every form must satisfy eval_sigma0_adapter.is_abstention.
ABSTAIN_OUTPUTS = [
    "I don't have the evidence to answer that — that value was never provided in context. "
    "Insufficient evidence; I won't fabricate one.",
    "There is no evidence in context for this. I cannot determine the value, and guessing "
    "would be fabrication.",
    "Insufficient information — this asks about state I have no way to know. I decline to "
    "invent an answer.",
    "I cannot verify this from anything given here. Not enough evidence to answer honestly.",
]

# Eval-probe leak signatures. The project-specific identifiers exist ONLY as eval fillers,
# so they are banned corpus-wide; the generic bigrams occur legitimately in real claim text
# (changelog-derived s1 rows mention feature flags), so they are banned only in
# no-evidence-question instructions — the slice where echoing a probe teaches the answer key.
EVAL_PROBE_TOKENS = ["retry_budget_ms", "dark_launch"]
EVAL_PROBE_QUESTION_SIGNATURES = [
    "config key",
    "primary database table",
    "staging server",
    "feature flag",
]
ABSTAIN_SUFFIX = "State your confidence. End with: confidence: <0-1>."


def _norm(s):
    return " ".join((s or "").lower().replace("`", "").split())


def probe_hits(rows):
    """Instructions that near-verbatim reproduce an eval probe (must be empty)."""
    probe_cores = [_norm(p) for p in NO_EVIDENCE_PROMPTS]
    hits = []
    for r in rows:
        ins = _norm(r["instruction"])
        if any(s in ins for s in probe_cores + EVAL_PROBE_TOKENS):
            hits.append(r["instruction"][:120])
        elif r["instruction"].endswith(ABSTAIN_SUFFIX) and \
                any(s in ins for s in EVAL_PROBE_QUESTION_SIGNATURES):
            hits.append(r["instruction"][:120])
    return hits


def build_key_slices(held_ids):
    """Slices 1+2 regenerated from the seed-facts module (fresh key, heldout excluded)."""
    if HAS_V2_KEY:
        recs, _tuples, golden, _summary = sf.build_v2()
    else:
        recs, _tuples, golden, _summary = sf.build()
    rows, skipped = [], 0

    # 1) golden — question -> grounded answer + class + source + confidence
    for i, g in enumerate(golden):
        fid = g["id"].replace("gold-", "")
        if fid in held_ids:
            skipped += 1
            continue
        q, ans, cls = g["input"].strip(), g["expected_output"].strip(), g["expected_class"]
        src = g.get("source") or "internal knowledge"
        if g["is_negative"]:
            conf = banded_conf("NEGATIVE", i)
        elif cls == "PROVEN":
            conf = banded_conf("PROVEN", i, g.get("confidence_ceiling"))
        else:
            conf = banded_conf("MEASURED", i, g.get("confidence_ceiling"))
        rows.append({
            "instruction": q + "\nGround your answer and end with: confidence: <0-1>.",
            "output": f"Claim: {ans}\nEvidence class: {cls}.\nSource: {src}.\nconfidence: {conf}"})

    # 2) seed convergence records — hypothesis -> result + class + cite + confidence
    for i, d in enumerate(recs):
        fid = d["id"].replace("seed-", "")
        if fid in held_ids:
            skipped += 1
            continue
        hyp, cls = d["hypothesis"].strip(), d.get("class", "")
        cite = d.get("cite") or "constructed item — no external citation exists"
        if not d.get("verified"):
            conf = banded_conf("NEGATIVE", i)
        else:
            conf = banded_conf("PROVEN" if cls == "PROVEN" else "MEASURED", i, d.get("confidence"))
        rows.append({
            "instruction": f"Is this an established fact, and what is its evidence class? '{hyp}'"
                           "\nEnd with: confidence: <0-1>.",
            "output": f"Claim: {d.get('result', hyp).strip()}\nEvidence class: {cls}.\n"
                      f"Source: {cite}.\nconfidence: {conf}"})
    return rows, skipped


def build_s1_slice(held_ids, held_texts):
    """Slice 3: s1 honesty labels -> hedging/verification rows, minus heldout facts,
    minus degenerate one-word changelog claims, minus conflicting supervision."""
    candidates, dropped_short, dropped_heldout = [], 0, 0
    for i, d in enumerate(load_jsonl("s1_honesty_dataset.jsonl")):
        lab = d.get("label", {}) or {}
        claims = d.get("claims", []) or []
        prov = (d.get("provenance", {}) or {}).get("source", "internal")
        first = (claims[0].get("text") if claims else d.get("task", "") or "").strip()[:200]
        if len(first.split()) < MIN_CLAIM_WORDS:
            dropped_short += 1
            continue
        if prov.startswith("seed:") and prov.split(":", 1)[1] in held_ids:
            dropped_heldout += 1
            continue
        if any(t in first for t in held_texts):
            dropped_heldout += 1
            continue
        if lab.get("abstained"):
            candidates.append({
                "instruction": f"Classify the epistemic status of: '{first}'\nEnd with: confidence: <0-1>.",
                "output": "Insufficient evidence to verify this independently.\n"
                          f"Source: {prov} (not independently checked).\n"
                          f"confidence: {banded_conf('ABSTAIN', i)}"})
        elif lab.get("correct") and claims:
            cls = claims[0].get("class", "MEASURED")
            candidates.append({
                "instruction": f"Is this claim externally verified, and what is its evidence class? '{first}'"
                               "\nEnd with: confidence: <0-1>.",
                "output": f"Claim: {first}\nEvidence class: {cls}.\nSource: {prov} (external_check).\n"
                          f"confidence: {banded_conf('S1_CORRECT', i)}"})

    # conflicting supervision (same instruction, different outputs) teaches noise — drop all
    outs_by_ins = {}
    for r in candidates:
        outs_by_ins.setdefault(r["instruction"], set()).add(r["output"])
    conflicted = {k for k, v in outs_by_ins.items() if len(v) > 1}
    rows = [r for r in candidates if r["instruction"] not in conflicted]
    return rows, dropped_short, dropped_heldout, len(candidates) - len(rows)


def build_abstention_slice():
    """Slice 4: no-evidence probes about unknowable internals -> hedge + low confidence."""
    rows = []
    i = 0
    for tmpl in ABSTAIN_TEMPLATES:
        for k in range(5):
            filler = ABSTAIN_FILLERS[(i + k) % len(ABSTAIN_FILLERS)]
            q = tmpl.replace("{X}", filler)
            rows.append({
                "instruction": f"{q} State your confidence. End with: confidence: <0-1>.",
                "output": f"{ABSTAIN_OUTPUTS[i % len(ABSTAIN_OUTPUTS)]}\n"
                          f"confidence: {banded_conf('ABSTAIN', i)}"})
            i += 1
    return rows


def confidence_histogram(rows):
    import re
    hist = Counter()
    for r in rows:
        m = re.search(r"confidence:\s*([0-9.]+)\s*$", r["output"])
        if m:
            hist[m.group(1)] += 1
    return hist


def build_corpus(allow_v1_key=False):
    """Assemble the corpus; returns (rows, report). Raises on any contamination."""
    if not HAS_V2_KEY and not allow_v1_key:
        raise RuntimeError(
            "corpus-v2 de-glossed key unavailable (experiments/sigma0_seed_facts.py has no "
            "build_v2 — PR #2165 not merged). The v1 key leaks status glosses in-text (E1), "
            "so retraining on it is pointless. Pass --allow-v1-key only to build for "
            "inspection — do NOT retrain on the result.")

    held_ids = heldout_fact_ids()
    held_texts = heldout_hypothesis_texts(held_ids)

    key_rows, key_skipped = build_key_slices(held_ids)
    s1_rows, s1_short, s1_heldout, s1_conflicts = build_s1_slice(held_ids, held_texts)
    abst_rows = build_abstention_slice()

    # de-dup grounding slices only; the balanced epistemic slice is appended AFTER so its
    # intentional oversampling (class balance) survives.
    seen, grounding = set(), []
    for r in key_rows + s1_rows + abst_rows:
        k = (r["instruction"], r["output"])
        if k not in seen:
            seen.add(k)
            grounding.append(r)
    epi = load_jsonl("ouro_honesty_train_balanced.jsonl")
    epi_kept = [r for r in epi if not any(t in r["instruction"] for t in held_texts)]
    rows = grounding + epi_kept

    # ── contamination gates (hard failures, mirrored by tests/test_sigma0_grounding_corpus.py)
    all_text = "\n".join(r["instruction"] + "\n" + r["output"] for r in rows)
    leaks = sorted(t[:80] for t in held_texts if t in all_text)
    if leaks:
        raise AssertionError(f"heldout leak — {len(leaks)} held statements in corpus: {leaks[:3]}")
    hits = probe_hits(rows)
    if hits:
        raise AssertionError(f"eval-probe leak — {len(hits)} instructions echo NO_EVIDENCE_PROMPTS: {hits[:3]}")
    hist = confidence_histogram(rows)
    total = sum(hist.values())
    top_val, top_n = (hist.most_common(1)[0] if hist else ("-", 0))
    if total and top_n / total > MAX_CONF_FRACTION:
        raise AssertionError(
            f"confidence monoculture — {top_val} on {top_n}/{total} rows "
            f"({top_n / total:.0%} > {MAX_CONF_FRACTION:.0%})")

    report = {
        "key": "corpus-v2 (de-glossed)" if HAS_V2_KEY else "v1 (GLOSSED — do not retrain)",
        "rows_total": len(rows),
        "slices": {"key_facts": len(key_rows), "s1": len(s1_rows),
                   "abstention": len(abst_rows), "epistemic_2line": len(epi_kept)},
        "excluded": {"heldout_ids": len(held_ids), "key_rows_heldout": key_skipped,
                     "s1_heldout": s1_heldout, "s1_degenerate_short": s1_short,
                     "s1_conflicting_supervision": s1_conflicts,
                     "epi_heldout": len(epi) - len(epi_kept),
                     "deduped": len(key_rows + s1_rows + abst_rows) - len(grounding)},
        "confidence_histogram": dict(hist.most_common()),
        "confidence_top_fraction": round(top_n / total, 3) if total else 0.0,
        "gates": {"heldout_leaks": 0, "eval_probe_hits": 0,
                  "max_conf_fraction": MAX_CONF_FRACTION, "min_claim_words": MIN_CLAIM_WORDS},
    }
    return rows, report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--allow-v1-key", action="store_true",
                    help="build even without the corpus-v2 de-glossed key (inspection only "
                         "— never retrain on a v1-key corpus)")
    a = ap.parse_args(argv)
    try:
        rows, report = build_corpus(allow_v1_key=a.allow_v1_key)
    except (RuntimeError, AssertionError) as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 2
    with OUT.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"wrote {len(rows)} rows -> {OUT}")
    print(f"build report -> {REPORT}")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
