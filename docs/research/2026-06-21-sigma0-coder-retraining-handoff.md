---
author: Alex Place (handoff prepared 2026-06-21)
created: 2026-06-21
audience: research team — Σ₀ Ouro coder retraining
status: handoff / actionable
---

# Σ₀ Ouro Coder — Retraining Handoff & Suggestions

**Ask:** the local Σ₀ Ouro-1.4B coder was given function-calling (FC) ability via a QLoRA
adapter this session. It *can* call tools but is unreliable in practice. This handoff
captures exactly what was built, what we observed, the root-cause diagnosis, and a
concrete, evidence-backed retraining recipe to make it reliable. Everything below is
grounded in on-disk artifacts (paths + counts verified) and primary sources (cited).

---

## 1. Context (what exists)

- **Model:** `ByteDance/Ouro-1.4B` — a weight-tied **looped** transformer (recurrent depth, Q-exit). Served via [`scripts/ouro_serve.py`](../../scripts/ouro_serve.py) as a drop-in **Ollama** HTTP API (`ouro:latest` on `:11434`); point `OURO_ADAPTER` at an adapter dir. Default = fast cached path; `OURO_NATIVE=1` = Q-exit deep mode (~1 s/token).
- **Adapters (on disk, outside repo):**
  - `D:/lantern-train/ouro-sigma0-fc-adapters/final` — **the FC adapter trained this session** (tool-calling).
  - `D:/lantern-train/ouro-sigma0-adapters/final` — the prior **coding** adapter (HumanEval pass@1 **0.518**, 85/164 full set — see `data/eval/leaderboard.jsonl`, row `ouro-final-rerun-full`).
- **Training script:** [`scripts/train-qlora-ouro.py`](../../scripts/train-qlora-ouro.py) — QLoRA, 4-bit nf4, transformers `Trainer` (no trl), pinned to transformers 4.57.
- **Serving contract (canonical, refactored this session):** the local model emits a single-line `<tool_call>{"name","input"}</tool_call>`. The proxy ([`apps/lantern-garage/lib/tool-runner.js`](../../apps/lantern-garage/lib/tool-runner.js)) defines **one tool registry** keyed by the canonical Claude-Code names the adapter was trained on — **Read, LS, Glob, Grep, Bash, PowerShell, Write, Edit** — used for *both* the prompt preamble and execution (advertised == emitted == executed). Shell tools route through the shared allowlist ([`lib/command-allowlist.js`](../../apps/lantern-garage/lib/command-allowlist.js)) + [`lib/safe-exec.js`](../../apps/lantern-garage/lib/safe-exec.js), operator-gated. **Retraining MUST target these exact names/schemas.**

## 2. What was done this session

