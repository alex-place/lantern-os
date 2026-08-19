# The Twin Machine

*One machine, two faces, one owned. A design for a system that finds not just answers but the
questions it should be asking — and an honest account of the one thing that makes it work and the
one place it can still fail. Companion to
[CONVERGENCE-CERTIFICATE-PLAIN.md](CONVERGENCE-CERTIFICATE-PLAIN.md).*

**Status:** DESIGN. Nothing here is proven. Where a claim rests on a measurement already made in
this repo, it says so; where it rests on an argument, it says that instead.

---

## The problem in one paragraph

A self-improving system that chooses its own questions will pick the ones its current worldview
rates as interesting. The question that would show its worldview is wrong — in a way it cannot yet
represent — has zero estimated value, because the model that would value it doesn't exist yet.
Nothing inside the loop can see this. It is the same failure the convergence certificate catches
for *answers* (collapse onto a confident fixed point), one level up: collapse onto a confident
*question space*. And it is structurally the same thing the §9 finding showed — a hidden quantity
cancelled in the only sum the gate can see, so every certificate passes while the system diverges.

You cannot fix this from inside. You need a second observer that rates questions differently.
That is the twin.

## The twins — and they are not peers

| | **A — the Answerer** | **B — the Asker** |
|---|---|---|
| job | get the current question right | find where A's worldview has cancelled a term |
| optimised for | being correct | being *calibrated about A* — predicting where A is wrong |
| grounded in | reality: run the test, place the bet, check the source | A itself, plus the list of things A cannot reach |
| what it is, concretely | the frontier model we rent | the verifier we own |
| its output | an answer | a calibrated "you are about to be wrong here" + a list of pins |
| its victory condition | converging | stopping A from converging too soon |
| inside it | any model; MoE later, plain model now | any model; a mixture of critics later, plain model now |

**The right-hand column is the in-house model.** Every line of it is something this repo has
already decided is ours to build: verifier-first rather than generalist (ADR-0024 A1, approved),
calibrated confidence read from internal state rather than prose, the honest halt, the escalation
trigger. B is not a new thing. It is the thing we were already building, named by its job.

A is the rented frontier, and that is the right call: A's job is the half any strong model can do.

**Why two copies of the same model will not work.** They share the cancelled term. Same priors,
same blind spot: they will find the same questions interesting and the same questions boring, and
you will have built an echo with extra steps. B has to be *built to fail differently* from A —
different training objective, different grounding, different optimisation target. The table above
is that difference, made explicit so it cannot drift.

## The one rule

> ### B can stop A. A cannot stop B.

B's only authority is the halt. It cannot make A produce a different answer; it can only refuse to
let the current one through and say why. If A could argue B down, the pair collapses back into
one loop with one blind spot, and B's disagreement stops being information. The asymmetry is not
a safety nicety. It is what makes the disagreement *mean* something.

This is ADR-0030's Phase 1 under its real name: B's early-exit signal *is* A's escalation trigger.
When B says "not yet," A escalates or halts. When B says "I can't tell," that is a pin.

**And B is overridable by exactly one thing: reality.** Not by A, and not by a manager sitting
above both. When an action settles a question — the test runs, the bet resolves, the source is
checked — the result overrules B's verdict in either direction. B is a prediction about A; reality
is the grade.

## Where the question-selector lives — this is the correction that matters

The natural diagram puts a box on top of both twins labelled *"what do we know / what is disputed /
what experiment next."* **That box is the vulnerability.** It is the question-selection function,
and question selection is exactly where the cancelled term lives. One selector over both twins is
one loop with one blind spot, drawn with more boxes.

So: **the selector is inside B.** Deciding what to probe next is B's job, because B is the twin
whose objective is "where is A wrong," and the most valuable probe is always the one that tests
that. A does not get a vote on what gets investigated; A gets the investigation handed to it.

B's selector has its own freshness law. The repo measured that an internal signal cannot replace
fresh external data in the selection role (§8.4.1 of the certificate; the 2026-07-07 experiments).
B is the internal signal *for A*. So on a cadence B does not control, B is forced to probe things
it currently rates as uninteresting — otherwise B's own question space ratchets closed exactly the
way a reused held-out set does. B's pin list is where that cadence points first.

