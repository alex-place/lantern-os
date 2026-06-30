### Added
- **Keystone-Σ₀ PLT — own-the-model training package** (`models/keystone-sigma0-plt/`) — a
  self-contained, pull-and-train scaffold for a *proprietary* Σ₀ coder bootstrapped from the
  Apache-2.0 LoopCoder-V2 Parallel Loop Transformer (arXiv:2510.24824). We own the forward
  pass end-to-end: `modeling_keystone_plt.py` is a pure-`torch`/`transformers` port of the
  vendor's vLLM-only PLT implementation (no vLLM, no custom CUDA), so the model loads with
  `AutoModelForCausalLM.from_pretrained(..., trust_remote_code=True)` and trains with `peft`.
  Ships `download_and_patch.py` (fetch weights + wire `auto_map`), `check_parity.py` (the
  **Stage-0 gate**: weight-key match + smoke gen + optional vLLM logit parity),
  `train_lora.py` (QLoRA, adapter-only over a frozen base per ADR-0010), and a runbook.
  Improves the **Reason** stage (a self-converging looped local kernel we control) and unlocks
  the **Converge** flywheel (adapter-only weight adjustment). Decision: **ADR-0011** (Proposed).
- **ADR-0011** (`docs/adr/0011-proprietary-sigma0-base-model.md`) — *Own a proprietary Σ₀ base
  model — fork the PLT architecture, adapter-only weights, council + CSF native* (Proposed,
  pending owner approval). Also backfilled the ADR index with 0009–0011.
