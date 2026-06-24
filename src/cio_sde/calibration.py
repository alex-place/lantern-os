"""
CIO-SDE Calibration Layer — Issue #1135

Implements falsification, false-positive / false-negative labelling, and
calibration reporting for Σ₀ interventions.  This is a simulation-only module.

No claims of product-level safety are made here.  All results are runtime
measurements over synthetic SDE rollouts.  See docs/SIGMA0-COLLAPSE-CERTIFICATE.md
for the distinction between theorem-proven, measured, and heuristic claims.

Public API
----------
ScenarioLabel       — Enum: consistent | false_positive | false_negative |
                              harmful | out_of_scope
ScenarioResult      — Outcome of one paired rollout comparison
CalibrationReport   — Aggregate over N scenarios
run_scenario        — Compare no_op vs. bounded-intervention from the same seed
run_calibration     — Run multiple scenarios and aggregate
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, asdict, field
from enum import Enum
from typing import Dict, List, Optional, Tuple

try:
    import torch
    Tensor = torch.Tensor
    _TORCH_AVAILABLE = True
except ImportError:
    _TORCH_AVAILABLE = False
    Tensor = object  # type: ignore[assignment,misc]


# ── Label definitions ─────────────────────────────────────────────────────────

class ScenarioLabel(str, Enum):
    """
    Falsifiable error labels for one paired-rollout comparison.

    consistent        — intervention did not worsen the declared objective.
    false_positive    — intervention fired AND the no-action arm met the terminal
                        objective at equal or lower cost; the intervention was
                        unnecessary.
    false_negative    — declared degraded terminal condition occurred without a
                        warning or intervention in the allowed window.
    harmful           — intervention worsened the declared objective, destroyed a
                        required invariant, or caused a new terminal failure.
    out_of_scope      — theorem assumptions do not hold for this scenario; no
                        theorem-backed interpretation is allowed.
    """
    consistent     = "consistent"
    false_positive = "false_positive"
    false_negative = "false_negative"
    harmful        = "harmful"
    out_of_scope   = "out_of_scope"


# ── Per-scenario result ───────────────────────────────────────────────────────

@dataclass
class ScenarioResult:
    """Outcome of one paired rollout."""
    scenario_id: str
    base_seed: int
    steps: int

    # no-op arm
    noop_final_x_norm: float
    noop_final_sigma_tr: float
    noop_integrated_cost: Optional[float]
    noop_collapse_count: int

    # intervention arm
    intervention_final_x_norm: float
    intervention_final_sigma_tr: float
    intervention_integrated_cost: Optional[float]
    intervention_count: int

    # deltas (intervention - no_op; positive = worse for cost)
    x_norm_delta: float
    sigma_tr_delta: float
    cost_delta: Optional[float]

    label: ScenarioLabel
    label_reason: str

    # Receipts from the intervention arm (already plain dicts)
    receipts: List[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["label"] = self.label.value
        return d


# ── Aggregate report ──────────────────────────────────────────────────────────

@dataclass
class CalibrationReport:
    """
    Aggregate calibration statistics over N scenarios.

    Rates include denominators so readers can judge statistical weight.
    No confidence intervals are computed; sample sizes are typically small.
    """
    scenario_count: int
    intervention_rate: float            # fraction of scenarios with ≥1 intervention
    false_positive_rate: float          # false_positive / scenario_count
    false_negative_rate: float          # false_negative / scenario_count
    harmful_rate: float                 # harmful / scenario_count
    mean_cost_delta: Optional[float]    # mean(cost_delta) where available; None if no costs
    label_counts: Dict[str, int]        # {label: count}
    scenario_ids: List[str]
    policy_summary: dict
    note: str = (
        "Simulation-only. Results do not transfer to Keystone Chat, PCSF routing, "
        "cloud egress, provider switching, or any external system."
    )

    def to_dict(self) -> dict:
        return asdict(self)


# ── Scenario runner ───────────────────────────────────────────────────────────

def run_scenario(
    model,
    x0: "Tensor",
    sigma0: "Tensor",
    steps: int = 20,
    dt: float = 0.05,
    base_seed: int = 0,
    scenario_id: str = "unnamed",
    terminal_cost_threshold: Optional[float] = None,
) -> ScenarioResult:
    """
    Run one paired comparison: no-op arm vs. bounded-intervention arm.

    terminal_cost_threshold: if set, a cost above this is treated as a
    'degraded' terminal condition for false-negative detection.
    """
    if not _TORCH_AVAILABLE:
        raise RuntimeError("torch is required to run calibration scenarios")

    from .engine import InterventionPolicy, paired_control_rollout

    # Override model policy for the bounded arm to allow up to 10 interventions
    saved_policy = model.intervention_policy
    model.intervention_policy = InterventionPolicy(observe_only=False, max_interventions=10)
    no_op, _observe, bounded = paired_control_rollout(
        model, x0, sigma0, steps=steps, dt=dt, base_seed=base_seed
    )
    model.intervention_policy = saved_policy

    cost_delta: Optional[float] = None
    if no_op.integrated_cost is not None and bounded.integrated_cost is not None:
        cost_delta = bounded.integrated_cost - no_op.integrated_cost

    # False-positive: intervention fired, but no-op arm met terminal objective at
    # ≤ cost than intervention arm.
    fp = (
        bounded.intervention_count > 0
        and (cost_delta is not None and cost_delta > 0.0)
    )

    # False-negative: degraded terminal (high cost in no-op arm) without intervention
    fn = (
        terminal_cost_threshold is not None
        and no_op.integrated_cost is not None
        and no_op.integrated_cost > terminal_cost_threshold
        and bounded.intervention_count == 0
    )

    # Harmful: intervention fired AND worsened state (x_norm or sigma_tr went up)
    harmful = (
        bounded.intervention_count > 0
        and (bounded.final_x_norm > no_op.final_x_norm * 1.5
             or bounded.final_sigma_tr > no_op.final_sigma_tr * 2.0)
    )

    if fp:
        label = ScenarioLabel.false_positive
        reason = (
            f"intervention fired ({bounded.intervention_count}x) but cost increased "
            f"by {cost_delta:.4f} vs no-op"
        )
    elif fn:
        label = ScenarioLabel.false_negative
        reason = (
            f"degraded terminal (cost {no_op.integrated_cost:.4f} > threshold "
            f"{terminal_cost_threshold}) with no intervention"
        )
    elif harmful:
        label = ScenarioLabel.harmful
        reason = (
            f"intervention worsened state: x_norm {no_op.final_x_norm:.3f} → "
            f"{bounded.final_x_norm:.3f}, sigma_tr {no_op.final_sigma_tr:.3f} → "
            f"{bounded.final_sigma_tr:.3f}"
        )
    else:
        label = ScenarioLabel.consistent
        reason = "intervention did not worsen declared objectives"

    return ScenarioResult(
        scenario_id=scenario_id,
        base_seed=base_seed,
        steps=steps,
        noop_final_x_norm=no_op.final_x_norm,
        noop_final_sigma_tr=no_op.final_sigma_tr,
        noop_integrated_cost=no_op.integrated_cost,
        noop_collapse_count=no_op.collapse_count,
        intervention_final_x_norm=bounded.final_x_norm,
        intervention_final_sigma_tr=bounded.final_sigma_tr,
        intervention_integrated_cost=bounded.integrated_cost,
        intervention_count=bounded.intervention_count,
        x_norm_delta=bounded.final_x_norm - no_op.final_x_norm,
        sigma_tr_delta=bounded.final_sigma_tr - no_op.final_sigma_tr,
        cost_delta=cost_delta,
        label=label,
        label_reason=reason,
        receipts=bounded.receipts,
    )


def run_calibration(
    model,
    scenarios: List[dict],
    dt: float = 0.05,
) -> CalibrationReport:
    """
    Run multiple scenarios and aggregate.

    Each dict in `scenarios` must have: x0, sigma0, steps, base_seed, scenario_id.
    Optional keys: terminal_cost_threshold.
    """
    if not _TORCH_AVAILABLE:
        raise RuntimeError("torch is required to run calibration")

    results: List[ScenarioResult] = []
    for s in scenarios:
        r = run_scenario(
            model,
            x0=s["x0"], sigma0=s["sigma0"],
            steps=s.get("steps", 20),
            dt=dt,
            base_seed=s["base_seed"],
            scenario_id=s["scenario_id"],
            terminal_cost_threshold=s.get("terminal_cost_threshold"),
        )
        results.append(r)

    n = len(results)
    if n == 0:
        return CalibrationReport(
            scenario_count=0, intervention_rate=0.0,
            false_positive_rate=0.0, false_negative_rate=0.0, harmful_rate=0.0,
            mean_cost_delta=None, label_counts={}, scenario_ids=[],
            policy_summary={},
        )

    label_counts: Dict[str, int] = {}
    for lab in ScenarioLabel:
        label_counts[lab.value] = sum(1 for r in results if r.label == lab)

    cost_deltas = [r.cost_delta for r in results if r.cost_delta is not None]

    policy = model.intervention_policy
    return CalibrationReport(
        scenario_count=n,
        intervention_rate=sum(1 for r in results if r.intervention_count > 0) / n,
        false_positive_rate=label_counts.get("false_positive", 0) / n,
        false_negative_rate=label_counts.get("false_negative", 0) / n,
        harmful_rate=label_counts.get("harmful", 0) / n,
        mean_cost_delta=sum(cost_deltas) / len(cost_deltas) if cost_deltas else None,
        label_counts=label_counts,
        scenario_ids=[r.scenario_id for r in results],
        policy_summary={
            "observe_only": policy.observe_only,
            "max_interventions": policy.max_interventions,
            "approval_required": policy.approval_required,
            "rollback_required": policy.rollback_required,
        },
    )
