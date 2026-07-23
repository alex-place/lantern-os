#!/usr/bin/env python3
"""
V0 probe LADDER (issue #2845) — does a linear probe on hidden states decode truth,
per model scale and per claim family?

Families (from build_probe_sets.py):
  factual — knowledge-recall claims (2606.02628 predicts the probe WORKS here)
  assoc   — associated misconceptions (2510.09033 predicts the probe FAILS here)
  arith   — computation claims (measured ~chance at 0.5B in the toy)

The V0 kill-gate reads the DE-GLOSSED per-family AUROC:
  factual >= 0.75 somewhere affordable  -> white-box audit stays a verifier candidate
  assoc   ~  chance everywhere          -> confirms dual-verifier necessity (expected)
  everything ~ chance at every rung     -> demote probe to telemetry, redesign sec.2

Runs ONE rung per invocation (crash-prone box: one heavy GPU job at a time, detached):

  .venv-train python experiments/v1_10_toy/probe_ladder.py --model ByteDance/Ouro-1.4B-Thinking
  .venv-train python experiments/v1_10_toy/probe_ladder.py --model Qwen/Qwen2.5-7B-Instruct --bits4

Results append to D:/lantern-train/v0-probe/ladder-results.jsonl (one JSON per rung).
"""
import argparse
import json
import os

if os.name == "nt":
    os.environ.setdefault("HF_HOME", "D:/hf-cache")

OUTDIR = "D:/lantern-train/v0-probe"


def load_rows(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def collect_states(texts, model, tok, layers, device, batch=8):
    """Per text: mean-pooled AND last-real-token hidden state at each layer."""
    import numpy as np
    import torch
    mean_out = {L: [] for L in layers}
    last_out = {L: [] for L in layers}
    for i in range(0, len(texts), batch):
        chunk = texts[i:i + batch]
        enc = tok(chunk, return_tensors="pt", padding=True, truncation=True, max_length=64).to(device)
        with torch.no_grad():
            hs = model(**enc, output_hidden_states=True).hidden_states
        am = enc["attention_mask"]
        lengths = am.sum(1) - 1  # index of last real token
        idx = torch.arange(am.shape[0], device=am.device)
        maskf = am.unsqueeze(-1)
        for L in layers:
            h = hs[L]
            mean_out[L].append(((h * maskf).sum(1) / maskf.sum(1).clamp(min=1)).float().cpu().numpy())
            last_out[L].append(h[idx, lengths].float().cpu().numpy())
    return ({L: np.concatenate(v) for L, v in mean_out.items()},
            {L: np.concatenate(v) for L, v in last_out.items()})


def probe_auroc(X, y, seed=42):
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import StratifiedKFold
    from sklearn.preprocessing import StandardScaler
    from sklearn.metrics import roc_auc_score
    # 5-fold CV (small families need every sample); mean held-out AUROC across folds
    aucs = []
    for tr, te in StratifiedKFold(5, shuffle=True, random_state=seed).split(X, y):
        sc = StandardScaler().fit(X[tr])
        clf = LogisticRegression(max_iter=2000, C=0.5).fit(sc.transform(X[tr]), y[tr])
        aucs.append(roc_auc_score(y[te], clf.predict_proba(sc.transform(X[te]))[:, 1]))
    return float(np.mean(aucs)), float(np.std(aucs))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--data", default="data/eval/v1_10/probe-sets-v1.jsonl")
    ap.add_argument("--bits4", action="store_true", help="load 4-bit NF4 (7B rung on 8GB)")
    ap.add_argument("--batch", type=int, default=8)
    a = ap.parse_args()

    import numpy as np
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"RUNG {a.model} | device {device} | 4bit={a.bits4}", flush=True)

    tok = AutoTokenizer.from_pretrained(a.model, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    tok.padding_side = "right"

    kw = dict(trust_remote_code=True)
    if a.bits4:
        from transformers import BitsAndBytesConfig
        kw["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.float16, bnb_4bit_use_double_quant=True)
        kw["device_map"] = "auto"
    else:
        kw["torch_dtype"] = torch.float16 if device == "cuda" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(a.model, **kw)
    if not a.bits4:
        model = model.to(device)
    model.train(False)
    if getattr(model.config, "pad_token_id", None) is None:
        model.config.pad_token_id = tok.pad_token_id

    rows = load_rows(a.data)
    texts = [r["text"] for r in rows]
    labels = np.array([r["label"] for r in rows])
    fams = np.array([r["family"] for r in rows])

    # Probe a dense band: 25%..95% of depth (2606.02628's peak band is mid-to-late).
    probe_n = None
    with torch.no_grad():
        enc = tok(texts[:2], return_tensors="pt", padding=True).to(model.device)
        probe_n = len(model(**enc, output_hidden_states=True).hidden_states)
    layers = sorted({int(probe_n * f) for f in (0.25, 0.4, 0.5, 0.6, 0.7, 0.8, 0.95)} - {0})
    print(f"hidden_states tuple length {probe_n}; probing layers {layers}", flush=True)

    mean_hs, last_hs = collect_states(texts, model, tok, layers, model.device, a.batch)

    result = {"model": a.model, "bits4": a.bits4, "n": len(rows), "layers": layers, "families": {}}
    print(f"\n{'family':8s} {'pool':5s} " + " ".join(f"L{L:<4d}" for L in layers))
    for fam in ("factual", "assoc", "arith"):
        m = fams == fam
        y = labels[m]
        result["families"][fam] = {}
        for pool, store in (("mean", mean_hs), ("last", last_hs)):
            line = []
            for L in layers:
                auc, sd = probe_auroc(store[L][m], y)
                result["families"][fam][f"{pool}-L{L}"] = round(auc, 3)
                line.append(f"{auc:.3f}")
            print(f"{fam:8s} {pool:5s} " + " ".join(f"{v:<5s}" for v in line), flush=True)
        best = max(v for k, v in result["families"][fam].items())
        result["families"][fam]["best"] = best
        print(f"{fam:8s} BEST  {best:.3f}")

    os.makedirs(OUTDIR, exist_ok=True)
    with open(os.path.join(OUTDIR, "ladder-results.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(result) + "\n")
    print(f"\nappended -> {OUTDIR}/ladder-results.jsonl")
    fb = result["families"]
    print(f"KILL-GATE READ: factual best {fb['factual']['best']:.3f} "
          f"(gate >=0.75) | assoc best {fb['assoc']['best']:.3f} | arith best {fb['arith']['best']:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
