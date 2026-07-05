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

import argparse
import concurrent.futures as cf
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
try:
    from eval_ledger import append_leaderboard  # noqa: E402  (#2108 provenance-stamped row)
except ImportError:
    # #2108 not present yet: fall back to a plain append so this harness stands alone. When the
    # provenance helper lands, rows automatically pick up git_sha/served_checkpoint/campaign_id.
    def append_leaderboard(row, path=str(REPO / "data" / "eval" / "leaderboard.jsonl")):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        return row

DATA = REPO / "data" / "eval" / "halueval-qa-subset.jsonl"

# Answerer selection (#2112): the gate signal is the *baseline answer's own* confidence, so
# "which model" is the whole point — measuring the local Ouro's honesty needs Ouro to be the
# answerer, not the gpt-4o-mini oracle. The gate's surprise arm needs per-token logprobs; the
# local Ollama-API serve path (ouro_serve.py) doesn't return them, so the gate degrades to
# "unavailable" while the A/B hallucination measurement (which needs no logprobs) still runs.
MODEL = "gpt-4o-mini"          # overridden by --model
ANSWERER = "openai"            # overridden by --answerer
OLLAMA_BASE = "http://127.0.0.1:11434"


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", (s or "").lower()).strip()


def contains_gold(answer: str, gold: str) -> bool:
    a, g = norm(answer), norm(gold)
    return bool(g) and g in a


def gpt(prompt: str):
    """OpenAI answerer → (text, mean_token_logprob). Higher mean logprob = more confident."""
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


