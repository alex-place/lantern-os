# OSS Landscape Baseline — 2026-07-06

**What this is:** a grounded, verified snapshot of the open-source terrain across every layer the
unisona.ai control-plane touches. Baselines our knowledge so we build on proven OSS instead of
reinventing it, and know exactly what to **stand on** (wrap), **beat** (benchmark against),
**watch** (competitor), or use as **reference**. Produced by an 8-agent audit (178 web lookups),
every license / maintenance status / number verified against a 2026 source.

> **Maintenance:** this is a *living* file. It goes stale fast (repos freeze, licenses change,
> models ship weekly). Re-run the audit before any build decision that leans on a row here, and
> update the row in the same PR. Rule: **never write a status you didn't verify.**

---

## The one finding that matters

Eight researchers audited eight different layers and **all landed on the same blank space.**
Across coding agents, runtimes, models, routing, memory, verification, and orchestration —
**every mature OSS project is a stateless, unaccountable executor or store.** None owns:

1. **persistent cross-repo/cross-session memory the user controls**,
2. a **policy/approval gate that HOLDS consequential actions** until the user approves,
3. **verifiable receipts** (diff + test + source + cost + why-this-model), or
4. **outcome-based routing** that learns which backend wins on *the user's own* repos.

That four-part **accountability layer is the unoccupied ground** — and the product thesis. unisona.ai
is **assembly, not invention**: proven OSS components + the accountability layer nobody ships.
Because it's assembly, the components are copyable — **the moat is execution quality + the
compounding owned data** (approvals, rejections, per-repo outcome history, receipts), not the parts.

---

## The stack — stand on / beat / watch

| Layer | ✅ Stand on (component) | 🎯 Baseline to beat | 👁 Watch (competitor) | unisona.ai's owned piece (the gap) |
|---|---|---|---|---|
| **Coding agents** | **OpenHands** (MIT, headless, LiteLLM→100+ providers, SWE-bench 72%); **Aider** (Apache-2.0, best diff engine) | **Codex CLI** (Terminal-Bench 83.4%, OpenAI-first) | **opencode** (178k★), **Goose** (Linux Foundation), **Cline** (62k★) | memory / approval / receipts |
| **Local runtime** | **Ollama** + **llama.cpp** (MIT, 8GB-native); ExLlamaV3 (MIT) | — | LM Studio (proprietary) | dumb substrate — correct as-is |
| **Local coding model** | **Qwen2.5-Coder-7B** (Apache-2.0, HumanEval 88.4%, 8GB); **-1.5B** (43%, fits 8GB) | Devstral 53.6% · Qwen3-Coder-30B 50.3% SWE-bench Verified | — | stateless weights |
| **Routing / gateway** | **LiteLLM** (MIT, 100+ providers) | RouteLLM (Apache, stale) | vLLM Semantic Router; Martian (~$1.3B, proprietary) | outcome-based **per-repo** routing |
| **Memory** | **Graphiti/Zep**, **cognee**, **txtai** (all Apache-2.0, local) | Mem0 (92.5 LoCoMo) · Zep (LongMemEval 63.8%) | **Mem0** (60k★) | store → accountable control plane |
| **Verification** | **SWE-bench harness** (MIT, tests) · **Inspect AI** (MIT, UK AISI) · **MiniCheck** (source-entailment, 770M) | lm-eval-harness (MIT) | — | verifies *text* → verify *actions* |
| **Orchestration** | **Pydantic-AI** or **LangGraph** (MIT) | — | CrewAI (55k★), MS Agent Framework | builder-lib → user-owned; **verification-decides**, not votes |
| **Looped models (research)** | **Ouro** (Apache-2.0, best OSS looped) | Huginn-3.5B (Geiping/UMD) | — | accountable depth controller; **recurrent-depth is unstable (Ouro −20% after 8 loops)** |

---

## Per-layer detail (verified 2026-07-06)

### Coding agents — execution backends & our closest competitors
- **OpenHands** (All-Hands-AI) · MIT · active (v1.7.0 May 2026) · **component**. Best headless/CI
  story: `openhands -t '...'` one-shot, `--headless`, `--resume`; uses LiteLLM → 100+ providers incl.
  Ollama/vLLM with no code change. SWE-bench Verified 72% (vendor, Sonnet 4.5). Also a partial
  competitor (Software Agent SDK + cloud). ~74–78k★, venture-backed ($18.8M A).
