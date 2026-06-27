### Fix: drop over-broad "now"/"today"/"current" from Convergence Oracle keymap (#1275)

#1268 already stopped the Convergence Oracle from grounding every chat prompt —
`formatGrounding()` returns `""` for a question that isn't anchored in cosmic time
(`sliceFor → null`). This closes the residual #1275 gap: the NOW band keymap still
carried the bare words `now`/`today`/`current`, which are not cosmology anchors and
false-matched everyday requests — "fix this bug now", "my schedule today", "the current
module" each matched the NOW band and got a dark-energy/heat-death "KNOWN facts… cite as
evidence" block prepended.

- Removed `now`/`today`/`current` from the NOW band in `lib/convergence-oracle.js`. Real
  anchors (`how old`, `age of the universe`, `dark energy`, `dark matter`) still ground;
  "how old is the universe right now?" still matches via `how old`.
- Mirrored in the Python port `src/convergence/oracle.py` to keep the keymaps in sync
  (behaviorally inert there — un-anchored questions still fall back to NOW).
- Test: `apps/lantern-garage/test/convergence-oracle.test.js` (3 cases) pins that anchored
  cosmology questions still ground, un-anchored everyday requests ground to `""`, and the
  bare common words no longer false-trigger. Python `tests/test_convergence_oracle.py`
  still passes.

Loop stage: **Reason / Verify** — grounding must attach evidence only to questions it
actually applies to.
