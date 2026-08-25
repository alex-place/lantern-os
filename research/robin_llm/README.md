# Robin, rebuilt for LLM design

A working reimplementation of the Robin pipeline (FutureHouse, arXiv:2505.13400,
`github.com/Future-House/robin`) with the scientific domain swapped from drug repurposing to
**design changes to our own reasoning/language stack**, plus the three checks Robin does not run.

```
goal
 ├─ literature          BM25 over the local arXiv corpus + an LLM summary      (Crow)
 ├─ assay selection     choose from executable experiments only                (their assay ranking)
 ├─ BASELINE            run the chosen assay NOW, on this machine              (new)
 ├─ candidates          propose (assay, knob, value) design changes
 │    └─ admission      a proposal that cannot be executed is UNRUNNABLE       (new)
 ├─ deep reports        one sceptical review per candidate, cited              (Falcon)
 ├─ sham arm            an inert candidate is added, in disguise               (new)
 ├─ ranking             pairwise LLM judge -> Bradley-Terry-Luce               (their method, kept)
 ├─ run top N           actually execute them                                  (Finch)
 └─ interpret           what is ruled out, what to test next
```

Run it:

```bash
node research/robin_llm/run_robin_llm.js --list
```

```bash
node research/robin_llm/run_robin_llm.js "your goal" --dry
```

```bash
node research/robin_llm/run_robin_llm.js "make the controller pick the true cause over a cheaper proxy more often" --assay controller-two-explanations --candidates 5 --top 2
```

`--dry` runs the whole graph against a scripted stub model — including really executing the
assay — so the wiring can be checked for free. `--list` prints the assay registry.

## What is the same as Robin

- **Deterministic stage graph.** Robin's own Methods note that their agent "almost always called
  tools in the same order", so they rewrote it as a fixed notebook. This is fixed from the start.
- **Pairwise judging with BTL.** Scoring N proposals on a 1–10 scale gives numbers that are not
  comparable across calls. Robin measured 88% intra-rater consistency on repeated identical pairs
  (versus 61% for human experts) by asking for one binary preference at a time.
  [`btl.js`](btl.js) implements the Bradley–Terry–Luce fixed point (Hunter 2004) and Robin's
  schedule: round robin up to 25 items, 300 sampled pairs above that.
- **Literature-grounded generation.** Retrieval first, then propose.
- **Analyse and feed forward.** The interpretation stage names the next experiment.

## What is different, and why

**1. Provider-agnostic.** Robin pins o4-mini and Claude 3.7 Sonnet. This calls
`lib/verify-llm.js`, which already has a fallback chain, because in this repo models are
replaceable by rule.

**2. A proposal is only a hypothesis if it can be run.** Robin proposes a drug and a human
pipettes it. We have no pipette. [`assays.js`](assays.js) declares the experiments that actually
exist here and the knobs each one exposes; a candidate must name `(assay, knob, value)` inside a
declared range or it is recorded as `unrunnable` with the reason. Robin hit the same wall — they
substituted pHrodo beads for photoreceptor outer segments "due to availability" — the difference
is that here the substitution is machine-checked rather than a footnote.

**3. A sham arm.** An inert candidate ("re-order the list alphabetically") is added before
ranking, in disguise. If the judge ranks it in the top half, the ranking is measuring
plausibility rather than merit and the run says `RANKING NOT TRUSTED`. This works: with the stub
judge (a coin flip) the sham ranked **1 of 5** and the run refused its own result; with a real
provider it ranked **6 of 6**.

**4. Every assay carries its own null control.** A candidate that improves the headline number
while breaking the control is reported as `REGRESSION (control broken)`, never as a discovery.
Nothing in the Robin paper asks what the pipeline proposes when there is no mechanism to find.

**5. A noise floor computed from the run's own counts.** The first live round reported
`IMPROVED  0.984 vs baseline 0.983` — a delta of +0.001 on a proportion whose two-standard-error
band is ±0.021. That is the pipeline manufacturing a discovery out of seed variation, and it is
exactly the failure everything above exists to prevent. Each assay now derives a band from its
own n, and a delta inside it is reported `WITHIN NOISE`. Robin has no equivalent — their
comparisons are eyeballed against a DMSO control with a Dunnett test done by hand.

## The assays

| assay | measures | null control | ~time |
|---|---|---|---|
| `controller-discovery` | validated regularities per unit of experiment | null world yields zero discoveries | 200s |
| `controller-two-explanations` | truth chosen over a cheaper proxy that fits equally | H4: original world does not regress | 120s |
| `controller-self-diagnosis` | experiments per discovery when the machine may repair its own policy | S3: does not fire in either control world | 600s |
| `humaneval-chat` | pass@1 through the real chat surface | **none** — stated in the report | 900s |

The knobs are real: `controller.py` reads `EC_WINDOW`, `EC_MSE_K`, `EC_ALPHA`, `EC_HOLD`,
`EC_BUDGET`, `EC_RETRACT_BELOW`, `EC_COST_EXPONENT`, `EC_HOLD_STEPS`, so the outer loop can move
the machine's design parameters without editing the file under test. A test asserts that every
declared knob reaches either argv or the environment, so the registry cannot drift into
advertising a dial that is not connected to anything.

## Honest limits

- **Three of the four assays measure a deterministic controller, not a language model.** They are
  a stand-in with a known ground truth, which is what makes the controls possible. `humaneval-chat`
  is the only one that measures an actual model, and it is the one with no null control.
- **The design space is knob values.** It cannot propose a new mechanism, only move a dial the
  harness already exposes. Structural changes (a different auditor, a new state) are outside what
  this loop can test today.
- **One judge, one vote per pair.** Robin runs 10 analysis trajectories and takes consensus. This
  does not yet; repeated judging per pair is a config away but was not measured.
- **No multiple-comparison correction.** With enough candidates, something clears a 2-SE band by
  chance. The band stops the worst of it; it is not a family-wise error rate.

## Files

| file | what |
|---|---|
| [`btl.js`](btl.js) | Bradley–Terry–Luce fit, pair schedule, seeded sampling |
| [`assays.js`](assays.js) | the executable experiments, their knobs, metrics, controls, noise bands |
| [`agents.js`](agents.js) | crow / falcon / judge / finch |
| [`pipeline.js`](pipeline.js) | the stage graph and the verdict rule |
| [`run_robin_llm.js`](run_robin_llm.js) | CLI, `--dry`, `--list` |
| `../../apps/lantern-garage/test/robin-llm.test.js` | 13 tests, no network |
