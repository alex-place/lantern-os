"""
Sigma0 S1 honesty-dataset builder -- turns the repo's VERIFIED experience into the
honesty-tuple SFT records the ideal honest model is trained on (SIGMA0-HONEST-MODEL, S1).

Every emitted record carries the honesty structure <claim, evidence-class, cite,
confidence, verified, outcome>, and the class is DERIVED from the record's ACTUAL
verification, never asserted:

    verified + machine-check signal  -> PROVEN
    verified (+ evidence)            -> MEASURED
    not verified, informative        -> HEURISTIC     (honest: a hypothesis, not a result)
    no result / empty                -> dropped (noise) or ABSTAIN

Anti-collapse (the certificate's rule 5 + the red-team): ONLY externally-grounded rows
become positive targets. Unverified, model-self-generated rows are kept only as
honestly-labelled HEURISTIC / abstention examples -- they teach the class distinction and
calibration, and are NEVER promoted to MEASURED. Source-independence: a row with no
external check is marked independent=false and excluded from the positive set. Confidence
is capped (unverified -> 0.5 no-information prior; any `allowed_max_confidence` honored).

Sources:
  data/convergence/records.jsonl  -- structured [hypothesis, evidence, result, verified, confidence]
  changelog.d/*.md                -- each a LANDED (CI-verified-by-merge) change -> MEASURED positive

Deterministic, offline. Run:  python experiments/sigma0_s1_data_builder.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from experiments.sigma0_honest_objective import validate_claim  # noqa: E402
RECORDS = REPO / "data" / "convergence" / "records.jsonl"
CHANGELOG_D = REPO / "changelog.d"
OUT = REPO / "data" / "sigma0" / "s1_honesty_dataset.jsonl"

_MACHINE_CHECK = re.compile(r"pytest|test_|exec[- ]?verif|machine.?check|passed|assert", re.I)
_LOOP_STAGE = re.compile(r"Strengthens?\s+\*\*(Observe|Remember|Reason|Act|Verify|Converge)\*\*", re.I)
_NOISE = re.compile(r"^\s*(i am (still )?here|what can i help|ok|okay|hello|hi)\b", re.I)


def derive_class(verified: bool, has_evidence: bool, has_machine_check: bool,
                 has_result: bool) -> str:
    if not has_result:
        return "ABSTAIN"
    if verified and has_machine_check:
        return "PROVEN"
    if verified:
        return "MEASURED"
    return "HEURISTIC"          # unverified -> honest lower class, never MEASURED/PROVEN


def _cap_confidence(conf, verified, allowed_max):
    c = float(conf if conf is not None else 0.5)
    if allowed_max is not None:
        c = min(c, float(allowed_max))
    if not verified:
        c = min(c, 0.5)         # honest no-information prior for unverified rows
    return round(max(0.0, min(1.0, c)), 3)


def _as_text(val) -> str:
    """Schema-drift guard: 'result'/'hypothesis' were plain strings originally, but newer
    writers (e.g. three-doors scene records, #2099-era tool records) emit structured dicts.
    Flatten deterministically (sorted keys) so the honesty tuple survives the drift."""
    if val is None:
        return ""
    if isinstance(val, str):
        return val.strip()
    if isinstance(val, dict):
        parts = [f"{k}: {_as_text(v)}" for k, v in sorted(val.items())
                 if v not in (None, "", [], {})]
        return "; ".join(p for p in parts if p).strip()
    if isinstance(val, (list, tuple)):
        return " ".join(filter(None, (_as_text(v) for v in val))).strip()
    return str(val).strip()


def record_to_tuple(rec: dict):
    """Map a convergence record -> honesty tuple, or None to drop as noise."""
    result = _as_text(rec.get("result"))
    hyp = _as_text(rec.get("hypothesis"))
    verified = bool(rec.get("verified", False))
    evidence = rec.get("evidence") or rec.get("evidence_ids") or rec.get("applied_evidence") or []
    grounding = rec.get("grounding_signals") or []
    has_evidence = bool(evidence) or bool(grounding)
    blob = f"{result} {hyp} {' '.join(map(str, evidence))} {' '.join(map(str, grounding))}"
    has_mc = bool(_MACHINE_CHECK.search(blob))

    # DROP pure noise: unverified, no evidence, and a trivial/greeting result
    if not verified and not has_evidence and (not result or _NOISE.match(result)):
        return None

    cls = derive_class(verified, has_evidence, has_mc, bool(result))
    conf = _cap_confidence(rec.get("confidence"), verified, rec.get("allowed_max_confidence"))
    cite = (";".join(map(str, evidence))[:200] if evidence
            else rec.get("source") or f"convergence:{rec.get('id', 'unknown')}")
    independent = bool(verified and has_evidence)

    claim = {"text": (result or hyp)[:600], "class": cls, "cite": cite,
             "confidence": conf, "verified": verified,
             "outcome": "pass" if verified else "unrun"}
    return {
        "task": hyp[:400] or "(unlabelled convergence step)",
        "response": result[:1200],
        "claims": [claim],
        "label": {"correct": verified, "abstained": cls == "ABSTAIN",
                  "positive": independent},                      # only grounded rows are positive targets
        "provenance": {"source": rec.get("source") or rec.get("id"),
                       "external_check": "convergence-verified" if verified else "none",
                       "independent": independent, "loop_stage": rec.get("loop_stage")},
    }


def fragment_to_tuple(path: Path):
    """A changelog fragment = a landed, CI-verified change -> a MEASURED positive."""
    text = path.read_text(encoding="utf-8", errors="replace").strip()
    if not text:
        return None
    m = _LOOP_STAGE.search(text)
    stage = m.group(1) if m else None
    has_mc = bool(_MACHINE_CHECK.search(text))
    first = re.sub(r"\s+", " ", text.splitlines()[0]).lstrip("-# ").strip()
    claim = {"text": first[:600], "class": "PROVEN" if has_mc else "MEASURED",
             "cite": f"changelog.d/{path.name}", "confidence": 0.8,
             "verified": True, "outcome": "pass"}
    return {
        "task": f"land change: {first[:200]}",
        "response": re.sub(r"\s+", " ", text)[:1200],
        "claims": [claim],
        "label": {"correct": True, "abstained": False, "positive": True},
        "provenance": {"source": f"changelog.d/{path.name}",
                       "external_check": "CI-merge", "independent": True,
                       "loop_stage": stage},
    }


def build():
    rows, dropped = [], 0
    if RECORDS.exists():
        for line in RECORDS.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = record_to_tuple(rec)
            if t is None:
                dropped += 1
            else:
                rows.append(t)
    for frag in sorted(CHANGELOG_D.glob("*.md")):
        if frag.name.upper() == "README.MD":
            continue
        t = fragment_to_tuple(frag)
        if t:
            rows.append(t)

    # high-value web-verified seed facts: gold PROVEN/MEASURED positives AND honestly-
    # labelled OPEN conjectures / theses (HEURISTIC, verified=False) -- the honest
    # negatives that the verification-skewed internal corpus lacks.
    try:
        from experiments.sigma0_seed_facts import build as _build_seed
        rows.extend(_build_seed()[1])
    except Exception:
        pass

    by_class, positives, verified_n = {}, 0, 0
    for r in rows:
        c = r["claims"][0]["class"]
        by_class[c] = by_class.get(c, 0) + 1
        positives += int(r["label"]["positive"])
        verified_n += int(r["claims"][0]["verified"])
    honest_negatives = len(rows) - positives
    summary = {"total": len(rows), "dropped_noise": dropped, "by_class": by_class,
               "positives": positives, "honest_negatives": honest_negatives,
               "verified": verified_n,
               "verified_frac": round(verified_n / len(rows), 3) if rows else 0.0,
               "note": ("this corpus is verification-SKEWED (mostly verified positives; "
                        "unverified rows are chat-noise and dropped). Honest negatives "
                        "that teach calibration must be mined from REVERTED/refuted PRs "
                        "and 'confident-then-caught' turns -- an S1 follow-up, tracked.")}
    return rows, summary


def main():
    rows, summary = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print("S1 honesty dataset ->", OUT.relative_to(REPO))
    print(json.dumps(summary, indent=2))
    # honesty invariant, checked at build time: no unverified row is MEASURED/PROVEN
    bad = [r for r in rows if not r["claims"][0]["verified"]
           and r["claims"][0]["class"] in {"MEASURED", "PROVEN"}]
    print(f"class-inflation check: {len(bad)} unverified rows mislabelled MEASURED/PROVEN"
          f" ({'PASS' if not bad else 'FAIL'})")


if __name__ == "__main__":
    main()
