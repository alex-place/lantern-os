### Added
- **Σ₀ collapse canary on the live chat serving path** (#1010). A dependency-free
  text canary (`lib/collapse-canary.js`) scores each completed reply for
  loop-collapse / phrase-echo / lexical-contraction into a single `sigma0_proximity`,
  stamped onto every reply's done signature. On a crossing it emits a logged
  `canary_collapse` signal with an advisory action — a passive observer wired into
  the single `sendDone` chokepoint, so the certificate can no longer read "healthy"
  while output is in loop-collapse. Zero behavior change when healthy.
- **Mandatory periodic external-grounding tick** (#1012) — the boiling-frog defense.
  `grounding-policy.js` gains a hard time cadence (`isGroundingDue`, configurable via
  `GROUNDING_TICK_MS`, default 30 min); the chat loop now re-touches external reality
  on a timer even when collapse-proximity ~0 and the message wouldn't otherwise
  trigger grounding. Internal monitors are provably blind to slow drift.

### Changed
- **Chat convergence records now use outcome-graded calibrated confidence** (#1011),
  retiring the frozen 0.7/0.3 heuristic. When ≥3 graded groundings exist for a
  provider key, the record's confidence is the calibrated Beta-posterior trust
  (`grounding-calibration`); otherwise it falls back to the heuristic, explicitly
  labeled as ungraded in `verification_notes`. Grade the outcome, never the
  self-assessment.
