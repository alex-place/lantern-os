---
author: Alex Place
created: 2026-06-22
updated: 2026-06-22
---

# The Frozen-Weights, Memory-Grounding Convergence Loop

> **One line:** the *safe, on-canon* form of a continuously-improving convergence loop —
> **neural weights frozen**, everything that adapts living in **append-only memory +
> retrieval + calibration**, **re-grounded in external reality every interval**, with the
> Σ₀ canary forcing a re-ground when a step starts to collapse.

> **Reading contract.** Per the External Reality Rule, every status claim below is
> **[verified]** against live code (file:line cited), **[grounded]** in the certificate /
> literature, or **[design]** (intended, not yet built). Audited 2026-06-22 against
> `origin/master`.

**Reads first:** [CONVERGANCE-SIGMA0-BRIEFING](../CONVERGANCE-SIGMA0-BRIEFING.md) (North Star) ·
[SIGMA0-COLLAPSE-CERTIFICATE](../SIGMA0-COLLAPSE-CERTIFICATE.md) ·
[KEYSTONE-LIMITATIONS](../KEYSTONE-LIMITATIONS.md) ·
[convergence-core-agent-spine](2026-06-19-convergence-core-agent-spine.md) §6.5

---

## 0. Why this design (and not the other one)

A *fully-online weight-updating* convergence loop is exactly the failure mode the
[Σ₀ Collapse Certificate](../SIGMA0-COLLAPSE-CERTIFICATE.md) §7 was written to warn against:
ungrounded recursion **collapses** onto a degenerate fixed point (the "42-state") or
**diverges**. Two facts settle the design:

1. **Stopping at intervals does not bound the dynamics.** Collapse/divergence is a *spectral*
   property of the map (`max Re λ(A) < 0`), independent of step size; and model collapse is
   *itself* the discrete-generation phenomenon — intervals are the setting collapse was
   demonstrated in, not the cure. **[grounded]**
2. **The lethal failure is *bounded*.** Collapse is the non-expansive projection `x*=Px`
   (`‖Px‖ ≤ ‖x‖`) — perfectly bounded, perfectly dead. So "it won't run away" is necessary,
   not sufficient. **[grounded]**

What actually bounds the loop is **external grounding** (the certificate's one-line thesis:
*"Grounding is the safety mechanism."*). The interval is merely *when you get the chance to
re-ground*; the grounding injected is the bound. Therefore the safe loop keeps **weights
frozen** and adapts only in **memory + retrieval + calibration**, re-grounded each interval.
Capability is bought by *which frozen model plugs in* (the offline, eval-gated specialist),
not by online retraining — consistent with North Star principle 5 ("never retrain").

---

## 1. The loop, concretely

```
 Observe ─► Remember ─► Reason ─► Act ─► Verify ─► Converge
    │          │          │        │       │          │
 temporal-   append a   consult   gate    grade vs   record
 band re-    memory +   trust(k)  Act on  external   grounding
 ground      conv-      (frozen   ground- truth      outcome →
 (web +      record     weights)  ing                update trust
 deep res.)  (interval)           floor              (interval)
```

- **Frozen weights:** the served model is a static artifact (base + read-only adapter),
  `model.eval` + `torch.no_grad`, no optimizer in the serving path.
- **The "weights" that move every interval** are *non-parametric*: the append-only memory,
  the retrieval/temporal-band index, and the **Beta-posterior trust weights** in
  [`grounding-calibration.js`](../../apps/lantern-garage/lib/grounding-calibration.js)
  (`trust = (1+hits)/(2+n)` — a pure, replayable function of the grounding log).
- **Re-ground every interval:** each tick pulls external evidence (web / deep research,
  temporal-band-anchored), verifies, writes a convergence record, updates trust.
- **Σ₀ guard:** the surprise/decode canary trips on a collapsing/over-confident step and
  deflates the dilation budget toward "stop and go re-ground."

---

## 2. Status — what's built vs. what's wiring (verified 2026-06-22)

