"""
Convergence IO — Unified Agent Primitive Stack
v1.0.0 — Corrected super-jarvis replacement

Implements the 5 derived specs from the Regulatory Primitive Stack:
  PCSF — Provider Capacity State Format  (P4, capacity routing)
  CCF  — Capability Claim Format         (P4, P5, P8, P10)
  AAPF — Agent Action Provenance Format  (P3, P6, P7, P9)
  NAP  — Negative Authority Profiles     (P2, M1 denial gates)
  DCF  — Data Classification Format      (P1, label propagation)

Replaces super-jarvis-default and super-jarvis-primary agent profiles
with a clean, testable, composable primitive stack.
"""

from .pcsf import ProviderCapacityState, ProviderRegistry, ProviderState, DreamerTier
from .ccf import CapabilityClaim, CapabilityGate, GateResult, HonestyTracker
from .aapf import ActionRecord, ProvenanceLedger
from .nap import NegativeAuthorityProfile, AuthorityGate
from .dcf import DataClassification, ClassificationLabel, DREAM_LABELS
from .engine import ConvergenceIO, RouteResult

__all__ = [
    "ConvergenceIO", "RouteResult",
    "ProviderCapacityState", "ProviderRegistry", "ProviderState", "DreamerTier",
    "CapabilityClaim", "CapabilityGate", "GateResult", "HonestyTracker",
    "ActionRecord", "ProvenanceLedger",
    "NegativeAuthorityProfile", "AuthorityGate",
    "DataClassification", "ClassificationLabel", "DREAM_LABELS",
]

__version__ = "1.2.0"
