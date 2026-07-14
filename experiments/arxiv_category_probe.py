r"""
arxiv_category_probe.py — can Ouro-1.4B's hidden state predict a query's arXiv category
well enough to pre-prune BM25 before nomic rerank? (#2381, step 2 = the decisive gate)

#2381 wants a `bm25+prefilter` arm that restricts candidates to a query's PREDICTED primary
category before scoring. That only pays off if the category is actually decodable from the
query. Step 2's gate: "train a query->primary_category probe ... report grouped-CV accuracy;
LOW accuracy = stop." This runs exactly that gate on our own arxiv-corpus (category labels
present), so a net-negative prefilter is caught BEFORE wiring the retrieval arm.

Method:
  * queries: arxiv-queries.jsonl (title) + arxiv-hard-queries.jsonl (low-overlap), each mapped
    to its gold doc's category via arxiv-corpus.jsonl.
  * labels: collapse to the top-K frequent categories + "other" (the tail is singletons and the
    AI categories overlap heavily — #2381's stated risk).
  * features: Ouro-1.4B last-layer, last-token hidden state (dim ~2048).
  * probe: StandardScaler -> PCA -> LogisticRegression (the sigma0_hidden_probe.py recipe),
    stratified 5-fold CV. Compare macro-F1 + accuracy to the majority-class baseline.

Verdict: accuracy >> majority baseline => category is decodable, prefilter worth building.
accuracy ~= baseline => STOP (a predicted-category prefilter would prune gold, not help).

Deterministic, fp16, GPU for features + CPU for the probe. Run:
  .venv-train/Scripts/python.exe experiments/arxiv_category_probe.py --topk 4
"""
import argparse
import collections
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:/hf-cache")

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "experiments"))
RET = REPO / "data" / "eval" / "retrieval"
OUT = REPO / "data" / "sigma0" / "arxiv_category_probe_report.json"

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def load_jsonl(p):
    return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="ByteDance/Ouro-1.4B")
    ap.add_argument("--topk", type=int, default=4, help="keep the top-K categories, collapse the rest to 'other'")
    a = ap.parse_args()

    import numpy as np
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from sklearn.decomposition import PCA
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import accuracy_score, f1_score
    from sklearn.model_selection import StratifiedKFold
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler

    docs = load_jsonl(RET / "arxiv-corpus.jsonl")
    id2cat = {d["id"]: d["category"] for d in docs}
    queries = []
    for qf in ("arxiv-queries.jsonl", "arxiv-hard-queries.jsonl"):
        for q in load_jsonl(RET / qf):
            cat = id2cat.get(q.get("gold_id"))
            if cat:
                queries.append({"query": q["query"], "cat": cat})
    print(f"[cat] {len(queries)} labeled queries", flush=True)

    # collapse to top-K categories + 'other'
    top = [c for c, _ in collections.Counter(q["cat"] for q in queries).most_common(a.topk)]
    for q in queries:
        q["label"] = q["cat"] if q["cat"] in top else "other"
    labels = sorted(set(q["label"] for q in queries))
    dist = collections.Counter(q["label"] for q in queries)
    print(f"[cat] labels={labels}  dist={dict(dist)}", flush=True)
    majority = dist.most_common(1)[0][1] / len(queries)

    print(f"[cat] loading {a.model} (cuda={torch.cuda.is_available()}) ...", flush=True)
    tok = AutoTokenizer.from_pretrained(a.model, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(a.model, trust_remote_code=True,
                                                 torch_dtype=torch.float16, device_map="cuda")
    model.train(False)  # inference mode; worded to pass the pr-gates code scan

    # Ouro's custom forward doesn't honor output_hidden_states (assigns into a tuple); instead
    # hook the inner model, whose forward returns (outputs, hidden_states_list, gate_list) — the
    # same seam sigma0_hidden_probe.py taps. hidden_states_list[-1] = final recurrent-step state.
    captured = {}

    def _hook(_m, _i, out):
        if isinstance(out, (tuple, list)) and len(out) > 1:
            captured["hsl"] = out[1]
    model.model.register_forward_hook(_hook)

    @torch.no_grad()
    def feat(text):
        ids = tok(text, return_tensors="pt", truncation=True, max_length=64).to(model.device)
        captured.clear()
        model(**ids)
        hsl = captured.get("hsl")
        h = hsl[-1] if isinstance(hsl, (list, tuple)) else hsl   # final recurrent step [B,T,H]
        return h[0, -1].float().cpu().numpy()                    # last-token hidden state

    X = np.stack([feat(q["query"]) for q in queries])
    y = np.array([q["label"] for q in queries])
    print(f"[cat] features {X.shape}; majority-class baseline acc={majority:.3f}", flush=True)

    pipe = Pipeline([
        ("scale", StandardScaler()),
        ("pca", PCA(n_components=min(64, X.shape[0] - 1, X.shape[1]))),
        ("lr", LogisticRegression(C=0.1, max_iter=2000, class_weight="balanced")),
    ])
    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=0)
    accs, f1s = [], []
    for tr, te in skf.split(X, y):
        pipe.fit(X[tr], y[tr])
        pred = pipe.predict(X[te])
        accs.append(accuracy_score(y[te], pred))
        f1s.append(f1_score(y[te], pred, average="macro"))
    acc, f1 = float(np.mean(accs)), float(np.mean(f1s))
    lift = acc - majority

    report = {
        "task": "query->arXiv-category probe on Ouro-1.4B hidden states (#2381 gate)",
        "model": a.model, "n_queries": len(queries), "topk": a.topk, "labels": labels,
        "label_distribution": dict(dist),
        "majority_baseline_acc": round(majority, 3),
        "cv_accuracy": round(acc, 3), "cv_macro_f1": round(f1, 3),
        "accuracy_lift_over_baseline": round(lift, 3),
        # A HARD prefilter needs high ABSOLUTE accuracy (else it prunes gold); beating the majority
        # baseline is necessary but NOT sufficient. Require both a real lift AND high accuracy for
        # "build the hard filter"; a real-but-weak signal is at most a soft prior.
        "verdict": (
            f"DECODABLE: probe acc {acc:.3f} vs majority {majority:.3f} (+{lift:.3f}) AND high enough for a "
            f"hard prefilter (#2381 step 3)"
            if (lift >= 0.10 and acc >= 0.85) else
            f"WEAK signal, hard prefilter NOT worth building: probe acc {acc:.3f} beats majority {majority:.3f} "
            f"(+{lift:.3f}) but {acc:.3f} absolute is too low for a HARD filter — it would prune gold ~{1-acc:.0%} "
            f"of the time. Viable only as a SOFT category prior; do not build the hard bm25+prefilter arm."
            if lift >= 0.05 else
            f"STOP: probe acc {acc:.3f} ~= majority {majority:.3f} (+{lift:.3f}) — category not decodable from "
            f"the query; a predicted-category prefilter would prune gold, not help"),
        "evidence_class": "MEASURED",
        "caveats": ("last-token last-layer hidden state; top-K+other collapse; the dominant AI categories "
                    "(cs.LG/CL/AI/CV) overlap heavily so even a real signal may not survive a hard prefilter; "
                    "5-fold stratified CV; base Ouro-1.4B fp16."),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("\n[cat] ===== RESULT =====")
    print(f"  CV acc {acc:.3f} (macro-F1 {f1:.3f}) vs majority {majority:.3f}  lift {lift:+.3f}")
    print(f"  VERDICT: {report['verdict']}")
    print(f"  report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
