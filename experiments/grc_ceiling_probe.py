"""
GRC ceiling probe (Technique 3 / #1595) — cheap go/no-go BEFORE building the cold coder.

A language model's teacher-forced cross-entropy in bits/byte over a text IS the lower
bound an ideal arithmetic coder using that model would emit (DeepMind "Language Modeling
Is Compression", ICLR 2024). So we measure a model's intrinsic CE bits/byte and compare it
to what CSF actually SHIPS on the full file (brotli-11 and CSF-Col). No arithmetic coder is
built — if the neural floor cannot beat the shipping codec, GRC has no headroom on this data
and the cold (~20 min/MB), resident-model coder is not worth building.

THE FAIR COMPARISON (load-bearing): brotli/col are measured on the FULL file, because they
win by exploiting cross-record redundancy (record N is a near-duplicate of an earlier one).
The model CE is measured on a slice but is ~slice-invariant. Comparing model-CE to a *sliced*
brotli would be unfair to brotli (a cold dictionary can't see the redundancy) and would
falsely flatter the neural option.

MEASURED (2026-06-29, gpt2-124M, CPU):
    log            rawB     brotli-full  col-full  gpt2-CE   verdict
    deltas.jsonl   21,286   0.401        0.328     0.585     gpt2 loses +78%
    raw.jsonl      320,163  0.524        0.487     1.016     gpt2 loses +109%
    elephant       4,649    1.833        1.972     1.035     gpt2 beats (tiny, no redundancy)
    sample_traces  3,541    2.112        2.289     1.051     gpt2 beats (tiny, no redundancy)

VERDICT: ungrounded neural prediction is REFUTED on realistic memory logs — it loses >2x to
CSF-Col, because the redundancy CSF-Col/brotli exploit is invisible to an ungrounded LM. This
is exactly the Σ₀ correction in #1595: grounding is what would let the predictor see that
redundancy. The thesis survives ONLY grounded (#1595) or as a residual pass over the CSF-Col
output (#1596). Bar to clear on the realistic corpus: beat col's ~0.49 bpb on raw.jsonl.

CAVEAT: a larger resident model (Qwen-3B / Ouro-1.4B) lowers CE vs gpt2-124M, but would have
to roughly HALVE it to reach col's 0.49 bpb on raw.jsonl — at enormous cold-compute cost. Run
this probe with --model to re-measure on the real resident model before committing to #1595.

    HF_HOME=D:\\hf-cache python experiments/grc_ceiling_probe.py [--model gpt2]
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src"))


def full_brotli_bpb(b: bytes) -> float:
    import brotli
    return len(brotli.compress(b, quality=11)) * 8 / len(b)


def full_col_bpb(b: bytes) -> float:
    import brotli
    from csf import omni
    best = min((s for lbl, s in omni.rank(b, effort="exhaustive") if lbl.startswith("col")),
               default=len(brotli.compress(b, quality=11)))
    return best * 8 / len(b)


def model_bpb(b: bytes, model, tok, ctx: int) -> float:
    """Intrinsic teacher-forced CE of `model` over `b`, in bits per ORIGINAL byte."""
    import torch
    text = b.decode("utf-8", errors="ignore")
    ids = tok(text, return_tensors="pt").input_ids[0]
    n = ids.shape[0]
    total_nll = 0.0  # nats
    with torch.no_grad():
        i = 0
        while i < n - 1:
            window = ids[i:i + ctx].unsqueeze(0)
            out = model(window, labels=window)
            total_nll += out.loss.item() * (window.shape[1] - 1)
            i += ctx
    return (total_nll / math.log(2)) / len(b)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="gpt2", help="HF model id (default gpt2-124M)")
    ap.add_argument("--slice", type=int, default=32768, help="bytes scored by the model")
    args = ap.parse_args()
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except Exception as e:
        print(f"GRC probe skipped — needs torch+transformers ({e})")
        return 0

    print(f"loading {args.model} (cpu)...")
    tok = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.float32).eval()
    ctx = min(getattr(model.config, "max_position_embeddings", 1024) or 1024, 1024)

    print("bpb = bits/byte (lower=better). brotli/col are FULL-FILE (what ships); model is")
    print("intrinsic teacher-forced CE (the ideal-arithmetic-coder floor for that model).")
    print(f"{'log':<26}{'rawB':>8}{'brotli-full':>12}{'col-full':>10}{'model-CE':>10}  verdict")
    print("-" * 90)
    for p in sorted(REPO.glob("data/csf_memory/*.jsonl")):
        full = p.read_bytes()
        if len(full) < 256:
            continue
        bb, cb = full_brotli_bpb(full), full_col_bpb(full)
        best = min(bb, cb)
        mb = model_bpb(full[:args.slice], model, tok, ctx)
        verdict = "model BEATS" if mb < best else f"model loses ({(mb / best - 1) * 100:+.0f}%)"
        print(f"{p.name[:25]:<26}{len(full):>8}{bb:>12.3f}{cb:>10.3f}{mb:>10.3f}  {verdict}")
    print("\nUngrounded CE that loses to col => GRC needs grounding (#1595) or residual (#1596).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
