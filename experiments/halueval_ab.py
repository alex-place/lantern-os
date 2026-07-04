"""
HaluEval A/B — ADR-0017 surprise-gated-decoding evidence gate (#1941).

Tests the core mechanism the surprise-intervention controller (`lib/surprise-intervene.js`)
relies on: when a model is likely to hallucinate, injecting a GROUNDING round reduces
hallucination. HaluEval-QA ships the ground-truth `knowledge` passage per question, so it is
a clean, judge-free A/B:

  A (baseline)   — answer the question with NO grounding (parametric memory only)
  B (grounded)   — answer WITH the knowledge passage injected (what the intervention's
                   Remember/Observe arms fetch when surprise fires)

Grading is deterministic (normalized containment of the gold `right_answer`), so no LLM
judge and no judge-bias. hallucination_rate = 1 − contains_gold. The ADR-0017 accept gate is
>= 20% relative reduction A→B.

Real external benchmark (RUCAIBox/HaluEval). Needs egress + OPENAI_API_KEY.
"""
from __future__ import annotations

import json
import os
import re
import sys
import concurrent.futures as cf
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "data" / "eval" / "halueval-qa-subset.jsonl"
OUT = REPO / "data" / "eval" / "halueval_ab_results.json"


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", (s or "").lower()).strip()


def contains_gold(answer: str, gold: str) -> bool:
    a, g = norm(answer), norm(gold)
    return bool(g) and g in a


def gpt(prompt: str, model="gpt-4o-mini") -> str:
    from openai import OpenAI
    c = OpenAI(base_url="https://api.openai.com/v1", api_key=os.environ["OPENAI_API_KEY"],
               timeout=30, max_retries=1)
    r = c.chat.completions.create(model=model, temperature=0, max_tokens=60,
                                  messages=[{"role": "user", "content": prompt}])
    return r.choices[0].message.content or ""


def answer(rec, grounded: bool) -> str:
    q = rec["question"]
    if grounded:
        p = (f"Use ONLY the provided knowledge to answer in a few words.\n"
             f"Knowledge: {rec['knowledge']}\nQuestion: {q}\nAnswer:")
    else:
        p = f"Answer the question in a few words.\nQuestion: {q}\nAnswer:"
    return gpt(p)


def run(records):
    def one(i):
        rec = records[i]
        base = answer(rec, grounded=False)
        grd = answer(rec, grounded=True)
        return (i, contains_gold(base, rec["right_answer"]), contains_gold(grd, rec["right_answer"]))
    res = [None] * len(records)
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for r in ex.map(one, range(len(records))):
            res[r[0]] = r
    n = len(records)
    base_correct = sum(1 for _, b, _ in res if b)
    grd_correct = sum(1 for _, _, g in res if g)
    base_hall = 1 - base_correct / n
    grd_hall = 1 - grd_correct / n
    rel_red = (base_hall - grd_hall) / base_hall if base_hall > 0 else 0.0
    return {"benchmark": "HaluEval-QA (RUCAIBox/HaluEval)", "model": "gpt-4o-mini",
            "n": n, "grading": "deterministic normalized-contains of gold right_answer",
            "baseline_hallucination_rate": round(base_hall, 3),
            "grounded_hallucination_rate": round(grd_hall, 3),
            "relative_reduction": round(rel_red, 3),
            "accept_gate_>=0.20": rel_red >= 0.20,
            "baseline_correct": base_correct, "grounded_correct": grd_correct}


def main():
    records = [json.loads(l) for l in DATA.read_text(encoding="utf-8").splitlines() if l.strip()]
    rep = run(records)
    OUT.write_text(json.dumps(rep, indent=2), encoding="utf-8")
    print(json.dumps(rep, indent=2))
    print(f"\nADR-0017 accept gate (>=20% rel. hallucination reduction A->B): "
          f"{'PASS' if rep['accept_gate_>=0.20'] else 'FAIL'} "
          f"({rep['baseline_hallucination_rate']:.0%} -> {rep['grounded_hallucination_rate']:.0%}, "
          f"{rep['relative_reduction']:.0%} rel.)")


if __name__ == "__main__":
    main()
