# Owned Math M7 — Attribution loss: a structured counterexample to the composed control law

**Date:** 2026-07-24
**Type:** Research note — structured counterexample + impossibility lemma + shipped guard.
**Status:** [derived — proofs note Lemma 3] + [measured — this note, against SHIPPED code paths].
**Loop stage:** Converge (hardens the unified control law before it is wired into production).
**Slate:** [`2026-07-21-owned-math-conjectures.md`](2026-07-21-owned-math-conjectures.md) §M7 ·
**Proof:** [`2026-07-21-owned-math-proofs.md`](2026-07-21-owned-math-proofs.md) Lemma 3 ·
**Target:** [`converge-control.js`](../../apps/lantern-garage/lib/converge-control.js) (#2857, PR #2909) +
[`grounding-policy.js`](../../apps/lantern-garage/lib/grounding-policy.js) ·
**Machine check:** [`owned_math_m7_composition_counterexample.js`](../../experiments/owned_math_m7_composition_counterexample.js)
→ [`results JSON`](../../experiments/results/owned_math_m7_composition_counterexample.json)

---

## TL;DR

> The unified control law's headline guarantee — *"(a) KILL the confident-unanchored runaway
> (M6 lasing)"* — is **unsatisfiable over the law's own signal vocabulary**. Not a bug, an
> impossibility: M6's kill side-condition is **per-mode** ("G/L > 1 *and zero
> external-innovation coupling*"), but every signal the law reads is **global-per-step**. The
> structured counterexample is a two-world pair with *identical signal histories* — one
> genuinely anchored, one laundered — so no causal policy over those signals can kill one and
> spare the other (Lemma 3). Measured against the shipped code (first slate artifact to drive
> real code paths, not toy semantics): the laundered runaway survives **40/40 steps**, ending
> at confidence **0.9999986** having *never* received evidence, while the law's per-step reason
> reads **"improving on external evidence."** Worse, the composition actively **protects** the
> runaway: the shipped allocator's dilation is strictly decreasing in laundered confidence
> (D → 0.500001, the knife-edge of the `D > 0.5` fetch cutoff; any cost pressure or
> collapse-proximity pushes it under), so the snowball also **de-allocates its own audit**. The
> M2 hard cadence — proven *necessary* by M3 — is therefore **not sufficient**: cadence
> guarantees *a* grounding event; attribution decides *whose* claims get grounded. Fix shipped,
> default-compatible: a keyed anchor signal (`evidenceForMode`) restores M6-soundness (kill at
> step 1); the attribution vocabulary already exists in the ledger as **M1's paid/free
> confidence split**. Bonus finding: the converged-but-stale-and-broke cell emitted a
> self-contradictory record (`action: "halt_saturated"`, `saturated: false`, reason claiming
> saturation) — fixed.

---

## 1. The claim attacked

[#2857](https://github.com/alex-place/lantern-os/issues/2857) / PR #2909 landed the **unified
control law** composing the owned math into one per-step decision. Its header claims four
guarantees; the first is the one that justifies the composition's existence:

> "(a) KILL the confident-unanchored runaway (M6 lasing)"

and its rule 1 implements it as:

```js
if (gainOverLeak > 1 && !evidenceInflux) return kill;
```

The slate's own **M6 statement** is per-mode: *"modes with **G/L > 1 and zero
external-innovation coupling** grow without bound."* `gainOverLeak` is documented per-mode —
but `evidenceInflux` is documented as *"did external evidence arrive this step?"* — a global
disjunction over everything the run touched. The shipped unit test canonized the unsound
reading; its name asserts an attribution the signals do not carry:

> `"a lasing mode that IS externally anchored is not killed"` — tested as
> `{ gainOverLeak: 1.5, evidenceInflux: true } → not kill`.

Nothing in that input says the evidence anchored *that mode*.

## 2. The structured counterexample (two worlds)

Unlike M3's silent set (found by grid search), this counterexample is **constructed** — and it
is a *pair*, which is what makes it an impossibility rather than a tuning gap:

| | **World G (anchored)** | **World L (laundered)** |
|---|---|---|
| Modes | one: m₁ | two: m₁ (focal), m₂ (any subscribed feed) |
| Evidence for m₁ | **every step** (Bayes LR = g) | **never** — zero external-innovation coupling |
| Evidence for m₂ | — | every step (unrelated items) |
| m₁ confidence odds | × g per step (paid) | × g per step (self-repeat gain, free) |
| M6-correct action | continue | **kill** |
| **Signal vector, every step** | `{gainOverLeak: 1.4, evidenceInflux: true, confidenceRising: true, fixedPoint: false, stable: true, groundingDue: false, budgetRemaining: 100}` | **identical, coordinate by coordinate** |

The G/L estimator reads magnitude, not provenance; the influx bit is a disjunction; the rising
bit is the same arithmetic. Identical signal *histories* ⇒ any deterministic causal policy
(arbitrary memory allowed) acts identically ⇒ it is either unsound on L or vacuous on G.
That is **Lemma 3** ([proofs note](2026-07-21-owned-math-proofs.md)); the kill criterion for
the lemma and the reason it survives charitable readings are stated there.

The attack is cheap in practice: **any ambient evidence stream** — a subscribed feed, tool
heartbeats, another hypothesis's grounding — sets the global bit every step. Under ambient
influx, rule 1 is dead code: guarantee (a) was silently vacuous in exactly the environments
the product runs in.

## 3. Measured against the shipped code

`node experiments/owned_math_m7_composition_counterexample.js` — deterministic (no RNG, no
clock), `require`s the shipped modules directly.

**Part A — the law (legacy vocabulary).** Both worlds: action histogram `{continue: 40}`,
`first_kill_step: null`, identical traces confirmed. World L ends at confidence
**0.9999986** (odds 1.4⁴⁰ ≈ 836,683) with zero evidence ever attributed to m₁, and the
per-step reason is *"improving on external evidence."*

**Part B — the keyed guard.** With `evidenceForMode` (shipped this note): World L killed at
**step 1** with reason *"…mode-unanchored (global evidence present but none attributed to
this mode — M7 laundering guard)"*; World G: zero kills across 40 steps; calls that omit the
field reproduce the legacy behavior **exactly** (all 10 pre-existing unit tests unchanged).

**Part C — the starvation corollary.** With provenance-blind uncertainty u = 1 − c (what the
allocator sees when free confidence masquerades as knowledge), the shipped
`dilation(u, cp, c, p)` is **strictly decreasing in laundered confidence**:

| laundered c | D (cp=0, p=0) | fetchExternal |
|---|---|---|
| 0.5 | 1.000000 | true |
| 0.9 | 0.578947 | true |
| 0.99 | 0.507538 | true |
| 0.999 | 0.500750 | true |
| 0.9999986 | **0.500001** | true — by 1e-6, the knife-edge |
| 0.9999986, cp=0.1 | 0.454546 | **false** |
| 0.9999986, p=0.5 | 0.300001 | **false** |

At the limit the runaway sits on the `D > 0.5` cutoff; **any** positive cost pressure or
collapse-proximity puts it under — and a laser *self-repeats*, so the degeneration signal
plausibly reads p > 0, meaning the **G12 collapse-deflation double-starves it**. G12 is
correct for *verified*-frozen nodes (retrieval has no marginal value); for the laundered
laser the true marginal value of retrieval is maximal (one lookup refutes it), but estimated
γ → 0 because the estimate is provenance-blind. Same lemma, allocator layer.

De-laundered rows (attribution-aware uncertainty): anchored mass only (c = 0.5, u = 0.5) →
**D = 1.0, fetchExternal true**; never-verified reading (u = 1) → **D = 1.33, maxResults
5 → 7**. Attribution moves the runaway from knife-edge-zero grounding to ramp-grade scrutiny.

**Part D — the self-contradictory record.** Input `{fixedPoint: true, stable: true,
groundingDue: true, budgetRemaining: 0}` returned `action: "halt_saturated"` with
`saturated: false` and a reason claiming *"saturated and grounding budget exhausted"* — a
converged-but-stale state mislabeled as saturation in the very telemetry convergence records
are built from. Fixed: the reason now distinguishes the two states; the action name stays
`halt_saturated` (conservative — neither state has a fresh anchor, so neither earns
`halt_converged` trust).

## 4. The three-layer reading — one mechanism

| Layer | Component | What it reads | What laundering does to it |
|---|---|---|---|
| Kill | rule 1 (M6) | global influx bit | suppresses the kill forever |
| Allocation | dilation/water-filling (M5, G12) | u = 1 − c, provenance-blind | starves the runaway's verification |
| Cadence | M2 hard tick | *that* grounding happens | fires — but allocation routes it elsewhere |

One mechanism at every layer: **unanchored confidence masquerades as knowledge in each
component's input vocabulary.** The laundered runaway is not merely un-killed — it is a
*protected equilibrium* of the composed law: it suppresses its own kill switch and
de-allocates its own audit. And the slate's arc completes cleanly: **M3 proved the hard
cadence necessary; M7 proves cadence-plus-allocation without attribution still admits the
silent runaway** — necessary, not sufficient.

## 5. The fix and what it costs

- **Shipped (this note, default-compatible):** `evidenceForMode` — the keyed anchor. Kill rule
  becomes `G/L > 1 ∧ ¬E_mode`; omitted field falls back to the legacy global reading, so no
  caller changes semantics until it opts in. 5 new unit tests; 10 pre-existing tests
  untouched.
- **The attribution vocabulary already exists:** M1's ledger scan *already* splits paid vs
  free confidence mass (slate §M1: 20.8% free). Keying that split per mode is bookkeeping,
  not new theory: `E_mode(t)` = "the mode's **paid** mass moved this step."
- **Instrumentation ask (goes with #2791):** the M6 `CANARY_TRACE` per-generation trajectories
  must tag grounding events with the mode/hypothesis they anchor, or the keyed bit cannot be
  computed live. Same ask covers the allocator: u must be *anchored* uncertainty
  (1 − c_paid), not 1 − c.
- **Not changed here:** the M5 allocator itself (IP-gated per the register §6; the starvation
  finding is recorded as a requirement, not patched code).

## 6. Kill criteria (pre-stated, for M7 itself)

- **Lemma 3 (impossibility half)** dies if the two worlds are shown *not* co-reachable under
  the real M6 estimator — i.e., someone proves the shipped G/L measurement entangles coupling
  (anchored lasers cannot exist). The counterexample against the shipped global-bit rule
  **survives that** (World L exists regardless); only the "no policy can do both" half
  degenerates.
- **The guard** dies if per-mode attribution is unimplementable at the signal source (the
  #2791 instrumentation ask fails) — then the honest statement is that guarantee (a) must be
  withdrawn from the law's header, not that the global bit works.
- **The starvation corollary** dies if the deployed uncertainty estimate is shown to already
  be attribution-aware (it is not, today: `chatDilation` derives u from surface features and
  `dilation` takes raw confidence).

## 7. Prior art, named

Discrete-event **fault diagnosability** (Sampath et al., 1995) — a fault is diagnosable only
if no arbitrarily long faulty trace is observation-equivalent to a nominal one; W_G/W_L are
exactly such a pair, so M7 is a diagnosability failure of the signal map, cured by
*relabeling* (attribution), not policy cleverness. Static-output-feedback distinguishability
is the control-theory cousin. Reward-hacking of anchoring checks is the RL-flavored analogue.
**M3's Lemma 2 is the sibling one level down** — passive internal functionals cannot separate
grounded from ungrounded *trajectories*; global step-signals cannot separate anchored from
laundered *gain*. **Ours:** the instantiation on the shipped law, the executable two-world
artifact against real code paths (a first for the slate — M3/M4 used toy instrument
semantics), the starvation corollary tying M5/G12 into the same mechanism, and the
default-compatible guard with the M1 paid/free split as the attribution vocabulary.

## 8. Honest scope

- The impossibility is **relative to the signal map** as typed in the shipped law. A richer
  map dissolves it — that is the point: the fix is a vocabulary fix.
- The knife-edge at exactly cp = 0, p = 0 leaves `fetchExternal` true by ~1e-6; the starvation
  claim at that corner is "minimum-grade grounding on a knife-edge," not "zero." Every
  perturbed cell (cp > 0 or p > 0) is a hard `false`.
- The confidence arithmetic (odds × g) is illustrative; the law reads only the rising *bit*,
  so no modeling choice there carries proof weight.
- The two worlds are *signal-level* constructions. Whether the production M6 estimator, once
  instrumented (#2791), emits G/L > 1 for genuinely anchored modes is an open empirical
  question — Lemma 3's honest-scope paragraph covers both outcomes.
- No new subsystem: one optional field on an existing pure function, docs, tests, and one
  experiment file.
