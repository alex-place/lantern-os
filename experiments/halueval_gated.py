"""
HaluEval A/B/C — the three-arm test that measures ADR-0017's *design*, not just its premise.

`halueval_ab.py` showed always-ground beats never-ground (55% -> 20% hall). That is the RAG
premise, not the novel claim. The novel claim is SELECTIVE grounding: fire the grounding round
only when the model is likely to be wrong (surprise high), and capture most of the gain at a
fraction of the grounding budget. That is only meaningful against the right control — grounding a
RANDOM subset of the same size — so this runs four arms:

  A  never-ground        (budget 0)
  B  always-ground       (budget N)          -- the premise
  C  surprise-gated      (ground the k least-confident baseline answers)   -- the design
  C_random  random-k     (analytic expectation; = the A->B line)           -- the control

The gate is ORACLE-FREE: it fires on the BASELINE answer's own mean token-logprob (never on the
gold). No threshold is tuned — the ENTIRE budget frontier k=0..N is swept, and the headline is
whether the gated curve sits BELOW the random line (the gate picks better than chance) and how
much of the A->B gain it captures at low budget. Grading is the same deterministic gold-contains.

Honest prior (from this session): output logprobs are a mediocre hallucination signal
(HaluEval logprob AUROC ~0.77; internal-state probe was 0.99). So the gate may only modestly beat
random — or not at all. Either way the number is the point. Needs egress + OPENAI_API_KEY.

Run:  python experiments/halueval_gated.py
"""
from __future__ import annotations

import concurrent.futures as cf
import json
import os
import re
from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "data" / "eval" / "halueval-qa-subset.jsonl"
OUT = REPO / "data" / "eval" / "halueval_gated_results.json"
MODEL = "gpt-4o-mini"


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", (s or "").lower()).strip()


def contains_gold(answer: str, gold: str) -> bool:
    a, g = norm(answer), norm(gold)
    return bool(g) and g in a


def gpt(prompt: str):
    """Return (text, mean_token_logprob). Higher mean logprob = more confident."""
    from openai import OpenAI
    c = OpenAI(api_key=os.environ["OPENAI_API_KEY"], timeout=40, max_retries=2)
    r = c.chat.completions.create(
        model=MODEL, temperature=0, max_tokens=60, logprobs=True,
        messages=[{"role": "user", "content": prompt}],
    )
    ch = r.choices[0]
    text = ch.message.content or ""
    lps = [t.logprob for t in ch.logprobs.content] if (ch.logprobs and ch.logprobs.content) else []
    mean_lp = sum(lps) / len(lps) if lps else 0.0
    return text, mean_lp


def answer(rec, grounded: bool):
    q = rec["question"]
    if grounded:
        p = (f"Use ONLY the provided knowledge to answer in a few words.\n"
             f"Knowledge: {rec['knowledge']}\nQuestion: {q}\nAnswer:")
    else:
        p = f"Answer the question in a few words.\nQuestion: {q}\nAnswer:"
    return gpt(p)


