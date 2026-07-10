r"""
sigma0_hneurons_causal.py — CAUSAL test of the H-Neurons honesty neurons (#2209 follow-up).

The #2209 probe found ~30 FFN neurons (0.02%) that PREDICT truth/hallucination at AUROC 0.97. The
paper's headline is that these neurons are CAUSALLY tied to over-compliance. This tests that on Ouro:
ablate the honesty neurons (zero their activation) and measure whether the model loses its ability to
prefer a true completion over a false one — vs a RANDOM-neuron control (same count).

Method:
  1. Fit the sparse probe (SelectKBest -> L1) on ALL matched facts; take the top-K neurons by |L1 coef|
     as the honesty set (global index -> (layer, unit)).
  2. For each matched pair, measure margin = logprob(true fill) - logprob(false fill) under:
       - baseline (no ablation)
       - honesty-ablated (zero the K honesty neurons in mlp.down_proj input, every layer/step)
       - random-ablated (zero K random neurons — the control)
  3. Report mean margin + accuracy (margin > 0) per condition. Causal support iff honesty-ablation
     collapses the margin/accuracy MORE than the random control.

Run:  .venv-train/Scripts/python.exe experiments/sigma0_hneurons_causal.py
Env:  OURO_MODEL, HN_K (honesty neurons to ablate, default 50)
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
K = int(os.environ.get("HN_K", "50"))
OUT = REPO / "data" / "sigma0" / "hneurons_causal_report.json"


def main():
    print(f"[causal] loading {MID} ...", flush=True)
    tok = AutoTokenizer.from_pretrained(MID, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        MID, trust_remote_code=True, torch_dtype=torch.float16, device_map="auto")
    model.eval()
    patch_universal_transformer_cache()
    L = model.config.num_hidden_layers
    inter = model.config.intermediate_size

    pairs = []  # (prefix, true, false, domain)
    for dom, facts in FACTS.items():
        for (tpl, t, f) in facts:
            pairs.append((tpl.split("{}")[0], tpl.format(t), tpl.format(f), dom, tpl))

    # ---- pass 1: capture neuron acts to fit the probe (find honesty neurons) ----
    neur = {}

    def mk(idx):
        def pre(_m, args):
            neur[idx] = args[0][0, -1, :].detach().float().cpu().numpy()
        return pre
    caps = [model.model.layers[i].mlp.down_proj.register_forward_pre_hook(mk(i)) for i in range(L)]

    X, y = [], []
    for (prefix, true_txt, false_txt, dom, tpl) in pairs:
        for label, text in ((1, true_txt), (0, false_txt)):
            ids = tok(text, return_tensors="pt").input_ids.to(model.device)
            neur.clear()
            with torch.no_grad():
                model(input_ids=ids)
            X.append(np.concatenate([neur[i] for i in range(L)])); y.append(label)
    for h in caps:
        h.remove()
    X = np.stack(X); y = np.array(y)

    probe = Pipeline([("sc", StandardScaler()),
                      ("sel", SelectKBest(f_classif, k=min(2000, X.shape[1]))),
                      ("lr", LogisticRegression(penalty="l1", solver="liblinear", C=0.1,
                                                max_iter=3000, class_weight="balanced"))])
    probe.fit(X, y)
    sel_idx = probe.named_steps["sel"].get_support(indices=True)          # 2000 preselected
    coef = probe.named_steps["lr"].coef_[0]
    order = np.argsort(-np.abs(coef))
    honesty_global = sel_idx[order[:K]]                                   # top-K global neuron indices
    honesty_by_layer = {}
    for gi in honesty_global:
        lyr, unit = int(gi // inter), int(gi % inter)
        honesty_by_layer.setdefault(lyr, []).append(unit)
    rng = np.random.RandomState(0)
    rand_global = rng.choice(X.shape[1], size=K, replace=False)
    random_by_layer = {}
    for gi in rand_global:
        lyr, unit = int(gi // inter), int(gi % inter)
        random_by_layer.setdefault(lyr, []).append(unit)
    print(f"[causal] honesty neurons span {len(honesty_by_layer)} layers; K={K}", flush=True)

    # ---- ablation hooks: zero selected units in each layer's down_proj INPUT ----
    ablate = {"map": None}

    def mk_abl(idx):
        def pre(_m, args):
            m = ablate["map"]
            if m and idx in m:
                x = args[0].clone()
                x[..., m[idx]] = 0.0
                return (x,) + tuple(args[1:])
            return None
        return pre
    abls = [model.model.layers[i].mlp.down_proj.register_forward_pre_hook(mk_abl(i)) for i in range(L)]

    def margin(prefix, true_fill_txt, false_fill_txt, prefix_txt):
        def fill_lp(text):
            p_ids = tok(prefix_txt, return_tensors="pt").input_ids
            ids = tok(text, return_tensors="pt").input_ids.to(model.device)
            a0 = p_ids.shape[1]
            with torch.no_grad():
                logits = model(input_ids=ids).logits[0].float()
            lp = [float(torch.log_softmax(logits[j - 1], dim=-1)[ids[0, j]]) for j in range(a0, ids.shape[1])]
            return float(np.mean(lp)) if lp else 0.0
        return fill_lp(true_fill_txt) - fill_lp(false_fill_txt)

    def run_condition(layer_map):
        ablate["map"] = layer_map
        margins = [margin(pf, tt, ft, pf) for (pf, tt, ft, dom, tpl) in pairs]
        ablate["map"] = None
        m = np.array(margins)
        return round(float(m.mean()), 4), round(float((m > 0).mean()), 4)

    base_margin, base_acc = run_condition(None)
    hon_margin, hon_acc = run_condition(honesty_by_layer)
    rnd_margin, rnd_acc = run_condition(random_by_layer)
    for h in abls:
        h.remove()

    causal = (base_acc - hon_acc) > 2 * max(0.0, base_acc - rnd_acc) + 0.05 or (base_margin - hon_margin) > 2 * max(0.0, base_margin - rnd_margin) + 0.1
    report = {
        "task": "causal test of H-Neurons honesty neurons via ablation (#2209 follow-up)",
        "model": MID, "n_pairs": len(pairs), "K_ablated": K,
        "honesty_neuron_layers": sorted(honesty_by_layer),
        "true_minus_false_logprob_margin": {
            "baseline": base_margin, "honesty_ablated": hon_margin, "random_ablated": rnd_margin},
        "accuracy_prefers_true": {
            "baseline": base_acc, "honesty_ablated": hon_acc, "random_ablated": rnd_acc},
        "honesty_ablation_drop_acc": round(base_acc - hon_acc, 4),
        "random_ablation_drop_acc": round(base_acc - rnd_acc, 4),
        "honesty_ablation_drop_margin": round(base_margin - hon_margin, 4),
        "random_ablation_drop_margin": round(base_margin - rnd_margin, 4),
        "causal_support": bool(causal),
        "verdict": ("CAUSAL: ablating the honesty neurons collapses the true>false preference much more "
                    "than a random-neuron control — they causally carry the honesty signal, not just "
                    "correlate" if causal else
                    "NOT clearly causal on this test: honesty-neuron ablation does not degrade the "
                    "true>false preference distinctly more than random ablation (predictive != causal "
                    "here, or the effect is distributed / masked by the residual stream)"),
        "evidence_class": "MEASURED (data/sigma0/hneurons_causal_report.json)",
        "caveats": (f"fp16, {MID}, K={K} neurons zeroed in down_proj input across all layers/UT steps, "
                    "80 matched facts; margin = mean fill logprob(true)-logprob(false). Ablation is "
                    "activation-zeroing (not mean-substitution); random control shares the count. Small n."),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("\n[causal] ===== RESULT =====")
    print(f"  accuracy(prefers true): baseline {base_acc} | honesty-ablated {hon_acc} | random-ablated {rnd_acc}")
    print(f"  margin(true-false lp):  baseline {base_margin} | honesty {hon_margin} | random {rnd_margin}")
    print(f"  drop(acc): honesty {report['honesty_ablation_drop_acc']} vs random {report['random_ablation_drop_acc']}")
    print(f"  VERDICT: {report['verdict'][:100]}")
    print(f"Report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
