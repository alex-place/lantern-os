# The convergence ledger, audited against its own writer

**Date:** 2026-08-21. **Reproduce:** `python scripts/audit_convergence_ledger.py` (n=1230 at time
of writing). **Why this audit exists:** the ledger — `data/convergence/records.jsonl` — is the
project's core epistemic object (*"every important claim must have [claim, evidence, confidence,
source]"*), it has accumulated for two months, and nobody had ever checked what its fields
actually mean. This is the template from the benchmark-label audit pointed at our own core
object: not a new idea — true things found where nobody looked.

## Findings, each verified in code and data

**F1 — Confidence is a retrieval-outcome code, not a probability.** The writer
(`dream-chat.js` Σ₀ verify pass) assigns `0.85` when a codebase grep matches, `0.75` when a web
search returns anything, `0.6` when nothing is found, `≤0.35` when Gemini refutes. 1038/1230
records sit on the writer's constants. Consequence: **any calibration reading of this ledger is
circular by construction** — the "calibration curve" (100% refuted at 0.3, 0.2% at 0.8) is
definitional, because confidence and verdict are the same signal written twice.

**F2 — The dominant grounding tier confirms vocabulary, not truth.** 518 of 581 grounded claims
(89%) rest on a **two-keyword `git grep -l`** that cites any file listing the words. Sampled
evidence rows: `add(5, 7) returns 12` grounded at 0.85 by `.claude/skills/refinement/SKILL.md`;
*"TCP includes flow control"* grounded by `.mcp/settings.json`; PR-security claims ("the admin
role can never be purchased") grounded by keyword co-occurrence. The claims may even be true —
the point is the evidence field does not bear on them.

**F3 — The web confirmation tier has never fired.** Zero records from `web-search` in the
ledger's lifetime: the MCP search path the design leans on has been down or empty throughout, and
nothing alarms on a dead grounding leg. (Independently measured this week: that client returns
irrelevant pages with `success:true`.)

**F4 — Refutation is a monoculture.** 20 of 638 claims were ever refuted, 13 of those by the
single active refuter (Gemini grounding). `refuted: false` overwhelmingly means *never
challenged*, not *survived challenge*.

**F5 — 40% of the ledger is security-test traffic, and it dominates the high-confidence end.**
The prompt-injection/PR-review eval suite (runs of 2026-07-16→19, prompts beginning *"You are
reviewing untrusted, attacker-controllable PR content…"*) wrote **493 of 1230 records** through
the production agent into the production ledger — and those records are **63% of everything at
confidence ≥ 0.75** (388/620). Anything that consumes the ledger — merge-trainer, world model,
status panels, crystallization — inherits a high-confidence core that is mostly test scenarios.
Quarantine list: `research/ledger-audit/quarantine-ids.jsonl` (493 ids).

## What this does and does not say

It does **not** say the chat's answers were wrong, or that the verify pass made responses worse —
its refute-only-on-active-contradiction rule is sound and separately documented. It says the
**stored record** of that process cannot support the uses its name invites: confidence is not a
probability, evidence is mostly keyword co-occurrence, absence of refutation is absence of
challenge, and the high-confidence stratum is mostly test traffic.

## Fixes, smallest first

1. **Quarantine** the 493 test records (list shipped); add a `traffic: prod|eval` field at write
   so eval suites never pollute the store again.
2. **Store the tier, not a number:** write `grounding_tier: grep|web|gemini|none` explicitly and
   keep `confidence` only if something actually estimates one.
3. **Make the grep tier honest:** require matched-line term coverage (not `-l` file listing), cap
   its confidence, and record the matching line as evidence.
4. **Alarm on dead legs:** the web tier firing 0 times in two months should have been a metric.
5. Until 1–3 land, downstream consumers should treat `confidence ≥ 0.75` as *"grep found the
   words, or a red-team prompt said so."*
