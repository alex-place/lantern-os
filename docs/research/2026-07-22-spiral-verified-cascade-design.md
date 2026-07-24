# The Spiral Model — a design (recursive verified convergence)

**Status:** the design of record for **[ADR-0030](../adr/0030-spiral-verified-cascade-harness.md)**
(Accepted). Phase 0 (the verified-cascade harness) is implemented in
[`lib/spiral-harness.js`](../../lib/spiral-harness.js) +
[`lib/spiral-fix-rate.js`](../../lib/spiral-fix-rate.js). Phases 1–2 are gated
behind Phase-0 evidence.
**Honest scope up front:** this is a **specialist reasoning core** for *verifiable* domains (code, math),
not a general AI. General breadth stays **rented** (frontier models). Its value is making a **small model
(7–14B, 8GB-runnable) punch above its class via verified recursion** — landing the "better than Qwen2.5,
below Claude/Fable-5" gap, local. Its power is the **verifier**, not the parameters (ARC-Prize proved that).

---

## 1. Lineage: loop → TRM refinement → spiral

- **Loop** (Ouro / DEQ): drive a fixed-size state to a **fixed point** → collapses to the 42-state (your cert).
- **TRM** (7M, [2510.04871]): answer `y` improves over **K fixed steps** with an inner latent `z` recursion — an
  *inward refinement*, but **bounded**, fixed-size, and (ARC-Prize) largely **memorization** on narrow tasks; its
  halt is a **learned-confidence** head (`q_halt` predicts its own correctness).
- **Spiral** = TRM's recursive-improvement core **+ five changes** that make it unbounded, non-collapsing, and
  honest — and that move the source of generalization from *the weights* to *the verifier*.

## 2. Architecture — five modules

