# Living Research Canon — Lantern OS Convergence 12

Curated references organized by component. Not a bookmark dump. Living document updated as implementation proceeds.

---

## [01] LANTERN-KERNEL — Core Orchestration Loop

### Academic Foundation
- **Dive into Claude Code: The Design Space of Today's and Future AI Agent Systems** (arXiv:2604.14228)
  - Establishes the design space for agentic systems; informs Kernel architecture
  - Key insight: agents need deliberation loops, not monolithic models
  - Relevant: six-stage loop design, state machine pattern
- **The Overfitted Brain: Dreams evolved to assist generalization** (Hoel 2020, [arXiv:2007.09560](https://arxiv.org/abs/2007.09560))
  - Dreams = noise injection (dropout + domain randomization) to combat overfitting → generalization
  - Grounds the North Star rule: *no separate dream engine; dreaming = high-exploration reasoning + mandatory verification*
  - The biological twin of Σ₀⁻¹ excitation; overfitting = the σ=0 / 42-state collapse — see [research note](research/2026-06-21-overfitted-brain-dreams-generalization.md)

### Implementation References
- **AIOS: A Generalist Agent Operating System** 
  - Reference architecture for agent kernel
  - Task scheduling, resource management
  - State machine patterns

### Applied Theory
- **Σ₀ Collapse Certificate** (Lantern-native)
  - Self-improving system detection
  - Prevents feedback collapse
  - Verification loop grounding

**Status:** Core research complete; implementation roadmap ready

---

## [02] LANTERN-MODEL-BROKER — Interchangeable Local Models

### Implementations
- **Ollama** (https://ollama.com)
  - Local model runner; primary implementation
  - Supports 50+ models, easy switching
  - Integration: stable, production-ready

- **llama.cpp** (https://github.com/ggml-org/llama.cpp)
  - Direct model inference; lightweight
  - When Ollama is too heavy (mobile/edge)
  - C++ backend for speed

- **vLLM** (https://github.com/vllm-project/vllm)
  - High-throughput serving
  - Future: when batch inference needed
  - Advanced caching (KV cache)

### Theory
- **Memory for Autonomous LLM Agents** (arXiv:2603.07670)
  - Model independence requirement
  - Memory systems that work with any LLM
  - Informs Broker design

**Status:** Framework exists (needs formalization as Lantern component)

---

## [03] LANTERN-MEMORY — Persistent Accumulated Learning

### Academic Foundation
- **Codebase-Memory: A Living Knowledge Graph for Code Understanding** (arXiv:2603.27277)
  - Knowledge graphs as memory substrate
  - Persistent, queryable, updateable
  - Directly applicable to code understanding
- **In-Context Learning can Perform Continual Learning Like Humans** ([arXiv:2509.22764](https://arxiv.org/abs/2509.22764))
  - In-context continual learning (ICCL): retain + accumulate across sequential tasks with **zero parameter updates**, purely via context-window scheduling — and it *outperforms* gradient-based CL (SGD, Experience Replay, EWC) on the benchmarks
  - Published grounding for the North Star *"persistent learning, NOT weight modification — improve via retrieval/reasoning, not retraining"* (this section's "Never retrain. Accumulate.")
  - Actionable: the **spacing effect** (distributed/interleaved exposure > massed, with an inter-task "sweet spot") → space repeated memory re-surfacing in the Convergence Core rather than dumping it at once; linear-attention models (Mamba, RWKV-7) show the most human-like retention (ACT-R / HRS-MD)

### Implementation References
- **Mem0: The Memory Layer for Large Language Models** (https://mem0.ai)
  - Structured memory for agents
  - Persistence patterns
  - Confidence scoring

### Applied Theory
- **GraphRAG: Knowledge Graph-based Retrieval-Augmented Generation** (https://github.com/microsoft/graphrag)
  - Graph-based memory organization
  - Hierarchical relationships
  - Future: as graph backend

### Lantern-Native
- **CADD: Context Archive for Dream Data** (docs/caad/README.md)
  - Existing CSF archive format
  - Binary compression + versioning
  - Replace bookmark usage with CADD

### Lattice substrate — ternary storage (the 3¹² singularity, storage face)
- **BitNet b1.58 — *The Era of 1-bit LLMs*** ([arXiv:2402.17764](https://arxiv.org/abs/2402.17764))
  - Ternary weights `{-1,0,+1}`, ~66% zeros, matmul→add; grounds CSF's qutrit engine
  - X3 (2026-06-19) **refined**: dust value-sparsity is population-dependent — a *substrate*
    resemblance to BitNet's learned zero-sparsity, **not the same mechanism** (the 0.66 match
    is a population coincidence; see the singularity doc §6.1 and the IP register §3.1)
  - Status: external grounding for [`TESSERACT-CSF-SINGULARITY.md`](TESSERACT-CSF-SINGULARITY.md)
- **Sparse-BitNet** ([arXiv:2603.05168](https://arxiv.org/pdf/2603.05168)) · **T-SAR** ([arXiv:2511.13676](https://arxiv.org/pdf/2511.13676))
  - 1.58-bit models are naturally sparsity-friendly; CPU-only ternary inference
- **Radix economy** ([Wikipedia](https://en.wikipedia.org/wiki/Radix_economy) · [Quanta](https://www.quantamagazine.org/how-base-3-computing-beats-binary-20240809/))
  - Base 3 is the most economical integer radix (optimum `e`); the principled reason the lattice is ternary
- **Where ternary actually pays — hardware/serving, never entropy** (2026-07-21)
  - GDDR7 ships **PAM-3** signaling: `{-1,0,+1}` levels, ~1.5 bits/cycle, +50% data per cycle vs NRZ ([Micron](https://www.micron.com/about/blog/memory/dram/unveiling-the-next-generation-of-graphics-memory-gddr7) · [Rambus](https://www.rambus.com/blogs/all-you-need-to-know-about-gddr7/))
  - Trit-in-bit packing is a solved 99.06% craft: 5 trits/byte, llama.cpp **TQ1_0 = 1.6875 bpw** / TQ2_0 = 2.0625 bpw for BitNet/TriLM weights ([PR #8151](https://github.com/ggml-org/llama.cpp/pull/8151) · [Compilade](https://compilade.net/blog/ternary-packing) · [bitnet.cpp, arXiv:2502.11880](https://arxiv.org/pdf/2502.11880)) — the packing question for the ADR-0026 serving artifact
  - Base-3 confers **no** codec advantage (Shannon is radix-invariant) — kill-doc verdict stands; application map: [`research/2026-07-21-tesseract-application-map.md`](research/2026-07-21-tesseract-application-map.md) §5
- **Hyperdimensional computing / VSA** ([arXiv:2111.06077](https://arxiv.org/abs/2111.06077))
  - Ternary `{-1,0,1}` sparse high-dimensional codes; reference for the 12-axis vector-symbolic substrate

### Compression — beating zstd-19 (memory encoding)
- **Language Modeling Is Compression** (DeepMind, [arXiv:2309.10668](https://arxiv.org/abs/2309.10668))
  - A predictor is a compressor: `p(next|ctx)` → arithmetic coding; a 3.2M transformer beats LZMA2 (17.7% vs 23%)
  - Grounds GRC / corrected E1 (issue #1595)
- **OpenZL** (Meta, 2025) · **DataCortex** — structure-aware reversible transforms beat zstd on ratio+speed for structured data (2–3× on NDJSON)
  - Grounds CSF-Col (issue #1593): known-schema row→column + typed coding
- **Revisiting Data Compression with LM** ([arXiv:2601.02875](https://arxiv.org/html/2601.02875v1))
  - Weight-accounting wall: LLM compression only pays past ~100GB — *dissolved here* by the resident-model amortization
- **Σ₀ collapse certificate** ([`SIGMA0-COLLAPSE-CERTIFICATE.md`](SIGMA0-COLLAPSE-CERTIFICATE.md))
  - Load-bearing constraint on GRC: ungrounded recurrent depth *raises* predictive entropy (collapse → uniform); the NIS/anisotropy canary is the measured depth-exit
- Full theorization + closed doors (low-rank, Kolmogorov, geometry, PAQ): [`research/2026-06-29-csf-beating-zstd.md`](research/2026-06-29-csf-beating-zstd.md)

**Status:** Append-only JSONL working; zstd-19+LDM / omni ships; CSF-Col (#1593) recommended next; Graph layer needed; ternary lattice substrate implemented (`src/csf/v07/`)

---

## [04] LANTERN-GRAPH — Knowledge Relationships

### Academic Foundation
- **GraphRAG: A Data API for Large Language Models** 
  - Extracting and organizing knowledge graphs
  - Querying relationships at scale
  - Hierarchical reasoning

### Implementation References
- **GraphRAG GitHub** (https://github.com/microsoft/graphrag)
  - Primary implementation
  - Relationship extraction
  - Multi-level summarization

- **Neo4j** (https://neo4j.com)
  - Optional: when graph scale demands it
  - Mature graph database
  - ACID guarantees

### Integration Path
1. **Phase 1:** GraphRAG + local embeddings
2. **Phase 2:** Optional Neo4j for scale
3. **Phase 3:** Auto-relationship detection (codebase → architecture → patterns)

**Status:** Roadmap; not yet implemented

---

## [05] LANTERN-TOOLS — Unified Execution Layer

### Standard
- **Model Context Protocol (MCP)** (https://modelcontextprotocol.io)
  - Formal specification for tool/model interaction
  - Growing ecosystem (GitHub, Anthropic, others)
  - Primary integration target

### Reference Implementations
- **Anthropic MCP GitHub** (https://github.com/modelcontextprotocol)
  - Official implementations
  - Example servers: file, git, web
  - Integration patterns

### Theory
- **Lazy Tool Integration Patterns**
  - Tools as composable modules
  - Consistent {success, output, confidence} return
  - No hardcoded tool chains

**Status:** MCP adoption in progress; needs formalization as Lantern component

---

## [06] LANTERN-CODER — Coding Specialization

### Academic Foundation
- **Dive into Claude Code** (arXiv:2604.14228)
  - Agentic coding design space
  - Tool use patterns
  - Verification integration

### Reference Implementations
- **Aider** (https://aider.chat)
  - Practical coding agent design
  - Git integration
  - Test feedback loop

- **OpenHands** (https://github.com/All-Hands-AI/OpenHands)
  - Full-stack coding agent
  - Tool composition patterns
  - Sandbox execution

- **Goose** (https://github.com/block/goose)
  - Lightweight coding agent
  - Focus on local development
  - Model-agnostic

- **Cline** (https://github.com/cline/cline)
  - Claude integration patterns
  - Real-world codebase navigation
  - Tool sequencing

- **Plandex** (https://plandex.ai)
  - Planning-first approach
  - Iterative refinement
  - State management

### Implementation Strategy
Coder = specialization of Kernel using Memory + Tools + verify loop.
Not a separate system.

**Status:** Design patterns understood; needs formalization as Lantern task

---

## [07] LANTERN-VERIFY — Reality Loop

### Benchmarks
- **SWE-bench: Software Engineering Benchmarks** (https://www.swebench.com)
  - Real GitHub issues as test cases
  - Standardized evaluation
  - Ground-truth validation

- **Terminal-bench: Terminal-Based Software Engineering** (https://terminalbench.ai)
  - Terminal interaction benchmarking
  - End-to-end task completion
  - Practical measurement

### Theory
- **Σ₀ Anti-Collapse Verification Loop** (Lantern-native)
  - Surprise monitor (NIS canary)
  - Collapse proximity detection
  - Re-grounding via verification
- **JEPA world-model as a plausibility signal** (V-JEPA 2, LeWM — see [11] SSL anti-collapse)
  - A latent world model that flags *implausible events* is a learned grounding/verification
    signal; the video-SSL analogue of the surprise canary (predict-then-check in latent space)

### Applied grounding — survivorship & backtest bias (added 2026-07-18)
- **Survivorship-free single-stock momentum** (in-repo measurement) — the Verify discipline run
  on a live market surface: point-in-time S&P 500 membership (fja05680) + delisted-inclusive prices
  put 12-1 momentum at Sharpe **0.60** full-cycle (an inflated upper bound), tying SPY and below the
  champion's 0.66. The "$2M momentum upgrade" was a survivorship mirage caught by fresh truth.
  See `experiments/survivorship_momentum/FINDINGS.md` and [UNISONA-SHARPE-CERTIFICATE.md](UNISONA-SHARPE-CERTIFICATE.md) §E5.
- **Survivorship Bias in Emerging-Market Small-Cap Indices** ([arXiv:2603.19380](https://arxiv.org/abs/2603.19380))
  - Independent confirmation: reconstructs historical NIFTY Smallcap 250 composition, measures
    **+4.94pp/yr** survivor-only overstatement. Same method, different market.
- **Evaluating LLMs in Finance Requires Explicit Bias Consideration** ([arXiv:2602.14233](https://arxiv.org/abs/2602.14233))
  - Taxonomy of look-ahead / survivorship / narrative biases that contaminate financial backtests.
- **Backtest-overfitting canon** — Deflated-Sharpe / luck-vs-skill / IS-WFA-OOS
  ([arXiv:1905.08042](https://arxiv.org/abs/1905.08042), [1906.00573](https://arxiv.org/abs/1906.00573),
  [2603.09219](https://arxiv.org/abs/2603.09219)); full tranche in
  `F:\arxiv-corpus\pdfs\REVIEW-2026-07-18-survivorship-backtest.md`.
- **Data-source reality** — no free price source is survivorship-free; live-priced vendor survey in
  [research/2026-07-18-market-data-vendors-survivorship.md](research/2026-07-18-market-data-vendors-survivorship.md).

### Integration
- Unit tests → memory update
- Integration tests → pattern extraction
- SWE-bench → capability measurement

**Status:** Theory solid; benchmark integration roadmap

---

## [08] LANTERN-DREAM — Exploration Mode

### Theory
- **Reasoning as Exploration + Verification**
  - Low confidence until verified
  - Mandatory validation before memory write
  - Separate workspace (doesn't pollute state)

### Implementation
```python
dream_mode = {
    "exploration": 0.9,         # higher sampling temperature
    "verification": "required", # all outputs must be tested
    "memory_write": "proposal", # never final until verified
    "confidence_cap": 0.3       # high-risk ideas
}
```

**Status:** Existing design; needs formalization as reasoning_params

---

## [09] LANTERN-OBSERVATORY — Repository Understanding

### Implementation References
- **repo-lantern** Patterns
  - Automatic structure understanding
  - Dependency mapping
  - Architecture inference

- **Corbell** Approach
  - Codebase analysis
  - Symbol relationship graphs
  - Coverage mapping

### Integration
- Auto-generate architecture diagrams
- Infer data flow
- Map module relationships
- Find hidden dependencies

**Status:** Patterns understood; needs Lantern-specific implementation

---

## [10] LANTERN-SANDBOX — Safe Isolated Execution

### Reference Implementation
- **SWE-Agent Patterns** (https://github.com/princeton-nlp/swe-agent)
  - Isolated task execution
  - State management
  - Rollback capability

### Core Capabilities
- git worktrees (parallel branches, no collision)
- Snapshot/restore (checkpoint state)
- Experiment isolation (doesn't break main)
- Failure recovery (rollback on error)

**Status:** Worktree support exists; needs formalization as Lantern component

---

## [11] LANTERN-CONVERGENCE — Self-Improvement

### Theory
- **Failure-Driven Learning**
  - Every failure → root cause
  - Root cause → solution → pattern
  - Pattern → memory (permanent knowledge)

### Implementation
```
Failure
    ↓
Root Cause Analysis (Kernel.reason + verify)
    ↓
Solution (Kernel.act)
    ↓
Pattern Extraction (Memory.compile)
    ↓
Memory.append(type=Pattern, confidence=X)
```

### Convergence dynamics — latent motion to a fixed point (the 3¹² singularity, motion face)
- **Geiping et al. — *Scaling up Test-Time Compute with Latent Reasoning: A Recurrent Depth Approach*** ([arXiv:2502.05171](https://arxiv.org/pdf/2502.05171))
  - Iterates a recurrent block to arbitrary depth; reports emergent **orbit trajectories,
    directional drift, per-token convergence rates** — the empirical basis for the spiral
- **STARS — *Stabilizing Recurrent Dynamics …*** ([arXiv:2605.26733](https://arxiv.org/html/2605.26733))
  - Constrains latent states to **asymptotically stable fixed points** via Jacobian Spectral
    Radius Regularisation; closes the spiral paper's open **non-normal-operator** gap
- **SpiralFormer** ([arXiv:2602.11698](https://arxiv.org/pdf/2602.11698)) · **A Survey on Latent Reasoning** ([arXiv:2507.06203](https://arxiv.org/pdf/2507.06203))
- **Ouro LoopLM** ([arXiv:2510.25741](https://arxiv.org/abs/2510.25741)) — weight-tied recurrence + Q-exit; substrate the spiral extends
- **Verdict (2026-06-28, run on the real Ouro-1.4B):** the latent loop does **not** contract in
  its 4 trained steps — convergence-exit never fires and the spiral premise collapses to a
  relabel of Q-exit; the usable adaptive-depth signal is the **trained Q-exit gate**. Closed in
  [`research/2026-06-28-csf-tesseract-novelty-and-e1-kill.md`](research/2026-06-28-csf-tesseract-novelty-and-e1-kill.md)
- Lattice consolidation: [`TESSERACT-CSF-SINGULARITY.md`](TESSERACT-CSF-SINGULARITY.md) · [`research/2026-06-19-convergence-tesseract-spiral.md`](research/2026-06-19-convergence-tesseract-spiral.md)
- Surviving-primitive application map (CSF · Convergence-IO · chat · trade · explore):
  [`research/2026-07-21-tesseract-application-map.md`](research/2026-07-21-tesseract-application-map.md)

### Self-supervised anti-collapse — the representation-learning twin of the collapse certificate
The LeCun/FAIR non-generative-SSL lineage (DrLIM → JEPA → LeJEPA/LeWM) spends two decades
fighting **representation collapse** — the same "frozen self-agreement" fate the [Σ₀ collapse
certificate](SIGMA0-COLLAPSE-CERTIFICATE.md) formalizes for an ungrounded latent loop. The
certificate's tool is **spectral** (bound the recurrent map's Jacobian, §1); this field's mature
answer is **distributional** (condition the embedding covariance). The two are complementary
anti-collapse conditions on the *same* object. Every ID below was web-verified 2026-07-06
(arXiv API + primary sources); **0 corrections** — the list is clean. Relevance is to the loop,
not a mandate to bolt a vision encoder onto the Core (that would be sprawl; the import is the
*regularization idea*).

- **Early SSL (predict-to-represent).** Becker & Hinton, *Self-organizing net … random-dot
  stereograms* ([Nature 355:161, 1992](https://doi.org/10.1038/355161a0)); Becker, *Mutual
  information maximization: models of cortical self-organization*
  ([Network 7(1), 1996](https://doi.org/10.1080/0954898X.1996.11978653)); Schmidhuber,
  *Learning Factorial Codes by Predictability Minimization*
  ([Neural Computation 4(6), 1992](https://doi.org/10.1162/neco.1992.4.6.863)) — agreement /
  mutual-information / predictability objectives; the ancestral form of "represent by predicting."
- **Contrastive (pull-together / push-apart).** DrLIM ([CVPR 2006](https://doi.org/10.1109/CVPR.2006.100));
  FaceNet/triplet ([arXiv:1503.03832](https://arxiv.org/abs/1503.03832)); CPC/InfoNCE
  ([arXiv:1807.03748](https://arxiv.org/abs/1807.03748)) — the contrastive objective avoids
  collapse by construction (negatives), at the cost of needing them.
- **Scaling contrastive.** InstDisc ([arXiv:1805.01978](https://arxiv.org/abs/1805.01978)); MoCo
  ([arXiv:1911.05722](https://arxiv.org/abs/1911.05722)); SimCLR
  ([arXiv:2002.05709](https://arxiv.org/abs/2002.05709)); MoCo v2/v3
  ([2003.04297](https://arxiv.org/abs/2003.04297) / [2104.02057](https://arxiv.org/abs/2104.02057)).
- **Distillation without negatives (collapse-avoidance by asymmetry).** BYOL
  ([arXiv:2006.07733](https://arxiv.org/abs/2006.07733)); SimSiam
  ([arXiv:2011.10566](https://arxiv.org/abs/2011.10566)); DINO / v2 / v3
  ([2104.14294](https://arxiv.org/abs/2104.14294) / [2304.07193](https://arxiv.org/abs/2304.07193)
  / [2508.10104](https://arxiv.org/abs/2508.10104)) — EMA + stop-gradient prevent collapse. The
  cautionary parallel for our **Qwen→Ouro distillation** (ADR-0015): asymmetry is load-bearing.
- **Masked autoencoders.** MAE ([arXiv:2111.06377](https://arxiv.org/abs/2111.06377)); iBOT
  ([arXiv:2111.07832](https://arxiv.org/abs/2111.07832)) — generative reconstruction; the branch
  JEPA deliberately abandons for latent prediction.
- **JEPA (predict in latent space — the world-model line).** Position paper: LeCun, *A Path Towards
  Autonomous Machine Intelligence* ([OpenReview BZ5a1r-kVsf, 2022](https://openreview.net/pdf?id=BZ5a1r-kVsf));
  I-JEPA ([arXiv:2301.08243](https://arxiv.org/abs/2301.08243)); V-JEPA
  ([arXiv:2404.08471](https://arxiv.org/abs/2404.08471)); V-JEPA 2
  ([arXiv:2506.09985](https://arxiv.org/abs/2506.09985)) — latent-predictive world models that
  support planning; **maps onto Observe→Reason**, and V-JEPA 2 / LeWM's *implausible-event
  detection* is a grounding signal for **[07] VERIFY** (see cross-ref).
- **Regularization (the distributional anti-collapse condition — closest to us).** W-MSE
  ([arXiv:2007.06346](https://arxiv.org/abs/2007.06346)); Barlow Twins
  ([arXiv:2103.03230](https://arxiv.org/abs/2103.03230)); VICReg
  ([arXiv:2105.04906](https://arxiv.org/abs/2105.04906)); **SIGReg / LeJEPA** (Balestriero & LeCun,
  [arXiv:2511.08544](https://arxiv.org/abs/2511.08544)) — regularize embeddings toward an
  **isotropic Gaussian**, heuristics-free (no stop-grad / EMA / scheduler), linear cost, one
  hyperparameter. **LeWM** (Maes et al., [arXiv:2603.19312](https://arxiv.org/abs/2603.19312)) —
  first *stable end-to-end* JEPA from pixels, prediction + one Gaussian regularizer, ~15M params,
  plans 48× faster than foundation-model world models. **This is the payload for us:** SIGReg's
  "force the latent distribution to be well-conditioned" is the distributional sibling of the
  certificate's spectral bound — a candidate anti-collapse term for the Ouro latent loop, and a
  falsifiable claim (does a covariance-conditioning regularizer reduce our measured collapse
  proximity?). Watch: *When Does LeJEPA Learn a World Model?* ([arXiv:2605.26379](https://arxiv.org/abs/2605.26379)).

### Key Insight
Never retrain. Accumulate.

**Status:** Philosophy established; implementation roadmap needed

---

## [12] LANTERN-LOCAL — User Sovereignty

### Infrastructure
- **Ollama** (local model runner)
- **Local Vector DB** (embeddings storage, if needed)
- **Local Graph DB** (relationships, if scale demanded)

### Principles
- Offline-first (cloud optional)
- User owns all data
- No vendor lock-in
- Model switching without migration

**Status:** Foundation in place; needs documentation

---

## Cross-Component References

### Multi-Component Papers
- **Claude Code Design Space** (arXiv:2604.14228)
  - Informs: Kernel, Coder, Tools, Verify
  - Establishes agentic design principles

- **Memory for Autonomous Agents** (arXiv:2603.07670)
  - Informs: Memory, Kernel, Coder
  - Establishes memory requirements for model-independent agents

### Long-Term Watch List
- **Coding Beyond Your Training: Claude Code and the Technological Frontier** (arXiv:2605.25438)
  - Emerging frontier in AI-assisted coding
  - Monitor for new patterns

---

## Canon Maintenance Rules

1. **Only add paper/project when it directly informs Convergence 12 components**
2. **Link to specific component (not generic reference)**
3. **Note the implementation status (theory / roadmap / in-progress / done)**
4. **Remove entries when superseded by implementation or better alternative**
5. **This is not a bookmarks list. It is the architecture research trail.**

**Last Updated:** 2026-07-06 (SSL anti-collapse lineage folded into [11] — DrLIM→JEPA→LeJEPA/LeWM, all 27 IDs web-verified, 0 corrections; the distributional twin of the collapse certificate)  
**Maintained By:** Lantern OS team  
**Immutability:** Read-only; update via PR + issue comment only
