"""
Convergence IO — Unified Agent Primitive Stack
v0.3.0 — CEG + PCSF optimizer + Hot-Swap + Time Dilation

Implements the 5 derived specs from the Regulatory Primitive Stack:
  PCSF — Provider Capacity State Format  (P4, capacity routing)
  CCF  — Capability Claim Format         (P4, P5, P8, P10)
  AAPF — Agent Action Provenance Format  (P3, P6, P7, P9)
  NAP  — Negative Authority Profiles     (P2, M1 denial gates)
  DCF  — Data Classification Format      (P1, label propagation)

v0.3 additions:
  CEG      — Convergence Execution Graph  G=(V,E,D,τ,S,H)
  Dilation — Time dilation field D(v) = f(uncertainty, cost_pressure, confidence)
  HotSwap  — σ operator with rollback, SwapConvergenceGuard anti-oscillation
"""

from .pcsf import ProviderCapacityState, ProviderRegistry, ProviderState, DreamerTier
from .ccf import CapabilityClaim, CapabilityGate, GateResult, HonestyTracker
from .aapf import ActionRecord, ProvenanceLedger
from .nap import NegativeAuthorityProfile, AuthorityGate
from .dcf import DataClassification, ClassificationLabel, DREAM_LABELS
from .engine import ConvergenceIO, RouteResult
from .status_cube import StatusCube, StatusArtifact, StatusCoordinate, BayesianBelief
from .ceg import (
    CEGraph, NodeKind, EdgeKind,
    IntentNode, ResourceNode, ConstraintNode, AuthorityNode, MemoryNode, TraceNode,
    UIProjectionNode, FeatureState,
    ExecutionContract, ExecutionConstraints, ExecutionPlan, ExecutionStep,
    PCSFOptimizer, SystemState, ResourceState, MemoryState, PolicyState,
    CostWeights, Severity, ResourceKind,
    CEGExecutor, ExecutorStep,
)
from .dilation import DilationField, SwapConvergenceGuard, dilation
from .hot_swap import HotSwapRegistry, SwapEvent, SwapTrigger, SwapPolicy, SwapHysteresis

__all__ = [
    # v0.1 primitives
    "ConvergenceIO", "RouteResult",
    "ProviderCapacityState", "ProviderRegistry", "ProviderState", "DreamerTier",
    "CapabilityClaim", "CapabilityGate", "GateResult", "HonestyTracker",
    "ActionRecord", "ProvenanceLedger",
    "NegativeAuthorityProfile", "AuthorityGate",
    "DataClassification", "ClassificationLabel", "DREAM_LABELS",
    "StatusCube", "StatusArtifact", "StatusCoordinate", "BayesianBelief",
    # v0.3 CEG
    "CEGraph", "NodeKind", "EdgeKind",
    "IntentNode", "ResourceNode", "ConstraintNode", "AuthorityNode", "MemoryNode", "TraceNode",
    "ExecutionContract", "ExecutionConstraints", "ExecutionPlan", "ExecutionStep",
    "PCSFOptimizer", "SystemState", "CostWeights", "Severity", "ResourceKind",
    # v0.4 CEG additions
    "UIProjectionNode", "FeatureState", "ResourceState", "MemoryState", "PolicyState",
    "CEGExecutor", "ExecutorStep",
    # v0.3 Dilation
    "DilationField", "SwapConvergenceGuard", "dilation",
    # v0.3/v0.4 HotSwap
    "HotSwapRegistry", "SwapEvent", "SwapTrigger", "SwapPolicy", "SwapHysteresis",
]

__version__ = "0.4.0"
