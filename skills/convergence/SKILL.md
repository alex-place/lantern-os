---
name: convergence
description: The Converge stage as a usable skill. Synthesizes recent memory/notes into one grounded insight, anchors every forward-looking claim in live web evidence (Σ₀ external-reality rule), and appends an evidence-bearing Convergence Record. Backs the `!convergance` chat command.
---

# Convergence (grounded synthesis + records)

Status: active — backs the live `!convergance` chat command
Loop stage: **Converge** (and Verify, via mandatory grounding)
Source: `apps/lantern-garage/lib/dream-chat.js` (`handleConvergenceCommand`, `_deriveConvergenceQuery`, `_appendConvergenceRecord`); records in `data/convergence/records.jsonl`

## Simple Answer

The Converge stage of the one loop, exposed as a command. Given recent dream/note entries it produces **one** coherent insight about patterns and direction of travel — but, per the Σ₀ external-reality rule, it does not bluff: any forward-looking suggestion is grounded in a live web search and cited, and the result is written back as a Convergence Record with its evidence, sources, and an honest confidence.

## What It Actually Does

- **`!convergance`** — synthesize the dreamer's recent entries into a single grounded observation. A query is derived from the salient themes of those entries (`_deriveConvergenceQuery`, deterministic, no extra LLM call), the live web is searched (`webSearch`: MCP → keyless DuckDuckGo/Wikipedia fallback), and the sources are injected so the synthesis cites `[n]` references rather than inventing direction.
- **`!convergance <topic>`** — same, but ground the synthesis on an explicit topic instead of the auto-derived themes.
- **`!convergance log an issue <title>`** — file a GitHub issue from the loop (shell-free via `safeExec`, so the title can't escape to a shell).
- Every run appends a **Convergence Record** to `data/convergence/records.jsonl`:
  `{ hypothesis, evidence:[entries…, source URLs…], sources, grounded, grounding_query, result, confidence, verified, loop_stage:"Converge", tags }`.

## Evidence / Source Discipline (Σ₀)

- **Grounded vs. ungrounded is explicit.** When live sources are found the record is `grounded:true`, `verified:true`, and earns higher confidence. When search fails or returns nothing, the synthesis degrades honestly to `grounded:false`, `verified:false`, confidence capped low, tag `ungrounded` — the record never overstates an un-anchored claim.
- **Claim → evidence → source.** Evidence carries both the dreamer's own entries and the external source URLs used; `sources` holds the URLs.
- No new dependencies — reuses the chat's existing `web-search-client` grounding helpers.

## Proven / Held / Local-Only

**Proven:** the grounding helpers (`webSearch`, `formatGroundingContext`) are the same battle-tested path the main chat tool loop uses (#1212).
**Held:** end-to-end UI verification requires a running server + a served local model + network; the synthesis text quality depends on the active provider.
**Local-only:** Convergence Records are append-only on the operator's machine — they are the persistent, retrieval-based learning substrate, never used to retrain weights.

## Relation to the loop

This is the canonical Converge surface. It must not grow into a separate engine: one synthesis path, one record store (`data/convergence/records.jsonl` + CSF archive). See [docs/BACKLOG-REVIEW-STANDARDS.md](../../docs/BACKLOG-REVIEW-STANDARDS.md) for how a backlog review pass is itself a Converge turn.