def ollama(prompt: str):
    """Local Ollama-API answerer (ouro_serve.py) → (text, None).

    Confidence is None: the serve path emits no per-token logprobs, so the gate's surprise
    signal is unavailable here. Reported honestly as such rather than faked with a proxy — a
    fabricated confidence would silently corrupt the gate AUROC.
    """
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {"temperature": 0, "num_predict": 60},
    }).encode("utf-8")
    req = urllib.request.Request(f"{OLLAMA_BASE}/api/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read().decode("utf-8"))
    return (d.get("message", {}) or {}).get("content", "") or "", None


def generate(prompt: str):
    return ollama(prompt) if ANSWERER == "ollama" else gpt(prompt)


def answer(rec, grounded: bool):
    q = rec["question"]
    if grounded:
        p = (f"Use ONLY the provided knowledge to answer in a few words.\n"
             f"Knowledge: {rec['knowledge']}\nQuestion: {q}\nAnswer:")
    else:
        p = f"Answer the question in a few words.\nQuestion: {q}\nAnswer:"
    return generate(p)


def main():
    global MODEL, ANSWERER, OLLAMA_BASE
    ap = argparse.ArgumentParser(description="HaluEval-QA A/B/C gated grounding (#2112)")
    ap.add_argument("--answerer", choices=["openai", "ollama"], default="openai",
                    help="who answers: the gpt-4o-mini oracle, or the local Ollama-API model (Ouro)")
    ap.add_argument("--model", default=None, help="model id (default gpt-4o-mini / ouro:latest)")
    ap.add_argument("--base", default=OLLAMA_BASE, help="Ollama-API base URL for --answerer ollama")
    ap.add_argument("--limit", type=int, default=0, help="cap items (0 = all); local runs are slow")
    ap.add_argument("--workers", type=int, default=None, help="concurrency (default 8 cloud / 1 local)")
    a = ap.parse_args()

    ANSWERER = a.answerer
    OLLAMA_BASE = a.base
    MODEL = a.model or ("ouro:latest" if ANSWERER == "ollama" else "gpt-4o-mini")
    workers = a.workers if a.workers is not None else (1 if ANSWERER == "ollama" else 8)

    records = [json.loads(l) for l in DATA.read_text(encoding="utf-8").splitlines() if l.strip()]
    if a.limit:
        records = records[:a.limit]
    n = len(records)

    def one(i):
        rec = records[i]
        tb, conf = answer(rec, grounded=False)      # baseline + its confidence (the gate signal)
        tg, _ = answer(rec, grounded=True)           # grounded
        b = 1 if contains_gold(tb, rec["right_answer"]) else 0
        g = 1 if contains_gold(tg, rec["right_answer"]) else 0
        return i, b, g, conf

    res = [None] * n
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for r in ex.map(one, range(n)):
            res[r[0]] = r

    b = np.array([r[1] for r in res])      # baseline correct (1/0)
    g = np.array([r[2] for r in res])      # grounded correct (1/0)
    # The gate needs per-token logprobs; some answerers (the local serve path) don't return them.
    # When ANY confidence is None the gate is UNAVAILABLE — we still report A/B honestly and skip
    # the surprise arm rather than fabricate a signal.
    have_conf = all(r[3] is not None for r in res)

    B, G = int(b.sum()), int(g.sum())
    A_hall, B_hall = 1 - B / n, 1 - G / n
    full_gain = A_hall - B_hall

    rep = {
        "benchmark": "HaluEval-QA (RUCAIBox/HaluEval)", "model": MODEL, "answerer": ANSWERER, "n": n,
        "grading": "deterministic normalized-contains of gold right_answer",
        "A_never_ground_hall": round(A_hall, 3),
        "B_always_ground_hall": round(B_hall, 3),
        "baseline_correct": B, "grounded_correct": G,
        "grounding_reduces_hallucination_rel": round(full_gain / A_hall, 3) if A_hall > 0 else None,
        "gate_available": have_conf,
        "evidence_class": "MEASURED",
    }

    print(f"[{ANSWERER}:{MODEL}] A never-ground hall = {A_hall:.0%}   "
          f"B always-ground hall = {B_hall:.0%}   (correct {B} -> {G} / {n})")

    if have_conf:
        conf = np.array([r[3] for r in res])
        y_hall = 1 - b
        auroc = float(roc_auc_score(y_hall, -conf)) if 0 < y_hall.sum() < n else float("nan")
        order = np.argsort(conf)           # ascending: least confident (most surprising) first
        gated_hall, random_hall = [], []
        for k in range(n + 1):
            fire = set(order[:k].tolist())
            correct = sum((g[i] if i in fire else b[i]) for i in range(n))
            gated_hall.append(1 - correct / n)
            random_hall.append(1 - ((k / n) * G + (1 - k / n) * B) / n)
        gated_hall = np.array(gated_hall); random_hall = np.array(random_hall)
        captured = (A_hall - gated_hall) / full_gain if full_gain > 0 else np.zeros(n + 1)
        k90 = int(np.argmax(captured >= 0.90)) if (captured >= 0.90).any() else n
        edge_auc = float(np.mean(random_hall - gated_hall))
        rep.update({
            "gate": "oracle-free: baseline answer mean token-logprob; fire on least-confident",
            "surprise_separates_hallucination_AUROC": round(auroc, 3),
            "budget_for_90pct_gain": k90, "budget_for_90pct_gain_frac": round(k90 / n, 3),
            "gate_edge_over_random_mean_gap": round(edge_auc, 4),
            "gated_frontier": [round(float(x), 3) for x in gated_hall],
            "random_frontier": [round(float(x), 3) for x in random_hall],
        })
        print(f"surprise separates hallucination: AUROC = {auroc:.3f}   "
              f"gate edge-over-random = {edge_auc:+.3f}")
    else:
        rep["gate"] = "UNAVAILABLE — answerer returns no token logprobs (A/B only)"
        print("gate: UNAVAILABLE (no token logprobs from this answerer) — A/B measured, surprise arm skipped")

    # Per-answerer results file so the Ouro run doesn't clobber the gpt-4o-mini one.
    out = REPO / "data" / "eval" / (
        "halueval_gated_results.json" if ANSWERER == "openai"
        else f"halueval_{ANSWERER}_{MODEL.replace(':', '_').replace('/', '_')}_results.json")
    out.write_text(json.dumps(rep, indent=2), encoding="utf-8")

    # Provenance-stamped leaderboard row (#2108): hallucination rate is 1 - accuracy; record the
    # baseline (never-ground) accuracy as the headline so the local model's on-model honesty is
    # a first-class, groupable row rather than only a side JSON.
    append_leaderboard({
        "benchmark": "halueval-qa", "label": f"halueval-{ANSWERER}-{MODEL.replace(':', '-')}",
        "model": MODEL, "answerer": ANSWERER, "n": n,
        "accuracy": round(B / n, 4), "hallucination_never_ground": round(A_hall, 3),
        "hallucination_always_ground": round(B_hall, 3), "gate_available": have_conf,
    })
    print(f"wrote {out.name} + leaderboard row")


if __name__ == "__main__":
    main()
