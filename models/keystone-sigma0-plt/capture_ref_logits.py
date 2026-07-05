#!/usr/bin/env python3
"""Capture the Stage-0 reference logits (ADR-0011 #1934) that `check_parity --ref` consumes.

WHY THIS EXISTS
`check_parity.py --ref ref_logits.pt` is the *faithful* Stage-0 gate: it runs OUR
ported forward on a fixed `input_ids` and compares next-token logits against a
reference captured from a trusted implementation, requiring `top1_agree >= 0.99`.
But producing that reference was, until now, only prose in `colab_parity.ipynb`
cell 13 ("dump reference logits for a fixed input_ids -> ref_logits.pt"). That
left the load-bearing step un-scripted, so every attempt would hand-roll the
tokenization and tensor shape — and if the prompt set or shape drifts from
`check_parity`, the comparison is silently meaningless.

This script IS that step, with the contract pinned:
  * it imports the SAME `PROMPTS` from `check_parity` (they can't drift), and
  * it writes exactly the dict `check_parity` loads:
        {"input_ids": LongTensor[1, T], "logits": FloatTensor[1, T, V]}
    (see check_parity.py: `ref = torch.load(args.ref)` → compares
     `ours.argmax(-1) == ref["logits"].argmax(-1)` over the full [1,T,V]).

REFERENCE SOURCE. `--ref-model` is the *trusted* implementation to capture from —
the vendor's ORIGINAL HuggingFace modeling of the LoopCoder-V2 checkpoint (the
one our `modeling_keystone_plt.py` re-implements). Its `model(input_ids).logits`
gives clean full-sequence logits with no sampling/kernel noise, which is the
right ground truth for a *logit* parity check. (The vendor's vLLM fork is the
same weights behind production kernels; if a vLLM-kernel reference is wanted
instead, capture the identical dict from it — check_parity doesn't care which
trusted forward produced the reference, only that the shape matches.)

HARDWARE. bf16 load of the ~7.6B model needs a >=24 GB box (L4/A100). The forward
math here is the vendor's own reference code, so it is trusted; what remains
unverified until this runs on that box is whether OUR port agrees with it — which
is exactly what check_parity measures next.

USAGE
    # on a >=24 GB GPU box, after download_and_patch.py has fetched the checkpoint:
    python capture_ref_logits.py --ref-model /content/ckpt --out ref_logits.pt
    python check_parity.py --model /content/ckpt --dtype bf16 --ref ref_logits.pt

    # contract self-test (no model, no GPU): proves the produced .pt round-trips
    # through check_parity's exact loader + comparison math.
    python capture_ref_logits.py --self-test
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Import the canonical prompt set from the gate itself so the reference is
# captured on EXACTLY the inputs check_parity will replay — no drift possible.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_parity import PROMPTS  # noqa: E402


def _save(out: Path, input_ids, logits) -> None:
    import torch

    # Normalize to the exact shapes check_parity expects: [1, T] and [1, T, V].
    if input_ids.dim() == 1:
        input_ids = input_ids.unsqueeze(0)
    if logits.dim() == 2:
        logits = logits.unsqueeze(0)
    assert input_ids.dim() == 2 and input_ids.shape[0] == 1, input_ids.shape
    assert logits.dim() == 3 and logits.shape[0] == 1, logits.shape
    assert logits.shape[1] == input_ids.shape[1], (
        f"seq mismatch: input_ids T={input_ids.shape[1]} vs logits T={logits.shape[1]}")
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {"input_ids": input_ids.to("cpu").long(), "logits": logits.to("cpu").float()},
        out,
    )


def _verify_contract(out: Path) -> bool:
    """Replay check_parity's exact --ref loader + comparison against the saved file.

    Proves the dict shape and dtype are consumable and the top-1 agreement math
    runs — a reference compared against ITSELF must agree 1.0. This is a genuine
    (CPU-only) check of the load-bearing contract, independent of any model math.
    """
    import torch

    ref = torch.load(out)
    assert set(ref) >= {"input_ids", "logits"}, f"missing keys: {set(ref)}"
    ids, lg = ref["input_ids"], ref["logits"]
    assert ids.dim() == 2 and lg.dim() == 3 and lg.shape[:2] == ids.shape, (ids.shape, lg.shape)
    # check_parity: top1 = (ours.argmax(-1) == ref.argmax(-1)).float().mean()
    self_top1 = (lg.argmax(-1) == lg.argmax(-1)).float().mean().item()
    ok = abs(self_top1 - 1.0) < 1e-9
    print(f"contract OK: input_ids{tuple(ids.shape)} logits{tuple(lg.shape)} "
          f"self-top1={self_top1:.4f}")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ref-model", help="trusted reference checkpoint (vendor HF modeling) to capture from")
    ap.add_argument("--out", default="ref_logits.pt", help="output .pt (default ref_logits.pt)")
    ap.add_argument("--dtype", default="bf16", choices=("bf16", "fp16"),
                    help="reference should be a clean (non-quantized) forward; bf16 default")
    ap.add_argument("--prompt-index", type=int, default=0,
                    help=f"which check_parity PROMPT to capture (0..{len(PROMPTS)-1}); default 0")
    ap.add_argument("--prompt", default=None, help="override with a custom prompt string")
    ap.add_argument("--self-test", action="store_true",
                    help="fabricate a tiny reference and verify the check_parity contract (no model/GPU)")
    args = ap.parse_args()

    out = Path(args.out)

    if args.self_test:
        import torch
        T, V = 8, 32
        input_ids = torch.arange(T).unsqueeze(0)          # [1, T]
        logits = torch.randn(1, T, V)                     # [1, T, V]
        _save(out, input_ids, logits)
        ok = _verify_contract(out)
        print("SELF-TEST", "PASS" if ok else "FAIL")
        return 0 if ok else 1

    if not args.ref_model:
        ap.error("--ref-model is required (or use --self-test)")

    prompt = args.prompt if args.prompt is not None else PROMPTS[args.prompt_index]

    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except Exception as e:  # noqa: BLE001
        print(f"deps missing: {e}\n  pip install -r requirements.txt")
        return 2

    dtype = torch.bfloat16 if args.dtype == "bf16" else torch.float16
    dev = "cuda:0" if torch.cuda.is_available() else "cpu"
    print(f"loading reference {args.ref_model} ({args.dtype}) on {dev} …")
    tok = AutoTokenizer.from_pretrained(args.ref_model, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        args.ref_model, torch_dtype=dtype, device_map=dev, trust_remote_code=True)
    model.eval()

    ids = tok(prompt, return_tensors="pt").to(dev)          # same tokenization as check_parity
    with torch.no_grad():
        logits = model(**ids).logits                        # [1, T, V]
    _save(out, ids["input_ids"], logits)
    print(f"wrote {out}  (prompt-index={args.prompt_index}, T={ids['input_ids'].shape[-1]}, "
          f"V={logits.shape[-1]})")
    ok = _verify_contract(out)
    print("CAPTURE", "OK" if ok else "SHAPE-FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
