# Pre-registration: does fresh verification stop a recursive improver from corrupting itself?

Written 2026-11-05, before any paid run. Only the offline tests (fake model) had run at
this point. A paid engineering pilot follows. Its data are excluded from the analysis.
Any change made after the pilot is listed in §9 with its reason.

## 1. Question

Published recursive improvers edit their own improvement process. Over many generations,
does fresh, independent verification stop such an improver from corrupting that process?
Corruption shows as the score changes are accepted on drifting away from fresh held-out
performance. It also shows as later versions of the improver producing worse descendants.

## 2. What is already known, and what is not

| System | Improver edits itself? | How changes are accepted | Tests long-run corruption? |
|---|---|---|---|
| AlphaEvolve (arXiv:2506.13131) | Prompts co-evolve | Fixed, human-written evaluators | No |
| MetaSkill-Evolve (arXiv:2607.05297) | Five-agent slow loop, every H=2 | Meta-updates unconditional. Child kept if ΔU > 0 on a validation batch | No (5–24 iterations) |
| Darwin Gödel Machine, SICA (2025) | Agent code | Benchmark scores | No |
| HyperAgents (arXiv:2603.19461) | Meta agent editable | Not found in the abstract | Not found |
| SGM (arXiv:2510.10232) | Model, training procedure or task code | E-value certificate on confirmation draws, with a cumulative bound on harmful accepts | No. It disclaims long-horizon calibration |

Sources: MetaSkill-Evolve and Yang were read from the arXiv HTML on 2026-11-05. SGM and
HyperAgents were read from their arXiv abstract pages; SGM also from its v2 HTML, which
was truncated. HyperAgents' HTML returned 404.

## 3. Prediction

The prediction comes from the toy in lantern-os-research,
`experiments/rsi_gated_vs_ungrounded.py`, and its report `data/sigma0/rsi_gated_report.json`:

- In that toy, ungrounded self-review crashed in 52.5% of runs.
- A reused filter slowed collapse but did not stop it: its precision fell from 0.87 to 0.70.
- A fresh gate held its precision, at 0.93 then 0.95.

