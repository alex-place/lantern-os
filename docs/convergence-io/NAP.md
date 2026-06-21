# NAP — Negative Authority Profiles

**Module:** [`src/convergence_io/nap.py`](../../src/convergence_io/nap.py) · **Principle:** P2 (Authority / Consent Gates), *denial form* · **Composes:** M1 (Dynamic External Predicates)
**Status:** Implemented + unit-tested. Python reference contract; not imported by the live JS chat path (see [README](README.md#status-honest)).

## What it is

NAP is the **inverse of a capability claim**: it defines what agents are *explicitly denied*
from doing. The load-bearing rule —

> **A hard denial cannot be overridden by a capability claim.** Denials are enforcement
> boundaries, not preferences.

It composes with **M1**: external deny-lists (OFAC SDN, BIS Entity List, etc.) can be loaded as
NAP entries and refreshed on a schedule. When a source is unreachable the runtime **degrades
safely** (keeps the last known denials rather than failing open).

## Core types / API

- **`NegativeAuthorityProfile`** — one denial profile:
  - `denies_action(action_type)` · `denies_provider(provider_id)` · `denies_boundary(boundary)` · `denies_data_class(label)` — the four denial axes (composes with [DCF.md](DCF.md) via `denies_data_class`).
  - `is_expired()` — time-boxed profiles (e.g. a refreshed external list).
  - `can_override(tier)` — whether a given [tier](PCSF.md) may override this profile (hard denials return `False` for everyone).
  - `to_dict()`.
- **`AuthorityGate`** — the enforcement point:
  - `add_profile(profile)` / `remove_profile(profile_id)`
  - `check(action_type, provider_id="", boundary=..., data_class=..., tier=...) → AuthorityResult`
  - `active_profiles()` — introspection.
- **`AuthorityResult`** — `{allowed, denied_by, reason, ...}`.
- Factories: **`dreamer_safety_nap()`** (baseline Dream-Journal safety denials) and
  **`local_only_nap()`** (deny all non-local providers — the offline/sovereign profile).

## How it composes

NAP runs **before** CCF in the gate order: a denial is a hard floor under capability. PCSF's
fallback chain is also clamped by NAP (`denies_provider`), so a denied provider is never selected
even if it's the only routable one — the request fails closed instead.

## Status & gaps

- Implemented with the four denial axes + override-by-tier + safe-degrade contract; covered by
  [`tests/test_convergence_io.py`](../../tests/test_convergence_io.py).
- The M1 external-list *loaders* (the actual OFAC/BIS fetch + schedule) are referenced by the
  contract but are a separate ingestion concern — NAP consumes entries, it doesn't fetch them.
