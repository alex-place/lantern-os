# Keystone-Σ₀ PLT — own-the-model training package

Self-contained code to **own, load, and train** a proprietary Σ₀ coder bootstrapped
from the Apache-2.0 **LoopCoder-V2** Parallel Loop Transformer (arXiv:2510.24824).
Decision record: **[ADR-0011](../../docs/adr/0011-proprietary-sigma0-base-model.md)**
(Proposed). Weight-adjustment policy: **[ADR-0010](../../docs/adr/0010-verify-gated-continual-learning-last-resort.md)**
(adapter-only, frozen base).

This is the package to `git pull` on a GPU box and run.

> **Picking this up? Start with [HANDOFF](../../docs/SIGMA0-PLT-HANDOFF.md)** — current state + the prioritized
> list of what's left (faithful parity, eval vs a frontier coder, the Adaptive Loop Gate).

**No GPU box? Test on Colab:** [![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/alex-place/lantern-os/blob/master/models/keystone-sigma0-plt/colab_parity.ipynb)
— `colab_parity.ipynb` clones this repo and runs the real pipeline (download → patch → parity).
A free T4 gives a 4-bit smoke + HumanEval subset; an L4/A100 gives **bf16** parity (no quant noise)
and the optional faithful vLLM logit check.

---

## ⚠️ Status: forward pass is UNVERIFIED until Stage 0 passes

The upstream repo ships weights + tokenizer but **no modeling code** — its only
inference path is a custom vLLM fork. The modeling code here
(`modeling_keystone_plt.py`) is a **hand port** of that fork's PyTorch
implementation, reconstructed faithfully but **not yet run** (no GPU/weights on
the authoring machine). `check_parity.py` is the gate that proves it before you
spend money training. **Do not train until Stage 0 is `PASS`.**

Confidence today: weights map 1:1 onto the module tree (low risk); three forward
boundaries are reconstructed and need confirming (see *Parity boundaries* below).

## Hardware

| Step | GPU | Notes |
|---|---|---|
| `check_parity.py --dtype 4bit` | ~12–16 GB | 9B @ nf4 + 2-loop activations |
| `check_parity.py --dtype bf16` | ≥24 GB | full precision; truest parity check |
| `train_lora.py` | ≥24 GB | 4-bit base + LoRA + grad-checkpoint |

CUDA GPU required. The 8 GB 3070 is *not* enough for bf16 parity; 4-bit smoke may
fit but is tight — prefer a ≥24 GB card or cloud (L4/A10/A100) for this stage.

## Run it

```bash
cd models/keystone-sigma0-plt

# 0. deps (install torch for YOUR cuda first — see requirements.txt header)
pip install torch --index-url https://download.pytorch.org/whl/cu121
pip install -r requirements.txt

# 1. build the loadable checkpoint (downloads ~18 GB Apache-2.0 weights, one time)
python download_and_patch.py --out ./checkpoint

# 2. STAGE-0 GATE — must pass before training
python check_parity.py --model ./checkpoint --dtype 4bit
#    truest check (needs 24 GB): --dtype bf16
#    faithful parity vs vLLM:     --ref ref_logits.pt   (see below)

# 3. train an adapter (only after Stage 0 PASS)
python train_lora.py --model ./checkpoint --data data/sample_sft.jsonl --out ./adapter
```

## Files

| File | Role |
|---|---|
| `configuration_keystone_plt.py` | `KeystonePLTConfig` — PLT params + `auto_map` we own |
| `modeling_keystone_plt.py` | `KeystonePLTForCausalLM` — the pure-torch PLT forward (the port) |
| `download_and_patch.py` | fetch Apache-2.0 weights, drop our code in, patch `config.json` |
| `check_parity.py` | **Stage-0 gate**: weight-key match + smoke gen + optional vLLM logit parity |
| `train_lora.py` | QLoRA SFT, adapter-only / frozen base (ADR-0010) |
| `data/sample_sft.jsonl` | tiny example dataset (prompt/completion or text) |

Weights are **not** in git (~18 GB) — every box runs `download_and_patch.py`.

## What the architecture is

PLT runs `num_hidden_layers=14` shared layers `plt_num_loops=2` times:

- **Loop 0** — standard causal attention; caches each layer's K/V.
- **Loop 1+** — per-head learned gate mixes **global** (current query vs loop-0's
  cached K/V, full causal) and **local** (current K/V, sliding window 64)
  attention: `out = g·global + (1−g)·local`, `g = sigmoid(Linear(RMSNorm(residual)))`.
- **Cross-loop processing** between loops: `H = 0.707·E + 0.053·H_prev`, then the
  shared `model.norm`.

Only extra params vs Llama: `self_attn.plt_gate` per layer (a `[40,5120]` weight,
`[40]` bias, and a `gate_norm`). Everything else is standard Llama weights, shared
across loops.

## Parity boundaries (confirm with `--ref` before trusting)

If smoke output is garbage or `top1_agree < 0.99`, the cause is almost certainly
one of these three reconstructed details (all isolated + commented in
`modeling_keystone_plt.py`):

1. **CLP shift** — `plt_clp_shift` (default `False`, matches the visible inference
   path). The paper docstring writes `a·E + b·shift(H)`; the vLLM inference code
   shows no shift. Flip to `True` in `config.json` if parity says so.
2. **Sliding-window boundary** — implemented as `0 ≤ t−s < 64` (64 tokens incl.
   self). Off-by-one is the next thing to try (`< 64` vs `≤ 64`).
3. **Per-loop norm placement** — shared `model.norm` after every non-last loop and
   after the last loop.

### Capturing a vLLM reference (optional but definitive)

On a box with the vendor fork (`yxing-bj/vllm`, ≥24 GB), run the model on a fixed
`input_ids`, save `{"input_ids", "logits"}` (last-step logits, `[1,T,V]`) to
`ref_logits.pt`, copy it here, and pass `--ref ref_logits.pt`. `top1_agree ≈ 1.0`
is the proof the port is faithful.

## After Stage 0 passes

Per ADR-0011 the next stages are: measure 4-bit VRAM/speed → serve an
OpenAI/Ollama-compatible endpoint → eval head-to-head vs Qwen2.5-Coder (a win
flips `verified:true` in `apps/lantern-garage/lib/local-model-registry.js`) →
register as a Σ₀ council member → archive base/adapter checkpoints in CSF. None of
those auto-promote the model; each is evidence-gated.
