"""Keystone-Σ₀ PLT — pure-PyTorch HuggingFace modeling code.

A self-contained, training-ready re-implementation of the Parallel Loop
Transformer (PLT) used by LoopCoder-V2 (Apache-2.0). It is ported faithfully from
the upstream vLLM reference (`yxing-bj/vllm:vllm/model_executor/models/
iquest_loopcoder.py`) and the published config, but depends ONLY on `torch` +
`transformers` — no vLLM, no custom CUDA — so the model loads with
`AutoModelForCausalLM.from_pretrained(..., trust_remote_code=True)` and trains
with `peft`/`Trainer`.

Why this exists: the upstream HF repo ships weights + config + tokenizer but no
modeling code; its only inference path is a custom vLLM fork that needs ≥24 GB
and cannot be evolved. Owning this forward pass is the prerequisite for adjusting
the weights (ADR-0011 / ADR-0010).

WEIGHT COMPATIBILITY — the checkpoint keys map 1:1 onto this module tree, so the
Apache-2.0 weights load with NO renaming:
    model.embed_tokens.weight
    model.layers.{i}.input_layernorm.weight
    model.layers.{i}.post_attention_layernorm.weight
    model.layers.{i}.self_attn.{q,k,v,o}_proj.weight
    model.layers.{i}.self_attn.plt_gate.weight          # [num_heads, hidden]
    model.layers.{i}.self_attn.plt_gate.bias            # [num_heads]
    model.layers.{i}.self_attn.plt_gate.gate_norm.weight
    model.layers.{i}.mlp.{gate,up,down}_proj.weight
    model.norm.weight
    lm_head.weight

PARITY — three boundaries are reconstructed from the reference and should be
confirmed by check_parity.py against vLLM-fork logits before training:
  (1) CLP shift: OFF by default (matches the visible inference path); config
      `plt_clp_shift` flips it.
  (2) sliding-window boundary: a token attends s in (t-W, t]  (W=64 tokens incl.
      self). See `_sliding_window_mask`.
  (3) per-loop norm placement: shared `model.norm` after every non-last loop and
      after the last loop (matches the reference forward).
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

from configuration_keystone_plt import KeystonePLTConfig


logger = logging.get_logger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Primitives (standard Llama-family: RMSNorm, RoPE, SwiGLU MLP)
# ──────────────────────────────────────────────────────────────────────────────
class KeystoneRMSNorm(nn.Module):
    def __init__(self, hidden_size: int, eps: float = 1e-5):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(hidden_size))
        self.variance_epsilon = eps

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # canonical Llama RMSNorm: variance in fp32, cast back, then scale.
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
# gate_norm.weight}. Hidden-states mode (the released weights): per head,
# g = sigmoid(Linear(RMSNorm(residual))).
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
            # query-based mode: gate from the post-RoPE query (per head)
            self.weight = nn.Parameter(torch.empty(self.num_heads, self.head_dim))
        self.bias = nn.Parameter(torch.zeros(self.num_heads))

    def forward(self, residual: torch.Tensor, query: Optional[torch.Tensor] = None) -> torch.Tensor:
        """Return per-head gate g, shape [B, num_heads, T, 1] in [0, 1]."""
        if self.use_hidden_states:
            x = self.gate_norm(residual)                       # [B, T, hidden]
            logits = F.linear(x, self.weight, self.bias)       # [B, T, num_heads]
            g = torch.sigmoid(logits).permute(0, 2, 1)         # [B, num_heads, T]
            return g.unsqueeze(-1)                              # [B, num_heads, T, 1]
        # query-based: einsum('bhtd,hd->bht', q, W) + b
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
        # q: [B, Hq, T, D]; k,v: [B, Hkv, T, D]; mask: [B,1,T,T] bool (True=keep)
        k = _repeat_kv(k, self.n_rep)
        v = _repeat_kv(v, self.n_rep)
        out = F.scaled_dot_product_attention(q, k, v, attn_mask=mask, scale=self.scaling)
        return out  # [B, Hq, T, D]

    def forward(self, hidden: torch.Tensor, residual: torch.Tensor, loop_idx: int,
                cos, sin, causal_mask, window_mask, loop0_kv):
        b, t, _ = hidden.shape
        q, k, v = self._project(hidden, cos, sin)

        if loop_idx == 0:
            out = self._attend(q, k, v, causal_mask)            # standard causal
            out = out.transpose(1, 2).reshape(b, t, -1)
            return self.o_proj(out), (k, v)                     # cache loop-0 K/V

        # loop 1+: gated mix of GLOBAL (q vs loop-0 K/V, full causal) and
        # LOCAL (q vs current K/V, sliding window).
        k0, v0 = loop0_kv
        global_out = self._attend(q, k0, v0, causal_mask)       # [B, Hq, T, D]
        local_out = self._attend(q, k, v, window_mask)          # [B, Hq, T, D]
        gate = self.plt_gate(residual, query=q)                 # [B, Hq, T, 1]
        mixed = global_out * gate + local_out * (1.0 - gate)
        mixed = mixed.transpose(1, 2).reshape(b, t, -1)
        return self.o_proj(mixed), None


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


# ──────────────────────────────────────────────────────────────────────────────
# Masks
# ──────────────────────────────────────────────────────────────────────────────
def _causal_mask(t: int, device, pad: Optional[torch.Tensor]) -> torch.Tensor:
    m = torch.tril(torch.ones(t, t, dtype=torch.bool, device=device))  # [T,T]
    m = m[None, None]                                                  # [1,1,T,T]
    if pad is not None:
        m = m & pad[:, None, None, :].to(torch.bool)                  # & key padding
    return m


def _sliding_window_mask(t: int, window: int, device, pad: Optional[torch.Tensor]) -> torch.Tensor:
    # token t attends s where 0 <= (t - s) < window  → W tokens incl. self (causal).
    idx = torch.arange(t, device=device)
    delta = idx[:, None] - idx[None, :]                               # [T,T]
    m = (delta >= 0) & (delta < window)
    m = m[None, None]
    if pad is not None:
        m = m & pad[:, None, None, :].to(torch.bool)
    return m


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

    def forward(self, input_ids=None, attention_mask=None, inputs_embeds=None, **kw):
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

            last = loop_idx == cfg.plt_num_loops - 1
            if (not last and cfg.plt_normalize_per_loop) or last:
                hidden = self.norm(hidden)

        return hidden


class KeystonePLTForCausalLM(KeystonePLTPreTrainedModel):
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
                labels=None, **kw):
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

    # No KV cache yet: PLT incremental decode (loop-0 cache reuse across steps) is
    # a later serving stage. .generate() works by full-forward recompute per step,
    # which is correct (just O(n²)) — fine for parity + small evals.
    def prepare_inputs_for_generation(self, input_ids, attention_mask=None, **kw):
        return {"input_ids": input_ids, "attention_mask": attention_mask}


__all__ = ["KeystonePLTConfig", "KeystonePLTModel", "KeystonePLTForCausalLM"]
