docs(adr): review-sweep the Proposed ADRs; fix the 0023 number collision + index gaps

- Renumber `0023-sigma0-frontier-training-program.md` → **ADR-0024** (default-profile
  landed first on 0023 by one minute, PR #2147 vs #2158); update all six frontier-side
  references (README index, SIGMA0-FRONTIER-TRAIN-BRIEF, SIGMA0-READING-PACK,
  SIGMA0-MODEL-DESIGN, changelog fragment) — the four in-code `ADR-0023` comments
  (surface-registry, feature-flags, sprawl-tripwire) already meant the default-profile
  ADR and are now unambiguous.
- Add the four missing README index rows: 0018 (Accepted), 0020 (Proposed),
  0022 (Accepted, operator-directed — explicit approval record pending), 0023 (Proposed).
- ADR-0024 gains template frontmatter (`approved-by: pending`), loop stage, an explicit
  reconciliation section with Accepted ADR-0010/0011 (it reopens 0011's rejected
  from-scratch alternative under the operator's 2026-07-06 directive), Alternatives, and
  an Evidence table.
- ADR-0020 reconciled with Accepted ADR-0022 (OAuth 1.0a is the connection model of
  record; Bearer is legacy fallback), paper-account prefixes corrected to DU/DI/DF,
  reversibility claim narrowed, Alternatives + Evidence sections added.
- ADR-0023 (default profile): corrected the false "CI re-runs the contract test" claim
  (nothing in CI runs surface-boundary.test.js — follow-up added to wire it), noted the
  systems.html loop-stage meta drift, precise header/footer nav history, Alternatives +
  Evidence sections, H1 added.

All three reviewed ADRs remain **Status: Proposed** — approval is Alex's alone.
Review evidence: 7-agent verification sweep (34/28/22 claims checked per ADR;
high-severity findings adversarially confirmed before edit).
