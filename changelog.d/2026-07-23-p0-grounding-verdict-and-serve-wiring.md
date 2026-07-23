P0 gate-wiring complete: (1) SIGMA0_GROUNDED serving mode (default ON, operator's "best answer,
cost no object" directive) routes ouro_serve.py through the native gated loop so every answer
carries a Σ₀-grounding verdict (x-sigma0-grounding header + response body), and arms the bounded
anti-collapse actuator; (2) sigma0_grounding_verdict() — a two-factor certificate whose load-bearing
invariant (exhaustively tested) is grounded=True IFF the loop is stable (ρ<1 contraction) AND an
external verifier confirmed the answer — never on stability alone (the certificate's #2236 /
Freshness Law position). Verified by a 3-agent math-check workflow: grounding-invariant and
honest-scope SOUND (no false-grounding path, no stability=factuality overclaim); it caught one MAJOR
false-stable bug — assemble_reason_verdict OR-ed the CONTINUOUS proven_contracting gate (max Re λ<0)
into the DISCRETE verdict, so a λ=−2 loop (ρ=2, diverges) was labelled 'contract' → false 'grounded'
at d≤512. Fixed: JSRR (ρ<1−margin) is authoritative, continuous gate is fallback-only; regression-
tested (test_sigma0_grounding_verdict.py). 81 tests green.
