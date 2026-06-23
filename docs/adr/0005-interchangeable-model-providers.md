---
adr: 0005
title: Models are interchangeable — provider abstraction with fallback
status: Proposed
date: 2026-06-23
deciders: Alex Place
approved-by: pending
supersedes: none
superseded-by: none
---

# ADR-0005: Models are interchangeable — provider abstraction with fallback

## Status

Proposed — awaiting approval from Alex Place.

## Context

The North Star is explicit: **models are replaceable; never hardcode a provider** — the
Convergence Core must never assume a specific LLM. Reasons: providers change pricing and
availability, the project runs a local Σ₀/Ouro model that must slot in as a peer, and vendor
lock-in would couple the loop's Reason stage to one company's uptime.

Without abstraction, every call site would `require('@anthropic-ai/...')` directly and a single
outage or key problem would break chat ("all providers failed").

## Decision

Providers are **data, not code**. The declared providers, fallback order, and default models
live in the PCSF layer: `data/pcsf/provider.pcsf.json` (the registry — a **gitignored runtime
file**, documented in [PROVIDERS.md:17](../PROVIDERS.md)) plus the committed model roster
[`data/pcsf/model.pcsf.json`](../data/pcsf/model.pcsf.json) (default + available models per
provider). The server reads `.env` for keys at startup and supports **hot reload** via
`POST /api/settings/providers` without a restart ([PROVIDERS.md:17-22](../PROVIDERS.md)).

All LLM calls route through a selector (`provider-router.js` / `selectProvider`,
imported by [`dream-chat.js`](../apps/lantern-garage/lib/dream-chat.js)) with a defined
**fallback chain**: Gemini → Claude → OpenAI → Ollama (local Σ₀/Ouro at
`http://127.0.0.1:11434`, default `ouro:latest`) ([PROVIDERS.md:156-161](../PROVIDERS.md),
[`dream-chat.js:430-431`](../apps/lantern-garage/lib/dream-chat.js)). No module hardcodes a
single provider as a hard dependency.

## Options Considered

### Option A: Config-driven registry + fallback chain (chosen)
**Pros:** swap models without code changes; local model is a first-class peer; one outage degrades
gracefully; keys hot-reload.
**Cons:** an indirection layer to maintain; declared-but-unwired providers can imply capability
the code lacks (see debt).

### Option B: Direct SDK calls per site (rejected)
**Cons:** violates the North Star; lock-in; brittle to outages; the local model can't substitute
cleanly.

## Trade-off Analysis

The abstraction costs a small indirection and the risk of config/code drift. In exchange the
project gets the single most load-bearing North Star property — interchangeability — which is
what lets the local Σ₀ model and any future model plug in without touching the loop.

## Consequences

- **Positive:** models swap via config; graceful fallback; local-first inference is a peer, not a
  special case.
- **Negative / trade-offs:** the registry can list providers that aren't actually wired.
- **Follow-ups:** [ARCHITECTURE.md §9.4](../ARCHITECTURE.md#9-known-divergences--debt) — Grok,
  Mistral, Cohere, Perplexity are declared in PCSF but not in the fallback chain
  ([PROVIDERS.md:167-170](../PROVIDERS.md)); either wire them or mark them clearly as future.

## Alternatives considered

See Options. "Do nothing" (hardcode the current best model) is the lock-in the North Star forbids.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| Providers declared as data (PCSF) | `data/pcsf/provider.pcsf.json` (gitignored runtime) + committed [`model.pcsf.json`](../data/pcsf/model.pcsf.json); [PROVIDERS.md:17](../PROVIDERS.md) | High | code + doc |
| Calls route through a selector | `provider-router.js` import in [`dream-chat.js:9`](../apps/lantern-garage/lib/dream-chat.js) | High | code |
| Fallback chain Gemini→Claude→OpenAI→Ollama | [PROVIDERS.md:156-161](../PROVIDERS.md) | High | doc |
| Local model is a peer in the chain | [`dream-chat.js:430-431`](../apps/lantern-garage/lib/dream-chat.js) | High | code |
| Keys hot-reload without restart | [PROVIDERS.md:22](../PROVIDERS.md) | Medium | doc |
| Never hardcode a provider | [CONVERGANCE-SIGMA0-BRIEFING.md](../CONVERGANCE-SIGMA0-BRIEFING.md) #3 | High | project doc |
