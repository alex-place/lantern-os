---
author: Alex Place
created: 2026-07-18
updated: 2026-07-18
---

# The Convergence Blueprint — one loop, everything we know

*The whole system, AGI-scope, as one document organized by the North-Star loop:
**Observe · Remember · Reason · Act · Verify · Converge**. Each stage lists the
conventional best practice (cited, 2026), what we have in-repo, and the honest gap.
This is the synthesis of what we know: the [Collapse Certificate](SIGMA0-COLLAPSE-CERTIFICATE.md)
is the **Verify** discipline; the frontier-model literature supplies the rest.*

> **Companion docs, not replacements.** North Star: [CONVERGANCE-SIGMA0-BRIEFING.md](CONVERGANCE-SIGMA0-BRIEFING.md).
> Living references: [RESEARCH-CANON.md](RESEARCH-CANON.md). Code alignment:
> [convergence-core-mapping.md](convergence-core-mapping.md). Verify economics:
> [SIGMA0-GROUNDING-LEDGER.md](SIGMA0-GROUNDING-LEDGER.md). This document is the *map over
> all six stages*; those go deep on one each.

---

## The thesis (grounded, and it sets expectations)

Building the best AI model possible in 2026 is **"not algorithmic creativity, it is efficiency
optimization"**; **data quality matters more than algorithm choice**; and **architecture is
treated as a commodity** — every frontier model is a Transformer, and MoE is behind virtually all
of them ([LLM Anatomy 2026](https://pasqualepillitteri.it/en/news/2023/llm-anatomy-2026-frontier-ai-training);
[Toloka](https://toloka.ai/blog/how-frontier-labs-build-pre-training-datasets/);
[MoE comparison](https://www.digitalapplied.com/blog/moe-architecture-comparison-gpt-claude-deepseek-qwen)).

Two consequences for an AGI-scope program:

1. **The differentiator is execution across the whole loop, not one clever mechanism.** No stage
   below is won by novelty; it is won by data + systems + disciplined iteration.
2. **Our genuine edge is the Verify stage.** The 2026 agentic frontier's *named* failure modes —
   "error accumulation, goal drift, context degradation over long trajectories" and "memory
   staleness → confidently wrong" ([agent-memory 2026](https://machinelearningmastery.com/the-6-best-ai-agent-memory-frameworks-you-should-try-in-2026/);
   [long-horizon reliability](https://medium.com/@nraman.n6/the-architecture-of-agency-a-deep-technical-guide-to-agentic-ai-systems-in-2026-9df63b37f6df)) —
   are *exactly* the collapse-without-grounding phenomena the Collapse Certificate formalizes. So
   our Verify discipline is not a corner of the loop; it is the discipline the whole loop is
   currently missing at the frontier.

**Evidence classes used below:** `ESTABLISHED` (conventional, external, cited) · `IN-REPO` (we
have it, with pointer) · `GAP` (needed, not ours, sourced) · `OURS` (a genuine in-repo
contribution — rare, and only the Verify discipline qualifies). No arXiv ID is cited unverified
(see the Certificate's fabricated-ID caution).

---

## OBSERVE — contact with external reality

*The loop's only tie to ground truth. Everything downstream degrades without it (that is the
Certificate's central result).*

- **Best practice (ESTABLISHED).** Two channels. **(a) Training-time observation = pretraining
  data**: curation, dedup, quality filtering, and LLM-**rephrasing** of low-quality web text
  (standard since late 2024), with a **human-data anchor ≥60–70%** and synthetic data as targeted
  amplification on verifiable domains. The binding constraint at the frontier is data, not FLOPs —
  high-quality public web text is forecast **exhausted 2026–2028**
  ([Toloka](https://toloka.ai/blog/how-frontier-labs-build-pre-training-datasets/);
  [Epoch AI](https://epoch.ai/data-insights/open-models-threshold)). **(b) Inference-time
  observation = retrieval + tools + multimodal input**: multi-signal retrieval (semantic + keyword
  + entity + graph, run in parallel) beats sequential
  ([agent-memory 2026](https://machinelearningmastery.com/the-6-best-ai-agent-memory-frameworks-you-should-try-in-2026/)).
- **In-repo (IN-REPO).** `lib/tool-runner.js` native tools (`web_search`, market data, doc
  extract, `recall_memory`); the arXiv corpus + BM25 retrieval; the RAG reranker (local
  cross-encoder, +21pt MRR on low-overlap — [[rag-reranker-is-the-win-not-m2v]]).
- **GAP.** We have **no pretraining-data pipeline** — no FineWeb-style curation, no rephrasing,
  no mixture-law tuning. This is the single largest gap and the frontier's #1 bottleneck. Sourced:
  [QuaDMix quality-diversity selection](https://arxiv.org/pdf/2504.16511); mixture prediction via
  scaling laws.

## REMEMBER — knowledge, in weights and outside them

*Two memories, deliberately: parametric (learned) and persistent (append-only + archive). The
Certificate's rule — one JSONL append + one CSF archive — is the anti-sprawl guard here.*

- **Best practice (ESTABLISHED).** **Parametric**: 10–20T-token pretraining puts knowledge in
  weights; **MoE** raises knowledge capacity at fixed active-FLOPs. **Non-parametric**: 2026
  treats memory as a *dedicated architectural component*, not a longer prompt — vector retrieval
  for fuzzy knowledge + key-value for structured state + episodic logs for audit; tiered
  "OS-memory-hierarchy" management (Letta-style: context = RAM, store = disk). **Named failure:
  staleness → confidently wrong** ([agent-memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026);
  [context→dreams](https://next.redhat.com/2026/06/01/from-context-to-dreams-architecting-memory-for-ai-agents/)).
- **In-repo (IN-REPO).** CSF archive (one lossless zstd/zlib-backed store) + append-only JSONL
  memory; MemOS per-keeper cubes; conversation-per-user profiles. Working "knowledge RENTED, not
  owned" hybrid-architecture stance ([[hybrid-architecture-redteam-verified]]).
- **OURS (Verify-adjacent).** The staleness failure mode *is* the Certificate's drift: a
  highly-retrieved memory that is "confidently wrong after the user changes jobs" is a grounding
  failure, and the §4 surprise/NIS canary + the Grounding Ledger's freshness law are the exact
  discipline for it. **[claim: our memory-verify discipline addresses the frontier's named
  staleness failure · confidence: Medium — argued, not yet measured on an agent · source:
  agent-memory 2026 + cert §4/§8.4.1]**
- **GAP.** No trained MoE knowledge base of our own; parametric memory is rented from base models.

## REASON — the core model + inference-time compute

*Where the loop actually thinks. Architecture is commodity; the live frontier is **test-time
compute** — and it is exactly the looped/latent-reasoning family the project already bet on.*

- **Best practice (ESTABLISHED).** **Architecture**: Transformer + **MoE** (commodity, but the
  scaling substrate). **Reasoning**: explicit long-CoT + search (majority vote, ToT, MCTS) *and*
  **latent/looped reasoning** — recurrence + parameter sharing scale depth at test time; a
  3.5B recurrent-depth model reaches ~50B single-pass effective compute by adding loops
  ([latent-reasoning survey arXiv:2507.06203](https://arxiv.org/pdf/2507.06203);
  [Ouro/LoopLM arXiv:2510.25741](https://www.emergentmind.com/papers/2510.25741);
  [LoopFormer](https://loopformer.github.io/)). Budget-conditioned depth is the efficiency lever.
- **In-repo (IN-REPO).** **Ouro-1.4B LoopLM** is the serving substrate (weight-tied recurrent
  transformer, dynamic depth) — the project is *already* on the winning test-time-compute
  architecture ([[ouro-looplm-research]]; ADR-0021). Nested adaptive Reason (Q-exit + escalation).
- **OURS (Verify-adjacent).** The looped-LM's known pathology — **"performance peaks at a depth
  then collapses"** — is the Certificate's §1 result on *real* models, and the §1.2.3 acceptance
  gate (`ρ(J)<1`, adopted from STARS [arXiv:2605.26733](https://arxiv.org/pdf/2605.26733)) is the
  stability discipline for it. This is the one place our Verify work and the frontier Reason
  architecture are the same object.
- **GAP.** We do not *train* the reasoner (Ouro is rented); reasoning-RL (below, Converge) is
  gate-only, not a training loop we run.

## ACT — tools, code, actuation, agency

*Turning a thought into an external effect — and the point where verification must re-enter,
because actions compound error.*

- **Best practice (ESTABLISHED).** Modular agent architecture: tool-calling, code execution,
  planner/executor separation, and **verification-in-the-loop** because **long-horizon
  reliability collapses** — agents are far less reliable over 100-step than 10-step trajectories;
  error accumulation and goal drift worsen with length
  ([architecture of agency 2026](https://medium.com/@nraman.n6/the-architecture-of-agency-a-deep-technical-guide-to-agentic-ai-systems-in-2026-9df63b37f6df)).
- **In-repo (IN-REPO).** Native tool-calling loop (`CHAT_TOOL_EXEC=1`, `lib/tool-runner`);
  autowork self-coding (worktree-isolated, surfaces in chat); shell-free command exec
  (`lib/safe-exec.js`); the council exec-verify (real Python run).
- **OURS (Verify).** "Actions compound error over long trajectories" is the Certificate's
  divergence/commitment result at the agent scale; §3.1's **grounding cadence** (re-ground on a
  schedule, don't wait for the drift alarm — it is provably late) is the direct prescription. The
  self-triggered-control framing (Heemels–Tabuada) applies. **[confidence: Medium — the schedule
  is proven on synthetic maps + one reservoir, not on an agent trajectory · source: cert §3.1]**
- **GAP.** No trained tool-use / agentic-RL of our own; agency rides on rented base models.

## VERIFY — grounding, collapse detection, honesty  ·  **the Certificate's home**

*The stage we actually own. External reality is the only thing that stops the loop degenerating —
proven (in-regime) and measured across this document's sibling work.*

- **Best practice (ESTABLISHED).** **RL with verifiable rewards (RLVR/GRPO)** — reward from real
  execution, no learnable reward model to hack ([post-training 2026](https://llm-stats.com/blog/research/post-training-techniques-2026)).
  **Model-collapse literature** — recursive training on unverified synthetic data degrades;
  verification prevents it (Shumailov *Nature* 2024; Feng et al. 2024). **Hallucination/eval** —
  contamination-free, date-annotated held-outs (LiveCodeBench), calibration/confabulation
  measurement.
- **OURS (the genuine contribution — but disciplined, not novel).** The
  [Collapse Certificate](SIGMA0-COLLAPSE-CERTIFICATE.md): a machine-checked (in-regime) formalization
  that an ungrounded self-referential loop collapses or diverges (Thm 1 / C3), the discrete
  acceptance gate (`ρ<1`), the critical-slowing-down + Kalman-NIS canary, the honesty/calibration
  harness, and the [Grounding Ledger](SIGMA0-GROUNDING-LEDGER.md) — grounding has a **price**
  (only fresh truth selects), a **schedule** (§3.1 cadence), and a **budget** (§8.4). *Honest
  scope*: every mechanism is adopted from a standard field (Lyapunov, contraction analysis,
  self-triggered control, RLS forgetting, Thresholdout, simulated annealing) — see the cert's
  gap→conventional-grounding map. The contribution is **disciplined in-repo formalization + honest
  measurement**, not new theory.
- **IN-REPO.** `src/cio_sde/` (Thm 1, Σ₀, Σ₀⁻¹, JSRR gate); `experiments/sigma0_*`; the honesty
  golden set + council; 8 test suites / 91 passing.
- **GAP.** The Verify machinery is validated in **simulation / one model / synthetic** — *no real
  training run has exercised it yet* (the E-B run, [#2691], is the pending real-model validation).

## CONVERGE — how the system gets better over time

*The meta-loop: turn verified experience into a better system. This is where post-training,
continual learning, and the Certificate's slow-weights gate (Σ_θ) live.*

- **Best practice (ESTABLISHED).** Modular post-training: **SFT → preference-opt (DPO/SimPO/KTO)
  → verifiable-reward RL (GRPO/DAPO)** — DPO is the de-facto alignment default, RLVR the reasoning
  lever; **data quality dominates algorithm choice**
  ([post-training 2026](https://llm-stats.com/blog/research/post-training-techniques-2026);
  [interconnects recipe](https://www.interconnects.ai/p/frontier-model-post-training)). Continual
  updates risk forgetting; **RL forgets less than SFT** (KL-from-base). **Scaling laws** set the
  compute/data budget (Chinchilla ~20 tokens/param).
- **In-repo (IN-REPO).** The **Σ_θ acceptance gate** (7-condition release gate + A/B/C tree,
  `experiments/sigma_theta_abc/`) — *when* a weight update may replace the incumbent; the E-B
  three-arm promotion protocol; QLoRA distillation + arm-C GRPO verified on Lightning L4 (#2231);
  distillation-to-ternary serving artifact (ADR-0026). "Persistent learning, not weight
  modification" is the project rule — improve via memory + retrieval first, retrain gated.
- **OURS (Verify-adjacent).** Σ_θ is the *Verify discipline applied to the slow weights*: it does
  not train the model, it **gates** the update against a fresh external anchor (the freshness law:
  internal signals detect, fresh randomness de-ratchets, only fresh truth informs). Honest: it is
  TRPO + Gao + Dwork + simulated-annealing imported, not a new gate.
- **GAP.** We run **no frontier post-training** — no large SFT/DPO, no from-scratch RLVR training
  loop, no MoE pretraining. Converge, for us, is currently *distill a rented model + gate the
  update*, not *train a frontier model*. Sourced against the full recipe above.

---

## Cross-cutting layers (present at every stage; mostly gaps for us)

| Layer | Best practice (ESTABLISHED, 2026) | Ours | Source |
|---|---|---|---|
| **Optimizer** | **Muon** replacing AdamW (~2× compute-efficient; DeepSeek V4-Pro adopts it) | GAP — we use stock AdamW in QLoRA | [Muon arXiv:2502.16982](https://arxiv.org/abs/2502.16982) |
| **Data quality** | the binding constraint; rephrasing + human anchor + verifiable synthetic | GAP — no pipeline; the E-B prep is a first eval/SFT-data step | [Toloka](https://toloka.ai/blog/how-frontier-labs-build-pre-training-datasets/) |
| **Systems** | FP8, MoE expert-parallel, distributed schedulers | GAP — single-L4 QLoRA only; 8GB local serves, cloud trains | [MoE inference](https://www.spheron.network/blog/moe-inference-optimization-gpu-cloud/) |
| **Scaling laws** | compute-optimal ~20 tok/param; predictive mixture laws | GAP — we operate below the scaling regime | [scaling analysis](https://aimultiple.com/llm-scaling-laws) |
| **Serving** | quant (post-hoc INT4/ternary), speculative decoding, KV-cache | IN-REPO — Ouro serve + ternary distill (ADR-0026); [[posthoc-quantization-cliff-measured]] | — |

---

## Reverse-engineering the frontier — the inverse-problem method (the black-hole telescope)

*Status: FRAMING (the method is ESTABLISHED science; its application here is ours). Added
2026-07-18 with the operator's synthesis.*

The frontier recipe — the unpublished data mixture, RL and systems tricks — is an
**ill-posed inverse problem**: we cannot observe it directly, and infinitely many recipes
are consistent with what we can observe. That is *exactly* the problem the Event Horizon
Telescope solves to image a black hole: interferometry data admits infinitely many images,
and **Regularized Maximum Likelihood** selects "a conservative image from an infinite number
of possible images" — fitting the data while regularizing hard enough to never hallucinate
structure the data doesn't support
([EHT sparse modeling](https://iopscience.iop.org/article/10.3847/1538-4357/aa6305/epub);
[M87 imaging](https://iopscience.iop.org/article/10.3847/2041-8213/ab0e85/pdf)).

The mapping, term by term:

| EHT imaging | Frontier reconstruction (this project) |
|---|---|
| sparse visibility data | the frontier model's observable input→output behavior |
| RML forward-modeling | **distillation** — recover the map from the black box's shadow |
| imaging the interior from indirect measurement | **probing** — e.g. the linear honesty probe reading truth off hidden states |
| the regularizer (entropy/sparsity priors) | **grounding (the Certificate)** — fit the observable capability, regularize to the established corpus, refuse to hallucinate the secret sauce |
| the conservative-image discipline | the evidence-class discipline — the same one that refused a fake "novel mechanism" every time this session tested one |

Reconstruction has a hard ceiling stated plainly: **an inverse problem cannot add structure
the data doesn't contain.** Distilling the frontier reaches it asymptotically; it does not
surpass it. To *exceed* the reconstruction you need an instrument the original doesn't have —
**fresh verified ground truth on domains the frontier has no cheap labels for**: resolved
market P&L, execution-verified code outcomes, real user corrections. That is the telescope
they do not own, and the freshness law (only fresh truth selects) is why it is the only thing
that can pull the student past the teacher — locally, on the surfaces that matter.

### How we make AGI — the disciplined synthesis (operator-approved, 2026-07-18)

We do not make AGI by training a frontier-scale model from scratch; that path is closed by
capital, data, and unpublished tacit knowledge. The open path is the one this document maps:
**rent** the six load-bearing capabilities the frontier ships; **own** the one it is missing
and names as its top failure (long-horizon grounding / anti-collapse); **distill** to a
small, local, verifiable serving artifact; **close the loop** with fresh domain verification
surfaces the frontier cannot cheaply replicate; and use the inverse-problem method above to
reconstruct what they hide — then exceed it locally where our telescope sees truth theirs
cannot. The Certificate's rule is unchanged and non-negotiable: no claimed edge, capability,
or novelty counts until it survives fresh, out-of-sample verification on the actual surface.
That is the plus-ultra that is actually beyond what they ship, *because it is grounded*.

## The honest AGI-scope assessment

**Could this become the best model possible?** Not from what we own. Six of the seven load-bearing
capabilities (data, architecture, optimizer, scaling, pretraining, frontier post-training, systems)
are **gaps we would fill with the outside research above**, not with anything in-repo. That is not a
failure — it matches the 2026 consensus that the frontier is *execution + data*, and those are
capital/compute problems more than idea problems.

**What is genuinely ours, and where it matters:** the **Verify** discipline (the Collapse Certificate
+ Grounding Ledger + Σ_θ gate), and its extension into **Converge** as the update gate. The bet that
pays off is *not* "we invented a better reasoner" — it is **"we are the only stack that treats
grounding/anti-collapse as a first-class, measured discipline across the whole loop,"** at exactly
the moment the agentic frontier is naming un-grounded long-horizon collapse as its top unsolved
failure. The architecture we already serve (Ouro LoopLM) is on the winning test-time-compute curve,
and our Verify work is the stability layer that curve needs.

**The strategy the loop implies:**
1. **Rent the six gap capabilities** — base models, their pretraining, their architecture — via the
   provider chain and distillation. Do not try to out-pretrain frontier labs.
2. **Own Verify + Converge-gating** — grounding cadence (Observe/Act), freshness-priced selection
   (Converge), collapse detection (Reason), honesty measurement (Verify). This is the differentiated
   product surface (the AI cockpit that *knows when it doesn't know*).
3. **Distill, don't train from scratch** — the ternary ≤8GB serving artifact (ADR-0026) + the
   verify-gated update loop is the realistic path to an *owned* small model that inherits frontier
   capability and adds the grounding discipline.
4. **Close the one real-model gap** — run E-B ([#2691]) so the Verify claims graduate from
   simulation to MEASURED-on-a-real-model. Until then, our edge is argued, not proven.

**The trap (stated so it can't be laundered):** treating a rigorous Verify layer as an AGI recipe.
It is the seatbelt and the dashboard warning light — indispensable, and worthless without the engine,
which we rent. The whole-loop win is *rented capability + owned grounding*, delivered as one
convergent product, not a home-grown frontier model.

---

## Evidence discipline (inherited, non-negotiable)

Every claim above carries a class (`ESTABLISHED`/`IN-REPO`/`OURS`/`GAP`) and a source. `OURS` is
used sparingly and only for the Verify discipline, which is itself formalization-of-standard-methods
(no novel mechanism — see the Certificate's 2026-07-18 gap→conventional-grounding map). External
citations are venue- or arXiv-verifiable; the project's history of four fabricated arXiv IDs is why
no ID here is cited unread. If a stage's "IN-REPO" pointer does not resolve, the blueprint has
drifted and that row should be demoted to GAP until reconciled.