| Primitive | Status | Reality (file:line) |
|---|---|---|
| **Frozen neural weights** | ✅ **done** | Load-once + `model.eval` + `torch.no_grad`, no optimizer/backward in serving. [`ouro_serve.py:99-129`](../../scripts/ouro_serve.py), [`loop_lm.py:303`](../../src/sigma0/loop_lm.py) |
| **Append-only memory / interval** | 🟡 partial | Conversation memory appended every turn; **Convergence Record only on `!`-commands**, not normal replies. [`stream-chat.js:1155`](../../apps/lantern-garage/lib/stream-chat.js), [`convergence-records.js:37`](../../apps/lantern-garage/lib/convergence-records.js) |
| **Fast-layer calibration** | 🟠 built, **not wired** | Math + log + HTTP endpoints built; `trust(key)` has **zero callers**; `recordGrounding` fires only from a manual POST, never from loop outcomes. [`grounding-calibration.js`](../../apps/lantern-garage/lib/grounding-calibration.js), [`convergence-dispatch.js:656-669`](../../apps/lantern-garage/routes/convergence-dispatch.js) |
| **Grounding gate on Act** | 🟠 built, **not wired** | `groundingPolicy` returns `minSources`/`deepMode` but stream-chat uses only `maxResults`; grounding is **non-fatal** (never blocks). [`grounding-policy.js:29`](../../apps/lantern-garage/lib/grounding-policy.js), [`stream-chat.js:794`](../../apps/lantern-garage/lib/stream-chat.js) |
| **Σ₀ canary on the loop** | 🟠 built, **not wired** | Real + tested at the *decode* layer, but `OURO_NATIVE`/`OURO_ADAPT` default off, telemetry is print-only (not in HTTP body), JS loop reads only `message.content`; cloud-default chain has no canary. [`surprise.py`](../../src/cio_sde/surprise.py), [`decode_canary.py`](../../src/sigma0/decode_canary.py), [`dream-chat.js:846`](../../apps/lantern-garage/lib/dream-chat.js) |
| **Loop closes on chat + temporal-band retrieval** | 🟡 partial | Loop closes **only for Kalshi**; chat records written **ungraded**. `TemporalBand` exists, not in answer path. [`observer-engine.js:347`](../../apps/lantern-garage/lib/observer-engine.js) |

**Headline:** the hard part — *actually frozen weights* — is done and enforced. The entire
adaptive layer is built and unit-tested **as primitives but not wired into the live loop**.
This is a wiring job, not a build-from-scratch.

---

## 3. The keystone wire

The single most important connection is already half-built:
[`grounding-policy.js`](../../apps/lantern-garage/lib/grounding-policy.js) exposes a
`collapseProximity` argument that **deflates the time-dilation budget toward "stop and
go re-ground"** as proximity → 1 — exactly the re-grounding reflex this design needs. But
[`stream-chat.js:795`](../../apps/lantern-garage/lib/stream-chat.js) calls it with
`collapseProximity` **hardcoded to 0**. Connect a real collapse signal to that one argument
and the reflex turns on.

---

## 4. Wiring ladder (ordered by leverage)

Every step is *connect existing tested parts*, not a new subsystem.

### Step 1 — write + adapt every interval (provider-agnostic; the chosen option, made real)
1. Emit a **Convergence Record on every reply**, not just `!`-commands.
2. Fire `recordGrounding({key, predicted, outcome})` from outcomes the loop **already
   produces** — web-search hit/miss, tests-passed.
3. **Consult `trust(key)`** in the confidence/route path instead of the hardcoded heuristic.
4. Add the **missing unit tests** for `grounding-calibration.js`.

→ This *is* "re-ground into memory/retrieval every interval" with frozen weights, and it
works on the cloud-default chain too (no model-side canary required).

### Step 2 — make it fail-safe (the Σ₀ guard)
5. Return canary proximity from `ouro_serve` → parse in JS → feed as `collapseProximity`
   (the keystone wire).
