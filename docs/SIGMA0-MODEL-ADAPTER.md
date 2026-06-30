# Σ₀ Local-Model Adapter

**Status:** Implemented (2026-06-26) · **Loop stages improved:** Reason, Verify

> "Models are interchangeable. The Convergence Core never assumes a specific LLM.
> All models plug in as replacements." — CLAUDE.md

This is the single place that answers, for the **local** backends: *which model
should lead this task, does it fit the box, and does it self-converge?* It feeds
the existing `lib/loop-reasoner.js` and the existing Ollama-compatible transport —
it is **extension, not a new subsystem**.

---

## 1. The decision: what "best local model" means here

The box is the constraint: **8 GB VRAM, one model process at a time.** That
hard-caps the candidate set. Grounded comparison of what actually fits (web,
June 2026):

| Candidate | Fits 8 GB? | Task strength | Σ₀ fit |
|---|---|---|---|
| **Ouro-1.4B-Thinking** (default) | Yes, easily | Weak raw coding (~10% in the local parity test) | **Native** — Q-exit *is* the collapse-certificate thesis |
| **Qwen2.5-Coder-7B** (Q4_K_M ~4.7 GB) | Yes | Strongest code model in the 8 GB tier | Wraps under `loopedReason()`; no native Q-exit |
| Qwen3-Coder-Next (80B MoE / 3B active) | **No** — MoE stores all experts (~40 GB+ @ Q4) | SOTA (>70% SWE-Bench) | Not on this box |
| DeepSeek-R1-Distill-7B/8B (Q4 ~5–6 GB) | Yes | Best hard-reasoning "second brain" | Reasoning, not agentic coding |

**Resolution (Ouro stays default):** Ouro-1.4B remains the Σ₀-native default —
its recurrent depth + Q-exit *is* what Σ₀ is. **Qwen2.5-Coder-7B** is registered
as the opt-in **capability lever**: when you want raw coding accuracy and it fits
the VRAM budget, flip one flag and it leads, wrapped by the convergence loop so it
stays Σ₀-compliant.