- **Aider** (Aider-AI) · Apache-2.0 · active · **component + baseline**. Terminal-native, scriptable
  (`--message`/`--yes`), git-commit-per-edit, strong local-model support. Cleanest diff engine to
  embed; owns the **Aider Polyglot** benchmark (225 Exercism tasks) — the live number to beat on
  edit-accuracy. (Its SWE-bench Lite 26.3% is 2024-era.) ~46k★.
- **opencode** (anomalyco) · MIT · active (v1.17.10) · **competitor**. Highest-starred terminal agent
  (~178k★); BYO-provider, Plan/Build, LSP+MCP, local via Ollama. **Gap: no owned cross-repo memory,
  no hold-for-approval gate.** NOTE: the original `opencode-ai/opencode` (Go) is archived — target
  the anomalyco TS/Bun repo.
- **Codex CLI** (openai/codex) · Apache-2.0 · active · **baseline**. Terminal-Bench 2.1 #1 (83.4%,
  GPT-5.5). Scriptable (`codex exec`), local via `--oss` (Ollama/LM Studio/gpt-oss) but OpenAI-first
  by default — opposite of local-first. ~94k★, 5M+ weekly users.
- **Goose** (Block → Agentic AI Foundation/Linux Foundation) · Apache-2.0 · active · **competitor**.
  Desktop+CLI+API, MCP-extensible, 15+ providers incl. Ollama. Vendor-neutral governance now. No
  owned persistent memory / approval-hold gate → exploitable gap. ~34k★.
- **Cline** · Apache-2.0 · active · **competitor**. IDE-first (VS Code/JetBrains/…), only a *preview*
  CLI (mac/Linux) → weak for Windows/PowerShell headless orchestration. 30+ providers, local via
  Ollama, plan/act approval prompts. ~62k★, 5M+ installs.
- **Qwen Code** (QwenLM) · Apache-2.0 · active · **component**. Terminal-native (forked from Gemini
  CLI, diverged), multi-protocol + local (Ollama/vLLM), daemon mode + SDKs → scriptable backend,
  tuned for Qwen3-Coder weights. ~26k★.
- **Kilo Code** (Kilo-Org) · MIT(CLI)/Apache(ext) · active · **reference**. All-in-one; its
  model-routing/cost-control is the closest public analog to our outcome-routing → study for UX.
- **Continue** (`cn` CLI, continuedev) · Apache-2.0 · **STALE / read-only** after a final 2.0.0;
  company pivoted to "Continuous AI" (agents-as-PR-CI-checks in `.continue/checks/*.md`).
  **Do not build on it** — keep the *agent-as-enforceable-CI-check* idea as a precedent for our gate.
- **Roo Code** (RooCodeInc) · Apache-2.0 · **DEAD** (all products shut down 2026-05-15, repo archived).
  Migration paths: Cline (official), Kilo. Do not build on it.

### Local model runtimes — the (deliberately) dumb substrate
- **Ollama** · MIT · active · **component**. OpenAI-compatible REST on `:11434`, 8GB-native. ~175k★.
- **llama.cpp** (ggml-org) · MIT · active · **component**. GGUF quant 1.5–8 bit; the reference
  8GB-VRAM / CPU engine.
- **vLLM** · Apache-2.0 · active · **component** (server-side; needs GPU headroom).
- **ExLlamaV3** (turboderp) · MIT · active · **component**. EXL3 2–8 bpw quant.
- **SGLang** · Apache-2.0 · active · **reference** (RadixAttention prefix reuse).
- **MLX/mlx-lm** (Apple) · MIT · active · **reference** (Apple-Silicon only).
- **LM Studio** · **proprietary** GUI (engines under it are OSS) · active · **competitor** (has an
  `lms` CLI + headless daemon). Free for commercial use per terms, but closed.
- **HF TGI** · **HFOILv1** (source-available, *not* OSI; ≤0.9.4 was Apache) · **avoid** for a hosted
  paid service — license restricts it.
- **Gap:** every engine here is a stateless token-generator. That's correct — unisona.ai supplies the
  accountability the substrate deliberately lacks.

### Open-weight coding models — the local-engine candidates (vs Ouro-1.4B)
- **Qwen2.5-Coder-7B-Instruct** · Apache-2.0 · **component**. HumanEval 88.4% / HumanEval+ 84.1%. The
  recommended **shipping local engine** — Apache, 8GB-capable quantized, drop-in via Ollama.
- **Qwen2.5-Coder-1.5B** · Apache-2.0 · **baseline**. HumanEval ~43% — fits 8GB comfortably; the
  small-model bar Ouro-1.4B must beat to earn the local slot. (Qwen2.5-Coder-3B is Qwen-Research /
  non-commercial — avoid for shipping.)