| module | what it is | grounded in | the delta |
|---|---|---|---|
| **M1 Growing verified memory** (the radius) | append a verified thought-slot each turn; attend over accumulated `M` | Titans / RMT / Tensor-Memory | writes are **verifier-gated** + **unbounded** (with retrieval + a cap vs the Titans-Revisited forgetting critique) |
| **M2 Recursive refiner = a *verified cascade* per turn** | the cheap tiny core proposes next `y`; if M4 says "not advanced," **escalate that turn** to a stronger/rented tier *inheriting the accumulated memory `M`* | **Policy-Guided Stepwise Routing [2605.06116]**, Cluster-Route-Escalate [2606.27457], escalation decision theory [2605.06350], our **live** verified cascade (#2800, 8.3× cheaper) | the refiner is **not one model** — it's cheap-first → verify → escalate-on-stall. This is *the cascade research, applied per turn*, and it's what makes the long spiral affordable |
| **M3 Rotational anti-collapse** | attend a *different aspect* each turn (rotational recurrence) + a novelty/isotropy term keeping `M` full-rank | **coRNN [2010.00951]** (coupled oscillators, *provably bounded* gradients + stable long-horizon), VICReg/SIGReg, your #768 non-normal dichotomy | the **certificate's positive dual** — now grounded, not speculative: coRNN proves bounded, non-collapsing long-horizon dynamics |
| **M4 Verifier-gated progress** | **replace TRM's learned `q_halt`** with a **real** verifier. Code per-step signal = **Fix Rate** (fraction of failing tests newly passed) **− regression penalty** | **SWE-Shepherd [2604.10493]**, **SWE-TRACE [2604.14820]** (step-level code PRMs), rStar-Math PPM, exec-verify (ours) | the **anti-memorization fix** + **source of generalization**. Concrete now: "did this patch advance?" = Δ(Fix Rate) ≥ 0 — computable, not a vibe |
| **M5 Answerability halt** | stop on verified-solved **or** answerability-declines ("honest can't") | PonderNet / ACT + the above-42 gate | honest termination, never bluff |

## 3. The forward pass

```
M ← [encode(problem)]
loop t = 0,1,2,…                          # unbounded, ONE problem
  a  ← ROTATE(focus)                                   # M3: next aspect
  # ── M2: the per-turn VERIFIED CASCADE (the cascade research, per step) ──
  m*  ← CHEAP.refine(x, y, z, read(M, a))              # owned tiny core (CPU / 8GB) tries FIRST
  adv ← VERIFY(m*, problem).fixRate ≥ 0                 # M4: Fix Rate − regression
  tier ← cheap
  if not adv:                                          # cheap stalled → escalate THIS step,
     m*  ← ESCALATE.refine(x, y, z, M)                 #   rented frontier — INHERITS full memory M
     adv ← VERIFY(m*, problem).fixRate ≥ 0             #   (progress preserved, not restarted)
     tier ← escalated
  # ───────────────────────────────────────────────────────────────────────
  if adv:                                              # commit the (possibly escalated) verified step
     M ← M ++ [ ANTICOLLAPSE(m*, M) ]                  # M1+M3: verified, decorrelated → grow radius
     y ← m*
     LOG(state, tier, verified=true, cost)             # → router corpus (#2820) + VTD trace;
  else:                                                #   escalated steps become distillation targets
     focus ← rotate / GROUND(external)                 # neither tier advanced → de-ratchet (freshness law)
  if HALT(solved | answerability): break               # M5
return decode(M, y)
```

## 4. The dynamics — where "monotone progress" actually comes from (honest)

A spiral = **rotation** (complex-eigenvalue recurrence, M3) + **radial progress** (M4). Non-collapse is by
construction (rotation + the isotropy term keep `M` off a point-attractor). **But monotone progress is NOT a
property of the model's dynamics** — the model may wander. **Progress is monotone because the *verifier* ratchets
it**: only verifiably-advancing steps commit to `M`. So the honest theorem is: *the committed trajectory is
monotone in the verifier's metric* — the model proposes, **reality ratchets**. This is the design's spine and its
one non-negotiable: **M4 must be a real, hard-to-game verifier** (code = yes; open-domain = the weak point).

## 4.5 Why the cascade makes the long spiral affordable — and the distillation flywheel

The ask is a spiral that works **one problem for very long**. Naively that's frontier-cost × many turns =
unaffordable. **The cascade is what makes the unbounded spiral economically real** — three jobs at once:

1. **Affordable long horizon (the sufficiency regime).** Most refinement steps are easy; the cheap tier clears
   them. Our **live** result: a strong cheap tier escalates ≈0% and runs **8.3× cheaper** (#2800). So "very long"
   = many cheap steps + a few escalated ≈ cheap. [Escalation decision theory 2605.06350] says *exactly when* to
   escalate: only where the cheap tier's expected verified gain < the escalation cost.
2. **De-risks the tiny-core bet (risk #0).** The tiny core need not solve everything. It handles what it can; the
   rest **escalate to rented frontier, inheriting the accumulated verified memory** (the grounded "preserve
   navigational progress" property). Floor = frontier quality (you can always escalate); you only *pay* frontier
   on the hard steps. A weak tiny core still yields a working system — it just escalates more often.
3. **The distillation flywheel (the self-improvement you asked for).** Every escalated step is a **frontier
   demonstration on a problem the cheap tier couldn't advance** — a *perfect* VTD target. Train the cheap tier on
   exactly those and **next time it does cheaply what it escalated for last time.** Escalation rate falls
   monotonically → cost falls → capability compounds. "Recursive self-improvement through convergence packs a tiny
   model with big-model coding ability," made concrete: the **cascade is the data-generator, the verifier is the
   label, VTD is the packer.** The one number that governs the whole business is the **escalation rate**, and it's
   designed to only ever go down.

## 5. Training — Verified-Trace Distillation (VTD)

Honestly scoped (nearest prior art, per the survey): VTD = **process-level RLVR expressed as a both-class
distillation loss with exec-verified per-step gating, over spiral-generated traces.**
- **Closest single work: rStar-Math** [2501.04519] — an MCTS *spiral* → step-verified traces → a **7B to
  o1-level MATH, no teacher distillation.** Proof the engine works at 7B.
- **Deltas** (what's actually new): the per-step judge is a **receipt/exec verifier** (not a model's Q-value or
  teacher-KL — cf. GateKD [2605.13136] confidence-gating, GRAIL [2606.04889] per-token advantage), **both-class
  step negatives kept** (cf. LENS [2510.08696], V-STaR [2402.06457]), folded into **one student loss**.
- **Why honest, not laundered:** unverified steps are never targets (Gekhman [2405.05904]: SFT on unknown facts
  *raises* hallucination). Reality confirms every distilled token.

## 6. Build order — de-risked, most value first

- **Phase 0 — the spiral as a *verified-cascade harness*** (M4+M5 wrapping a **two-tier cascade**: local/cheap →
  rented/escalation, per-turn routed, progress-inheriting). **No new weights** — this is *reassembly of parts we
  already shipped*: the live cascade (#2800), the router corpus (#2820), the constraint-aware tier picker (#2814),
  the verified ledger (#2797). Generates the verified-trace **+ escalation** corpus; **measurable on SWE-bench
  today.** *(This is what I actually recommended — and the cascade research is why it's already 80% built.)*
- **Phase 1 — VTD-specialize a 7–14B** (M2) on the Phase-0 traces. The "own weights" bet; single-GPU / cloud-burst.
- **Phase 2 — the novel arch** (M1 growing memory + M3 rotational recurrence as trainable modules), VTD-trained,
  from-scratch feasible at TRM scale (1× L40S, ~1000 examples + augmentation). **Only after Phase 1 proves the
  traces + method.** This is the ambitious piece — gated behind evidence, not built first.

## 7. Honest risks / what falsifies it  (web-grounded 2026-07)

0. **THE BIG ONE — tiny-recursive is unproven for code/language.** TRM/HRM are demonstrated on **puzzles/tabular
   only** (ARC/Sudoku/Maze; Tab-TRM [2601.07675]); the language extensions are *embryonic* (autoregressive-TRM
   [2603.08082], Mamba-TRM [2602.12078]). **There is no evidence a 7M–7B recursive core reaches useful CODE ability.**
   → *Hedge:* don't bet the code result on the tiny-recursive arch. Ground the **code** side on the proven
   **SWE-agent + step-PRM** lineage (Satori-SWE [2505.23604], Live-SWE-agent [2511.13646], SWE-Shepherd [2604.10493]).
   The spiral is the **synthesis of two lineages**: TRM = the tiny recursive *substrate* (proven for structure,
   unproven for code); SWE-agent-PRM = the verified *refinement* (proven for code). Phase 0 (harness) works
   **today regardless of the neural arch**, which is why it's first.
1. **The memorization trap (ARC-Prize):** without a *real* M4 verifier, the spiral just memorizes (HRM hidden-task
   ARC-AGI-2 = 2%). M4 is load-bearing — and now concrete (Fix Rate, SWE-Shepherd).
2. **Code per-step signal is noisier than math** — but it exists: Fix Rate (Δ failing→passing) with a regression
   constraint is a real computable metric; it's just fuzzier than an exact math check, so expect *lower vs frontier*
   on SWE than rStar-Math got on MATH.
3. **Unbounded memory saturates/forgets** (Titans-Revisited): cap + retrieve, don't grow naively.
4. **Phase 2 (the from-scratch arch) is high-risk / no tooling.** Phases 0–1 (harness + VTD on a real 7–14B) capture
   most of the value at low risk; Phase 2 is the research option, gated behind Phase-1 evidence, not the plan.

## 8. One line
**Spiral = a *verified cascade applied recursively* over a growing verified memory** — each turn the cheap owned
tiny-core refines, a real Fix-Rate verifier gates, and only on a stall does it **escalate to rented frontier
inheriting the accumulated progress**; unbounded, honest halt; trained by **VTD on the escalated (frontier) steps
it generates.** The cascade makes the long horizon affordable, turns every escalation into a distillation target,
and the one governing number — **escalation rate** — is designed to only fall. Generalization comes from the
verifier, not scale; home = verifiable domains on CPU / 8GB.
