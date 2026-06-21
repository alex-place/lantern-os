---
title: Σ₀ Serving Performance — Debug, Research, and the First Upgrade
created: 2026-06-21
status: debug findings + shipped upgrade + next-step plan
relates_to:
  - scripts/ouro_serve.py
  - src/sigma0/loop_lm.py
  - scripts/bench_ouro_loop.py
  - docs/SIGMA0-AGENT-PORTFOLIO-UPDATE.md
---

# Σ₀ Serving Performance — Debug, Research, Upgrade

## TL;DR
- **Root cause of the native Q-exit path's ~1 s/token** (and the 170–280 s coding outliers on the leaderboard): it decoded with `use_cache=False`, **re-encoding the entire growing sequence on every token = O(N²)**. The Ouro model natively supports a KV cache; the loop simply opted out.
- **Upgrade shipped (this PR):** wired the model's `UniversalTransformerCache` into `Sigma0LoopLM.generate` for **incremental O(N) decode**, with an `OURO_LOOP_CACHE=0` fallback. Expected: a large speedup that **grows with output length** (coding > chat).
- **Next upgrade (needs GPU validation):** *forward-truncation*. Today the loop runs all R4 recurrent steps and then merely **selects** the Q-exit depth — so adaptive depth saves **zero** compute. Truncating the recurrent loop per token is the second lever.
- **Proven knob:** recurrent depth `OURO_UT_STEPS=3` ≈ **1.28×**. **`torch.compile`** on the weight-tied block is an untapped third lever.

## 1. Debug — where the time actually goes (code-grounded)

**Native Q-exit loop — the O(N²) bug** ([`src/sigma0/loop_lm.py`](../../src/sigma0/loop_lm.py), pre-fix line 190):
```python
_out, hidden_states_list, gate_list = bb.model(input_ids=ids, use_cache=False)
```
`ids` is the full prompt + everything generated so far, re-fed every step with the cache off → each token re-runs all 24 layers × `total_ut_steps` over the whole sequence. Cost per token grows with position ⇒ **O(N²)** decode. This matches the leaderboard, where `ouro-fast-cached` `sec_per_problem` scales with output length (3 → 32 → 68 → 174 → 284 s).

**No forward-truncation** (`modeling_ouro.OuroModel.forward`, the recurrent loop):
```python
for current_ut in range(self.total_ut_steps):   # always runs ALL steps
    ...
    hidden_states_list.append(hidden_states); gate_list.append(self.early_exit_gate(hidden_states))
```
The loop runs every step, then `loop_lm.py` computes Q-exit and **selects** `hidden_states_list[step-1]` — i.e. adaptive depth is **observability only**, not a speedup, today.

**Fast path** (`scripts/ouro_serve.py` default, transformers `generate`): already O(N) via `UniversalTransformerCache` and already has the **merge+SDPA 2.8×** win (65.8 → 23.7 s/prompt, #775) — but it is **fixed R4** (no adaptive savings) and still ~34–68 s per full HumanEval problem.

## 2. Research — the levers, ranked

| Lever | Status | Expected impact | Risk |
|---|---|---|---|
| **KV cache in the native loop** | **shipped (this PR)** | O(N²) → O(N); gap widens with length | Low — model-native, env fallback |
| Recurrent depth `OURO_UT_STEPS=3` | proven ~1.28× | speed ↔ quality knob | quality drop (fewer loop steps) |
| **Forward-truncation** | next (impl + GPU) | up to `R4 / mean_depth` on simple tokens | Medium — reimplement the UT loop |
| `torch.compile` on the block | untapped | compile once, runs R4× per token | Medium — custom `trust_remote_code` |
| 4-bit quant (nf4/AWQ) | untapped | VRAM relief on the 8 GB box | Low |
| KV cache *at chat lengths* | tested neutral | — (matters for long coding outputs) | — |

## 3. Upgrade #1 — incremental KV decode (this PR)

`Sigma0LoopLM.generate` now encodes the prompt once, then forwards **only the new token** each step, reusing the cache the model returns:
```python
_use_cache = os.environ.get("OURO_LOOP_CACHE", "1") == "1"
_past = None; _cur = ids
...
_out, hidden_states_list, gate_list = bb.model(input_ids=_cur, past_key_values=_past, use_cache=True)
_past = _out.past_key_values            # UniversalTransformerCache, auto-created + returned
...
_cur = _nxt_t                           # next pass = only the new token
```
**Why it's correct:** the model auto-creates and returns the cache (`OuroModel.forward:596,661`) and advances `cache_position` off `get_seq_length()`. The existing gate/hidden reads already index `[-1]` (last position), so they're correct whether the pass is the full prompt or a single token. `OURO_LOOP_CACHE=0` restores the legacy path. **No quality change expected** (same tokens, fewer redundant FLOPs).

## 4. Upgrade #2 — forward-truncation (implemented, EXPERIMENTAL)

`Sigma0LoopLM._truncated_forward` replicates `OuroModel.forward` using the model's **own** components (`embed_tokens` / `rotary_emb` / `norm` / `early_exit_gate` / `layers` / `create_causal_mask`) and **breaks the recurrent loop** when the last token's cumulative Q-exit fires. Enable with `OURO_LOOP_TRUNCATE=1` (qexit mode). Simple tokens then cost their realized depth instead of full R4.

### The load-bearing finding: truncation and the KV cache are mutually exclusive
A token that exits at step *k* never writes its step *k+1…R4* KV. Later tokens decoding with the cross-token cache would then attend to **missing** deeper-step keys for that position → an inconsistent cache and corrupted output. This is a fundamental tension, **not** an implementation gap — and it is exactly why vLLM's Ouro integration ships **fixed R4** (drops adaptive exit). So:

| | KV cache (Upgrade #1) | Forward-truncation (Upgrade #2) |
|---|---|---|
| Complexity | **O(N)** | O(N²) (forces no-cache) |
| Depth | fixed R4 | **adaptive per token** |
| Best for | long outputs (coding) | short outputs (chat) |

They're **complementary but currently exclusive** — pick per workload. The real prize (O(N) **and** adaptive) needs a **ragged-depth cache** that tolerates per-position exit depths; that is the deeper research item this PR scopes but does not attempt.

### Why it's correct (and how to confirm)
The full-loop path already *selects* the Q-exit depth, so truncation must yield **byte-identical** output — only faster. `scripts/bench_ouro_loop.py --truncate` runs that **parity check** (full-loop vs truncated). **Parity must be True before enabling `OURO_LOOP_TRUNCATE` in serving** — a False means the forward replica's mask/rotary/position prep is off. I could not run it in-session (GPU crash risk); the replica is faithful to the pinned `modeling_ouro.py` and compiles, but the *parity number* must come from the GPU.

## 5. Validate

Run on the GPU box:
```bash
.venv-train/Scripts/python scripts/bench_ouro_loop.py --tokens 32,128,256 --steps 1,2,3,4
```
**Expected signature:** with `OURO_LOOP_CACHE=on`, tok/s stays roughly flat across output lengths; with `off`, tok/s degrades as length grows — **that widening gap is the O(N²) tax this PR removes.** Acceptance: cache-on materially faster at 256 tokens with **identical argmax tokens** (no quality change), and a clean speed↔depth curve on the `--steps` sweep to pick a default recurrent depth on evidence.