Sources: [Microcenter — local LLMs by memory tier](https://www.microcenter.com/site/mc-news/article/best-local-llms-8gb-16gb-32gb-memory-guide.aspx) ·
[Tembo — best local LLM for coding 2026](https://www.tembo.io/blog/best-local-llm-for-coding) ·
[daily.dev — best local LLM models 2026](https://daily.dev/blog/best-local-llm-models-run/) ·
[qwen.ai — Qwen3-Coder-Next](https://qwen.ai/blog?id=qwen3-coder-next) ·
Ouro paper [arXiv 2510.25741](https://arxiv.org/abs/2510.25741).

---

## 2. The contract

`apps/lantern-garage/lib/local-model-registry.js` declares each local backend:

| Field | Meaning |
|---|---|
| `id` | Served model name (what `/api/chat` receives) |
| `endpoint` | Base URL of the Ollama/OpenAI-compatible server |
| `selfConverges` | `true` = loops / Q-exits **internally** (Ouro). `false` = single-pass → the Core **must wrap it** in `loopedReason()` to be Σ₀-compliant |
| `toolCalling` | Trained for `tool_use` / function calling |
| `vramGB` | Approx VRAM at the served quant — the 8 GB-box gate |
| `ctxTokens` | Usable context window |
| `taskTypes` | Intents this model is eligible to **lead** |
| `rank` | Default preference within a task (lower = earlier) |
| `capabilityScore` | Raw-task strength 0–1 (used under capability-first) |

**Source of truth:** built-in defaults in the module, overlaid by
`data/models/local-registry.json` (operator-editable, ~60 s TTL — no consumer
restart needed beyond that).

### Why `selfConverges` is the key field

The convergence loop must sit **above** the backend, not inside it:

```
Convergence Core (Reason / Act)
   │
   ├─ selectChain(taskType)            ← registry: best LOCAL model that fits VRAM
   │
   ├─ if  selfConverges(lead)  → call model directly      (Ouro: Q-exit inside)
   │  else                     → loopedReason(model)       (Qwen: cdfExit wraps it)
   │
   └─ Verify gate (existing grounding / requireVerified)
```

Before this adapter, the `LOOP_REASONER` path was **blind to the model**: it would
double-loop a self-converging Ouro *and* skip the grounding loop for a
non-self-converging model. The registry makes that decision a capability lookup.
Unknown models default to `selfConverges=false` → wrapped (grounding by default).

---

## 3. Selection rules

`selectChain(taskType, opts)` returns the VRAM-fitting models eligible to lead,
best-first:

- **Default order** = `rank` ascending → **Ouro leads** every task it's eligible for.
- **Capability-first** (`LOCAL_CAPABILITY_FIRST=1` or `opts.capabilityFirst`) =
  `capabilityScore` descending → the strongest model that **still fits the box**
  leads. (A model that doesn't fit `VRAM_BUDGET_GB` can never lead — the gate is
  applied first, so capability-first on a 4 GB box still yields Ouro.)
- **Kernel is strict:** `"default"`-tagged general-fallback models are **not**
  widened into the `kernel` task. The Σ₀ Convergence Core path only uses models
  that explicitly opt into `kernel`.

### Config flags

| Env | Default | Effect |
|---|---|---|
| `VRAM_BUDGET_GB` | `8` | The box budget. Models with `vramGB >` this are gated out. |
| `LOCAL_CAPABILITY_FIRST` | `0` | `1` → best-capability-that-fits leads (Qwen for coding). |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Default endpoint for all entries. |
| `OLLAMA_MODEL` | — | Operator pin. Kept as a chain **candidate**; it only **leads** when it is a model the registry does **not** manage (a deliberate custom GGUF). A registry-managed pin keeps its capability slot — see `resolveLocalLead` below. |

### The authoritative lead: `resolveLocalLead(intent, opts)`

`selectChain` answers "what's the capability order?" — but keystone chat needs ONE
authoritative lead that folds in the operator's `OLLAMA_MODEL` pin and the caller's
served-fallback chain. `resolveLocalLead(intent, { pin, fallback })` is that single
resolver:

1. An `OLLAMA_MODEL` pin the registry does **not** manage (a custom model) → it leads.
2. Otherwise the registry's capability-gated `#1` leads; the pin stays a candidate.

This fixed a real bug: a stale `OLLAMA_MODEL=ouro:latest` (the legacy default) used to
**front-jump the chain and silently defeat the capability swap** — keystone chat stayed
pinned to Ouro while the adapter had already picked the better model. The lead is now
re-asserted as the chain head *after* the leaderboard reorder, so neither a stale pin nor
measured win-rate can displace the deterministic, VRAM-gated swap pick.
`LOCAL_CAPABILITY_FIRST=0` still restores Ouro-first (rank-order) cleanly. The chosen
local model + reason is surfaced in the chat reply signature (a `⇄ <model>` chip).

---

## 4. Serving the backends (one process at a time)

The 8 GB box serves **one** local model on `:11434`. The two backends are
mutually exclusive at runtime; the registry remains the source of truth for
capabilities regardless of which is currently up.

**Ouro (default, Σ₀-native):**
```bash
OURO_NATIVE=1 OURO_ADAPTER=<dir> python scripts/ouro_serve.py   # speaks Ollama on :11434
```

**Qwen (capability lever):**
```bash
ollama pull qwen2.5-coder:7b          # real Ollama on :11434
LOCAL_CAPABILITY_FIRST=1 LOOP_REASONER=1 npm start --prefix apps/lantern-garage
```
`LOOP_REASONER=1` is what actually wraps Qwen in the convergence loop (Ouro
ignores it — it Q-exits internally). When VRAM grows, registering the next model
(e.g. Qwen3-Coder-Next) is a **one-line** `data/models/local-registry.json` add.

---

## 5. Where it plugs in

| File | Change |
|---|---|
| `lib/local-model-registry.js` | **New** — the adapter/registry + contract. |
| `data/models/local-registry.json` | **New** — declarative, operator-editable overlay. |
| `lib/provider-router.js` | Coding chain leads `ouro:latest` then `qwen2.5-coder` (Ouro default). |
| `lib/stream-chat.js` | (a) local model chain is registry-led via `resolveLocalLead` (VRAM-gated); the lead is re-asserted as the chain head after the leaderboard reorder so a stale `OLLAMA_MODEL` pin can't defeat the swap; (b) the `LOOP_REASONER` wrap is `selfConverges`-aware (no double-loop on Ouro, grounding wrap for Qwen); (c) the swap decision is stamped onto the done signature so the UI can surface the chosen model. |
| `test/local-model-registry.test.js` | **New** — capability-first, VRAM gating, `selfConverges` contract, kernel-strict, the grounding gate, and the `resolveLocalLead` pin-precedence cases (stale-pin-doesn't-win, custom-pin-leads, rank-order escape). |

All wiring is additive and falls back to prior behavior on any error.

---

## 6. Σ₀ alignment

- **Reason:** better local-model selection (fit-aware, capability-aware) — *one*
  selection layer, not a parallel router.
- **Verify:** the `selfConverges` contract keeps the convergence loop honest —
  every non-self-converging model is grounded by `loopedReason()`; the
  self-converging one isn't redundantly looped.
- **No sprawl:** no new memory system, no new agent ecosystem, no second serving
  path. One contract, feeding the existing loop + the existing transport.
