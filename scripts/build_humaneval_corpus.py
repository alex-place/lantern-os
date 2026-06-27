#!/usr/bin/env python3
"""
Build a HumanEval-optimized coding corpus for the Ouro QLoRA adapter.

WHY: the in-tree models/lantern-sigma0-coder/training-data.jsonl (243 rows) and the
function-calling corpus (Hermes/ToolACE) train tool-calling, NOT free-form Python code
generation. HumanEval pass@1 measures the latter. The grounded, best-cited recipe for
lifting HumanEval pass@1 on a small model is Magicoder's **OSS-Instruct + Evol-Instruct**
(Wei et al., arXiv:2312.02120 — Magicoder S-CL-7B reaches 66.5% HumanEval+). We use the
clean, execution-filtered members of that family and DECONTAMINATE against HumanEval so the
score reflects generalization, not leakage (Σ₀ External Reality rule — no cheating).

SOURCES (HuggingFace Hub, downloaded to HF_HOME on first run):
  - ise-uiuc/Magicoder-OSS-Instruct-75K        problem  -> instruction, solution -> output
  - bigcode/self-oss-instruct-sc2-exec-filter-50k  instruction/response (exec-filtered, clean)
  - google-research-datasets/mbpp (full)       text+test_list -> instruction, code -> output
        (train+validation+prompt splits ONLY — the 500-row `test` split is the benchmark)

DECONTAMINATION: any candidate row sharing a 13-gram (word-level, normalized) with ANY
HumanEval prompt or canonical_solution is dropped. 13-gram overlap is the standard test-set
decontamination filter (Brown et al. 2020 / Llama).

Output schema matches train-qlora-ouro.py: {"instruction", "input", "output"} (input="").

Usage:
    python scripts/build_humaneval_corpus.py                     # default 15k rows, decontaminated
    python scripts/build_humaneval_corpus.py --limit 25000
    python scripts/build_humaneval_corpus.py --out models/lantern-sigma0-coder/humaneval-train.jsonl
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

if os.name == "nt":  # Windows local dev — keep the big HF cache off C:
    os.environ.setdefault("HF_HOME", "D:/hf-cache")

ROOT = Path(__file__).resolve().parent.parent
OUT_DEFAULT = ROOT / "models" / "lantern-sigma0-coder" / "humaneval-train.jsonl"

NGRAM = 13  # word-level n-gram length for decontamination


def _norm_words(text: str):
    """Lowercase, strip non-alphanumerics to spaces, split — for n-gram overlap."""
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).split()


def _ngrams(words, n=NGRAM):
    for i in range(len(words) - n + 1):
        yield " ".join(words[i:i + n])


def build_poison_set():
    """13-grams drawn from every HumanEval prompt + canonical solution."""
    from datasets import load_dataset
    he = load_dataset("openai_humaneval", split="test")
    poison = set()
    for r in he:
        for field in ("prompt", "canonical_solution"):
            poison.update(_ngrams(_norm_words(r.get(field, ""))))
    print(f"[decontam] HumanEval poison set: {len(poison)} 13-grams from {len(he)} tasks")
    return poison


def is_contaminated(instruction, output, poison):
    words = _norm_words(instruction + "\n" + output)
    if len(words) < NGRAM:
        return False
    return any(g in poison for g in _ngrams(words))


def load_oss_instruct(limit):
    from datasets import load_dataset
    ds = load_dataset("ise-uiuc/Magicoder-OSS-Instruct-75K", split="train")
    rows = []
    for r in ds:
        if (r.get("lang") or "").lower() != "python":
            continue
        instr, out = (r.get("problem") or "").strip(), (r.get("solution") or "").strip()
        if instr and out:
            rows.append({"instruction": instr, "input": "", "output": out})
        if limit and len(rows) >= limit:
            break
    return rows


def load_self_oss(limit):
    from datasets import load_dataset
    ds = load_dataset("bigcode/self-oss-instruct-sc2-exec-filter-50k", split="train")
    rows = []
    for r in ds:
        instr, out = (r.get("instruction") or "").strip(), (r.get("response") or "").strip()
        if instr and out:
            rows.append({"instruction": instr, "input": "", "output": out})
        if limit and len(rows) >= limit:
            break
    return rows


def load_mbpp():
    """MBPP train+validation+prompt (NOT test — that's the held-out benchmark)."""
    from datasets import load_dataset
    rows = []
    for split in ("train", "validation", "prompt"):
        try:
            ds = load_dataset("google-research-datasets/mbpp", "full", split=split)
        except Exception as e:
            print(f"[mbpp] skip {split}: {e}")
            continue
        for r in ds:
            text = (r.get("text") or "").strip()
            code = (r.get("code") or "").strip()
            tests = r.get("test_list") or []
            if not text or not code:
                continue
            instr = text
            if tests:
                instr += "\n\nYour code should pass these tests:\n" + "\n".join(tests)
            rows.append({"instruction": instr, "input": "", "output": code})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(OUT_DEFAULT))
    ap.add_argument("--limit", type=int, default=15000, help="target total rows after dedup/decontam")
    ap.add_argument("--max-chars", type=int, default=5500,
                    help="drop rows whose instruction+output exceeds this (~1500 tok @ seq=1536, "
                         "so no code answer is truncated mid-function during training); 0 = no cap")
    ap.add_argument("--no-decontam", action="store_true", help="skip HumanEval decontamination (debug only)")
    ap.add_argument("--no-oss", action="store_true")
    ap.add_argument("--no-self-oss", action="store_true")
    ap.add_argument("--no-mbpp", action="store_true")
    ap.add_argument("--seed", type=int, default=20260626)
    args = ap.parse_args()

    poison = set() if args.no_decontam else build_poison_set()

    # MBPP first (small, high-value, always keep all), then fill from the synthetic sets.
    pool = []
    if not args.no_mbpp:
        mbpp = load_mbpp()
        print(f"[mbpp]      {len(mbpp)} rows")
        pool.extend(mbpp)
    remaining = max(0, args.limit - len(pool))
    # Oversample the synthetic sources before decontam/dedup trims them down.
    grab = int(remaining * 0.75) + 2000
    if not args.no_oss:
        oss = load_oss_instruct(grab)
        print(f"[oss]       {len(oss)} python rows")
        pool.extend(oss)
    if not args.no_self_oss:
        soss = load_self_oss(grab)
        print(f"[self-oss]  {len(soss)} rows")
        pool.extend(soss)

    # Dedup by instruction, decontaminate, cap.
    import random
    random.seed(args.seed)
    random.shuffle(pool)

    seen, kept, n_contam, n_dup, n_long = set(), [], 0, 0, 0
    for r in pool:
        key = r["instruction"][:200]
        if key in seen:
            n_dup += 1
            continue
        seen.add(key)
        if args.max_chars and len(r["instruction"]) + len(r["output"]) > args.max_chars:
            n_long += 1
            continue
        if poison and is_contaminated(r["instruction"], r["output"], poison):
            n_contam += 1
            continue
        kept.append(r)
        if len(kept) >= args.limit:
            break

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        for r in kept:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"\n[done] wrote {len(kept)} rows -> {out_path}")
    print(f"       dropped {n_dup} dups, {n_long} over-length, {n_contam} HumanEval-contaminated")


if __name__ == "__main__":
    main()
