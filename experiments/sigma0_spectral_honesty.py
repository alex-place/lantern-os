r"""
sigma0_spectral_honesty.py — is the loop's spectral/stability signal a FACTUAL-honesty signal,
and does it become one only with external grounding? (#2236, the Σ₀ differentiated thesis.)

The stability side (STARS/JSRR spectral radius, PLDR criticality) is externally published. The
open lane is the project's thesis: **loop-stability alone is not factuality — it becomes a factual
signal only once external grounding is supplied.** This tests that head-on, reusing the #2029 loop
machinery and the #2030 truth-probe.

Per statement (matched true/false facts across 5 domains, from sigma0_probe_transfer.FACTS), in
TWO conditions, from ONE forward each:
  * closed-book:  "<statement>"                                  (parametric only, no evidence)
  * grounded:     "Context: <true fact>. Statement: <stmt>. Supported:"   (external grounding)

we extract, at the last token:
  SPECTRAL / STABILITY (cheap, from the recurrent hidden_states_list — the per-generation loop read):
    - rho_obs        = geomean ||Δh_{t+1}||/||Δh_t||         (loop contraction; the JSRR-analogue)
    - final_delta    = ||h_T - h_{T-1}||                     (criticality: has the loop settled?)
    - total_move     = Σ_t ||Δh_t||
  PROBE (the #2030 hidden-state truth direction) and SURPRISE (answer logprob) as comparators.

Then AUROC of each signal for TRUTH (true vs false), in each condition. Thesis prediction:
spectral AUROC ≈ chance closed-book, but rises with grounding; the hidden-state probe is the strong
signal; surprise is weak. Clean control: label-shuffle AUROC.

Run:  .venv-train/Scripts/python.exe experiments/sigma0_spectral_honesty.py
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
from sigma0_probe_transfer import FACTS  # noqa: E402  (matched true/false facts by domain)

import numpy as np  # noqa: E402
import torch  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402
from sklearn.decomposition import PCA  # noqa: E402
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
OUT = REPO / "data" / "sigma0" / "spectral_honesty_report.json"


def main():
    print(f"[spec-hon] loading {MID} (cuda={torch.cuda.is_available()}) ...", flush=True)
    tok = AutoTokenizer.from_pretrained(MID, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        MID, trust_remote_code=True, torch_dtype=torch.float16, device_map="auto")
    model.eval()
    patch_universal_transformer_cache()
    n_steps = int(getattr(model.config, "total_ut_steps", 4) or 4)

    cap = {}

    def hook(_m, _i, out):
        if isinstance(out, (tuple, list)) and len(out) >= 2 and isinstance(out[1], list):
            cap["hsl"] = out[1]
    h = model.model.register_forward_hook(hook)

    def features(text, answer_from_char):
        """One forward; return (spectral dict, per-step last-token hidden states, mean answer logprob)."""
        enc_ids = tok(text, return_tensors="pt").to(model.device)
        input_ids = enc_ids["input_ids"]
        cap.clear()
        with torch.no_grad():
            out = model(**enc_ids)
        hsl = cap["hsl"]                       # list[n_steps] of [1, seq, H]
        traj = torch.stack([hsl[s][0, -1, :].float() for s in range(n_steps)], dim=0)  # [n_steps, H]
        d = (traj[1:] - traj[:-1]).norm(dim=-1)                # [n_steps-1] step deltas at last token
        r = (d[1:] / (d[:-1] + 1e-9)) if len(d) > 1 else d[:1]
        rho_obs = float(torch.exp(torch.log(r.clamp(min=1e-6)).mean())) if len(r) else 1.0
        spectral = {
            "rho_obs": rho_obs,
            "final_delta": float(d[-1]),
            "total_move": float(d.sum()),
        }
        feats = [hsl[s][0, -1, :].float().cpu().numpy() for s in range(n_steps)]
        # answer logprob (surprise) over the answer span
        enc = tok(text, return_offsets_mapping=True)
        offs = enc["offset_mapping"]
        a0 = next((i for i, (s, e) in enumerate(offs) if s >= answer_from_char and e > s), len(offs) - 1)
        a0 = max(a0, 1)
        logits = out.logits[0].float()
        seqlen = input_ids.shape[1]
        lp = [float(torch.log_softmax(logits[t - 1], dim=-1)[input_ids[0, t]]) for t in range(a0, seqlen)]
        return spectral, feats, (float(np.mean(lp)) if lp else 0.0)

    rows = []  # dict(cond, label, domain, fid, spectral..., feats[step], logprob)
    fid = 0
    for dom, facts in FACTS.items():
        for (tpl, t, f) in facts:
            true_stmt, false_stmt = tpl.format(t), tpl.format(f)
            for label, stmt in ((1, true_stmt), (0, false_stmt)):
                # closed-book: the bare statement (answer span = whole statement)
                sp, fe, lp = features(stmt, 0)
                rows.append({"cond": "closed", "label": label, "domain": dom, "fid": fid,
                             **{f"sp_{k}": v for k, v in sp.items()}, "feats": fe, "logprob": lp})
                # grounded: true fact as context, then the statement, scored at "Supported:"
                gtext = f"Context: {true_stmt} Statement: {stmt} Supported:"
                sp2, fe2, lp2 = features(gtext, len(gtext))  # score the last token (post 'Supported:')
                rows.append({"cond": "grounded", "label": label, "domain": dom, "fid": fid,
                             **{f"sp_{k}": v for k, v in sp2.items()}, "feats": fe2, "logprob": lp2})
            fid += 1
        print(f"[spec-hon] scored domain {dom}", flush=True)
    h.remove()

    def auc(y, s):
        a = roc_auc_score(y, s)
        return float(max(a, 1 - a))

    def probe_auc(subset):
        """Out-of-fold AUROC of the best-UT-step hidden-state probe on `subset` rows."""
        y = np.array([r["label"] for r in subset]); g = np.array([r["fid"] for r in subset])
        best = 0.5
        for s in range(n_steps):
            X = np.stack([r["feats"][s] for r in subset]); oof = np.zeros(len(y))
            for tr, te in GroupKFold(5).split(X, y, g):
                p = Pipeline([("sc", StandardScaler()),
                              ("pca", PCA(n_components=min(24, max(2, len(tr) - 8)))),
                              ("lr", LogisticRegression(C=0.05, max_iter=3000, class_weight="balanced"))])
                p.fit(X[tr], y[tr]); oof[te] = p.predict_proba(X[te])[:, 1]
            best = max(best, auc(y, oof))
        return round(best, 4)

    report = {"task": "spectral/stability loop signal as a FACTUAL-honesty signal, closed-book vs grounded",
              "model": MID, "n_facts": fid, "n_examples": len(rows), "n_ut_steps": n_steps,
              "conditions": {}}
    rng = np.random.RandomState(0)
    for cond in ("closed", "grounded"):
        sub = [r for r in rows if r["cond"] == cond]
        y = np.array([r["label"] for r in sub])
        block = {
            "n": len(sub),
            "spectral_rho_obs_AUROC": round(auc(y, np.array([r["sp_rho_obs"] for r in sub])), 4),
            "spectral_final_delta_AUROC": round(auc(y, np.array([r["sp_final_delta"] for r in sub])), 4),
            "spectral_total_move_AUROC": round(auc(y, np.array([r["sp_total_move"] for r in sub])), 4),
            "surprise_logprob_AUROC": round(auc(y, np.array([r["logprob"] for r in sub])), 4),
            "hidden_probe_AUROC": probe_auc(sub),
            "shuffled_control_AUROC": round(auc(rng.permutation(y),
                                                np.array([r["sp_final_delta"] for r in sub])), 4),
        }
        report["conditions"][cond] = block
        print(f"[spec-hon] {cond:9} spectral(final_delta) {block['spectral_final_delta_AUROC']}  "
              f"rho_obs {block['spectral_rho_obs_AUROC']}  surprise {block['surprise_logprob_AUROC']}  "
              f"probe {block['hidden_probe_AUROC']}", flush=True)

    c, g = report["conditions"]["closed"], report["conditions"]["grounded"]
    spectral_gain = round(max(g["spectral_final_delta_AUROC"], g["spectral_rho_obs_AUROC"], g["spectral_total_move_AUROC"])
                          - max(c["spectral_final_delta_AUROC"], c["spectral_rho_obs_AUROC"], c["spectral_total_move_AUROC"]), 4)
    report["thesis"] = {
        "spectral_best_closed": max(c["spectral_final_delta_AUROC"], c["spectral_rho_obs_AUROC"], c["spectral_total_move_AUROC"]),
        "spectral_best_grounded": max(g["spectral_final_delta_AUROC"], g["spectral_rho_obs_AUROC"], g["spectral_total_move_AUROC"]),
        "spectral_grounding_gain": spectral_gain,
        "hidden_probe_closed": c["hidden_probe_AUROC"],
        "hidden_probe_grounded": g["hidden_probe_AUROC"],
        "verdict": ("spectral signal is a factuality signal only WITH grounding (gain > 0.1, closed ~ chance)"
                    if spectral_gain > 0.1 and c["spectral_final_delta_AUROC"] < 0.65 else
                    "spectral grounding-gain is small/absent on this model — thesis NOT supported here (honest null)"),
    }
    report["evidence_class"] = "MEASURED (data/sigma0/spectral_honesty_report.json)"
    report["caveats"] = ("fp16, Ouro-1.4B-Thinking, matched self-authored facts, cheap per-generation "
                         "spectral read (trajectory contraction, not the full autograd rho(J) of #2029 — "
                         "that is the operator's asymptotic radius; here we want a per-token stability read). "
                         "n per condition = 2*n_facts. Grounding = true-fact context; label is statement truth.")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("\n[spec-hon] ===== THESIS =====")
    print(f"  spectral best: closed {report['thesis']['spectral_best_closed']} -> grounded "
          f"{report['thesis']['spectral_best_grounded']} (gain {spectral_gain})")
    print(f"  hidden probe : closed {c['hidden_probe_AUROC']} -> grounded {g['hidden_probe_AUROC']}")
    print(f"  surprise     : closed {c['surprise_logprob_AUROC']} -> grounded {g['surprise_logprob_AUROC']}")
    print(f"  VERDICT: {report['thesis']['verdict']}")
    print(f"Report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
