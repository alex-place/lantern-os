"""KV-cache correctness gate for the owned Σ₀ PLT forward
(models/keystone-sigma0-plt/modeling_keystone_plt.py).

PR #1766 replaced the O(n^2) no-cache decode with cached greedy generation
(dynamic + static pre-allocated buffers), taking the model from DONT_BUILD
(4.29 tok/s) to BUILD (7.83 tok/s) — see docs/adr/0011-proprietary-sigma0-base-model.md
and data/convergence/loopcoder-probe-log.jsonl. That speed win is worthless if the
cache silently changes the output, so this test asserts `fast_generate` (dynamic)
and `fast_generate_static` (static) are TOKEN-IDENTICAL to the full-recompute
(no-cache) forward — the same equivalence check done ad hoc during development,
now a committed regression test.

Uses a tiny random-init config so it runs on CPU in seconds; this does NOT touch
the real ~9B checkpoint or prove faithful parity against the vendor vLLM reference
(that is the separate, GPU-gated Stage-0 check in
models/keystone-sigma0-plt/check_parity.py). This test only proves: *whichever
math the forward implements, the two cached decode paths reproduce it exactly.*
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")

PKG_DIR = Path(__file__).resolve().parents[1] / "models" / "keystone-sigma0-plt"
pytestmark = pytest.mark.skipif(
    not (PKG_DIR / "modeling_keystone_plt.py").exists(),
    reason="models/keystone-sigma0-plt package not present",
)


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def plt():
    """Load the package's config + modeling modules by path (it's not a pip
    package — download_and_patch.py is what normally drops them next to the
    checkpoint, so we import directly from the repo copy instead)."""
    if str(PKG_DIR) not in sys.path:
        sys.path.insert(0, str(PKG_DIR))
    config_mod = _load_module("configuration_keystone_plt", PKG_DIR / "configuration_keystone_plt.py")
    modeling_mod = _load_module("modeling_keystone_plt", PKG_DIR / "modeling_keystone_plt.py")
    return config_mod, modeling_mod


def _tiny_config(config_mod, **overrides):
    kwargs = dict(
        vocab_size=64,
        hidden_size=32,
        intermediate_size=64,
        num_hidden_layers=2,
        num_attention_heads=4,
        num_key_value_heads=2,
        head_dim=8,
        max_position_embeddings=64,
        plt_num_loops=2,
        plt_window_size=[3, 0],
        plt_normalize_per_loop=True,
        plt_clp_shift=False,
        pad_token_id=0,
        bos_token_id=1,
        eos_token_id=[63],
    )
    kwargs.update(overrides)
    return config_mod.KeystonePLTConfig(**kwargs)


def _full_recompute_greedy(model, input_ids, max_new_tokens, eos_set):
    """Ground truth: re-run the WHOLE no-cache forward every step (the original,
    pre-#1766 behavior — preserved bit-exact in the cached file for training/parity)."""
    ids = input_ids.clone()
    for _ in range(max_new_tokens):
        logits = model(input_ids=ids).logits
        next_tok = int(logits[0, -1].argmax())
        ids = torch.cat([ids, torch.tensor([[next_tok]], dtype=ids.dtype)], dim=1)
        if next_tok in eos_set:
            break
    return ids


# Each case exercises one of the reconstructed "parity boundary" knobs called out
# in models/keystone-sigma0-plt/README.md (clp_shift, per-loop norm, window edges)
# plus a 3-loop config (the released checkpoint uses plt_num_loops=2, but the cache
# math must generalize to any loop count).
CASES = {
    "defaults": {},
    "three_loops": {"plt_num_loops": 3},
    "clp_shift": {"plt_clp_shift": True},
    "no_per_loop_norm": {"plt_normalize_per_loop": False},
    "window_of_one": {"plt_window_size": [1, 0]},
    "window_wider_than_seq": {"plt_window_size": [16, 0]},
}


@pytest.mark.parametrize("overrides", CASES.values(), ids=list(CASES.keys()))
def test_cached_decode_matches_full_recompute(plt, overrides):
    config_mod, modeling_mod = plt
    torch.manual_seed(0)
    config = _tiny_config(config_mod, **overrides)
    model = modeling_mod.KeystonePLTForCausalLM(config)
    model.eval()

    prompt = torch.randint(2, config.vocab_size, (1, 5), dtype=torch.long)
    eos_set = set(config.eos_token_id)
    max_new = 6

    ground_truth = _full_recompute_greedy(model, prompt, max_new, eos_set)
    static_out = model.fast_generate_static(
        prompt, max_new_tokens=max_new, eos_token_id=config.eos_token_id
    )
    dynamic_out = model.fast_generate(
        prompt, max_new_tokens=max_new, eos_token_id=config.eos_token_id
    )

    # An early EOS on one path vs another is fine; every token a path DID emit
    # must match the ground truth exactly over the overlapping prefix.
    n = min(ground_truth.shape[1], static_out.shape[1], dynamic_out.shape[1])
    assert torch.equal(ground_truth[:, :n], static_out[:, :n]), (
        f"static-cache decode diverged from full-recompute ({overrides})"
    )
    assert torch.equal(ground_truth[:, :n], dynamic_out[:, :n]), (
        f"dynamic-cache decode diverged from full-recompute ({overrides})"
    )


def test_hf_generate_routes_through_static_cache(plt):
    """`.generate()` (the HF-standard entry point serve_keystone_plt.py calls)
    must produce the same output as calling fast_generate_static directly —
    proves the routing in KeystonePLTForCausalLM.generate() isn't silently
    falling back to the (slow, but also just-as-correct) GenerationMixin path
    for the batch=1 greedy case it's supposed to intercept."""
    config_mod, modeling_mod = plt
    torch.manual_seed(1)
    config = _tiny_config(config_mod)
    model = modeling_mod.KeystonePLTForCausalLM(config)
    model.eval()

    prompt = torch.randint(2, config.vocab_size, (1, 4), dtype=torch.long)
    max_new = 5

    direct = model.fast_generate_static(
        prompt, max_new_tokens=max_new, eos_token_id=config.eos_token_id
    )
    via_generate = model.generate(
        prompt, max_new_tokens=max_new, do_sample=False, num_beams=1, use_cache=True
    )
    assert torch.equal(direct, via_generate), (
        ".generate() did not route batch=1 greedy through the static-cache path"
    )