def main():
    records = [json.loads(l) for l in DATA.read_text(encoding="utf-8").splitlines() if l.strip()]
    n = len(records)

    def one(i):
        rec = records[i]
        tb, conf = answer(rec, grounded=False)      # baseline + its confidence (the gate signal)
        tg, _ = answer(rec, grounded=True)           # grounded
        b = 1 if contains_gold(tb, rec["right_answer"]) else 0
        g = 1 if contains_gold(tg, rec["right_answer"]) else 0
        return i, b, g, conf

    res = [None] * n
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for r in ex.map(one, range(n)):
            res[r[0]] = r

    b = np.array([r[1] for r in res])      # baseline correct (1/0)
    g = np.array([r[2] for r in res])      # grounded correct (1/0)
    conf = np.array([r[3] for r in res])   # baseline mean logprob (higher=confident)

    B, G = int(b.sum()), int(g.sum())
    A_hall, B_hall = 1 - B / n, 1 - G / n
    full_gain = A_hall - B_hall

    # does the surprise signal separate hallucination at all? (-conf predicts baseline-wrong)
    y_hall = 1 - b
    auroc = float(roc_auc_score(y_hall, -conf)) if 0 < y_hall.sum() < n else float("nan")
    conf_wrong = float(conf[b == 0].mean()) if (b == 0).any() else float("nan")
    conf_right = float(conf[b == 1].mean()) if (b == 1).any() else float("nan")

    # frontier: ground the k LEAST-confident items; sweep k=0..n
    order = np.argsort(conf)               # ascending: least confident (most surprising) first
    gated_hall, random_hall = [], []
    for k in range(n + 1):
        fire = set(order[:k].tolist())
        correct = sum((g[i] if i in fire else b[i]) for i in range(n))
        gated_hall.append(1 - correct / n)
        random_hall.append(1 - ((k / n) * G + (1 - k / n) * B) / n)   # analytic E[random-k]

    gated_hall = np.array(gated_hall); random_hall = np.array(random_hall)
    captured = (A_hall - gated_hall) / full_gain if full_gain > 0 else np.zeros(n + 1)

    # smallest budget capturing >=90% of the A->B gain, and the gate's edge over random there
    k90 = int(np.argmax(captured >= 0.90)) if (captured >= 0.90).any() else n
    half = n // 2
    # mean vertical gap between random line and gated curve (positive => gate below line => beats chance)
    edge_auc = float(np.mean(random_hall - gated_hall))

    rep = {
        "benchmark": "HaluEval-QA (RUCAIBox/HaluEval)", "model": MODEL, "n": n,
        "grading": "deterministic normalized-contains of gold right_answer",
        "gate": "oracle-free: baseline answer mean token-logprob; fire on least-confident",
        "A_never_ground_hall": round(A_hall, 3),
        "B_always_ground_hall": round(B_hall, 3),
        "baseline_correct": B, "grounded_correct": G,
        "surprise_separates_hallucination_AUROC": round(auroc, 3),
        "mean_conf_baseline_wrong": round(conf_wrong, 3),
        "mean_conf_baseline_right": round(conf_right, 3),
        "budget_for_90pct_gain": k90, "budget_for_90pct_gain_frac": round(k90 / n, 3),
        "gated_hall_at_90pct_budget": round(float(gated_hall[k90]), 3),
        "random_hall_at_same_budget": round(float(random_hall[k90]), 3),
        "gated_hall_at_50pct_budget": round(float(gated_hall[half]), 3),
        "random_hall_at_50pct_budget": round(float(random_hall[half]), 3),
        "gate_edge_over_random_mean_gap": round(edge_auc, 4),
        "gated_frontier": [round(float(x), 3) for x in gated_hall],
        "random_frontier": [round(float(x), 3) for x in random_hall],
        "evidence_class": "MEASURED",
    }
    OUT.write_text(json.dumps(rep, indent=2), encoding="utf-8")

    print(f"A never-ground hall = {A_hall:.0%}   B always-ground hall = {B_hall:.0%}   "
          f"(correct {B} -> {G} / {n})")
    print(f"surprise separates hallucination: AUROC = {auroc:.3f}   "
          f"(conf wrong {conf_wrong:.2f} vs right {conf_right:.2f})")
    print(f"C gated: captures 90% of A->B gain at budget {k90}/{n} ({k90/n:.0%})  "
          f"-> hall {gated_hall[k90]:.0%}  vs random@same {random_hall[k90]:.0%}")
    print(f"   at 50% budget: gated {gated_hall[half]:.0%} vs random {random_hall[half]:.0%}   "
          f"gate edge-over-random (area) = {edge_auc:+.3f}")
    verdict = ("GATE BEATS RANDOM" if edge_auc > 0.01 else
               "GATE ~= RANDOM (no selective value)" if edge_auc > -0.01 else
               "GATE WORSE THAN RANDOM")
    print(f"VERDICT: {verdict}")


if __name__ == "__main__":
    main()
