"""CI coverage for the arm-C GRPO/RLVR trainer math (ADR-0025 / Σ_θ §8).

The GRPO advantage, adaptive-rollout skip, and trust-region loss are the load-bearing training
logic for arm C. They must be exercised in CI (no GPU) so a regression is caught before any L4
spend. The model-generation/optimizer loop is L4-only and not covered here.
"""
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "rlvr_grpo_ouro", os.path.join(ROOT, "scripts", "rlvr_grpo_ouro.py"))
G = importlib.util.module_from_spec(_spec)
sys.modules["rlvr_grpo_ouro"] = G   # register before exec so @dataclass resolves __module__
_spec.loader.exec_module(G)


def test_selftest_all_pass():
    assert G.selftest() == 0


def test_zero_advantage_groups_skipped():
    assert G.should_skip_group([1.0, 1.0, 1.0])      # all pass
    assert G.should_skip_group([0.0, 0.0, 0.0])      # all fail
    assert not G.should_skip_group([1.0, 0.0, 1.0])  # mixed → keep


def test_advantage_signs_and_mean_zero():
    adv = G.group_relative_advantage([1.0, 0.0, 0.0, 0.0])
    assert adv[0] > 0 and all(a < 0 for a in adv[1:])
    assert abs(sum(adv)) < 1e-9
    assert all(abs(a) < 1e-9 for a in G.group_relative_advantage([1.0, 1.0, 1.0]))


def test_loss_upweights_passing_completion():
    adv = G.group_relative_advantage([1.0, 0.0, 0.0, 0.0])
    ref = [-2.0, -2.0, -2.0, -2.0]
    lo, _ = G.grpo_step_loss([-2.0, -2.0, -2.0, -2.0], adv, ref, kl_coef=0.0)
    hi, _ = G.grpo_step_loss([-1.0, -2.0, -2.0, -2.0], adv, ref, kl_coef=0.0)
    assert hi < lo   # raising logp of the passing (adv>0) completion lowers the loss


def test_kl_penalizes_drift_from_base():
    adv = G.group_relative_advantage([1.0, 0.0, 0.0, 0.0])
    ref = [-2.0, -2.0, -2.0, -2.0]
    drift = [-0.5, -0.5, -0.5, -0.5]
    l0, _ = G.grpo_step_loss(drift, adv, ref, kl_coef=0.0)
    l1, kl = G.grpo_step_loss(drift, adv, ref, kl_coef=0.5)
    assert l1 > l0 and kl > 0
