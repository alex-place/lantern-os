---
adr: 0009
title: One routing contract — cloud-primary for coding, local as verified backstop
status: Accepted
date: 2026-06-28
deciders: Alex Place
approved-by: Alex Place (2026-06-28)
supersedes: none
superseded-by: none
---

# ADR-0009: One routing contract — cloud-primary for coding, local as verified backstop

## Status

Accepted — approved by Alex Place on 2026-06-28.

### Note on the kernel verify-gated path (added on acceptance)

Reviewing the call sites on acceptance clarified that the kernel coding path
(`lib/stream-chat.js` ~line 378, `KEYSTONE_LOCAL_FIRST`, policy #1207) runs
local-first **but verify-gated** (`requireVerified`): a local coding result is
only served if it passes verification, otherwise it escalates to the cloud
teacher (#1197). This is **not** in conflict with this ADR — it is the concrete
implementation of **Rule 4** (local is the *verified* backstop). What the
contract forbids is serving *unverified* local output for coding (the #1167 bug),
which #1197 already eliminated. `CONVERGENCE_CHAT` (off by default) and
`LOCAL_CAPABILITY_FIRST` (selects *which* local model, not cloud-vs-local) are
retained as documented escape hatches / orthogonal knobs, not contradictions.

The routing flags are therefore centralized in `lib/route-contract.js` as the
single home (`resolveCodingRoute`, `kernelCodingLocalFirst`); changing any live
*default* remains gated on real-chat-UI verification per the user-path rule.

## Context

A competitive read against Claude Code, Codex, Cursor, Copilot, Cline, OpenHands,
and Aider surfaced a contradiction in our own kernel: **two routing policies
coexist, and the decision is smeared across environment variables and comments in
separate code paths** rather than stated once.

The conflicting signals, as landed today:

- **Coding is already cloud-first.** `lib/stream-chat.js` (the "locked design
  2026-06-26", ~line 1445) leads a coding intent in Auto mode with a cloud coder
  when an API key exists, with Ollama appended only as the offline backstop.
  Escape hatch: `CODING_LOCAL_FIRST=1`.
- **General chat still defaults local-first.** `lib/stream-chat.js` (~line 377)
  runs the local Ollama ladder first unless `KEYSTONE_LOCAL_FIRST=0`.
- **A third path exists** behind `CONVERGENCE_CHAT=1`, plus the provider-router /
  Σ₀ gate that computes a `primaryProviderHint`, plus `LOCAL_CAPABILITY_FIRST=1`
  in `lib/local-model-registry.js`.

The result: four environment variables and two subsystems jointly decide who
leads a turn, with no single authoritative statement of the contract.

### Evidence (External Reality Rule)

The choice is not a toss-up — the evidence is one-sided:

| Claim | Evidence | Source |
|---|---|---|
| The local coder cannot code | Ouro-1.4B scores ~0/5 on HumanEval through the chat harness | #1263, `eval_humaneval_chat.py` |
| The local chat path is unstable | Recurring crash/hang reports on the Ollama fallback path | #1366, #1369, #1374 |
| Local replies degrade silently | Multilingual word-salad collapse not caught by the canary | #1342 |
| Cloud keys are intermittently unfunded | Autowork runs only on Vertex; API-key providers periodically out of credits | memory: autowork-vertex-provider |
| Local ownership is a first principle | Σ₀ briefing principle #6 | CONVERGANCE-SIGMA0-BRIEFING.md |

So reliability and quality point to **cloud-primary for coding**, while the
local-ownership North Star forbids abandoning local entirely. The resolution must
honor both: cloud leads for coding when healthy; local remains a first-class,
*verified* fallback for offline / cloud-down operation.

## Decision

There is **one routing contract**, resolved in this priority order:

1. **Explicit user mode wins.** If the user selects a specific provider/model,
   that choice is honored and the rest of the contract does not apply.
2. **Ouro classifies, it does not generate.** The router/Σ₀ gate produces a
   *task type + escalation hint* only. It never routes the user into a divergent
   persona/answer path. (Consistent with the Ouro intent-router design, #1267.)
3. **Coding is cloud-primary when a cloud key is reachable.** A coding intent in
   Auto mode leads with a cloud coder (Anthropic, then OpenAI). The local coder
   is **not** served as the primary answer for code.
4. **Local is the verified backstop, not the leader.** Local models run when
   (a) no cloud key is reachable (offline), or (b) a deterministic provider-health
   check fails. Local output that backstops a coding turn must pass the existing
   verification/groundedness gates before it is served.
5. **Non-coding chat may remain local-first** for latency/cost, unchanged — the
   conflict this ADR resolves is specifically about *coding* routing.

The contract is implemented as a single pure resolver
(`lib/route-contract.js`, `resolveCodingRoute()`), unit-tested, and called from
the live dispatch path. The scattered environment variables become *inputs* to
the resolver, not the contract itself. `CODING_LOCAL_FIRST=1` is retained only as
a documented developer escape hatch.

## Consequences

**Positive**
- One authoritative, testable statement of routing; behavior is predictable.
- Reliability + code quality match the product thesis (a trustworthy coding
  cockpit), without contradicting the local-ownership principle.
- Unblocks the Cline Plan/Act port (folded into #1408) and the receipts/metrics
  work (#1410/#1411), which need a defined injection point.

**Negative / costs**
- Cloud dependency for the primary coding path; mitigated by the local offline
  backstop and by surfacing escalation in the receipt (#1410).
- A behavior-preserving refactor of `stream-chat.js` is required to route the
  live call sites through the resolver; must be verified through the real chat UI
  (per the user-path verification rule) before the redundant escape hatches are
  removed.

## Alternatives considered

- **Capability-first local coding** (current default ladder): rejected — the
  local coder scores ~0/5 and the path crashes; serving it as primary is the bug
  the 2026-06-26 lock already started fixing.
- **Cloud-only** (drop local): rejected — violates the local-ownership North
  Star and the offline-resilience requirement.

## Implementation

- `lib/route-contract.js` — `resolveCodingRoute()` pure resolver (this PR).
- `lib/stream-chat.js` — coding-route call site delegates to the resolver
  (behavior-preserving; this PR).
- Follow-up (separate, after approval): migrate the remaining scattered call
  sites, then deprecate the redundant env vars; wire the repo-map evidence slice
  (#1409) and receipts (#1410) into the resolved path.

Tracks #1408.
