### Serving substrate decision (ADR-0021) + certificate ρ=1.064 control-check + Ouro cache guard

Web-grounded (mid-2026 SOTA, 4 lenses, adversarially verified — 0 refuted) the two open serving
questions and recorded the decision as **ADR-0021 (Proposed)**: retain the Ouro/Σ₀ custom
`transformers` loop, reject an engine port (no engine serves adaptive depth or exposes mid-layer
hidden states), defer a Qwen3.5-4B base swap to a registry node. Findings memo:
`docs/research/2026-07-04-serving-design-sota.md`.

- **Guardrail (landed + tested):** `scripts/ouro_compat.py` + `tests/test_ouro_compat.py`
  (7 passing) — Ouro's recurrent KV cache breaks silently under `transformers>=4.56`; the server
  now warns loudly (hard-fails under `OURO_STRICT_TRANSFORMERS=1`). This env already runs 4.57.6,
  past the pin, so the guard fires today.
- **Honest correction:** annotated the Collapse Certificate's headline `ρ = 1.064` §6 result as an
  unreliable estimate — `experiments/rho_controls.py` shows the mean is a fitting artifact
  (unregularized lstsq tail-blows-up to max ρ ≈ 16,872 on real chat; ridge collapses ρ>1; median
  contracting; poor non-normal fit; state is 4 text-surface features, not model hidden states).
  Number kept, not deleted; the real measurement (loop Jacobian on Ouro hidden states) is staged.

GPU-gated phases (in-loop KV speedups, mid-layer probe, real loop-Jacobian fit) are staged in the
ADR, not claimed done — the Ouro model cannot load in this environment (no GPU torch, no cache).
