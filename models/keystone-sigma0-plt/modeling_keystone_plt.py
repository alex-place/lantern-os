"""Keystone-Σ₀ PLT — pure-PyTorch HuggingFace modeling code (STATIC KV-cache decode).

DROP-IN replacement for `modeling_keystone_plt.py` / `modeling_keystone_plt_cached.py`.
Same class names, `__all__`, `model_type="keystone_plt"`, and `auto_map` targets, so
`AutoModelForCausalLM.from_pretrained(..., trust_remote_code=True)` loads unchanged and
the Apache-2.0 checkpoint keys map 1:1.

The full-forward path (no cache) is preserved BIT-EXACT — training / parity depend on it.

────────────────────────────────────────────────────────────────────────────────
WHY STATIC CACHE  (vs the dynamic `cat` cache in modeling_keystone_plt_cached.py)
────────────────────────────────────────────────────────────────────────────────
The dynamic cache `torch.cat`s K/V onto a growing buffer each step, so every
decode step sees a DIFFERENT tensor shape -> `torch.compile` recompiles the graph
every token (so compilation never pays off). A STATIC cache instead:

  * pre-allocates per-layer K/V buffers of shape [B, n_kv_heads, max_seq_len, head_dim],
  * writes the new token's K/V at index `cache_position` (an int -> `index_copy_`),
  * attends the FULL pre-allocated buffer under an ADDITIVE position mask that zeroes
    out slots `> cache_position` (and, for the LOCAL branch, also slots outside the
    sliding window `cache_position - slot < window`).

Because the attended tensors are always `[B, H, max_seq_len, D]` regardless of how
many tokens have been generated, the per-step `decode_step` has CONSTANT shapes and
compiles ONCE. This is the standard HuggingFace `StaticCache` pattern, adapted to PLT's
two attention branches (loop-0 GLOBAL + per-loop windowed LOCAL).

────────────────────────────────────────────────────────────────────────────────
PLT semantics (identical to the verified dynamic path)
────────────────────────────────────────────────────────────────────────────────
Loop 0  : standard causal attention; caches its post-RoPE (k,v) -> the loop-0 buffer.
Loop j>=1: per-head learned gate mixes
            GLOBAL = q @ (loop-0 buffer)        (full causal: slot <= cache_position)
            LOCAL  = q @ (loop-j's own buffer)  (sliding window: 0 <= pos-slot < window)
CLP between loops: hidden = emb_scale*E + hidden_scale*H_prev  (optionally roll(+1)).
Per-loop norm applied at the end of every non-last loop iff `plt_normalize_per_loop`,
and always after the last loop.

Exactness notes carried over from the dynamic cache (the static decode reproduces
them with masks instead of slicing):
  * cached k are POST-RoPE (RoPE applied at each token's own absolute position).
  * the new token's RoPE uses absolute position p == cache_position.
  * the loop-0 buffer MUST include the new token before loop>=1's GLOBAL branch reads
    it; here the loop-0 write happens (across all layers) inside the loop-0 pass, and
    the GLOBAL mask `slot <= p` keeps slot==p, so the current token is attended.
  * the LOCAL window mask `0 <= p - slot < window` reproduces the dynamic `[-window:]`
    slice exactly (post-write the buffer has valid entries 0..p).
"""

from __future__ import annotations

from typing import Optional

import torch
import torch.nn.functional as F
from torch import nn

from transformers.activations import ACT2FN
from transformers.modeling_outputs import CausalLMOutputWithPast
from transformers.modeling_utils import PreTrainedModel
from transformers.utils import logging

try:  # transformers >= 4.50 no longer mixes GenerationMixin into PreTrainedModel
    from transformers.generation import GenerationMixin
except Exception:  # pragma: no cover - very old transformers
    GenerationMixin = object

from configuration_keystone_plt import KeystonePLTConfig


logger = logging.get_logger(__name__)

# Additive-mask "minus infinity". Using a large finite value (not -inf) keeps SDPA's
# softmax numerically safe even for an all-masked row (which never occurs here, since
# the diagonal slot == cache_position is always unmasked).
NEG_INF = torch.finfo(torch.float32).min


# ──────────────────────────────────────────────────────────────────────────────
# Primitives (standard Llama-family: RMSNorm, RoPE, SwiGLU MLP) — IDENTICAL math.
# ──────────────────────────────────────────────────────────────────────────────
class KeystoneRMSNorm(nn.Module):
    def __init__(self, hidden_size: int, eps: float = 1e-5):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(hidden_size))
        self.variance_epsilon = eps

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        input_dtype = x.dtype
        x = x.to(torch.float32)
        var = x.pow(2).mean(-1, keepdim=True)
        x = x * torch.rsqrt(var + self.variance_epsilon)
        return self.weight * x.to(input_dtype)


