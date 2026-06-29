# Keystone Chat — Frontier Dev Stack (Research + Design)

**Status:** Proposed (for Alex's review — not an accepted ADR)
**Date:** 2026-06-28
**Author:** Claude (engineer) for Alex (stakeholder)

**Decisions locked with Alex (2026-06-28):**
- **Capability-gated, local-first-when-able.** Use a **frontier local model when the box can run it**, otherwise **fall back to Claude (cloud)**. One harness; the model is auto-selected by detected hardware.
- **Local frontier model = Qwen 3.6-27B** (the "24 GB model"). Alex will **buy or rent a 24 GB GPU** for his own box; consumers on ≤ 8 GB get the cloud-fallback profile automatically.
- **Claude is the cloud brain / escalation ceiling.** Models stay interchangeable (North Star), but Claude leads cloud "as of now."
- Recurrent-depth (Ouro) = research front only (SOTA designs).

---

## 0. TL;DR

**One harness, two model profiles, selected automatically.** The frontier of consumer dev is the *harness*, not the weights — every frontier tool (Claude Code, Cursor, Windsurf, Devin, Cline) is a harness over a cloud (or BYO) model, and the 2026 literature shows **up to 10× on coding benchmarks from harness/edit-format changes alone, no model change** ([Survey](https://openreview.net/pdf?id=eONq7FdiHa)). That is the Σ₀ "the loop is everything" bet.

Keystone runs the same harness everywhere and lets the **VRAM gate + serving-liveness probe (both already in [`local-model-registry.js`](apps/lantern-garage/lib/local-model-registry.js))** pick the model:

| Detected box | Local model leads? | Agentic brain | Claude's role |
|---|---|---|---|
| **≥ 24 GB GPU** (Alex's box, rented GPU) | **Yes — Qwen 3.6-27B** | Local frontier | **Verify-failure escalation** (Opus 4.8) |
| **≤ 8 GB GPU** (typical consumer) | No (support only) | **Claude Sonnet 4.6** | **Workhorse** |
| **No GPU / offline** | — | Claude (or local offline fallback) | Everything |

Same code path, same `KEYSTONE_LOCAL_FIRST` verify-gated escalation — only the *threshold* where local stops leading changes with hardware. No new serving path, no new memory system.

---

## 1. What "frontier consumer dev" means in mid-2026

| Tool | Model | Frontier ingredient (all harness) |
|---|---|---|
| **Claude Code** | cloud | Orchestrator–worker **sub-agents** (isolated context), 5-tier **compaction**, permission tiers, MCP/skills/hooks ([arXiv 2604.14228](https://arxiv.org/html/2604.14228v1)) |
| **Cursor / Windsurf** | cloud | Deep **codebase index** + flow-aware retrieval |
| **Devin** | cloud | Long-horizon **planning** + sandbox + self-verification |
| **Aider / Cline** | cloud (BYO-key) | **Repo-map** + **search-replace** edits + step approval |
| **Goose** | BYO model | Model-agnostic, on-machine, local-first — closest sibling to Keystone |

The named discipline — *harness engineering* — has fixed components: tool/execution substrate, **state persist + compaction**, permission tiers, feedback routing, **state-transition verification** ([Survey](https://openreview.net/pdf?id=eONq7FdiHa)); context engineering = **compaction + progressive disclosure + just-in-time retrieval**. All map 1:1 onto the loop, so chasing the frontier is *extension, not sprawl*:

| Σ₀ stage | Harness component |
|---|---|
| Observe / Remember | Codebase index, repo-map, JIT retrieval, compaction |
| Reason | Planner + sub-agent delegation (isolated context) |
| Act | Uniform multi-turn tool loop, search-replace edits, sandbox |
| Verify | Test-driven gate, diff-apply re-verify, state-transition checks |
| Converge | Convergence records, escalation + distillation flywheel |

---

## 2. Model strategy — capability-gated ladder

Models stay interchangeable; this is a routing policy over the existing provider abstraction + VRAM gate.

### Tier L-Frontier — Local 24 GB (leads when present)

| Model | Params | Ctx | SWE-bench Verified | VRAM (Q4) | Tool-calling |
|---|---|---|---|---|---|
| **Qwen 3.6-27B (dense)** ⭐ | 27B | 262K | **77.2%** | ~17 GB | Native (`qwen3_coder`) |
| Qwen 3.6-35B-A3B (MoE) | 35B/3B | 262K | 73.4% | ~22 GB | Native; 101.7 tok/s on 3090 |
| Qwen3-Coder-Next (step-up) | 80B/3B | 256K–1M | 71.3% (SWE-rebench Pass@5 **64.6%, #1**) | ~35–40 GB (48 GB box) | Native |

Source: [kilo.ai](https://kilo.ai/open-source-models), [InsiderLLM](https://insiderllm.com/guides/best-local-coding-models-2026/). **Pick: Qwen 3.6-27B** — dense beats the MoE on raw agentic quality (77.2 vs 73.4), and it *matches Claude 4.5 Opus on Terminal-Bench 2.0 (59.3)*. When it verifies a task locally, you pay zero cloud tokens.

> **GPU note (Alex's box):** ~17 GB Q4 fits a single 24 GB card — used **RTX 3090 ≈ $700–900**, or **rent** (RunPod/Vast.ai/Lambda, a 24 GB instance runs this comfortably; llama.cpp + speculative decoding measured **2.56×** on this exact model/GPU).

### Tier C — Cloud brain / ceiling (Claude)

| Role | Model | When |
|---|---|---|
| Workhorse (8 GB profile) | **Claude Sonnet 4.6** | Default agentic brain when no local frontier model |
| Ceiling (all profiles) | **Claude Opus 4.8** | Verify-failure escalation / hardest multi-file tasks. SWE-bench Pro active leader **69.2%** ([morphllm](https://www.morphllm.com/swe-bench-pro)) |

Open-weight cloud backups (GLM-5.2, DeepSeek V4-Pro, Kimi K2.6) remain valid drop-ins, but **Claude leads now** per Alex.

### Tier 0 — Local 8 GB support layer (always, even on the 24 GB box)

On 8 GB you load **one** model at a time; on the 24 GB box this work co-exists with headroom. Cheap/frequent/private jobs that never need the frontier:

| Role | Model | VRAM | Loop stage |
|---|---|---|---|
| Resident coder | **Qwen2.5-Coder-7B** (Q4) | ~5 GB | FIM/autocomplete (Act), cheap edits, intent routing (Reason) |
| Index embeddings | nomic-embed-text / bge-small | <0.5 GB | Codebase index — **code never leaves the machine** (Remember + privacy) |

Every turn Tier 0 absorbs is a Claude token unpaid — a **margin lever** for a subscription/BYO-key product.

### Why local can't *always* be the brain (honest)

A 7–9B model at 8 GB tops out near HumanEval single-file work; its agentic SWE-bench is far below the bar — hence the gate. The 27B frontier model clears the bar but needs 24 GB. The gate is exactly the line between "local leads" and "Claude leads."

### Recurrent-depth (Ouro) — research-front

Ouro-1.4B is today's hardcoded Σ₀-native default (`toolCalling:false`). Genuine research front, but a 1.4B no-tools model can't anchor a tool-driven cockpit. **Keep as a research registry entry; the default local lead becomes capability-gated (Qwen 3.6-27B ≥24 GB, else Qwen2.5-Coder-7B support).**

---

## 3. Tech stack

| Layer | Choice | Status |
|---|---|---|
| Local serving | **Ollama** (dev) → **llama.cpp + spec-decode** / **vLLM FP8** (24 GB prod) | Ollama wired |
| VRAM detection | `nvidia-smi`/torch → sets the gate budget (override `VRAM_BUDGET_GB`) | **Build** (today hardcoded 8) |
| Cloud transport | Existing provider router + PCSF → Anthropic first | Have it |
| Tool-call format | Native Claude tool_use; `qwen3_coder` parser (local) | Partial |
| Edit format | **Search-replace blocks** (the 10× format) | **Build** |
| Index | Local embeddings + ranked repo-map | **Build** |
| Sandbox | Git worktrees | Have it |

### 3.1 The capability gate (the one new routing rule)

```
detect VRAM → selectAvailableChain(taskType)              # existing, VRAM-gated + liveness
  if best served local model.capabilityScore ≥ FRONTIER_THRESHOLD:
       local leads coding/reasoning  →  verify  →  on fail, escalate to Claude Opus   # KEYSTONE_LOCAL_FIRST
  else:
       local does Tier-0 support     →  Claude Sonnet leads agentic  →  Opus on hard
```

This is `selectChain` + `capabilityFirst` + the existing `KEYSTONE_LOCAL_FIRST` escalation, with **(a)** auto-detected VRAM instead of a hardcoded 8, and **(b)** the Qwen 3.6-27B entry registered with a frontier-tier `capabilityScore`.

---

## 4. The harness — the actual product (5 gaps vs Claude Code)

| # | Build | Stage | Touches | GPU-independent? |
|---|---|---|---|---|
| 1 | **Uniform multi-turn agent loop** | Act | `tool-runner.js`, `tool-turns.js`, `stream-chat.js` | ✅ testable today vs Claude |
| 2 | **Codebase index / repo-map** (local embeddings) | Remember | `rag-house.js` (+ index lib) | ✅ |
| 3 | **Search-replace edit + re-verify loop** | Act/Verify | autowork + `keystone-escalation.js` | ✅ |
| 4 | **5-tier context compaction** | Remember | `assembleSessionContext()` | ✅ |
| 5 | **Isolated sub-agents** | Reason | `convergence-agent.js` | ✅ |

**Already at parity (keep):** verify-gated escalation (`KEYSTONE_LOCAL_FIRST`), permission tiers (`command-allowlist.js` + `safe-exec.js`), worktree isolation, PCSF routing, CSF memory, convergence records, web grounding.

The whole harness is **GPU-independent and verifiable today** against cloud Claude — the local frontier model just slots into the same loop when the GPU lands.

---

## 5. Roadmap

| Phase | Scope | Needs GPU? | Outcome |
|---|---|---|---|
| **0a** | VRAM auto-detect + register Qwen 3.6-27B (frontier `capabilityScore`); demote Ouro to research entry | scaffolds now, **inert until 24 GB box** | Capability gate ready |
| **0b** | Confirm exact Ollama/vLLM model tag; serve Qwen 3.6-27B; dogfood | **yes** (buy/rent) | Local frontier live |
| **1** | Uniform multi-turn agent loop + search-replace edits | no | The visible "feels like Claude Code" leap |
| **2** | Local codebase index / repo-map | no | Context quality + ownership story |
| **3** | 5-tier compaction | no | Long sessions + token margin |
| **4** | Isolated sub-agents | no | Devin-class capstone |

**Recommended order:** **Phase 1 now** (highest leverage, fully testable against Claude today, no waiting on hardware) + **Phase 0a scaffolding** in parallel (safe/inert on 8 GB). Then 0b the moment the GPU arrives, then 2→4.

---

## 6. Open items for Alex

1. **Cloud cost model:** product fronts it (subscription, cf. Patreon tiers) or **BYO-key**? Sets how hard Tier 0 works.
2. **GPU:** buy (used RTX 3090 ~$700–900 / 4090 / 5090) or rent (RunPod/Vast/Lambda) — either works; the registry auto-detects.
3. **Build scope:** confirm **Phase 1 now + 0a scaffold** (recommended), or different order?

---

## Sources

- [SWE-bench Pro Leaderboard (Opus 4.8 leads, 69.2%)](https://www.morphllm.com/swe-bench-pro)
- [Best Local Coding Models by VRAM Tier 2026 — InsiderLLM](https://insiderllm.com/guides/best-local-coding-models-2026/)
- [Best Open-Weight Coding Models 2026 — kilo.ai](https://kilo.ai/open-source-models)
- [Agent Harness Engineering: A Survey (10× from harness alone)](https://openreview.net/pdf?id=eONq7FdiHa)
- [Dive into Claude Code — arXiv 2604.14228](https://arxiv.org/html/2604.14228v1)
- [Inside Claude Code's architecture — callsphere](https://callsphere.ai/blog/inside-claude-code-s-architecture-how-the-agent-loop-works)
