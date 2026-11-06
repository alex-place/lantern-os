# The Question Machine — bidirectional consolidation of the convergence loop

**Status: BUILT + TESTED (2026-06-25); MEASURED 2026-11-06.** §8 tests whether it can investigate
from a deliberately wrong prior: it notices the contradiction but does not choose the deciding
experiment. §9 is its first external number, on 20 Questions, where it shows no measured difference
from a freely prompted model at n = 30. Core in [`src/cio_sde/question.py`](../../src/cio_sde/question.py);
5 machine-checked tests in [`tests/test_question_machine.py`](../../tests/test_question_machine.py);
runnable demo [`experiments/question_machine_demo.py`](https://github.com/alex-place/lantern-os-research/blob/master/experiments/question_machine_demo.py).
This is the math core (the bidirectional loop + the CAP/NAP seam-arbiter), **not** the
full product — the external Act-stage channels it would ask *through* are still the open
gap (see §7). Companion to the [Collapse Certificate](../SIGMA0-COLLAPSE-CERTIFICATE.md)
and Theorem C3.

---

## 1. The idea, in one line

Deep Thought computed the **Answer** (42). The machine it then built — the Earth — was a
**question-finder**. A system that only runs forward converges on an answer and, ungrounded,
freezes onto the dead 42-state. A system that also runs **backward from a goal** and
**consolidates** the two passes can tell *where it most needs to find something out* — and
that, not the answer, is what keeps it alive.

The Question Machine runs the convergence loop **both ways** and reads the **seam** between
them as a question.

## 2. The three passes

| Pass | Direction | Control / estimation analogue | Loop stage |
|---|---|---|---|
| **predict** | beginning → forward | the drift rollout `x_{t+1}=x_t+f·dt` | Observe → Reason → Act |
| **adjoint** | end → backward | Pontryagin costate `λ_t=∂J/∂x_t`; backprop-through-time; the Kalman *smoother* | Verify (credit assignment) |
| **consolidate** | meet in the middle | Hamiltonian stationarity `∂H/∂u=0`; the two-point boundary value problem | Converge |

The **backward sweep** (`backward_costate`) is the piece that was missing — the engine had
the instantaneous costate (`CIO_SDE.costate`) but never propagated it back across a trace.
It runs:

```
λ_T = terminal_grad(x_T)                       # the "end" — an EXTERNAL goal / observation
λ_t = ∇ₓL_t·dt + (I + Aᵀ·dt) λ_{t+1}           # the end, seen from each earlier moment
g_t = ∇_u L_t·dt + dt·Bᵀ λ_{t+1}  =  ∂H/∂u_t   # the seam at step t
```

`g_t` is **exactly** `∂J/∂u_t` for `J = Σ_t L(x_t,u_t)·dt + Φ(x_T)` — machine-checked against
finite differences to `rel 1e-4` (`test_backward_costate_matches_finite_difference`). That
gradient check is the correctness anchor: the "end-back" pass provably computes the true
sensitivity of the whole future to each present choice.

## 3. The question is the seam

The question at step `t` is **`‖∂H/∂u_t‖ = ‖g_t‖`** — how far the forward choice is from what
the backward objective demands. Large `‖g_t‖` = "this moment most needs resolving." The
**consolidation** (`QuestionMachine.consolidate(..., iterations>0)`) is forward-backward
descent `u ← u − lr·g`: each step re-predicts forward and re-propagates backward, driving the
seam toward zero. That descent **is** the search for the certificate's "safe passage" (§5) —
a trajectory pinned by both its start and its goal. *Tested:* the seam drops ~10× and the
questions go quiet at the optimum (`test_consolidation_drives_seam_toward_zero`).

## 4. CAP and NAP — the seam-arbiter

A surfaced question names a **channel** (an action_type / capability it would be resolved
through — `ask_human`, `web_search`, `market_probe`, …). `ask()` ranks questions by seam
magnitude, then gates each:

- **CAP** — CCF [`CapabilityGate`](../../src/convergence_io/ccf.py): the channel must be a
  *claimed, honesty-tracked, currently-routable* capability. The positive authority — what it
  can do.
- **NAP** — [`AuthorityGate`](../../src/convergence_io/nap.py): if a Negative Authority Profile
  denies the channel, the question is inadmissible **regardless of capability**. The negative
  authority — and it **overrides**.

So the machine asks the highest-leverage question it is both **able** (CAP) and **allowed**
(NAP) to ask. *Tested:* a channel CAP allows but NAP denies is dropped, and `ask()` routes to
the next admissible question (`test_nap_overrides_cap`) — denials win, exactly the CIO
constraint-dominance invariant.

## 5. The honesty discipline — coherent ≠ correct

When the forward and backward passes **agree**, the seam → 0 and the machine has nothing left
to ask *itself*. But **two mirrors agreeing can be jointly wrong** — a smoother converging on a
self-consistent, ungrounded trajectory is the higher-order collapse the C3
work warns about. Consolidation makes the trajectory **coherent, not correct.**

The escape is the **external terminal condition**. *Tested:* at the consolidated optimum the
questions are quiet (`max seam < 0.05`); swapping in a terminal anchor that *contradicts* the
coherent path reopens the seam by `>10×` (`test_grounding_revives_question`). Grounding revives
the question. `consolidate()` is internal; `ask()`'s output is a **hypothesis to be externally
verified**, never an answer.

## 6. Honest findings surfaced while building it

- **The seam front-loads to early, high-leverage steps — not the disturbance site.** Breaking
  the path at step `k` makes the seam at `k` jump sharply (~85× in test), but the *global* top
  question is the earliest step, because early controls have the most authority over the
  terminal. So "the question localizes to the break" is **false**; "a break reopens a seam,
  most loudly where leverage is highest" is true (`test_perturbation_reopens_seam`). The
  machine asks *where a fix has the most leverage*, which is the optimal-control-correct thing.
- **It stays inside the one loop — no sprawl.** Reason+Act is the forward pass, Verify is the
  backward pass, Converge is the Hamiltonian consolidation. A surfaced question is a
  **Convergence Record** (`Question.to_record()` → `[hypothesis, evidence, confidence, source]`).
  Nothing here is a new top-level subsystem; it is the existing loop closed from both ends.

## 7. What is and isn't built

**Built + tested:** the backward sweep, the forward-backward consolidation, the seam-as-question,
CAP/NAP gating, the coherent≠correct grounding behavior. The gradient check makes the math
trustworthy.

**The loop is now closed (`question_loop.py`, 2026-06-25).** `QuestionDrivenLoop` consolidates
toward a goal *belief*, asks the top admissible question, resolves it through a `Channel`, and
folds the external observation back into the belief — the Act stage made real.
`Channel` organs: `OracleChannel` (grounded reality), `MirrorChannel` (ungrounded
self-reference), `CallbackChannel`/`HumanChannel` (the human-in-the-loop — a person *is*
just a channel), `WebChannel` (live web grounding), and `CorroboratedChannel` (≥2
independent channels fused — agreement earns confidence, disagreement is flagged
"divergent" rather than averaged away; the External-Reality Rule as a channel). Tests
(`tests/test_question_loop.py`) make the thesis executable:

| run | belief discovered | internal coherence (seam) | error vs the true goal |
|---|---|---|---|
| **grounded** (oracle) | the TRUE goal | 0.053 | **0.52** |
| **ungrounded** (mirror) | stuck at the prior (0) | 0.026 | **1.94** |

The ungrounded mirror is *more* internally coherent (lower seam) and **3.7× more wrong** — it
agrees with itself precisely because it never let reality perturb it. That is *grounding is the
safety mechanism* (§7 of the certificate) as two numbers. A NAP-denied channel leaves its
dimension a permanent **blind spot** (`LoopResult.blind`) — denials keep you safe and leave you
blind, surfaced not hidden.

**Goal-attainment guard (2026-11-05):** `QuestionDrivenLoop.run` now passes the worst-sample terminal residual `max_i ‖x_T[i] − belief[i]‖` into reconciliation. Even if the forward/backward seam is quiet and all other gates pass, an endpoint outside `goal_tol` produces `replan` rather than `act`. The default tolerance is `1e-2`; callers should override it through `tolerances` for their state units. This prevents the known false-`act` case with an uncontrollable goal dimension, but it does not prove mathematical reachability or guarantee that the optimizer found the best attainable endpoint.

**Still toy:** the channels return scalars (a goal component). The remaining work is swapping
`OracleChannel`/`CallbackChannel` for organs backed by *real* external systems — the web tool,
a document store, a market feed, an actual human prompt — and letting an LLM (e.g. the Ouro
brain in the Reason slot) translate a `Question` into a real query and a returned answer into an
`Observation`. The spine is built; the organs are stubs.

## 8. Measured: can it investigate? The wrong-prior benchmark (2026-11-06)

**Status: MEASURED (synthetic).** [`experiments/question_machine_wrong_prior.py`](../../experiments/question_machine_wrong_prior.py),
tests in [`tests/test_question_machine_wrong_prior.py`](../../tests/test_question_machine_wrong_prior.py).

Nothing above measures whether the machine can *investigate*: start from a wrong belief, notice, and
find out what is true. This benchmark gives it a problem whose answer is not supplied, whose evidence
is incomplete and whose prior is deliberately wrong. It scores six behaviours: does the machine
(1) recognize the contradiction, (2) name what it does not know, (3) choose a useful experiment,
(4) obtain discriminating evidence, (5) change its conclusion, and (6) leave a reproducible record of
why, including what would refute it?

**The world.** A hidden 3-coordinate linear system is one of four mechanisms, h0 to h3. The machine
believes the wrong one (h0, prior 0.85). A passive run refutes h0 but cannot separate the other three,
which differ only in what x3 does to x1. Three probes are available, each pushing one coordinate for
one second, and only pushing x3 decides. Three control arms let a policy fail the other way:
- **null:** the prior is right;
- **unknown:** the truth is none of the four;
- **denied:** NAP denies the deciding probe.

**The policies** differ only in which probe they run. The Bayes update and the decision rule are
shared.
- **seam** is the shipped machine: consolidate under the current best model, then push the control
  dimension of `ask()`'s top admissible question.
- **eig** picks the probe with the most expected information gain. It lives in the benchmark, not
  in the machine.
- **passive**, **random** and an **oracle** that knows the truth bound them.

200 worlds per cell, coupling 1, σ = 0.02:
`python experiments/question_machine_wrong_prior.py --seeds 200 --sweep`. The output, including the
sweep, is in [`data/question_machine/wrong_prior_results.json`](../../data/question_machine/wrong_prior_results.json).
Each entry is the share of
worlds where the final claim was the arm's target. The first 3 records of every cell reproduce byte
for byte.

| Policy | wrong: claims h2 | null: keeps h0 | unknown: refutes all four | denied: stays unresolved | Probes run, wrong arm |
|---|---|---|---|---|---|
| passive | 0.00 | 0.99 | 0.01 | 0.99 | 0 |
| random | 0.68 | 0.99 | 0.69 | 0.99 | 2.1 |
| **seam (the shipped machine)** | **0.00** | 0.99 | **0.01** | 0.99 | 2.97 |
| **eig** | **0.99** | 0.99 | **1.00** | 0.99 | 0.99 |
| oracle | 0.99 | 0.99 | 1.00 | 0.99 | 0.99 |

The 0.99 entries are 2 of the 200 worlds, which every policy shares: the decision rule refutes all
four hypotheses on the passive run alone, before any probe (see the last finding).

What it shows:
- **It notices the contradiction, at this signal strength.** The shipped `reconcile` says
  `revise_model` in all 200 wrong-prior worlds and in none of the 200 null ones. It reads only the
  worst single step, though. In the sweep it catches 2% of wrong priors at coupling 0.3 and 42% at
  noise 0.05. Accumulating the same evidence over the run catches 100% in both, and neither method
  false-alarms on a right prior.
- **It cannot say what it doesn't know.** The machine has no set of competing explanations:
  `revise_model` says the model failed, not which revisions the data still allows. Every policy names
  {h1, h2, h3} here only because the benchmark's Bayes layer does that for them.
- **It does not choose the experiment that decides.** Across the 200 wrong-prior worlds:
  - the seam's first probe was x1 in 110 and x2 in 88, and never x3;
  - it ran 2.97 of its 3 probes on average;
  - it concluded correctly in none of them.

  The reason is that `ask` ranks questions by the control's leverage on the cost. After the passive run,
  x1 and x2 sit away from the target (‖∂H/∂u‖ ≈ 4·10⁻²) and x3 sits at it (10⁻² at most). So the seam
  pushes where every live hypothesis predicts the same response. Its leverage question is the right
  one for planning, but here it is the wrong one for finding out.
- **Information gain passes every arm at this setting.** It runs one probe on average, always x3, and
  concludes correctly 99–100% of the time. It runs no probe when the prior is right, or when the only
  deciding probe is NAP-denied, and then it reports that probe as blocked.
- **Where it breaks.** The sweep varies coupling and noise, with 100 worlds per cell:
  - *A truth outside the hypotheses is absorbed once its effect is small.* At coupling 0.3,
    information gain claims h1 at confidence ≥ 0.95 in 78% of unknown-arm worlds at σ = 0.02, and in
    96% at σ = 0.05. At coupling 1 and σ = 0.05 it does so in 14%. Refutation needs the mean squared
    standardised residual over all the data to exceed 1.8. That is too blunt to see a misfit
    confined to one coordinate during one probe. This is the "knows when it doesn't know" failure,
    measured.
  - *At coupling 0.1 and σ = 0.05 nothing works.* The passive run never refutes h0. Information
    gain then confirms a right prior in only 42% of null worlds and concludes correctly in 7% of
    wrong-prior ones. The seam keeps a right prior in 94%, but concludes correctly on no wrong one.
  - *The same rule false-alarms.* It refutes all four on the passive run in 1% of worlds (2 of 200
    in every arm at the main setting). That is the price of judging 30 residuals against 1.8.
  - *The seam concluded correctly in 0% of wrong-prior worlds in every cell.*

**Not tested:**
- generating the hypotheses: the four are given;
- real evidence, or language;
- any world but a synthetic linear one. Its x3 barely moves unless pushed (1/20 of the others'
  noise), a design choice that keeps the passive run from saying what x3 does;
- the machine's own channels. The probes run outside the `Channel` interface, which returns one
  number per question and cannot carry an experiment's trajectory back.

**The next measured step.** The selector half is done:
`QuestionMachine.ask_by_information` now scores a finite set of hypotheses by exact expected
information gain (§9). This benchmark's eig policy still estimates the gain itself by Monte Carlo,
because its outcomes are continuous. What remains is to give the machine its own set of competing
models, and to route probes through a channel that returns what happened, then re-run this
benchmark. The change holds only if the seam row comes to match the eig row without breaking the
null arm.

## 9. Measured: 20 Questions against a freely prompted model (2026-11-06)

**Status: MEASURED (pilot, 30 of 100 targets).**
- Harness: [`experiments/question_machine_20q.py`](../../experiments/question_machine_20q.py).
- Results, every transcript included:
  [`data/question_machine/20q_pilot_gpt-4o-mini.json`](../../data/question_machine/20q_pilot_gpt-4o-mini.json).
- Tests: [`tests/test_question_machine_20q.py`](../../tests/test_question_machine_20q.py) runs the
  harness offline, with a fake model playing every role.
  [`tests/test_question_information.py`](../../tests/test_question_information.py) tests the selector.

This is the machine's first external number. BED-LLM (Choudhury et al., ICLR 2026,
[arXiv:2508.21184](https://arxiv.org/abs/2508.21184)) measures exactly what this machine claims to
do: choose the question that teaches the most. Its 20 Questions protocol and its Animals targets
give a public task with published numbers. The targets are copied in under their MIT license.

**The selector is now part of the machine.** G2's exact information-gain selector is ported into
`question.py`. `QuestionMachine.ask_by_information(belief, experiments, budget)` returns the experiment
with the most expected information gain per unit cost, among those CAP and NAP admit.
- An experiment they refuse is never selected, but its worth is still reported.
- When only refused experiments carry information, the stop reason is `denied`.
- The seam-ranked `ask` is unchanged. It answers a different question: where a change of control
  matters most.

**The run.** gpt-4o-mini plays both questioner and answerer.
- 30 targets (seed 0), one game per target per arm, at most 20 yes/no questions.
- A separate answerer call knows the secret and sees only the current question.

The two arms:
- **Prompt-Only** is the paper's baseline, with its prompt verbatim.
- **Question Machine:**
  - the model samples up to 15 candidates, with the paper's prompt;
  - likelihoods come from the model's own Yes/No token log-probabilities;
  - the paper's filter drops a candidate once an answer has probability below 0.2 under it;
  - `ask_by_information` chooses each question from 15 the model proposes;
  - when one candidate is left, it asks "Is it X?".

Both arms are scored the same way. A Yes to a question that names the target ends the game as solved.
Otherwise the model's final guess from the transcript decides, matched by name. Matching is strict:
"Jackal" is not "Golden jackal".

| Arm | Solved | Confirmed by a guess | Questions used | Model calls per game | Cost per game |
|---|---|---|---|---|---|
| Prompt-Only (the paper's baseline) | 18/30 = 60% ± 9 | 33% | 18.3 | 42 | $0.0017 |
| **Question Machine** | **20/30 = 67% ± 9** | 50% | 16.7 | 655 | $0.038 |
| *BED-LLM paper, Table 1: gpt-4o-mini, all 100 Animals* | *Prompt-Only 44%, BED-LLM 88%* | | | | |

What it shows:
- **No measured difference.** Per target, the machine won 8, lost 6 and tied 16, and an exact sign
  test gives p = 0.79. At n = 30 the pilot cannot tell the arms apart. Nor does it reproduce the
  paper's 44-point gap: our baseline did better than the paper's (60% against 44%), and our machine
  did worse than BED-LLM (67% against 88%).
- **It costs 22× more per game.** It makes 655 model calls a game against 42, mostly the likelihood
  rows (one call per candidate per turn).
- **The paper's filter empties the candidate pool.** On 32 turns across the 30 games no candidate
  survived, so the machine asked a question without information gain. Four of its ten misses had two
  or more such turns. A single answer that the likelihood model disagrees with removes the true
  animal. Bayes' rule with a 2% answer-error rate, tried in a smoke run, failed the other way: it kept
  contradicted candidates, so the pool never refreshed.
- **Its own belief is weaker than its transcript.** Scored by its belief's best candidate, which is
  the paper's rule, the machine solved 16/30 (53%). Confirmed guesses and the shared final guess give
  it 20.
- **Several misses are near-misses under strict matching:** "Jackal" for Golden jackal (its belief
  held "Golden jackal"), "Giant tortoise" for Galápagos tortoise, "Hercules beetle" for Rhinoceros
  beetle, and "Oncilla" for Ocelot.

**How it was built, disclosed.** Two smoke runs on two other targets found four bugs before the pilot:
- the list writes aliases as `name | alias`, and they went unmatched;
- a guess that did not end the game was asked again;
- the Bayes variant above lost both smoke games;
- the baseline stopped asking after "Is it a frog?" was answered Yes. It now gets one reminder of its
  output format.

After the pilot, the guess rule was widened to the baseline's own phrasing ("Is the animal you are
thinking of a moose?"), and both arms were re-scored from their transcripts. That moved the baseline
from 16 to 18 solved and left the machine unchanged. Everything together cost $1.26 at gpt-4o-mini
list prices, over 21,598 calls.

**The next measured step.** First, a belief that survives one wrong answer and still refreshes its pool,
or a stronger model for the likelihoods and the answers. Then the full 100 targets, with more than one
game each, before any difference between the arms is claimed.

---

*Provenance: built 2026-06-25 alongside the C3 certificate closure. The "end-back / beginning-
forward, consolidate with CAP and NAP" framing is the design request this realizes; the
Deep-Thought / question-vs-answer framing is the through-line from the collapse certificate's
§7 (grounding is the safety mechanism).*
