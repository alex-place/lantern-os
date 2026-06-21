---
author: Alex Place
created: 2026-06-19
updated: 2026-06-20
---

# Σ₀ Ouro Coder — the looped local coding agent

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
our own Σ₀ fine-tune. It runs **fully local**, served as a drop-in Ollama model.

> Two distinct local coders live in the repo. This is the **looped** one. For the
> Qwen-based coder (`lantern-sigma0-coder`, leaderboard-routed), see
> [LANTERN-SIGMA0-CODER.md](LANTERN-SIGMA0-CODER.md). For the loop *mechanism* (the Q-exit
> math + the API re-prompt approximation), see [OURO-LOOPLM.md](OURO-LOOPLM.md).

## What it is
| | |
|---|---|
| **Base model** | `ByteDance/Ouro-1.4B-Thinking` (weight-tied recurrent transformer) |
| **Σ₀ tune** | QLoRA on the Σ₀ Claude-session set ([`scripts/train-qlora-ouro.py`](../scripts/train-qlora-ouro.py); 3 epochs, 4-bit nf4, LoRA r=16/α=32 over `all-linear`) |
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

## How the agent uses it (no code change)
`ouro_serve.py` **speaks the Ollama HTTP API** (`/api/chat`, `/api/generate`, `/api/tags`)
and defaults to port **11434**, advertising the model as `ouro:latest`. The Σ₀ coder/agent
path already calls a local model over exactly that API:
- streaming chat is **Ollama-first** (`OLLAMA_BASE_URL`, default `http://127.0.0.1:11434`);
- the looped re-prompt pass ([`lib/loop-reasoner.js`](../apps/lantern-garage/lib/loop-reasoner.js))
  and the MCP Kernel worker (`task_run` → `/api/dream/chat`) hit the same local endpoint.

So **stop the Ollama binary, run `ouro_serve.py` on 11434**, and the entire coder/agent path
transparently runs on Ouro — `Observe → Remember → Reason → Act → Verify → Converge` with a
looped brain, no code change. (Ouro is a *drop-in*; unlike the Qwen coder it is **not** yet
registered in the model-broker leaderboard — that's a follow-up.)

## Two inference modes
- **Default — fast cached.** Uses Ouro's `UniversalTransformerCache`; this is the chat/coder
  default (the product gate is speed).
- **Deep — native adaptive Q-exit.** `OURO_NATIVE=1` activates `Sigma0LoopLM`: per-token
  Q-exit (`q` = `OURO_Q`, default 0.5), realized depth reported as `mean_depth`, and
  `exit_reason: "adaptive_qexit"`. It is no-cache (~1 s/token), so it's an opt-in
  "think-harder" mode, not the default.

Decode-quality guards apply on both paths to kill small-model degeneration:
`OURO_REP_PENALTY=1.3`, `OURO_NO_REPEAT_NGRAM=3`, greedy by default (`OURO_SAMPLE=1` to
sample); `OURO_UT_STEPS` overrides the recurrent-step count.

## Run it
```bash
# 1. (optional) train the Σ₀ adapter — needs transformers 4.57 + a CUDA GPU
python scripts/train-qlora-ouro.py --epochs 3

# 2. serve Ouro as a drop-in Ollama model on :11434 (stop the Ollama binary first)
#    set OURO_ADAPTER to the adapter dir produced by step 1
OURO_ADAPTER=<adapter_dir> python scripts/ouro_serve.py

# 3. (optional) deep adaptive-depth mode
OURO_NATIVE=1 OURO_ADAPTER=<adapter_dir> python scripts/ouro_serve.py

# 4. probe the realized loop depth directly
python -m sigma0.loop_lm
```
The garage chat path (4177/4178) and the MCP `task_run` worker then use Ouro with no further
config — they already point at `:11434`.

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
- **Drop-in, not yet leaderboard-routed** — you select Ouro by serving it on 11434, not via
  the model-broker leaderboard (that integration is a follow-up).
- **Native loop is slow** (~1 s/token, no-cache) — opt-in deep mode only; the default is the
  fast cached path.
- **Realized-depth / training-loss numbers are not persisted** to eval/log artifacts yet —
  treat `python -m sigma0.loop_lm` / console output as live observations, not benchmarks.

## Related
- [OURO-LOOPLM.md](OURO-LOOPLM.md) — the loop mechanism (Q-exit math, API re-prompt loop)
- [LANTERN-SIGMA0-CODER.md](LANTERN-SIGMA0-CODER.md) — the parallel Qwen-based local coder
- [SUPERFLEET-SWARM-DESIGN.md](SUPERFLEET-SWARM-DESIGN.md) — the worker swarm that runs this loop
- [CONVERGANCE-SIGMA0-BRIEFING.md](CONVERGANCE-SIGMA0-BRIEFING.md) — the architecture North Star
