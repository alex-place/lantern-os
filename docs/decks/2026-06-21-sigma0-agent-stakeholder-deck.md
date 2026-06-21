## Σ₀ — Funding the Looped Reasoning Coder

- A decision deck for the Keystone OS Σ₀ agent
- Solo dev: Alex Place · 2026-06-21
- One model. One client contract. Swappable engines.

> Speaker notes: This deck asks for a fund/no-fund decision on how we serve and update Σ₀ — our looped reasoning coder. Everything here is grounded in primary-source verification; I flag confidence on the load-bearing claims. The throughline: we do NOT have to choose between "works on Windows" and "keeps the special looped model." One important correction up front versus my earlier draft — our current benchmark numbers come from the FAST fixed-depth engine, not the adaptive one; I've relabeled them honestly throughout, because that distinction changes what "low risk" means.

---

## The Ask, In One Line

- **Fund ~4 weeks of work to ship a cloud-backed Σ₀ to all Windows users — and a separate, gated 1–2 week spike to embed it natively in the Windows app.**
- Two real decisions for you: **(1) fund the plan**, and **(2) accept a bounded, temporary cloud cost + prompts-leave-the-device for the default tier.**
- Two more items (is adaptive-depth non-negotiable? is the QLoRA adapter "OK"?) are **my recommendations — flag only if you disagree.**

> Speaker notes: I deliberately cut the ask to two decisions you actually need to make: fund it, and accept the temporary cloud dependency with its cost. The other two — whether adaptive depth is non-negotiable, and whether the format adapter violates our learning principle — are technical judgments I've already made a call on. They're here as FYI so you can veto, not as homework.

---

## Why Now — The Cost Of Doing Nothing

- Today Σ₀ **cannot actually serve as the everyday coder**: the live chat routing points at dead/legacy model names, so coding requests **fall through to paid third-party cloud models** (recurring API spend, today)
- Staying put means: **no local-first differentiator**, an **ongoing third-party API bill**, and the **Σ₀=Ouro consolidation stays aspirational** (not wired into the live path)
- The alternative "just keep using the cloud models we already fall back to" forfeits the entire reason Σ₀ exists: a local-first, owned, looped coder

> Speaker notes: Before the plan, the honest status quo: Σ₀ isn't the coder today. The default chat chain lists model names that aren't even served, so coding silently falls through to paid cloud APIs. So "do nothing" is not free — it's a recurring bill plus the loss of the local-first product we set out to build. That's the baseline this spend has to beat, and it's a low bar.

---

## What Σ₀ / Ouro Actually Is

- Σ₀ = **Ouro**, an open (Apache-2.0, ungated, commercial-OK — conf 0.92) 1.4B "looped" reasoning model from ByteDance
- A normal model runs its layers **once**. A looped model runs the **same layers several times** over one token — "thinking in a circle" before answering
- Vendor-reported (ByteDance, **not yet independently replicated**): a 1.4B that reasons ~like a 4B (2.6B variant ~like 8B) — strongest on **reasoning/math, not knowledge recall**
- Bonus: it can **stop early** on easy tokens (adaptive depth) — its signature efficiency trick

> Speaker notes: Key intuition: depth-by-repetition instead of depth-by-size. Same weights reused, so it stays small in memory but reasons deep. Two honesty flags I added: the "reasons like 4B/8B" numbers are the vendor's own, not independently reproduced, and they're strongest on math/reasoning, not factual recall. "Adaptive depth" — loops more on hard tokens, less on easy ones — is the property we keep fighting to preserve.

---

## Where We Are Today — And The Pain

- Σ₀ runs on the dev box via plain Python/transformers behind an Ollama-shaped HTTP shim
- **Two engines exist, and they are NOT the same:**
  - **Fast cached (fixed-depth):** our only MEASURED path — pass@1 **0.518** on full HumanEval, **~67.9 s/problem** (and ~23.7 s on a short golden set). **This is fixed-depth — it does NOT use adaptive early-exit.**
  - **Native Q-exit (adaptive):** preserves the loop's signature, but **~1 s/token, capped at 80 tokens**, and **UNMEASURED for accuracy or scaled latency**
- **NVIDIA-only + heavy install:** needs Python + Torch + CUDA — a non-starter for normal users
- **Routing is broken:** the default chat chain lists dead model names; Σ₀ doesn't reliably run

> Speaker notes: This is the most important correction from my first draft. We have TWO engines. The good benchmark — 0.518 pass@1 — is the FAST FIXED-DEPTH engine, not the adaptive one. The adaptive Q-exit engine that preserves the loop is ~1 second per token and capped at 80 tokens, and we have never benchmarked its accuracy or its real latency. So "keep the adaptive loop as the default" is currently an unmeasured bet, not a known-good baseline. Phase 0 fixes that.

