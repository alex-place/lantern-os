#!/usr/bin/env python3
"""Stage-0 gate (ADR-0011): does OUR forward load the weights and produce sane code?

This is the BLOCKING step before any training. It does two things:

  SMOKE  — load the patched checkpoint through our transformers modeling code
           (4-bit by default so it fits a 24 GB box, or --dtype bf16 for full),
           confirm EVERY weight tensor mapped (no missing/unexpected keys), and
           generate a few short completions. Garbage output ⇒ the PLT forward is
           wrong somewhere (see the three parity boundaries in
           modeling_keystone_plt.py) — fix before training.

  PARITY  — (optional, --ref logits.pt) compare our next-token logits against a
            reference captured from the upstream vLLM fork on identical inputs.
            Reports max abs diff + top-1 agreement. This is the real proof the
            port is faithful; capture the reference with the vLLM fork once.

    python check_parity.py --model ./checkpoint
    python check_parity.py --model ./checkpoint --dtype bf16 --ref ref_logits.pt

Appends a verdict to data/convergence/keystone-plt-parity-log.jsonl.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

REPO = Path(__file__).resolve().parents[2]
LOG = REPO / "data" / "convergence" / "keystone-plt-parity-log.jsonl"

PROMPTS = [
    "def is_palindrome(s: str) -> bool:\n    \"\"\"Return True if s reads the same forwards and backwards, ignoring case and spaces.\"\"\"\n",
    "def two_sum(nums, target):\n    \"\"\"Return indices [i, j] such that nums[i] + nums[j] == target.\"\"\"\n",
    "def fib(n):\n    \"\"\"Return the nth Fibonacci number (0-indexed).\"\"\"\n",
]


def emit(rec: dict) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")
    print(f"\nverdict appended → {LOG}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--dtype", default="4bit", choices=("4bit", "bf16", "fp16"))
    ap.add_argument("--max-new-tokens", type=int, default=96)
    ap.add_argument("--ref", default=None, help="reference logits .pt from the vLLM fork (optional)")
    args = ap.parse_args()

    rec = {
        "ts": datetime.now(timezone.utc).isoformat(), "model": args.model,
        "dtype": args.dtype, "loaded": False, "missing_keys": None,
        "unexpected_keys": None, "coherent": None, "parity": None,
        "verdict": "DID_NOT_RUN",
    }

    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except Exception as e:  # noqa: BLE001
        print(f"deps missing: {e}\n  pip install -r requirements.txt")
        emit(rec)
        return 2

    kw = {"trust_remote_code": True}
    if args.dtype == "4bit":
        from transformers import BitsAndBytesConfig
        kw["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
        kw["device_map"] = "cuda:0"
    else:
        kw["torch_dtype"] = torch.bfloat16 if args.dtype == "bf16" else torch.float16
        kw["device_map"] = "cuda:0" if torch.cuda.is_available() else "cpu"

    tok = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    print(f"loading {args.model}  ({args.dtype}) …")
    t0 = time.time()
    # output_loading_info surfaces any weight-key mismatch — a silent mismatch is
    # the most common 'loads but generates garbage' failure for a hand-ported arch.
    model, info = AutoModelForCausalLM.from_pretrained(
        args.model, output_loading_info=True, **kw)
    model.eval()
    rec["loaded"] = True
    rec["missing_keys"] = list(info.get("missing_keys", []))
    rec["unexpected_keys"] = list(info.get("unexpected_keys", []))
    print(f"loaded in {time.time()-t0:.1f}s  |  missing={len(rec['missing_keys'])}  "
          f"unexpected={len(rec['unexpected_keys'])}")
    if rec["missing_keys"]:
        print("  ⚠ MISSING:", rec["missing_keys"][:8])
    if rec["unexpected_keys"]:
        print("  ⚠ UNEXPECTED:", rec["unexpected_keys"][:8])

    dev = next(model.parameters()).device
    coherent = 0
    print("\n-- generations --")
    for p in PROMPTS:
        ids = tok(p, return_tensors="pt").to(dev)
        with torch.no_grad():
            out = model.generate(**ids, max_new_tokens=args.max_new_tokens, do_sample=False)
        body = tok.decode(out[0][ids["input_ids"].shape[-1]:], skip_special_tokens=True)
        codey = ("return" in body or "for " in body or "if " in body) and len(body.strip()) > 8
        coherent += int(codey)
        print(f"  [{'OK ' if codey else 'BAD'}] {body.strip()[:200]!r}")
    rec["coherent"] = f"{coherent}/{len(PROMPTS)}"

    # Optional faithful-parity check vs a vLLM-fork reference.
    if args.ref and Path(args.ref).exists():
        ref = torch.load(args.ref)  # {"input_ids": LongTensor[1,T], "logits": Float[1,T,V]}
        ids = ref["input_ids"].to(dev)
        with torch.no_grad():
            ours = model(ids).logits.float().cpu()
        rl = ref["logits"].float()
        max_abs = (ours - rl).abs().max().item()
        top1 = (ours.argmax(-1) == rl.argmax(-1)).float().mean().item()
        rec["parity"] = {"max_abs_diff": max_abs, "top1_agree": top1}
        print(f"\nPARITY vs vLLM ref: max|Δ|={max_abs:.4f}  top1-agree={top1:.4f}")

    ok = rec["loaded"] and not rec["missing_keys"] and not rec["unexpected_keys"] and coherent >= 2
    if rec["parity"] is not None:
        ok = ok and rec["parity"]["top1_agree"] >= 0.99
    rec["verdict"] = "PASS" if ok else "FAIL"
    print(f"\n=> Stage-0 {rec['verdict']}")
    emit(rec)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
