# DCF — Data Classification Format

**Module:** [`src/convergence_io/dcf.py`](../../src/convergence_io/dcf.py) · **Principle:** P1 (Data Classification) · **Gates:** CCF
**Status:** Implemented + unit-tested. Python reference contract; the production JS chat path does not import it directly (see [README](README.md#status-honest)).

## What it is

Every datum the system touches carries a **class label**, and labels **propagate through
transformations** — *a summary of a FERPA record is still a FERPA record*. DCF is the
bookkeeping that makes that propagation explicit, so downstream gates (CCF, NAP) can decide
what may be done with a piece of data without re-inspecting its contents.

For the Dream Journal product the primary classes are:

| Label | Meaning |
|---|---|
| `dream_content` | user dreams — personal, not medical |
| `user_identity` | dreamer name, email |
| `symbolic_data` | symbols, lore, characters — user-created world-building |
| `system_metadata` | timestamps, agent selections, session state |

## Core types / API

- **`ClassificationLabel`** — a label *definition*: name + sensitivity + retention policy.
  `to_dict()` for serialization.
- **`DataClassification`** — the label *set* attached to one datum:
  - `add_label(label)` / `has_label(label)`
  - `has_any_sensitive(sensitive_labels=None)` — does this datum carry any sensitive class?
  - `is_retained(label_definitions=None)` — is it inside its retention window?
  - `derive(new_datum_id, propagating_labels=None)` — **the propagation primitive**: produce
    the classification of a *derived* datum, carrying forward the labels that must propagate.
  - `to_dict()`.

## How it composes

DCF is the **input gate** of the stack: CCF ([CCF.md](CCF.md)) checks an agent's capability
*against the class of the data it wants to act on*, and NAP ([NAP.md](NAP.md)) can deny actions
on a `data_class`. Classify first, then gate.

## Status & gaps

- Implemented with a clean dataclass contract; covered by the convergence-io suite
  ([`tests/test_convergence_io.py`](../../tests/test_convergence_io.py)).
- Label *definitions* (sensitivity + retention) are caller-supplied — there's no shipped
  central registry of label policy yet; `is_retained` / `derive` accept the definitions per call.
