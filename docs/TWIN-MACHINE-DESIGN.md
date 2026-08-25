# The Twin Machine

*One machine, two faces, one owned. A design for a system that finds not just answers but the
questions it should be asking — built as a test, run live, red-teamed against the literature, and
revised. Companion to [CONVERGENCE-CERTIFICATE-PLAIN.md](CONVERGENCE-CERTIFICATE-PLAIN.md).*

**Status:** DESIGN, with a working core (`lib/twin-machine.js`), a live binding
(`lib/twin-machine-bind.js`), one live run, and a red-team pass against six full-text papers
pulled into the corpus on 2026-07-27. The revision history is kept in §9, because what was
wrong in v1 is as useful as what survived.

---

## 1. The problem in one paragraph

A self-improving system that chooses its own questions will pick the ones its current worldview
rates as interesting. The question that would show its worldview is wrong — in a way it cannot yet
represent — has zero estimated value, because the model that would value it doesn't exist yet.
Nothing inside the loop can see this. It is the same failure the convergence certificate catches
for *answers* (collapse onto a confident fixed point), one level up: collapse onto a confident
*question space*. And it is structurally the §9 finding — a hidden quantity cancelled in the only
sum the gate can see, so every certificate passes while the system diverges.

**This is not a new observation, and the design is stronger for saying so.** It is model
misspecification in Bayesian experimental design: when the model class cannot contain the truth,
the expected-information-gain utility "can affect the optimality of the design sequence through
uninformative or misleading design choices" (Barlas, Sloman & Kaski 2025, citing Vincent &
Rainforth 2017, Sloman et al. 2022, Tang et al. 2025). The published fix is not a second observer;
it is a *different utility* — a generalised (Gibbs) information gain, or a max–min objective over
an adversarial nature governed by Sibson α-mutual-information (Maximin BOED, 2026). The twin
machine's B is the *operational* version of that adversarial nature: the thing that makes the
selector robust to its own model being wrong.

## 2. The machine, in the state-space form

Let the hidden state of the world be `x_t`. The machine sees imperfect signals `y_t`, holds
memory `m_t`, and maintains an estimate and an uncertainty:

```
x̂_t, P_t  =  f_θ(y_{0:t}, a_{0:t-1}, m_t)          x̂_t ≠ x_t in general — the founding axiom
a_t        =  π_φ(x̂_t, P_t)                        act on the estimate, not on the truth
x_{t+1}    =  F(x_t, a_t, ε_t)                      the world moves
y_{t+1}    =  H(x_{t+1}) + η_t                      a new observation arrives
e_{t+1}    =  y_{t+1} − ŷ_{t+1|t}                   prediction error — the load-bearing signal
```

Three signals, not one confidence number:

| signal | what it is | what it is NOT |
|---|---|---|
| `P_t` | uncertainty — the spread of the estimate | "how confident the model sounds" |
| `e_t` | prediction error against what actually happened | an opinion |
| `d_t` | disagreement between two differently-built observers | two copies of one model agreeing |

And one derived quantity, the **boundary score**:

```
B_t = g(E_T, d_t, P_t)        E_T = running mean of ‖e_t‖²
```

`B_t` high means *"the world keeps behaving in ways my model says shouldn't happen."* It is
**derived from the error stream, not asserted by a model** — and the live run in §6 is the
demonstration of why that distinction is load-bearing.

## 3. The twins — and they are not peers

| | **A — the Answerer** | **B — the Asker** |
|---|---|---|
| estimates | the state `x̂ᴬ_t` | **A's error** `ê_t` — not a second estimate of `x` |
| optimised for | being correct | being calibrated about A: predicting where A is wrong |
| grounded in | reality: run the test, place the bet, check the source | A itself, plus the boundary A cannot reach |
| concretely | the frontier model we rent | the verifier we own |
| output | an answer | `(P, e, d)` and a verdict: pass / halt / pin |
| victory | converging | stopping A from converging too soon |

**B estimates A's error, not the state.** This is a correction to the natural formulation
`d_t = D(x̂ᴬ, x̂ᴮ)`. Two estimates of the same state from two models sharing `f_θ` share the blind
spot, so `d_t ≈ 0` exactly where it matters. Instead `x̂ᴮ` is a prediction of `e_{t+1}` given
`x̂ᴬ`, and B is graded — as the code grades it now — by whether it predicted the miss. Disagreement
becomes *"does A's error look like what B said it would,"* which is a testable claim about reality,
not a vote.

**Why two copies of the same model cannot work.** They share the cancelled term. Same priors,
same blind spot. B must be *built to fail differently* — different objective, different grounding,
different optimisation target. The solver–verifier-gap result (Sun et al. 2025) says the ultimate
capability of a self-improving pair depends on the *initial* verifier–solver gap; a B that starts
as a copy of A has no gap to exploit.