---

## The Constraint That Shaped Everything

- **Must have a Windows client** — end users are on Windows, varied hardware, **NOT all NVIDIA**
- **Local-first is a feature** — ownership, privacy, no mandatory cloud
- **Minimize install friction** ("normie" brand voice)
- **Keep the loop** — the consolidation decision says Σ₀ = Ouro; no separate dense-model coder track

> Speaker notes: These four constraints killed most obvious answers. "Just use a fast Linux server" fails Windows. "Just use a fast dense model" fails the loop. "Just use llama.cpp/Ollama" drops the loop. The recommendation is the only shape that threads all four — but note constraint two, local-first, is in tension with shipping a cloud default first. I address that head-on two slides down.

---

## The Options We Considered

- **1. Windows-native transformers (today)** — keeps loop; slow; NVIDIA-only; heavy install
- **2. Dense fallback (Ollama/llama.cpp)** — fast, all-hardware, but **drops the loop** ✗
- **3. Linux-only (vLLM/SGLang)** — fast, but **no Windows client** ✗
- **4. Hybrid** — thin Windows client → cloud/Linux engine over standard HTTP
- **5. Compile-and-embed (ONNX + DirectML)** — run the loop **in-process** on any Windows GPU

> Speaker notes: Six months of pain comes down to these five. Options 2 and 3 each fail a hard constraint outright. The winners are 4 (ship now, reaches everyone) and 5 (the local-first dream). Our plan uses both.

---

## What The Evidence Said

- **vLLM serves Ouro's loop** — real, merged, released (conf **0.97**) — but **at fixed depth, no early-exit** (conf 0.90)
- **Neither vLLM nor SGLang preserves adaptive depth** — both pin full loop count (conf 0.90)
- **ONNX + DirectML runs 1.4–3.8B models on ALL Windows GPUs** (NVIDIA/AMD/Intel), no WSL — Phi-3 precedent (conf 0.90)
- **ONNX's Loop op supports data-dependent early-exit** — the exact primitive Ouro needs (conf 0.97) — **but confirmed on CPU only; GPU path unverified**
- **DirectML is officially "maintenance mode / legacy"** — mature but frozen; we keep the export portable to its successor (Windows ML)

> Speaker notes: Every claim checked against primary sources — GitHub PRs, model cards, the paper, Microsoft docs. Two findings drive the design: the fast Linux servers run the loop but throw away early-exit, so they can't be our adaptive default; and ONNX+DirectML is the one runtime that's native-Windows, all-vendor, and can in principle keep early-exit. I added two cautions: the early-exit primitive is only CONFIRMED on CPU, not GPU — that's the first thing the spike measures — and DirectML itself is officially frozen, so we keep the export portable.

---

## The Recommendation

- **Cloud-default today → embedded-first target — one model, one swappable client contract.**

```
  Keystone chat ── HTTP ──► [ Σ₀ engine ]
                              ├─ Cloud transformers  (default: keeps adaptive loop*)
                              ├─ Cloud vLLM          (opt-in "fast", fixed depth — still the loop, NOT dense)
                              ├─ Local Windows-native (NVIDIA / offline — the local-first floor, today)
                              └─ Embedded ONNX/DirectML  ◄── the bet (any GPU, in-process)
   * adaptive default is Phase-0 parity-gated before it can ship
```

> Speaker notes: One indirection — a single base-URL setting — makes the backend interchangeable. I renamed the recommendation honestly: we are CLOUD-DEFAULT today, with embedded-first as the target. The existing local Windows-native engine is NOT an afterthought — it's our standing local-first floor for NVIDIA/offline users from day one, so "local-first" is never fully abandoned even before the spike lands. vLLM "fast" still runs the full param-shared loop — it is NOT a dense model, it just doesn't adapt depth.

---

## Local-First: The Honest Trade

- **Naming it plainly:** the shipped DEFAULT for ~4 weeks (and indefinitely if the spike is NO-GO) is a **cloud tier where prompts leave the device** — a real, temporary deviation from local-first
- **It is never the ONLY option:** the existing **local Windows-native engine stays the local-first floor for NVIDIA/offline users from day one**
- **The NO-GO branch is a real decision, not a footnote:** if the embedded spike fails, do we (a) accept **permanent cloud-default** for non-NVIDIA users, or (b) mandate a **fixed-R local embedded** build (which the spike proves FIRST) as the local floor for everyone?

> Speaker notes: I'm putting the local-first deviation on its own slide rather than soft-pedaling it. The cloud default is a genuine, temporary departure from our own principle, justified only because it's the one way to reach non-NVIDIA Windows users today. But I keep the existing local engine alive as the NVIDIA local floor throughout. And I'm forcing the uncomfortable question: if embedded fails entirely, are you OK with permanent cloud-default for non-NVIDIA users, or do we commit to a fixed-depth local embedded build as the floor? I recommend (b).

