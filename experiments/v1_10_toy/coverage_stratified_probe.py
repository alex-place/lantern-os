#!/usr/bin/env python3
"""Coverage-stratified probe test (P1 rung A) — mechanism, not correlation.

The two-family ladder showed truth-probe detectability rising with scale/training
tokens (Qwen assoc 0.703->0.774->0.924; Phi assoc 0.571->0.792). That is a
CROSS-model correlation. This experiment tests the MECHANISM within single models:

    If detectability is gated by parametric knowledge COVERAGE, then inside one
    model the probe should separate truth from falsehood on claims the model
    KNOWS, and sit near chance on claims it does not - and the known/unknown map
    should be MODEL-SPECIFIC (cross-model double dissociation), killing the
    "some rows are just easier" confound.

Per row: elicit the model's own zero-shot truth judgment (logprob gap between
" true" and " false" continuations) -> known = judged correctly. Probe hidden
states with the ladder's exact methodology (5-fold CV, out-of-fold scores), then
compute AUROC within strata FROM OUT-OF-FOLD SCORES ONLY (no refit per stratum).

PRE-REGISTERED GATES (2026-07-24, before first run):
  G-A1 (within-model): assoc-family AUROC(known) - AUROC(unknown) >= +0.10,
        out-of-fold, in BOTH models.
  G-A2 (dissociation): for rows known by exactly one model, each model's AUROC
        on ITS OWN known-only rows exceeds its AUROC on the OTHER model's
        known-only rows, in both models.
  KILL: gap < 0.05 in both models -> coverage mechanism REFUTED; P1 reverts to
        correlation-grade ("scale-emergent, mechanism open") and says so.
  Bonus (report, no gate): AUROC among rows the model judges WRONG zero-shot -
        if > 0.5, hidden states carry signal beyond elicited behavior (Kadavath-
        style "knows more than it says") - relevant to D1's audit story.

One model per invocation (crash-prone 8GB box - ladder discipline):
  .venv-train python experiments/v1_10_toy/coverage_stratified_probe.py --model Qwen/Qwen2.5-1.5B-Instruct
  .venv-train python experiments/v1_10_toy/coverage_stratified_probe.py --model microsoft/phi-2
Then combine:
  .venv-train python experiments/v1_10_toy/coverage_stratified_probe.py --combine
"""
import argparse
import json
import os

if os.name == "nt":
    os.environ.setdefault("HF_HOME", "D:/hf-cache")

OUTDIR = os.path.join("experiments", "results")
TAG = "v1_10_coverage_stratified"
DATA = "data/eval/v1_10/probe-sets-v1.jsonl"
DEPTHS = (0.5, 0.6)  # ladder's best band; best-of-two per family, same as ladder reads