## Independence is tested, not measured

It is tempting to track critic correlation — "if B1 and B2 always agree, discount their
agreement." That is necessary and it is not the point. The §9 failure was not two correlated
signals; it was a quantity *no* signal had any sensitivity to — a direction where every certificate
read zero. Correlation among the critics you have says nothing about that direction.

The test for a shared blind spot is the one the §9 experiment ran: **hold every certificate fixed,
vary a hidden quantity, and watch whether the outcome moves.** If it moves while every verdict is
constant, you have found a cancelled term. This is a perturbation test, not a statistic, and it is
the only test that catches the failure that actually happened.

So the machine keeps, for each twin, a record of *what perturbations it has been shown to be
sensitive to* — not a confidence number, and not an agreement rate. A twin is independent of
another in a direction only if it has been demonstrated to move there when the other does not.

## The product is the pin list

Here is what changes once you take the twin seriously. A Deep Thought machine's most valuable
output is not its answers. It is its list of **pins**: the questions B can see but no action can
yet resolve — "here is where my own twin says I am blind, and I have no instrument that reaches
it." That list is where the next instrument gets built. Deep Thought's actual punchline is the
right one: it found the answer, could not find the question, and needed a second, differently-built
machine to do it.

On the surface, the pin list is a first-class object next to the answer: *what we're confident of,
where the twins disagree, and what we cannot reach yet.* Not a confidence score — a map of the
boundary.

## The layer cake, and what each layer is for

| layer | what it is | status here |
|---|---|---|
| computation | MoE inside a twin — more capacity per unit compute | not needed to start; plain models first |
| evaluation | a mixture of critics inside B — more judgments per answer | not needed to start; one critic first |
| epistemic | the twins — A explores, B audits, one-way stop | **this document** |
| evidence | append-only observations with provenance | exists: the JSONL memory + CSF |
| experiment | acting on the world — tests, bets, sources | exists: the tool runner, the trader, the exec sandbox |
| boundary | the pin list | **new**; the first thing to build |
| evolution | controlled model/tool/weight updates | **exists and is switched off**, and should stay off — see below |

MoE makes the brains bigger. A mixture of critics makes the judgment broader. The twins make the
system adversarial to itself. Reality makes it answerable to something outside itself. The
architecture is the *topology connecting* these, not any one of them — which is why the twin
contract does not depend on what is inside A or B.

## The hole, stated up front

The evolution layer — letting the machine update its own weights — is the part with an unresolved
flaw, and this design does not pretend otherwise. The §9 result is exactly that composing a
weight-update gate with a fast-state certificate is **not** safe just because both pass: the safe
rate was set by a quantity neither measured, and the two passed while the composed system diverged
by a factor of a thousand. That was in the linear case. The general case is worse, not better.

So the evolution layer stays **off** until the composition itself has been tested — not each half,
the composition — by the perturbation test above. "Eventually" is not a gate. A measured bound is.

## What to build first, in order

1. **The pin list as a surface object.** B's "I cannot tell" is already a state the honest halt
   produces; surface it next to the answer instead of dropping it. Zero model work.
2. **The one-way stop, wired.** B's verdict gates A's answer at the single endpoint both stand
   behind (`/api/dream/chat/stream`). This is the escalation trigger; the meter for it already
   exists (`GET /api/metrics/escalation`).
3. **B trained verifier-first on owned data** — every verified trace is a labelled example, and the
   trading surfaces generate ground truth on a schedule the market sets. This is ADR-0024 A1.
4. **The perturbation test of independence**, run before any second critic is added. If a new
   critic moves in no direction the first does not, it is an echo, not a twin.
5. The evolution layer, **last and gated**, on a measured composition bound — not before.

## What this is not

It is not two chatbots talking. It is not a debate, and it is not a vote. It is one machine whose
two faces are built to fail differently, where one face holds the only veto, and where the veto
answers to reality alone. The closed loop is the enemy throughout; every design choice above is a
way of keeping something outside it.