1. **Built a real FC corpus** (replacing the original 250 code-gen pairs) via two new scripts:
   - [`scripts/harvest_tool_traces.py`](../../scripts/harvest_tool_traces.py) — mines tool-use turns from this repo's Claude Code session transcripts → `<tool_call>` training pairs (the *trigger*). Secrets redacted; tool_result bodies never emitted.
   - [`scripts/convert_fc_dataset.py`](../../scripts/convert_fc_dataset.py) — converts public FC datasets into our exact wire format with **train/serve preamble parity** (reuses the proxy's `_render_tools` + `parse_tool_call` to validate: positives must parse as a tool call, negatives must not).
2. **Retrained** the FC adapter: **1 epoch** on a **5,050-row** balanced subset (`training-data-5k.jsonl`, **25% negatives**), `--seq 1536`, completion-only loss, LoRA r16/α32, **lr 2e-4 (script default — not overridden)**, bf16. ~6h41m on the RTX 3070 (~38.5 s/optimizer step).
3. **Evaluated behaviorally** (no BFCL yet): under *auto* tool_choice the new adapter spontaneously emits `tool_use` where the old one was 0/3, and correctly refrains on non-tool prompts — but under-triggers on some real tasks and reaches for `Bash`.
4. **Made dream-chat tool-aware** (renders `<tool_call>` as cards; executes via the registry, operator-gated). This surfaced the in-chat behavior below.

## 3. Observed failure modes (the problem to fix)

| # | Symptom | Evidence |
|---|---|---|
| 1 | **Under-triggers** — answers in prose / refuses instead of calling a tool | auto-mode eval missed "list files"; chat refusals |
| 2 | **Bash over-bias** — reaches for `Bash` even to read a file | chat emitted `Bash` for "read CHANGELOG.MD"; `[tool-aware] name=Bash` repeatedly |
| 3 | **Over-refusal** — memorized refusal templates verbatim | turn-2 replies were the exact 3 refusal strings from the negatives |
| 4 | **Erratic tool args** — empty / messy / non-allowlisted commands | `Bash {}`; `ls … 2>&1 && cd ../` |

## 4. Root-cause diagnosis

- **(2)/(4) Bash bias** is a **data-distribution** artifact, not a prompt issue (confirmed: trimming the system prompt to the bare tool preamble did **not** change it). The repo-trace positives are **Bash-dominated**: Bash 3287 / Read 1665 / Edit 564 / Grep 536 / Write 302 / **Glob 277** — Bash is ~50% of positives, Glob ~4%. The model learns "reach for Bash."
- **(3) Over-refusal** is **template memorization**: the 6,051 irrelevance negatives use only **3 fixed refusal strings**, and at **25% of the 5k subset** the refusal prior is inflated (~2.5× the optimum).
- **(1) Under-trigger** is the flip side of (3) plus **no "positive prose" class** — the model only learned {emit-template-refusal} or {emit-tool}, never {answer normally}, so it lands on refusal/prose when unsure.
- The **format/name contract is now correct** (the registry refactor made names canonical), so this is squarely a **data-composition + light-recipe** problem, not an architecture or harness one.

## 5. Retraining suggestions (prioritized, concrete)

### P0 — Rebalance the corpus (fixes #2, #4)
- **Tool-name distribution:** no tool >25%, none <12%. Target for a fresh ~7k-positive set: Bash ~22%, Read ~18%, Edit ~16%, Grep ~15%, Write ~15%, Glob ~14%. **Downsample Bash ~55%** (keep only well-formed, non-empty commands) and **upsample Glob/Write/Grep ~3–4×** (synthesize) so every tool has comparable gradient mass.
- **Kill degenerate Bash rows:** drop empty/whitespace/single-token commands; per the project's own dedicated-tool rule, **rewrite `cat`→Read, `find`→Glob, `grep`/`rg`→Grep** as paired examples so the model learns the tool boundary.

### P0 — Hammer function masking (fixes #2, #4) — highest leverage
[Hammer, arXiv:2410.04587] masks, at data-gen time, ~50% of positive rows: replace each tool's **name** and **parameter names** with random aliases (e.g. `Bash`→`fn_8a3`, `command`→`p_x1`), keep the human-readable **description** intact, and relabel the gold call to match. This forces description-grounded selection and **kills the "Bash" token bias**. Train on a **mix** of masked-alias rows (teaches grounding) and real-name rows (teaches the production schema). This is exactly why Hammer-1.5B hits 72.18 BFCL irrelevance at sub-2B.

### P0 — Fix the negatives (fixes #3, #1)
- **Ratio: 25% → ~10–12%** (Hammer's optimum is ~10% irrelevance-augmentation).
- **Diversity: 3 strings → 150–300+** distinct refusal/clarification realizations; no single completion >1%.
- **Types:** (a) irrelevance (correct tool absent → empty call / honest refusal), (b) **missing-param** (tool exists, required arg absent → ask, don't fabricate), (c) chit-chat/conceptual (no tool).
- **Add a "positive prose" class (~8–10%):** normal helpful replies with **no tool and no refusal template** — restores the {answer normally} mode.

### P1 — Recipe knobs
| Knob | Current FC run | Recommended | Why |
|---|---|---|---|
| lr | **2e-4** (default) | **~7e-5**, cosine | tied-weight loop multiplies effective update across recurrent steps → 2e-4 drove template memorization |
| LoRA | r16/α32 | **r32/α64** | r16 under-fit a 6-tool boundary in 1 epoch |
| epochs | 1 | **2** | 1 under-fit the rebalanced distribution (watch per-tool trigger rate; stop if Glob/Write memorize) |
| recurrent depth (train) | (serve default) | **match serving** (`OURO_UT_STEPS=3`) | optimize the adapter for the deployed compute path |
| seq / loss / batch | 1536 / completion-only / eff. 16 | **keep** | verify the mask boundary lands exactly at the tool-call token start under the pinned template |
| function-masked frac | 0 | **~0.5 of positives** | see Hammer above |

### P1 — Train/serve format parity (fixes #1)
Generate the training data through the **same serializer the server uses** ([`ouro_anthropic_bridge.py`](../../scripts/ouro_anthropic_bridge.py) `_render_tools` / [`tool-runner.js`](../../apps/lantern-garage/lib/tool-runner.js) `renderToolPreamble`). Verify byte-for-byte that a rendered training prompt == what the live server sends. Use the **canonical 8 tool names** (Read/LS/Glob/Grep/Bash/PowerShell/Write/Edit).

### P1 — Evaluation (BFCL + in-domain)
- **Harness:** Berkeley Function-Calling Leaderboard (BFCL) against the served endpoint with the **pinned** tool-call format.
- **Watch:** **irrelevance** (the over-refusal/under-trigger headline), **relevance**, AST/simple (per-tool, catches Bash-bias + bad args), multiple/parallel, multi-turn.
- **Sub-2B targets:** Hammer-1.5B = **73.04% overall / 72.18 irrelevance / 92.68 relevance**; xLAM-1b-fc-r = **78.94% overall** (stretch).
- **Custom regression metrics:** per-tool trigger rate on a held-out set; false-refusal rate on positive-prose+valid-tool prompts; empty/malformed-Bash-arg rate (target <2%).
- **Release gate:** irrelevance ≥70 **and** relevance ≥88 **and** per-tool trigger rate within 2× across all 6 tools **and** malformed-Bash <2%.
- **Also build a small in-domain eval** of the 6 real tools (gold calls + gold refusals) — BFCL won't test our exact schema.
- **Procedure:** baseline the current checkpoint first; eval every ~150-step checkpoint on irrelevance+relevance (over-refusal regresses fast); compare masked-name vs real-name eval to confirm masking generalizes.

**Throughput note:** ~9k rows × 2 epochs / eff-batch 16 ≈ ~1,125 steps ≈ **~12 h** on the 3070 at 38.5 s/step. Checkpoint + eval every 150 steps.

## 6. Assets available (verified on disk)

| File | Rows | Role |
|---|---|---|
| `models/lantern-sigma0-coder/fc-hermes.jsonl` | 8,920 | positive FC — Hermes (Apache-2.0) |
| `models/lantern-sigma0-coder/fc-toolace.jsonl` | 9,877 | positive FC — ToolACE (Apache-2.0) |
| `models/lantern-sigma0-coder/tool-trace-pairs.jsonl` | 7,265 | positive trigger — repo session harvest (Bash-heavy; rebalance) |
| `models/lantern-sigma0-coder/fc-negatives.jsonl` | 6,051 | negatives — xlam-irrelevance (CC-BY-4.0); **only 3 refusal strings — diversify** |
| `models/lantern-sigma0-coder/training-data.harvested.jsonl` | 250 | positive code-gen (no tool) |
| `models/lantern-sigma0-coder/training-data.jsonl` | 31,218 | **combined** (24,917 with `<tool_call>`, 6,301 without = 20.2% neg) |
| `models/lantern-sigma0-coder/training-data-5k.jsonl` | 5,050 | the subset the FC adapter was trained on (25% neg) |

Pipeline: `harvest_tool_traces.py` → `convert_fc_dataset.py` (`--source hermes|toolace|irrelevance`) → combine → `train-qlora-ouro.py`. Continual-training orchestrator: `scripts/continual_ouro_pipeline.py` (harvest → execution-verify → train → HumanEval-gated promote; see [SIGMA0-CONTINUAL-TRAINING.md](../SIGMA0-CONTINUAL-TRAINING.md)). **Gating note:** that pipeline gates on **HumanEval** (coding); a FC retrain needs a **BFCL/FC gate** added to `decide_promotion`, or it should target a separate FC adapter slot.

**Gated dataset to add (needs HF login):** `Salesforce/xlam-function-calling-60k` — execution-verified, CC-BY-4.0 (commercial OK w/ attribution), underpins xLAM-1b-fc-r. `huggingface-cli login`, then add an xLAM source to `convert_fc_dataset.py`.

## 7. Doc discrepancies to clean up (found while grounding)

- **seq:** [SIGMA0-OURO-CODER.md](../SIGMA0-OURO-CODER.md) says `seq 1024`; the script now defaults **1536** (audited p99=1219). Update the doc.
- **HumanEval:** [SIGMA0-CONTINUAL-TRAINING.md](../SIGMA0-CONTINUAL-TRAINING.md) still says the full rerun is "partial ~58% (67/115)". It **completed**: pass@1 **0.518** (85/164) in `data/eval/leaderboard.jsonl` (`ouro-final-rerun-full`). The ~0.58 incumbent bar overshot; update to 0.518.
- **base-model name:** script + leaderboard use `ByteDance/Ouro-1.4B`; SIGMA0-OURO-CODER.md mixes in `Ouro-1.4B-Thinking`. Pin one.

## 8. Open questions for the team
- **Mix the two adapters or keep separate?** The FC tune degrades general chat (it tool-ifies everything). Recommend a **dedicated FC adapter slot** + route by surface, OR a multi-task corpus with the positive-prose class large enough to preserve chat.
- **Bash policy in the corpus:** do we want the model to *prefer* the typed tools (Read/Glob/Grep) over Bash (cleaner, safer), and only use Bash for genuinely shell-shaped tasks? The P0 rewrites (cat→Read etc.) assume yes.
- **Looped-depth training:** does training at `OURO_UT_STEPS=3` (vs serve default) measurably change FC reliability? Worth an ablation.

## 9. Sources
- Hammer — function masking + ~10% irrelevance optimum + sub-2B BFCL: <https://arxiv.org/abs/2410.04587> · <https://arxiv.org/html/2410.04587v2>
- xLAM-1b-fc-r — 78.94% BFCL, sub-2B: <https://huggingface.co/Salesforce/xLAM-1b-fc-r>
- ToolACE — data-quality ceiling (8B rivals GPT-4): <https://arxiv.org/abs/2409.00920> · <https://huggingface.co/Team-ACE/ToolACE-8B>
- Hammer2.1-1.5b — sub-2B coder FC analog: <https://huggingface.co/MadeAgents/Hammer2.1-1.5b>
- BFCL eval categories: <https://gorilla.cs.berkeley.edu/leaderboard.html>
- Internal: [SIGMA0-OURO-CODER.md](../SIGMA0-OURO-CODER.md) · [SIGMA0-CONTINUAL-TRAINING.md](../SIGMA0-CONTINUAL-TRAINING.md)
