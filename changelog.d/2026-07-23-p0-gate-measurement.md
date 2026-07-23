P0 gate-wiring, step 1 (measure before wiring): experiments/p0_gate_measure.py tests the JSRR
gate + Σ₀⁻¹ operator in isolation on-box, no model. Findings (data/sigma0/p0-gate-measurements.json):
verdict 5/5 correct incl. the non-normal case that proves exact ρ is the right object (accepts
ρ=0.9 despite σ_max=5.16, which a surrogate gate would reject); exact ρ costs ~7.0s/call at
d=2048 (impractical per-generation) vs 52ms at d=256 — so the serve-path gate must run on a
REDUCED reasoning-state Jacobian (confirm its dim, the deferred JVP #2029) or a two-tier
surrogate-then-exact gate (surrogate is 2500× faster but over-rejects 26.5% near the boundary);
Σ₀⁻¹.excite verified functional (anisotropy 1.0→1.45, state-kick fired) → safe to arm bounded.
