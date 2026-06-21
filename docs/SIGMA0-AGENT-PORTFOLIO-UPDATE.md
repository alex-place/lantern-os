# Σ₀ (Keystone Coder) Serving Architecture — Staff Portfolio Update (v2)

**Workstream:** Keystone chat / Σ₀ coder runtime
**Date:** 2026-06-21
**Audience:** Senior engineering peer-review panel + funding stakeholder
**Decision owner:** Σ₀ workstream lead
**North Star tie-in:** This is the **Reason → Act** engine of the one loop. Inherited constraints: *one coder = Ouro LoopLM*; *models are replaceable*; *local-first is a feature*; *persistent learning via retrieval, not weight modification*. This document picks a runtime topology that honors all four without sprouting a second coder track.

> **Revision note (v2):** This version corrects two material errors flagged in peer review and fully verified against the repo: (1) the headline `pass@1 0.518` / `67.9 s` baseline belongs to the **fixed-depth `ouro-fast-cached` engine**, NOT the adaptive Q-exit engine the plan makes canonical — the adaptive path is **unmeasured**; (2) the live default chat chain does **not** route to Ouro at all today. Both are now treated as load-bearing problems, not footnotes. Overclaimed cost/latency/accuracy statements are downgraded or cited throughout.

---

## 1. TL;DR + the decision

