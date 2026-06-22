# PCSF — Provider Capacity State Format

**Module:** [`src/convergence_io/pcsf.py`](../../src/convergence_io/pcsf.py) · **Principle:** P4 (Capability Constraints) · **Tests:** [`tests/test_pcsf_ccf.py`](../../tests/test_pcsf_ccf.py)

**Status:** Built and unit-tested. Python reference version; the live chat app does its own provider routing — see the [README](README.md#status-honest).

> **Name note:** "PCSF" here means **Provider Capacity State Format**. An older, never-written doc (`PCSF-PROVIDER-CAPACITY-SAFETY-FRAME.md`) describes the same idea under a different name — *this* is the real, shipped version.

## In one sentence

PCSF keeps track of **which AI providers are healthy right now** and automatically sends each request to the best one that's actually working — falling back down a chain when one is down, slow, or out of quota.

## The everyday version

Think of how your **phone hands off between Wi-Fi, then 5G, then 4G** without you noticing. If the strong connection drops, it quietly steps down to the next one that works, and you just keep going.

PCSF does that for AI providers. The default chain is:

```
Claude → OpenAI → Gemini → Groq → DeepSeek → Ollama (on your machine) → offline fallback
```

It tries them in order and skips any that aren't usable, so the system stays up even when one provider has an outage. And because a core project rule is that **models are interchangeable**, PCSF only ever cares about the *slots* — never a specific model.

## How it decides who's usable

For each provider it tracks a live status — roughly **available, degraded (slow), out of quota, circuit-tripped (too many recent failures), unavailable, or no API key**. A few mechanisms keep that honest:

- **A circuit breaker.** After a few failures in a row, a provider is benched for a cooldown, then gets a single test request to see if it's back. Keep failing and the cooldown gets longer each time.
- **Quota backoff.** Hit a rate limit (a "429") and the provider steps aside for a bit before being retried.
- **No key, no routing.** A provider with no API key configured simply isn't offered.
- **Latency tracking.** It keeps a smoothed average of how fast each provider has been responding.

## Tiers

Users have tiers (`wanderer`, `deep_dreamer`, `synthesasia_guild`). Paid tiers get **priority routing** to the better providers and **higher or unlimited quotas**; the free tier has per-action caps (so many chats or images per period).

## What's in the toolkit

**One provider's live state — `ProviderCapacityState`.** Answers `is_routable()` ("can we use it this second?") and takes the runtime signals that update it: `record_success` (with latency), `record_error` (trips the breaker), and `record_quota_hit` (the rate-limit backoff).

**The router — `ProviderRegistry`.**

- `register(...)` / `check_env(...)` — list the providers and notice which ones actually have keys.
- **`get_routable_chain(tier)`** — the ordered list of providers that are live right now, sorted for the user's tier.
- `check_tier_quota(...)` — the per-tier usage cap.
- `snapshot(tier)` — the full live picture (this is what a status panel would show).

**`default_registry()`** — the preconfigured chain above, ready to go.

## Where it sits in the safety stack

PCSF answers **"where"** — once an action has cleared the denials ([NAP](NAP.md)) and proven its capability ([CCF](CCF.md)), PCSF picks which live provider actually handles it. The choice is still clamped by NAP (a denied provider is never chosen) and by the tier quota. Success / error / quota signals feed back in real time so the picture stays current.

## Status & gaps

- **Working and tested:** smoothed latency, a real circuit breaker, quota backoff, and key-based discovery, directly unit-tested ([`tests/test_pcsf_ccf.py`](../../tests/test_pcsf_ccf.py)).
- **This isn't the router serving 4177 today.** The live chat path is JavaScript and does its own provider fallback; this Python version is the clean reference, not the code currently running the site.