6. For the cloud default (no token canary), add a **post-generation degeneration /
   over-confidence detector** to populate the same proximity (the grounding-policy comment
   already anticipates this).
7. Enforce the `GroundingPolicy` floor (`minSources`/`trust`) before an action commits →
   ungrounded/low-trust step forces stop-and-reground.

### Step 3 — richer grounding + proof
8. Wire `TemporalBand` retrieval into the answer path (temporal-band-anchored evidence).
9. Grade chat records per turn (close Verify→Converge beyond the Kalshi slice).
10. **Measure grounded-vs-cold lift** (Gate B) — prove the loop helps, not assert it.

---

## 5. Measurement plan (so "it helps" is earned)

| Metric | Meaning | Source |
|---|---|---|
| **Global Brier** | calibration quality of asserted confidence | `grounding-calibration.calibration()` |
| **trust(key) drift** | does measured source/provider trust move with evidence? | grounding log |
| **grounded-vs-cold lift** | accuracy with grounding ON vs OFF on a held-out set | `eval_keystone` / leaderboard |
| **collapse incidents** | canary spooks per N turns; re-grounds triggered | canary telemetry |
| **records closed** | fraction of convergence records graded (not just Kalshi) | convergence records |

A change that doesn't move Brier or lift is not landed — it's logged and reverted.

---

## 6. Where this sits in the program

This is the **runtime** half of the model program:

- **Brain (offline):** a ≤8B domain specialist, cloud-shaped by distillation + SFT/DPO on
  verified data, **eval-gated and frozen** (the continual-training flywheel) — never online.
- **Runtime (this doc):** frozen weights + per-interval memory-grounding + Σ₀ guard.

Together: *cloud-shape offline behind an eval gate, run local behind the grounded loop.*

---

## 7. Honest scope

- This is **not** an AGI and **not** an online weight-self-improving loop — by design, and
  per the North Star. It is a **durable, bounded, trustable** local agent.
- "Grounding bounds the loop" is proven closed-form only for the normal-`A` case (the L2
  lemma); the broader Σ₀⁻¹ prevention is **measured** (900-run sweep, 100%), not a full
  theorem. The wiring here operationalizes a measured-and-grounded mechanism, not a proof.
- The cloud-default provider chain has **no token-level canary**; its fail-safe guard
  depends on the post-generation detector (Step 2.6), which is **[design]**, not yet built.
- The win condition is **reliability**, not raw IQ: fewer *unsafe* (silent / runaway /
  ungrounded) errors than a frontier cloud model — measured (§5), not asserted.

---

## Sources (audited on disk 2026-06-22)

- Frozen weights — [`scripts/ouro_serve.py`](../../scripts/ouro_serve.py) · [`src/sigma0/loop_lm.py`](../../src/sigma0/loop_lm.py)
- Memory + records — [`apps/lantern-garage/lib/convergence-records.js`](../../apps/lantern-garage/lib/convergence-records.js) · [`stream-chat.js`](../../apps/lantern-garage/lib/stream-chat.js)
- Calibration — [`apps/lantern-garage/lib/grounding-calibration.js`](../../apps/lantern-garage/lib/grounding-calibration.js)
- Grounding policy / dilation — [`apps/lantern-garage/lib/grounding-policy.js`](../../apps/lantern-garage/lib/grounding-policy.js) · [`src/convergence_io/dilation.py`](../../src/convergence_io/dilation.py)
- Canary — [`src/cio_sde/surprise.py`](../../src/cio_sde/surprise.py) · [`src/sigma0/decode_canary.py`](../../src/sigma0/decode_canary.py)
- Temporal bands — [`apps/lantern-garage/lib/observer-engine.js`](../../apps/lantern-garage/lib/observer-engine.js)
- North Star + certificate — [`docs/CONVERGANCE-SIGMA0-BRIEFING.md`](../CONVERGANCE-SIGMA0-BRIEFING.md) · [`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`](../SIGMA0-COLLAPSE-CERTIFICATE.md)
</content>
