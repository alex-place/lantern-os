---
author: Alex Place
created: 2026-06-19
updated: 2026-06-21
---

# Re-grounding the "Keystone OS kernel" model question — Ouro LoopLM vs the 2026 dense small-model frontier

> ## 📖 In plain English (start here)
>
> **What this is about:** every AI assistant needs a "brain" — the model that does the
> actual thinking. Lantern's brain is a small model called **Ouro**, and this page asks a
> simple question: *is Ouro still the right pick, or has something better come out?*
>
> **Why we even checked.** Someone ran a ChatGPT/Google report suggesting which model
> Lantern should use. It had two problems: it **never mentioned Ouro** (the brain we
> already run), and its suggestions were **about a year out of date**. So we redid the
> homework against real, checkable sources.
>
> **What makes Ouro special.** Most AI gets smarter by getting *bigger*. Ouro gets smarter
> by *thinking in loops* — re-reading a hard problem a few times instead of answering in
> one pass. That lets a tiny model (1.4 billion "knobs") keep up with models several times
> its size on reasoning — while still fitting on a normal gaming GPU.
>
> **The honest comparison.** The fair contest is Ouro against today's best small open
> models — **Qwen3.5-4B, Phi-4-mini, and Gemma 4** (the tiny phone-friendly one from
> Google). Not the older models the original report listed. *(Updated 2026-06-21: the
> frontier moved again — Gemma 4 and Qwen3.5 shipped in 2026; see §2.)*
>
> **The catch — we measure, we don't guess.** We score these brains on *Lantern's own
> tests* (does it continue a thought correctly? does it cite real sources? does it call the
> right tool?), not on generic trivia quizzes. Right now only Ouro has real scores
> (**80% correct**). So this page is a **plan for what to test next** — not a final pick.
> Nothing here changes the running system.
>
> *🎙️ Want it read aloud? Press the **Listen** bar at the bottom of this page.*
>
> The rest of this page is the precise, technical version. ↓

**Date:** 2026-06-19
**Type:** Research note (grounded follow-up to an external ChatGPT/Google shortlist)
**Status:** Research-only. No serving code changed; no model selected. Recommends what to *bench*, not what to *ship*.
**Grounding contract:** External Reality Rule — every model claim below carries a primary source (HF model card / vendor blog / arXiv). The prior report's `citeturn…` markers were ChatGPT rendering artifacts, **not citations**, and are treated as unsourced.

Related canon: [`RESEARCH-CANON.md`](../RESEARCH-CANON.md) · [`OURO-LOOPLM.md`](../OURO-LOOPLM.md) · [`SERVING-ARCHITECTURE-2026.md`](../SERVING-ARCHITECTURE-2026.md) · [`KEYSTONE-PRODUCT.md`](../KEYSTONE-PRODUCT.md) · [`CONVERGANCE-SIGMA0-BRIEFING.md`](../CONVERGANCE-SIGMA0-BRIEFING.md)

---

## 0. Why the external shortlist needed re-grounding

A ChatGPT/Google report shortlisted edge LLMs as a "Keystone OS kernel": **Llama 3.2 3B, Gemma "4 E2B", Phi-3.5-mini, Qwen2.5-7B** (+ Mistral-7B / Mixtral / Falcon3 / MPT alternates). Two grounding faults:

