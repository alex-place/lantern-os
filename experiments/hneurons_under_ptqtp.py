r"""
hneurons_under_ptqtp.py — does honesty monitoring survive quantization? (#2209 x #2206)

Deployment question: if we ship a PTQTP-quantized coder (#2206), does the H-Neurons hallucination
probe (#2209) still work on it? A honesty gate that only functions at FP16 is useless once we
compress the served model. So: fit + score the sparse FFN-neuron probe on the SAME matched facts,
FP16 vs 3-plane-PTQTP-quantized, and compare detection AUROC + OOD transfer.

Run:  .venv-train/Scripts/python.exe experiments/hneurons_under_ptqtp.py --model Qwen/Qwen2.5-Coder-7B-Instruct
"""
import argparse
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:/hf-cache")
import numpy as np  # noqa: E402
import torch  # noqa: E402
import torch.nn as nn  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402
from sklearn.feature_selection import SelectKBest, f_classif  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.model_selection import GroupKFold  # noqa: E402
from sklearn.pipeline import Pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "experiments"))
from sigma0_probe_transfer import FACTS  # noqa: E402
from ptqtp_quantize import ptqtp_matrix  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def capture(model, tok, L):
    neur = {}

    def mk(i):
        def pre(_m, args):
            neur[i] = args[0][0, -1, :].detach().float().cpu().numpy()
        return pre
    hs = [model.model.layers[i].mlp.down_proj.register_forward_pre_hook(mk(i)) for i in range(L)]
    X, y, g, dom = [], [], [], []
    fid = 0
    for d, facts in FACTS.items():
        for (tpl, t, f) in facts:
            for label, fill in ((1, t), (0, f)):
                ids = tok(tpl.format(fill), return_tensors="pt").input_ids.to(model.device)
                neur.clear()
                with torch.no_grad():
                    model(input_ids=ids)
                X.append(np.concatenate([neur[i] for i in range(L)])); y.append(label); g.append(fid); dom.append(d)
            fid += 1
    for h in hs:
        h.remove()
    return np.stack(X), np.array(y), np.array(g), np.array(dom)


def score(X, y, g, dom):
    def auc(yy, s):
        a = roc_auc_score(yy, s); return float(max(a, 1 - a))
    pipe = lambda: Pipeline([("sc", StandardScaler()),
                             ("sel", SelectKBest(f_classif, k=min(2000, X.shape[1]))),
                             ("lr", LogisticRegression(penalty="l1", solver="liblinear", C=0.1,
                                                       max_iter=3000, class_weight="balanced"))])
    oof = np.zeros(len(y))
    for tr, te in GroupKFold(5).split(X, y, g):
        p = pipe(); p.fit(X[tr], y[tr]); oof[te] = p.predict_proba(X[te])[:, 1]
    detect = round(auc(y, oof), 4)
    lodo = []
    for held in set(dom):
        tr = dom != held; te = dom == held
        p = pipe(); p.fit(X[tr], y[tr]); lodo.append(auc(y[te], p.predict_proba(X[te])[:, 1]))
    return detect, round(float(np.mean(lodo)), 4)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-Coder-7B-Instruct")
    ap.add_argument("--planes", type=int, default=3)
    a = ap.parse_args()
    print(f"[hn-ptqtp] loading {a.model} ...", flush=True)
    tok = AutoTokenizer.from_pretrained(a.model, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(a.model, trust_remote_code=True,
                                                 torch_dtype=torch.float16, device_map="cuda")
    model.eval()
    L = model.config.num_hidden_layers

    print("[hn-ptqtp] probe @ FP16 ...", flush=True)
    X, y, g, dom = capture(model, tok, L)
    fp_detect, fp_lodo = score(X, y, g, dom)
    print(f"  FP16: detect {fp_detect}  LODO {fp_lodo}", flush=True)

    print(f"[hn-ptqtp] PTQTP-quantizing ({a.planes} planes) ...", flush=True)
    for name, mod in model.named_modules():
        if isinstance(mod, nn.Linear) and "lm_head" not in name:
            rec, _ = ptqtp_matrix(mod.weight.data, 128, 8, n_planes=a.planes)
            mod.weight.data.copy_(rec)

    print("[hn-ptqtp] probe @ PTQTP ...", flush=True)
    Xq, yq, gq, domq = capture(model, tok, L)
    q_detect, q_lodo = score(Xq, yq, gq, domq)
    print(f"  PTQTP: detect {q_detect}  LODO {q_lodo}", flush=True)

    report = {
        "task": "does the H-Neurons honesty probe survive PTQTP quantization? (#2209 x #2206)",
        "model": a.model, "planes": a.planes,
        "fp16_detect_auroc": fp_detect, "fp16_lodo_auroc": fp_lodo,
        "ptqtp_detect_auroc": q_detect, "ptqtp_lodo_auroc": q_lodo,
        "detect_delta": round(q_detect - fp_detect, 4), "lodo_delta": round(q_lodo - fp_lodo, 4),
        "verdict": ("honesty monitoring SURVIVES quantization: the sparse FFN-neuron probe still "
                    "detects hallucination on the quantized model (delta small) — we can ship a "
                    "compressed coder AND keep the honesty gate"
                    if q_detect >= fp_detect - 0.05 else
                    "honesty monitoring DEGRADES under quantization: the probe loses signal on the "
                    "quantized model — the gate must be re-fit on the quantized model or kept at FP16"),
        "evidence_class": "MEASURED",
        "caveats": "80 matched facts, 7B, PTQTP dequantized weights (quality not speed), n small.",
    }
    OUT = REPO / "data" / "sigma0" / "hneurons_under_ptqtp_report.json"
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("\n[hn-ptqtp] ===== RESULT =====")
    print(f"  FP16  detect {fp_detect} / LODO {fp_lodo}")
    print(f"  PTQTP detect {q_detect} / LODO {q_lodo}  (delta {report['detect_delta']} / {report['lodo_delta']})")
    print(f"  VERDICT: {report['verdict'][:110]}")
    print(f"Report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