---

## Why This Is Best For Σ₀ Specifically

- A looped model is **memory-light**: the weights are the same ~2.8 GB no matter how many loops — **depth costs compute, not memory** (caveat: KV cache grows ~4x at R4 on LONG context — capped + routed to cloud)
- That makes it **uniquely suited to weak/varied consumer GPUs** — the loop fits where a true big model wouldn't
- ONNX + DirectML + a memory-light loop = a deep-reasoning model that **fits on a normie's laptop, any vendor**
- This is the rare design that honors *both* the Windows constraint *and* the keep-the-loop rule

> Speaker notes: The crux insight: a dense 8B model needs 8B-worth of VRAM; Ouro gets 8B-class reasoning from 1.4B-worth of weights by reusing them. So the thing that makes Ouro special is also what makes it deployable on cheap, varied hardware. One honesty caveat: "depth costs no memory" is only true for the weights — the KV cache does grow ~4x at full loop depth on long contexts, so we cap context locally and send long jobs to cloud.

---

## The New Agent In Keystone Chat

- Same route users already use: dream-chat → streaming HTTP → `ouro:latest` — **once routing is fixed (Phase 0)**
- Adds a **"deep" vs "fast"** selector (sensible default; power-user affordance, not a normie-facing knob)
- "Deep" = adaptive looped reasoning (default); "Fast" = fixed-depth, lower latency
- One agent, no per-backend branching — it resolves to cloud / local / embedded by config

> Speaker notes: From the user's seat almost nothing changes — same chat, same model name — but only AFTER we fix routing, which today doesn't point at Ouro at all. The deep/fast toggle defaults to deep; it's a power-user affordance, not something we force on normies, so it doesn't fight the low-friction brand. Behind the scenes the same agent points at whichever engine is configured.

---

## Update vs Train — The QLoRA Plan In Plain Terms

- We **don't retrain the brain.** We add a tiny ~58 MB "adapter" that teaches Ouro our exact instruction + tool-call format
- One-time, human-triggered, **eval-gated** — not learning-on-the-fly
- **Hard guardrail:** the adapter corpus is **curated format/tool-call examples only — NEVER user-session data** (a bright line against drift into de-facto online learning)
- The system still *learns from experience* via **memory + retrieval**, not weight changes (honors our North Star)

> Speaker notes: QLoRA here is a one-time formatting alignment — making Ouro speak our template reliably — frozen as a static artifact. It is NOT the system learning from users; that still happens through stored memory and retrieval. I added an explicit guardrail: the adapter's training data may never include user-session experiential data, only curated format examples. That's the bright line that stops "format alignment" from quietly becoming "online learning," which our North Star forbids. This is item #4 of the ask — flag only if you disagree.

---

## Timeline

```
 Week:   0 ──── 1 ──── 2 ──── 3 ──── 4 ──── 5 ──── 6 ──── 7
 P0  [contract+cloud parity]
 P1        [auth/tiers/spend ]
                              ◄ SHIPS to all Windows users (~wk 4)
 P2                          [vLLM fast tier]
 P3 (parallel)  [ONNX spike] ───► GO/NO-GO decision point (~wk 5–6)
 P4 (only if GO)                        [embed → default]
```

- **Ships to users: ~week 4.** Embedded GO/NO-GO call: **~week 5–6.**
- Total to first ship: **~4 weeks; the spike is a parallel 1–2 week bet, off the critical path.**

> Speaker notes: This is the new slide reviewers asked for — one timeline strip with the dates that matter. Value ships to all Windows users around week four. The risky research (the ONNX spike) runs in parallel and produces a GO/NO-GO around week five-to-six. The spike never delays the ship. As a solo dev, "1–2 weeks of specialist time" honestly means 1–2 weeks where nothing else ships — that's the real opportunity cost of the bet.

---

## Cost — The Honest Monthly Picture

- **Per-unit cloud:** scale-to-zero, ~$0.17–1.10/GPU-hr, $0 when truly idle (RunPod/Modal, 1.4B is cheap)
- **BUT the plan commits to WARM/min-1 replicas for paying tiers — that is NOT $0-idle.** Realistic bounded monthly exposure:

| Scenario | Cloud / month |
|---|---|
| Low (all scale-to-zero, light use) | **~$10–30** |
| Expected (1 warm replica for payers + guest bursts) | **~$120–300** |
| High (always-warm + heavy guest load) | **~$400–700** |

