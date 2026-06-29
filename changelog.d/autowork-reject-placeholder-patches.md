### autowork: reject placeholder / non-implementation patches (#1354)

An autowork run with no real spec (from the junk "autowork the oldest issue"
meta-command) generated a brand-new file that was pure scaffolding — `// Placeholder
for the actual dispatch logic`, "simulate async work" (`setTimeout`), "in a real
scenario this would fetch…", console.logs. It applied cleanly (passed the anti-fraud
"≥1 file changed, 0 hunk errors" gate) and only got caught because the planned tests
happened to fail. A placeholder that *passed* tests would have opened a bad PR.

- `self-edit-engine.js`: new `looksLikePlaceholderPatch(diffText)` — trips only on ≥2
  distinct STRONG non-implementation markers among ADDED lines (markers that never
  appear in a real fix; lone "TODO"/"FIXME" deliberately excluded to avoid false
  positives).
- `autonomous-work` + `autonomous-work/stream`: the patch accept-gate now rejects a
  placeholder patch, rolls it back, and feeds the signal into the existing retry loop
  ("implement the actual logic — no stubs"), failing cleanly if still placeholder
  after MAX_PATCH_ATTEMPTS.
- Tests: positive case built from the actual hallucinated diff + false-positive guards
  (single stray marker, genuine impl, context-only markers) in
  `tests/test_self_edit_engine.js`.

_Loop stage: Verify (a patch must be a real implementation, caught regardless of
whether tests happen to fail)._
