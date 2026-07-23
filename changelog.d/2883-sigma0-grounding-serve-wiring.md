### Σ₀ grounding verdict wired into the serve path + measured on CPU (#2883)

The served Ouro kernel can now attach its **two-factor honesty verdict** to a response —
`grounded=True` **only** when the reasoning loop was contraction-stable (JSRR ρ<1) **and** an
external verifier confirmed the answer. It rides as pure metadata (`x-ouro-grounded` header +
`sigma0_grounding` body field) and is **opt-in** (`SIGMA0_GROUNDED=1`, native loop only): with the
flag unset the serving default is byte-identical — the verdict never changes a token. With no
verifier wired at serve time the verdict is the active-face **pending** state
(`klass=experiment_required`), so serving can never emit a fabricated `grounded=True`.

Measurement: added a `native` engine to `scripts/eval_keystone.py` — in-process
`AutoModelForCausalLM.generate` (bf16, greedy, `low_cpu_mem_usage`) matching the serve kernel, so
the golden set is now measurable **CPU-only**, no CUDA/Ollama. Greedy decoding is deterministic in
the weights, so a CPU pass@1 equals the GPU-served number token-for-token — a real measurement, not
a proxy. Measured row `ouro-native-cpu-bf16`: **accuracy 0.277** on the 65-prompt golden set
(smoke 1.0, easy 0.286, medium 0.25, hard 0.136; avg 47.3 s/prompt at ~0.3 tok/s). Honest read:
this is the RAW-kernel floor — no context injection, 32-token cap — and it sits in-family with the
prior raw-Ouro rows (0.10–0.22 at depths 1/2/4), slightly above them. The 0.72–0.85 rows on the
same board are a 7B model behind chat-with-context; not comparable surfaces.
