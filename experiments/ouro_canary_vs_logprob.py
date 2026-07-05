"""
The novel test: does the Sigma0 hidden-state SURPRISE CANARY route grounding better than Ouro's
own logprob gate (FLARE)? Feasibility passed (Ouro HaluEval-QA baseline 68% hall, grounding -30pp),
so the A/B/C structure holds. Here, on the SAME 40 items and SAME model (Ouro-1.4B-Thinking), we
compute — from Ouro's own baseline answer, oracle-free (never the gold) — three gate signals and
ask which best picks WHICH items to ground:

  logprob            -mean answer-token logprob                        [FLARE, unsupervised]
  canary_resid       loop residual motion ||h_T - h_{T-1}|| (surprise) [Sigma0 canary, unsupervised]
  canary_rho         per-step contraction ratio (loop convergence)     [Sigma0 canary, unsupervised]
  canary_hnorm       final hidden-state norm                           [Sigma0 canary, unsupervised]
  cv_probe           GroupKFold logistic probe on final hidden state    [supervised, needs labels]

The unsupervised canary-vs-logprob is the FAIR fight (neither sees labels). The CV-probe is the
"if you'll train a probe" upper bound, reported separately and honestly. Signals extracted exactly
as experiments/sigma0_hidden_probe.py (hook on model.model -> hidden_states_list; answer-token
logprob). Greedy, deterministic. In-process GPU.
"""
import os, re, json
os.environ.setdefault("HF_HOME", "D:/hf-cache")
import numpy as np
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from sklearn.metrics import roc_auc_score
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA
from sklearn.pipeline import Pipeline
from sklearn.model_selection import GroupKFold

from pathlib import Path
_REPO = Path(__file__).resolve().parents[1]
MODEL_ID = os.environ.get("OURO_MODEL", "ByteDance/Ouro-1.4B-Thinking")
DATA = str(_REPO / "data" / "eval" / "halueval-qa-subset.jsonl")
OUT = str(_REPO / "data" / "eval" / "ouro_canary_vs_logprob_results.json")


def patch_universal_transformer_cache():
    import sys
    for name, mod in list(sys.modules.items()):
        cls = getattr(mod, "UniversalTransformerCache", None)
        if not isinstance(cls, type):
            continue
        if getattr(cls, "_lantern_cache_patched", False):
            return name
        for attr in ("key_cache", "value_cache"):
            priv = "_lantern_" + attr
            cls_prop = property((lambda p: lambda self: getattr(self, p, None))(priv),
                                (lambda p: lambda self, v: setattr(self, p, v))(priv))
            setattr(cls, attr, cls_prop)
        cls._lantern_cache_patched = True
        return name
    return None


def norm(s): return re.sub(r"[^a-z0-9 ]", "", (s or "").lower()).strip()
def contains_gold(a, g): a, g = norm(a), norm(g); return bool(g) and g in a


print(f"[canary] loading {MODEL_ID} (cuda={torch.cuda.is_available()})...", flush=True)
tok = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
model = AutoModelForCausalLM.from_pretrained(
    MODEL_ID, trust_remote_code=True, torch_dtype=torch.float16,
    device_map="auto", attn_implementation="sdpa")
model.eval()
patch_universal_transformer_cache()
n_steps = int(getattr(model.config, "total_ut_steps", 4) or 4)
captured = {}


def hook(_m, _i, out):
    if isinstance(out, (tuple, list)) and len(out) >= 2 and isinstance(out[1], list):
        captured["hsl"] = out[1]


handle = model.model.register_forward_hook(hook)


def gen(instruction, max_new=64):
    prompt = f"### Instruction:\n{instruction}\n\n### Response:\n"
    inp = tok(prompt, return_tensors="pt").to(model.device)
    captured.clear()
    with torch.no_grad():
        out = model.generate(**inp, max_new_tokens=max_new, do_sample=False,
                             pad_token_id=tok.eos_token_id)
    return prompt, tok.decode(out[0][inp["input_ids"].shape[1]:], skip_special_tokens=True).strip()


def signals(prompt, answer_text):
    """Oracle-free gate signals from Ouro's own baseline answer."""
    p_ids = tok(prompt, return_tensors="pt").input_ids
    full = tok(prompt + answer_text, return_tensors="pt").input_ids.to(model.device)
    a_start = p_ids.shape[1]
    if full.shape[1] <= a_start:
        return None
    captured.clear()
    with torch.no_grad():
        out = model(input_ids=full)
    hsl = captured.get("hsl")
    logits = out.logits[0].float()
    pos = list(range(a_start, full.shape[1]))
    lp = [float(torch.log_softmax(logits[t - 1], dim=-1)[full[0, t]]) for t in pos]
    logprob = float(np.mean(lp)) if lp else 0.0
    resid, rhos, hnorm = [], [], []
    for t in pos:
        steps = [hsl[s][0, t, :].float() for s in range(len(hsl))]
        d = [float(torch.norm(steps[s + 1] - steps[s])) for s in range(len(steps) - 1)]
        if d:
            resid.append(d[-1]); hnorm.append(float(torch.norm(steps[-1])))
            r = [d[s + 1] / d[s] for s in range(len(d) - 1) if d[s] > 1e-9]
            if r:
                rhos.append(float(np.exp(np.mean(np.log(r)))))
    feat = hsl[-1][0, full.shape[1] - 1, :].float().cpu().numpy()  # final-step, last-answer-token
    return {"logprob": logprob,
            "canary_resid": float(np.mean(resid)) if resid else 0.0,
            "canary_rho": float(np.mean(rhos)) if rhos else 1.0,
            "canary_hnorm": float(np.mean(hnorm)) if hnorm else 0.0,
            "feat": feat}


