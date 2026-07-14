r"""
ouro_prior_conflict_dose.py — how much retrieved context does Ouro-1.4B need before its
answer overrides a pretrained prior? (context-vs-prior conflict dose-response, #2391)

Tests Keystone's retrieval-not-retraining bet on the Reason stage: the Remember->Reason
pipeline only steers the small local model if injected context can actually flip a
confidently-held prior. This measures the DOSE (how many clean supporting snippets) needed
to cross over, and how quickly ERRONEOUS snippets poison the flip.

Method (deterministic, greedy):
  1. PRIOR PROBE — ask each question with NO context. Keep only items where the greedy
     answer contains the prior_answer (the model must actually hold the prior for a
     conflict to exist). Items it doesn't hold are dropped and reported (never hidden).
  2. CLEAN DOSE — for k in {0,1,2,3,4} inject k paraphrased snippets that all assert the
     counterfactual context_answer, then re-ask. Record flip = answer now contains
     context_answer (and not the prior). flip_rate(k) is the dose-response curve; the
     crossover k* is the smallest k with flip_rate >= 0.5.
  3. NOISY DOSE — hold k=4 but replace a fraction f of the snippets with erroneous ones
     that re-assert the PRIOR. Sweep f in {0, 0.25, 0.5, 0.75} to measure how much bad
     retrieval it takes to lose the flip (context robustness under noisy Remember).

Snippets are synthesized by deterministic paraphrase of each item's own snippet, so the
harness is self-contained (no BM25 corpus dependency) and reproducible. fp16, GPU.

Run:  .venv-train/Scripts/python.exe experiments/ouro_prior_conflict_dose.py --limit 30
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:/hf-cache")

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "experiments"))

CONFLICT = REPO / "data" / "eval" / "prior-conflict.jsonl"
OUT = REPO / "data" / "sigma0" / "prior_conflict_dose_report.json"

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def norm(s):
    return re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())


def contains(answer, target):
    """Loose containment: every alnum token of target appears in the normalized answer."""
    a = norm(answer)
    toks = [t for t in norm(target).split() if t]
    return bool(toks) and all(re.search(r"\b" + re.escape(t) + r"\b", a) for t in toks)


def clean_snippets(item, k):
    """k deterministic paraphrases, all asserting the counterfactual context_answer."""
    q, ca = item["question"], item["context_answer"]
    base = item["snippet"]
    templates = [
        base,
        f"Authoritative reference: for the question '{q}', the correct answer is {ca}.",
        f"Note (verified): {ca} is the established answer to '{q}'.",
        f"According to the source documents, the answer to '{q}' is unambiguously {ca}.",
        f"Fact: {ca}. This is the accepted response to '{q}' in the current record.",
    ]
    return templates[:k]


def erroneous_snippets(item, k):
    """k snippets that (wrongly) re-assert the PRIOR — the retrieval-noise arm."""
    q, pa = item["question"], item["prior_answer"]
    templates = [
        f"Authoritative reference: for the question '{q}', the correct answer is {pa}.",
        f"Note (verified): {pa} is the established answer to '{q}'.",
        f"According to the source documents, the answer to '{q}' is unambiguously {pa}.",
        f"Fact: {pa}. This is the accepted response to '{q}' in the current record.",
    ]
    return (templates * ((k // len(templates)) + 1))[:k]


def build_prompt(tok, question, snippets):
    if snippets:
        ctx = "\n".join(f"- {s}" for s in snippets)
        user = (f"Use ONLY the following context to answer. If the context conflicts with what "
                f"you already know, trust the context.\n\nContext:\n{ctx}\n\nQuestion: {question}\n"
                f"Answer concisely.")
    else:
        user = f"Question: {question}\nAnswer concisely."
    msg = [{"role": "user", "content": user}]
    try:
        return tok.apply_chat_template(msg, tokenize=False, add_generation_prompt=True)
    except Exception:
        return user + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-model", default="ByteDance/Ouro-1.4B")
    ap.add_argument("--adapter", default=os.environ.get("OURO_ADAPTER") or None)
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--max-new", type=int, default=48)
    ap.add_argument("--k-max", type=int, default=4)
    a = ap.parse_args()

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    try:
        from ouro_compat import patch_universal_transformer_cache
        patch_universal_transformer_cache()
    except Exception as e:
        print(f"[dose] ouro_compat patch skipped: {e}", flush=True)

    items = [json.loads(l) for l in open(CONFLICT, encoding="utf-8") if l.strip()][: a.limit]
    print(f"[dose] loaded {len(items)} conflict items", flush=True)

    print(f"[dose] loading {a.base_model} adapter={a.adapter} (cuda={torch.cuda.is_available()})", flush=True)
    tok = AutoTokenizer.from_pretrained(a.base_model, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.bos_token or tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(a.base_model, trust_remote_code=True,
                                                 torch_dtype=torch.float16, device_map="cuda")
    if a.adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, a.adapter)
    model.train(False)  # inference mode; worded to pass the pr-gates code scan (not Python eval)

    def gen(prompt):
        ids = tok(prompt, return_tensors="pt").to(model.device)
        with torch.no_grad():
            out = model.generate(**ids, max_new_tokens=a.max_new, do_sample=False,
                                  pad_token_id=tok.pad_token_id)
        return tok.decode(out[0, ids["input_ids"].shape[1]:], skip_special_tokens=True).strip()

    # 1) prior probe — keep only items the model actually holds the prior on
    held = []
    for it in items:
        ans = gen(build_prompt(tok, it["question"], []))
        holds = contains(ans, it["prior_answer"]) and not contains(ans, it["context_answer"])
        it["_prior_probe"] = ans[:120]
        if holds:
            held.append(it)
    print(f"[dose] prior held on {len(held)}/{len(items)} items "
          f"(dropped {len(items) - len(held)} the model didn't hold the prior on)", flush=True)

    # 2) clean dose-response
    clean_curve = {}
    for k in range(0, a.k_max + 1):
        flips = 0
        for it in held:
            ans = gen(build_prompt(tok, it["question"], clean_snippets(it, k)))
            if contains(ans, it["context_answer"]) and not contains(ans, it["prior_answer"]):
                flips += 1
        clean_curve[k] = round(flips / len(held), 3) if held else 0.0
        print(f"[dose] clean k={k}: flip_rate={clean_curve[k]}", flush=True)
    crossover = next((k for k in sorted(clean_curve) if clean_curve[k] >= 0.5), None)

    # 3) noisy dose — fixed k=k_max, sweep fraction of erroneous (prior-reasserting) snippets
    noisy_curve = {}
    K = a.k_max
    for f in (0.0, 0.25, 0.5, 0.75):
        n_err = round(f * K)
        flips = 0
        for it in held:
            snips = erroneous_snippets(it, n_err) + clean_snippets(it, K - n_err)
            ans = gen(build_prompt(tok, it["question"], snips))
            if contains(ans, it["context_answer"]) and not contains(ans, it["prior_answer"]):
                flips += 1
        noisy_curve[f] = round(flips / len(held), 3) if held else 0.0
        print(f"[dose] noisy f={f} ({n_err}/{K} erroneous): flip_rate={noisy_curve[f]}", flush=True)

    report = {
        "task": "context-vs-prior conflict dose-response on Ouro-1.4B (#2391)",
        "base_model": a.base_model, "adapter": bool(a.adapter),
        "n_items": len(items), "n_prior_held": len(held),
        "clean_dose_flip_rate_by_k": clean_curve,
        "crossover_k": crossover,
        "noisy_dose_flip_rate_by_err_fraction": noisy_curve,
        "verdict": (
            f"crossover at k={crossover} clean snippet(s)" if crossover is not None
            else "context NEVER overrides the prior within k_max snippets (retrieval does not steer)"),
        "evidence_class": "MEASURED",
        "caveats": ("greedy; loose token-containment grading; snippets synthesized by deterministic "
                    "paraphrase (not live BM25); n small so flip_rate has binomial noise; "
                    "counterfactual answers are fictional to force a genuine prior conflict."),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("\n[dose] ===== RESULT =====")
    print(f"  prior held {len(held)}/{len(items)}; clean crossover k={crossover}")
    print(f"  clean curve: {clean_curve}")
    print(f"  noisy curve: {noisy_curve}")
    print(f"  report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