- **Decision: a CLOUD-DEFAULT floor that ships now, with an EMBEDDED-FIRST target reached via a gated spike — behind one swappable client contract.** One model (Ouro LoopLM), one client contract (`SIGMA0_BASE_URL`/`SIGMA0_API_KEY`), engines swapped by config — never a code fork, never a second dense coder track.
- **Honest naming of the local-first deviation:** The *shipped state* for the first ~3 weeks (and indefinitely if the embedded spike is NO-GO) is **cloud-default — user prompts leave the machine.** That is a real, named deviation from the local-first principle, mitigated by keeping the existing local `ouro_serve.py` tier as the NVIDIA/offline local floor and time-boxing the cloud-default with an explicit contingency (§3, §5, decision ask #3).
- **The "adaptive loop is the default" thesis is currently UNPROVEN and must be earned in Phase 0.** The native Q-exit engine (`OURO_NATIVE`) has **no full-benchmark accuracy number and no scaled-latency number** in the repo. Its documented cost is **~1 s/token, capped at 80 tokens** — not yet shown to be interactive. Phase 0 now *measures* it before it is allowed to be the canonical default (§6).
- **vLLM is an opt-in FAST tier only, never the default.** vLLM v0.11.1 natively serves the Ouro loop (confirmed, 0.97) but **pins fixed depth and drops adaptive Q-exit** (refuted that it preserves it, 0.90). Fixed-depth ≠ dense: it still runs the param-shared loop, so it does **not** violate the consolidation — but it is not the adaptive Σ₀.
- **The high-upside bet is a GATED spike:** export Ouro-1.4B to **ONNX Runtime + DirectML** to run **in-process** in the Windows client — all GPU vendors, adaptive depth *expressible* via the ONNX Loop data-dependent trip count (confirmed, 0.97). Zero public precedent for a LoopLM export, so it is off the critical path. **NO-GO falls back to cloud-transformers — never to a loop-dropping dense GGUF.**
- **Exec ask (two real decisions):** (1) fund the plan — **~4–6 engineering weeks of solo-dev time to ship the cloud floor (Phases 0–2), plus a separate 1–2 week embedded spike (Phase 3)**; (3) accept the **temporary, bounded, Patreon-gated cloud dependency and its recurring cost** for the default tier. Asks #2 (is fixed-R4 ever acceptable?) and #4 (QLoRA reconciliation) are *my recommendations — flag if you disagree*, not gates.

---

## 2. Context & current baseline (corrected)

Σ₀ is the project's single coder model: **ByteDance Ouro LoopLM** (Ouro-1.4B-Thinking; a 2.6B variant exists). Ouro is a **parameter-shared looped transformer** — the same blocks re-applied recurrently (default R4 = `total_ut_steps=4`), with an entropy-regularized **adaptive-depth** objective so simple tokens exit early via a learned Q-exit gate. Apache-2.0, ungated (confirmed, 0.92).

**Current serving (ground truth, repo-extracted):**
- Served by `scripts/ouro_serve.py` — plain HuggingFace `transformers` (`AutoModelForCausalLM`, Ouro-1.4B-Thinking, fp16) behind a stdlib HTTP server on `127.0.0.1:11434` speaking the **Ollama API** as `ouro:latest`. No vLLM, no SGLang in serving code.
- **Two engines live in this one file, and they are NOT interchangeable on measurement:**
  - **`ouro-fast-cached`** (default fast path): cached `generate` (`UniversalTransformerCache`) at a **fixed** recurrent depth. This is the engine every benchmark in the repo was run on.
  - **`OURO_NATIVE=1`** (opt-in): the native **adaptive Q-exit** loop — preserves the signature property — but is **~1 s/token, capped at `OURO_NATIVE_MAX=80` tokens**, and is **UNMEASURED for accuracy or scaled latency.**

**Corrected baseline attribution (verified in `data/eval/leaderboard.jsonl`):**

| Figure | Value | Engine it actually belongs to | Note |
|---|---|---|---|
| Full HumanEval pass@1 | **0.518** (85/164) | **`ouro-fast-cached`** (fixed-depth) | label `ouro-final-rerun-full`, `n=164`, `subset:false`. A single full-set row; other full/large rows in the file score 0.0–0.1 (`ouro-he10`=0.1, `ouro-baseline-he20`=0.05). So 0.518 is **one good run of the fixed-depth engine**, not a hardened stable baseline of the adaptive engine. |
| Latency | **67.9 s/problem** | **`ouro-fast-cached`** | from the same `n=164` row. |
| "~23.7 s/prompt (down from 65.8)" | fast avg | **`ouro-fast-cached`** | on a 10-prompt, 48-token-cap golden set on an RTX 3070 8 GB. This is short-answer fast-cached latency — **not** representative full-answer interactive latency, and **not** the adaptive engine. |
| Adaptive Q-exit accuracy / scaled latency | **none** | `OURO_NATIVE` | **No row in the leaderboard uses the native/qexit engine.** The entire "keep the adaptive loop as default" thesis currently rests on an **unmeasured engine.** |

**This is exactly "Option 1": a Windows-native transformers Ollama shim — slow, NVIDIA-only, and (per §3) not even wired as the live coder.**

**Live routing gap is worse than a one-line omission (verified, `stream-chat.js:1273-1310`).** The static `OLLAMA_MODEL_CHAIN` lists **dead/non-served model names** for every intent — `lantern-csf-dream`, `mistral`, `qwen2.5-coder`, `hf.co/PantheonUnbound/Satyr-V0.1-4B:Q4_K_M` — and the **`coding` intent tries `qwen2.5-coder` FIRST**. `ouro:latest` appears in **no** chain. Of those names, only `lantern-csf-dream` is a legacy alias `ouro_serve.py` still answers to; `qwen2.5-coder`/`mistral`/Satyr fall through to cloud. **Net: the "one coder = Ouro" consolidation is NOT wired into the live default chat path today.** Σ₀ runs only when reinjected via `OLLAMA_MODEL` or surfaced by leaderboard reordering. Fixing this is now **Phase 0's first exit criterion**, not a parenthetical (§6).

**Hard requirement (stakeholder, 2026-06-21):** the engine MAY run as a Linux sidecar (WSL2) or cloud app, but there **MUST be a Windows client**. End users are on Windows with **varied hardware (NOT all NVIDIA)**. Dev box = 8 GB GPU. Brand voice = "normie" → minimize install friction.

---

## 3. Problem statement & constraints

**The collision.** The thing that makes Σ₀=Ouro distinctive — the **adaptive-depth loop** — fights every fast/portable runtime:

- The current native path **preserves the loop** but is **slow (~1 s/tok, 80-tok cap), NVIDIA-only, unmeasured**, with a heavy Python+torch+CUDA install — failing the normie/varied-hardware/interactive bar.
- The fast Linux runtimes (vLLM/SGLang) **run the loop but pin depth**, discarding adaptive Q-exit.
- The all-hardware Windows-native dense runtimes (llama.cpp/Ollama on a *dense* model) **drop the loop entirely** — violating the consolidation.

**Constraints (non-negotiable):**
1. **Σ₀ = Ouro consolidation.** One coder. No rebuilt dense track (the Qwen track was deleted as bloat — do not relitigate).
2. **Windows client, varied hardware.** Must reach non-NVIDIA users; minimize install friction.
3. **Local-first is a feature.** Cloud is acceptable as a reach mechanism but is a **named deviation**, to be minimized and time-boxed — see the local-first contingency below.
4. **North Star.** Persistent learning via retrieval + convergence records, **not** weight retraining.

**Local-first contingency (made explicit, per review).** Because the shipped default is cloud, the principle is preserved on two fronts: (a) the existing local `ouro_serve.py` tier on `:11434` is retained and promoted as the **local-first floor for NVIDIA/offline users** — not an afterthought; (b) the cloud-default is **explicitly temporary**, with a forced decision at the Phase-3 gate. **If Phase 3 is NO-GO, the stakeholder must rule whether permanent cloud-default is acceptable, or whether a fixed-R *local* embedded build (which the spike proves first, before the harder adaptive variant) becomes the mandated universal local floor.** We do not silently let cloud-default become permanent.

The problem is therefore **not "which is fastest"** — it is **"which topology reaches all Windows users without abandoning the adaptive loop, forking the coder, or quietly giving up local-first."**

---

## 4. Options evaluated

Legend: ✅ yes · ⚠️ partial/conditional · ❌ no. Confidence markers cite the crux verdicts (Appendix).

| # | Option | Runs loop? | Windows-native? | Preserves adaptive depth? | Hardware reach | Maturity | Effort |
|---|--------|-----------|-----------------|---------------------------|----------------|----------|--------|
| 1 | **Win-native transformers** (current `ouro_serve.py`) | ✅ yes | ✅ yes (local shim) | ✅ yes (`OURO_NATIVE`, but unmeasured + 80-tok cap) `0.97` | ❌ NVIDIA-only | ⚠️ shipped but slow & not benchmarked on native | — (in place) |
| 2 | **Win-native DENSE** (llama.cpp/GGUF/Ollama) | ❌ no¹ | ✅ yes | ❌ no `0.82` | ✅ all vendors | ✅ mature runtime | ⚠️ mod. (C++ fork even to unroll) `0.82` |
| 3 | **Linux-only** (vLLM / SGLang standalone) | ✅ yes (fixed-R) | ❌ no (WSL2 only) | ❌ no `0.90` | ⚠️ NVIDIA-clean / AMD-friction / Intel-exp. `0.86` | ✅ vLLM v0.11.1 native `0.97` | ⬇️ low (server) — but fails Win-client req |
| 4 | **HYBRID** thin Win client → Linux/cloud `/v1` | ✅ yes² | ✅ client native | ⚠️ engine-dependent³ | ✅ cloud = any HTTPS device; WSL2 = NVIDIA-first `0.86` | ✅ topology mature | ⬇️ low-to-mod. |
| 5 | **COMPILE-AND-EMBED** (ONNX Runtime + DirectML, in-process) | ✅ yes (plausible) | ✅ yes (no WSL) `0.90` | ⚠️ expressible, unproven for Ouro `0.97`⁴ | ✅ all DX12 vendors `0.90` | ⚠️ runtime mature; Ouro export unprecedented | ❌ high (weeks, specialist) |

¹ Stock llama.cpp cannot run weight-tied recurrent-**depth** at all (its Mamba/RWKV recurrence is sequence-**state**, a different axis); the only no-C++ route is *unrolling* R4 into a dense N-layer GGUF, which **drops adaptive depth AND the param-shared memory win** (4× block storage ≈ a dense 5–6B). Verdict: partially-true, `0.82`.
² Hybrid preserves the loop **exactly** if the cloud container runs today's transformers code; preserves it at **fixed-R** if it runs vLLM.
³ Adaptive depth is preserved **only** on the transformers container path; **vLLM/SGLang pin `total_ut_steps`** (refuted that either preserves Q-exit, `0.90`).
⁴ The **ONNX Loop op supports a data-dependent trip count** (confirmed, `0.97`) — the exact primitive Q-exit needs — but no public LoopLM has been exported, and **DirectML GPU EP** honoring data-dependent early-exit is unverified (CPU EP confirmed only).

**Crux verdicts driving the table:**
- vLLM merged native Ouro (PR #27794, shipped v0.11.1): **confirmed 0.97**.
- vLLM/SGLang preserve adaptive Q-exit: **refuted 0.90** (both pin fixed depth).
- SGLang "supports Ouro + RadixAttention correct over the loop": **refuted 0.78** (loads via generic Transformers fallback only; prefix-cache correctness over recurrent KV unverified and architecturally suspect).
- ONNX Loop supports data-dependent trip count: **confirmed 0.97**.
- ORT+DirectML runs 1.4–3.8B natively across NVIDIA/AMD/Intel, no WSL (Phi-3 precedent): **confirmed 0.90** — caveat: DirectML officially in "maintenance mode"/"legacy."
- WSL2 GPU inference is NVIDIA-only: **refuted 0.86** (AMD official via ROCm; Intel experimental — with friction).
- Param-shared loop is VRAM-flat regardless of depth: **partially-true 0.86** (weights flat; **KV scales ~4× at R4 on long contexts**).
- Ouro is Apache-2.0 + ungated: **confirmed 0.92**.
- "1.4B≈4B / 2.6B≈8B" reasoning equivalence: **first-party (ByteDance) benchmarks, NOT independently replicated; strongest on reasoning/math, not knowledge recall** — treat as vendor-reported.

---

## 5. Recommended architecture + rationale

**Recommendation: CLOUD-DEFAULT floor (ships now) + EMBEDDED-FIRST target (gated spike), unified behind one swappable client contract.**

Concretely:
1. **Ship now** by hardening the existing thin-client contract (dream-chat already speaks Ollama/OpenAI-shaped HTTP via `stream-chat.js`) and adding a single `SIGMA0_BASE_URL`/`SIGMA0_API_KEY` indirection so any backend is **config, not a fork**. **Retarget the dead static chains onto served Ouro aliases** so Σ₀ is actually the everyday coder (the consolidation is wired, not aspirational).
2. **Stand up a scale-to-zero cloud tier** running the **existing transformers `ouro_serve.py` container**. *Which engine is the cloud default depends on Phase 0's measurement:* if native Q-exit proves interactive and accurate, it is the canonical adaptive default; **if it proves too slow/length-capped, the cloud default is the fixed-cached engine and we explicitly say so** — we do not claim "adaptive default" we cannot stand behind. **vLLM v0.11.1 native Ouro is an opt-in FAST/fixed-R4 tier** behind the same `/v1` endpoint either way.
3. **In parallel, pursue the highest-upside bet as a GATED spike:** export Ouro-1.4B to **ONNX Runtime + DirectML** to run **in-process** in the Windows client. If it lands, embedded becomes canonical and cloud demotes to overflow; if it fails even at fixed-R, **cloud stays the product** and the local-first contingency (§3) is triggered.
4. The current Windows-native `ouro_serve.py` on `:11434` **stays** as the NVIDIA power-user / offline **local-first floor** — not removed.

**Why this and not the simpler options.** It refuses the false choice between the Windows requirement and the consolidation, and it does not pretend the local-first deviation away. Cloud-transformers is the **floor** that ships value early and **keeps the loop** (adaptive or at worst fixed-R, never dense); the embedded ONNX bet is the **ceiling** that, if it lands, restores local-first universally. One contract makes them interchangeable — honoring *models-replaceable* and *no-sprawl*.

**Explicit dependency list — this recommendation relies on these crux claims (and these *unvalidated assumptions*, flagged):**

| The recommendation relies on… | Status | Confidence / gate |
|---|---|---|
| Cloud + thin client reaches every Windows HTTPS device; thin-client integration trivial | verified | `0.92` |
| Containerized transformers reproduces local Ouro outputs **exactly** | **UNVALIDATED ASSUMPTION** — code is identical, output parity is **gated by Phase 0** | gate, not fact |
| Native Q-exit is accurate **and** interactive enough to be the default | **UNMEASURED** — Phase 0 must benchmark; `~1 s/tok`, 80-tok cap are the only known numbers | gate, not fact |
| vLLM is a *real loop* FAST tier (not dense) | verified | `0.97` |
| …but must **not** be the default (drops adaptive Q-exit) | verified | `0.90` (refuted) |
| Embedded bet can preserve adaptive depth in principle (ONNX Loop data-dependent trip count) | verified primitive; **Ouro export unprecedented; GPU-EP early-exit unverified** | `0.97` primitive / spike-gated |
| Embedded is all-vendor, Windows-native, no WSL (Phi-3 precedent) | verified | `0.90`; DirectML is "legacy"/frozen |
| Nothing legal blocks hosting/embedding (Apache-2.0, ungated) | verified | `0.92` |
| Weights fit constrained GPUs (~2.8 GB fp16); KV ~4× only on long contexts | verified w/ caveat | `0.86` (partially-true) |

**Overall synthesis confidence: 0.78** (down from 0.82 in v1). The downgrade reflects the two corrected facts: the adaptive default is unmeasured, and the live coder routing is broken today — both must be earned in Phase 0 rather than assumed.

---

## 6. Phased roadmap (with timeline + rollback)

**Total to ship the cloud floor (Phases 0–2): ~4–6 weeks of solo-dev time** (calendar may stretch — solo dev, so "1–2 weeks specialist" means 1–2 weeks where nothing else ships). **Embedded spike (Phase 3): separate 1–2 weeks.** GO/NO-GO decision point: **end of Phase 3 (~week 6–8).** Phase 4 only exists on a Phase-3 GO.

```
Wk:   0────1────2────3────4────5────6────7────8
P0  [==========]                              parity + routing fixed, native Q-exit MEASURED
P1       [==========]                         auth/tiers/spend live → SHIP to users
P2            [=========]                      vLLM fast tier (opt-in, parity-gated)
P3                      [=========]  ◆GO/NO-GO embedded spike (off critical path)
P4                                [.....]      only if GO
```

### Phase 0 — Client contract + live routing + cloud parity + **native-engine measurement**
**Goal:** make the backend swappable, make Σ₀ the actual live coder, and *measure* the adaptive engine before designating any default.
**Work:**
- Add `SIGMA0_BASE_URL`/`SIGMA0_API_KEY` indirection in `stream-chat.js`/`model-registry.js` where `OLLAMA_BASE_URL` (`:11434`) is read.
- **Retarget the static `OLLAMA_MODEL_CHAIN` (lines 1273–1310) off dead names (`qwen2.5-coder`/`mistral`/Satyr) onto served Ouro aliases**, with a test asserting `ouro:latest` is reachable on the `default` AND `coding` intents.
- **Benchmark the `OURO_NATIVE` adaptive Q-exit engine on the full HumanEval set** for accuracy AND record realistic full-answer latency + the cost of lifting the 80-token cap. *This is the gate that decides whether the adaptive engine can be the default.*
- Containerize `ouro_serve.py` on RunPod serverless (native OpenAI worker, FlashBoot) or Modal (per-second, $30/mo credits, GPU snapshots); run the repo HumanEval/leaderboard against the hosted endpoint.
**Exit criteria:**
- `ouro:latest` reachable on default + coding intents (consolidation wired); test passes.
- Hosted Ouro pass@1 within a few points of the **fixed-cached reference (0.518)** for the fixed-cached engine, *and* a measured native-engine number recorded (whatever it is).
- A documented ruling: **is native Q-exit interactive enough to be the default, or is the default the fixed-cached engine?** No "adaptive default" claim survives this phase unmeasured.
- **Rollback / circuit-breaker shipped:** on hosted `5xx`/timeout, the client falls back to local `ouro_serve.py` on `:11434` (or the cloud-model chain) with a **user-visible error, never a blank stream** (per the `surface-errors-not-blanks` memory).

### Phase 1 — Auth, tiers, spend control (ship to users)
**Goal:** production-safe, cost-bounded, behind existing Patreon.
**Work:** per-API-key token-bucket middleware (Express + Redis) mapping Patreon tiers (guest/supporter/founder/admin) to rate buckets and to warm-vs-cold workers: founder/supporter = warm/min-1-replica; guest = cold + rate-limited. **Drop Fly.io** (GPUs sunset after Aug 1). Keep the container portable (RunPod/Modal/HF-dedicated interchangeable).
**Exit criteria:** authenticated tiered access live; cold-start UX acceptable for paying tiers; **monthly spend bounded, observable, and below the agreed ceiling (open question #6);** guests rate-limited.

### Phase 2 — vLLM FAST tier (opt-in, parity-gated)
**Goal:** fixed-R4 low-latency for workloads that don't need adaptive depth — **not the default.**
**Work:** add `vllm serve ByteDance/Ouro-1.4B-Thinking` (v0.11.1+) as a second engine in the same image behind the same `/v1` endpoint; a `fast` route targets it, `deep` stays on the transformers engine. Validate vLLM output vs the transformers reference on HumanEval (PR #27794 shipped with an **empty test plan** — do not trust blind). Tune `gpu_memory_utilization` for the R4 KV multiplier.
**Exit criteria:** FAST tier passes parity within tolerance; default route remains the transformers engine; stakeholders have ruled whether fixed-R4 "counts" for a given surface.

### Phase 3 — Embedded ONNX/DirectML spike (GATED go/no-go, highest upside)
**Goal:** de-risk the canonical local-first all-vendor Σ₀ **without blocking ship.**
**Work:** export Ouro-1.4B **FIXED-R4** (`torch.export`/`torch.scan`, no gate) to ONNX; **verify weight-tie survives initializer dedup** so footprint stays ~1.4B, not 4×; int4-AWQ quantize; benchmark tok/s + HumanEval on the **8 GB dev dGPU AND one AMD/Intel iGPU** via DirectML. **Then** Variant B: Q-exit gate as the body-computed `cond` of an ONNX Loop, validating numeric match to `OURO_NATIVE` **and that the DirectML GPU EP — not just the CPU EP — honors data-dependent early-exit** (explicitly unverified).
**Exit criteria:** **GO** if fixed-R export loads, runs cross-vendor, holds accuracy within a few points, and Variant B preserves adaptive depth **on GPU**. **NO-GO** → cloud stays the product **and the §3 local-first contingency is forced** (stakeholder rules: permanent cloud-default, or fixed-R local embedded as the mandated local floor). **Do NOT fall back to a loop-dropping dense GGUF.**

### Phase 4 — Embedded-first promotion + maintenance loop (only on GO)
**Goal:** make the in-process Windows runtime the default; wire re-export into the training loop.
**Work:** wire the ORT in-process generator behind the existing client contract; ship the embedded build with no localhost server / no Python+torch+CUDA for end users; demote cloud to overflow (non-DX12 machines, long-context KV-blowup beyond a token threshold, batch). Add an **export+requantize step** to the QLoRA pipeline so every adapter update re-exports, gated by the leaderboard before ship.
**Exit criteria:** embedded build runs in-process on NVIDIA/AMD/Intel at acceptable interactive tok/s; cloud reachable as automatic overflow; every model update re-exports and clears the leaderboard gate.

---

## 7. The new/updated Σ₀ agent — serving path + train plan

### Serving path
The Σ₀ coder agent in dream-chat keeps its route — UI → `/api/dream/chat/stream` → `stream-chat.js` → `ouro:latest` (**once Phase 0 wires the chain to it; today it does not, see §2**). The **only** structural change is the `SIGMA0_BASE_URL` indirection so the same agent resolves to:
- **(a)** hosted transformers container — **default, all Windows users** (engine = adaptive *or* fixed-cached per Phase 0 ruling);
- **(b)** hosted vLLM fixed-R4 — opt-in `fast`;
- **(c)** local Windows-native `ouro_serve.py` on `:11434` — **NVIDIA/offline local-first floor + circuit-breaker fallback**;
- **(d)** eventually, the in-process ONNX/DirectML embedded runtime.

The agent **never branches per backend** — engine is config. A **`deep` vs `fast` selector** maps to the adaptive vs fixed-R engines. *(Implementation note for the "normie" brand: this is a power-user affordance with a sensible default, not a required choice surfaced to every user; it may be cut from the consumer UI and kept internal.)*

**vLLM "fast" is not dense.** For clarity to non-ML readers: the fast tier still computes the full **param-shared loop** at fixed R4 — it keeps the loop, just non-adaptively. It does **not** violate the "one coder = Ouro" consolidation; it is the *same* model at a *fixed* depth.

### What we update/train — QLoRA adapter scope
Continue the existing `scripts/train-qlora-ouro.py` path: peft + transformers Trainer (no trl); 4-bit nf4; LoRA r16/α32 all-linear; seq 1536; completion-only loss; base `ByteDance/Ouro-1.4B`; ~58 MB adapter via `OURO_ADAPTER`.

The adapter scope is **deliberately narrow**: format/parity tuning so Ouro reliably emits the product's `### Instruction / ### Response` template and tool-call format — **not** a continuously-relearned knowledge store.

- **Training data:** existing `models/lantern-sigma0-coder/training-data.jsonl` (~31k rows, FC + coding corpus; FC recipe with ~30% negatives, masked prompt).
- **Governance guardrail (new, per review):** the adapter corpus must **NOT** include user-session experiential data — only curated format/tool-call examples. This is a bright line preventing future drift from "format alignment" into de-facto online learning.
- **Eval harness:** existing repo HumanEval/leaderboard (`data/eval/leaderboard.jsonl`). Every adapter and every cloud/embedded deploy must clear a **parity gate**. **Parity bar caveat:** the `0.518` reference is the **fixed-cached** engine's single best full-set run; the native-engine bar is whatever Phase 0 measures. Parity is "within a few points of the *same engine's* measured reference," not "0.518 universally." In Phase 4 the pipeline gains a mandatory **export + requantize + leaderboard** step so embedded never ships a stale graph. **Each parity-eval run is logged as a Convergence Record** `[hypothesis, evidence, result, confidence]` — the serving decision is itself an instance of the loop it serves.

### Honoring "persistent learning, not weight modification" (the central principle check)
This tension is real and named explicitly — it is the single most important North-Star check in this document. CLAUDE.md says improve via retrieval + convergence records, **not** retraining. Reconciliation:

- QLoRA here is a **one-time, human-triggered, eval-gated format/capability alignment** of the base coder (teaching Ouro the product's instruction + tool-call grammar), **frozen as a static base artifact.**
- It is **not** the mechanism by which the system learns from experience. **The running agent does not retrain on user interactions.** Weights change only when a human deliberately re-runs `train-qlora-ouro.py` on a **curated, experience-free corpus** (the governance guardrail above) and clears the eval gate.
- Per-session and cross-session learning still flow through **JSONL memory + CSF archive + Convergence Records via retrieval** — exactly as the principle requires.
- The adapter is part of *"which model plugs in"* (models are replaceable; a tuned-but-fixed checkpoint), **not** part of the live learning loop. The scope is kept tight — and now hard-fenced by the no-user-data corpus rule — precisely so we never drift into "learning = retraining," which the principle forbids.

---

## 8. Success metrics (targets)

- **Reach:** any Windows device can reach Σ₀ via the shipped client — **cloud path = any HTTPS device (vendor-agnostic); embedded path = any DX12 GPU, contingent on the unverified DirectML GPU early-exit.** Verified on an NVIDIA, an AMD, and an Intel/no-GPU machine.
- **Consolidation wired:** automated test asserts `ouro:latest` is the live coder on default + coding intents (closes the §2 routing gap).
- **Parity:** hosted/exported Σ₀ pass@1 **within a few points of the same engine's measured reference** (fixed-cached ≈ 0.518; native = TBD from Phase 0) at every tier before it can become a default. *(For exec slides: "within a few points of what the model scores on the dev box today on our internal coding benchmark.")*
- **Adaptive depth proven live — only if claimed:** if the default is the adaptive engine, ship **server-side mean-recurrent-depth telemetry** (wire the `loop_lm.py` `mean_depth`/canary instrumentation, currently research-only, into the served path) and show **mean depth < R4 on easy tokens.** If telemetry is not wired, we do **not** claim adaptive depth is "verifiably alive."
- **Latency (now a hard exit criterion, not a vibe):** measured time-to-first-token AND tokens/sec for the shipped default on a warm replica; the current product pain *is* latency, so the floor needs a latency gate, not just an accuracy gate. *(Cold-start provenance: RunPod 6–12 s uncached / sub-200 ms FlashBoot warm; ~2.8 GB fp16 weight load + container pull is the cold-start driver; single-user chat has no shared prefix so vLLM APC gives little benefit — warm replicas for payers hide this.)*
- **Cost:** cloud spend **bounded, predictable, below the agreed ceiling**, Patreon-gated; **warm/min-1 replica cost stated separately** (it is NOT $0-when-idle — see §9); guests rate-limited.
- **Phase 3 gate answered with a real number:** measured cross-vendor tok/s + accuracy on the 8 GB dev dGPU **and ≥1 iGPU** — not a doc claim.
- **If embedded ships:** in-process Windows runtime, **no localhost server, no Python/torch/CUDA** for end users; footprint **~0.9–1.5 GB int4** (weight-tie preserved, not 4×).
- **No sprawl:** one model (Ouro), one client contract, engines swappable by config; **no second coder track introduced.**

---

## 9. Cost (bounded estimate, warm-replica cost surfaced)

Per-unit serverless GPU rates for a 1.4B model: **RunPod** RTX A4000 ~$0.17/hr, L4 ~$0.39/hr, RTX 4090 ~$0.34/hr; **Modal** T4 ~$0.59/hr, L4 ~$0.80/hr ($30/mo free credits). Scale-to-zero = $0 *only when no replica is warm.*

**The plan's Phase-1 warm/min-1 replica for paying tiers explicitly defeats scale-to-zero.** A single always-warm L4 ≈ **$0.39–0.80/hr ⇒ ~$280–580/mo** if held warm 24/7; cheaper if warmed only during active hours. Worked envelope:

| Scenario | Driver | Rough monthly |
|---|---|---|
| **Floor (scale-to-zero, guests only, bursty)** | per-second billing, idle = $0 | **~$10–40/mo** |
| **Expected (some paying users, warmed during active hours)** | partial warm L4 + guest burst | **~$60–150/mo** |
| **High (one L4 held warm 24/7 for payers)** | always-on replica | **~$280–580/mo** |

These are planning envelopes, not quotes; Phase 1 instruments actuals and enforces the ceiling (open question #6). **Embedded tier compute = $0, but NOT free:** it carries per-release export + requantize + leaderboard-gate engineering cost. **Cost of doing nothing:** Σ₀ is not the live coder today (§2), so coding requests fall through to **paid third-party cloud models** — a recurring API spend *and* a loss of the local-first differentiator and the consolidation. The plan's spend has that baseline to beat.

---

## 10. Risks & mitigations

| Risk | Confidence basis | Mitigation |
|---|---|---|
| **Adaptive default is unmeasured** — `OURO_NATIVE` has no full-benchmark accuracy/latency; `~1 s/tok` + 80-tok cap may be non-interactive | repo-verified gap | Phase 0 **measures it before designating it the default.** If non-interactive, default = fixed-cached and we say so; do not claim adaptive default unproven. |
| **Live coder is not Ouro today** — static chains target dead `qwen2.5-coder`/`mistral`/Satyr names | repo-verified (`stream-chat.js:1273-1310`) | Phase 0 first exit criterion: retarget chains to served Ouro aliases + assertion test. |
| Default silently drops adaptive depth if vLLM chases speed | refuted 0.90 | transformers engine is the canonical default; vLLM opt-in `fast` only, parity-gated; `deep/fast` selector makes it explicit. |
| Embedded ONNX export unprecedented; may fail even at fixed-R (weight-tie dedup; **DirectML GPU may not honor data-dependent Loop early-exit** — CPU EP only confirmed) | 0.97 primitive, no LoopLM precedent | Gate as non-critical-path spike; fixed-R first, footprint-check dedup, then GPU-EP control-flow. **NO-GO → cloud + §3 contingency, NOT a dense GGUF.** |
| **No production rollback for the cloud default cutover** | review finding | Phase 0 ships a circuit-breaker: hosted 5xx/timeout → local `:11434` (or cloud chain) with a **user-visible error, never a blank stream.** |
| Output parity drift on hosted/exported engine (template/tokenizer drift already cost ~11 HumanEval pts) | repo-measured | Hard parity gate **vs the same engine's measured reference** at every phase boundary. |
| Cloud cold-start UX (6–12 s uncached) + recurring spend | Hybrid verdict | Warm/min-1 replicas + Modal GPU snapshots for payers; scale-to-zero + rate-limit for guests; per-key token buckets; **warm cost surfaced (§9).** Drop Fly.io. |
| **Local-first abandoned if Phase 3 NO-GO** | principle | §3 contingency forces a stakeholder ruling; retain `:11434` local floor for NVIDIA/offline regardless. |
| QLoRA drifts into de-facto continuous retraining | principle | Narrow scope + **no-user-data corpus guardrail**; human-triggered + eval-gated only; experiential learning via JSONL + CSF + Convergence Records. |
| Long-context KV blow-up (~4× at R4) OOMs constrained GPUs (embedded) | partially-true 0.86 | Cap embedded context; last-step/averaged KV reuse (~4×, <0.2 pt GSM8K loss); route beyond a **token threshold** to cloud overflow. |
| **Embedded runtime (DirectML) is officially "maintenance mode"/legacy** | confirmed 0.80 | Keep the ONNX graph EP-agnostic; target via Windows ML EP abstraction so the same export moves to a forward EP (TensorRT-RTX/OpenVINO) without re-export. *(Now on the deck risk slide, not just the appendix.)* |
| "1.4B≈4B / 2.6B≈8B" cited as fact | vendor benchmark | Always carry the **"first-party, not independently replicated, reasoning/math-strongest"** qualifier in any external-facing claim. |

---

## 11. Open questions

1. **Does the DirectML GPU EP (not just CPU EP) honor a data-dependent ONNX Loop early-exit?** Single unverified gate on whether the embedded path preserves **true** adaptive depth on consumer GPUs.
2. **Real interactive tok/s of a looped R4 model (fixed and adaptive) on a weak AMD/Intel iGPU via DirectML?** Published 200–260 tok/s are *dense Phi-3 on an RTX 4090*; the looped multiplier on an iGPU is unmeasured.
3. **Does int4-AWQ hold accuracy on an iteratively-refining looped model**, or does repeated reuse of quantized weights across R passes degrade below the leaderboard threshold?
4. **Is Ouro-1.4B-Thinking on vLLM v0.11.1 actually equivalent** to the transformers reference for the **-Thinking** variant and long context? (PR #27794 shipped with an empty test plan.)
5. **Upgrade the cloud/embedded base to Ouro-2.6B?** Param-sharing keeps weights light (~5.2 GB fp16 still fits 8 GB) and 2.6B matches ~8B class — arguably higher-leverage than the ONNX spike and a *config/eval-gate swap, not an architecture change* (models-replaceable). The reason 1.4B stays pinned for now: the iGPU throughput floor and export tractability. Worth an explicit decision rather than indefinite deferral.
6. **Acceptable monthly cost ceiling for the warm-replica paying tier** — does the current Patreon base economically justify a min-1 always-warm replica (~$280–580/mo at the high end, §9) vs scale-to-zero for everyone?
7. **If Phase 3 is NO-GO, is permanent cloud-default acceptable,** or is a fixed-R *local* embedded build the mandated universal local-first floor? (Forced at the Phase-3 gate.)

---

## 12. Appendix — evidence table

| Claim | Verdict | Conf. | Source |
|---|---|---|---|
| vLLM merged native Ouro support (PR #27794), shipped in released v0.11.1; serves Ouro-1.4B-Thinking | confirmed | 0.97 | https://github.com/vllm-project/vllm/pull/27794 ; https://github.com/vllm-project/vllm/releases/tag/v0.11.1 ; https://docs.vllm.ai/en/stable/api/vllm/model_executor/models/ouro/ |
| vLLM serves the loop at FIXED depth — `early_exit_gate` loaded but never called; adaptive exit disabled | confirmed (caveat) | 0.97 | https://github.com/vllm-project/vllm/blob/main/vllm/model_executor/models/ouro.py ; https://huggingface.co/ByteDance/Ouro-2.6B/blob/main/README.md |
| Neither vLLM nor SGLang preserves Ouro's adaptive/entropy early-exit (both pin `total_ut_steps`) | refuted | 0.90 | https://huggingface.co/ByteDance/Ouro-1.4B ; https://arxiv.org/html/2510.25741v2 (Sec 4.5) |
| SGLang runs Ouro only via generic Transformers fallback; RadixAttention-correct-over-loop unverified/suspect | refuted | 0.78 | https://github.com/sgl-project/sglang/pull/28328 ; https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/models/transformers.py ; https://arxiv.org/pdf/2510.25741 |
| ONNX Loop op supports a data-dependent trip count / body-computed early termination | confirmed | 0.97 | https://onnx.ai/onnx/operators/onnx__Loop.html ; https://github.com/microsoft/onnxruntime/blob/main/onnxruntime/core/providers/cpu/controlflow/loop.cc |
| ORT + DirectML runs 1.4–3.8B LLMs natively on Windows across NVIDIA/AMD/Intel, no WSL (Phi-3 precedent) | confirmed (caveats) | 0.90 | https://onnxruntime.ai/blogs/accelerating-phi-3 ; https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-onnx ; https://learn.microsoft.com/en-us/windows/ai/models/get-started-models-genai |
| DirectML officially in "maintenance mode"/"legacy"; forward path is Windows ML vendor EPs | confirmed | 0.80 | https://github.com/microsoft/DirectML ; https://learn.microsoft.com/en-us/windows/ai/new-windows-ml/supported-execution-providers |
| Weight-tied loop: weight VRAM ≈ base params regardless of R; **KV scales ~4× at R4 on long contexts** | partially-true | 0.86 | https://arxiv.org/html/2510.25741v2 ; https://arxiv.org/html/2605.07721v1 (MELT) |
| llama.cpp/GGUF cannot run weight-tied recurrent-DEPTH without custom C++; Mamba/RWKV is sequence-STATE | partially-true | 0.82 | https://huggingface.co/ByteDance/Ouro-1.4B ; https://github.com/ggml-org/llama.cpp/discussions/16770 ; https://raw.githubusercontent.com/ggml-org/llama.cpp/master/docs/development/HOWTO-add-model.md |
| MLC-LLM/TVM can compile custom arch to Windows Vulkan + WebGPU; looped-arch export plausible, no LLM precedent; "DirectX" target is wrong | partially-true | 0.72 | https://llm.mlc.ai/docs/compilation/define_new_models.html ; https://llm.mlc.ai/docs/install/gpu.html ; https://github.com/mlc-ai/web-llm |
| WSL2 GPU inference is NOT NVIDIA-only — AMD official (ROCm 7.x), Intel experimental (IPEX-LLM), with friction | refuted | 0.86 | https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/compatibility/compatibilityrad/wsl/wsl_compatibility.html ; https://github.com/intel/ipex-llm |
| Ouro-1.4B/2.6B publicly downloadable, ungated, Apache-2.0 (commercial use permitted; "research only" is a non-binding notice) | confirmed | 0.92 | https://huggingface.co/ByteDance/Ouro-1.4B ; https://huggingface.co/api/models/ByteDance/Ouro-1.4B-Thinking |
| "1.4B≈4B / 2.6B≈8B" reasoning equivalence | first-party, **not independently replicated**; reasoning/math-strongest | — | https://arxiv.org/abs/2510.25741 (vendor benchmark; treat as reported, not settled) |
| Ouro arch facts: parameter-shared loop, `total_ut_steps=4`, 7.7T-token pretrain, entropy-regularized adaptive depth | confirmed | 0.95 | https://arxiv.org/abs/2510.25741 ; https://huggingface.co/ByteDance/Ouro-1.4B |
| **Σ₀ baseline `0.518` pass@1 / `67.9 s/problem` belongs to the `ouro-fast-cached` (FIXED-depth) engine, NOT the adaptive `OURO_NATIVE` path; native engine is UNMEASURED** | confirmed (repo) | 0.95 | `data/eval/leaderboard.jsonl` (label `ouro-final-rerun-full`, `engine:"ouro-fast-cached"`, `n:164`) — grep returns **zero** native/qexit rows |
| **Live `OLLAMA_MODEL_CHAIN` omits `ouro:latest` for all intents; coding intent tries `qwen2.5-coder` first; chains list dead/non-served names** | confirmed (repo) | 0.95 | `apps/lantern-garage/lib/stream-chat.js:1273-1310` |

---

*Synthesis confidence: **0.78** (down from 0.82 — reflecting that the adaptive default is unmeasured and the live coder routing is broken today; both are now Phase-0 gates rather than assumptions). Tie to North Star: this strengthens the **Reason → Act** stage with one swappable engine contract, keeps the loop (adaptive where proven, fixed-R never dense) as the default, names the local-first deviation honestly with a forced contingency, and keeps learning in retrieval + convergence records — fenced from the QLoRA adapter by a no-user-data corpus rule.*