recs = [json.loads(l) for l in open(DATA, encoding="utf-8") if l.strip()]
B, Gd, rows = [], [], []
for i, r in enumerate(recs):
    q, k, gold = r["question"], r["knowledge"], r["right_answer"]
    pb, base = gen(f"Answer the question in a few words.\nQuestion: {q}")
    _, grd = gen(f"Use ONLY the provided knowledge to answer in a few words.\nKnowledge: {k}\nQuestion: {q}")
    b = int(contains_gold(base, gold)); g = int(contains_gold(grd, gold))
    sig = signals(pb, base) if base else None
    B.append(b); Gd.append(g); rows.append(sig)
    print(f"[{i+1}/{len(recs)}] b={b} g={g} "
          f"lp={sig['logprob']:.2f} resid={sig['canary_resid']:.1f} rho={sig['canary_rho']:.2f}" if sig
          else f"[{i+1}/{len(recs)}] b={b} g={g} (empty answer, no signal)", flush=True)

# keep only items with a signal
idx = [i for i, s in enumerate(rows) if s is not None]
b = np.array([B[i] for i in idx]); g = np.array([Gd[i] for i in idx])
y = 1 - b                                      # hallucination label
n = len(idx); Bc, Gc = int(b.sum()), int(g.sum())


def edge(sig):
    """orient signal to predict hallucination, then routing edge over random at equal budget."""
    a = roc_auc_score(y, sig)
    s = sig if a >= 0.5 else -sig
    order = np.argsort(-s)                      # most-surprising first
    gated = []
    for k in range(n + 1):
        fire = set(order[:k].tolist())
        gated.append(1 - sum((g[j] if j in fire else b[j]) for j in range(n)) / n)
    gated = np.array(gated)
    rnd = np.array([1 - ((k / n) * Gc + (1 - k / n) * Bc) / n for k in range(n + 1)])
    return round(max(a, 1 - a), 3), round(float(np.mean(rnd - gated)), 4)


unsup = {}
for name in ("logprob", "canary_resid", "canary_rho", "canary_hnorm"):
    s = np.array([rows[i][name] for i in idx], float)
    unsup[name] = dict(zip(("auroc", "edge"), edge(s)))

# supervised CV probe on final hidden state (GroupKFold by item -> oracle-free oof)
X = np.stack([rows[i]["feat"] for i in idx]); grp = np.array(idx)
oof = np.zeros(n)
pipe = Pipeline([("sc", StandardScaler()),
                 ("pca", PCA(n_components=min(24, max(2, n - 16)))),
                 ("lr", LogisticRegression(C=0.05, max_iter=2000, class_weight="balanced"))])
for tr, te in GroupKFold(n_splits=5).split(X, y, grp):
    pipe.fit(X[tr], y[tr]); oof[te] = pipe.predict_proba(X[te])[:, 1]
probe_auc, probe_edge = edge(oof)

rep = {"model": MODEL_ID, "benchmark": "HaluEval-QA", "n_with_signal": n,
       "baseline_hall": round(1 - Bc / n, 3), "grounded_hall": round(1 - Gc / n, 3),
       "unsupervised_gates": unsup,
       "supervised_cv_probe": {"auroc": probe_auc, "edge": probe_edge,
                               "note": "GroupKFold by item; needs labels (upper bound, not a fair unsup comparison)"},
       "logprob_baseline_auroc": unsup["logprob"]["auroc"],
       "evidence_class": "MEASURED"}
json.dump(rep, open(OUT, "w", encoding="utf-8"), indent=2)

print(f"\n=== CANARY vs LOGPROB on Ouro (n={n}, baseline_hall={1-Bc/n:.0%}, grounded_hall={1-Gc/n:.0%}) ===")
print(f"{'gate':16}{'AUROC':>8}{'edge_vs_random':>16}  (unsupervised = fair fight)")
for name in ("logprob", "canary_resid", "canary_rho", "canary_hnorm"):
    m = "  <- FLARE baseline" if name == "logprob" else ""
    print(f"{name:16}{unsup[name]['auroc']:>8.3f}{unsup[name]['edge']:>16.3f}{m}")
print(f"{'cv_probe(sup)':16}{probe_auc:>8.3f}{probe_edge:>16.3f}  <- needs labels (upper bound)")
best_c = max(("canary_resid", "canary_rho", "canary_hnorm"), key=lambda k: unsup[k]["auroc"])
d = unsup[best_c]["auroc"] - unsup["logprob"]["auroc"]
print(f"\nbest canary = {best_c} (AUROC {unsup[best_c]['auroc']:.3f}); vs logprob {unsup['logprob']['auroc']:.3f} "
      f"=> {d:+.3f} ({'within n noise' if abs(d) < 0.11 else 'exceeds n noise'})")
