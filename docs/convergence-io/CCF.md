# CCF — Capability Claim Format

**Module:** [`src/convergence_io/ccf.py`](../../src/convergence_io/ccf.py) · **Principle:** P4 (Capability Constraints) · **Consumed by:** P5 (Boundary), P8 (Vendor Chain), P10 (Supply Chain) · **Tests:** [`tests/test_pcsf_ccf.py`](../../tests/test_pcsf_ccf.py)
**Status:** Implemented + unit-tested. Python reference contract; not on the live JS path (see [README](README.md#status-honest)).

## What it is

An agent must **prove at action time** that it has the capability it claims — capability is not
assumed from identity or config. A `CapabilityClaim` is the runtime record of *what an agent can
actually do right now*; a `CapabilityGate` checks claims before letting an action proceed. This is
the enforcement of "no overclaiming" (the Σ₀ External Reality Rule) at the action boundary.

## Core types / API

- **`CapabilityClaim`** — what an agent asserts it can do:
  - `verify()` — validate the claim (returns the verified claim).
  - `is_expired()` — claims are time-boxed; a stale claim is not a live capability.
  - `has_capability(cap)` — does this claim cover a specific capability?
  - `to_dict()`.
- **`HonestyTracker`** — measures claim-vs-reality drift per agent:
  - `record_result(agent_id, expected_caps, actual_caps)` — log what was claimed vs what actually happened.
  - `score(agent_id, window=20)` — rolling honesty score over the last N actions.
  - `snapshot()`.
- **`CapabilityGate`** — the checkpoint:
  - `CapabilityGate(honesty_floor=0.5, pcsf_registry=None)` — wires to [PCSF](PCSF.md) so capability
    can depend on a live provider, and refuses agents below the honesty floor.
  - `register_claim(claim)` · `check(agent_id, required, boundary=None, ...) → GateResult`.
  - `snapshot()`.
- **`GateResult`** — `{allowed, reason, ...}`.

## How it composes

CCF sits **after** DCF and NAP, **with** PCSF: DCF classifies the data, NAP can hard-deny, then CCF
asks "does this agent provably hold the required capability for this data class — and is it honest
enough (≥ `honesty_floor`) and is its provider live (via `pcsf_registry`)?" P5/P8/P10 (boundary,
vendor chain, supply chain) read these claims to reason about *who* and *what* is in the loop.

## Status & gaps

- Implemented with time-boxed claims, an honesty floor, a PCSF link, and a gate result contract;
  directly unit-tested in [`tests/test_pcsf_ccf.py`](../../tests/test_pcsf_ccf.py).
- The honesty signal is only as good as what callers feed `record_result` — it's a runtime
  feedback contract, not an oracle; nothing auto-populates it on the live path yet.
