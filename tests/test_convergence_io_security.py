"""Adversarial soundness probes for the Convergence-IO governance primitives
(NAP authority gate + CCF capability gate).

Same discipline as the CSF benchmarks: try to BYPASS each gate, confirm the hole,
then the fix closes it. Grounded in standard access-control results:
  * canonicalization before authz (CWE-178 / CWE-289; OWASP) — a denial keyed on an
    exact string is bypassed by case/whitespace/separator variants;
  * fail-closed on indeterminate (XACML: unknown → deny, never allow);
  * deny-overrides / hard denial cannot be lifted by a grant (the IP-register §4.4
    "NAP-over-capability ordering invariant");
  * honesty accounting must penalize partial over-claims, not reward overlap.
"""
import pytest

from src.convergence_io.nap import (AuthorityGate, NegativeAuthorityProfile,
                                    dreamer_safety_nap)
from src.convergence_io.ccf import CapabilityGate, CapabilityClaim


# ── F1: NAP action/data-class canonicalization bypass ──────────────────────────

@pytest.mark.parametrize("variant", [
    "Financial_Trade", "FINANCIAL_TRADE", " financial_trade", "financial_trade ",
    "financial-trade", "financial trade",
])
def test_nap_denial_survives_string_variants(variant):
    """A safety denial on 'financial_trade' must not be defeated by re-casing or
    re-spacing the action string."""
    gate = AuthorityGate()
    gate.add_profile(dreamer_safety_nap())          # denies 'financial_trade'
    res = gate.check(action_type=variant)
    assert res.denied, f"BYPASS: variant {variant!r} slipped past the denial"


def test_nap_data_class_denial_survives_case():
    gate = AuthorityGate()
    gate.add_profile(dreamer_safety_nap())          # denies 'pii.ssn'
    assert gate.check(action_type="chat", data_classes=["PII.SSN"]).denied


# ── F2: a HARD denial cannot be lifted by a tier (capability) override ──────────

def test_hard_safety_nap_cannot_be_tier_overridden():
    gate = AuthorityGate()
    gate.add_profile(dreamer_safety_nap())          # safety = hard, unoverridable
    # even the highest tier must not lift a hard safety denial
    assert gate.check(action_type="financial_trade", tier="synthesasia_guild").denied


def test_soft_nap_still_tier_overridable():
    """Non-safety operator policies keep the documented soft-override behavior."""
    soft = NegativeAuthorityProfile(profile_id="soft", denied_actions={"art_generation"},
                                    tier_override="deep_dreamer")
    gate = AuthorityGate()
    gate.add_profile(soft)
    assert gate.check(action_type="art_generation", tier="wanderer").denied      # low tier denied
    assert not gate.check(action_type="art_generation", tier="deep_dreamer").denied  # high tier lifts


# ── F5: CCF unknown REQUIRED tier must fail closed (not silently pass) ──────────

def test_ccf_unknown_required_tier_fails_closed():
    gate = CapabilityGate()
    claim = CapabilityClaim(agent_id="a", provider_id="p", capabilities={"chat"},
                            tier="wanderer")
    gate.register_claim(claim)
    # requiring an unrecognized tier must NOT be satisfied by a low-tier claim
    res = gate.check("a", required={"chat"}, tier="pilot")
    assert not res.allowed, "BYPASS: unknown required tier acted as no requirement"


def test_ccf_known_tier_ladder_still_enforced():
    gate = CapabilityGate()
    gate.register_claim(CapabilityClaim(agent_id="lo", provider_id="p",
                                        capabilities={"chat"}, tier="wanderer"))
    gate.register_claim(CapabilityClaim(agent_id="hi", provider_id="p",
                                        capabilities={"chat"}, tier="synthesasia_guild"))
    assert not gate.check("lo", required={"chat"}, tier="deep_dreamer").allowed
    assert gate.check("hi", required={"chat"}, tier="deep_dreamer").allowed


# ── F4: honesty must penalize partial over-claims, not reward overlap ───────────

def test_honesty_penalizes_persistent_overclaim():
    """An agent that has 'chat' but keeps claiming 'admin_delete' it lacks must lose
    honesty — the ANY-overlap metric wrongly kept it at 1.0."""
    gate = CapabilityGate(honesty_floor=0.5)
    gate.register_claim(CapabilityClaim(agent_id="grabby", provider_id="p",
                                        capabilities={"chat"}, tier="wanderer"))
    for _ in range(20):
        gate.check("grabby", required={"chat", "admin_delete"})   # always missing admin_delete
    score = gate.snapshot()["honesty"]["grabby"]["score"]
    assert score < 0.5, f"over-claimer kept honesty {score} (overlap metric masked it)"


# ── F6: capability match canonicalization ──────────────────────────────────────

def test_ccf_capability_match_is_canonical():
    gate = CapabilityGate()
    gate.register_claim(CapabilityClaim(agent_id="a", provider_id="p",
                                        capabilities={"Chat", " save "}, tier="wanderer"))
    # a claim of 'Chat'/' save ' should satisfy required {'chat','save'} after canonicalization
    assert gate.check("a", required={"chat", "save"}).allowed
