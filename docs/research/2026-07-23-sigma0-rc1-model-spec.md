---
author: Alex Place (drafted by Claude lane, 2026-07-23)
created: 2026-07-23
status: SPEC — the concrete research candidate for benchmarking; runnable after P0 gate-wiring
parent: 2026-07-23-sigma0-llm-design.md (design of record) · SIGMA0-LLM-WHITEPAPER.md (plain-English)
---

# Σ₀-RC1 — the concrete local model spec for research & benchmarking

*This is the buildable instantiation of the design of record: exact checkpoints, exact knobs,
exact baselines, exact numbers to beat. Every experiment against it is comparable because
everything here is pinned. Hardware ground truth: reference box = RTX 3070 8GB + Windows,
Ollama daemon (healthy, currently stopped), `.venv-train` cu121, HF_HOME=D:\hf-cache.*

## 1. The three arms (benchmark all; the tier bake-off IS the experiment)

| Arm | Checkpoint | Size / serving footprint | Why this arm |
|---|---|---|---|
| **RC1-L** (looped) | `ByteDance/Ouro-1.4B-Thinking` via `scripts/ouro_serve.py` | ~1.85GB (NF4) GPU · CPU-viable | the design's pure-looped bet: weight-tied recursion + trained Q-exit; the only arm the JSRR gate + canary already instrument |
| **RC1-D** (dense comparator) | `qwen2.5-coder:1.5b` (Ollama, Q4_K_M) | ~1.1GB · CPU-viable | strongest practical dense baseline at the tier; the 1.5B probe floor (AUROC 0.980/0.774) was measured at this class |
| **RC1-D3** (tier ceiling) | `qwen2.5-coder:3b` (Ollama, Q4_K_M) | ~2.0GB · CPU-viable | the top of the operator envelope (≤3B/≤4GB); tests whether the last doubling buys its cost |

**Escalation tier (not the product):** `qwen2.5-coder:7b` Q4_K_M (~4.7GB — GPU boxes only;
measured 0.829 HumanEval-164 single-shot = the local escalation reference) · cloud
`SPIRAL_FRONTIER_PROVIDER=openai` for the true-frontier rescue arm.

**Rejected for RC1** (on the record): 0.5B tier (probe floor fails, 0.703; retrieval measured
harmful 6/6→2/6) · any MoE core (uncertified switched system — admission gate not built) ·
7B as product tier (operator envelope: crashes the reference class).

## 2. Serving configuration (pinned)

```bash
# ── RC1-L: the looped arm, gates ON (this IS the P0 configuration) ──
OURO_NATIVE=1 OURO_MODE=qexit OURO_Q=0.5 \
OURO_4BIT=1 OURO_KV_INT8=1 OURO_UT_STEPS=4 \
OURO_CANARY=1 OURO_ADAPT=1 \
SIGMA0_JSRR_MARGIN=0.05 \
python scripts/ouro_serve.py          # :11434, Ollama wire protocol

# ── RC1-D / RC1-D3: dense arms ──
ollama serve &&  ollama pull qwen2.5-coder:1.5b qwen2.5-coder:3b
# CPU-mode runs: same models, OLLAMA num_gpu=0 (record tok/s separately)
```

