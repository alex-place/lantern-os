# NAP — Negative Authority Profiles

**Module:** [`src/convergence_io/nap.py`](../../src/convergence_io/nap.py) · **Principle:** P2 (Authority / Consent), *denial form* · **Composes:** M1 (Dynamic External Predicates)

**Status:** Built and unit-tested. Python reference version; the live chat app (JavaScript) doesn't call it directly — see the [README](README.md#status-honest).

## In one sentence

NAP is the system's list of hard **"no"s** — the things an agent is flatly forbidden to do — and the key rule is that **nothing can talk its way around them.**

## The everyday version

Think of the **"we don't serve alcohol to minors" rule** behind a bar. It doesn't matter how good the customer's story is, how much they'll pay, or how much of a regular they are — the rule is a wall, not a suggestion. No amount of "but I'm allowed because…" gets through.

Most of the safety stack is about proving you *can* do something. NAP is the opposite: it's the short list of things that are simply off-limits, and it always wins. If a NAP rule says no, the action stops — even if every other check said yes.

## The four things a "no" can be about

A single denial profile can forbid things along four lines:

| It can deny… | Example |
|---|---|
| an **action** | placing a financial trade, deleting data, entering credentials |
| a **provider** | "never send anything to this cloud vendor" |
| a **boundary** | "nothing leaves the device" (no cloud at all) |
| a **data type** | "never touch a Social Security number or a medical diagnosis" (ties into [DCF](DCF.md)) |

Two ready-made profiles ship with the code:

- **`dreamer_safety_nap()`** — the baseline for anything a user touches: no financial, medical, or child-identity actions.
- **`local_only_nap()`** — the "stay offline" setting: blocks every cloud provider, so all traffic stays on your machine.

External blocklists (like government sanctions lists) can also be loaded in as NAP rules and refreshed on a schedule. If that source ever goes unreachable, the system **keeps the last known "no"s** rather than quietly dropping them — it fails safe, not open.

## What's in the toolkit

**A denial profile — `NegativeAuthorityProfile`.** One set of "no"s. It can answer `denies_action`, `denies_provider`, `denies_boundary`, and `denies_data_class`; it knows when it `is_expired` (some rules are temporary, e.g. a refreshed external list); and `can_override(tier)` says whether a high enough user tier is allowed to bypass *this particular* rule (truly hard denials say no to everyone).

**The enforcement point — `AuthorityGate`.** Holds all the active profiles (`add_profile` / `remove_profile`) and runs the actual check. `check(...)` returns a result saying **whether it was denied, which profile denied it, and why.**

## Where it sits in the safety stack

NAP runs **before** the capability check ([CCF](CCF.md)) — a "no" is a floor that capability can't lift. It also clamps provider routing ([PCSF](PCSF.md)): a denied provider is never chosen, even if it's the only one left. In that case the request **fails closed** (stops) rather than reaching for something forbidden.

## Status & gaps

- **Working and tested.** All four denial types, the tier-override rule, and the fail-safe behavior are covered by the convergence-io test suite ([`tests/test_convergence_io.py`](../../tests/test_convergence_io.py)).
- **NAP enforces lists; it doesn't fetch them.** The machinery to download and refresh external blocklists (sanctions lists and the like) lives elsewhere — NAP just enforces the entries it's handed.
