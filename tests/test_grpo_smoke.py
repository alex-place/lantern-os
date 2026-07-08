"""End-to-end smoke of the arm-C GRPO loop on a TINY model (CPU, offline, no cloud).

A training loop is model-agnostic, so a tiny random GPT-2 (with a real cached tokenizer) proves the
whole machinery — sample -> reward -> group-relative advantage -> policy/ref logprobs -> GRPO loss ->
backward -> optimizer step -> params move — without Ouro, a GPU, or the cloud. The L4 run is the SAME
code with `--base ByteDance/Ouro-1.4B`.

Skipped automatically where torch/transformers/peft (or the cached tokenizer) are absent — e.g. a
torch-free CI interpreter — so it never reddens the suite. Runs under the training venv:
    D:/lantern-venv-train/Scripts/python -m pytest tests/test_grpo_smoke.py -q
"""
import importlib.util
import os
import sys

import pytest

torch = pytest.importorskip("torch")
pytest.importorskip("transformers")
pytest.importorskip("peft")

os.environ.setdefault("HF_HOME", "D:/hf-cache")
os.environ.setdefault("HF_HUB_OFFLINE", "1")          # never touch the network in a test
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("rlvr_grpo_ouro", os.path.join(ROOT, "scripts", "rlvr_grpo_ouro.py"))
G = importlib.util.module_from_spec(_spec)
sys.modules["rlvr_grpo_ouro"] = G
_spec.loader.exec_module(G)


def _tiny_setup():
    """Tiny GPT-2 policy(+LoRA) & frozen ref sharing weights, plus a real cached tokenizer."""
    from transformers import GPT2Config, GPT2LMHeadModel, AutoTokenizer
    from peft import LoraConfig, get_peft_model
    try:
        tok = AutoTokenizer.from_pretrained("ByteDance/Ouro-1.4B", trust_remote_code=True)
    except Exception as e:
        pytest.skip(f"Ouro tokenizer not cached offline ({e})")
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    cfg = GPT2Config(vocab_size=tok.vocab_size, n_positions=128, n_embd=64, n_layer=2, n_head=2,
                     bos_token_id=tok.pad_token_id, eos_token_id=tok.eos_token_id or tok.pad_token_id)
    torch.manual_seed(0)
    base = GPT2LMHeadModel(cfg)
    ref = GPT2LMHeadModel(cfg)
    ref.load_state_dict(base.state_dict())
    for p in ref.parameters():
        p.requires_grad_(False)
    policy = get_peft_model(base, LoraConfig(r=4, lora_alpha=8, target_modules=["c_attn"], task_type="CAUSAL_LM"))
    return policy, ref, tok


def test_grpo_update_moves_params_on_a_mixed_group():
    """The deterministic core: a mixed-reward group must produce a finite loss and actually step the
    LoRA weights (this is the real backward/optimizer path, on a real model)."""
    policy, ref, tok = _tiny_setup()
    prompt = "def add(a, b):\n"
    completions = ["    return a + b\n", "    return a - b\n", "    pass\n", "    return None\n"]
    comp_ids, plens = [], []
    plen = tok(prompt, return_tensors="pt")["input_ids"].shape[1]
    for c in completions:
        ids = tok(prompt + c, return_tensors="pt")["input_ids"]
        comp_ids.append(ids); plens.append(plen)
    rewards = [1.0, 0.0, 0.0, 0.0]   # only the first "passes" -> mixed group, real signal

    trainable = [p for p in policy.parameters() if p.requires_grad]
    before = [p.detach().clone() for p in trainable]
    opt = torch.optim.Adam(trainable, lr=1e-2)
    cfg = G.GRPOConfig(group=4, kl_coef=0.02, kl_max=1e9)   # kl_max high so the step isn't gated out
    loss, kl, did = G.grpo_update(policy, ref, comp_ids, plens, rewards, cfg, opt, device="cpu")

    assert did is True
    assert torch.isfinite(loss.detach())
    moved = any(not torch.allclose(b, a) for b, a in zip(before, trainable))
    assert moved, "LoRA params did not change after a GRPO update"


def test_grpo_update_skips_zero_advantage_group():
    """An all-pass (or all-fail) group carries no gradient -> no step (adaptive rollout)."""
    policy, ref, tok = _tiny_setup()
    prompt = "def f():\n"
    comp_ids, plens = [], []
    plen = tok(prompt, return_tensors="pt")["input_ids"].shape[1]
    for c in ["    return 1\n", "    return 2\n", "    return 3\n"]:
        comp_ids.append(tok(prompt + c, return_tensors="pt")["input_ids"]); plens.append(plen)
    opt = torch.optim.Adam([p for p in policy.parameters() if p.requires_grad], lr=1e-2)
    _, _, did = G.grpo_update(policy, ref, comp_ids, plens, [1.0, 1.0, 1.0], G.GRPOConfig(), opt)
    assert did is False


def test_grpo_train_loop_runs_end_to_end():
    """Full loop with sampling + a fake reward: completes all steps, accounts every step as an
    update or a skip, and produces finite losses."""
    policy, ref, tok = _tiny_setup()
    tasks = [{"prompt": "def g(x):\n", "entry_point": "g", "test": ""}]
    # fake reward with in-group variance (byte parity of the sampled text) so updates can happen
    reward_fn = lambda comp, task: float(sum(comp.encode("utf-8", "ignore")) % 2)
    cfg = G.GRPOConfig(group=4, steps=3, max_new=6, temperature=1.5, lr=1e-2, kl_max=1e9)
    st = G.grpo_train_loop(policy, ref, tok, tasks, reward_fn, cfg, device="cpu", log=lambda *a: None)
    assert st["steps"] == 3
    assert st["updates"] + st["skipped"] == 3
    assert all(l == l for l in st["losses"])   # no NaN
