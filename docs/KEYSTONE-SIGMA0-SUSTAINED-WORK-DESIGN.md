# Keystone-Σ₀: self-converging local kernel + chat harness for sustained autonomous work

> **Status:** Internal design document (design-only; proposes no merge by itself). Solo developer (Alex Place), Keystone OS.
> **Method & integrity rule.** Follows the same discipline as [FRONTIER-DIRECTIONS-2026-H2.md](FRONTIER-DIRECTIONS-2026-H2.md): every important claim carries `[claim, evidence, confidence, source]`, and where an earlier "ahead" framing was refuted this document adopts the corrected verdict. Nothing here auto-promotes a model or opens a valve — each step is evidence-gated.
> **Governing ADRs:** [ADR-0011](adr/0011-proprietary-sigma0-base-model.md) (own the Σ₀ base, Proposed), [ADR-0010](adr/0010-verify-gated-continual-learning-last-resort.md) (adapter-only, frozen base, Proposed), [ADR-0005](adr/0005-interchangeable-model-providers.md) (models interchangeable), [ADR-0009](adr/0009-one-routing-contract-cloud-primary-coding.md) (cloud-primary coding contract).

---

## 0. One paragraph

The three things asked for — **Keystone chat**, the **new Σ₀ model**, and the **adapter based on loopcoder** — are not three independent builds. They are one move: make the local kernel *self-converging* (it knows its own depth, when it has halted, and how uncertain it was), and then **wire those signals all the way up** through serving → registry → chat → canaries → the autonomous-work loop. The payoff is *sustained* work, because a long-running loop only stays alive if its pump (Reason) spends compute adaptively and its leak (Verify) actually drains uncertainty. Today the kernel already emits these signals for Ouro (`src/sigma0/loop_lm.py`, `src/sigma0/decode_canary.py`, `ouro_serve.py`'s `x-ouro-depth` header) — but the owned PLT base can't yet (Stage 0 parity unproven). On the Verify side the surprise leak is **already wired and fed on master** (#1678 valve + #1673/#1676/#1681 calibration) — it now only awaits the *local serving emit* of per-token logprobs (Track M). What remains genuinely open for sustained work is the **Converge** side: the loop has **no way to recover from a wedge or notice its own decay** (this session adds the first — the wedge-recovery ceiling; the drift monitor is next). This design closes those three gaps without adding a subsystem.

---

## 1. Thesis — the loop is a pumped, lossy resonator

From the North Star: the whole product is **one loop** — Observe → Remember → Reason → Act → Verify → Converge. The mental model that makes *sustained* operation precise is a **pumped lossy resonator** ([[pumped-lossy-resonator-principle]]): an oscillation only sustains if it is **pumped** (energy in — Observe/Reason) and it **leaks** in a controlled way (energy out — Verify). Two failure modes bracket it:

- **Starvation / death** — the pump stalls (the loop wedges, or burns its whole budget on easy tokens) and the oscillation dies out.
- **Collapse / runaway** — the leak is plugged (uncertainty never drains), confidence compounds, and the output degenerates (phrase-loops, confident hallucination).

A model that runs a **fixed** number of loops and exposes **no** internal uncertainty cannot pump adaptively or leak — so a sustained autonomous loop built on it inevitably drifts toward one of the two failure modes. The fix is a kernel that is *self-converging*: it decides its own recurrent depth, emits a **halt / convergence certificate**, and reports **per-token surprise**. Those three signals are exactly the pump-control and the leak-valve the resonator needs.

The three asks map onto this cleanly:

| Asked for | What it is | Loop stage(s) | The sustained-work failure it removes |
|---|---|---|---|
| **New Σ₀ model** | Keystone-Σ₀ PLT — own the LoopCoder-V2 forward, frozen base (ADR-0011) | **Reason** | A rented kernel whose forward we can't change → can't add a halt signal or fit the 8 GB box |
| **Adapter based on loopcoder** | **Adaptive Loop Gate (ALG)** — trained halt head + loop gate over the frozen PLT base | **Reason + Converge** | Fixed depth 2 burns compute on easy tokens and has *no native "I'm done" signal* |
| **Keystone chat** | The harness that *consumes* depth + halt + surprise + canary telemetry to route / escalate / abstain | **Verify** | The surprise-leak valve is installed but never fed → uncertainty never drains; the loop can't notice its own decay or recover from a wedge |

---

## 2. The issues, grounded (file:line)

Everything below is in the working tree today; line numbers are approximate anchors.

### Issue A — The Reason stage spends fixed compute and emits no convergence certificate
- LoopCoder / the owned PLT base run a **fixed** `plt_num_loops = 2` (`models/keystone-sigma0-plt/modeling_keystone_plt.py` `_run_loops`, ~`:310`; `configuration_keystone_plt.py:94`). The readout always returns `h₂`.
- The Ouro path already does better: `Sigma0LoopLM.generate(mode="qexit")` exits per-token when the trained gate's CDF ≥ q (`src/sigma0/loop_lm.py:179-193`), with `converge` and `accel` fallbacks (`:201-245`). **But the owned PLT base has no equivalent**, and non-self-converging models in chat get wrapped in a *fixed*-depth loop reasoner (`local-model-registry.js` `selfConverges:false` → `lib/loop-reasoner.js`) with **no early exit**.
- Net: on the owned kernel, easy tokens cost as much as hard ones, and nothing downstream can ask "did the model converge, or did it run out of loops?"

### Issue B — The Verify leak valve (✅ already SHIPPED on master — open only on the stale release branch)
> **Correction (2026-06-30).** The runtime maps for this design were taken against the
> `claude/unisona-1.8-release` branch, which is **behind master** on exactly these files.
> On `master` this issue is **already fixed** and I am **not** rebuilding it:
> - `stream-chat.js` already feeds the valve: a `streamSurprise.createSurpriseAccumulator()`
>   is filled during streaming and read once in `sendDone` as `tokenSurprise: surprise.value()`
>   (#1678), gated by `SURPRISE_CANARY`, graceful no-op when no logprobs.
> - `token-surprise.js` `fieldToUncertainty` is already a **per-model-calibrated logistic on
>   the mean/p90 blend** (#1673/#1676/#1681), AUROC 0.77/0.81 — tailMass is demoted to a
>   reported-only field, exactly the recalibration this design called for.
>
> What it *looked like* on the stale branch (for the record): `modelUncertainty` hard-0
> because `runCanaries` was called without `tokenSurprise`, and `fieldToUncertainty` was
> `0.7·tailMass + 0.3·p90` — with tailMass AUROC ≈ 0.50 (chance) vs mean/p90 ≈ 0.76–0.79
> ([[surprise-leak-layer1-result]]). Both are resolved on master. **No action; do not revert.**

### Issue C — The Converge stage can't sustain: it wedges, decays silently, and doesn't compound
- **Wedge (loop death).** `auto-dispatch.js` serialises one run at a time via an `inFlight` flag persisted to `state.json` (`:42,200,217,252`). If a run crashes mid-tick, `inFlight` is never cleared and **every future tick is blocked forever** — there is no staleness reset (`lastTickAt` is loaded but not used to expire a stale lock). [confidence 0.9, sustained-work map]
- **Silent decay (no drift sensor).** Canaries fire **per-reply** (`canary.js`, `collapse-canary.js`, `groundedness-canary.js`) and write append-only events, but **nothing watches the trend** — no aggregator alarms on rising collapse-proximity, rising council dissent, or falling exec-pass-rate over hours. A long run can degrade without any single reply tripping a threshold. [confidence 0.85, sustained-work map]
- **No compounding.** `data/convergence/records.jsonl` is plain mutable JSONL with no chain (`grep prev_hash|merkle|sha256` = 0 hits; `src/convergence/objects.py::to_jsonl` ~`:183-199`), and there is **no measured self-improvement signal** — SWE-bench is 🟡 in `docs/BENCHMARKS.md` with no resolved% ever posted. So "the loop is getting better" is unfalsifiable. [confidence 0.85, FRONTIER-DIRECTIONS §5a]

### What's *already* solid (so we extend, not rebuild)
- Adaptive depth + per-token canary + telemetry **exist and are live for Ouro**: `Sigma0LoopLM` (Q-exit/converge/accel), `decode_canary.py` (self-repeat, n-gram echo, entropy z-alarm, Σ₀ SurpriseMonitor proximity), `quantized_cache.py` (int8 KV), and `ouro_serve.py` which serves them with `mean_depth`, `canary_max_proximity`, and an `x-ouro-depth` response header (`ouro_serve.py:185-209,236-265,372-377`).
- The collapse canary was just hardened for multi-word phrase-loops (peak penalty gated on low TTR, `collapse-canary.js:~128-131`, #1609; block threshold 0.5, mid-stream guard 0.85).
- The council answerability gate already lets **execution override text** and emits `seam_open`/`pin` verdicts (`council-review.js:~110-121`).
- The web-search DNS hang is already fixed with wall-clock deadlines (`autowork-research.js`, `wide-search.js`).
- `loopcoder-v2` is already a registry entry, correctly `verified:false` until a probe earns it (`local-model-registry.js:131-149`).

**Implication:** the design's job is to (1) bring the *owned* PLT base to the same self-converging standard the Ouro path already meets (via the ALG adapter), and (2) carry the signals that already exist at the kernel up through the layers that currently drop them.

---

## 3. The unified design

One new contract ties the three artifacts together.

### 3.0 The Σ₀ telemetry envelope (the single new wire)

Every local-kernel response carries a small, typed envelope — an **extension** of the existing `x-ouro-depth` header and the `reply.surprise` field, not a new object:

```
Σ₀Telemetry {
  depth:        number   // realized recurrent depth (Ouro: mean_depth; PLT/ALG: expected d ∈ [0,2])
  halted:       bool     // did the convergence certificate fire (Q-exit CDF≥q / ALG halt) vs hit the cap?
  haltConf:     number   // the certificate's confidence at exit
  surprise:     { nTokens, meanBits, p90Bits, maxBits }   // per-token logprob summary (NO tailMass as a driver)
  canaryProx:   number   // decode-time collapse proximity (0 healthy … 8 collapse), if local
  source:       string    // model id + serving mode
}
```

It flows: **serving endpoint** (`ouro_serve.py` / the PLT serve stage) → **Node adapter** (a thin reader in `serving-modes.js` / the registry call site) → **chat** (`stream-chat.js`) → **canaries + council** → **autowork**. This is the spine of the whole design; each artifact below either *produces* or *consumes* it.

### 3.1 The Σ₀ model — Keystone-Σ₀ PLT (own the Reason substrate)

No change to ADR-0011's plan; this design depends on it and sequences behind it.

- Own `modeling_keystone_plt.py` (the hand-port of the PLT forward); bootstrap from the Apache-2.0 LoopCoder-V2 weights via `download_and_patch.py`; **Stage 0 = parity** (`check_parity.py`: weight-key match + coherent smoke + optional vLLM `top1_agree ≥ 0.99`).
- **Stage 0 blocks everything on the model side.** It needs a ≥24 GB GPU (bf16) for the truest check — not available on the 8 GB authoring box — so the entire model/adapter half of this design is **design + default-off code** until parity passes on a cloud/borrowed GPU. The runtime half (§3.3, §3.4) does not depend on Stage 0.
- Once parity passes, the base registers in `local-model-registry.js` as one more VRAM-gated, **`verified:false`** entry that cannot lead until a reproduced eval beats the incumbent (Qwen2.5-Coder). This is identical to how `loopcoder-v2` is gated today.

**Loop stage:** Reason. **Sprawl check:** extends the existing local-model adapter + serving path; no new ecosystem.

### 3.2 The adapter based on loopcoder — the Adaptive Loop Gate (ALG)

This is the heart of the ask: the "adapter based on loopcoder" is the [Adaptive Loop Gate](../models/keystone-sigma0-plt/ADAPTIVE-LOOP-GATE.md) — adapter-scale heads over the **frozen** PLT base that give it the self-converging behaviour the Ouro path already has, so the owned kernel becomes a first-class resonator.

- **Mechanism (already specified in ALG.md):** capture the per-loop post-norm states `h₀ = norm(E)`, `h₁`, `h₂`; a tiny `loop_gate: Linear(hidden→3)` produces a softmax mixture at train time (the differentiable "superposition"), and a `halt_head: Linear(hidden→1)` produces ACT-style per-boundary halting at inference. Expected depth `d = w₁·1 + w₂·2 ∈ [0,2]`; a ponder cost `λ·d` teaches "use depth 2 only when you must." The cap of 2 is the empirically-validated PLT ceiling (>2 regresses).
- **Why this *is* the convergence certificate:** the halt head is to the PLT base exactly what Ouro's trained Q-exit gate is to `Sigma0LoopLM` — a learned, native "I have converged" signal. It populates `Σ₀Telemetry.halted/haltConf/depth`. This is the unification: **one self-converging contract, two looped backends (Ouro Q-exit; PLT ALG-halt).**
- **The runtime adapter (the Node + serving glue), to mirror the existing Ouro stack:**
  - **Serving:** the PLT serve stage emits the envelope the same way `ouro_serve.py` does — depth header + per-token logprobs in the response. Reuse `decode_canary.py` for `canaryProx` (it is model-agnostic — it reads logits/tokens, not Ouro internals).
  - **Bridge:** for tool-use, reuse `ouro_anthropic_bridge.py` unchanged (it already injects tools, parses `<tool_call>` from free text, and supports forced `tool_choice`). The PLT base is `toolCalling:false` initially → it routes through the same bridge/loop-reasoner path that Qwen does.
  - **Registry:** the ALG-equipped base registers with `selfConverges:true` **only after** the §9 eval gate of ALG.md passes (beats fixed-1-loop, matches fixed-2-loop, mean depth < 2). Until then `selfConverges:false` and it is wrapped like any single-pass model.
- **Default-off ⇒ parity-safe.** `plt_adaptive=False` returns `h₂` byte-identical to today. The ALG code can be written in parallel with Stage 0 (it is inert until the flag flips) but is **not trained or trusted** until parity passes — Stage 0 blocks Stage 1.

**Loop stage:** Reason (adaptive depth) + Converge (halt = native convergence certificate). **Sprawl check:** an additive `nn.Module` on the existing PLT port; adapter-only per ADR-0010; no new serving path (reuses `ouro_serve.py`/bridge pattern).

### 3.3 Keystone chat — the harness that consumes the certificate

Chat stops being a dumb pipe to a provider and becomes the **resonator controller**. It reads `Σ₀Telemetry` and applies deterministic policies. All of these are *extensions* of code that exists.

1. **Adaptive local-first routing (pump control).** The capability-gated local-lead resolution (`local-model-registry.selectChain` / the `resolveLocalLead` path, [[keystone-chat-model-swap-wired]]) already picks a VRAM-fit local model for the intent. Add: when the chosen local kernel is self-converging and `halted=true` with low `depth` and low `surprise`, **answer locally** (cheap convergence — the pump spent little). This is the cost win the fixed loop can't deliver.
2. **Open the leak valve (Issue B) — ✅ DONE on master.** Already shipped: `stream-chat.js` feeds `tokenSurprise: surprise.value()` into `runCanaries` (#1678), and `token-surprise.js` `fieldToUncertainty` is a per-model-calibrated mean/p90 logistic (#1673/#1676/#1681). RAISE-ONLY, graceful no-op when surprise is absent. The remaining dependency is purely the **local serving emit** of per-token logprobs (Track M) — the consumer side is complete.
3. **Fidelity escalation (nested adaptive Reason, [[nested-adaptive-reason-design]]).** If the kernel hits the depth cap *without* halting (`halted=false, depth=cap`) **or** surprise is high after the valve opens, escalate this turn to a higher-fidelity member (cloud) — one Reason stage, canary-gated, not a second engine.
4. **Adaptive serving mode, not env-only.** Today FAST (2 s) vs DEEP (120 s) is env-only (`serving-modes.js`), so interactive chat times out long reasoning mid-thought. Let the certificate pick: a turn the kernel can halt on stays FAST; a turn that needs depth gets the DEEP budget. (Bounded; default unchanged when telemetry is absent.)
5. **Tool-loop bound by convergence, not a magic number.** The native tool loop is hard-capped at 5–6 iterations (`stream-chat.js` per-provider `MAX_TOOL_ITERS`). Keep the hard cap as a backstop, but allow an *early* exit when the kernel halts with low surprise and no pending tool call — so the cap stops being the only stop condition.

**Loop stage:** Verify (valve), with Reason routing. **Sprawl check:** every item edits an existing call site; no new module.

### 3.4 The sustained-work spine — close the three Converge gaps

These are the changes that make a *long* run survive, and they are the **most buildable today** (no GPU, no Stage 0 dependency).

1. **Wedge recovery (Issue C / loop death).** In `auto-dispatch.js`, expire a stale `inFlight` lock: if `inFlight=true` but `now − lastTickAt > STALE_MS` (e.g. 2× the dispatch budget), reset it and log a `wedge_recovered` convergence record. Keeps the pump from dying on a single crashed run. *(buildable now)*
2. **Resonator health monitor (Issue C / silent decay).** A small rolling aggregator over the existing append-only streams (`canary-events.jsonl`, `council-reviews.jsonl`, autowork run logs) that tracks **trends**: mean collapse-proximity, council dissent rate, exec-pass-rate, and (once the valve is open) mean surprise — per N-record window. When a trend crosses a band, it emits a `drift` convergence record and (operator-gated) **pauses dispatch and reseeds** rather than letting the loop grind downhill. This is the macroscopic analogue of the per-token `decode_canary` — same idea, longer timescale. *(buildable now; this is the single highest-leverage sustained-work addition)*
3. **Patch abstention (Issue B applied to Act).** In autowork, when the proposing model's `surprise` is high (valve open) or the council returns `seam_open`, the run **abstains** — it records the attempt but does **not** open a low-confidence PR. This is FRONTIER-DIRECTIONS §5c's "same wire," and it directly reduces fleet slop on long unattended runs. *(buildable once the valve is recalibrated; cloud-only runs degrade gracefully to council-only abstention)*
4. **Compounding signal (deferred, gated).** Hash-chain `ConvergenceRecord` (`prev_hash`/`record_hash`, JS + Python parity) and post a **measured** SWE-bench resolved% on a frozen slice so self-improvement is a *delta over epochs*, not an assertion. This is real but heavier (WSL2/Docker) and explicitly **not** required for the resonator to sustain — list it as the Converge follow-on, not a blocker.

**Loop stage:** Converge (+ Act for abstention). **Sprawl check:** all extend existing logs/dispatch; no new store or engine.

---

## 4. Feature-gate table (name the loop stage or reject it)

| Change | Loop stage | Status | Depends on |
|---|---|---|---|
| Own PLT forward + Stage-0 parity | Reason | design + code (ADR-0011) | ≥24 GB GPU |
| Adaptive Loop Gate (halt head + loop gate) | Reason + Converge | design (ALG.md), default-off code | Stage 0 PASS |
| `Σ₀Telemetry` envelope (extend `x-ouro-depth`/`reply.surprise`) | (carrier) | extend | serving emits it |
| Recalibrate `token-surprise.js` → mean/p90 | Verify | ✅ **shipped on master** (#1673/#1676/#1681) | — |
| Open the valve (`stream-chat.js` → `runCanaries`) | Verify | ✅ **shipped on master** (#1678) | local logprob emit (Track M) |
| Adaptive serving mode + early tool-loop exit | Reason | extend | telemetry present |
| Fidelity escalation on no-halt / high-surprise | Reason | extend | telemetry present |
| `inFlight` staleness reset (wedge recovery) | Converge | ✅ **built this session** (R3) | — |
| Resonator health / drift monitor | Converge | **buildable now** | existing logs |
| Patch abstention on high surprise / `seam_open` | Act + Verify | buildable (valve done) | — |
| Hash-chained record + SWE-bench delta | Converge | deferred follow-on | WSL2/Docker |

Anything not in this table that doesn't name a stage is rejected as sprawl.

---

## 5. Honest positioning (External Reality Rule)

- **No "ahead/parity" capability claims.** Per FRONTIER-DIRECTIONS, all four "ahead" headlines were refuted. The owned kernel's edge is **ownership + local-first + a working self-converging loop**, not invented capability. Adaptive recurrent depth (ACT/Universal-Transformer/Ouro Q-exit) and logprob-based uncertainty are prior art; we are integrating, not inventing.
- **The surprise signal is a first-line flag, not an oracle.** Raw per-token surprise AUROC ≈ 0.76–0.81 is at/below NLI/semantic-entropy. It catches *degeneration / anchoring*, **not** fluent factual hallucination. UI/abstention copy must say so. The valve must not ship until the AB harness confirms mean/p90 separation on *our* served models (the kill-switch gate).
- **Stage 0 gates the model.** Until `check_parity.py` reports PASS against a vLLM reference, the owned PLT forward is unverified and may be garbage; we own nothing. No `verified:true`, no leading, no training over it.
- **No measured self-improvement yet.** SWE-bench resolved% is unposted; "the loop improves itself" stays a hypothesis until a frozen-slice delta exists.

---

## 6. Build order (gated)

```
Track R (runtime — no GPU):
  R1  Recalibrate token-surprise.js → mean/p90 calibrated logistic   ✅ SHIPPED on master (#1673/#1676/#1681)
  R2  Open the valve: surprise.value() → runCanaries (stream-chat.js) ✅ SHIPPED on master (#1678)
  R3  inFlight staleness reset in auto-dispatch.js (wedge recovery)   ✅ BUILT this session (tested; lands vs master)
  R4  Resonator health/drift monitor over existing JSONL streams → drift records + operator-gated pause   ← next
  R5  Patch abstention on high-surprise / seam_open (valve now done)  ← next

Track M (model — gated on a ≥24 GB GPU; design + default-off code can be written anytime):
  M0  Stage 0 parity (check_parity.py vs vLLM ref)         ◄── blocks everything below
  M1  ALG default-off code lands (inert; parity-identical)
  M2  Train ALG (mix→halt), adapter-only, frozen base
  M3  Eval gate (beats fixed-1, matches fixed-2, mean depth<2) → selfConverges:true, verified:true
  M4  Σ₀Telemetry envelope emitted by the PLT serve stage; chat consumes it (§3.3)

Converge follow-on (deferred, heavier):
  C1  Hash-chain ConvergenceRecord (JS+Python parity) + chain verifier
  C2  Frozen-slice SWE-bench resolved% baseline → measured self-improvement delta
```

**Status (2026-06-30).** R1+R2 (the "open the leak" linchpin) were **already shipped to master** by prior work (#1678/#1681) — the runtime maps that flagged them as open were taken against the stale `claude/unisona-1.8-release` branch. **R3** was built this session (it bounds the worst-case wedge from "rest of process lifetime" to a 40-min ceiling). The remaining sustained-work runtime gaps are **R4** (drift monitor — the biggest remaining win) and **R5** (patch abstention, now unblocked since the valve is live). The substantive forward work is **Track M** (own the kernel + ALG), still gated on Stage-0 parity / a GPU.

---

## 7. Risks & mitigations

- **Valve ships on a dead signal.** → R1 gated by re-running `surprise_leak_ab.py` on *our* served models; if mean/p90 is ~chance there too, do **not** open the valve. tailMass never drives.
- **Stage-0 parity fails (hand-port wrong).** → ALG and all "owned kernel" claims stay design-only; Qwen2.5-Coder remains the local lead (the safe default ADR-0011 names). Honest confidence on first-pass parity is medium-low.
- **Drift monitor false-pauses the fleet.** → operator-gated pause + wide bands + the same "verified-first, evidence-gated" discipline; it logs a `drift` record before acting and can run observe-only first (mirrors `decode_canary`'s `adapt=false` default).
- **Adaptive serving mode regresses interactive latency.** → telemetry-absent path is unchanged (FAST default); DEEP only when the certificate asks for it, bounded.
- **Scope creep into a "self-improvement engine."** → every row in §4 is an extend of one loop stage; the only new artifacts are an append-only drift stream and a `nn.Module` adapter. No new memory system, no new agent ecosystem, no separate dream engine.

---

## 8. Do NOT build

- A second model loop or "dream engine" — the kernel's halt certificate *is* the convergence mechanism; Ouro Q-exit and PLT ALG-halt are the **one** self-converging contract with two backends.
- A new uncertainty store — surprise rides the existing reply/telemetry path and logs into the existing convergence/canary JSONL.
- A separate "sustained-work supervisor" service — the drift monitor is a rolling read over logs the system already writes, emitting into the one convergence stream.
- Any `verified:true` flip, valve-open, or training run that isn't gated by reproduced on-box evidence.

---

## Appendix — key anchors

| Area | File / anchor |
|---|---|
| PLT forward + parity knobs | `models/keystone-sigma0-plt/modeling_keystone_plt.py` `_run_loops`; `configuration_keystone_plt.py:94-100`; `check_parity.py` |
| Adaptive Loop Gate spec | [`models/keystone-sigma0-plt/ADAPTIVE-LOOP-GATE.md`](../models/keystone-sigma0-plt/ADAPTIVE-LOOP-GATE.md) |
| Existing self-converging loop (Ouro) | `src/sigma0/loop_lm.py:179-245`; `src/sigma0/decode_canary.py`; `src/sigma0/quantized_cache.py` |
| Serving + telemetry to extend | `scripts/ouro_serve.py:185-209,372-377`; `scripts/ouro_anthropic_bridge.py` |
| Registry / lead resolution | `apps/lantern-garage/lib/local-model-registry.js:81-162,301-334` |
| The valve wire (Issue B) | `apps/lantern-garage/lib/stream-chat.js:~1199`; `lib/groundedness-canary.js:~135-151`; `lib/token-surprise.js:59-86` |
| Collapse canary | `apps/lantern-garage/lib/collapse-canary.js:~99-135` |
| Council answerability gate | `apps/lantern-garage/lib/council-review.js:~106-121` |
| Autowork dispatch / wedge | `apps/lantern-garage/lib/auto-dispatch.js:42,187-254`; `lib/autowork-research.js` |
| Measured surprise result | `experiments/surprise_leak_ab.py`; `docs/research/2026-06-30-surprise-leak-layer1-result.md` |
| Governing ADRs | `docs/adr/0011-*`, `docs/adr/0010-*`, `docs/adr/0005-*`, `docs/adr/0009-*` |
</content>
</invoke>
