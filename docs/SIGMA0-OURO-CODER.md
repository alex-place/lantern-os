---
author: Alex Place
created: 2026-06-19
updated: 2026-06-23
---

# Σ₀ Ouro Coder — the local coding agent (single source of truth)

> **This is the one doc for the local Σ₀ coder — then and now.** It supersedes and folds
> in two older pages:
> - **`LANTERN-SIGMA0-CODER.md`** — *what we had then*: the Qwen2.5-Coder-3B QLoRA model
>   served via the Ollama binary (deprecated, kept as a tombstone).
> - **`OURO-LOOPLM.md`** — the **loop mechanism** (Q-exit math + the two loop
>   implementations), now described in [§The loop mechanism](#the-loop-mechanism) below
>   (deprecated, kept as a redirect).
>
> If you landed on one of those, you're in the right place now.

> ## 📖 In plain English (start here)
>
> **What this is:** a coding assistant that runs entirely **on your own computer** — no
> cloud, no internet needed. Its "brain" is a small AI model called **Ouro**.
>
> **The trick — it thinks in loops.** Most AI models get smarter by being *bigger*. Ouro
> gets smarter by going *around again*: it reuses the same small set of layers several
> times on one problem — like re-reading a hard sentence until it clicks. That's why it's
> named "Ouro," after the *ouroboros*, the snake that eats its own tail. A loop.
>
> **It decides how hard to think.** Easy question? It loops a couple of times and answers
> fast. Hard question? It keeps looping to think it through. A built-in "good enough yet?"
> check (the *Q-exit gate*) decides when to stop — so a tiny model can punch above its size
> on the hard parts without being slow on the easy ones.
>
> **It learned this project.** It was fine-tuned on this repo's own past coding sessions,
> so it already knows the house style and conventions.
>
> **Two speeds:** a **Fast** mode (the default — quick, reuses cached work) and a **Deep**
> "think-harder" mode you switch on for tough problems (slower, ~1 second per word).
>
> **Where it fits:** it's just one swappable "brain" plugged into the bigger Lantern loop —
> *Observe → Remember → Reason → Act → Verify → Converge*. Unplug it, drop in a different
> model, and the rest of the system doesn't change.
>
> **What came before:** an earlier version used a different brain (Qwen) and needed a
> separate "Ollama" program to run it. We retired that — the new one is smaller, loops, and
> runs itself. See *[What we had then → what we have now](#what-we-had-then--what-we-have-now)*.
>
> **Honest about limits:** it's small (1.4 billion parameters), it's a real but modest
> fine-tune (not a production-grade model), and its Deep mode is genuinely slow. A capable
> local helper — not a frontier model.
>
> *🎙️ Want it read aloud? Press the **Listen** bar at the bottom of this page.*
>
> The rest of this page is the precise, technical version. ↓

The **Σ₀ Ouro Coder** is the Σ₀ coding agent running on **Ouro** (the *Ouroboros* looped
language model, [arXiv:2510.25741](https://arxiv.org/abs/2510.25741)) instead of a plain
transformer. It is the same Convergence-Core coder path — `Reason → Act` for code — but its
local brain is **Ouro-1.4B with weight-tied recurrent depth + a learned Q-exit gate**, plus
our own Σ₀ fine-tune. It runs **fully local**, served as a drop-in Ollama-API model.

## What we had then → what we have now

There used to be **two** local coders documented separately; there is now **one**. This is
the arc:

| | **Then** (`lantern-sigma0-coder`, 2026-06-18) | **Now** (Σ₀ Ouro Coder, since 2026-06-20) |
|---|---|---|
| **Base model** | `Qwen/Qwen2.5-Coder-3B-Instruct` (plain transformer) | `ByteDance/Ouro-1.4B-Thinking` (weight-tied **looped** transformer) |
| **Σ₀ tune** | QLoRA on 365 pairs / 51 sessions; 3 epochs / 135 steps; loss 2.87 → 1.78 | QLoRA on the Σ₀ Claude-session set; 3 epochs, 4-bit nf4, r=16/α=32 over `all-linear` |
| **Serving** | **Ollama binary** (`lantern-sigma0-coder-v2`) | [`scripts/ouro_serve.py`](../scripts/ouro_serve.py) — **drop-in Ollama HTTP API**, no Ollama binary |
| **Adaptive depth** | none (single forward pass) | `Sigma0LoopLM` **Q-exit** — loop until `CDF(t) ≥ q` |
| **Routing** | leaderboard-preferred (`model-leaderboard.js`) | drop-in on `:11434`; leaderboard integration is a follow-up |
| **Status** | **deprecated & removed** | **active local coder** |

**Why the switch (issue #811 / PR #823 — "Ollama sunset"):** we retired the external Ollama
binary as a hard dependency and moved to a Python server that *speaks* the Ollama API. That
made it natural to swap the brain for Ouro, whose looped recurrent depth lets a 1.4B model
spend extra computation on hard turns and exit early on easy ones — a better trade for a
small local model than a larger single-pass one.

**Verified on disk (2026-06-20):** the Qwen training outputs
(`D:\lantern-train\sigma0-adapters`, `sigma0-merged`) were **removed** and
`lantern-sigma0-coder-v2` is **no longer registered in Ollama** (only the base
`qwen2.5-coder` blob remained). The active local coder is the Ouro Σ₀ adapter at
`D:\lantern-train\ouro-sigma0-adapters\final\` (base `ByteDance/Ouro-1.4B`, LoRA r=16/α=32,
trained locally). The Qwen continual-training track was **deleted as bloat — do not
rebuild it**; the live retrain pipeline is [SIGMA0-CONTINUAL-TRAINING.md](SIGMA0-CONTINUAL-TRAINING.md).

## What it is
| | |
|---|---|
| **Base model** | `ByteDance/Ouro-1.4B-Thinking` (weight-tied recurrent transformer) |
| **Σ₀ tune** | QLoRA on the Σ₀ Claude-session set ([`scripts/train-qlora-ouro.py`](../scripts/train-qlora-ouro.py); 3 epochs, 4-bit nf4, LoRA r=16/α=32 over `all-linear`, lr 2e-4, **seq 1536**) |
| **Adaptive depth** | `Sigma0LoopLM` Q-exit ([`src/sigma0/loop_lm.py`](../src/sigma0/loop_lm.py)) — exit at the first recurrent step where `CDF(t) ≥ q` |
| **Serving** | [`scripts/ouro_serve.py`](../scripts/ouro_serve.py) — drop-in **Ollama HTTP API** (`ouro:latest` on `:11434`) |
| **Integration** | transparent: the coder/agent path POSTs to `OLLAMA_BASE_URL` (default `:11434`) — point it at ouro_serve and the whole path uses Ouro |

## Why Ouro for the coder
Ouro builds reasoning into **computation depth** — reusing weight-tied layers R times in
latent space — rather than into token length (the paper's "third scaling axis": loop depth).
For a small local model that's a good trade: spend extra recurrent steps on hard
coding/reasoning turns and exit early on easy ones. The Σ₀ QLoRA tune adapts it to *this*
codebase from past Claude-Code sessions, so it learns the repo's idioms while staying 1.4B
and local.

## The loop mechanism
*(absorbed from the former `OURO-LOOPLM.md`.)*

**Source:** *Scaling Latent Reasoning via Looped Language Models* (Ouro,
[arXiv:2510.25741](https://arxiv.org/abs/2510.25741)). PDF in repo:
[`docs/research-papers/ouro-looped-llm-2510.25741.pdf`](research-papers/ouro-looped-llm-2510.25741.pdf).

### The idea (paper)
LoopLM builds reasoning into computation by **reusing weight-tied layers R times** in latent
space (a "third scaling axis": loop depth). Key mechanisms we borrow:
- **Adaptive depth + learned early-exit (Q-exit):** a gate emits per-step exit probabilities;
  exit at the first step where the cumulative `CDF(t) ≥ q`. `q` trades compute for accuracy.
- **Entropy-regularized depth** (uniform prior) prevents collapse to always-shallow/deep.
- **Deeper-is-better, with diminishing returns** — most inputs converge by mid-depth.

### 1. Native latent loop on real Ouro weights (the real thing)
[`src/sigma0/loop_lm.py`](../src/sigma0/loop_lm.py) — `Sigma0LoopLM` is our implementation of
the paper's **Q-exit adaptive-depth policy** (λ→survival→CDF→first-step-≥q), run on **Ouro's
pretrained weight-tied block + exit gate** (we do **not** pretrain a LoopLM — that needs
7.7T tokens). This activates the adaptive inference the **stock Ouro checkpoint leaves off**:
its `generate()` threads no per-call exit threshold, so it runs **fixed full depth**. Our
module reads the per-step gates, applies Q-exit, and **reports the realized per-token loop
depth** (`mean_depth`); `generate()` returns `exit_reason: "adaptive_qexit"`. Defaults:
`q=0.5`, `max_new_tokens=200`, repetition penalty `1.3`.

- **Probe it:** `python -m sigma0.loop_lm` prints the realized mean depth — adaptive and
  **below** the recurrent step count (`total_ut_steps`), i.e. not fixed-depth. (This probe
  output is **not yet persisted** to an eval artifact, so treat the number as a live
  observation, not a benchmark.)
- **Trained on our data:** QLoRA fine-tune of Ouro-1.4B on the Σ₀ Claude-session set
  ([`scripts/train-qlora-ouro.py`](../scripts/train-qlora-ouro.py)). Adapter loads via
  `Sigma0LoopLM.load(base, adapter=…)`.
- **Convergence-exit (research upgrade, not the served default):** `Sigma0LoopLM.generate()`
  also takes `mode="converge"`, which exits the latent loop on a **fixed point**
  (`‖hₜ − hₜ₋₁‖/‖hₜ₋₁‖ < ε`, `exit_reason: "convergence_exit"`, returns `mean_contraction`)
  rather than on Q-exit confidence — the falsifiable "spiral" experiment (E2). The served deep
  path (`ouro_serve.py`, `OURO_NATIVE=1`) uses the default `mode="qexit"`; convergence-exit is
  not yet wired into serving. See
  [research/2026-06-19-convergence-tesseract-spiral.md](research/2026-06-19-convergence-tesseract-spiral.md).

### 2. API-level re-prompt loop (provider-agnostic approximation)
For any plain (non-looped) local model, we also approximate the loop by re-prompting:

- **[`lib/loop-reasoner.js`](../apps/lantern-garage/lib/loop-reasoner.js)** — `loopedReason()`
  runs the model up to `MAX_LOOPS` (4, = Ouro R4), feeding each prior answer back as a
  Coconut-style context prefix, and **exits via `cdfExit()`**:
  - `threshold_met` — confidence `≥ CDF_THRESHOLD` (0.85)
  - `converged` — `|Δconfidence| < CONVERGENCE_EPS` (0.04), the entropy-plateau analog
    (requires ≥ 2 loops)
  - `max_loops` — compute budget hit

  Confidence is **heuristic** — `extractConfidence()` parses a `Confidence:` field or
  estimates from structure. The module also exports a one-shot `singleReason()`
  (`exit_reason: "single_pass"`) and the three constants; callers may override
  `maxLoops`/`cdfThreshold` per call.
- **Wired into [`lib/stream-chat.js`](../apps/lantern-garage/lib/stream-chat.js)** — for
  `reasoning`/`coding` intents (and only when **not** Keystone-debug, **not** roleplay, and
  no explicit provider was picked), a looped pass runs on the local model and the `done`
  event carries **`loop_n` / `confidence` / `exit_reason`**. The **"Loop Depth (Σ₀)"** panel
  in [`dream-chat.html`](../apps/lantern-garage/public/dream-chat.html) renders them as
  `⟳ N loop(s) · X% conf · <exit_reason>`; the provider dropdown's **"Local Σ₀ Loop (Ouro)"**
  option is the user-facing entry. On error the pass falls through to normal streaming
  (non-fatal).

### Where it maps in the codebase
| Paper concept | Lantern |
|---|---|
| Recurrent steps R | Ouro `total_ut_steps` (native) · `MAX_LOOPS` (re-prompt) |
| Q-exit `CDF(t) ≥ q` | `qexit_step()` in `loop_lm.py` (native) · `cdfExit()` (re-prompt) |
| Realized adaptive depth | `mean_depth` (native) · "Loop Depth (Σ₀)" panel (`loop_n`/`confidence`/`exit_reason`) |
| Deeper-is-better, diminishing | early-exit at the first step with `CDF ≥ q` |
| Knowledge manipulation > capacity | small local model + KB grounding ([CSF spec §2.9](CSF-FORMAT-SPECIFICATION.md)) |

> **Grounding note:** this doc is markdown, indexed by
> [`scripts/build_knowledge_index.py`](../scripts/build_knowledge_index.py) into
> `data/knowledge/index.jsonl`, so the Knowledge Center can ground / near-route on it. A doc
> becomes grounded by being linked from `knowledgecenter.html` (the indexer scrapes
> `/repo/*.md` hrefs). **Re-run the indexer after editing** so the snapshot matches the live
> text.

## How the agent uses it (no code change)
`ouro_serve.py` **speaks the Ollama HTTP API** (`/api/chat`, `/api/generate`, `/api/tags`)
and defaults to port **11434**, advertising the model as `ouro:latest`. The Σ₀ coder/agent
path already calls a local model over exactly that API:
- streaming chat is **Ollama-first** (`OLLAMA_BASE_URL`, default `http://127.0.0.1:11434`);
- the looped re-prompt pass ([`lib/loop-reasoner.js`](../apps/lantern-garage/lib/loop-reasoner.js))
  and the MCP Kernel worker (`task_run` → `/api/dream/chat`) hit the same local endpoint.

So **run `ouro_serve.py` on 11434** and the entire coder/agent path transparently runs on
Ouro — `Observe → Remember → Reason → Act → Verify → Converge` with a looped brain, no code
change. `OURO_MODEL` defaults to `ByteDance/Ouro-1.4B-Thinking`; set `OURO_ADAPTER` for the
Σ₀ tune. (Ouro is a *drop-in*; unlike the old Qwen coder it is **not** yet registered in the
model-broker leaderboard — that's a follow-up.)

## Two inference modes
- **Default — fast cached.** Uses Ouro's `UniversalTransformerCache`; this is the chat/coder
  default (the product gate is speed).
- **Deep — native adaptive Q-exit.** `OURO_NATIVE=1` activates `Sigma0LoopLM`: per-token
  Q-exit (`q` = `OURO_Q`, default 0.5), realized depth reported as `mean_depth`, and
  `exit_reason: "adaptive_qexit"`. It is no-cache (~1 s/token), so it's an opt-in
  "think-harder" mode, not the default. Tunable via `OURO_NATIVE_MAX` (80).

Decode-quality guards apply on both paths to kill small-model degeneration:
`OURO_REP_PENALTY=1.3`, `OURO_NO_REPEAT_NGRAM=3`, greedy by default (`OURO_SAMPLE=1` to
sample); `OURO_UT_STEPS` overrides the recurrent-step count. The API re-prompt loop (§2 above)
is gated separately by `LOOP_REASONER=1`. Ouro's custom modeling code is **tested locally on transformers 4.57.6** (current local `.venv-train`).
`ROPE_INIT_FUNCTIONS['default']` is present in 4.57.6 but was removed in some intermediate 4.5x
builds — the monkey-patch in `train-qlora-ouro.py` handles both cases. `OuroConfig.pad_token_id`
is `None` and must be patched to `bos_token_id` before `from_pretrained`; this is done in the
script. Cloud dispatches (Kaggle) pin `transformers>=4.40,<4.53` to avoid the affected range; the
local env does not need the cap since 4.57.6 has the key restored. No `transformers` entry in
`requirements.txt` (training env only).

## Run it
```bash
# 1. (optional) train the Σ₀ adapter — needs transformers>=4.40 + a CUDA GPU (local: 4.57.6 works)
python scripts/train-qlora-ouro.py --epochs 3

# 2. serve Ouro as a drop-in Ollama model on :11434
#    set OURO_ADAPTER to the adapter dir produced by step 1
OURO_ADAPTER=<adapter_dir> python scripts/ouro_serve.py

# 3. (optional) deep adaptive-depth mode
OURO_NATIVE=1 OURO_ADAPTER=<adapter_dir> python scripts/ouro_serve.py

# 4. probe the realized loop depth directly
python -m sigma0.loop_lm
```
The garage chat path (4177/4178) and the MCP `task_run` worker then use Ouro with no further
config — they already point at `:11434`.

## Continual training
The local adapter improves offline via the **Σ₀ continual-training loop**
([SIGMA0-CONTINUAL-TRAINING.md](SIGMA0-CONTINUAL-TRAINING.md)): harvest → execution-verify →
train → eval → eval-gated promote. Two ground-truth gates (only green subprocesses train;
only a measured pass@1 win promotes), kept offline by design. This replaces the old
`scripts/continual-train.ps1` Qwen flow.

## Where it fits the loop
This is **[06] LANTERN-CODER** realized on a looped model: *Coder = Kernel + Memory + Tools +
"improve the codebase" task type* — a task type, not a separate system. Ouro plugs into
**[02] LANTERN-MODEL-BROKER** as one interchangeable local model; its adaptive depth serves
the **Reason/Act** stages; every turn still emits a PCSF receipt + Convergence Record
(**Verify/Converge**). It is fully in-house and offline — see the
[Σ₀ Briefing](CONVERGANCE-SIGMA0-BRIEFING.md) and the
[Superfleet design](SUPERFLEET-SWARM-DESIGN.md) (workers run this loop on Tasks).

## Honest scope
- **1.4B, single-pass QLoRA** — a genuine fine-tune, not production-grade; quality ratchets
  via continual training.
- **Native loop (§1)** is real adaptive depth on Ouro's weight-tied checkpoint — but
  **inference-time only** (we don't pretrain), and the no-cache Q-exit path is slow
  (~1 s/token), so it's opt-in deep mode; the **default** served path is the fast cached one.
- **Re-prompt loop (§2)** is an **API-level approximation** — it refines by re-prompting a
  standard model, not shared-weight latent loops. Confidence and exit are heuristic.
- **Drop-in, not yet leaderboard-routed** — you select Ouro by serving it on 11434, not via
  the model-broker leaderboard (that integration is a follow-up).
- **Realized-depth / training-loss numbers are not persisted** to eval/log artifacts yet —
  treat `python -m sigma0.loop_lm` / console output as live observations, not benchmarks.

## Training status (2026-06-23)

Cloud GPU dispatch system (`orchestration.html` → `routes/gpu-training.js` → `lib/training-dispatcher.js`)
is wired and tested. Providers are configured via `data/pcsf/gpu-training.pcsf.json`; credentials live in
Windows User-scope env vars and are synced into `process.env` at first call.

| Provider | Status |
|---|---|
| **Kaggle** (T4/P100, 30 h/wk free) | Kernel v7 dispatched ✓ — running with all fixes; poll confirms `status:running` |
| **Lightning AI** (T4 on-demand) | Studio "ouro-training" dispatched ✓ — background run in progress |
| **HuggingFace Hub** (`lanternfounder/ouro-checkpoints`) | ✓ upload + download roundtrip passes |
| **Paperspace** | ⚠ API credentials valid; `GET /v1/notebooks` accessible; `POST /v1/notebooks` returns 500 for all machine types — Gradient notebooks plan may be inactive on this account. Script is correct (fixed bash template + git clone + LFS skip). Needs account upgrade or manual UI dispatch. |
| **Colab / SageMaker** | ✓ smoke-test passes (credentials present; full dispatch untested) |

**Bugs fixed to reach this state (2026-06-22–23):**

| Bug | Fix |
|---|---|
| `KeyError: 'default'` in `ROPE_INIT_FUNCTIONS` (transformers ≥4.53) | Monkey-patch in `train-qlora-ouro.py`; version pin `>=4.40,<4.53` in Kaggle notebook |
| `AttributeError: OuroConfig has no attribute 'pad_token_id'` | Load `AutoConfig` first; set `pad_token_id = bos_token_id`; pass `config=` to both `from_pretrained` calls |
| Kaggle LFS clone failure (LFS budget exceeded) | `GIT_LFS_SKIP_SMUDGE=1` in clone subprocess |
| Kaggle 409 Conflict on kernel push | Fixed `kernel_id` slug in PCSF + title spacing trick to control Kaggle's slugifier |
| `HF_HOME=D:/hf-cache` crashing on Linux/Kaggle | Guarded with `if os.name == "nt"` in script; Kaggle notebook overrides with `/kaggle/working/hf-cache` |
| Lightning "No such file" — bare script name | Use full path `/teamspace/studios/this_studio/ouro_train_lightning.py` |
| Lightning "Studio already running on T4" error | Check `studio.status` before calling `start()`; only call it if not already running |
| Lightning `--checkpoint-uri ""` argparse crash | Only append flag when `checkpointUri` is non-empty |
| Paperspace 404 (domain migration) | `api.paperspace.io` → `api.paperspace.com` in dispatcher + PCSF |

Seq-length note: audited the training corpus p99 at 1219 tokens; bumped to **seq=1536** so the tail of
function-call outputs is no longer truncated. Kaggle T4 (16 GB) fits this without swapping to CPU;
Kaggle P100 also confirmed (same VRAM tier).

## Related
- [SIGMA0-CONTINUAL-TRAINING.md](SIGMA0-CONTINUAL-TRAINING.md) — the offline retrain flywheel that improves this adapter
- [SUPERFLEET-SWARM-DESIGN.md](SUPERFLEET-SWARM-DESIGN.md) — the worker swarm that runs this loop on Tasks
- [CONVERGANCE-SIGMA0-BRIEFING.md](CONVERGANCE-SIGMA0-BRIEFING.md) — the architecture North Star
- [CSF-FORMAT-SPECIFICATION.md](CSF-FORMAT-SPECIFICATION.md) — §2.9 KB grounding index + near routing
- [LANTERN-SIGMA0-CODER.md](LANTERN-SIGMA0-CODER.md) · [OURO-LOOPLM.md](OURO-LOOPLM.md) — the two superseded pages this consolidates (tombstones)