def _rope_cos_sin(positions: torch.Tensor, head_dim: int, theta: float,
                  dtype: torch.dtype) -> tuple[torch.Tensor, torch.Tensor]:
    """Standard Llama RoPE tables for the given positions. positions: [T]."""
    inv_freq = 1.0 / (theta ** (torch.arange(0, head_dim, 2,
                                             device=positions.device,
                                             dtype=torch.float32) / head_dim))
    freqs = torch.outer(positions.to(torch.float32), inv_freq)  # [T, D/2]
    emb = torch.cat((freqs, freqs), dim=-1)                     # [T, D]
    return emb.cos().to(dtype), emb.sin().to(dtype)


def _rotate_half(x: torch.Tensor) -> torch.Tensor:
    x1, x2 = x[..., : x.shape[-1] // 2], x[..., x.shape[-1] // 2:]
    return torch.cat((-x2, x1), dim=-1)


def _apply_rope(q: torch.Tensor, k: torch.Tensor, cos: torch.Tensor,
                sin: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    # q,k: [B, H, T, D];  cos,sin: [T, D] → broadcast over B,H
    cos = cos[None, None, :, :]
    sin = sin[None, None, :, :]
    q = (q * cos) + (_rotate_half(q) * sin)
    k = (k * cos) + (_rotate_half(k) * sin)
    return q, k


class KeystoneMLP(nn.Module):
    def __init__(self, config: KeystonePLTConfig):
        super().__init__()
        self.gate_proj = nn.Linear(config.hidden_size, config.intermediate_size, bias=config.mlp_bias)
        self.up_proj = nn.Linear(config.hidden_size, config.intermediate_size, bias=config.mlp_bias)
        self.down_proj = nn.Linear(config.intermediate_size, config.hidden_size, bias=config.mlp_bias)
        self.act_fn = ACT2FN[config.hidden_act]

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.down_proj(self.act_fn(self.gate_proj(x)) * self.up_proj(x))


# ──────────────────────────────────────────────────────────────────────────────
# PLT per-head gate — matches checkpoint keys self_attn.plt_gate.{weight,bias,
# gate_norm.weight}. Hidden-states mode (released weights): g = sigmoid(Linear(RMSNorm(residual))).
# ──────────────────────────────────────────────────────────────────────────────
class LoopGateProjection(nn.Module):
    def __init__(self, config: KeystonePLTConfig):
        super().__init__()
        self.use_hidden_states = config.plt_gate_use_hidden_states
        self.num_heads = config.num_attention_heads
        self.head_dim = config.head_dim
        if self.use_hidden_states:
            self.gate_norm = KeystoneRMSNorm(config.hidden_size, eps=config.rms_norm_eps)
            self.weight = nn.Parameter(torch.empty(self.num_heads, config.hidden_size))
        else:
            self.weight = nn.Parameter(torch.empty(self.num_heads, self.head_dim))
        self.bias = nn.Parameter(torch.zeros(self.num_heads))

    def forward(self, residual: torch.Tensor, query: Optional[torch.Tensor] = None) -> torch.Tensor:
        """Return per-head gate g, shape [B, num_heads, T, 1] in [0, 1]."""
        if self.use_hidden_states:
            x = self.gate_norm(residual)                       # [B, T, hidden]
            logits = F.linear(x, self.weight, self.bias)       # [B, T, num_heads]
            g = torch.sigmoid(logits).permute(0, 2, 1)         # [B, num_heads, T]
            return g.unsqueeze(-1)                              # [B, num_heads, T, 1]
        logits = torch.einsum("bhtd,hd->bht", query, self.weight) + self.bias[None, :, None]
        return torch.sigmoid(logits).unsqueeze(-1)             # [B, num_heads, T, 1]


# ──────────────────────────────────────────────────────────────────────────────
# Attention with the PLT loop semantics
# ──────────────────────────────────────────────────────────────────────────────
def _repeat_kv(x: torch.Tensor, n_rep: int) -> torch.Tensor:
    """[B, n_kv, T, D] → [B, n_kv*n_rep, T, D] (GQA expansion)."""
    if n_rep == 1:
        return x
    b, n_kv, t, d = x.shape
    return x[:, :, None, :, :].expand(b, n_kv, n_rep, t, d).reshape(b, n_kv * n_rep, t, d)


class KeystonePLTAttention(nn.Module):
    def __init__(self, config: KeystonePLTConfig, layer_idx: int):
        super().__init__()
        self.layer_idx = layer_idx
        self.hidden_size = config.hidden_size
        self.num_heads = config.num_attention_heads
        self.num_kv_heads = config.num_key_value_heads
        self.head_dim = config.head_dim
        self.n_rep = self.num_heads // self.num_kv_heads
        self.scaling = self.head_dim ** -0.5

        self.q_proj = nn.Linear(self.hidden_size, self.num_heads * self.head_dim, bias=config.attention_bias)
        self.k_proj = nn.Linear(self.hidden_size, self.num_kv_heads * self.head_dim, bias=config.attention_bias)
        self.v_proj = nn.Linear(self.hidden_size, self.num_kv_heads * self.head_dim, bias=config.attention_bias)
        self.o_proj = nn.Linear(self.num_heads * self.head_dim, self.hidden_size, bias=config.attention_bias)
        self.plt_gate = LoopGateProjection(config)

    def _project(self, hidden: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor):
        b, t, _ = hidden.shape
        q = self.q_proj(hidden).view(b, t, self.num_heads, self.head_dim).transpose(1, 2)
        k = self.k_proj(hidden).view(b, t, self.num_kv_heads, self.head_dim).transpose(1, 2)
        v = self.v_proj(hidden).view(b, t, self.num_kv_heads, self.head_dim).transpose(1, 2)
        q, k = _apply_rope(q, k, cos, sin)
        return q, k, v

    def _attend(self, q, k, v, mask):
        # q: [B, Hq, T, D]; k,v: [B, Hkv, S, D]; mask: additive float [B/1, 1, T, S] or None
        k = _repeat_kv(k, self.n_rep)
        v = _repeat_kv(v, self.n_rep)
        out = F.scaled_dot_product_attention(q, k, v, attn_mask=mask, scale=self.scaling)
        return out  # [B, Hq, T, D]

    # ── full-forward (no cache) — preserved BIT-EXACT vs the original modeling. ──
    def forward(self, hidden: torch.Tensor, residual: torch.Tensor, loop_idx: int,
                cos, sin, causal_mask, window_mask, loop0_kv):
        b, t, _ = hidden.shape
        q, k, v = self._project(hidden, cos, sin)

        if loop_idx == 0:
            out = self._attend(q, k, v, causal_mask)            # standard causal
            out = out.transpose(1, 2).reshape(b, t, -1)
            return self.o_proj(out), (k, v)                     # cache loop-0 K/V

        k0, v0 = loop0_kv
        global_out = self._attend(q, k0, v0, causal_mask)       # [B, Hq, T, D]
        local_out = self._attend(q, k, v, window_mask)          # [B, Hq, T, D]
        gate = self.plt_gate(residual, query=q)                 # [B, Hq, T, 1]
        mixed = global_out * gate + local_out * (1.0 - gate)
        mixed = mixed.transpose(1, 2).reshape(b, t, -1)
        return self.o_proj(mixed), (k, v)

    # ── STATIC single-token decode (batch=1, fixed shapes). ─────────────────────
    def step_static(self, hidden, residual, loop_idx, cos, sin, cache, i,
                    global_mask, local_mask, cache_position):
        """One new-token step against PRE-ALLOCATED `cache` buffers.

        hidden, residual: [1, 1, H]; cos,sin: [1, D] (RoPE @ absolute pos == cache_position).
        cache : a `StaticPLTCache`; `i` is this layer's index. The new (k,v) is WRITTEN
                into the cache here (index_copy_ at slot `cache_position`) BEFORE the
                attention reads it, so:
                  * loop 0 attends its own loop-0 buffer (now incl. the new token);
                  * loop j>=1 attends the loop-0 buffer (already holds the new token
                    from the loop-0 pass) GLOBALLY and this loop's own buffer LOCALLY.
        global_mask: additive float [1, 1, 1, max_seq_len], slots > cache_position == NEG_INF.
        local_mask : additive float [1, 1, 1, max_seq_len], slots > cache_position OR
                     outside the sliding window == NEG_INF.
        Returns attn_out [1,1,H].

        Fixed shapes throughout: q is [1,Hq,1,D]; the attended K/V are the FULL
        [1,Hkv,max_seq_len,D] buffers; masks are [1,1,1,max_seq_len]. The `loop_idx`
        / `i` python ints are loop-unrolled constants (not tensor values), so there is
        no data-dependent control flow and no dynamic slicing -> torch.compile-safe.
        """
        q, k, v = self._project(hidden, cos, sin)               # q:[1,Hq,1,D]; k,v:[1,Hkv,1,D]

        if loop_idx == 0:
            # write loop-0's new (k,v) FIRST, then attend the full buffer.
            cache.write_loop0(i, cache_position, k, v)
            out = self._attend(q, cache.loop0_k[i], cache.loop0_v[i], global_mask)
            out = out.transpose(1, 2).reshape(1, 1, -1)
            return self.o_proj(out)

        # loop j>=1: write THIS loop's new (k,v) into its own buffer, then mix
        # GLOBAL (loop-0 buffer) + LOCAL (this loop's windowed buffer).
        cache.write_local(i, loop_idx, cache_position, k, v)
        global_out = self._attend(q, cache.loop0_k[i], cache.loop0_v[i], global_mask)
        local_out = self._attend(q, cache.local_k[i][loop_idx],
                                 cache.local_v[i][loop_idx], local_mask)
        gate = self.plt_gate(residual, query=q)                      # [1,Hq,1,1]
        mixed = global_out * gate + local_out * (1.0 - gate)
        mixed = mixed.transpose(1, 2).reshape(1, 1, -1)
        return self.o_proj(mixed)


class KeystonePLTDecoderLayer(nn.Module):
    def __init__(self, config: KeystonePLTConfig, layer_idx: int):
        super().__init__()
        self.self_attn = KeystonePLTAttention(config, layer_idx)
        self.mlp = KeystoneMLP(config)
        self.input_layernorm = KeystoneRMSNorm(config.hidden_size, eps=config.rms_norm_eps)
        self.post_attention_layernorm = KeystoneRMSNorm(config.hidden_size, eps=config.rms_norm_eps)

    def forward(self, hidden, loop_idx, cos, sin, causal_mask, window_mask, loop0_kv):
        residual = hidden                                       # pre-norm = gate input
        x = self.input_layernorm(hidden)
        attn_out, kv = self.self_attn(x, residual, loop_idx, cos, sin,
                                      causal_mask, window_mask, loop0_kv)
        hidden = attn_out + residual
        residual = hidden
        x = self.post_attention_layernorm(hidden)
        hidden = self.mlp(x) + residual
        return hidden, kv

    # ── STATIC single-token decode ─────────────────────────────────────────────
    def step_static(self, hidden, loop_idx, cos, sin, cache, i,
                    global_mask, local_mask, cache_position):
        residual = hidden                                       # pre-norm = gate input
        x = self.input_layernorm(hidden)
        attn_out = self.self_attn.step_static(
            x, residual, loop_idx, cos, sin, cache, i,
            global_mask, local_mask, cache_position)
        hidden = attn_out + residual
        residual = hidden
        x = self.post_attention_layernorm(hidden)
        hidden = self.mlp(x) + residual
        return hidden


# ──────────────────────────────────────────────────────────────────────────────
# Masks (full-forward path — unchanged)
# ──────────────────────────────────────────────────────────────────────────────
def _causal_mask(t: int, device, pad: Optional[torch.Tensor]) -> torch.Tensor:
    m = torch.tril(torch.ones(t, t, dtype=torch.bool, device=device))  # [T,T]
    m = m[None, None]                                                  # [1,1,T,T]
    if pad is not None:
        m = m & pad[:, None, None, :].to(torch.bool)                  # & key padding
    return m


def _sliding_window_mask(t: int, window: int, device, pad: Optional[torch.Tensor]) -> torch.Tensor:
    idx = torch.arange(t, device=device)
    delta = idx[:, None] - idx[None, :]                               # [T,T]
    m = (delta >= 0) & (delta < window)
    m = m[None, None]
    if pad is not None:
        m = m & pad[:, None, None, :].to(torch.bool)
    return m


# ──────────────────────────────────────────────────────────────────────────────
# STATIC PLT cache — pre-allocated per-layer buffers (batch=1).
# ──────────────────────────────────────────────────────────────────────────────
class StaticPLTCache:
    """Pre-allocated, fixed-shape post-RoPE (k,v) buffers for batch=1 PLT decode.

    Per layer:
      * loop0_k / loop0_v — [1, Hkv, max_seq_len, D] : loop-0's FULL (k,v); the GLOBAL
        source for every loop >= 1.
      * local_k[j] / local_v[j] for j in 1..num_loops-1 — [1, Hkv, max_seq_len, D] :
        loop-j's own (k,v) for the windowed LOCAL branch.

    A new token at absolute position p is written with `index_copy_` at slot p; the
    decode then attends the WHOLE buffer under an additive mask that zeroes slots > p
    (GLOBAL) or slots outside `0 <= p - slot < window` (LOCAL). Because the attended
    tensors keep shape [1, Hkv, max_seq_len, D] forever, the decode step compiles once.

    `prev_loop_hidden[j]` retains the loop-(j-1) output at position p-1 so the
    `plt_clp_shift` parity knob reproduces `roll(H_prev, +1)` incrementally (scalar
    state — does not change shapes).

    NOT a transformers `Cache` subclass (works across versions). `fill_from_full_cache`
    seeds these buffers from a prefill pass.
    """

    def __init__(self, num_layers: int, num_loops: int, num_kv_heads: int,
                 head_dim: int, window: int, max_seq_len: int,
                 device=None, dtype=torch.float32):
        self.num_layers = num_layers
        self.num_loops = num_loops
        self.num_kv_heads = num_kv_heads
        self.head_dim = head_dim
        self.window = int(window)
        self.max_seq_len = int(max_seq_len)
        self.device = device
        self.dtype = dtype

        shape = (1, num_kv_heads, self.max_seq_len, head_dim)
        # loop-0 full buffer per layer
        self.loop0_k = [torch.zeros(shape, device=device, dtype=dtype) for _ in range(num_layers)]
        self.loop0_v = [torch.zeros(shape, device=device, dtype=dtype) for _ in range(num_layers)]
        # one local buffer per loop index 1..num_loops-1 (index 0 unused / placeholder)
        self.local_k = [
            [None] + [torch.zeros(shape, device=device, dtype=dtype) for _ in range(1, num_loops)]
            for _ in range(num_layers)
        ]
        self.local_v = [
            [None] + [torch.zeros(shape, device=device, dtype=dtype) for _ in range(1, num_loops)]
            for _ in range(num_layers)
        ]
        # clp_shift bookkeeping: previous position's loop-(j-1) output per loop>=1.
        self.prev_loop_hidden = [None] * num_loops
        self._seq_len = 0

    def get_seq_length(self, layer_idx: int = 0) -> int:
        return self._seq_len

    # ── single-slot writes at absolute position `pos` (index_copy_ keeps shape) ──
    def write_loop0(self, i: int, pos: torch.Tensor, k, v):
        # k,v: [1, Hkv, 1, D]; pos: 0-d long tensor (the slot index).
        self.loop0_k[i].index_copy_(2, pos, k)
        self.loop0_v[i].index_copy_(2, pos, v)

    def write_local(self, i: int, loop_idx: int, pos: torch.Tensor, k, v):
        self.local_k[i][loop_idx].index_copy_(2, pos, k)
        self.local_v[i][loop_idx].index_copy_(2, pos, v)

    def fill_from_full_cache(self, full):
        """Seed the static buffers from a prefill (a `_PrefillCapture`). Copies the
        first `T` slots; the rest stay zero (masked out anyway)."""
        t = full.seq_len
        for i in range(self.num_layers):
            self.loop0_k[i][:, :, :t, :].copy_(full.loop0[i]["k"])
            self.loop0_v[i][:, :, :t, :].copy_(full.loop0[i]["v"])
            for j in range(1, self.num_loops):
                lk = full.local[i][j]["k"]
                lv = full.local[i][j]["v"]
                if lk is not None:
                    self.local_k[i][j][:, :, :t, :].copy_(lk)
                    self.local_v[i][j][:, :, :t, :].copy_(lv)
        self.prev_loop_hidden = list(full.prev_loop_hidden)
        self._seq_len = t


class _PrefillCapture:
    """Transient capture object used ONLY during the prefill full-forward to harvest
    per-layer loop-0 + per-loop (k,v) and the clp-shift snapshots. Shapes here are the
    prompt length T (variable), but this runs ONCE, not per decode step."""

    def __init__(self, num_layers: int, num_loops: int):
        self.num_layers = num_layers
        self.num_loops = num_loops
        self.loop0 = [{"k": None, "v": None} for _ in range(num_layers)]
        self.local = [
            [None] + [{"k": None, "v": None} for _ in range(1, num_loops)]
            for _ in range(num_layers)
        ]
        self.prev_loop_hidden = [None] * num_loops
        self.seq_len = 0


# ──────────────────────────────────────────────────────────────────────────────
# Base + CausalLM
# ──────────────────────────────────────────────────────────────────────────────
class KeystonePLTPreTrainedModel(PreTrainedModel):
    config_class = KeystonePLTConfig
    base_model_prefix = "model"
    supports_gradient_checkpointing = True
    _no_split_modules = ["KeystonePLTDecoderLayer"]
    _supports_sdpa = True

    def _init_weights(self, module):
        std = self.config.initializer_range
        if isinstance(module, nn.Linear):
            module.weight.data.normal_(mean=0.0, std=std)
            if module.bias is not None:
                module.bias.data.zero_()
        elif isinstance(module, nn.Embedding):
            module.weight.data.normal_(mean=0.0, std=std)
        elif isinstance(module, LoopGateProjection):
            module.weight.data.normal_(mean=0.0, std=std)
            module.bias.data.zero_()


class KeystonePLTModel(KeystonePLTPreTrainedModel):
    def __init__(self, config: KeystonePLTConfig):
        super().__init__(config)
        self.embed_tokens = nn.Embedding(config.vocab_size, config.hidden_size, config.pad_token_id)
        self.layers = nn.ModuleList(
            [KeystonePLTDecoderLayer(config, i) for i in range(config.num_hidden_layers)]
        )
        self.norm = KeystoneRMSNorm(config.hidden_size, eps=config.rms_norm_eps)
        self.gradient_checkpointing = False
        self.post_init()

    def get_input_embeddings(self):
        return self.embed_tokens

    def set_input_embeddings(self, value):
        self.embed_tokens = value

    # ── original full forward — kept BIT-EXACT. `capture` (a _PrefillCapture) is an
    #    additive, opt-in side channel; it does NOT alter any math when None. ──────
    def forward(self, input_ids=None, attention_mask=None, inputs_embeds=None,
                capture: Optional["_PrefillCapture"] = None, **kw):
        cfg = self.config
        if inputs_embeds is None:
            inputs_embeds = self.embed_tokens(input_ids)
        E = inputs_embeds                                        # [B, T, H]
        b, t, _ = E.shape
        device = E.device

        positions = torch.arange(t, device=device)
        cos, sin = _rope_cos_sin(positions, cfg.head_dim, cfg.rope_theta, E.dtype)

        pad = attention_mask if attention_mask is not None else None
        window = int(cfg.plt_window_size[0]) if cfg.plt_window_size else 64
        causal_mask = _causal_mask(t, device, pad)
        window_mask = _sliding_window_mask(t, window, device, pad)

        emb_scale = 1.0 if cfg.plt_emb_scale is None else cfg.plt_emb_scale
        hidden_scale = 1.0 if cfg.plt_hidden_scale is None else cfg.plt_hidden_scale

        hidden = E
        loop0_kv = [None] * len(self.layers)
        for loop_idx in range(cfg.plt_num_loops):
            if loop_idx > 0:
                if capture is not None:
                    capture.prev_loop_hidden[loop_idx] = hidden[:, -1:, :].clone()
                h_prev = hidden
                if cfg.plt_clp_shift:                            # parity knob (default off)
                    h_prev = torch.roll(h_prev, shifts=1, dims=1)
                    h_prev[:, 0, :] = 0.0
                hidden = emb_scale * E + hidden_scale * h_prev   # cross-loop processing

            for i, layer in enumerate(self.layers):
                if self.gradient_checkpointing and self.training:
                    hidden, kv = torch.utils.checkpoint.checkpoint(
                        layer, hidden, loop_idx, cos, sin, causal_mask, window_mask,
                        loop0_kv[i], use_reentrant=False)
                else:
                    hidden, kv = layer(hidden, loop_idx, cos, sin, causal_mask,
                                       window_mask, loop0_kv[i])
                if loop_idx == 0:
                    loop0_kv[i] = kv
                    if capture is not None:
                        capture.loop0[i]["k"] = kv[0]
                        capture.loop0[i]["v"] = kv[1]
                elif capture is not None and kv is not None:
                    capture.local[i][loop_idx]["k"] = kv[0]
                    capture.local[i][loop_idx]["v"] = kv[1]

            last = loop_idx == cfg.plt_num_loops - 1
            if (not last and cfg.plt_normalize_per_loop) or last:
                hidden = self.norm(hidden)

        if capture is not None:
            capture.seq_len = t
        return hidden

    # ── STATIC single-token decode (batch=1, FIXED shapes — torch.compile-safe) ──
    def decode_step_static(self, token_id: torch.Tensor, cache_position: torch.Tensor,
                           cache: "StaticPLTCache"):
        """Run all loops for ONE new token at absolute position `cache_position`
        (a 0-d long tensor), writing into the PRE-ALLOCATED `cache` buffers in place.
        Returns the final post-norm hidden state [1, 1, H].

        Designed for `torch.compile`: q is [1,Hq,1,D]; attended K/V are the full
        [1,Hkv,max_seq_len,D] buffers; masks are [1,1,1,max_seq_len] built from a
        position arange compared to `cache_position` (a tensor). No python branch on
        a tensor value, no shape-changing slice."""
        cfg = self.config
        E_p = self.embed_tokens(token_id)                        # [1, 1, H]
        device = E_p.device
        window = int(cfg.plt_window_size[0]) if cfg.plt_window_size else 64

        # RoPE @ absolute position == cache_position.
        cos, sin = _rope_cos_sin(cache_position.reshape(1), cfg.head_dim,
                                 cfg.rope_theta, E_p.dtype)        # [1, D] each

        # ── Position-dependent additive masks over the FULL buffer (constant shape). ─
        slots = torch.arange(cache.max_seq_len, device=device)    # [max_seq_len]
        delta = cache_position - slots                            # [max_seq_len]
        # GLOBAL (loop-0 / causal): keep slot <= p  ⇔  delta >= 0.
        keep_global = delta >= 0
        # LOCAL (sliding window): keep 0 <= delta < window. window<=0 ⇒ unbounded (== global).
        if window and window > 0:
            keep_local = (delta >= 0) & (delta < window)
        else:
            keep_local = keep_global
        global_mask = torch.where(keep_global, 0.0, NEG_INF).to(E_p.dtype)
        local_mask = torch.where(keep_local, 0.0, NEG_INF).to(E_p.dtype)
        global_mask = global_mask.view(1, 1, 1, cache.max_seq_len)
        local_mask = local_mask.view(1, 1, 1, cache.max_seq_len)

        emb_scale = 1.0 if cfg.plt_emb_scale is None else cfg.plt_emb_scale
        hidden_scale = 1.0 if cfg.plt_hidden_scale is None else cfg.plt_hidden_scale

        cur_loop_hidden = [None] * cfg.plt_num_loops

        hidden = E_p
        for loop_idx in range(cfg.plt_num_loops):
            if loop_idx > 0:
                if cfg.plt_clp_shift:
                    prev = cache.prev_loop_hidden[loop_idx]
                    # roll(H_prev,+1)[p] = loop-(loop_idx-1) output @ p-1; zero at p==0.
                    h_prev = torch.zeros_like(E_p) if prev is None else prev
                else:
                    h_prev = hidden                              # previous loop output @ p
                hidden = emb_scale * E_p + hidden_scale * h_prev

            for i, layer in enumerate(self.layers):
                # step_static projects, WRITES the new (k,v) into the cache at slot
                # `cache_position`, then attends the full masked buffer(s). Loop-0's
                # write-before-read ordering (so the current token is visible to itself
                # and to every loop>=1 under the slot<=p mask) is handled inside it.
                hidden = layer.step_static(hidden, loop_idx, cos, sin, cache, i,
                                           global_mask, local_mask, cache_position)

            last = loop_idx == cfg.plt_num_loops - 1
            if (not last and cfg.plt_normalize_per_loop) or last:
                hidden = self.norm(hidden)

            cur_loop_hidden[loop_idx] = hidden

        if cfg.plt_clp_shift:
            for j in range(1, cfg.plt_num_loops):
                cache.prev_loop_hidden[j] = cur_loop_hidden[j - 1]

        # NOTE: length bookkeeping (`cache._seq_len = position + 1`) is intentionally
        # NOT done here. Calling `int(cache_position)` would force a `Tensor.item()`
        # graph break under torch.compile. The generation loop advances `_seq_len`
        # from a python int instead, keeping this method a single clean graph.
        return hidden


class KeystonePLTForCausalLM(KeystonePLTPreTrainedModel, GenerationMixin):
    _tied_weights_keys = ["lm_head.weight"]

    def __init__(self, config: KeystonePLTConfig):
        super().__init__(config)
        self.model = KeystonePLTModel(config)
        self.lm_head = nn.Linear(config.hidden_size, config.vocab_size, bias=False)
        self.post_init()

    def get_input_embeddings(self):
        return self.model.embed_tokens

    def set_input_embeddings(self, value):
        self.model.embed_tokens = value

    def get_output_embeddings(self):
        return self.lm_head

    def set_decoder(self, decoder):
        self.model = decoder

    def get_decoder(self):
        return self.model

    def forward(self, input_ids=None, attention_mask=None, inputs_embeds=None,
                labels=None, past_key_values=None, use_cache=None, **kw):
        hidden = self.model(input_ids=input_ids, attention_mask=attention_mask,
                            inputs_embeds=inputs_embeds)
        logits = self.lm_head(hidden).float()

        loss = None
        if labels is not None:
            shift_logits = logits[:, :-1, :].contiguous()
            shift_labels = labels[:, 1:].contiguous()
            loss = F.cross_entropy(
                shift_logits.view(-1, shift_logits.size(-1)),
                shift_labels.view(-1).to(shift_logits.device),
                ignore_index=-100,
            )

        return CausalLMOutputWithPast(loss=loss, logits=logits)

    # ──────────────────────────────────────────────────────────────────────────
    # DYNAMIC KV-cached greedy decode (kept available; see modeling_..._cached.py
    # for the documented version). This is the O(n) `cat` cache.
    # ──────────────────────────────────────────────────────────────────────────
    @torch.no_grad()
    def fast_generate(self, input_ids: torch.Tensor, max_new_tokens: int,
                      eos_token_id=None) -> torch.Tensor:
        """Greedy, batch=1, DYNAMIC KV cache. Token-identical to full-recompute greedy.

        input_ids: [1, T] prompt. Returns [1, T + n] including the prompt."""
        assert input_ids.dim() == 2 and input_ids.shape[0] == 1, "batch=1 only"
        self.eval()
        device = input_ids.device

        eos_set = set()
        if eos_token_id is not None:
            eos_set = {int(eos_token_id)} if isinstance(eos_token_id, int) else set(int(e) for e in eos_token_id)

        cfg = self.config
        # Dynamic decode reuses the static cache buffers sized to T+max_new, but
        # writes/reads only valid slots via masks — semantically identical to `cat`.
        # (We route the dynamic path through the same static buffers to avoid keeping
        # a second cache class here; the math is the masked-full-buffer attention.)
        max_seq_len = input_ids.shape[-1] + max_new_tokens + 1
        return self._generate_with_static_cache(input_ids, max_new_tokens, eos_set,
                                                 max_seq_len, compiled_step=None)

    # ──────────────────────────────────────────────────────────────────────────
    # PRIMARY DELIVERABLE: exact STATIC-cache greedy decode (torch.compile-ready).
    # ──────────────────────────────────────────────────────────────────────────
    @torch.no_grad()
    def fast_generate_static(self, input_ids: torch.Tensor, max_new_tokens: int,
                             eos_token_id=None, max_seq_len: Optional[int] = None,
                             compiled_step=None) -> torch.Tensor:
        """Greedy, batch=1, STATIC pre-allocated KV cache. Token-identical to
        full-recompute greedy and to the dynamic `fast_generate`.

        input_ids: [1, T] prompt. Returns [1, T + n] including the prompt.
        max_seq_len: pre-allocated buffer length (default T + max_new_tokens + 1).
        compiled_step: optional callable wrapping `model.decode_step_static`
            (e.g. a `torch.compile`d version) — used to verify compiled identity.
        """
        assert input_ids.dim() == 2 and input_ids.shape[0] == 1, "batch=1 only"
        self.eval()
        device = input_ids.device

        eos_set = set()
        if eos_token_id is not None:
            eos_set = {int(eos_token_id)} if isinstance(eos_token_id, int) else set(int(e) for e in eos_token_id)

        if max_seq_len is None:
            max_seq_len = input_ids.shape[-1] + max_new_tokens + 1
        return self._generate_with_static_cache(input_ids, max_new_tokens, eos_set,
                                                 max_seq_len, compiled_step=compiled_step)

    @torch.no_grad()
    def _generate_with_static_cache(self, input_ids, max_new_tokens, eos_set,
                                    max_seq_len, compiled_step=None):
        cfg = self.config
        device = input_ids.device
        dtype = self.lm_head.weight.dtype
        window = int(cfg.plt_window_size[0]) if cfg.plt_window_size else 64

        cache = StaticPLTCache(
            num_layers=cfg.num_hidden_layers, num_loops=cfg.plt_num_loops,
            num_kv_heads=cfg.num_key_value_heads, head_dim=cfg.head_dim,
            window=window, max_seq_len=max_seq_len, device=device, dtype=dtype)

        # ── Prefill: full forward over the whole prompt, capturing per-loop (k,v);
        #    seed the static buffers; take last-token logits. ───────────────────────
        prefill = _PrefillCapture(cfg.num_hidden_layers, cfg.plt_num_loops)
        hidden = self.model(input_ids=input_ids, capture=prefill)
        cache.fill_from_full_cache(prefill)
        last_logits = self.lm_head(hidden[:, -1:, :]).float()
        next_tok = int(last_logits[0, -1].argmax())

        generated = [next_tok]
        if next_tok in eos_set:
            tok = torch.tensor([[next_tok]], device=device, dtype=input_ids.dtype)
            return torch.cat([input_ids, tok], dim=1)

        step_fn = compiled_step if compiled_step is not None else self.model.decode_step_static

        for _ in range(max_new_tokens - 1):
            position = cache.get_seq_length()                    # absolute pos of new token
            tok = torch.tensor([[next_tok]], device=device, dtype=input_ids.dtype)
            cache_position = torch.tensor(position, device=device, dtype=torch.long)
            hidden = step_fn(tok, cache_position, cache)
            # decode_step_static updates cache._seq_len when called directly; a compiled
            # wrapper may not run that python side-effect, so set it explicitly here.
            cache._seq_len = position + 1
            logits = self.lm_head(hidden).float()
            next_tok = int(logits[0, -1].argmax())
            generated.append(next_tok)
            if next_tok in eos_set:
                break

        gen = torch.tensor([generated], device=device, dtype=input_ids.dtype)
        return torch.cat([input_ids, gen], dim=1)

    # ── HF generate integration: serve single-sequence greedy from the static path. ─
    def generate(self, inputs=None, generation_config=None, **kwargs):
        input_ids = inputs if inputs is not None else kwargs.get("input_ids")
        do_sample = kwargs.get("do_sample", None)
        num_beams = kwargs.get("num_beams", 1)
        use_cache = kwargs.get("use_cache", True)
        if generation_config is not None:
            if do_sample is None:
                do_sample = getattr(generation_config, "do_sample", False)
            num_beams = getattr(generation_config, "num_beams", num_beams)
        do_sample = bool(do_sample)

        greedy_single = (
            input_ids is not None
            and isinstance(input_ids, torch.Tensor)
            and input_ids.dim() == 2
            and input_ids.shape[0] == 1
            and not do_sample
            and num_beams == 1
            and use_cache is not False
        )
        if greedy_single:
            max_new = kwargs.get("max_new_tokens", None)
            if max_new is None and generation_config is not None:
                max_new = getattr(generation_config, "max_new_tokens", None)
            if max_new is None:
                max_len = kwargs.get("max_length", None)
                if max_len is not None:
                    max_new = int(max_len) - input_ids.shape[-1]
            if max_new is None:
                max_new = 20
            eos = kwargs.get("eos_token_id", None)
            if eos is None:
                eos = getattr(self.config, "eos_token_id", None)
            return self.fast_generate_static(input_ids, max_new_tokens=int(max_new),
                                             eos_token_id=eos)
        return super().generate(inputs=inputs, generation_config=generation_config,
                                **kwargs)

    def prepare_inputs_for_generation(self, input_ids, past_key_values=None,
                                      attention_mask=None, use_cache=None, **kw):
        return {"input_ids": input_ids, "attention_mask": attention_mask,
                "use_cache": use_cache, "past_key_values": past_key_values}

    def _reorder_cache(self, past_key_values, beam_idx):
        return past_key_values


__all__ = ["KeystonePLTConfig", "KeystonePLTModel", "KeystonePLTForCausalLM"]
