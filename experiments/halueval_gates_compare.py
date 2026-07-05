"""
HaluEval gate bake-off — can any OWNED/better cheap signal beat FLARE's logprob gate?

halueval_gated.py established the logprob gate (FLARE's mechanism): AUROC ~0.87, beats random
grounding by +0.06. This asks the follow-up: on the SAME model (gpt-4o-mini) and SAME 40 items,
does a richer surprise signal route grounding BETTER than free logprob? Three oracle-free gates,
each deciding which items to ground (higher signal = more likely hallucinating = ground it):

  1. logprob          -mean token-logprob of the baseline answer                [FLARE]
  2. self_consistency K=5 samples @ temp 0.8; disagreement = 1 - modal/K         [semantic entropy]
  3. council_delta    cross-model {4o-mini, 4o, 3.5}; Δ = 1 - max-agreement       [SAC3 / council-Δ]

NOTE ON THE ACTUAL Σ₀ CANARY: the hidden-state surprise canary cannot run here — gpt-4o-mini is
closed (no internal states; that is *why* FLARE uses logprobs). These are the API-feasible,
directly-comparable cousins; none is novel (all three are published). The strict canary test needs
an open model (Ouro) and is the separate, heavier follow-up. What this buys: which CHEAP gate to
actually use, measured on our harness, and whether the expensive council beats free logprob.

Outcome per item is fixed by gpt-4o-mini (baseline b_i, grounded g_i); the gates only pick WHICH to
ground, so this is a clean test of signal quality. Needs egress + OPENAI_API_KEY.

Run:  python experiments/halueval_gates_compare.py
"""
from __future__ import annotations

import concurrent.futures as cf
import json
import os
import re
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "data" / "eval" / "halueval-qa-subset.jsonl"
OUT = REPO / "data" / "eval" / "halueval_gates_compare_results.json"
PRIMARY = "gpt-4o-mini"
COUNCIL = ["gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo"]
K_SC = 5


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", (s or "").lower()).strip()


def contains_gold(a: str, g: str) -> bool:
    a, g = norm(a), norm(g)
    return bool(g) and g in a


def gpt(prompt, model=PRIMARY, temperature=0.0, logprobs=False):
    from openai import OpenAI
    c = OpenAI(api_key=os.environ["OPENAI_API_KEY"], timeout=40, max_retries=2)
    kw = dict(model=model, temperature=temperature, max_tokens=60,
              messages=[{"role": "user", "content": prompt}])
    if logprobs:
        kw["logprobs"] = True
    try:
        r = c.chat.completions.create(**kw)
    except Exception as e:
        return None, 0.0  # model unavailable on this key -> skip gracefully
    ch = r.choices[0]
    text = ch.message.content or ""
    lp = 0.0
    if logprobs and ch.logprobs and ch.logprobs.content:
        vs = [t.logprob for t in ch.logprobs.content]
        lp = sum(vs) / len(vs) if vs else 0.0
    return text, lp


def base_prompt(rec):
    return f"Answer the question in a few words.\nQuestion: {rec['question']}\nAnswer:"


def grounded_prompt(rec):
    return (f"Use ONLY the provided knowledge to answer in a few words.\n"
            f"Knowledge: {rec['knowledge']}\nQuestion: {rec['question']}\nAnswer:")


def one(rec):
    bp = base_prompt(rec)
    base, lp = gpt(bp, logprobs=True)                       # primary baseline + logprob
    grd, _ = gpt(grounded_prompt(rec))                      # primary grounded
    b = 1 if contains_gold(base, rec["right_answer"]) else 0
    g = 1 if contains_gold(grd, rec["right_answer"]) else 0

    # self-consistency: K samples at temp 0.8, disagreement vs modal answer
    sc = [gpt(bp, temperature=0.8)[0] for _ in range(K_SC)]
    normed = [norm(x) for x in sc if x]
    sc_dis = 1 - (Counter(normed).most_common(1)[0][1] / len(normed)) if normed else 0.0

    # council-Δ: cross-model disagreement (primary answer reused for 4o-mini)
    ans = [norm(base)]
    for m in COUNCIL:
        if m == PRIMARY:
            continue
        t, _ = gpt(bp, model=m)
        if t:
            ans.append(norm(t))
    council_d = 1 - (Counter(ans).most_common(1)[0][1] / len(ans)) if ans else 0.0

    return b, g, -lp, sc_dis, council_d      # surprise = -logprob (higher = ground)


def frontier_edge(sig, b, g, B, G, n):
    order = np.argsort(-sig)                  # most uncertain first
    gated = []
    for k in range(n + 1):
        fire = set(order[:k].tolist())
        gated.append(1 - sum((g[i] if i in fire else b[i]) for i in range(n)) / n)
    gated = np.array(gated)
    rnd = np.array([1 - ((k / n) * G + (1 - k / n) * B) / n for k in range(n + 1)])
    return float(np.mean(rnd - gated)), gated


def main():
    recs = [json.loads(l) for l in DATA.read_text(encoding="utf-8").splitlines() if l.strip()]
    n = len(recs)
    res = [None] * n
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for i, r in zip(range(n), ex.map(one, recs)):
            res[i] = r
    b = np.array([r[0] for r in res]); g = np.array([r[1] for r in res])
    sigs = {"logprob": np.array([r[2] for r in res]),
            "self_consistency": np.array([r[3] for r in res]),
            "council_delta": np.array([r[4] for r in res])}
    B, G = int(b.sum()), int(g.sum())
    y = 1 - b

    rows = {}
    for name, s in sigs.items():
        auroc = float(roc_auc_score(y, s)) if 0 < y.sum() < n else float("nan")
        edge, _ = frontier_edge(s, b, g, B, G, n)
        rows[name] = {"auroc": round(auroc, 3), "edge_over_random": round(edge, 4)}

    best = max(rows, key=lambda k: rows[k]["auroc"])
    rep = {"benchmark": "HaluEval-QA", "primary_model": PRIMARY, "council": COUNCIL,
           "n": n, "A_baseline_hall": round(1 - B / n, 3), "B_grounded_hall": round(1 - G / n, 3),
           "gates": rows, "best_by_auroc": best,
           "logprob_baseline_auroc": rows["logprob"]["auroc"],
           "note": ("API-feasible gate cousins (all published: FLARE/semantic-entropy/SAC3); the "
                    "strict Sigma0 hidden-state canary needs an open model (Ouro) and is not tested here."),
           "evidence_class": "MEASURED"}
    OUT.write_text(json.dumps(rep, indent=2), encoding="utf-8")

    print(f"n={n}  baseline_hall={1-B/n:.0%}  grounded_hall={1-G/n:.0%}  (correct {B}->{G})")
    print(f"{'gate':18}{'AUROC':>8}{'edge_vs_random':>16}")
    for name in ("logprob", "self_consistency", "council_delta"):
        r = rows[name]; mark = "  <- FLARE baseline" if name == "logprob" else ""
        print(f"{name:18}{r['auroc']:>8.3f}{r['edge_over_random']:>16.3f}{mark}")
    win = rows[best]["auroc"] - rows["logprob"]["auroc"]
    print(f"BEST: {best} (AUROC {rows[best]['auroc']:.3f}); "
          f"beats logprob by {win:+.3f} "
          f"({'within n=40 noise (~0.08 CI)' if abs(win) < 0.08 else 'exceeds n=40 noise'})")


if __name__ == "__main__":
    main()
