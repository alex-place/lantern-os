### Certificate §3.1: scheduled grounding from certificate quantities (design note, machine-checked core)

Adds `docs/SIGMA0-COLLAPSE-CERTIFICATE.md` §3.1 — a conservative **design note**, not a new
theorem: inside a certified basin (γ, c, P), the anchor budget needed to escape rises
geometrically at the certified rate and saturates at `B*_inf = sqrt(c/λ_max(P))`, so any bounded
grounding has a computable deadline `n*(B)`. Verified by construction in
`experiments/sigma0_grounding_deadline.py` (exact trust-region max of V(x+a) vs predicted
deadline): normal basin — deadline BITES (predicted 1.6/2.9/6.0 vs measured last-escapes 1/2/5);
non-normal sliver (cond(P)~6e5) — ceiling tiny, no practical bite. Ouro's measured ρ=0.88 +
strong non-normality put it in the sliver regime, retro-dicting the measured anchoring null
(supporting evidence, not validation).

Design shift: grounding becomes a **schedule** (period < half-life ln2/ln(1/ρ), ~5.4 steps for
Ouro — PROJECTION) with the §4 canary demoted from primary trigger to audit — critical slowing
down is detectable only after contraction is deep, exactly when the escape budget has saturated.
Honestly scoped in-section: math is corollary-grade; "early beats late" is independently
published (arXiv:2604.23235); the contribution is the certified composition; prospective test
needs a well-conditioned loop (STARS-trained). PROVEN core (synthetic, V-metric) +
MEASURED inputs + PROJECTION, labeled per claim. `data/sigma0/grounding_deadline_report.json`.
