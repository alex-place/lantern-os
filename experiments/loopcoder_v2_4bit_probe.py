#!/usr/bin/env python3
"""LoopCoder-v2 — 4-bit feasibility probe for the 8GB box.

Before sinking a serve-proxy build into LoopCoder-v2, answer three empirical questions on the
actual hardware, because every number we have for it is predicted/unverified:

    FIT   — does the 7B PLT load 4-bit under the 8GB VRAM budget (weights + KV + activations)?
    RUNS  — does it generate coherent code (the novel PLT arch + bitsandbytes 4-bit might not
            load via AutoModelForCausalLM, or might quantize the custom attention badly)?
    SPEED — tok/s on a 3070 (7B + 2 parallel loops + bnb-4bit + unoptimized custom kernels could
            land in single digits, which is fine for batch eval but painful interactively).

This does NOT wire anything in. It loads, generates a few short coding completions, measures peak
VRAM and tok/s, and prints a BUILD / DON'T-BUILD verdict. If the arch won't load 4-bit, it says so
plainly instead of guessing.

Run on the box with the GPU (e.g. the .venv-train cu121 env):
    python experiments/loopcoder_v2_4bit_probe.py
    python experiments/loopcoder_v2_4bit_probe.py --bits 8 --max-new-tokens 192

Needs: torch (cu12x), transformers, bitsandbytes, accelerate, and ~14GB download on first run.
Appends a run summary to data/convergence/loopcoder-probe-log.jsonl.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

# Windows consoles default to cp1252 and choke on unicode; make stdout UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

REPO = Path(__file__).resolve().parents[1]
LOG = REPO / "data" / "convergence" / "loopcoder-probe-log.jsonl"
VRAM_BUDGET_GB = 8.0          # the box
SPEED_PASS = 10.0            # tok/s — comfortably interactive
SPEED_MARGINAL = 5.0        # tok/s — usable for batch eval, painful interactively

# Original (non-HumanEval-verbatim, to avoid contamination) signature+docstring completions.
PROMPTS = [
    ("is_palindrome",
     "def is_palindrome(s: str) -> bool:\n"
     '    """Return True if s reads the same forwards and backwards, ignoring case and spaces."""\n'),
    ("two_sum",
     "def two_sum(nums, target):\n"
     '    """Return indices [i, j] such that nums[i] + nums[j] == target, or None if no pair exists."""\n'),
    ("merge_sorted",
     "def merge_sorted(a, b):\n"
     '    """Merge two ascending-sorted lists into one ascending-sorted list."""\n'),
]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="LoopCoder-v2 4-bit feasibility probe")
    p.add_argument("--model", default="Multilingual-Multimodal-NLP/LoopCoder-V2")
    p.add_argument("--bits", type=int, default=4, choices=(4, 8))
    p.add_argument("--max-new-tokens", type=int, default=160)
    return p.parse_args()


def emit(summary: dict) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(summary) + "\n")
    print(f"\nrun summary appended -> {LOG.relative_to(REPO)}")


def main() -> int:
    args = parse_args()
    summary = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "model": args.model, "bits": args.bits,
        "loaded": False, "generated": False,
        "peak_vram_gb": None, "fits_8gb": None, "tok_per_s": None,
        "verdict": "DID_NOT_RUN", "error": None,
    }

    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    except Exception as e:  # noqa: BLE001
        summary["error"] = f"import failed: {e}"
        print(f"DEPENDENCY MISSING — {e}\nInstall: torch (cu12x) transformers bitsandbytes accelerate")
        emit(summary)
        return 2

    if not torch.cuda.is_available():
        summary["error"] = "no CUDA device"
        print("NO GPU — this probe measures real VRAM/speed and must run on the 3070, not CPU.")
        emit(summary)
        return 2

    gpu = torch.cuda.get_device_name(0)
    print("=" * 64)
    print(f"LoopCoder-v2 {args.bits}-bit feasibility probe  —  GPU: {gpu}")
    print("=" * 64)

    quant = (BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                                bnb_4bit_compute_dtype=torch.float16,
                                bnb_4bit_use_double_quant=True)
             if args.bits == 4 else
             BitsAndBytesConfig(load_in_8bit=True))

    # ── LOAD (the #1 risk: a novel PLT arch may not load via AutoModelForCausalLM) ──
    torch.cuda.reset_peak_memory_stats()
    try:
        tok = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
        t0 = time.time()
        model = AutoModelForCausalLM.from_pretrained(
            args.model, quantization_config=quant,
            device_map="cuda:0", trust_remote_code=True,
        )
        model.eval()
        load_s = time.time() - t0
    except Exception as e:  # noqa: BLE001
        summary["error"] = f"load failed: {e}"
        print("LOAD FAILED — the PLT arch likely isn't AutoModelForCausalLM/bitsandbytes-"
              "compatible as-is.\nThis is a real blocker, not a flake. Detail:\n")
        traceback.print_exc()
        emit(summary)
        return 1

    summary["loaded"] = True
    cfg = getattr(model, "config", None)
    loops = getattr(cfg, "plt_num_loops", getattr(cfg, "num_loops", "?"))
    print(f"loaded in {load_s:.1f}s  |  plt_num_loops={loops}  |  ctx={getattr(cfg,'max_position_embeddings','?')}")

    # ── RUNS + SPEED ──
    gen_tokens = 0
    gen_time = 0.0
    coherent = 0
    print("\n-- generations --")
    for i, (name, prompt) in enumerate(PROMPTS):
        ids = tok(prompt, return_tensors="pt").to("cuda:0")
        if i == 0:  # warm-up excluded from timing (kernel compile / first-call overhead)
            with torch.no_grad():
                model.generate(**ids, max_new_tokens=16, do_sample=False)
        torch.cuda.synchronize()
        t0 = time.time()
        with torch.no_grad():
            out = model.generate(**ids, max_new_tokens=args.max_new_tokens, do_sample=False)
        torch.cuda.synchronize()
        dt = time.time() - t0
        new = out.shape[-1] - ids["input_ids"].shape[-1]
        gen_tokens += new
        gen_time += dt
        body = tok.decode(out[0][ids["input_ids"].shape[-1]:], skip_special_tokens=True)
        looks_codey = ("return" in body or "for " in body or "if " in body) and len(body.strip()) > 8
        coherent += int(looks_codey)
        print(f"  [{name}] {new} tok in {dt:.1f}s  ({new/max(dt,1e-9):.1f} tok/s)  "
              f"{'coherent' if looks_codey else 'SUSPECT'}")
        print("      " + body.strip().replace("\n", "\n      ")[:240])

    peak = torch.cuda.max_memory_allocated() / 1e9
    tps = gen_tokens / gen_time if gen_time else 0.0
    summary.update(generated=True, peak_vram_gb=round(peak, 2),
                   fits_8gb=peak < VRAM_BUDGET_GB, tok_per_s=round(tps, 1))

    # ── VERDICT ──
    fit = peak < VRAM_BUDGET_GB
    runs = coherent >= 2  # at least 2/3 produced plausible code
    speed = "PASS" if tps >= SPEED_PASS else "MARGINAL" if tps >= SPEED_MARGINAL else "FAIL"
    build = fit and runs and tps >= SPEED_MARGINAL
    summary["verdict"] = "BUILD" if build else "DONT_BUILD"

    print("\n" + "=" * 64)
    print("VERDICT")
    print("=" * 64)
    print(f"  FIT   : peak {peak:.2f}GB  {'<' if fit else '>='} {VRAM_BUDGET_GB:.0f}GB  -> {'PASS' if fit else 'FAIL'}")
    print(f"  RUNS  : {coherent}/{len(PROMPTS)} coherent           -> {'PASS' if runs else 'FAIL'}")
    print(f"  SPEED : {tps:.1f} tok/s                  -> {speed}")
    print(f"\n  => {'BUILD the serve-proxy' if build else 'DO NOT build — fall back to Qwen2.5-Coder-7B'}")
    if build and speed == "MARGINAL":
        print("     (usable for batch eval; interactive coding will feel slow on this GPU)")
    emit(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