1. **It omits the kernel Lantern actually runs.** Lantern's served default is **ByteDance Ouro 1.4B LoopLM** behind an Ollama-compatible endpoint ([`scripts/ouro_serve.py`](../../scripts/ouro_serve.py)), with a native Σ₀ adaptive Q-exit loop as opt-in deep mode ([`src/sigma0/loop_lm.py`](../../src/sigma0/loop_lm.py)). The question is not "pick an edge model from scratch" — it is **"does anything beat the looped model we already serve, measured on our own metrics?"**
2. **Its list is ~1 generation stale.** Llama 3.2 3B, Phi-3.5-mini, Qwen2.5-7B, Mistral-7B-v0.3 are the **2024–25** generation. *(Correction 2026-06-21: the report's "Gemma 4 E2B" is **not** a mis-name — **Gemma 4 E2B is a real model** Google shipped Apr 2026; see the verified update in §2. This note originally read it as **Gemma 3n E2B** (Google, 2025), and that reinterpretation was itself the grounding error.)* The real 2026 dense small-model frontier (verified 2026-06-21) is **Qwen3.5-4B, Phi-4-mini (3.8B), Gemma 4 E2B/E4B** — with Ouro-1.4B as the incumbent and Llama 3.3 dropped (70B, wrong tier; caveat below).

This note re-frames the question on the axis **Ouro's own paper uses — Gemma 3 / Qwen3** — and scores candidates on **Lantern's metrics**, not MMLU.

---

## 1. The current kernel: Ouro LoopLM (what the external report omitted)

**Paper:** *Scaling Latent Reasoning via Looped Language Models* — [arXiv:2510.25741](https://arxiv.org/abs/2510.25741) ([HF paper page](https://huggingface.co/papers/2510.25741)). PDF in repo: [`docs/research-papers/ouro-looped-llm-2510.25741.pdf`](../research-papers/ouro-looped-llm-2510.25741.pdf).

**Mechanism (verified against the paper):** LoopLM reuses weight-tied layers **R times** in latent space (loop depth as a "third scaling axis"), with an **entropy-regularized objective for learned depth allocation** and **adaptive early-exit (Q-exit)**. Pre-trained to **7.7T tokens**. Core claim: the advantage is **knowledge *manipulation*, not knowledge *capacity*** — exactly the property a small grounded kernel wants (the KB supplies facts; the model reasons over them).

**Headline benchmark results (from the paper / HF page — primary):**
- **Ouro-1.4B** with 4 recurrent steps performs **comparably to Qwen3-4B**, and scores **82.40 on MATH500 vs 59.60 for Qwen3-4B**.
- **Ouro-2.6B** outperforms dense models up to **8B**: **80.46 on BBH**, surpassing **Qwen3-8B (77.65)** and **Llama-3.1-8B (71.56)**.
- Net: 1.4B ≈ 4B-class, 2.6B ≈ 8B-class on reasoning (BBH, GSM8K, MATH500). The paper benchmarks against **Gemma 3 (1B/4B/12B)** and **Qwen3 (1.7B/4B/8B)** — that is the correct comparison axis for Lantern, **not** the 2024 models the external report listed.

**What Lantern actually implements (from [`OURO-LOOPLM.md`](../OURO-LOOPLM.md)):**
- `Sigma0LoopLM` runs the paper's Q-exit policy (λ→survival→CDF→first-step ≥ q) on Ouro's pretrained weight-tied block + exit gate. We do **not** pretrain (that needs 7.7T tokens) — we activate adaptive inference the **stock checkpoint leaves off** (stock `generate()` runs fixed full depth).
- **Two serving modes** (decided 2026-06-18, [`SERVING-ARCHITECTURE-2026.md`](../SERVING-ARCHITECTURE-2026.md)): **FAST** = stock `generate()` + `UniversalTransformerCache` + anti-repetition decode (product default, target <2 s); **DEEP** = native no-cache Q-exit loop (`OURO_NATIVE=1`, ~1 s/token, opt-in).
- **Measured baseline** ([`KEYSTONE-PRODUCT.md`](../KEYSTONE-PRODUCT.md), RTX 3070 8GB, `eval_keystone` golden set): `ouro-fast-merged-sdpa` = **80% (8/10) accuracy, 23.7 s avg latency** (`OURO_MERGE=1 OURO_ATTN=sdpa`, ~2.8× faster than the 65.8 s unmerged/eager row at equal accuracy). Persistent misses: #5 multi-step arithmetic, #6 primary-colors→RGB — small-model reasoning limits.

**Honest scope (carried from the canon):** the native loop is **inference-time only** (no pretraining); realized-depth and training-loss figures are **live console observations, not persisted benchmark artifacts**. Speed — not degeneration — is now the product gate; `llama.cpp` **cannot** run the looped arch (relevant to runtime choices below).

---

## 2. The real 2026 frontier (primary-source verified)

Every row verified against the HF model card / vendor blog. The external report's picks are shown for contrast.

| Model | Params | Context | Modality | Released | Primary source |
|---|---|---|---|---|---|
| **Ouro-1.4B / 2.6B LoopLM** *(current kernel)* | 1.4B / 2.6B (4 loop steps) | — | text | Oct 2025 | [arXiv:2510.25741](https://arxiv.org/abs/2510.25741) |
| **Qwen3-4B** | 4B dense | 32K native / 131K YaRN | text, hybrid thinking | 2025 | [HF: Qwen/Qwen3-4B](https://huggingface.co/Qwen/Qwen3-4B) |
| **Qwen3-8B** | 8B dense | 32K / 131K YaRN | text | 2025 | [HF: Qwen/Qwen3-8B](https://huggingface.co/Qwen/Qwen3-8B) |
| **Phi-4-mini** | 3.8B dense | 128K | text, function-calling | Feb 2025 | [HF: microsoft/Phi-4-mini-instruct](https://huggingface.co/microsoft/Phi-4-mini-instruct) |
| **Gemma 3n E2B** | ~1.91B *effective* (5B raw, PLE/MatFormer) | 32K | **multimodal** (text/image/audio), on-device | 2025 | [Google AI: Gemma 3n](https://ai.google.dev/gemma/docs/gemma-3n) · [dev blog](https://developers.googleblog.com/en/introducing-gemma-3n-developer-guide/) |
| **Llama 3.3** | **70B only** | 128K | text | Dec 2024 | [HF: meta-llama/Llama-3.3-70B-Instruct](https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct) |
| *(external report's stale picks)* | | | | | |
| Llama 3.2 3B | 3B | 128K | text, edge | Sep 2024 | [Meta blog](https://ai.meta.com/blog/llama-3-2-connect-2024-vision-edge-mobile-devices/) |
| Phi-3.5-mini | 3.8B | 128K | text | Aug 2024 | [HF: microsoft/Phi-3.5-mini-instruct](https://huggingface.co/microsoft/Phi-3.5-mini-instruct) |
| Qwen2.5-7B / Mistral-7B-v0.3 | 7B | — | text | 2024 | vendor cards |

**Three corrections that matter for kernel selection:**

1. **"Gemma 4 E2B" was real all along — NOT a mis-name** *(corrected 2026-06-21; see the verified update above).* Google shipped **Gemma 4** in Apr 2026 with a genuine **E2B = 2.3B-effective (5.1B w/ embeddings)** edge variant, so the external report's name resolves to an actual model. This note's original move — reinterpreting it as *Gemma 3n E2B* — was the grounding error (whether the source report predated Gemma 4's Apr-2026 release, making the name a lucky hallucination, or referenced the real model, is unknown; either way it must now be treated as real). **Historical context:** Gemma 3n E2B (Google 2025) is the predecessor it was confused with — `E` = *Effective* params (raw 5B → ~1.91B effective / ~2 GB VRAM via PLE caching + MatFormer + parameter-skipping), multimodal (MobileNet-v5 vision + audio, 140 langs) ([Gemma 3n](https://ai.google.dev/gemma/docs/gemma-3n)). **Gemma 4 E2B/E4B now supersede it** as the edge/multimodal candidate — still capacity-light cores, the property that cuts against the LoopLM thesis.

2. **Llama 3.3 is 70B-only.** Meta shipped **no** small 3.3 variant ([HF card](https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct), Dec 2024). The edge-class Llama is **3.2 1B/3B** ([Meta blog](https://ai.meta.com/blog/llama-3-2-connect-2024-vision-edge-mobile-devices/)). So "Llama 3.3" does **not** belong on a sub-8B edge-kernel shortlist — at 70B it is a different deployment tier than Ouro-1.4B (~6 GB on GPU). Treat it as a *cloud/ceiling* reference, not a kernel candidate.

3. **Qwen3-4B is the paper's head-to-head; Qwen3.5-4B is now the current one.** Qwen3-4B is *exactly* the model Ouro-1.4B is benchmarked against in the source paper — so reproduce **that** comparison on our golden set rather than trust the paper's external benchmarks transitively. *(Corrected 2026-06-21: for a current kernel decision, bench against **Qwen3.5-4B**, the shipped successor — see §2 verified update; Qwen3-4B remains the apples-to-apples check against the paper's numbers.)*

> **Frontier-has-moved-again — VERIFIED 2026-06-21** (was a low-confidence forward-watch item; now grounded to model-card / arXiv level). The June-2026 titles were **real, not rendering artifacts**. Confirmed against primary sources:
> - **Gemma 4 — REAL.** Google shipped it (initial Apr 2026; encoder-free "unified" **12B** variant Jun 3 2026). Edge-class sizes: **E2B = 2.3B effective (5.1B w/ embeddings)** and **E4B = 4.5B effective (8B w/ embeddings)**, both 128K, **multimodal text/image/audio**; plus 12B (256K), 31B dense, and a **26B-A4B MoE (3.8B active)** ([Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4) · [blog.google](https://blog.google/innovation-and-ai/technology/developers-tools/introducing-gemma-4-12b/)). **This supersedes Gemma 3n E2B** as the edge/multimodal candidate scored below.
> - **Qwen3.5 & Qwen3.6 — REAL (both).** Qwen3.5 (Feb 16 2026; 397B-A17B flagship, 262K ctx, 201 langs) ships small dense variants **Qwen3.5-9B / 4B / 2B / 0.8B**; Qwen3.6 (Apr 2026; agentic-coding focus, 27B dense + 35B-A3B MoE, 262K ctx) ([QwenLM/Qwen3.6](https://github.com/QwenLM/Qwen3.6) · [CNBC](https://www.cnbc.com/2026/02/17/china-alibaba-qwen-ai-agent-latest-model.html)). **Qwen3.5-4B is the new head-to-head**, superseding Qwen3-4B.
> - **Phi-4 successor — NOT FOUND.** No Phi-5 / Phi-4.5 surfaced; **Phi-4-mini (3.8B) remains current** ([Azure Phi](https://azure.microsoft.com/en-us/products/phi)). The Phi rows below stand unchanged.
> - **arXiv:2604.07035 — REAL paper, wrong title.** The title guessed above was incorrect. Actual = *"Unified Deployment-Aware Evaluation of Open Reasoning Language Models"* (Md Motaleb Hossen Manik & Ge Wang) — a **deployment-aware, multi-objective (accuracy × latency × memory) eval**, i.e. exactly Lantern's *bytes-per-correct* axis, not a leaderboard. Finding: **Gemma-4-E4B** is "a strong practical operating point … substantially lower latency and memory" ([arXiv:2604.07035](https://arxiv.org/abs/2604.07035)).
>
> **Net:** the frontier *this note itself* named (Qwen3-4B / Phi-4-mini / Gemma 3n E2B) is ~1 generation stale as of 2026-06-21. Corrected head-to-head set = **Qwen3.5-4B, Phi-4-mini (unchanged), Gemma 4 E2B/E4B**. Ouro-1.4B remains the incumbent (no new LoopLM release found). The §3 benchmark *plan* is unchanged in shape — only the opponent names move. The §2 table and §3 cells below are preserved as the original (now prior-gen) snapshot; read them through this correction.

---

## 3. Score on Lantern's OWN metrics, not MMLU

Per the **Convergence Core Research Program** (Drive: *Instrumenting the Black Box — A Ten-Year Research Program*; repo PDFs [`Convergence-Core-Research-Program-v1.1.pdf`](../Convergence-Core-Research-Program-v1.1.pdf)) and [`CONVERGANCE-SIGMA0-BRIEFING.md`](../CONVERGANCE-SIGMA0-BRIEFING.md), Lantern grades a kernel on **whether it advances the single loop** (Observe→Remember→Reason→Act→Verify→Converge), not on leaderboard trivia. The kernel-relevant metrics:

| Lantern metric | Loop stage | What it measures | Why a general benchmark misses it |
|---|---|---|---|
| **Continuation accuracy** | Reason | next-step correctness on *our* golden set (`data/eval/sigma0-prompts.jsonl`) | MMLU is trivia; we serve repo-grounded reasoning |
| **Grounding precision** | Observe/Verify | fraction of `[claim, evidence, confidence, source]` tuples whose source actually supports the claim (External Reality Rule) | no public benchmark scores citation-faithfulness against *your* KB |
| **Action correctness** | Act | did the chosen tool/route achieve the intended state change | benchmarks don't exercise our convergence router |
| **Tool-call validity** | Act | fraction of emitted tool calls that are schema-valid and executable | function-calling benches ≠ our MCP tool schemas |
| **CSF compression ratio** | Remember | bytes of CSF needed to round-trip a belief/observation state | architecture-specific to the Status Cube / CSF format |
| **Bytes-per-correct-continuation** | (efficiency) | served bytes (latency×tok) per *correct* continuation — the true product cost | conflates the two things FAST/DEEP split apart |

**`scripts/eval_keystone.py` already produces the first two cheaply** for any Ollama-API backend → `data/eval/leaderboard.jsonl`. The rubric below is the *measurement plan*; the cells are **priors to be tested**, not measured results (only the Ouro-fast row is measured today).

### Qualitative priors (to be replaced by `eval_keystone` rows)

| Candidate | Continuation acc. | Grounding precision | Action / tool-call validity | Bytes-per-correct (efficiency) | CSF / fit notes |
|---|---|---|---|---|---|
| **Ouro-1.4B (current)** | **80% measured** (8/10) | strong-by-design (manipulation > capacity; KB supplies facts) | untested on MCP schemas | FAST 23.7 s/prompt measured; loop recurrence is the per-token tax | runtime locked to transformers 4.57; **no llama.cpp** |
| **Ouro-2.6B** | prior: ≥1.4B (paper: 8B-class) | ≥1.4B | untested | **slower** — 2.6B × 4 loops × VRAM; gated on "bench before VRAM spend" roadmap item | same runtime constraint |
| **Qwen3-4B** | the head-to-head (paper: ≈Ouro-1.4B, **worse on MATH500**) | hybrid-thinking may help Reason; needs measuring | mature tool/function-calling ecosystem | single forward pass → likely **cheapest bytes-per-correct** of the dense set | runs on llama.cpp/vLLM/Ollama → trivial to serve |
| **Phi-4-mini (3.8B)** | strong on math/code/reasoning per card; unmeasured here | unknown vs our KB | **explicit function-calling** in card — promising for Act | single pass, 3.8B → cheap | drop-in via Ollama; good Act candidate |
| **Gemma 3n E2B** | ~2B-effective → likely **below** Ouro on Reason | unknown | unknown | **cheapest VRAM (~2 GB)**; multimodal opens Observe over images/audio | only multimodal + truest edge option; capacity-light cuts against LoopLM thesis |
| **Llama 3.3 (70B)** | ceiling reference, not a kernel | — | — | wrong tier (70B ≠ edge) | use as cloud upper-bound only |

**Reading:** the LoopLM bet is that **continuation accuracy + grounding precision per VRAM** beats the dense models because reasoning is *looped in latent space* rather than spent on knowledge capacity — and the one measured Lantern number (80% on the golden set at 1.4B) is consistent with that. The dense frontier's counter-bet is **bytes-per-correct-continuation**: a single forward pass with no 4× recurrence tax, on runtimes (llama.cpp/vLLM) that the looped arch can't use. **That tradeoff is precisely what `eval_keystone` + `blind_study` exist to settle — so settle it with rows, not priors.**

---

## 4. LoopLM-adjacent context (Drive `local_llm` + Coconut)

LoopLM is one point in a **latent-reasoning** family; the kernel decision should be read against it:

- **Coconut — *Training LLMs to Reason in a Continuous Latent Space*** ([arXiv:2412.06769](https://arxiv.org/abs/2412.06769), Meta, Dec 2024; [code](https://github.com/facebookresearch/coconut)). Feeds the model's **last hidden state back as the next input embedding** ("continuous thought") instead of decoding to tokens — reasoning in latent rather than language space, BFS-like exploration of multiple paths. **This is the conceptual parent of Lantern's re-prompt loop:** [`lib/loop-reasoner.js`](../../apps/lantern-garage/lib/loop-reasoner.js) already feeds each prior answer back as a "Coconut-style context prefix" (an *API-level* approximation — not true shared-weight latent loops, confidence/exit are heuristic). Coconut = the **why** behind LoopLM; Ouro = the **pretrained-in** version Lantern serves.
- **Distinction worth keeping straight:** Coconut/LoopLM (continuous latent loop, weight-tied) vs. token-space chain-of-thought (the dense frontier's "thinking" modes, e.g. Qwen3 hybrid thinking). Gemma 3n / Phi-4-mini / Qwen3 all reason in **token space**; only Ouro reasons in **latent loop space**. That is the single biggest architectural axis in this decision — and the one MMLU cannot see.
- **Drive `local_llm` folder + the Ouro PDF** (founder's Google Drive) are the off-repo source set; per [data architecture](../../CLAUDE.md) real papers/data live in Drive, code + sanitized notes in repo. This note is the repo-side index; the Drive folder is the corpus.

---

## 5. Conclusions (research-only — no decision taken)

1. **The kernel question is not open — it has an incumbent.** Lantern serves **Ouro-1.4B LoopLM** (FAST default, 80%/23.7 s measured). The external report's omission of it makes its entire shortlist moot as written. Reframe: *"what, measured on our metrics, beats the looped model we already run?"*
2. **The honest comparison axis is Gemma / Qwen3** — the model families Ouro's own paper benchmarks against — **not** Llama 3.2 3B / Phi-3.5 / Qwen2.5-7B. Use the **verified-current** 2026 frontier (**Qwen3.5-4B, Phi-4-mini, Gemma 4 E2B/E4B**; see §2 update of 2026-06-21); drop "Llama 3.3" as a kernel candidate (70B, wrong tier).
3. **Decide with `eval_keystone` rows, not paper transitivity.** The highest-value next experiments, in order:
   - **(a) Ouro-1.4B vs Qwen3.5-4B** on the golden set (continuation acc + grounding precision + bytes-per-correct) — the current successor to the paper's exact head-to-head (Qwen3-4B), reproduced on *our* data; run Qwen3-4B too if cross-checking the paper's numbers.
   - **(b) Phi-4-mini** as the **Act/tool-call** candidate (explicit function-calling) — measure tool-call validity against our MCP schemas.
   - **(c) Ouro-2.6B vs 1.4B** — already a roadmap item ("bench before VRAM spend"); gate the VRAM on a measured accuracy delta.
   - **(d) Gemma 4 E2B/E4B** only if **multimodal Observe** (image/audio grounding) becomes a product requirement — these supersede Gemma 3n E2B, but the ~2–4.5B-effective cores are still unlikely to win on pure Reason.
4. **Grow the golden set first** (roadmap item 5): today's 10 prompts are trivia-heavy; grounding precision / action correctness / CSF compression are **not yet instrumented** in `eval_keystone`. Those metrics must exist before any of the above rows mean anything — otherwise we'd be re-importing the MMLU mistake the external report made.

**Nothing here changes serving config or selects a model.** It converts an unsourced external shortlist into a grounded, primary-source-verified benchmark plan on Lantern's own axes.

---

### Sources (primary, verified 2026-06-19)
- Ouro LoopLM paper — [arXiv:2510.25741](https://arxiv.org/abs/2510.25741) · [HF paper page](https://huggingface.co/papers/2510.25741)
- Coconut — [arXiv:2412.06769](https://arxiv.org/abs/2412.06769) · [facebookresearch/coconut](https://github.com/facebookresearch/coconut)
- Qwen3-4B — [HF model card](https://huggingface.co/Qwen/Qwen3-4B) · Qwen3-8B — [HF](https://huggingface.co/Qwen/Qwen3-8B)
- Phi-4-mini — [HF model card](https://huggingface.co/microsoft/Phi-4-mini-instruct)
- Gemma 3n — [Google AI for Developers](https://ai.google.dev/gemma/docs/gemma-3n) · [Google dev blog](https://developers.googleblog.com/en/introducing-gemma-3n-developer-guide/)
- Llama 3.3 70B — [HF model card](https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct) · Llama 3.2 edge — [Meta blog](https://ai.meta.com/blog/llama-3-2-connect-2024-vision-edge-mobile-devices/)
- **2026-06-21 frontier verification (primary):** Gemma 4 — [model card](https://ai.google.dev/gemma/docs/core/model_card_4) · [blog.google](https://blog.google/innovation-and-ai/technology/developers-tools/introducing-gemma-4-12b/) · Qwen3.5/3.6 — [QwenLM/Qwen3.6](https://github.com/QwenLM/Qwen3.6) · [CNBC](https://www.cnbc.com/2026/02/17/china-alibaba-qwen-ai-agent-latest-model.html) · Phi-4-mini still current — [Azure Phi](https://azure.microsoft.com/en-us/products/phi) · arXiv:2604.07035 = *Unified Deployment-Aware Evaluation of Open Reasoning Language Models* (Manik & Wang) — [arXiv](https://arxiv.org/abs/2604.07035)

**Internal:** [`OURO-LOOPLM.md`](../OURO-LOOPLM.md) · [`SERVING-ARCHITECTURE-2026.md`](../SERVING-ARCHITECTURE-2026.md) · [`KEYSTONE-PRODUCT.md`](../KEYSTONE-PRODUCT.md) · [`RESEARCH-CANON.md`](../RESEARCH-CANON.md) · [`CONVERGANCE-SIGMA0-BRIEFING.md`](../CONVERGANCE-SIGMA0-BRIEFING.md) · [`lib/loop-reasoner.js`](../../apps/lantern-garage/lib/loop-reasoner.js)