- **Qwen3-Coder-30B-A3B** · Apache-2.0 · reference. SWE-bench Verified 50.3% (needs >8GB).
- **Devstral Small** (Mistral) · Apache-2.0 · reference. SWE-bench Verified 53.6% (2507).
- **DeepSeek-V3** · MIT weights · reference (frontier MoE, cloud-tier).
- **GLM-4.6** (Zhipu) · MIT · reference. LiveCodeBench v6 82.8% (vendor).
- **StarCoder2-3B/7B** · BigCode OpenRAIL-M (use-restrictions) · stale · reference.
- **Codestral-22B** · Mistral MNPL (**non-commercial**) · **avoid** for shipping.
- **Gap / decision:** raw coding capability is **fully commoditized** at every tier under
  permissive licenses. Weights are stateless & unaccountable. **→ Ship on Qwen2.5-Coder; Ouro
  auditions later.** (See Decisions.)

### Routing / cascade / gateway
- **LiteLLM** (BerriAI) · MIT · active · **component**. 100+ providers unified in OpenAI format; the
  gateway to route local↔cloud through.
- **vLLM Semantic Router** · Apache-2.0 · active · **competitor** (intent classification pre-gen).
- **RouteLLM** (LMSYS) · Apache-2.0 · stale · **baseline** (85% cost cut @ 95% GPT-4 quality, MT-Bench).
- **OptiLLM**, **FrugalGPT**, **RoRF**, **LLMRouter** · reference (test-time / pairwise routing).
- **Martian** · proprietary · competitor (~$1.3B).
- **Gap:** every OSS router routes on a **pre-generation proxy signal** and none owns the *outcome*.
  **No outcome-based, per-user-repo routing exists** — that's the wedge (learn which backend actually
  succeeds on *this* user's repos).

### Agent / personal memory (CSF / Dream-Journal comparables)
- **Mem0** · Apache-2.0 · active · **competitor**. 60k★, LoCoMo 92.5 (vendor).
- **Graphiti/Zep** (getzep) · Apache-2.0 · active · **component**. 28k★, LongMemEval 63.8% (temporal
  knowledge graph) — a strong OSS store to build the accountability layer on.
- **cognee** · Apache-2.0 · active · **component**. 27k★, hybrid graph+vector.
- **txtai**, **MemOS**, **Letta** (MemGPT), **GraphRAG** · reference/component.
- **Gap / decision:** these are **memory stores, not accountable control planes** — none has an
  approval gate or a receipt for what was remembered/retrieved/acted on. They are also **better
  benchmarked than our CSF**. **→ Use one (Graphiti or cognee) as the store; own the accountability
  layer over it.** (See Decisions.)

### Verification / eval / guardrails (the "verification-decides" layer)
- **SWE-bench harness** · MIT · active · **component** (verify by real test execution).
- **Inspect AI** (UK AISI) · MIT · active · **component** (200+ evals).
- **MiniCheck** (LLM-AggreFact) · Apache-2.0 · **component** (source-entailment at ~GPT-4 accuracy,
  770M — cheap enough to run local as the grounding judge).
- **Ragas**, **promptfoo**, **DeepEval**, **NeMo Guardrails**, **Guardrails-AI** · reference.
- **lm-evaluation-harness** (EleutherAI) · MIT · **baseline**.
- **Gap:** every tool verifies a **model's text**, not an **agent's consequential action**. Compose
  them (tests + entailment + policy) into the layer that decides whether an action is allowed to run.

### Multi-agent / orchestration (the council layer)
- **Pydantic-AI** · MIT · active · **component** (typed, clean, local-capable) — recommended substrate.
- **LangGraph** · MIT · active · **reference/component** (graph state machine).
- **CrewAI** (55k★), **Microsoft Agent Framework** · **competitor**.
- **OpenAI Agents SDK**, **Google ADK**, **AG2** · reference. **AutoGen (legacy)** & **Swarm** · avoid (stale).
- **Gap:** all are **builder's libraries** with **vote/manager/handoff** selection — **none is
  verification-decides** or user-owned. Build on one and add the verifier-decides + ownership layer.

