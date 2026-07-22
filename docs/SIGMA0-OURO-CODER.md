---
author: Alex Place
created: 2026-06-19
updated: 2026-07-22
---

# Σ₀ Ouro Coder → the Spiral — the owned local coding model (single source of truth)

> ## ⭐ Current state (2026-07-22): the model IS the Spiral, a verified cascade
>
> This page is the **one doc for the owned local coder and its whole legacy** — what it was,
> what it is, and where it's going. The headline, decided in **[ADR-0030](adr/0030-spiral-verified-cascade-harness.md)**
> (Accepted): the "model" is no longer a single fine-tune. It is the **Spiral** — the CLAUDE.md
> convergence loop run on ONE problem, whose per-turn engine is a **verified cascade** (a cheap
> owned tier proposes → a real exec-test verifier gates by **Fix Rate** → escalate to a frontier
> tier only on a stall, inheriting the progress). **The moat is the system, not a home-grown
> frontier model, and generalization comes from the verifier, not scale.**
>
> The lineage that led here — Qwen-3B QLoRA → Ouro-1.4B looped → the owned PLT coder → the
> verified Qwen-7B default → the Spiral — is the rest of this page. Everything about the **Ouro
> recurrent-depth kernel** below is still accurate: Ouro is the looped-reasoning research front
> and the Convergence-Core kernel; the Spiral is the outer verified loop that wraps whatever cheap
> tier leads. Design of record: [docs/research/2026-07-22-spiral-verified-cascade-design.md](research/2026-07-22-spiral-verified-cascade-design.md).

