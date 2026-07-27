### Spiral: SWE-shaped focus rotation (#2974) + search/replace edits (#2975)

**Edits (#2975).** One of our 5 graded SWE-bench Lite predictions failed to apply at all —
20% of the run lost to patch *format*, not reasoning. A unified diff asks the model to
reproduce exact surrounding lines and correct `@@` numbers from memory; small models can't,
and the 111-138/164 no-parse counts on HumanEval are the same weakness seen from another
angle. New `lib/spiral-edit.js`: the model emits `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE`
blocks naming a file, we locate the text ourselves, and the diff is rendered from disk by
git afterward — nobody has to get line numbers right.

The exact-match rule is the point: if the SEARCH text is missing or appears twice, **nothing
is written** and the reason comes back as an observation. A patch that lands in the wrong
function is worse than one that doesn't land — it burns the turn and poisons the Fix-Rate
signal for it. Multi-block sets are all-or-nothing for the same reason. Indentation drift is
forgiven (only when the match is still unique, splicing the file's own bytes), paths can't
escape the repo, and a no-op write is skipped so the tree can't look mutated by a turn that
changed nothing.

A tier may now return `{ edit }` alongside `{ action }` and `{ text }`; `env.applyEdits`
mirrors `env.run`'s contract, so the loop treats all three identically.

**Focus (#2974).** New `lib/spiral-swe-focus.js` replaces the MBPP-shaped
`outline/edge-cases/simplify` cycle with `localize → reproduce → patch → regress → reflect`.
Rotation is **state-aware, not a clock**: phase advances on evidence in memory (something
was read; a test was touched; files changed) with a `maxPhaseTurns` anti-wedge, so the loop
can't patch before it has looked or move on from `reproduce` without a reproduction. The
`reproduce` phase is the load-bearing one — our own measurement puts frustration at
phi-hat 0.80 on weak verification vs 0.092 with unit tests, and a reproduction moves
SWE-bench from the first regime to the second.

Honest note on reflection: Live-SWE-agent's +3-5pp comes from reflection folded into the
step prompt, which is what `focusGuidance()` does on every phase. The standalone `reflect`
phase (forced after repeated unproductive turns) is our adaptation and costs a turn — it
should not be reported as reproducing their number.

21 new tests; `test:spiral` now 72 green.