Pinned decode params, all arms: `temperature 0.7 / top_p 0.9` for the N-sample ladder,
`temperature 0` for the single-shot baseline row; `repetition_penalty 1.3, no_repeat_ngram 3`
(RC1-L small-model guards); seed ladder `1337 + i` for sample i (deterministic reruns).
Context budget: 8k task window (Ouro's comfort zone; Qwen native 32k unused in RC1).

**Gate receipts (required output, every RC1-L generation):** one JSONL row —
`{ρ, jsrr_verdict, mean_depth, canary_proximity, exit_reason}` → `data/sigma0/rc1-receipts.jsonl`.
Σ₀⁻¹ policy for RC1: `observe_only=false, max_interventions=2/generation` (bounded, receipted) —
the certificate's C3 is conditional on permission to act; RC1 grants it *bounded*.

## 3. The system wrap (what makes it Σ₀ and not just a small model)

Spiral harness (`spiral_solve` / `experiments/spiral_phase0.js`) over each arm:
**N=8 samples default** (budget dial: low=4, high=16) → real exec verifier
(`exec-verify`, python runner, 8s timeout) → **held-out split: visible tests for selection,
≥1 held-out test for the *scored* verdict** (the transduction-trap rule — a solve only counts
on held-out pass) → stall ⇒ escalate carrying best candidate + failing tests (teacher-as-repair,
never blank-prompt) → honest-halt if unverified. Per-task budget caps: low $0.02 / high $0.25
equivalent (local compute priced at measured tok/s; cloud at list price).

## 4. Benchmark matrix (the numbers this model exists to produce)

| # | Benchmark | Split / harness | The row it fills |
|---|---|---|---|
| B1 | **HumanEval-164 verified cascade** (the missing headline) | `scripts/humaneval_runner.py` + spiral wrap | verified pass@1, $/task, e, vs 0.829 escalation reference |
| B2 | MBPP held-out | [400–450) (the existing VTD split — never trained on) | verified pass + regression check vs 21/50 base rows |
| B3 | Depth-stability sweep (RC1-L only) | `OURO_UT_STEPS ∈ {2,4,6,8}` on B2 | accuracy-vs-depth + ρ trajectory (peak-then-collapse profile); the JSRR gate's first live-workload validation |
| B4 | ARC-AGI-2 budgeted sample | ADR-0031 harness (to build), 20-task public sample | score @ $/task, two-budget experiment (design falsifier 7) |
| B5 | Energy/throughput | tok/s + nvidia-smi power polling (GPU); CPU runs wall-clock only, energy marked ESTIMATED | verified-solves per watt-hour (honest caveat: Windows CPU energy is approximated) |

**Baselines every table must carry** (or the number is unreportable): (a) same-arm single-shot
temp-0; (b) same-arm Best-of-N *majority, no verifier* (isolates the verifier's contribution —
Snell's claim dies or lives here); (c) 7B single-shot 0.829; (d) published tier numbers
(Qwen2.5-Coder-1.5B/3B report cards) for external anchoring.

## 5. Acceptance / kill criteria (pre-registered)

- **RC1 ships as the research reference iff** B1 verified-cascade beats baseline (b) at equal
  compute AND beats baseline (a) by ≥15pp AND the B1 $/task is ≤⅕ of the 7B-single-shot cost row.
- **RC1-L (the looped bet) earns the core slot iff** it beats RC1-D on B1-per-dollar or B3 shows
  usable depth-scaling that dense arms structurally lack; else **the design's core defaults to
  RC1-D and says so** — the looped bet is falsifiable, not protected.
- **Kill row:** if no arm beats baseline (b) at equal compute, verifier amplification is not
  delivering above blind sampling here and the design's §1 claim is refuted at this tier —
  report it, per the certificate's honesty discipline.

## 6. Training path (AFTER RC1 baselines exist — never before)

VTD on the winning arm only: LlamaFactory, gentle config (lr 5e-5, ≤3 epochs, LoRA r=8,
retention mix), data = escalation corpus + exec-verified TACO (Apache-2.0 primary; NC-tagged
sets research-only), **every promotion behind Σ_θ on fresh held-out** (its first real run), then
BitDistill ternary with **#2873 probe survival as the acceptance test**. GPU training is real
spend (L4 class) and sits with the mookman handoff (#2850) — nothing in RC1 presumes it.

## 7. Build items standing between this spec and first numbers

1. **P0 (binding precondition, design-doc header):** JSRR verdict + receipts on the default
   serve path; Σ₀⁻¹ bounded-armed (the §2 config *is* P0's definition of done).
2. Spiral wrap for `humaneval_runner.py` (B1) with the held-out split + cost meter.
3. ARC-AGI-2 sample harness (B4) — smallest slice last.

*Ollama daemon is currently stopped on the box; `ollama serve` before any RC1-D run.
Everything else above exists today.*
