P0 gate-wiring: the JSRR ρ<1 acceptance gate now runs on the EXACT low-rank reduction of the
empirical loop Jacobian (src/sigma0/loop_lm.py). The (d,d)=(2048,2048) Jacobian is a mean of T
token-transitions → rank ≤ T-1, so ρ (the sole driver of the accept verdict) is computed exactly
from the (T-1,T-1) Gram VᵀU (same nonzero spectrum) — ~570× cheaper, machine-precision match,
turning a ~7s/generation eigvals into sub-ms. Also: the full Jacobian is now built via matmul
(not the old (T-1,d,d) broadcast — a latent ~2GB OOM at d=2048), the expensive geometry-dependent
continuous diagnostics are capped at d≤512 (they were diagnostic/fallback only), and long
generations are windowed to the most-recent 256 transitions (a deliberate recency + cost bound —
NOT verdict-preserving for T>257; the reduction is). Backward-compatible signature; 58 existing
gate tests pass + 4 new (tests/test_sigma0_jsrr_reduction.py). Adversarially reviewed (2 agents:
reduction math sound, no downstream consumer broken). Ready-to-wire; serve-path integration
(ouro_serve default mode) + Σ₀⁻¹ arming are the next P0 slices.
