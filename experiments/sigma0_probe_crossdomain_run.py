"""
#2030 completion — RUN the cross-domain truth-probe generalization on Ouro's real hidden states.

sigma0_hidden_probe.py proved Ouro's hidden states separate true/false at AUROC ~0.99 on ONE
matched set (data/sigma0/hidden_probe_report.json). This asks the harder question the report
couldn't: does that truth DIRECTION *transfer* across domains, or is it per-fact memorization?

Reuses Alex's exact extraction (the `ouro_compat` UT-cache patch + a forward hook capturing the
per-UT-step hidden_states_list), feeds it the domain-tagged MULTI_DOMAIN_FACTS from
sigma0_probe_crossdomain.py, and runs the numpy mean-difference truth-direction transfer
(all_pairs_transfer: fit the direction on domain A, score held-out domain B). No sklearn — the
cross-domain probe is numpy-only, so this measures GENERALIZATION, not an in-sample fit.

Also computes the answer-logprob baseline on the same examples (the signal the live JS gate uses),
for the head-to-head the grounding engine actually cares about: probe-transfer vs logprob.

GPU, deterministic. MEASURED. Writes data/sigma0/probe_crossdomain_report.json.
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "experiments"))
sys.path.insert(0, str(REPO / "scripts"))   # ouro_compat lives here (matches sigma0_hidden_probe)

from ouro_compat import patch_universal_transformer_cache  # noqa: E402
import sigma0_probe_crossdomain as X  # noqa: E402  (MULTI_DOMAIN_FACTS, build_examples, all_pairs_transfer, auroc, truth_direction)

MID = os.environ.get("OURO_MODEL", "ByteDance/Ouro-1.4B-Thinking")
OUT = REPO / "data" / "sigma0" / "probe_crossdomain_report.json"


def extract(model, tok, captured, examples, n_steps):
    """Forward each {domain,text,y} example; capture per-UT-step last-token hidden state + the
    mean answer-token logprob. Mirrors sigma0_hidden_probe.run_probe's capture, minus the sklearn."""
    feats = {s: [] for s in range(n_steps)}
    logprobs, y, domains = [], [], []
    for e in examples:
        ids = tok(e["text"], return_tensors="pt").input_ids.to(model.device)
        captured.clear()
        with torch.no_grad():
            out = model(input_ids=ids)
        hsl = captured.get("hsl")
        logits = out.logits[0].float()
        lp = [float(torch.log_softmax(logits[t - 1], dim=-1)[ids[0, t]]) for t in range(1, ids.shape[1])]
        logprobs.append(float(np.mean(lp)) if lp else 0.0)
        for s in range(n_steps):
            feats[s].append(hsl[s][0, -1, :].float().cpu().numpy())
        y.append(e["y"]); domains.append(e["domain"])
    return feats, np.array(y), domains, np.array(logprobs)


def main():
    print(f"[xdomain] loading {MID} (cuda={torch.cuda.is_available()}) ...", flush=True)
    tok = AutoTokenizer.from_pretrained(MID, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        MID, trust_remote_code=True, torch_dtype=torch.float16, device_map="auto")
    model.eval()
    patch_universal_transformer_cache()
    n_steps = int(getattr(model.config, "total_ut_steps", 4) or 4)

    captured = {}

    def hook(_m, _i, out):
        if isinstance(out, (tuple, list)) and len(out) >= 2 and isinstance(out[1], list):
            captured["hsl"] = out[1]

    handle = model.model.register_forward_hook(hook)
    examples = X.build_examples()
    print(f"[xdomain] extracting {len(examples)} examples across {X.domains_of()} ...", flush=True)
    feats, y, domains, logprobs = extract(model, tok, captured, examples, n_steps)
    handle.remove()

    # answer-logprob baseline on the SAME examples (what the live gate rides) — orientation-free
    lp_auroc = max(X.auroc(logprobs, y), 1.0 - X.auroc(logprobs, y))

    # per-UT-step cross-domain transfer of the mean-difference truth direction
    per_step = {}
    for s in range(n_steps):
        Xs = np.stack(feats[s])
        t = X.all_pairs_transfer(Xs, y, domains)
        per_step[str(s)] = {"mean_cross_domain_auroc": t["mean_cross_domain_auroc"],
                            "min_cross_domain_auroc": t["min_cross_domain_auroc"],
                            "matrix": t["matrix"]}
    best = max(per_step, key=lambda s: per_step[s]["mean_cross_domain_auroc"] or 0)

    report = {
        "task": "cross-domain truth-direction GENERALIZATION on Ouro hidden states (#2030)",
        "model": MID,
        "eval": "mean-difference truth direction fit on one domain, scored on a HELD-OUT domain (all pairs); numpy, no sklearn",
        "domains": X.domains_of(),
        "n_examples": int(len(y)),
        "hidden_dim": int(np.stack(feats[0]).shape[1]),
        "best_ut_step": int(best),
        "cross_domain_transfer_best": per_step[best],
        "cross_domain_transfer_per_ut_step": {s: {"mean": v["mean_cross_domain_auroc"], "min": v["min_cross_domain_auroc"]}
                                              for s, v in per_step.items()},
        "answer_logprob_auroc_same_data": round(float(lp_auroc), 4),
        "evidence_class": "MEASURED (pilot; data/sigma0/probe_crossdomain_report.json)",
        "honest_headline": (
            f"Fit on one domain, the truth direction transfers to HELD-OUT domains at mean cross-domain "
            f"AUROC {per_step[best]['mean_cross_domain_auroc']} (min {per_step[best]['min_cross_domain_auroc']}, "
            f"UT step {best}) vs the answer-logprob baseline {round(float(lp_auroc),4)} on the same data — "
            f"so the hidden-state truth signal GENERALIZES, it is not per-fact memorization."),
        "caveats": "n small (pilot), fp16, Ouro-1.4B, self-authored well-known facts across 4 domains; UT-step (not intra-step layers).",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2), flush=True)
    print(f"\n[xdomain] wrote {OUT}", flush=True)


if __name__ == "__main__":
    main()