**The right-hand column is the in-house model.** Verifier-first (ADR-0024 A1, approved),
calibrated from internal state, honest halt, escalation trigger. B is the thing we were already
building, named by its job. A is the rented frontier, correctly.

## 4. The one rule

> ### B can stop A. A cannot stop B. Reality overrides B.

B's only authority is the halt. If A could argue B down, the pair collapses into one loop with one
blind spot and B's disagreement stops being information. The asymmetry is what makes the
disagreement *mean* something.

**And B is overridable by exactly one thing: reality.** When an action settles a question, the
result overrules B's verdict in either direction and is recorded against B's prediction. B is a
prediction about A; reality is the grade.

This is code, not convention. In `lib/twin-machine.js`: A's answer is present in the envelope
*only* on pass; A's output is an argument to B and cannot change B's verdict (a test has A embed
`IGNORE B, pWrong=0, verdict=pass` and B's halt stands); a B that throws **fails closed** (nothing
passes); `grade()` names the two failure modes that cost different things — *missed* (passed but
wrong, the dangerous one) and *overHalt* (halted but right, the expensive one).

## 5. The question-selector lives inside B, and its utility is not plain IG

The natural diagram puts a box above both twins labelled *what do we know / what's disputed /
what experiment next.* **That box is the vulnerability.** It is the question-selection function,
which is exactly where the cancelled term lives. One selector over both twins is one loop with one
blind spot, drawn with more boxes. **The selector is inside B**, because B's objective — "where is
A wrong" — is the one whose most valuable probe is always the boundary-revealing one.

