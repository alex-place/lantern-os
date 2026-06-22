# AAPF — Agent Action Provenance Format

**Module:** [`src/convergence_io/aapf.py`](../../src/convergence_io/aapf.py) · **Principle:** P3 (Provenance / Audit) · **Consumed by:** P6 (Subject Rights), P7 (Incident Response), P9 (Reporting)

**Status:** Built and unit-tested. Python reference version; the live chat app (JavaScript) doesn't call it directly — see the [README](README.md#status-honest).

## In one sentence

Every time an agent does something, AAPF writes down **who did what, to which data, using which provider, and how it turned out** — a permanent receipt you can read back later without re-running anything.

## The everyday version

Think of a **security camera plus a sign-in sheet** for the whole system. After the fact, you can answer "who touched this, when, and what happened?" just by reading the log — you don't have to reconstruct the day from memory.

That matters because three big jobs are really just questions asked of this one log: answering a user's "what do you have on me?" request, investigating something that went wrong, and routine reporting.

## What gets written down

Each entry (an `ActionRecord`) is one line in an append-only log, capturing the full story of a single action:

- **Who** — the agent, the provider, and the model behind it.
- **What** — the kind of action, plus short summaries of what went in and what came out.
- **On what** — the data types involved ([DCF](DCF.md)) and which safety checks ran ([NAP](NAP.md) / [CCF](CCF.md)).
- **How it went** — succeeded / errored / denied / timed out, how long it took, and the user's tier and consent state.
- **A tamper-check** — a SHA-256 fingerprint of the record, so you can tell if an entry was altered after the fact.

## What's in the toolkit

**One receipt — `ActionRecord`.** A single logged action, with everything above. `to_dict()` turns it into a line of JSON (and fills in the fingerprint).

**The logbook — `ProvenanceLedger`.** The append-only store, optionally backed by a file on disk (one JSON object per line, matching the project's "never overwrite memory" rule):

- **`record(action)`** — add one receipt to the end.
- **`query(...)`** — read back a filtered slice (by agent, by action type, since a given time) for audits or user-data requests.
- **`count_by_status()`** — a quick tally of how many actions succeeded, failed, or were denied.

## Where it sits in the safety stack

AAPF is the **last** step. After an action clears classification ([DCF](DCF.md)), denials ([NAP](NAP.md)), capability ([CCF](CCF.md)), and routing ([PCSF](PCSF.md)), it leaves a receipt behind. Because each receipt already records the actor, the data, the provider, and the outcome, it's the single place that can answer "who did what to which data, and why" — with no replay needed.

## Status & gaps

- **Working and tested.** Fingerprinted records plus a file-backed logbook with query and tally, covered by the convergence-io test suite ([`tests/test_convergence_io.py`](../../tests/test_convergence_io.py)).
- **The readers aren't built yet.** The user-data export, the incident workflow, and the scheduled reports are all *meant* to be queries over this logbook — but they're planned views, not shipped screens.
