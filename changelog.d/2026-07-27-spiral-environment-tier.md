### Spiral: action-shaped tiers + repo sandbox (#2973)

The Phase-0 spiral could only take a whole-answer proposal per turn — right for MBPP/TACO,
wrong for a real repository, where it degenerates to blind single-shot patching (the
configuration that measured **0/5 resolved** on SWE-bench Lite, #2246).

A tier may now return `{ action }` — one bash command — instead of `{ text }`. The new
`lib/spiral-env.js` runs it in the instance checkout, bounded by a timeout, with output
middle-elided so one `cat` can't eat the cheap tier's context, and reports whether the
working tree changed.

That mutation bit is what makes exploration affordable: `ls`/`grep`/`cat` change nothing, so
they commit to memory, cost no verifier run, never de-ratchet and never buy a frontier call
— only a **mutating** action is a step that faces the Fix-Rate verifier. Exploration is
bounded by `observeLimit` (new halt reason `observation-limit`). Mutation is measured from
git, not guessed from the command string, so a write via a python heredoc still counts.

`escalationRate` — ADR-0030's one governing number — now divides step-escalations by step
turns, so a chatty explorer can't fake it downward and an exploring frontier call can't push
it above 1. Total billed frontier calls stay on `escalations`; `stepEscalations` is new.

The whole control loop is unchanged (stop-on-stall, loop detection, duplicate rejection,
bidirectional tiering, the ratchet, honest-can't), and the answer-shaped contract the 204-row
VTD corpus was built on is pinned by test. 14 new tests, existing spiral suites green;
`test:spiral` now also runs the stall-tiering and env suites.

Follow-ups tracked: #2974 (SWE-shaped focus rotation + reflection), #2975 (search/replace
edits), #2976 (PASS_TO_PASS bisection), #2977 (memory cap + retrieval), #2978 (width).
