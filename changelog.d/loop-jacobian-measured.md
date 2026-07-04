### Σ₀ loop is contracting — the real measurement replaces the debunked ρ=1.064

The Collapse Certificate's headline `ρ=1.064` ("the loop is non-contracting, near-boundary") was
debunked earlier as a fragile fit over four text-surface features, not the model. Now that Ouro
loads, `experiments/sigma0_loop_jacobian.py` measures the **real** recurrent-loop contraction: it
hooks Ouro-1.4B-Thinking's `OuroModel.forward` and reads the actual per-recurrent-step
hidden-state trajectory (`hidden_states_list`, dim 2048), over 8 prompts × all token positions,
run to depth 12 (3× the trained 4 — a STARS depth-scaling probe).

**Result: ρ_observed = geomean ‖Δh_{t+1}‖/‖Δh_t‖ = 0.88 < 1 → the loop CONTRACTS** toward a fixed
point, and keeps settling with depth (median last/first step-change ratio 0.15) — the *opposite*
of the debunked "near-boundary" reading, and **no** STARS-style collapse when over-iterated here.
Evidence class MEASURED (`data/sigma0/loop_jacobian_report.json`), not a fit. Certificate §6
updated; the "deferred" real-measurement note is retired. Honest caveats: ~34% of individual steps
transiently expand (non-normal — aggregate still contracts), fp16, the "Thinking" variant, 8 prompts.
