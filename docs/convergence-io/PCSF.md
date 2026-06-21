# PCSF — Provider Capacity State Format

**Module:** [`src/convergence_io/pcsf.py`](../../src/convergence_io/pcsf.py) · **Principle:** P4 (Capability Constraints) · **Tests:** [`tests/test_pcsf_ccf.py`](../../tests/test_pcsf_ccf.py)
**Status:** Implemented + unit-tested. Python reference contract; the live JS path routes providers itself (see [README](README.md#status-honest)).

> **Naming note:** "PCSF" here is **Provider Capacity State Format**. The often-referenced but
> never-written `docs/PCSF-PROVIDER-CAPACITY-SAFETY-FRAME.md` describes the same family under a
> different gloss — this is the real, shipped contract.

## What it is

PCSF tracks **which providers are available, degraded, or exhausted** and routes requests through
a fallback chain with **circuit breakers and quota awareness**. It operationalizes the master
plan's capacity fallback:

```
Claude → OpenAI → Gemini → Ollama → offline persona fallback
```

Models are replaceable (Σ₀ principle #3): PCSF is *about* the slots, never a specific model.

## Core types / API

- **`ProviderState`** (enum) — available / degraded / exhausted lifecycle.
- **`ProviderCapacityState`** — per-provider live state:
  - `is_routable()` — may we send to it right now?
  - `record_success(latency_ms, ema_alpha=0.2)` — EMA-smoothed latency tracking.
  - `record_error(msg, failure_threshold=3, recovery_secs=30)` — **circuit breaker**: trip after
    N failures, auto-probe for recovery after a cooldown.
  - `record_quota_hit(recovery_secs=60)` — quota/429 backoff.
  - `to_dict()`.
- **`DreamerTier`** (enum) — user tiers; quota limits are per-tier.
- **`ProviderRegistry`** — the router:
  - `register(provider_id, env_key=None, priority=None)` / `check_env(env_getter)` — discover which
    providers are configured (a provider with no key is simply not routable).
  - `get_routable_chain(tier="wanderer")` — the ordered fallback chain, filtered to live providers.
  - `check_tier_quota(tier, action, current_count)` — per-tier quota gate.
  - `record_success / record_error / record_quota_hit(provider_id, ...)` — feed runtime signals.
  - `snapshot(tier)` — observable status (this is what a status panel renders).
- **`default_registry()`** — the preconfigured Claude→OpenAI→Gemini→Ollama chain.

## How it composes

PCSF answers **"where"** — given an action that already cleared NAP (provider not denied) and CCF
(capability proven), which live provider gets it. The chain is clamped by NAP's `denies_provider`
and by per-tier quota. Latency/error/quota signals feed back so the breaker state is current.

## Status & gaps

- Implemented with EMA latency, a real circuit breaker, quota backoff, and env-driven discovery;
  directly unit-tested in [`tests/test_pcsf_ccf.py`](../../tests/test_pcsf_ccf.py).
- The **live** chat path (`lib/stream-chat.js`) is JS and does its own provider fallback; this
  Python `ProviderRegistry` is the typed reference, not the runtime currently serving 4177.
