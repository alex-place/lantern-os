# The Grounding Deadline: a scheduling consequence of the collapse certificate

**Date:** 2026-07-05 · **Evidence class:** PROVEN core (synthetic, V-metric) + MEASURED inputs +
PROJECTION (Ouro) · **Loop stage:** Verify/Converge
**Artifacts:** `experiments/sigma0_grounding_deadline.py`,
`data/sigma0/grounding_deadline_report.json`, certificate §3.1

## Question

Can the certificate's own objects (γ, c, P) + grounding + math produce a *new answer to
collapse* — not another detector? Run postulate → kill-search → derive → machine-check.

## Kill-search first (what was already taken)

- "Early intervention beats late; models commit" — published, with per-token commitment counts
  (arXiv:2604.23235). Not ours.
- Contraction metrics determine basins; bounded-disturbance divergence bounded by rate and
  condition number — classical control (e.g. contraction-metric literature). Not ours.
- **Not found:** a *certified deadline formula* for grounding computed from a collapse
  certificate's own quantities, with a conditioning condition for when it binds. That
  composition survived the search.

## The result (stated at its honest size)

Inside a certified basin `{V ≤ c}` with `V∘F ≤ γV`: escape with anchor budget B requires
`B > B*(n) = (√c − γ^{n/2}√V₀)/√λ_max(P)` — rises geometrically at the certified rate,
saturates at `B*_∞ = √(c/λ_max(P))`. Any `B < B*_∞` has a computable deadline `n*(B)`.
**Math: corollary-grade** (P-norm triangle inequality + geometric decay) — the value is the
composition and the design consequence, not the mathematics.

Machine-checked by construction (exact trust-region max of `V(x+a)`, not our own bound):

| regime | prediction | measurement |
|---|---|---|
| normal basin (cond 1.8) | deadlines 1.6 / 2.9 / 6.0 | last escapes 1 / 2 / 5 — bites, conservative |
| sliver (cond 6·10⁵) | ceiling B*_∞ ≈ 0.002 → no practical bite | escapes at every depth |
| Ouro (ρ=0.88 measured, strongly non-normal) | sliver regime → weak deadline | **retro-dicts** the measured anchoring null |

## Design consequences (the actionable part)

1. **Grounding is a schedule, not only an event** — period below the commitment half-life
   `ln2/ln(1/ρ)` (~5.4 steps at Ouro's measured rate; PROJECTION).
2. **Canary demoted to audit** — critical slowing down is detectable only after deep
   contraction, exactly when the escape budget has saturated; canary-triggered Σ₀⁻¹ fires at
   the expensive end of the window in well-conditioned basins. Consistent with (not proven by)
   the measured rank≠route split: early-curve logprob routed +, late-curve canary routed −.
3. **cond(P) decides the regime** — hard deadline (well-conditioned) vs soft (sliver); cheap to
   measure alongside any certified rate.

## Honest limits

Additive-anchor model of grounding (real grounding enters as tokens via attention); the Ouro
story is a retrodiction of our own null, not a prospective test; a prospective test needs a
well-conditioned loop (e.g. STARS-trained, arXiv:2605.26733) where the deadline should bite.
Landed as a certificate **design note** (§3.1), deliberately not a theorem-style section.
