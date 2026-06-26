# The Question Machine — bidirectional consolidation of the convergence loop

**Status: BUILT + TESTED (2026-06-25).** Core in [`src/cio_sde/question.py`](../../src/cio_sde/question.py);
5 machine-checked tests in [`tests/test_question_machine.py`](../../tests/test_question_machine.py);
runnable demo [`experiments/question_machine_demo.py`](../../experiments/question_machine_demo.py).
This is the math core (the bidirectional loop + the CAP/NAP seam-arbiter), **not** the
full product — the external Act-stage channels it would ask *through* are still the open
gap (see §7). Companion to the [Collapse Certificate](../SIGMA0-COLLAPSE-CERTIFICATE.md)
and [Theorem C3](../SIGMA0-C3-NONCOLLAPSE-NORMAL.md).

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
self-consistent, ungrounded trajectory is the higher-order collapse the [C3](../SIGMA0-C3-NONCOLLAPSE-NORMAL.md)
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

**Still toy:** the channels return scalars (a goal component). The remaining work is swapping
`OracleChannel`/`CallbackChannel` for organs backed by *real* external systems — the web tool,
a document store, a market feed, an actual human prompt — and letting an LLM (e.g. the Ouro
brain in the Reason slot) translate a `Question` into a real query and a returned answer into an
`Observation`. The spine is built; the organs are stubs.

---

*Provenance: built 2026-06-25 alongside the C3 certificate closure. The "end-back / beginning-
forward, consolidate with CAP and NAP" framing is the design request this realizes; the
Deep-Thought / question-vs-answer framing is the through-line from the collapse certificate's
§7 (grounding is the safety mechanism).*
