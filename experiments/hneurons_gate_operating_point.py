r"""
hneurons_gate_operating_point.py — turn the H-Neurons probe (#2209) into a shippable gate.

AUROC 0.97 is a curve, not a decision. To WIRE this into the Verify-stage surprise/abstention gate we
need operating points: at a chosen threshold, what fraction of hallucinations does it catch (recall)
and how often does it wrongly flag a true statement (false-positive rate)? This reports the
precision/recall/FPR curve from the probe's out-of-fold scores and picks sensible operating points:
  - high-precision (few false flags): threshold at ~5% FPR
  - high-recall (catch most hallucinations): threshold at ~90% recall
plus the balanced (Youden J) point. Fixed-holdout style: grouped-CV out-of-fold scores, so the
numbers are what a deployed gate would see on unseen facts.

Run:  .venv-train/Scripts/python.exe experiments/hneurons_gate_operating_point.py
"""
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:/hf-cache")
import numpy as np  # noqa: E402
import torch  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402
from sklearn.feature_selection import SelectKBest, f_classif  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import roc_curve, precision_recall_curve, roc_auc_score  # noqa: E402
from sklearn.model_selection import GroupKFold  # noqa: E402
from sklearn.pipeline import Pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "experiments"))
sys.path.insert(0, str(REPO / "scripts"))
from sigma0_probe_transfer import FACTS  # noqa: E402
from ouro_compat import patch_universal_transformer_cache  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

MID = os.environ.get("OURO_MODEL", "ByteDance/Ouro-1.4B-Thinking")
OUT = REPO / "data" / "sigma0" / "hneurons_gate_operating_point.json"


def main():
    print(f"[gate] loading {MID} ...", flush=True)
    tok = AutoTokenizer.from_pretrained(MID, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(MID, trust_remote_code=True,
                                                 torch_dtype=torch.float16, device_map="cuda").eval()
    patch_universal_transformer_cache()
    L = model.config.num_hidden_layers
    neur = {}

    def mk(i):
        def pre(_m, args):
            neur[i] = args[0][0, -1, :].detach().float().cpu().numpy()
        return pre
    hs = [model.model.layers[i].mlp.down_proj.register_forward_pre_hook(mk(i)) for i in range(L)]
    X, y, g = [], [], []
    fid = 0
    for d, facts in FACTS.items():
        for (tpl, t, f) in facts:
            for label, fill in ((1, t), (0, f)):   # label 1 = TRUE (not hallucinated)
                ids = tok(tpl.format(fill), return_tensors="pt").input_ids.to(model.device)
                neur.clear()
                with torch.no_grad():
                    model(input_ids=ids)
                X.append(np.concatenate([neur[i] for i in range(L)])); y.append(label); g.append(fid)
            fid += 1
    for h in hs:
        h.remove()
    X = np.stack(X); y = np.array(y); g = np.array(g)

    # out-of-fold probability that the statement is a HALLUCINATION (= P(false) = 1 - P(true))
    oof = np.zeros(len(y))
    for tr, te in GroupKFold(5).split(X, y, g):
        p = Pipeline([("sc", StandardScaler()),
                      ("sel", SelectKBest(f_classif, k=min(2000, X.shape[1]))),
                      ("lr", LogisticRegression(penalty="l1", solver="liblinear", C=0.1,
                                                max_iter=3000, class_weight="balanced"))])
        p.fit(X[tr], y[tr]); oof[te] = p.predict_proba(X[te])[:, 1]     # P(true)
    hall_score = 1.0 - oof                                              # P(hallucination)
    hall_label = (y == 0).astype(int)                                  # 1 = actually false/hallucinated
    auroc = roc_auc_score(hall_label, hall_score)

    fpr, tpr, thr = roc_curve(hall_label, hall_score)

    def at_fpr(target):
        i = np.argmin(np.abs(fpr - target))
        return {"threshold": round(float(thr[i]), 3), "recall_tpr": round(float(tpr[i]), 3),
                "fpr": round(float(fpr[i]), 3)}

    def at_recall(target):
        ok = np.where(tpr >= target)[0]
        i = ok[0] if len(ok) else len(tpr) - 1
        return {"threshold": round(float(thr[i]), 3), "recall_tpr": round(float(tpr[i]), 3),
                "fpr": round(float(fpr[i]), 3)}

    j = np.argmax(tpr - fpr)
    balanced = {"threshold": round(float(thr[j]), 3), "recall_tpr": round(float(tpr[j]), 3),
                "fpr": round(float(fpr[j]), 3)}

    report = {
        "task": "H-Neurons hallucination gate — operating points for the Verify stage (#2209)",
        "model": MID, "n_examples": int(len(y)), "auroc_hallucination": round(float(auroc), 4),
        "operating_points": {
            "high_precision_5pct_fpr": at_fpr(0.05),
            "balanced_youden_J": balanced,
            "high_recall_90pct": at_recall(0.90),
        },
        "reading": ("At the high-precision point the gate flags a generation as a likely hallucination "
                    "with ~5% false-positive rate, catching the listed recall of true hallucinations; "
                    "at the high-recall point it catches ~90% at a higher false-flag cost. Pick per the "
                    "product's tolerance: abstain/verify-more when P(hallucination) > threshold."),
        "how_to_wire": ("fit this probe once (persist SelectKBest indices + LR weights), then at serve "
                        "time capture the last-token down_proj neuron activations, score P(hallucination), "
                        "and route to the abstention/extra-verification path when it exceeds the chosen "
                        "threshold — a stronger signal than the free-logprob gate (0.71) it augments."),
        "evidence_class": "MEASURED", "caveats": "80 matched facts (n=160), grouped-CV OOF; small n.",
    }
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\n[gate] hallucination AUROC {auroc:.4f}")
    for k, v in report["operating_points"].items():
        print(f"  {k:24} thr {v['threshold']:<6} recall {v['recall_tpr']:<6} FPR {v['fpr']}")
    print(f"Report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