The Σ_θ freshness law (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md` §8.4–§8.4.1) predicts the same
direction: selection on a reused set ratchets onto its noise, and only re-drawn truth
breaks the ratchet.

Prediction for this run:

- **P1.** Arms 1 and 2 show a growing gap, over generations, between the score their
  champion was accepted on and its fresh held-out performance.
- **P2.** Arm 3 does not.
- **P3.** In later generations, arm 3's improver produces better successors per unit of
  compute than arm 2's.

**Kill condition.** If arm 2 matches arm 3 on fresh held-out performance *and* on
successor quality per unit of compute over the full run, the governance design adds
nothing at this scale. That will be reported plainly.

## 4. Domain

Online bin packing with a priority function, as in FunSearch (Nature 2024). Its shape is
that of AlphaEvolve's data-centre scheduling heuristic.

- **Instances.** Each instance is generated from a (stream, index) pair. The item family
  is one of Weibull, uniform or bimodal, with parameters drawn per instance. Each instance
  has 120–360 items and bin capacity 100. A fresh instance costs microseconds.
- **Score.** Bins saved against best fit on the same instance, in percent of the L1 lower
  bound ceil(Σ items / 100). The unit is "pp". Higher is better, and best fit scores
  exactly 0. Because every score is paired with best fit, a score on any instance set
  estimates the same quantity.
- **Exact and unforgeable.** A sandboxed worker runs the candidate and returns its bin
  assignment. The trusted parent checks the packing (capacity, online order) and counts
  the bins.
- **Final holdout.** 240 instances of stream `holdout`. No run process may generate this
  stream: `binpack.FORBIDDEN_STREAMS` raises if one tries. The holdout is scored only
  after the runs.

## 5. Arms, at equal compute

All arms are built on **OpenEvolve v0.4.0** (Apache-2.0, pinned with openai 3.20.0, both
released 2026-09-28). They reuse its island/MAP-Elites `ProgramDatabase`, its
`PromptSampler` and diff template, its SEARCH/REPLACE diff application and its
`OpenAILLM` client. One in-process driver replaces `process_parallel.py`, so the three
arms share one code path.

- Seed program: best fit.
- Model: gpt-4o-mini, at temperature 0.7 unless the improver sets one.
- Every proposal prompt ends with the same request for a `PREDICTED_DELTA`, in every arm.
  Only arm 3 acts on it.

**Arm 1 — AlphaEvolve-style.**

- OpenEvolve semantics: every valid child enters the database.
- Children are scored on a reused validation set of 16 instances, `val<seed>`.
- Instruction texts co-evolve in a prompt database. Each text is scored by its children's
  mean improvement over their parents on that same set, and chosen by UCB.
- One LLM call per generation writes a new instruction variant.
- OpenEvolve declares `use_meta_prompting` but leaves it unimplemented, so this part is
  built here, following AlphaEvolve §2.
- Per generation: 23 proposals plus 1 mutation call, 24 calls in all.

**Arm 2 — MetaSkill-Evolve-style recursive baseline.**

- The improver is m = (ψ analysis, σ retrieval, α allocation, π proposer, ε editor).
  Each component is a text, plus the numbers that component controls.
- Fast loop: the allocator's budget sets K = 1–3 children per parent step. It widens
  after a step with no kept child.
- A child is kept only if it beats its parent on the same reused validation set (ΔU > 0).
- Slow loop, every generation (H = 20 children): the improver edits itself. Four calls
  run: Analyzer (ψ), Allocator (α), Proposer (π) and Evolver (ε). Retrieval is a lookup.
  Each agent is instructed by the improver's own component.
- The edit is applied unconditionally, as in the paper.
- Per generation: 20 proposals plus 4 meta calls, 24 calls in all.

**Arm 3 — ours.** Arm 2 plus three additions.

1. **Fresh gate on every promotion.**
   - Child and parent are scored on 16 instances drawn fresh for that decision.
   - The child is accepted if the mean paired gain is above 0 and the paired t ≥ 1.0.
     It must also pass a retention veto: no mean regression worse than 0.5 pp on 16
     retired instances.
   - Used instances retire to a burned pool.
   - A program's believed score is its mean over every instance it was scored on while
     that instance was fresh.
2. **Fresh gate on every improver change.**
   - The slow loop's edit becomes a candidate. During the next generation, parent steps
     alternate between the incumbent and the candidate, so each gets equal budget.
   - All of that generation's children are re-scored against their parents on 24
     instances drawn fresh for the decision. A proposal's value is
     max(0, child − parent), and an invalid proposal counts 0.
   - The candidate is adopted if its mean value is higher and Welch t ≥ 1.0. Otherwise it
     is discarded. This is Yang §13.2's descendant test, used as the gate.
3. **Prediction error shrinks the budget (Yang §5.6).** Yang gives no formula, so this
   rule is the experiment's own.
   - Skill = 1 − Σ|pred − actual| / Σ|actual − median(actual)|, over the last 30 scored
     children, with a missing prediction counted as 0.
   - The cap on children per parent is 1 if skill < 0.25, 2 if skill < 0.75, and 3
     otherwise. There is no cap before 10 children have been scored.
   - The improver cannot raise this cap.

The gate, its thresholds (a frozen dataclass), the task issuer, the burned ledger and
the logs are harness objects. The improver's genome is prompt text and clipped numbers,
so it cannot reach them. No arm can write its evaluator. That holds by construction for
all three arms, as it does in the published systems.

**Equal compute** means equal LLM calls per generation: 24 for every arm. Token totals
are reported. Extra *verification* compute (sandbox CPU) is not equalized, because
verification throughput is the variable under test. It is reported as instance
evaluations per hour.

**Planned scale** (§9 records the final numbers once the budget is approved):

- 30 generations per run: 600–690 proposals and 720 LLM calls.
- 5 seeds per arm. Seed s gives arms 1 and 2 the same validation set and gives arm 3 its
  own fresh stream.
- MetaSkill-Evolve ran 5–24 iterations with 2–3 meta-updates. This is 25–140× longer,
  with 30 improver updates.

## 6. Measures and analysis

Seeds are the units. Intervals are 95% t-intervals over seeds. Tests are one-sided at
α = 0.05: Welch's t-test between arms, or a one-sample t-test.

Per generation g, per run:

- **Fitness on fresh tasks:** the champion's holdout score. The champion is the program
  the arm believes best.
- **Gap:** the champion's believed score minus its holdout score. The believed score is
  the score it was accepted on: the validation set for arms 1 and 2, the fresh estimate
  for arm 3.
- **Acceptance precision:** the fraction of accepted children whose holdout score beats
  their parent's. The harm rate is also reported. A fixed 15% hash-sample of rejected
  valid children is scored too.
- **Prediction error:** mean |PREDICTED_DELTA − measured change|, against the arm's own
  measure and against the holdout.
- **Successor test** (Yang §13.2), at g ∈ {5, 10, 15, 20, 25, 30}, run from snapshots
  outside every budget:
  - *own:* the arm's 8 believed-best programs each get one proposal from v_g, from
    v_{g−1}, and from v_0.
  - *ref:* 8 fixed reference parents, shared by all arms and seeds, each get one proposal
    from v_g. v_0 is run on them once per run.
  - Quality Q = mean over proposals of max(0, holdout(child) − holdout(parent)). An
    invalid proposal counts 0. Q is reported per 1k tokens.
- **Throughput and cost:** instance evaluations and fresh tasks consumed per hour, and
  tokens and USD at list price.

Summaries per run:

- final holdout;
- mean holdout over generations (AUC);
- gap slope (OLS of gap on g);
- early gap (g ≤ 10) and late gap (g ≥ 21);
- precision early and late;
- ref successor quality per 1k tokens: late (g ≥ 15) and over all test generations;
- corruption index: mean over test generations of Q_own(v_g) − Q_own(v_0).

**Tests.**

- **H1** (P1), arms 1 and 2 separately: mean gap slope > 0 (one-sample t, p < 0.05) *and*
  the late gap is above the early gap.
- **H2** (P2): arm 3's slope is not significantly > 0 (p ≥ 0.05) *and* arm 2's slope is
  above arm 3's (Welch, p < 0.05).
- **H3** (P3): arm 3's late ref successor quality per 1k tokens is above arm 2's (Welch,
  p < 0.05).
- **Kill:**
  - The measures are (a) holdout AUC and (b) ref successor quality per 1k tokens over all
    test generations.
  - Each measure is "matched" if arm 3 − arm 2 is not significantly > 0 *and* its point
    estimate is below the smallest effect of interest: 0.10 pp for (a), 20% of arm 2's
    mean for (b).
  - If the difference is not significant but the point estimate reaches that effect, the
    measure is "inconclusive at this sample size".
  - The kill fires only if both measures are matched.

Arm 1 is a reference point. The kill condition compares arms 2 and 3 because they share
both loops.

## 7. What this cannot show

- The result covers one problem family, one model (gpt-4o-mini) and validation and gate
  sets of 16 instances. The freshness penalty is n-graded (§8.4): a much larger reused
  set would shrink arms 1–2's gap. The result is a statement about this regime.
- The gate is a per-decision t threshold. It has no cumulative error budget, unlike SGM.
  A false promotion can happen at roughly the t ≥ 1.0 tail rate.
- MetaSkill-Evolve is reimplemented here from its paper, because no code is released.
  The simplifications are listed in §8.
- 5 seeds per arm gives limited power. "Inconclusive" is a possible and reportable outcome.

## 8. Deviations from the published systems, stated up front

- **OpenEvolve prompt co-evolution:** not in v0.4.0, so it is built here (arm 1).
- **MetaSkill-Evolve fast loop:** its agents run as separate calls per child. Here they
  are folded into the improver-assembled prompt of one proposal call, keeping arm 1's one
  call per child.
- **MetaSkill-Evolve slow loop:** it rewrites all five files with K_m meta-children. Here
  it edits one target component per round, with K_m = 1. The loop runs every 20 children
  rather than every 2 fast iterations, so that the generations are meaningful at this
  scale.
- **Yang §5.6 and §13.2:** neither section gives a formula. The rules above are this
  experiment's, fixed before the run.
- **Σ_θ conditions 3 and 4** (§8.1.2) have no separate content here. There is no proxy
  reward apart from the fresh score, and no weights to drift.

## 9. Amendments after the pilots

All of these were made on 2026-11-06, before the main run.

**A1. Instance family, for feasibility.**

- **What happened.** Pilot 1 ran on the family in §4: seed 100, 3 generations per arm,
  216 calls, $0.087.
  - Arms 2 and 3 kept 0 of 120 children. 58 of them packed exactly as their parent did.
  - A check on 300 instances found no tested heuristic better than best fit on that
    family. FunSearch's published OR heuristic scored −0.32 ± 0.13 pp.
  - With nothing accepted there is nothing to corrupt, so the test would have been empty.
- **Change.** The family is replaced by the OR-Library binpack recipe that FunSearch
  evaluated on:
  - capacity 150;
  - integer item sizes uniform on [lo, hi], with lo ∈ [15, 25] and hi ∈ [90, 110] drawn
    per instance;
  - 120–500 items in three size bands: small 120–240, medium 241–360, large 361–500.
    These bands are now the "families" in the feedback.
- **Evidence the new family is sound.**
  - The packer reproduces FunSearch's numbers on OR4-sized instances: first fit 5.18% and
    best fit 4.94% excess, against the paper's 5.23% and 4.94%.
  - FunSearch's heuristic saves 0.88 ± 0.10 pp over best fit on the new family, so there
    is headroom.
  - A strong heuristic's score has a per-instance SD of 0.85 pp, so a 16-instance set has
    a standard error of about 0.21 pp.
- No hypothesis measure (gap, precision, successor) had been computed when this was
  decided.

**A2. Execution, for memory.**

- The 12 GB PC had 0.5 GB of memory available.
- All runs therefore execute as coroutines in one process, sharing four sandbox workers
  (`rsi_oe/multi.py`).
- Each run restores its own Python `random` state after every await, so OpenEvolve's
  global-random sampling stays per run.
- No arm's logic changes.

**A3. Scale.** Alex approved the 5-seed plan on 2026-11-06, at an estimated $7–8.

- 5 seeds (0–4) × 3 arms × 30 generations.
- 720 LLM calls per run.
- Successor tests at g ∈ {5, 10, 15, 20, 25, 30}.
- The pilots ran on seeds 100 and 101. None of their data enter the analysis.

**A4. Deterministic ids, for reproducibility.**

- Program ids, improver versions and prompt-variant ids are now derived from (arm, seed,
  iteration or generation) instead of `uuid4`.
- OpenEvolve samples parents from Python sets of ids, so random ids made the parent
  choice depend on the ids themselves.
- A test confirms that runs sharing one process now produce exactly the logs they produce
  alone.
- No arm's logic changes.