- **Embedded tier: $0 cloud runtime** (user's own GPU) — but real per-release **re-export + requantize** maintenance cost
- **The actual spend you're approving:** ~1–2 weeks of solo-dev engineering for the spike

> Speaker notes: My first draft made cloud look basically free. It isn't, because the same plan promises warm replicas for paying users, which defeats scale-to-zero. So here's the bounded monthly range: roughly $10–30 if everything scales to zero, an expected $120–300 with one always-warm replica, up to ~$700 worst case. All of it is gated behind Patreon tiers, so spend tracks paying users. Embedded is zero cloud cost but carries a per-release re-export chore. The real investment I'm asking for is the 1–2 weeks of engineering.

---

## Risks + The One Thing That Could Kill It

- **The killer risk:** the ONNX export of Ouro's custom looped + early-exit architecture is **unprecedented** — may fail, especially on GPU
- **Mitigation:** gated spike, off the critical path — **NO-GO falls back to the shipped cloud tier, never to a dense model**
- **Default-tier rollback (new):** if the hosted endpoint 5xx/times-out in production, a **circuit-breaker falls back to local `ouro_serve.py` (:11434) or the existing cloud-model chain — with a visible error, never a blank stream**
- **Adaptive default is unmeasured:** the Q-exit engine has **no accuracy/latency benchmark yet** → **Phase 0 must benchmark it before it can be the default**
- Other: output drift (→ hard parity gate), cold-starts (→ warm replicas for payers), KV memory on long context (→ cap + route to cloud), DirectML is frozen (→ EP-agnostic export)

> Speaker notes: Three additions from review. First, the production rollback: the spike was gated but the cloud cutover itself had no fallback — now it does, a circuit-breaker to the local engine or cloud chain, surfacing an error not a blank, per our hard-won memory lesson. Second, I'm flagging loudly that the adaptive default is UNMEASURED — Phase 0 has to benchmark the Q-exit engine on full HumanEval before we dare call it the default. Third, the killer risk and its NO-GO fallback are unchanged: worst case, we keep the working cloud tier and never drop to a dense model.

---

## Success Metrics

- **100% of Windows users** reach Σ₀: any device with HTTPS (cloud) or any DX12 GPU (embedded)
- **Routing fixed:** `ouro:latest` is provably reachable on the default coding intent (test-asserted) — the consolidation is actually wired, not aspirational
- **Adaptive engine measured:** OURO_NATIVE Q-exit benchmarked on full HumanEval, **within a few points of our internal fixed-depth reference (currently 0.518)** — and its real latency/length budget stated honestly
- **Adaptive early-exit verifiably live:** served engine **emits mean-recurrent-depth telemetry** (depth < full loop on easy tokens) — telemetry wired, or the claim is dropped
- **Interactive latency** for paying tiers (time-to-first-token); cloud spend bounded + predictable
- **One coder, one contract, engines swappable** — no second model track

> Speaker notes: These are checkable and I've tightened them per review. The accuracy bar is now stated as relative — "within a few points of what the model scores on our dev box today" — and I name 0.518 only as that internal reference, not as a settled universal number. Critically, I added that the adaptive engine must actually be benchmarked, that routing must be test-proven to reach Ouro, and that adaptive depth must be backed by real server-side telemetry — if we can't wire that telemetry, we drop the claim rather than assert it.

---

## The Decision Ask + Next Step

- **DECISION 1 — Fund the plan:** ship cloud-now (Phases 0–1, ~4 wks, low risk) + fund the gated embedded spike (Phase 3, 1–2 wks, parallel)
- **DECISION 2 — Accept the trade:** temporary cloud-default = prompts leave the device + bounded monthly cost (~$120–300 expected); resolved IF embed lands, with the NO-GO branch decided now
- *FYI #3 (my call — flag if you disagree):* adaptive early-exit IS load-bearing → adaptive transformers stays the default; vLLM "fast" is opt-in only
- *FYI #4 (my call — flag if you disagree):* the one-time, eval-gated, user-data-free format adapter does **not** violate "persistent learning, not weight modification"
- **On approval, next step:** stand up the swappable client contract, **fix routing to reach `ouro:latest`**, and run the Phase-0 parity gate (incl. the first-ever OURO_NATIVE full-HumanEval benchmark)

> Speaker notes: Two real decisions, two FYIs. Decision 1: fund both tracks. Decision 2: accept the temporary cloud dependency and its bounded cost, and pick the NO-GO branch now so we're not surprised later. The two FYIs are technical calls I've already made — adaptive depth is load-bearing, and the format adapter is principled — here only so you can veto. Say yes, and I start Phase 0 immediately: the client contract, fixing the routing so Ouro is actually the coder, and the first real benchmark of the adaptive engine that the whole "keep the loop" thesis rests on.