def load_rows(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def oof_scores(X, y, seed=42):
    """Out-of-fold decision scores, ladder probe methodology (5-fold, scaled logreg)."""
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import StratifiedKFold
    from sklearn.preprocessing import StandardScaler
    out = np.zeros(len(y), dtype=float)
    for tr, te in StratifiedKFold(5, shuffle=True, random_state=seed).split(X, y):
        sc = StandardScaler().fit(X[tr])
        clf = LogisticRegression(max_iter=2000, C=0.5).fit(sc.transform(X[tr]), y[tr])
        out[te] = clf.predict_proba(sc.transform(X[te]))[:, 1]
    return out


def auroc_safe(y, s):
    import numpy as np
    from sklearn.metrics import roc_auc_score
    y = np.asarray(y)
    if len(y) < 8 or len(set(y.tolist())) < 2:
        return None  # too thin to score honestly
    return float(roc_auc_score(y, s))


def run_model(model_id, batch):
    import numpy as np
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from probe_ladder import collect_states  # same-dir import: identical methodology

    device = "cuda" if torch.cuda.is_available() else "cpu"
    tok = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    tok.padding_side = "right"
    model = AutoModelForCausalLM.from_pretrained(
        model_id, trust_remote_code=True,
        torch_dtype=torch.float16 if device == "cuda" else torch.float32).to(device)
    model.train(False)
    if getattr(model.config, "pad_token_id", None) is None:
        model.config.pad_token_id = tok.pad_token_id

    rows = load_rows(DATA)
    texts = [r["text"] for r in rows]
    labels = np.array([int(r["label"]) for r in rows])
    fams = np.array([r["family"] for r in rows])

    # ---- knowledge elicitation: logprob(" true") vs logprob(" false") next-token
    id_t = tok.encode(" true", add_special_tokens=False)
    id_f = tok.encode(" false", add_special_tokens=False)
    first_token_only = len(id_t) > 1 or len(id_f) > 1
    it, jf = id_t[0], id_f[0]
    prompts = [f"Question: Is the following statement true or false?\nStatement: {t}\nAnswer: The statement is"
               for t in texts]
    gaps = []
    with torch.no_grad():
        for i in range(0, len(prompts), batch):
            enc = tok(prompts[i:i + batch], return_tensors="pt", padding=True,
                      truncation=True, max_length=96).to(device)
            logits = model(**enc).logits
            last = enc["attention_mask"].sum(1) - 1
            idx = torch.arange(logits.shape[0], device=device)
            lg = torch.log_softmax(logits[idx, last].float(), dim=-1)
            gaps.extend((lg[:, it] - lg[:, jf]).cpu().tolist())
    gaps = np.array(gaps)
    judged_true = gaps > 0
    known = judged_true == (labels == 1)  # zero-shot judgment correct

    # ---- hidden states at the ladder band; out-of-fold probe scores per family
    with torch.no_grad():
        enc = tok(texts[:2], return_tensors="pt", padding=True).to(device)
        n_hs = len(model(**enc, output_hidden_states=True).hidden_states)
    layers = sorted({max(1, int(n_hs * d)) for d in DEPTHS})
    _, last_hs = collect_states(texts, model, tok, layers, device, batch)

    res = {"model": model_id, "n": len(rows), "layers": layers,
           "first_token_only": first_token_only,
           "knowledge_rate": round(float(known.mean()), 3),
           "per_row": [], "families": {}}
    for fam in ("factual", "assoc", "arith"):
        m = fams == fam
        y = labels[m]
        best = None
        for L in layers:
            s = oof_scores(last_hs[L][m], y)
            a = auroc_safe(y, s)
            if best is None or (a or 0) > (best[1] or 0):
                best = (L, a, s)
        L, overall, s = best
        km = known[m]
        fam_out = {
            "layer": int(L), "overall_oof_auroc": overall,
            "n_known": int(km.sum()), "n_unknown": int((~km).sum()),
            "auroc_known": auroc_safe(y[km], s[km]),
            "auroc_unknown": auroc_safe(y[~km], s[~km]),
        }
        res["families"][fam] = fam_out
        print(f"{model_id} {fam:8s} L{L} overall {overall and round(overall,3)} | "
              f"known n={fam_out['n_known']} AUROC {fam_out['auroc_known'] and round(fam_out['auroc_known'],3)} | "
              f"unknown n={fam_out['n_unknown']} AUROC {fam_out['auroc_unknown'] and round(fam_out['auroc_unknown'],3)}",
              flush=True)
    # per-row record for the cross-model dissociation (combine step)
    fam_layer = {f: res["families"][f]["layer"] for f in res["families"]}
    scores_by_fam = {}
    for fam in fam_layer:
        m = fams == fam
        scores_by_fam[fam] = oof_scores(last_hs[fam_layer[fam]][m], labels[m])
    cursor = {f: 0 for f in fam_layer}
    for i, r in enumerate(rows):
        f = r["family"]
        res["per_row"].append({"i": i, "family": f, "label": int(labels[i]),
                               "known": bool(known[i]), "gap": round(float(gaps[i]), 4),
                               "oof": round(float(scores_by_fam[f][cursor[f]]), 6)})
        cursor[f] += 1
    safe = model_id.replace("/", "--")
    os.makedirs(OUTDIR, exist_ok=True)
    with open(os.path.join(OUTDIR, f"{TAG}.{safe}.json"), "w", encoding="utf-8") as fh:
        json.dump(res, fh, indent=1)
    print(f"wrote {OUTDIR}/{TAG}.{safe}.json")


def combine():
    import numpy as np
    files = [f for f in os.listdir(OUTDIR) if f.startswith(TAG + ".") and f.endswith(".json")
             and not f.endswith(".combined.json")]
    packs = []
    for f in sorted(files):
        with open(os.path.join(OUTDIR, f), encoding="utf-8") as fh:
            packs.append(json.load(fh))
    if len(packs) != 2:
        print(f"need exactly 2 model packs, found {len(packs)}: {files}")
        return 1
    A, B = packs
    out = {"models": [A["model"], B["model"]], "gates": {}, "families": {}}
    # G-A1: known-vs-unknown gap on assoc, both models
    gaps = {}
    for P in (A, B):
        fam = P["families"]["assoc"]
        k, u = fam["auroc_known"], fam["auroc_unknown"]
        gaps[P["model"]] = (None if (k is None or u is None) else round(k - u, 3))
    out["gates"]["G_A1_assoc_known_minus_unknown"] = gaps
    valid = [g for g in gaps.values() if g is not None]
    out["gates"]["G_A1_PASS"] = bool(valid and all(g >= 0.10 for g in valid))
    out["gates"]["KILL_fired"] = bool(valid and all(g < 0.05 for g in valid))
    # G-A2: double dissociation on rows known by exactly one model (per family pool)
    kA = {r["i"]: r["known"] for r in A["per_row"]}
    kB = {r["i"]: r["known"] for r in B["per_row"]}
    onlyA = {i for i in kA if kA[i] and not kB[i]}
    onlyB = {i for i in kA if kB[i] and not kA[i]}
    diss = {}
    for P, own, other in ((A, onlyA, onlyB), (B, onlyB, onlyA)):
        rows = {r["i"]: r for r in P["per_row"] if r["family"] in ("factual", "assoc")}
        yo = [rows[i]["label"] for i in own if i in rows]
        so = [rows[i]["oof"] for i in own if i in rows]
        yx = [rows[i]["label"] for i in other if i in rows]
        sx = [rows[i]["oof"] for i in other if i in rows]
        diss[P["model"]] = {
            "auroc_on_rows_only_IT_knows": auroc_safe(yo, so), "n_own": len(yo),
            "auroc_on_rows_only_OTHER_knows": auroc_safe(yx, sx), "n_other": len(yx)}
    out["gates"]["G_A2_dissociation"] = diss
    ok = []
    for m, d in diss.items():
        a, b = d["auroc_on_rows_only_IT_knows"], d["auroc_on_rows_only_OTHER_knows"]
        ok.append(a is not None and b is not None and a > b)
    out["gates"]["G_A2_PASS"] = bool(ok and all(ok))
    # bonus: signal beyond behavior (unknown-stratum AUROC > 0.5?), per model per family
    for P in (A, B):
        out["families"][P["model"]] = P["families"]
    with open(os.path.join(OUTDIR, f"{TAG}.combined.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1)
    print(json.dumps(out["gates"], indent=1))
    print(f"wrote {OUTDIR}/{TAG}.combined.json")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model")
    ap.add_argument("--combine", action="store_true")
    ap.add_argument("--batch", type=int, default=8)
    a = ap.parse_args()
    if a.combine:
        raise SystemExit(combine())
    if not a.model:
        raise SystemExit("need --model or --combine")
    run_model(a.model, a.batch)


if __name__ == "__main__":
    main()
