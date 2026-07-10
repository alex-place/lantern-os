r"""
sigma0_hneurons_probe.py — the H-Neurons hallucination probe on OUR models (#2209, arXiv:2512.01797).

H-Neurons claims <0.1% of FFN neurons predict hallucination, generalize OOD, and are causally tied to
over-compliance (our Σ₀ collapse canary). Their numbers are on Mistral/Gemma/Llama — untested on
Ouro. This builds the probe on Ouro-1.4B and asks: does a SPARSE probe over FFN neuron activations
detect truth/hallucination, does it transfer across domains, and does it beat the free-logprob gate
(~0.77) and match/exceed the #2030 residual-hidden-state probe?

Neuron activation = the input to each layer's `down_proj`, i.e. `act_fn(gate_proj(x)) * up_proj(x)`
(dim intermediate_size=5632 per layer). We capture it at the LAST token on the LAST UT step, across
all 24 layers -> a 135k-dim neuron vector per example. Probe: StandardScaler -> SelectKBest (the
sparse-neuron selection) -> L1-LogisticRegression. Grouped CV by fact; leave-one-domain-out for OOD.

Data: the matched true(faithful)/false(hallucinated) minimal pairs from sigma0_probe_transfer.FACTS
(length-matched, 5 domains) — the same clean set the #2030 residual probe used, so the two are
directly comparable.

Run:  .venv-train/Scripts/python.exe experiments/sigma0_hneurons_probe.py
Env:  OURO_MODEL, HN_TOPK (SelectKBest k, default 2000)
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
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.model_selection import GroupKFold  # noqa: E402
from sklearn.pipeline import Pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

MID = os.environ.get("OURO_MODEL", "ByteDance/Ouro-1.4B-Thinking")
TOPK = int(os.environ.get("HN_TOPK", "2000"))
OUT = REPO / "data" / "sigma0" / "hneurons_probe_report.json"


def main():
    print(f"[hneurons] loading {MID} (cuda={torch.cuda.is_available()}) ...", flush=True)
    tok = AutoTokenizer.from_pretrained(MID, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        MID, trust_remote_code=True, torch_dtype=torch.float16, device_map="auto")
    model.eval()
    patch_universal_transformer_cache()
    L = model.config.num_hidden_layers
    inter = model.config.intermediate_size

    # capture the input to each layer's mlp.down_proj (= the gated neuron activations), last token.
    # down_proj is called once per (layer, UT step); we keep the LAST call (last UT step).
    neur = {}

    def mk(idx):
        def pre_hook(_m, args):
            x = args[0]
            neur[idx] = x[0, -1, :].detach().float().cpu().numpy()  # [intermediate]
        return pre_hook

    handles = [model.model.layers[i].mlp.down_proj.register_forward_pre_hook(mk(i)) for i in range(L)]

    rows = []  # dict(vec, label, domain, fid, logprob)
    fid = 0
    for dom, facts in FACTS.items():
        for (tpl, t, f) in facts:
            prefix = tpl.split("{}")[0]
            for label, fill in ((1, t), (0, f)):
                text = tpl.format(fill)
                p_ids = tok(prefix, return_tensors="pt").input_ids
                ids = tok(text, return_tensors="pt").input_ids.to(model.device)
                a0 = p_ids.shape[1]
                neur.clear()
                with torch.no_grad():
                    out = model(input_ids=ids)
                vec = np.concatenate([neur[i] for i in range(L)])  # [L*inter]
                logits = out.logits[0].float()
                lp = [float(torch.log_softmax(logits[j - 1], dim=-1)[ids[0, j]])
                      for j in range(a0, ids.shape[1])]
                rows.append({"vec": vec, "label": label, "domain": dom, "fid": fid,
                             "logprob": float(np.mean(lp)) if lp else 0.0})
            fid += 1
        print(f"[hneurons] captured domain {dom} (dim={rows[-1]['vec'].shape[0]})", flush=True)
    for h in handles:
        h.remove()

    X = np.stack([r["vec"] for r in rows]); y = np.array([r["label"] for r in rows])
    g = np.array([r["fid"] for r in rows]); dom = np.array([r["domain"] for r in rows])
    lp = np.array([r["logprob"] for r in rows])

    def auc(yy, s):
        a = roc_auc_score(yy, s); return float(max(a, 1 - a))

    def make_probe(ntrain):
        return Pipeline([("sc", StandardScaler()),
                         ("sel", SelectKBest(f_classif, k=min(TOPK, X.shape[1]))),
                         ("lr", LogisticRegression(penalty="l1", solver="liblinear", C=0.1,
                                                   max_iter=3000, class_weight="balanced"))])

    # grouped CV AUROC (detection)
    oof = np.zeros(len(y)); nsel = []
    for tr, te in GroupKFold(5).split(X, y, g):
        p = make_probe(len(tr)); p.fit(X[tr], y[tr]); oof[te] = p.predict_proba(X[te])[:, 1]
        lr = p.named_steps["lr"]; nsel.append(int((np.abs(lr.coef_) > 1e-8).sum()))
    detect_auc = round(auc(y, oof), 4)
    mean_nonzero = int(np.mean(nsel))
    frac_neurons = round(mean_nonzero / X.shape[1] * 100, 4)

    # leave-one-domain-out OOD transfer
    domains = list(FACTS)
    lodo = {}
    for held in domains:
        tr = dom != held; te = dom == held
        p = make_probe(int(tr.sum())); p.fit(X[tr], y[tr])
        lodo[held] = round(auc(y[te], p.predict_proba(X[te])[:, 1]), 4)
    lodo["MEAN"] = round(float(np.mean([v for v in lodo.values()])), 4)

    logprob_auc = round(auc(y, lp), 4)

    report = {
        "task": "H-Neurons sparse FFN-neuron hallucination probe on Ouro-1.4B (#2209)",
        "model": MID, "n_facts": fid, "n_examples": int(len(y)),
        "neuron_dim_total": int(X.shape[1]), "layers": L, "intermediate_per_layer": inter,
        "select_k": TOPK,
        "detection_auroc_grouped_cv": detect_auc,
        "mean_nonzero_neurons_in_probe": mean_nonzero,
        "pct_neurons_used": frac_neurons,
        "ood_transfer_LODO": lodo,
        "logprob_baseline_auroc": logprob_auc,
        "reference_residual_probe_2030": "0.928 full / 0.885 model-uncertain tercile / 0.931 LODO (sigma0_probe_transfer)",
        "verdict_note": "",
        "evidence_class": "MEASURED (data/sigma0/hneurons_probe_report.json)",
        "caveats": ("fp16, Ouro-1.4B-Thinking, matched self-authored true/false facts, last-token "
                    "last-UT-step neuron acts across all 24 layers, SelectKBest+L1 (a sparse but not "
                    "single-neuron probe), n small so LODO carries variance. Compares to logprob and "
                    "to the #2030 residual-state probe on the SAME facts."),
    }
    go = detect_auc >= 0.85 and lodo["MEAN"] >= 0.75
    report["verdict_note"] = (
        f"GO-candidate: sparse neuron probe detects at {detect_auc} (LODO {lodo['MEAN']}) using "
        f"~{frac_neurons}% of neurons, vs logprob {logprob_auc}. " if go else
        f"NO-GO / weak: neuron probe {detect_auc} (LODO {lodo['MEAN']}) does not clear the bar vs "
        f"logprob {logprob_auc} and the #2030 residual probe (0.93). ")
    report["verdict_note"] += ("On these facts the residual-state probe (#2030) is the incumbent; wire "
                               "H-Neurons into the gate only if it beats it on transfer or adds causal "
                               "over-compliance control the residual probe lacks.")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("\n[hneurons] ===== RESULT =====")
    print(f"  detection AUROC (grouped CV) = {detect_auc}  using ~{mean_nonzero} neurons ({frac_neurons}% of {X.shape[1]})")
    print(f"  OOD transfer (LODO)          = {lodo}")
    print(f"  logprob baseline AUROC       = {logprob_auc}")
    print(f"  vs #2030 residual probe: 0.928 full / 0.931 LODO")
    print(f"  VERDICT: {report['verdict_note'][:120]}")
    print(f"Report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
