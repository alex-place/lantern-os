# Keystone Cockpit — the human-in-the-loop spine

**Status: BUILT + TESTED (2026-06-25).** Core in [`src/keystone/cockpit.py`](../src/keystone/cockpit.py);
8 tests in [`tests/test_keystone_cockpit.py`](../tests/test_keystone_cockpit.py).

The personal-AI flow Keystone is built around:

```
You ask Keystone
→ it identifies the task and the evidence it needs
→ it gathers from local files / web / email / calendar / MCP / an approved model
→ it shows what it found and what it plans to do
→ you approve anything that SENDS, SCHEDULES, SUBMITS, SPENDS, or CHANGES records.
```

Keystone never assumes it can submit an application, book an appointment, or email someone
without showing you the final action first.

## Two human-in-the-loop gates

### 1. Profile — durable but editable

A store of personal facts: resume facts, family scheduling preferences, insurance details you
choose to store, preferred doctors/dentists, active applications. Every fact is one of:

- **approved** — durable, trusted as truth (the cockpit acts on it);
- **proposed** — held; gathered or inferred by Keystone but **not trusted until you approve**
  (confidence capped at 0.7).

The save **only happens on approval** (`Profile.approve`). Facts are editable; persistence is
append-only JSONL (last value per key wins on load), so an edit never destroys history — the
convergence rule. (`Profile`)

### 2. ActionGate — nothing mutating runs without approval

Actions whose kind is `send` / `schedule` / `submit` / `spend` / `change_records` are **held**
(`needs_approval`, not executable) until you approve them. Read / lookup / draft / plan
actions are shown but need no approval. (`Cockpit.propose_action` / `approve_action` /
`pending_actions`)

This is the same *denial-overrides-capability* shape as
[NAP](convergence-io/NAP.md): an action is held unless explicitly approved — capability alone
never authorizes a mutation.

## The Question Machine, here

When Keystone lacks a key fact for a task — *"Which CareSource role?"*, *"What insurance
plan?"*, *"Who needs the dentist appointment?"* — it surfaces the **smallest useful
question**: the single highest-priority missing fact, **one at a time**, in the task's
declared priority order (`Cockpit.next_question`). You answer; the answer is saved as durable
**only when you approve** it (`Cockpit.answer(..., approve=True)`); the question machine then
advances to the next gap, or reports the task `ready`.

This is the [Question Machine](research/question-machine.md) principle — *ask the
highest-leverage admissible question* — applied to personal facts instead of a numeric goal
vector. A `TaskSpec` declares what facts a task `needs`; the cockpit computes what's `missing`
and asks for exactly the next thing, never a wall of forms.

## The transparency surface

`Cockpit.plan(task)` returns *what it found* (approved evidence), *the smallest useful
question* still open, whether the task is `ready`, and *what it plans to do* (pending actions
held for approval) — the "shows what it found and what it plans" step, as data.

## Honest scope

This is the **spine**, not the integrations. The cockpit decides *what to ask* and *what to
hold for approval*; the organs that actually gather (local files, web, email, calendar, MCP)
and execute (send/schedule/submit) plug in as the grounding/action layer — the same
`Channel`/Act-stage gap noted for the [grounded loop](research/question-machine.md). What's
real and tested today: the profile (approved vs proposed, editable, durable), the
smallest-useful-question surfacing, and the action gate.
