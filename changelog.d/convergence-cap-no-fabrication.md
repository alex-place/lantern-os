### Convergence grade card: stop fabricating the CAP score (#2093)

The Capability (CAP) axis of the grade card's `grade()` (in `src/convergence_io_engine.py`)
wrote a **hardcoded** `{"passed_tests": 10, "total_tests": 10, "score": 1.0}` report and fed
that 1.0 straight into the overall grade — a fabricated number with no evidence, while the
OH and SCOPE axes were genuinely measured. That violates the External Reality Rule (a claim
only counts with [evidence, source]).

Now the CAP check **actually runs the real benchmark** (`node tests/gaming-layout-suite/run.js`)
and parses its `Gameplay centred: <passed>/<total>` result into a real `cap_score`. When the
benchmark has nothing scorable (the copyrighted reference clips are intentionally unbundled, so
a bare checkout legitimately can't measure) or it errors, `cap_score` stays **`None`
("not measured")** — never faked to 1.0 nor misleadingly zeroed. The overall average now
excludes unmeasured axes (`axes_measured` is recorded) instead of counting a phantom score.

Verified: the parse/fail-closed logic run against the real `run.js` yields `None` on a
no-clips checkout; the average excludes `None` while still counting a genuine measured `0.0`;
existing `tests/test_convergence_io_engine.py` still passes (18).

Note: `grade()` currently lives on a `TesseractEngine` class that is shadowed by a second
same-named class later in the module, so it is presently unreachable — filed as a separate
follow-up (duplicate-class shadowing, same anti-pattern `objects.py` already fixed). Loop
stage: **Verify**.
