### Serving substrate decision (ADR-0021) + Ouro serving restored + certificate ρ=1.064 control-check

Web-grounded (mid-2026 SOTA, 4 lenses, adversarially verified — 0 refuted) the two open serving
questions and recorded the decision as **ADR-0021 (Proposed)**: retain the Ouro/Σ₀ custom
`transformers` loop, reject an engine port (no engine serves adaptive depth or exposes mid-layer
hidden states), defer a Qwen3.5-4B base swap to a registry node. Findings memo:
`docs/research/2026-07-04-serving-design-sota.md`.

- **Ouro serving restored + real cache fix (verified):** a D:-drive cleanup had wiped the GPU
  venv (`D:\lantern-venv-train`, behind the `.venv-train` junction) and the HF cache
  (`D:\hf-cache`), so the model stopped loading. Rebuilt both (`scripts/rebuild-train-venv.ps1`,
  torch 2.5.1+cu121 + transformers 4.55.0). Found the deeper bug: Ouro's remote
  `UniversalTransformerCache` assigns to `key_cache`/`value_cache`, which are **read-only
  properties on transformers ≥ 4.54** — no stock version fixes it (older transformers lacks
  Ouro's other imports). `scripts/ouro_compat.py::patch_universal_transformer_cache()` patches
  the class at runtime (applied by `ouro_serve.py`); `tests/test_ouro_compat.py` 9 pass. Verified
  end-to-end: Ouro-1.4B-Thinking loads (2.87 GB VRAM, RTX 3070) and generates "The capital of
  France is" → " Paris." **Correction:** an earlier draft's "pin transformers<4.56" advice was
  wrong (4.54.1 also has the read-only property).
- **Honest correction (certificate):** annotated the Collapse Certificate's headline `ρ = 1.064`
  §6 result as an unreliable estimate — `experiments/rho_controls.py` shows the mean is a fitting
  artifact (unregularized lstsq tail-blows-up to max ρ ≈ 16,872 on real chat; ridge collapses
  ρ>1; median contracting; poor non-normal fit; state is 4 text-surface features, not model
  hidden states). Number kept, not deleted; the real measurement (loop Jacobian on Ouro hidden
  states) is staged.

The Ouro base now loads and generates. The GPU-gated *performance* phases (in-loop KV speedups,
mid-layer probe, real loop-Jacobian fit) remain staged in the ADR, not claimed done.