### Looped / recurrent-depth / latent-reasoning (the research lane)
- **Ouro / LoopLM** (ByteDance Seed) · Apache-2.0 · active · **component/research**. Best OSS looped
  model (Ouro-1.4B GSM8K 78.92, MATH500 82.4). But **recurrent-depth is unstable at test time —
  Ouro-1.4B falls ~20% from peak after 8 loops** (the field's open wound; matches our own findings).
- **Huginn-3.5B** (Geiping/UMD) · Apache-2.0 · **baseline**.
- **Coconut** (Meta), **LoopFormer** (ICLR 2026), **PonderNet/ACT** · reference.
- **Gap:** the layer ships weights + a baked halting heuristic but **no accountable per-task depth
  controller** — and looping alone is unstable. Confirms Ouro is a **research lane, not a product
  dependency.**

---

## Decisions this baseline forces

1. **Ship the local engine on Qwen2.5-Coder (Apache-2.0), not Ouro.** ✅ **Landed (#2171):** the
   model registry now leads coding/reasoning/default with `qwen2.5-coder:latest` (already pulled,
   serves on the standard Ollama `:11434`) on the 8GB box; **Ouro stays kernel/research-only** (its
   coding promotion is gated on the loop-value experiment #2178). Honest: Qwen is registered
   `verified:false` (vendor HumanEval 88.4% not yet reproduced on-box — #2173 is the gate to flip it),
   yet it leads because it out-scores the only other (also-unverified) local coder and — unlike the
   PLT shim — actually serves. ✅ **Verified on-box (#2173):** qwen2.5-coder:latest scored **exec-graded
   coding-golden pass@1 0.96 (24/25)**, ~6s/task, live via Ollama `:11434` (leaderboard row
   `qwen25coder-onbox-2173`) — so it flipped from `verified:false` to `verified:true` (reproduced by us,
   not vendor-claimed). `capabilityScore` stays the vendor HumanEval anchor (0.86), not the easier 0.96 —
   a full external HumanEval/SWE-bench run on Qwen is the stronger follow-up. Test: `npm run test:local-engine` (7/7).
2. **Continue is frozen — do not build on it.** Field is thinning (Roo dead, Continue read-only),
   which *widens* the neutral, user-owned control-plane lane.
3. **Use an OSS memory store (Graphiti/cognee), don't defend CSF as a better store.** Our value is the
   accountability control plane *over* memory, not the store.
4. **The product is assembly + the accountability layer.** Stand on OpenHands/Aider (execution),
   Ollama+Qwen2.5-Coder (engine), LiteLLM (gateway), Graphiti/cognee (memory), SWE-bench+MiniCheck
   (verifiers), Pydantic-AI (orchestration). **Build only the four unoccupied things:** owned
   cross-repo memory control, hold-for-approval, receipts, outcome-routing.

## First slice (landed) + backlog

**Landed:** the coding-backend control plane — `apps/lantern-garage/lib/coding-backend/`. A backend
**proposes** a change, the control plane **holds it for approval** (consequence-gate pattern) and
emits a **receipt** (task, backend, model, cost, files, patch-hash, why, status) that no raw coding
agent produces; approve applies it, reject drops it. Backends: **mock** (tests), **ollama** (direct
Qwen2.5-Coder generation), **Aider**, **OpenHands** (#2172) — the agent adapters activate when their
CLI is installed and serve the registry-resolved local engine. Tested: `npm run test:coding-backend` (7/7).

**Wrapped-vs-raw benchmark (#2173, MEASURED):** `scripts/eval_coding_backend_ab.py` ran the 25 golden
tasks **raw** (direct qwen) vs **wrapped** (through the control plane), same model. Result:
**raw pass@1 1.00 = wrapped pass@1 1.00**, with **100% held-for-approval + 100% receipt coverage** —
the control plane costs **zero accuracy** and adds full accountability that no raw agent provides.
Report: `data/eval/coding-backend-ab-report.json`.

**Backlog (filed from this baseline):**
- #2171 — ship local engine on Qwen2.5-Coder; Ouro → research lane
- #2172 — OpenHands adapter (headless, LiteLLM)
- #2173 — real wrapped-vs-raw benchmark (Aider Polyglot / SWE-bench Lite)
- #2174 — verification-decides layer ✅ **LANDED** (`lib/coding-backend/verifier.js` + `verifiers/{tests-run,entailment}.js`: a verifier — not a model vote — judges the held proposal; verdict fills `receipt.test` (the #2175 router reads it); apply blocked on an enforced, decisive failure; `npm run test:coding-verifier`)
- #2175 — outcome-based per-repo routing ✅ **LANDED** (`lib/coding-backend/router.js`: routes by measured per-(repo,backend,taskType) success fed from receipts; cold-starts + cascade fallback; `npm run test:coding-router`)
- #2176 — evaluate Graphiti/cognee as the memory store
- #2177 — unify coding-backend approvals with the consequence-gate surface
- #2178 — loop-value experiment (Ouro audition for the local slot)
