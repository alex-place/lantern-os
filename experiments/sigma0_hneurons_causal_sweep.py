r"""
sigma0_hneurons_causal_sweep.py — does H-Neuron causality emerge at scale? (#2209, strengthen the null)

The K=50 zeroing test (sigma0_hneurons_causal.py) found the honesty neurons predictive but not
causally distinct from random on the output true>false margin. This strengthens that: sweep K and use
**mean-substitution** ablation (replace the neuron with its dataset-mean activation — a more faithful
intervention than zeroing), honesty vs random control at each K. If honesty-ablation collapses the
margin distinctly more than random at some K, causality emerges at scale; if not even at K=1000, the
"predictive != causal" conclusion is robust.

Run:  .venv-train/Scripts/python.exe experiments/sigma0_hneurons_causal_sweep.py
"""
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:/hf-cache")
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "experiments"))
from ouro_compat import patch_universal_transformer_cache  # noqa: E402
from sigma0_probe_transfer import FACTS  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402
from sklearn.feature_selection import SelectKBest, f_classif  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.pipeline import Pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

MID = os.environ.get("OURO_MODEL", "ByteDance/Ouro-1.4B-Thinking")
KS = [50, 200, 500, 1000]
OUT = REPO / "data" / "sigma0" / "hneurons_causal_sweep_report.json"


def main():
    print(f"[sweep] loading {MID} ...", flush=True)
    tok = AutoTokenizer.from_pretrained(MID, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        MID, trust_remote_code=True, torch_dtype=torch.float16, device_map="auto")
    model.eval()
    patch_universal_transformer_cache()
    L = model.config.num_hidden_layers
    inter = model.config.intermediate_size

    pairs = []
    for dom, facts in FACTS.items():
        for (tpl, t, f) in facts:
            pairs.append((tpl.split("{}")[0], tpl.format(t), tpl.format(f)))

    neur = {}

    def mk(idx):
        def pre(_m, args):
            neur[idx] = args[0][0, -1, :].detach().float().cpu().numpy()
        return pre
    caps = [model.model.layers[i].mlp.down_proj.register_forward_pre_hook(mk(i)) for i in range(L)]
    X, y = [], []
    for (prefix, true_txt, false_txt) in pairs:
        for label, text in ((1, true_txt), (0, false_txt)):
            ids = tok(text, return_tensors="pt").input_ids.to(model.device)
            neur.clear()
            with torch.no_grad():
                model(input_ids=ids)
            X.append(np.concatenate([neur[i] for i in range(L)])); y.append(label)
    for h in caps:
        h.remove()
    X = np.stack(X); y = np.array(y)
    feat_mean = X.mean(axis=0)                       # per-neuron dataset mean (for mean-substitution)

    probe = Pipeline([("sc", StandardScaler()),
                      ("sel", SelectKBest(f_classif, k=min(4000, X.shape[1]))),
                      ("lr", LogisticRegression(penalty="l1", solver="liblinear", C=0.15,
                                                max_iter=4000, class_weight="balanced"))])
    probe.fit(X, y)
    sel = probe.named_steps["sel"].get_support(indices=True)
    coef = probe.named_steps["lr"].coef_[0]
    ranked = sel[np.argsort(-np.abs(coef))]          # honesty neurons, most predictive first
    rng = np.random.RandomState(0)

    subst = {"map": None}

    def mk_abl(idx):
        def pre(_m, args):
            m = subst["map"]
            if m and idx in m:
                x = args[0].clone()
                units, vals = m[idx]
                x[..., units] = torch.tensor(vals, dtype=x.dtype, device=x.device)
                return (x,) + tuple(args[1:])
            return None
        return pre
    abls = [model.model.layers[i].mlp.down_proj.register_forward_pre_hook(mk_abl(i)) for i in range(L)]

    def build_map(global_idx):
        m = {}
        for gi in global_idx:
            lyr, unit = int(gi // inter), int(gi % inter)
            m.setdefault(lyr, [[], []])
            m[lyr][0].append(unit); m[lyr][1].append(float(feat_mean[gi]))
        return {k: (np.array(v[0]), np.array(v[1])) for k, v in m.items()}

    def acc_margin(layer_map):
        subst["map"] = layer_map
        ms = []
        for (prefix, true_txt, false_txt) in pairs:
            def flp(text):
                p = tok(prefix, return_tensors="pt").input_ids
                ids = tok(text, return_tensors="pt").input_ids.to(model.device)
                a0 = p.shape[1]
                with torch.no_grad():
                    lg = model(input_ids=ids).logits[0].float()
                v = [float(torch.log_softmax(lg[j - 1], dim=-1)[ids[0, j]]) for j in range(a0, ids.shape[1])]
                return float(np.mean(v)) if v else 0.0
            ms.append(flp(true_txt) - flp(false_txt))
        subst["map"] = None
        m = np.array(ms)
        return round(float((m > 0).mean()), 4), round(float(m.mean()), 4)

    base_acc, base_margin = acc_margin(None)
    print(f"[sweep] baseline acc {base_acc} margin {base_margin}", flush=True)
    sweep = []
    for K in KS:
        hon = build_map(ranked[:K])
        rnd = build_map(rng.choice(X.shape[1], size=K, replace=False))
        ha, hm = acc_margin(hon)
        ra, rm = acc_margin(rnd)
        row = {"K": K, "honesty_acc": ha, "random_acc": ra,
               "honesty_margin": hm, "random_margin": rm,
               "honesty_acc_drop": round(base_acc - ha, 4), "random_acc_drop": round(base_acc - ra, 4),
               "honesty_minus_random_acc_drop": round((base_acc - ha) - (base_acc - ra), 4)}
        sweep.append(row)
        print(f"[sweep] K={K}: honesty acc {ha} (drop {row['honesty_acc_drop']}) | "
              f"random acc {ra} (drop {row['random_acc_drop']}) | net {row['honesty_minus_random_acc_drop']}", flush=True)
    for h in abls:
        h.remove()

    max_net = max(r["honesty_minus_random_acc_drop"] for r in sweep)
    causal = max_net > 0.08
    report = {
        "task": "H-Neurons causal ablation K-sweep with mean-substitution (#2209)",
        "model": MID, "n_pairs": len(pairs), "ablation": "mean-substitution",
        "baseline_acc": base_acc, "baseline_margin": base_margin,
        "sweep": sweep,
        "max_honesty_minus_random_acc_drop": max_net,
        "causal_support": bool(causal),
        "verdict": ("CAUSAL emerges at scale: honesty-neuron ablation collapses the true>false "
                    "preference distinctly more than random at some K" if causal else
                    "NOT causal even up to K=1000 with mean-substitution: honesty-neuron ablation never "
                    "degrades the output preference distinctly beyond a random control. The H-Neurons "
                    "are a strong DETECTOR (0.97 AUROC) but not a causal over-compliance lever here — "
                    "predictive != causal on Ouro's output margin. Robust null."),
        "evidence_class": "MEASURED (data/sigma0/hneurons_causal_sweep_report.json)",
        "caveats": (f"fp16 {MID}, mean-substitution ablation across all layers/UT, 80 matched facts; the "
                    "output margin is a weak target (baseline acc ~0.68 — the model barely knows many "
                    "facts parametrically). A compliance/instruction-following behavior may show causality "
                    "the factual margin doesn't."),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\n[sweep] max net honesty-vs-random acc drop = {max_net}  -> {'CAUSAL' if causal else 'NOT causal (robust null)'}")
    print(f"Report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
