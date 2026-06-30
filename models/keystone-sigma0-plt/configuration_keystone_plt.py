"""Keystone-Σ₀ PLT model configuration.

This is Keystone OS's *own* configuration for a Parallel Loop Transformer (PLT)
coder. It is a faithful, renamed re-derivation of the upstream IQuestPLTCoder
config (Apache-2.0, `Multilingual-Multimodal-NLP/LoopCoder-V2`,
arXiv:2510.24824) so that we OWN the architecture end-to-end (ADR-0011) — the
weights are bootstrapped from that Apache-2.0 checkpoint and become a Keystone
artifact we adjust via adapters (ADR-0010).

PLT reuses the same `num_hidden_layers` physical layers across `plt_num_loops`
passes. Loop 0 runs standard causal attention and stores its K/V. Loops 1+ run a
per-head learned gate that mixes GLOBAL attention (current query against loop-0's
cached K/V, full causal) with LOCAL attention (current loop's K/V, sliding
window). Between loops the hidden state is recombined with the token embedding
via cross-loop processing (CLP): `a·E + b·H_prev`.

The crucial difference from the upstream release: upstream ships config +
tokenizer + weights but NO modeling code (its `auto_map` wires only `AutoConfig`,
and inference is only possible through a custom vLLM fork). Here `auto_map` wires
BOTH the config and `modeling_keystone_plt.KeystonePLTForCausalLM`, so
`AutoModelForCausalLM.from_pretrained(dir, trust_remote_code=True)` works on a
stock `transformers` + `bitsandbytes` + `peft` stack — which is what makes the
model trainable on a GPU box.
"""

from __future__ import annotations

from transformers.configuration_utils import PretrainedConfig
from transformers.utils import logging


logger = logging.get_logger(__name__)


class KeystonePLTConfig(PretrainedConfig):
    """Configuration for `KeystonePLTForCausalLM`.

    Defaults reproduce the LoopCoder-V2 7B/PLT checkpoint
    (`Multilingual-Multimodal-NLP/LoopCoder-V2`). Only the PLT-specific args are
    documented at length; the rest are standard Llama-family fields.

    PLT args:
        plt_num_loops (`int`, default 2): number of passes over the shared layer
            stack. Loop 0 caches K/V; loops 1+ use the gated mixed attention.
        plt_window_size (`list[int]`, default `[64, 0]`): `[left, right]` sliding
            window for the LOCAL attention branch in loops 1+. `[64, 0]` = a
            left-context window of 64 tokens, causal (no right context).
        plt_normalize_per_loop (`bool`, default True): apply the shared
            `final_layernorm` (`model.norm`) to the hidden state at the end of
            every non-last loop before the next loop's CLP.
        plt_emb_scale (`float`, default 0.707): `a` in CLP `a·E + b·H_prev`.
            `None` → 1.0.
        plt_hidden_scale (`float`, default 0.053): `b` in CLP `a·E + b·H_prev`.
            `None` → 1.0.
        plt_gate_use_hidden_states (`bool`, default True): gate input mode. True
            (OLMo-style, what the checkpoint uses) → `sigmoid(Linear(RMSNorm(
            pre-attn residual)))` per head. False → `sigmoid(einsum(Q, W))` on the
            post-RoPE query (kept for completeness; the released weights use True).
        plt_clp_shift (`bool`, default False): if True, causally shift `H_prev` by
            one position in CLP (`a·E + b·roll(H_prev, +1)`). The upstream vLLM
            INFERENCE path does NOT shift; the paper docstring writes "shift(H)".
            This is the #1 parity knob — leave False to match the validated
            inference path; flip only if the parity check says otherwise.
    """

    model_type = "keystone_plt"
    keys_to_ignore_at_inference = ["past_key_values"]

    def __init__(
        self,
        vocab_size=76800,
        hidden_size=5120,
        intermediate_size=27648,
        num_hidden_layers=14,
        num_attention_heads=40,
        num_key_value_heads=8,
        head_dim=128,
        hidden_act="silu",
        max_position_embeddings=131072,
        initializer_range=0.02,
        rms_norm_eps=1e-5,
        use_cache=False,  # PLT loop-0 K/V caching for incremental decode is a
        # later stage; teacher-forced training + full-forward eval/parity recompute.
        pad_token_id=None,
        bos_token_id=1,
        eos_token_id=None,
        tie_word_embeddings=False,
        rope_theta=500000.0,
        rope_scaling=None,
        attention_bias=False,
        attention_dropout=0.0,
        mlp_bias=False,
        # PLT specific
        plt_num_loops=2,
        plt_window_size=None,
        plt_normalize_per_loop=True,
        plt_emb_scale=0.707,
        plt_hidden_scale=0.053,
        plt_gate_use_hidden_states=True,
        plt_clp_shift=False,
        **kwargs,
    ):
        if eos_token_id is None:
            eos_token_id = [2, 75864, 75869]
        if plt_window_size is None:
            plt_window_size = [64, 0]

        self.vocab_size = vocab_size
        self.max_position_embeddings = max_position_embeddings
        self.hidden_size = hidden_size
        self.intermediate_size = intermediate_size
        self.num_hidden_layers = num_hidden_layers
        self.num_attention_heads = num_attention_heads
        self.num_key_value_heads = num_key_value_heads
        self.head_dim = head_dim
        self.hidden_act = hidden_act
        self.initializer_range = initializer_range
        self.rms_norm_eps = rms_norm_eps
        self.use_cache = use_cache
        self.rope_theta = rope_theta
        self.rope_scaling = rope_scaling
        self.attention_bias = attention_bias
        self.attention_dropout = attention_dropout
        self.mlp_bias = mlp_bias

        # PLT specific
        self.plt_num_loops = plt_num_loops
        self.plt_window_size = plt_window_size
        self.plt_normalize_per_loop = plt_normalize_per_loop
        self.plt_emb_scale = plt_emb_scale
        self.plt_hidden_scale = plt_hidden_scale
        self.plt_gate_use_hidden_states = plt_gate_use_hidden_states
        self.plt_clp_shift = plt_clp_shift

        super().__init__(
            pad_token_id=pad_token_id,
            bos_token_id=bos_token_id,
            eos_token_id=eos_token_id,
            tie_word_embeddings=tie_word_embeddings,
            **kwargs,
        )


__all__ = ["KeystonePLTConfig"]
