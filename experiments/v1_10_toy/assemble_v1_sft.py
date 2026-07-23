#!/usr/bin/env python3
"""
V1-B — assemble the honest-teacher SFT set (the recipe from the training-set review).

Three parts, both-class, DECONTAMINATED against the honesty eval (5-gram overlap -> drop):
  anchor   (~60%)  tulu-3-sft-mixture sample — keeps a working assistant (survey G3; VTD run-1's
                   -6 was instruct damage from a zero-anchor tune)
  honesty  (~20%)  our convergence records + mined corpus, reformatted as assert/deny turns
  boundary (~20%)  v1_boundary_probe output (Gekhman-calibrated assert/abstain from gsm8k)

Output: data/eval/v1_10/v1-sft.jsonl  {prompt, solution}  (the schema train_qlora_qwen_coder.py eats)
"""
import argparse
import hashlib
import json
import os
import random

if os.name == "nt":
    os.environ.setdefault("HF_HOME", "D:/hf-cache")

EVAL = "data/eval/v1_10/honesty-eval-full.jsonl"
OUT = "data/eval/v1_10/v1-sft.jsonl"
LEDGER = "data/convergence/records.jsonl"
CORPUS = "data/eval/v1_10/corpus-v0.jsonl"


def five_grams(text):
    toks = [t for t in ''.join(c.lower() if c.isalnum() else ' ' for c in text).split()]
    return {tuple(toks[i:i+5]) for i in range(len(toks) - 4)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--boundary", default="data/eval/v1_10/boundary-gsm8k.jsonl")
    ap.add_argument("--anchor-n", type=int, default=900)
    ap.add_argument("--seed", type=int, default=11)
    a = ap.parse_args()
    rng = random.Random(a.seed)

    # decontamination index from the eval
    eval_grams = set()
    for l in open(EVAL, encoding="utf-8"):
        if l.strip():
            eval_grams |= five_grams(json.loads(l)["statement"])
    print(f"decontam index: {len(eval_grams)} 5-grams from the honesty eval", flush=True)

    rows, dropped = [], 0

    def add(prompt, solution, kind):
        nonlocal dropped
        if not prompt or not solution:
            return
        if five_grams(prompt + " " + solution) & eval_grams:
            dropped += 1
            return
        rows.append({"prompt": prompt, "solution": solution, "kind": kind})

    # honesty core — convergence records + mined corpus
    for path in (LEDGER, CORPUS):
        try:
            for l in open(path, encoding="utf-8"):
                if not l.strip():
                    continue
                r = json.loads(l)
                claim = (r.get("claim") or "").strip()
                if not claim:
                    continue
                conf = r.get("confidence", 0.5)
                if r.get("refuted"):
                    sol = (f"That is not correct. {r.get('corrected') if isinstance(r.get('corrected'), str) else ''}"
                           f" (confidence {conf:.2f}; evidence: {str(r.get('evidence'))[:160]})").strip()
                else:
                    sol = f"Yes. {str(r.get('evidence'))[:200]} (confidence {conf:.2f})".strip()
                add(f"Is this accurate: {claim}", sol, "honesty")
        except FileNotFoundError:
            print(f"  (skip {path} — not found)")

    # boundary slice — Gekhman-calibrated assert/abstain
    nb = 0
    try:
        for l in open(a.boundary, encoding="utf-8"):
            if not l.strip():
                continue
            r = json.loads(l)
            add(r["question"], r["target"], f"boundary-{r['honesty_class']}")
            nb += 1
    except FileNotFoundError:
        print(f"  (boundary file {a.boundary} not ready — run v1_boundary_probe.py first)")

    core_n = len(rows)
    # anchor — tulu-3 sample sized to ~60% of the final set
    target_anchor = min(a.anchor_n, max(1, int(core_n / 0.4 * 0.6)))
    try:
        from datasets import load_dataset
        ds = load_dataset("allenai/tulu-3-sft-mixture", split="train")
        idxs = rng.sample(range(len(ds)), min(target_anchor * 3, len(ds)))
        added = 0
        for i in idxs:
            if added >= target_anchor:
                break
            msgs = ds[i].get("messages") or []
            u = next((m["content"] for m in msgs if m["role"] == "user"), None)
            asst = next((m["content"] for m in msgs if m["role"] == "assistant"), None)
            if u and asst and len(u) < 1200 and len(asst) < 1600:
                add(u, asst, "anchor")
                added += 1
        print(f"  anchor rows added: {added}", flush=True)
    except Exception as e:
        print(f"  (anchor skipped: {str(e)[:120]})")

    rng.shuffle(rows)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")

    from collections import Counter
    kinds = Counter(r["kind"] for r in rows)
    anchor = sum(v for k, v in kinds.items() if k == "anchor")
    print(f"\nwrote {len(rows)} SFT rows -> {OUT}  (decontam-dropped {dropped})")
    for k, v in sorted(kinds.items()):
        print(f"  {k:20s} {v}")
    if rows:
        print(f"  anchor fraction: {anchor/len(rows):.2f}  (target >=0.60, survey G3)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
