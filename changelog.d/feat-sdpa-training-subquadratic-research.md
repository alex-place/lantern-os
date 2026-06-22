feat(train): enable SDPA (FlashAttention-2) in QLoRA training

- `train-qlora-ouro.py`: add `attn_implementation="sdpa"` (with ValueError/TypeError
  fallback) to close the gap where serving used SDPA since #775 but training used eager
  attention. Reduces training activation VRAM constant factor; required step toward
  seq=4096 training.
- `docs/research/2026-06-22-ouro-subquadratic-attention.md`: full research write-up on
  the three O(n²) problems in the Ouro stack — decode (fixed #810), training attention
  (fixed here), and asymptotic architectural (SWA/linear-attn roadmap). Includes ragged-
  depth KV cache as the O(N)-adaptive prize and sequenced implementation plan.
