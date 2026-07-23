Σ₀ model program — P0 gate work + docs (2026-07-23). (1) The JSRR ρ<1 stability gate now runs on
the EXACT low-rank reduction of the empirical loop Jacobian (src/sigma0/loop_lm.py) — ρ from the
(T-1,T-1) Gram VᵀU, machine-precision, ~570× cheaper (7s→sub-ms at d=2048); matmul build (kills a
latent 2GB OOM); continuous diagnostics capped by dim; JSRR authoritative over the continuous gate
(math-check caught a false-'contract' bug on λ=−2 loops). (2) sigma0_grounding_verdict() — a
two-factor certificate: grounded=True IFF loop-stable AND externally verified; its ACTIVE FACE means
a stable-but-unverified answer EXPERIMENTS to verify (next_action=experiment) and only settles
effectively-false-until-true once all means are exhausted — never a resting abstention. (3) Docs:
the from-scratch whitepaper (SIGMA0-OURO-CODER rewrite), the technical paper, the RC1 model spec,
the design-of-record anytime-budget scope, research-canon from-scratch + modern-design landscape,
and the home trading-chips + model-picker. Experiments: p0_gate_measure, spiral_arc_smoketest,
convergence_world_model, oracle-active-loop records. The serve-path wiring of the grounding verdict
(SIGMA0_GROUNDED default + response surfacing) is deferred to #2883 — it changes the serving default
and requires a measured leaderboard row.