> ## 📖 In plain English (start here)
>
> **What this is:** a coding assistant that runs on **your own computer** (CPU or an 8GB GPU) —
> no cloud needed for the common case. It's built to **punch above its size** by being careful,
> not big.
>
> **The trick — it spirals, and it checks its work against reality.** Instead of answering once,
> it works one problem in a loop: it proposes a step, then **actually runs the tests**. It keeps
> only steps that genuinely make more tests pass. If its small local brain gets stuck, it calls a
> big frontier model **for that one step**, hands it everything it's figured out so far, and keeps
> going. Most steps are easy and stay local (cheap); only the hard ones "phone a friend."
>
> **Why that's the whole point.** Because a real test — not the model's opinion — decides every
> step, a small model can't bluff its way to a wrong answer, and it keeps improving on the exact
> steps it used to fail. Every time it has to call the big model, that's a free lesson it saves to
> get better next time. The one number that matters — how often it has to escalate — is designed
> to only go **down**.
>
> **Its brains, past and present.** The current cheap "brain" is **Qwen2.5-Coder-7B** (the one
> local coder we've actually verified on our own hardware). An earlier brain, **Ouro**, is a
> looping model we keep as the research kernel — it "re-reads the hard sentence until it clicks."
> The whole thing is one swappable brain plugged into the bigger Lantern loop — *Observe →
> Remember → Reason → Act → Verify → Converge*.
>
> **Honest about limits:** its home is **verifiable work** — code and math, where a test can
> decide. Away from that (open-ended chat), it can't ratchet, so it's just a normal small model.
> It is not a frontier model; the edge is the *system* around it.
>
> The rest of this page is the precise version. ↓

---

## 1. What this is now — the Spiral

The **owned local coder** is the **Spiral** ([ADR-0030](adr/0030-spiral-verified-cascade-harness.md)):
the convergence loop run on one problem, where **each turn is a verified cascade**.

```
loop on ONE problem:
  cheap owned tier proposes the next step        (Qwen2.5-Coder-7B today; a VTD-specialized tier later)
  → Fix-Rate verifier gates it                   (real exec tests: failing→passing minus a regression penalty)
  → if it stalled, escalate THIS step            (rented frontier — inherits the accumulated memory)
  → commit only if reality ratchets it           (the anti-memorization gate)
  halt on solved | honest-can't | turn cap; emit the escalation corpus (the Phase-1 VTD fuel)
```

Five modules (design doc §2): **M1** growing verified memory · **M2** the per-turn cascade ·
**M3** rotational anti-collapse (coRNN-grounded; Phase 2) · **M4** the Fix-Rate verifier
(the load-bearing piece) · **M5** answerability halt ("honest can't"). Generalization comes from
**M4**, not the parameters — ARC-Prize showed tiny-recursive puzzle wins are largely memorization,
so an *external* verifier is what makes it generalize.

**Implementation (Phase 0, shipped):**
| Piece | File |
|---|---|
| the loop + per-turn cascade + corpus emit | [`lib/spiral-harness.js`](../apps/lantern-garage/lib/spiral-harness.js) |
| the M4 Fix-Rate ratchet metric (pure) | [`lib/spiral-fix-rate.js`](../apps/lantern-garage/lib/spiral-fix-rate.js) |
| real exec verifier + injectable model tiers | [`lib/spiral-tiers.js`](../apps/lantern-garage/lib/spiral-tiers.js) |
| non-blocking bounded exec sandbox | [`lib/exec-verify.js`](../apps/lantern-garage/lib/exec-verify.js) (`verifyExecAsync`) |
| **the chat surface** — `spiral_solve` operator tool | [`lib/tool-runner.js`](../apps/lantern-garage/lib/tool-runner.js) |
| Phase-0 runner over real executable tasks | [`experiments/spiral_phase0.js`](../experiments/spiral_phase0.js) |

**Chat is the surface.** A user drives a spiral on a tested coding task from
[`dream-chat.html`](../apps/lantern-garage/public/dream-chat.html) via the `spiral_solve` tool and
watches it converge; it returns the verified solution + transcript + escalation rate, and says so
honestly when it can't verify. This is the *Coder = Kernel + Memory + Tools* task type of
[06] LANTERN-CODER, now realized as a verified loop rather than a single model call.

## 2. The legacy — the full lineage

There have been several "local coders"; this is the arc, oldest to newest. **Each superseded step
is kept for history; the Spiral is what unifies them.**

| Era | Model | Role then | Status now |
|---|---|---|---|
| 2026-06-18 | **`lantern-sigma0-coder`** — Qwen2.5-Coder-3B QLoRA, served via the **Ollama binary** | the first local coder | **removed** (git history); Ollama-binary dependency retired (#811/#823) |
| 2026-06-20 | **Σ₀ Ouro Coder** — Ouro-1.4B weight-tied **looped** transformer + Q-exit, our QLoRA | *the* local coder | **recurrent-depth KERNEL / research front** (see §7); no longer the coding lead |
| 2026-07-01 | **`keystone-sigma0-plt`** — owned Parallel Loop Transformer bootstrapped from LoopCoder-V2 ([ADR-0011](adr/0011-proprietary-sigma0-base-model.md)) | the sole local coder by operator decision | registered but **`verified:false`** — leads only for lack of a verified peer; serves on its `:11435` shim |
| 2026-07-06 | **`qwen2.5-coder:latest`** — supported Apache-2.0 Qwen2.5-Coder-7B (OSS-baseline #2171) | the **verified** local coder | **reproduced on-box** (#2173: coding-golden exec pass@1 0.96) — the current cheap-tier base |
| **2026-07-22** | **the Spiral** — a verified cascade over the above, with a growing verified memory ([ADR-0030](adr/0030-spiral-verified-cascade-harness.md)) | — | **the current architecture** — the model is now the *system*, not any single checkpoint |

**Why the arc bent this way.** We chased "own a small model that codes." Two facts settled the
strategy: (1) open Qwen3-Coder-32B already ≈ Claude 3.5 on SWE-bench, so **we can't out-parameter
the frontier and don't need to**; (2) tiny-recursive puzzle wins are largely memorization, so
**the verifier, not scale, is the source of generalization**. Both point away from "a bigger
home-grown checkpoint" and toward "a verified *system* around a small, honest, improving cheap
tier." That system is the Spiral.

## 3. The moat — the system, not the model

- **Not** a home-grown frontier model (scale isn't our edge).
- **Is:** a verified harness (the exec Fix-Rate ratchet) + **owned verified-trace data** (the
  escalation corpus the Spiral generates) + the **smallest hardware** (CPU / 8GB) + local/private.
- **The flywheel:** every escalation is a frontier demonstration on a step the cheap tier
  couldn't do — a perfect **Verified-Trace-Distillation** target. Train the cheap tier on those and
  it does cheaply next time what it escalated for last time. The governing number — the
  **escalation rate** — is designed to only fall. Live cascade economics already measured: a strong
  cheap tier escalates ≈0% and is **8.3× cheaper** (#2800).

## 4. Borrowed weights & training sets (validated as convergence records)

"Nothing is accepted without evidence." Each open **weight** or **training set** we might borrow
for incremental gains is validated as one honest ConvergenceRecord — reproducible via
[`scripts/spiral_borrow_records.js`](../scripts/spiral_borrow_records.js) (records land in the
gitignored canonical ledger `data/convergence/records.jsonl`). The **External Reality Rule** holds:
a borrow is a **candidate** (`verified:false`) until reproduced on our hardware, and synthesized
trajectory sets are gated behind our own exec-verification before any become a VTD target
(Gekhman 2405.05904: SFT on unverified data raises hallucination). The insight, per the survey:
**open training sets are the likelier win** — we already have a good cheap tier; what we lack is
owned verified data.

| Borrow | Phase | Conf | Verified? | Why / gain | Source |
|---|---|---|---|---|---|
| **Qwen2.5-Coder-7B** (Apache-2.0) | P1 base | 0.82 | ✅ on-box (#2173) | known-good verified base VTD improves, not replaces | best-for-8GB guides; registry |
| **SWE-HERO** exec-verified 13.5k | P1 | 0.75 | candidate | reference patches verified *by execution* → honest VTD subset | [2604.01496](https://arxiv.org/pdf/2604.01496) |
| **KodCode** (verifiable, ≥5 tests/problem) | P1 / M4 | 0.72 | candidate | test-rich → the *rich* per-test Fix Rate our metric rewards | [2503.02951](https://arxiv.org/html/2503.02951v1) · [HF](https://huggingface.co/KodCode) |
| **SWE-Gym** (2.4K exec + 234 Lite) | P0 / P1 | 0.70 | candidate | executable → native Fix-Rate source; Lite = the cheap first run | [Modal](https://modal.com/resources/best-open-source-models-swe-bench-coding-agents) |
| **TACO** (25K, Apache-2.0, verified) | P1 / M4 | 0.68 | candidate | cleanest license — safe for a commercial moat | [2501.01054](https://arxiv.org/pdf/2501.01054) |
| **SWE-rebench V2** (32k+ containerized, decontaminated, 20 langs) | P1 | 0.68 | candidate | scale + decontamination (avoids eval leakage) | [Nebius](https://nebius.com/blog/posts/meet-swe-rebench-v2) · [2505.20411](https://arxiv.org/pdf/2505.20411) |
| **Pass-rate reward** (+ dynamic unit-test scaling) | M4 | 0.65 | candidate | confirms Fix Rate ~ pass-rate; a learned PRM as a cheap pre-filter | [2605.02944](https://arxiv.org/pdf/2605.02944) |
| **OpenCoder-8B** (weights + **data** + recipe) | P1 | 0.60 | candidate | the open *data/recipe* is the borrow — a path to an owned base | [kilo.ai](https://kilo.ai/open-source-models) |
| **DeepCoder-14B** (open RL recipe, verl) | P1 (24GB) | 0.58 | candidate | recipe transfers down to 7B; escalation-tier option on a big box | [Together](https://www.together.ai/blog/deepcoder) |
| **Open-SWE-Traces** (207k synthesized) | P1 | 0.50 | candidate ⚠ gated | volume — but **exec-verify before use** (synthesized, not executed) | [2606.16038](https://arxiv.org/html/2606.16038v1) |
| **TRM (~7M) / HRM (27M)** substrates | P2 | 0.35 | candidate ⚠ risk | the tiny recursive core *if* it generalizes to code — puzzle-proven only | [2510.04871](https://arxiv.org/abs/2510.04871) · [2506.21734](https://arxiv.org/abs/2506.21734) |

## 5. The three phases (de-risked, most value first)

- **Phase 0 — the verified-cascade harness (NO new weights). ✅ shipped + run live on-box.**
  Reassembles the parts we already had (live cascade #2800, cheap-tier picker #2814, verified
  ledger #2797) into the loop. [`experiments/spiral_phase0.js`](../experiments/spiral_phase0.js)
  runs the spiral over real executable tasks, emits the escalation corpus, and self-emits a
  ConvergenceRecord. **Verified live, fully local, zero spend (2026-07-22):** a real cascade with
  `cheap=qwen2.5-coder:0.5b → escalate=qwen2.5-coder:7b` on the local Ollama daemon solved **5/6**
  real tasks at **33% escalation** (4/6 cheap-tier sufficiency); the 6th (`rle`) was honestly
  reported **unsolved** after both tiers plateaued — nothing fabricated — and the escalated rescue
  (`two_sum`) was captured as a `distillTarget` corpus row. That is the affordable-long-horizon +
  honest-halt behavior, on-box, with two real models. With a **cloud** escalate tier
  (`SPIRAL_FRONTIER_PROVIDER=openai`) `rle` also solves → **6/6**: the cheap tier sets the cost
  floor, the escalate tier the ceiling. On the **borrowed open MBPP-basic** set
  (`node experiments/spiral_phase0.js --dataset mbpp --live`, 18 problems, per-check Fix Rate) the
  same fully-local cascade solved **18/18 at 6% escalation** (17/18 cheap-tier sufficiency — only
  `mbpp-8` needed the 7B). **Honest scope:** MBPP-basic is a *basic curated* set, so this shows the
  cheap tier **saturates easy open problems locally** and the cascade catches the miss — it is
  **not** a hard-task (full-MBPP / SWE-bench) claim; stressing the escalation economics on a harder
  open set is the next run.
- **Phase 1 — VTD-specialize the cheap tier (own weights). Confirmed NECESSARY (2026-07-22).** We
  first tested the *cheap* form of self-improvement — retrieval, no weight change (CLAUDE.md
  "improve via retrieval, not retraining"). On-box it **HURT** the tiny model:
  [`experiments/tiny_model_selfimprove.js`](../experiments/tiny_model_selfimprove.js) measured
  `qwen2.5-coder:0.5b` at baseline **6/6** on held-out DP problems → **2/6** when its own verified
  solutions were injected as few-shot (regressed 4, rescued 0). The raw generations show *template
  contamination*: shown `min_distance`, the 0.5B wrote an edit-distance-shaped answer to
  `longest_common_subsequence`. A model this tiny has weak in-context learning, so capability can't
  ride in the context — it must be baked into the **weights**. So VTD is the path, not a nice-to-have.
  **Run 1 (2026-07-22, MEASURED NEGATIVE — dose, not mechanism):** the full pipeline ran end-to-end
  on-box — 120 MBPP problems → **63 exec-verified traces** (36 frontier rescues) via the cascade
  (0.5B local → OpenAI escalate), QLoRA on the RTX 3070 (6 epochs, 292s, r=16, lr 2e-4,
  best-checkpoint on held-out eval_loss), then held-out MBPP [400–450): **base 21/50 (42%) →
  +VTD 15/50 (30%), delta −6** (fixed 2, regressed 8; ledger record `cr-mrvvxsuc`). At 55 train
  rows the model memorized the corpus (train loss 0.003) and the update damaged the instruct
  behavior more than it taught. Together with the retrieval negative this shows the 0.5B's
  capability is **fragile under both context injection and aggressive small-corpus updates**.
  **Run 2 (same day, dose-response confirmed):** scaled to **204 traces** (remaining MBPP 120–400)
  and retrained gentle (lr 5e-5, 3 epochs, r=8): held-out delta went **−6 → ±0** (21/50 both arms;
  fixed 3, regressed 3; ledger `cr-mrvxt1li`). Training dynamics flipped from memorized (loss
  0.003) to healthy (loss 0.38, best checkpoint = last). The direction confirms the scale
  hypothesis: **more data + gentler update = less damage, with real fixes appearing** — but the
  crossover to a net lift needs an order of magnitude more traces. MBPP is nearly exhausted
  (400/450 used); the next corpus source is the borrowed verifiable sets (§4: KodCode ≥5
  tests/problem, TACO Apache-2.0), plus a retention mix to eliminate the residual regressions.
  Longer-term data = the **exec-verified** subset of {SWE-HERO 13.5k, KodCode, TACO} **+ our own
  escalation corpus**; method = Verified-Trace Distillation (receipt-gated, both-class,
  process-level; nearest prior art rStar-Math 2501.04519). Cloud GPU dispatch is real spend (see
  §9); the local 3070 handles the 0.5B tier. Relates to [ADR-0015](adr/0015-qwen-teacher-verified-distillation.md) /
  [ADR-0024](adr/0024-sigma0-frontier-training-program.md) / [ADR-0025](adr/0025-rlvr-dreaming-continual-updates-double-gated.md).
- **Phase 2 — the tiny recursive core (research option).** TRM/HRM substrate + rotational
  anti-collapse (coRNN) as trainable modules. **Gated behind Phase-1 evidence** and held at low
  confidence: proven on puzzles/tabular only, not code/language (the make-or-break risk).

## 6. Serving & running it

```bash
# Phase-0 spiral over real executable tasks (free, deterministic mechanics run)
node experiments/spiral_phase0.js
# real LOCAL cascade, zero spend: cheap qwen2.5-coder:0.5b → escalate 7b on the Ollama daemon
node experiments/spiral_phase0.js --live
# stronger rescue via a cloud escalate tier (keys present): OpenAI / Gemini
SPIRAL_FRONTIER_PROVIDER=openai node experiments/spiral_phase0.js --live

# emit / refresh the borrow convergence records
node scripts/spiral_borrow_records.js

# in dream-chat: the assistant calls the `spiral_solve` tool on a tested coding task.
```

**Local-model resolution (the "fix the local Ollama" seam).** The spiral's local cheap tier
resolves its model from the constraint-aware registry (`selectCheapStandin` → `qwen2.5-coder`),
**not** the raw `OLLAMA_MODEL` env — which on this box pins `ouro:latest`, a model served only by
the separate `ouro_serve.py` shim, so a plain-daemon call to it returns *"model not found"*. So
`spiral_solve` and the Phase-0 runner work against whatever coder is actually pulled in Ollama,
independent of the Ouro serving state. Override with `SPIRAL_LOCAL_MODEL`.

The Ouro **kernel** is still served exactly as before — `ouro_serve.py` speaks the Ollama HTTP
API on `:11434`, and the cheap-tier / re-prompt loop points at `OLLAMA_BASE_URL`. See §8 for the
full knob reference.

## 7. The loop mechanism — the Ouro recurrent-depth kernel

*(The Spiral is the outer, verifier-gated loop. Ouro is the inner recurrent-depth kernel and the
looped-reasoning research front — both are real, and they compose: a looped model can be the cheap
tier of the Spiral.)*

**Source:** *Scaling Latent Reasoning via Looped Language Models* (Ouro,
[arXiv:2510.25741](https://arxiv.org/abs/2510.25741); PDF `docs/research-papers/ouro-looped-llm-2510.25741.pdf`).
LoopLM builds reasoning into computation by **reusing weight-tied layers R times** in latent space
(the paper's "third scaling axis": loop depth), with a learned **Q-exit** early-exit gate.

### 7.1 Native latent loop on real Ouro weights
[`src/sigma0/loop_lm.py`](../src/sigma0/loop_lm.py) — `Sigma0LoopLM` runs the paper's **Q-exit
adaptive-depth policy** (λ→survival→CDF→first-step-≥q) on Ouro's pretrained weight-tied block + exit
gate (we do **not** pretrain a LoopLM — that needs 7.7T tokens). The stock checkpoint runs fixed
full depth; our module activates the adaptive inference and reports realized per-token depth
(`mean_depth`). Three exit policies (`OURO_MODE`):
- **`qexit`** (default) — the trained gate; exit at the first step with `CDF(t) ≥ q`.
- **`converge`** — first-order latent fixed point `‖hₜ−hₜ₋₁‖/‖hₜ₋₁‖ < ε`.
- **`accel`** — spiral-robust second-order acceleration criterion (Two-Scale, arXiv:2509.23314);
  the **certificate-consistent** upgrade where first-order `converge` false-exits on spiral dynamics
  (see [collapse certificate](SIGMA0-COLLAPSE-CERTIFICATE.md) §1.1).

**DecodeCanary + depth coupling (intrinsic anti-collapse):** in native mode the per-token
DecodeCanary (#766/#793) folds self-repeat / n-gram echo / argmax-margin / entropy-collapse
z-alarms into one `sigma0_proximity`. `OURO_CANARY=1` runs it observe-only; `OURO_ADAPT=1` arms the
actuator — as proximity rises, the loop deepens and the repetition penalty rises (#1014,
divergence→depth coupling). This is the *inner* anti-collapse; the Spiral's M3 (coRNN rotational
recurrence) is the *outer* one.

### 7.2 API-level re-prompt loop (provider-agnostic)
[`lib/loop-reasoner.js`](../apps/lantern-garage/lib/loop-reasoner.js) — `loopedReason()` approximates
the loop for any plain local model by re-prompting up to `MAX_LOOPS` (4 = Ouro R4), feeding each
prior answer back as a Coconut-style prefix, exiting via `cdfExit()` (`threshold_met` /
`converged` / `max_loops`). Confidence is heuristic. Wired into
[`lib/stream-chat.js`](../apps/lantern-garage/lib/stream-chat.js) for reasoning/coding intents; the
**"Loop Depth (Σ₀)"** panel in dream-chat renders `⟳ N loop(s) · X% conf · <exit_reason>`.

| Paper concept | Lantern |
|---|---|
| Recurrent steps R | Ouro `total_ut_steps` (native) · `MAX_LOOPS` (re-prompt) · **Spiral turns** (outer) |
| Q-exit `CDF(t) ≥ q` | `qexit_step()` (native) · `cdfExit()` (re-prompt) · **M5 answerability halt** (outer) |
| Realized adaptive depth | `mean_depth` (native) · "Loop Depth (Σ₀)" panel (re-prompt) |
| The **verifier** deciding progress | — (Ouro has none) · **the Spiral's M4 Fix Rate** (this is the new part) |

## 8. Knob reference (`ouro_serve.py`)
| Knob | Default | What it does |
|---|---|---|
| `OURO_NATIVE` | `0` | `1` = deep adaptive loop; `0` = fast cached |
| `OURO_MODE` | `qexit` | exit policy: `qexit` / `converge` / `accel` (native only) |
| `OURO_Q` / `OURO_EPS` | `0.5` / `0.05` | Q-exit threshold · convergence/accel ε |
| `OURO_CANARY` / `OURO_ADAPT` | `1` / `0` | collapse monitor (observe) · depth-coupling actuator |
| `OURO_UT_STEPS` | model default | recurrent-step count — decode-speed lever (3 ≈ 1.28×) + long-context KV lever (2 halves the recurrent cache) |
| `OURO_4BIT` | `0` | NF4 base (~7.7→1.85 GB; forces LoRA unmerged) |
| `OURO_KV_INT8` | `0` | int8 KV cache (~halves it, near-lossless; cached path) |
| `OURO_MERGE` / `OURO_ATTN` | `1` / `sdpa` | merge LoRA into base · attention kernel — together ~2.8× faster (#775) |
| `OURO_REP_PENALTY` / `OURO_NO_REPEAT_NGRAM` | `1.3` / `3` | small-model degeneration guards |
| `OURO_ADAPTER` / `OURO_MODEL` | — / `…/Ouro-1.4B-Thinking` | Σ₀ adapter dir · base model id |

**8GB / CC-scale prompts:** `OURO_4BIT=1 OURO_KV_INT8=1 OURO_UT_STEPS=2` reaches 15–20k-token
prompts on an 8GB card. **Transformers ≥ 4.54** required (Ouro's `configuration_ouro.py` needs
`layer_type_validation`); local `.venv-train` + the Kaggle/Lightning dispatch wrappers pin **4.57**;
`OuroConfig.pad_token_id` is `None` and is patched to `bos_token_id` before load.

## 9. Honest scope & status
- **Home is verifiable domains** (code, math). The Fix-Rate ratchet needs a real test; in
  open-domain chat there is no hard M4, so the Spiral degrades to plain cascade quality — we do not
  claim the ratchet there.
- **Phase 0 is mechanics-verified, not a model result.** [`spiral_phase0.js`](../experiments/spiral_phase0.js)
  proves the loop + exec verifier + corpus on real tasks with stub tiers; a `--live` run is what
  produces a model-capability number.
- **Phase 1 GPU training is real spend** ([memory: dispatch = paid job](adr/0025-rlvr-dreaming-continual-updates-double-gated.md)),
  and Ampere-only (bf16; Kaggle's pre-Ampere free fleet can't be a trustworthy target — the correct
  target is a Lightning/Modal A10/L4). It stays behind an explicit, funded run.
- **Borrows are candidates until reproduced** (§4). Synthesized trajectory sets are exec-verified
  before any become VTD targets.
- **The Ouro kernel (§7)** is real adaptive depth but inference-time only (we don't pretrain), and
  the 1.4B adapter can't yet *drive* Claude Code (under-triggers tools under CC's ~20k-token system
  prompt). Reliable surfaces: in-app chat + the standalone agent loop + now `spiral_solve`.

## 10. Related
- **[ADR-0030](adr/0030-spiral-verified-cascade-harness.md)** — the Spiral decision · [design of record](research/2026-07-22-spiral-verified-cascade-design.md)
- [ADR-0011](adr/0011-proprietary-sigma0-base-model.md) (owned PLT coder) · [ADR-0021](adr/0021-serving-substrate-retain-ouro-custom-loop.md) (retain the Ouro loop) · [ADR-0024](adr/0024-sigma0-frontier-training-program.md) / [ADR-0025](adr/0025-rlvr-dreaming-continual-updates-double-gated.md) / [ADR-0026](adr/0026-ternary-serving-artifact-distillation-target.md) (training + serving-artifact)
- [SIGMA0-CONTINUAL-TRAINING.md](SIGMA0-CONTINUAL-TRAINING.md) — the offline retrain flywheel · [SIGMA0-COLLAPSE-CERTIFICATE.md](SIGMA0-COLLAPSE-CERTIFICATE.md) — the safety foundation
- [CONVERGANCE-SIGMA0-BRIEFING.md](CONVERGANCE-SIGMA0-BRIEFING.md) — the North Star · [models/keystone-sigma0-plt/README.md](../models/keystone-sigma0-plt/README.md) — the PLT coder
- `LANTERN-SIGMA0-CODER.md` · `OURO-LOOPLM.md` — the two superseded pages this consolidates (removed 2026-07-16; in git history)
