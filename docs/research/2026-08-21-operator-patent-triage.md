# Operator patent & novelty triage — recorded, cross-checked, not ratified

**Date:** 2026-08-21. **Provenance:** supplied by Alex (operator) from an external search session,
verbatim conclusions summarised below. **Status under the novelty-verification protocol
(docs/research/2026-07-23):** recorded as evidence, NOT ratified — the protocol's traps apply to
this document exactly as to our own passes, and two of our own "novel" calls died on one query
each the day before. Indexed here so `priorwork.js` feeds it to every future audit.

## The operator's verdict table (condensed)

| Cluster | Density | Verdict |
|---|---|---|
| Spectral/Jacobian stability (JSRR, ρ gates) | High | not novel |
| Test-time verification / verifiers / pass@k | Very high | not novel |
| Cascades / cost routers (FrugalGPT lineage) | High | not novel |
| Ternary / sparse encodings | Med–High | generic forms not novel |
| Capability honesty / agent hold | Medium | related art exists |
| **Certificate-as-runtime-contract + scheduled grounding** | Low | strongest remaining system claim |
| **Held-out "solved" rule + precision-of-claimed-solve** | Low as product law | moderate–strong |
| **CSF-specific operators** (search-without-decompress, convergence-merge, 3¹² delta) | Low exact match | moderate if format distinctive |
| Dream Journal mechanics (3-Door, anchors, lineage) | Low exact match | product differentiation |

Recommended handling per the operator's table: do-not-claim (JSRR, LoopLM, pass@k, cascades,
generic ternary); trade secret / system IP (certificate-as-contract, deadline grounding, held-out
solved rule, precision-of-claimed-solve); concrete format protection worth considering (CSF wire
format + operators); branding-not-patents (Dream Journal mechanics).

## What our own machinery corroborates

- **JSRR "not novel":** matches the standing decision "ADOPT JSRR, don't republish" — Σ₀ core
  externally published (LoopLM).
- **Cascades "not novel":** matches ADR-0030's own framing (verified cascade as harness, not
  invention) and the FrugalGPT lineage in the corpus.
- **Verification "very high density":** matches every mill run — 30+ ideas, all verification-
  adjacent ones placed instantly.
- **"System-level, not architectures" as the residue:** matches the mill's structural finding —
  every unencumbered survivor leaned on an asset (ledger, settled markets, instrumented
  controller), never on a technique.

## What is NOT yet checked to our own standard

- The "Low density" cells are the dangerous ones — they are the same inference (search silence)
  that killed our own novelty calls twice. Each surviving cluster needs the full protocol:
  claim-style decomposition, per-atom prior-art table, **other-vocabulary search** (classical
  scheduling/contract-algorithm literature is exactly where "grounding deadline" ancestors would
  hide), patent-leg search, adversarial refutation, THEN attorney review.
- Our mill's one surviving family — **market-outcome supervision of internal confidence signals**
  — is not in the operator's table at all; it came from the assets list, and it is currently the
  only *measurement-level* candidate alongside the operator's #19/#20 (verified-skill-per-
  sample-per-watt).
- Nothing here is legal advice; the protocol's final gate (expert examiner / attorney) is
  unchanged.

## Standing next actions derived from both triages

1. Register the free **EPO OPS key** (operator-only) — unlocks the real patent corpus harvest;
   until then the patent leg is the undocumented Google endpoint.
2. Run the full protocol on the top three survivors: certificate-as-runtime-contract,
   held-out-solved-as-law, CSF operators. Treat as trade secret meanwhile (their value does not
   require filing).
3. The bounded-day probe experiment (PREREG-market-supervised-probe.md) — P0 gate decides on the
   backfilled prices.
4. Prospective price logging in `kalshi-collector` (one JSONL append in a loop that already
   runs) — builds the horizon dataset nothing public can reconstruct.
