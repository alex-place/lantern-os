# Living Research Canon — Lantern OS Convergence 12

Curated references organized by component. Not a bookmark dump. Living document updated as implementation proceeds.

---

## [01] LANTERN-KERNEL — Core Orchestration Loop

### Academic Foundation
- **Dive into Claude Code: The Design Space of Today's and Future AI Agent Systems** (arXiv:2604.14228)
  - Establishes the design space for agentic systems; informs Kernel architecture
  - Key insight: agents need deliberation loops, not monolithic models
  - Relevant: six-stage loop design, state machine pattern

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
  - The dust-sparsity in `quantum_dust.py` is the storage twin of BitNet's zero-sparsity
  - Status: external grounding for [`TESSERACT-CSF-SINGULARITY.md`](TESSERACT-CSF-SINGULARITY.md)
- **Sparse-BitNet** ([arXiv:2603.05168](https://arxiv.org/pdf/2603.05168)) · **T-SAR** ([arXiv:2511.13676](https://arxiv.org/pdf/2511.13676))
  - 1.58-bit models are naturally sparsity-friendly; CPU-only ternary inference
- **Radix economy** ([Wikipedia](https://en.wikipedia.org/wiki/Radix_economy) · [Quanta](https://www.quantamagazine.org/how-base-3-computing-beats-binary-20240809/))
  - Base 3 is the most economical integer radix (optimum `e`); the principled reason the lattice is ternary
- **Hyperdimensional computing / VSA** ([arXiv:2111.06077](https://arxiv.org/abs/2111.06077))
  - Ternary `{-1,0,1}` sparse high-dimensional codes; reference for the 12-axis vector-symbolic substrate

**Status:** Append-only JSONL working; Graph layer needed; ternary lattice substrate implemented (`src/csf/v07/`)

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
- Lattice consolidation: [`TESSERACT-CSF-SINGULARITY.md`](TESSERACT-CSF-SINGULARITY.md) · [`research/2026-06-19-convergence-tesseract-spiral.md`](research/2026-06-19-convergence-tesseract-spiral.md)

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

**Last Updated:** 2026-06-19 (3¹² lattice substrate + convergence-dynamics anchors — Comet Leap P2)  
**Maintained By:** Lantern OS team  
**Immutability:** Read-only; update via PR + issue comment only
