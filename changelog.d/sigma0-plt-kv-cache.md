### Σ₀ PLT coder — exact KV-cache decode (4.29 → 7.83 tok/s, DONT_BUILD → BUILD)

The owned Keystone-Σ₀ PLT forward (`models/keystone-sigma0-plt/modeling_keystone_plt.py`)
now ships an **exact incremental-decode KV cache** for the Parallel Loop Transformer.
Previously `.generate()` recomputed the full forward every step (O(n²), self-documented in the
old `prepare_inputs_for_generation`). Both a **dynamic** cache (`fast_generate`, grows via
`cat`) and a **static** pre-allocated cache (`fast_generate_static`, in-place `index_copy_`,
`torch.compile`-ready) are provided; `model.generate(do_sample=False)` routes through the static
path for batch-1.

Greedy output is **token-identical** to the full-recompute path — verified 14/14 across
prompt</≥window, gen-crosses-window, `num_loops=3`, `plt_clp_shift=True`,
`normalize_per_loop=False`, `window=1` (both caches, eager and compiled) — and the original
full-forward path is preserved **bit-exact** (`max_abs_diff=0.0`), so parity / training are
unaffected.

On the on-box 4-bit feasibility probe (RTX 3070, nf4), same FIT/RUNS/SPEED test:

| | tok/s | verdict |
|---|--:|:--|
| baseline (no cache) | 4.29 | DONT_BUILD |
| dynamic cache | 5.82 | BUILD |
| **static cache** | **7.83** | **BUILD** |

The static cache wins by avoiding per-step `cat` allocation. `torch.compile` does **not** help
under bnb-nf4 here (6.65 tok/s — cudagraphs disabled by the in-place cache write, and bnb-4bit
ops don't lower in inductor); `decode_step_static` does capture as a single fullgraph, so the
compile path is ready for a compile-friendly quant (torchao int4) on a newer-torch box. The
registry entry stays `verified:false` — BUILD = feasible-to-serve, not a capability win over
Qwen2.5-Coder (the head-to-head eval is the remaining promotion gate).
