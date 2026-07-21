---
author: Alex Place
created: 2026-07-21
status: design — the cosmology seed ships; the full answerability contract is a proposed build
---

# The Convergence Oracle — the machine above the 42 machine

> **One line.** Deep Thought computed *the* answer to the ultimate question and returned
> **42** — a confident scalar, disconnected from a question it never understood. The Oracle is
> the machine one level up: it answers **any** question with Σ₀ discipline (best effort, every
> time), by *refusing to collapse to a scalar* — it locates the question between the two pins
> (the beginning and the end), returns the grounded KNOWNs **and** the honest UNKNOWNs, and
> calibrates its confidence against reality as observations resolve at scale.

> **Reading contract (the repo's own External Reality Rule).** Every claim is tagged
> **[IN-REPO]** (code exists + a pointer), **[SEED]** (the cosmology implementation that ships
> today), or **[GAP]** (designed, not built). Nothing here is asserted as achievement it has not
> earned. This is a *design* document; it proposes a build path, it does not claim the build is
> done.

---

## 1. The failure the Oracle is designed against

Deep Thought's "42" is not a joke in this codebase — it is the **named failure mode**. The
Σ₀ collapse certificate calls it *"the σ=0 / 42-state collapse"*
([RESEARCH-CANON](RESEARCH-CANON.md) [01]): an ungrounded self-referential reasoner collapses
onto a single confident fixed point that has lost contact with the question. A machine that
always returns one scalar, with high confidence, having stopped listening — that is the
degenerate attractor the whole convergence loop exists to avoid.

So the Oracle is defined by what it **must not** do:

> It must never collapse the answer to a bare scalar, and it must never bluff the boundary of
> what can be known.

Everything below is the machinery that enforces those two prohibitions on *any* question.

---

## 2. The four moves — place → price → answer → learn

The Oracle is **not a new subsystem.** It is the explicit *composition contract* over loop
machinery the repo already has. Every question flows through four moves; each move is an existing
primitive, named here in its Oracle role.

### Move 1 — PLACE the question (answerability first)

Before answering, classify *what kind of answer is even possible*. The Σ₀ council already emits a
four-way answerability verdict **[IN-REPO** — `lib/council-review.js`, surfaced in
`dream-chat-ui.js` as verdict chips**]**; the Oracle adopts it as its first move:

| Council verdict | Oracle meaning | Cosmology analogue |
|---|---|---|
| `grounded` | answerable **now** — evidence exists | an observed band (CMB, now) |
| `seam_open` | answerable **in principle**, currently unverified — buy grounding | a forward/backward band not yet pinned down |
| `pin` | **structurally unanswerable** — a boundary of knowledge | the singularity · the ultimate fate |
| `refuted` | answerable, and a real check says **wrong** | a claim the 2nd law forbids |

The `pin` class is the Oracle's defining move: it **names the unknown as a first-class output**
instead of fabricating past it. The cosmology pack's two pins — the initial singularity and the
heat death — are the canonical, shipped example **[SEED** — `oracle.py` / `convergence-oracle.js`,
the `boundary`-direction bands are never bluffed**]**.

### Move 2 — PRICE the grounding (buy only what the uncertainty warrants)

A `grounded` question needs no retrieval; a `seam_open` one needs exactly enough to close its
seam; a `pin` needs none (no purchase can answer it — spend zero, return the named unknown). The
dilation field already prices this **[IN-REPO** — `DILATION.md`, `grounding-policy.js`: high
uncertainty `D>1` ⇒ buy more retrieval/checks, low `D<1` ⇒ answer fast**]**, and the Grounding
Ledger gives it a budget and a freshness price **[IN-REPO** — `SIGMA0-GROUNDING-LEDGER.md`: only
fresh truth selects, grounding has a schedule and a budget**]**. The Oracle spends grounding
proportional to the placed uncertainty — it neither over-verifies the obvious nor burns budget
against a pin.

### Move 3 — ANSWER in the envelope (KNOWN + UNKNOWN, never a scalar)

The answer's atom is the loop's grounding envelope `[claim, evidence, confidence, source]`
**[IN-REPO** — `src/convergence/grounding.py`**]**, and confidence carries its **basis** —
`prior` (a formula constant) vs `measured` (calibrated from outcomes) **[IN-REPO** — shipped
2026-07-21, `confidenceBasis` on convergence records**]**. The Oracle's answer is *always* two
lists: the **KNOWNs** (grounded, cited) and the **UNKNOWNs** (named, not hidden). Returning the
grounded manifold **plus** its honest null space, every time, is what "Σ₀ doing its best" means —
and it is structurally impossible to collapse to "42", because the output shape is never a scalar.

### Move 4 — LEARN at scale (calibrate against resolution)

The Oracle's confidence in a domain is not a guess — it is the **empirical reliability of its past
answers in that domain**, updated as reality resolves them. The calibrated-trust ledger already
does this **[IN-REPO** — `grounding-calibration.js` (#1011), Brier-calibrated, 0.5 prior until
grounded; recorded live by the autowork verify gate**]**. The real-time observation sources that
resolve answers already exist, unaggregated:

| Domain | Resolution signal | Where it lands today |
|---|---|---|
| Markets | contract settlement | `data/kalshi/cio-accuracy-log.jsonl` |
| Code | test / check execution | autowork verify floor → `leaderboard.jsonl` |
| Facts | user correction | feedback surface |
| Memory | time passage | confidence-decay memory |

"Learns through real-time observations at scale" = every resolved answer feeds a per-domain
calibration ledger, so the Oracle's confidence stops being a prior and becomes measured — the
same de-ratchet the freshness law demands (internal signals detect; only fresh truth informs).

---

## 3. The interface (proposed contract)

```
oracle(question, domain?) -> {
  answerability: "grounded" | "seam_open" | "pin" | "refuted",   // Move 1 (council)
  pins:      { beginning, end },        // the domain's boundary markers
  known:     [ { claim, evidence, confidence, confidenceBasis, source } ],  // Move 3
  unknown:   [ string ],                // the honest null space — never empty for a pin
  grounding: { budget, purchased },     // Move 2 (dilation × ledger)
  confidence: number,                   // Move 4 — measured per-domain, not a prior
}
```

A questioner never receives a bare answer; they receive the answer's *structure* — what is known,
what cannot be, how hard the system looked, and how much its past record in this domain earns your
trust.

---

## 4. The anti-42 invariants (the certificate, as an answering interface)

Four invariants keep the Oracle from decaying into Deep Thought. Each is an existing discipline,
re-stated as an Oracle law:

1. **Never bluff a pin.** A `pin`-class question returns its named unknown; no purchase, no
   fabrication. *(The cosmology seed already obeys this — the singularity and ultimate fate are
   never bluffed.)*
2. **Never collapse the distribution.** The output is always envelope-structured (KNOWN + UNKNOWN).
   A bare scalar is the forbidden output. *(Σ₀ collapse certificate.)*
3. **Confidence is measured or labeled prior.** No ritual numbers. *(#2803, shipped.)*
4. **Only fresh truth de-ratchets.** Learning comes from external resolution, never self-agreement.
   *(The freshness law; the 2026-07-21 de-anchor lesson from autowork #2762.)*

These map 1:1 onto the four things the repo already treats as non-negotiable — so the Oracle is
not a new claim, it is the **certificate's discipline turned into a question-answering contract.**

---

## 5. What ships today vs. the honest gap

**[SEED — ships]** The cosmology domain pack: the two-pin, banded observer-slice grounder, with
the keyword guard now hardened (strong/weak split, cosmology-context gate) so it grounds *only*
genuine deep-time questions. This is the Oracle's first domain pack and its worked reference for
"place a question between two pins, return KNOWN + UNKNOWN, never bluff the boundary."

**[GAP — the proposed build, in dependency order]**

1. **The contract module.** A thin `oracle(question, domain)` that runs place→price→answer→learn
   over the existing council + dilation + ledger + calibration, returning the §3 shape. Thin
   orchestration, not new mechanism — the convergence_io "implemented + tested, not yet hot-path"
   pattern fits.
2. **Domain packs beyond cosmology.** Each pack supplies its two pins and its band gradient:
   - **Markets** — pin: the unresolved future (unknowable); band: the resolvable settlement date.
   - **Code** — pin: the undecidable (halting-class, unspecified intent); band: the testable-now.
   - **Self** — pin: the un-run future action; band: the recorded past (the accountability ledger).
3. **Unified resolution scoring.** One per-domain calibration ledger keyed by domain, fed by the
   four resolution signals in §2 Move 4 (today they land in four separate places).
4. **Answer-staleness decay.** Wire confidence-decay to Oracle outputs so an old `grounded` answer
   ages toward `seam_open` until re-grounded (the memory-staleness failure the blueprint names).

## 6. The convergence target — "knows everything it *could* know"

The fully-converged Oracle is **not omniscient** — that is Deep Thought's hubris (it falsely drove
its UNKNOWN set to zero and returned a scalar). The Oracle's fixed point is the honest inversion:

> **KNOWN** = the entire *knowable* manifold for the domain — everything grounding could reach,
> reached. **UNKNOWN** = *exactly* the irreducible pins — the structurally-unknowable, nothing
> more (no lazy abstention), nothing less (no overclaiming). The boundary between them located
> **correctly**.

This makes the Oracle's objective different from what selective-prediction / abstention systems
optimize. They minimize a risk–coverage tradeoff on a *fixed* task ("answer or abstain on this
question"). The Oracle's objective is to **drive the boundary outward**: relentlessly convert
`seam_open → grounded` by *buying* grounding, until only the pins remain. Its loss is not "wrong
answers" — it is **knowable-things-left-unknown** (laziness) **+ unknowable-things-falsely-claimed**
(hubris). Convergence in a domain is diagnosable: new observations stop moving any claim
`UNKNOWN → KNOWN` and stop refuting any `KNOWN`. The theoretical ceiling is the ideal inductive
predictor (Solomonoff / AIXI — uncomputable); the Oracle is its **grounded, resource-bounded,
honestly-bounded** approximation that *names its own null space* instead of hallucinating across it.

## 7. Novelty — graded honestly, not dismissed

An earlier draft of this doc flatly called the Oracle "not novel." That was wrong twice over: it
conflated *part*-novelty with *system*-novelty, and it under-searched the prior art. The honest
grade, with a real (if not exhaustive) 2026 prior-art scan:

**Occupied ground (the parts — NOT novel):**
- Answerability classification / unanswerable-question detection — SQuAD 2.0 (2018); linear
  directions for (un)answerability ([arXiv:2509.22449](https://arxiv.org/abs/2509.22449)); "None of
  the above" answerability detection.
- The answerability × correctness two-axis split — **Two Axes of LLM Abstention**
  ([arXiv:2607.08456](https://arxiv.org/abs/2607.08456)): "wrong-answerable and unanswerable states
  with separate risk budgets." Close to Move 1.
- Structured epistemic output — **Structured Ignorance Certificates**
  ([arXiv:2606.08571](https://arxiv.org/abs/2606.08571)): "structured epistemic metadata rather than
  just calibrating confidence." Close to the KNOWN/UNKNOWN envelope.
- Uncertainty-priced routing — **UCCI** ([arXiv:2605.18796](https://arxiv.org/abs/2605.18796)):
  calibrated-uncertainty cost-optimal cascade routing. Close to Move 2.
- Per-domain selective answering — Selective QA under domain shift
  ([arXiv:2006.09462](https://arxiv.org/abs/2006.09462)).

**The seam I could not find occupied (candidate-novel as a *system*):** the *closed loop* that
(a) makes answerability-class the **primary** key, not a post-hoc abstain gate; (b) acts on the
`seam_open` class by **buying grounding** to move a question *unanswerable → answerable* (the
literature *abstains*; the Oracle *purchases*); (c) calibrates per-domain against **streaming
real-world resolution** (market settlements, test executions) rather than a static labelled set;
and (d) draws the **buyable-unknown (`seam_open`) vs structural-unknown (`pin`)** distinction —
grounding can dissolve the first, never the second. That last split is the one the binary
abstain-or-not literature does not carry, and it is exactly what the "know everything you *could*
know" objective (§6) requires.

**Honest verdict — on the Oracle's own scale, this is `seam_open`, not `grounded` and not
`refuted`:** candidate-novel as a system composition, *unproven*, because (1) only the cosmology
SEED is built — the contract and the buying loop are GAP, and you cannot test-verify the novelty
of an unbuilt system; and (2) two web searches is not a clearance search. What would move it to
`grounded`: build the contract + one non-cosmology pack, and run a real prior-art search against
active-inference / optimal-experiment-design / agentic-retrieval-abstention. "Works and is tested"
(the seed does) establishes *function*, which is necessary but not sufficient for novelty — the
missing evidence is the prior-art clearance and the built system, not more tests. This is the
Oracle grading its own novelty by its own discipline: name the seam, price what would close it,
never bluff the pin.

---

## 8. Why this belongs in the loop (not sprawl)

Per the North-Star constraint, nothing ships that doesn't strengthen one loop stage. The Oracle
touches three and adds no top-level subsystem:

- **Reason** — answerability-first placing is better routing (answer vs. name-the-pin).
- **Verify** — the KNOWN/UNKNOWN envelope + never-bluff-a-pin is the Verify discipline at answer time.
- **Converge** — per-domain calibration against resolution is the meta-loop learning from reality.

It is the single Convergence Core expressing itself as an answering interface — extension, not
addition.

## Sources (in-repo, verified on disk 2026-07-21)
- Seed: [`src/convergence/oracle.py`](../src/convergence/oracle.py) · [`apps/lantern-garage/lib/convergence-oracle.js`](../apps/lantern-garage/lib/convergence-oracle.js) · [`apps/lantern-garage/test/convergence-oracle.test.js`](../apps/lantern-garage/test/convergence-oracle.test.js)
- Move 1: council four-way verdict — [`apps/lantern-garage/lib/council-review.js`](../apps/lantern-garage/lib/council-review.js)
- Move 2: [`docs/convergence-io/DILATION.md`](convergence-io/DILATION.md) · [`apps/lantern-garage/lib/grounding-policy.js`](../apps/lantern-garage/lib/grounding-policy.js) · [`docs/SIGMA0-GROUNDING-LEDGER.md`](SIGMA0-GROUNDING-LEDGER.md)
- Move 3: [`src/convergence/grounding.py`](../src/convergence/grounding.py) · confidence-basis (#2803)
- Move 4: [`apps/lantern-garage/lib/grounding-calibration.js`](../apps/lantern-garage/lib/grounding-calibration.js) (#1011)
- Frame: [`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`](SIGMA0-COLLAPSE-CERTIFICATE.md) (the σ=0 / 42-state collapse) · [`docs/research/question-machine.md`](research/question-machine.md)