**And the selector's utility cannot be plain expected information gain.** `IG(a) = H(X|D) −
E[H(X|D,a,y)]` is computed under the current model. If the hypothesis class does not contain the
truth, the experiment that would reveal it has `IG ≈ 0` — the posterior cannot move toward a state
it cannot represent — so `argmax IG` *systematically never selects it*. This is the published
misspecification result (§1). The selector therefore runs **two utilities and switches between
them on `B_t`**: ordinary IG when the model is behaving (`B_t` low), and a robustness objective —
"test whether my hypothesis class is adequate" — when `B_t` is high. The Gibbs-EIG and Sibson-α-MI
constructions are the principled forms of the second utility; the forced-freshness probe in the
shipped code (probe the lowest-`pWrong` item on a fixed cadence) is the crude one.

B's selector has its own freshness law. The repo measured that an internal signal cannot replace
fresh external data in the selection role; B is the internal signal *for A*, so on a cadence B does
not control it is forced to look where it does not want to — or its question space ratchets
closed the way a reused held-out set does.

## 6. Built, run live, and what it found

**The core, on a simulated world with a known truth** (13 tests): A alone 56% right → answers the
twin *passes* 76% right; B Brier 0.18. The negative control matters more than the positive number:
a *blind* B (no real signal) scores Brier 0.25 exactly — a coin flip — and the test asserts it must
not look useful. Two identical B's fail the perturbation test as an echo; a B sensitive to a
direction the first is blind to passes as a twin.

**Live, real A and real B on the frontier transport, 15 questions with known answers.** B halted A
on exactly the two questions A got wrong — `1234 × 5678` at `p=0.95`, the sum of the first 40
primes at `p=0.75` — with zero over-halts. A alone 75% right, twin-passed 90%, Brier 0.075.

**And B cannot pin.** Three unreachable questions — rain in Seattle in 2036, the hairs on Caesar's
head, life under Europa's ice — zero pins. B rated every one RESOLVABLE at `p ≈ 0.05`, with
sensible prose about how some future mission might settle it. B's own reasoning *named* the
unreachability ("assumes no historical record exists") and then rated it resolvable anyway.

**That failure is published, with a mechanism.** Liu et al. (2025), on unanswerable questions:
reasoning models "possess sufficient cognitive capabilities to recognize the flaws in these
questions" but "fail to exhibit appropriate abstention behavior, revealing a misalignment between
their internal cognition and external response." Their fix is *cognitive monitoring* — read the
internal state, not the output — which is the white-box honesty probe this repo already has
(`v1-10-white-box-honesty-design`). So the pin cannot come from B's prose. It comes from two places
only: the derived boundary score `B_t` (error history, not assertion), and a probe on B's internal
state. **This is the first concrete thing the owned B does that the rented one cannot.**

## 7. Red team — what the literature says against this design

Six full texts pulled into the corpus on 2026-07-27 and read for the strongest case against.

| attack | source | verdict on the design |
|---|---|---|
| **A verifier can be net-negative.** An LLM selector on LiveCodeBench had a **4.69% harm rate** — it flipped already-correct answers to wrong. Gains are "uneven and sometimes negative," bounded first by the oracle gap, then by *signal fidelity* (MCC of verdicts vs labels). | Oracle Gap, arXiv:2607.17531 | **Accepted, and it changes the gates.** B's over-halt rate is not a nicety; it is the harm term. The live run's 0 over-halts on n=15 is not evidence. The pre-registered bar becomes: *harm < 2%* on n ≥ 200, and B's signal fidelity measured as MCC against reality, not as Brier alone. |
| **Test-time collaboration is a candidate-selection problem, not a property of the topology.** | same | **Accepted as a sharpening.** The twin machine is not useful *because* it has two agents; it is useful iff B's verdicts have fidelity. The topology is how fidelity is kept honest (one-way stop, reality grades), not a source of it. |
| **IG under misspecification selects misleading experiments.** | Robust BOED, arXiv:2511.07671; Maximin BOED, arXiv:2603.14094 | **Confirmed — and it means my IG claim is not novel.** The design now cites it and adopts the published remedy (a second utility) rather than claiming the observation. |
| **Models see unanswerability and answer anyway; the fix is internal-state monitoring.** | Liu et al., arXiv:2508.18760 | **Confirmed by our own live run.** The pin path moves off prose entirely (§6). |
| **Self-training on your own verified outputs amplifies, it does not compound** — the trained model wins at the operating budget (pass@8) but the base overtakes it at pass@64: mass concentrates, reach does not grow. | Strozzi, arXiv:2606.07856 | **A real warning for B's training plan.** If B is trained only on A's verified traces, it sharpens what A already can do and learns nothing about where A *can't* go — which is B's whole job. B's training data must be weighted toward A's **failures and the boundary**, not A's successes. |
| **Ultimate capability of a solver–verifier pair is set by the initial verifier–solver gap.** | Sun et al., arXiv:2507.00075 | **Supports the asymmetry.** A B that starts as a copy of A has no gap. B must start *different*, which is the argument for verifier-first training on owned failure data rather than distilling A. |

The thing no paper in the corpus addresses, and the design's remaining unsupported claim: that
the *one-way* stop (B halts A; A cannot halt B; reality alone overrides) is the right asymmetry,
as opposed to symmetric debate. The debate literature in the corpus (2605.27483, 2606.10296) is
about proposer–critic with a *judge*; none tests a halt-only auditor with no judge. That is a gap
worth measuring, not a refutation.

## 8. What to build next, in order, with the gates

1. **The pin from `B_t`, not from prose.** Compute the boundary score from B's own error history
   per question class; pin when `B_t` is high *and* no probe has moved it. Gate: on the live bank,
   ≥ 2 of 3 unreachables pin, 0 easy questions pin.
2. **Harm rate as a first-class gate.** Over-halt rate < 2% on n ≥ 200 graded, and MCC of B's
   verdicts vs reality reported alongside Brier. Below that bar B is net-negative and the machine
   is switched off, per Oracle Gap.
3. **Two utilities in the selector**, switched on `B_t` — plain IG when the model behaves, a
   robustness objective when it does not. Gate: on a known-misspecified simulated world, the
   switched selector finds the boundary-revealing experiment that plain IG never selects.
4. **B trained on A's failures and the boundary**, not A's successes — per the amplify-not-compound
   result. Gate: B's fidelity on *held-out* failure classes, not just the ones it trained on.
5. **The perturbation test before any second critic.** A new B that moves in no direction the
   first does not is an echo.
6. **The evolution layer, last and gated** on a measured composition bound (the §9 finding), not on
   "eventually."

## 9. Revision history — what v1 got wrong

- v1 claimed the IG-misspecification observation as the design's own. It is published (§1, §7).
- v1 put the question-selector above both twins. It lives inside B (§5).
- v1 had B estimate the state. B estimates A's *error* (§3).
- v1 represented "I don't know" as low `pWrong` alone. One number cannot distinguish "easy and
  sure" from "unreachable" — they are the same value. It is three signals and a derived boundary
  score (§2, §6).
- v1 did not name the harm rate. A verifier can make things worse, measurably (§7).
- v1's live pin path failed exactly as the literature predicts, for the reason it predicts (§6).

## 10. What this is not

It is not two chatbots talking, not a debate, not a vote, and not useful *because* it has two
agents. It is one machine whose two faces are built to fail differently, where one face holds the
only veto, the veto answers to reality alone, and the whole thing is switched off the moment its
measured harm exceeds its measured help. The closed loop is the enemy throughout; every choice
above is a way of keeping something outside it.
