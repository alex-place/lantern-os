"""Tests for the PCSF circuit-breaker fix + CCF gate hardening (#765, part of #764)."""
import time

import pytest

from src.convergence_io.pcsf import ProviderCapacityState, ProviderState, ProviderRegistry
from src.convergence_io.ccf import CapabilityGate, CapabilityClaim


# ── PCSF: the core AttributeError bug ──────────────────────────────────────────

def test_record_success_does_not_raise_and_seeds_ema():
    """The bug: record_success read self.latency_p50_ms (never declared) → AttributeError
    on every provider's FIRST success, silently routing healthy providers to fallback."""
    pcs = ProviderCapacityState(provider_id="anthropic")
    pcs.record_success(100.0)                      # must not raise
    assert pcs.state is ProviderState.AVAILABLE
    assert pcs.latency_ema_ms == pytest.approx(100.0)   # first sample seeds the EMA
    assert pcs.success_count == 1


def test_record_success_ema_blends():
    pcs = ProviderCapacityState(provider_id="x")
    pcs.record_success(100.0)
    pcs.record_success(200.0)                      # EMA = 0.2*200 + 0.8*100 = 120
    assert pcs.latency_ema_ms == pytest.approx(120.0)


def test_to_dict_reports_ema_not_p50():
    pcs = ProviderCapacityState(provider_id="x")
    pcs.record_success(50.0)
    d = pcs.to_dict()
    assert d["latency_ema_ms"] == pytest.approx(50.0)
    assert "latency_p50_ms" not in d


# ── PCSF: circuit breaker + exponential backoff ────────────────────────────────

def test_circuit_opens_after_threshold_and_blocks():
    pcs = ProviderCapacityState(provider_id="x")
    for _ in range(3):
        pcs.record_error("boom")                   # default threshold 3
    assert pcs.state is ProviderState.CIRCUIT_OPEN
    assert pcs.is_routable() is False              # recovery timer in the future


def test_circuit_half_open_after_timer():
    pcs = ProviderCapacityState(provider_id="x")
    for _ in range(3):
        pcs.record_error("boom")
    pcs.circuit_recovery_at = time.time() - 1.0    # timer elapsed → half-open probe allowed
    assert pcs.is_routable() is True


def test_circuit_backoff_doubles_per_trip():
    pcs = ProviderCapacityState(provider_id="x")
    for _ in range(3):
        pcs.record_error("boom")                   # first trip: window ~30s, level→1
    w1 = pcs.circuit_recovery_at - pcs.last_error_at
    pcs.record_error("boom again")                 # failed half-open probe: window ~60s, level→2
    w2 = pcs.circuit_recovery_at - pcs.last_error_at
    assert pcs.recovery_backoff_level == 2
    assert w2 == pytest.approx(2 * w1, rel=0.05)


def test_success_resets_circuit_and_backoff():
    pcs = ProviderCapacityState(provider_id="x")
    for _ in range(4):
        pcs.record_error("boom")
    pcs.record_success(120.0)
    assert pcs.state is ProviderState.AVAILABLE
    assert pcs.error_count == 0
    assert pcs.recovery_backoff_level == 0
    assert pcs.circuit_recovery_at is None and pcs.quota_recovery_at is None
    assert pcs.is_routable() is True


# ── PCSF: quota-hit recovery timer (mirrors circuit) ───────────────────────────

def test_quota_hit_blocks_then_half_opens():
    pcs = ProviderCapacityState(provider_id="x")
    pcs.record_quota_hit(recovery_secs=60.0)
    assert pcs.state is ProviderState.QUOTA_HIT
    assert pcs.is_routable() is False
    pcs.quota_recovery_at = time.time() - 1.0      # timer elapsed
    assert pcs.is_routable() is True


# ── CCF gate: honesty floor + PCSF routability ─────────────────────────────────

def _claim(agent="a", provider="anthropic", caps=("chat",)):
    return CapabilityClaim(agent_id=agent, provider_id=provider, capabilities=set(caps))


def test_gate_denies_below_honesty_floor():
    gate = CapabilityGate(honesty_floor=0.5)
    gate.register_claim(_claim())
    for _ in range(20):                            # 0 hits / 20 → score ≈ 3/23 ≈ 0.13
        gate._honesty.record_result("a", {"chat"}, set())
    res = gate.check("a", {"chat"})
    assert res.allowed is False
    assert "honesty" in res.reason


def test_gate_denies_when_provider_not_routable():
    reg = ProviderRegistry()
    reg.register("anthropic")
    for _ in range(3):
        reg.record_error("anthropic", "boom")      # circuit open → not routable
    gate = CapabilityGate(pcsf_registry=reg)
    gate.register_claim(_claim())
    res = gate.check("a", {"chat"})
    assert res.allowed is False
    assert "not routable" in res.reason


def test_gate_allows_when_routable_and_honest():
    reg = ProviderRegistry()
    reg.register("anthropic")
    reg.record_success("anthropic", 50.0)          # AVAILABLE → routable
    gate = CapabilityGate(pcsf_registry=reg)
    gate.register_claim(_claim())
    res = gate.check("a", {"chat"})
    assert res.allowed is True


def test_gate_backward_compatible_without_pcsf():
    gate = CapabilityGate()                         # no registry, default floor
    gate.register_claim(_claim())
    assert gate.check("a", {"chat"}).allowed is True
    assert gate.check("a", {"chat", "vision"}).allowed is False   # missing cap still denied
