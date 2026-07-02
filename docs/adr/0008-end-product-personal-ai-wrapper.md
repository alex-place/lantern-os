---
adr: 0008
title: The end product is a personal AI wrapper — user capabilities are Tools + Skills in the one loop
status: Proposed
date: 2026-06-24
deciders: Alex Place
approved-by: pending
supersedes: none
superseded-by: none
---

# ADR-0008: The end product is a personal AI wrapper — user capabilities are Tools + Skills in the one loop

> **Consolidation note (2026-07-01).** This file absorbed the duplicate
> `0008-personal-ai-wrapper-end-product.md` (added by PR #1144), which claimed the same
> ADR number and carried `status: Accepted` without an `approved-by` — in violation of
> the approval gate. Its unique content (the no-autonomous-submission rule, the
> `~/.keystone/workspace/` default, and follow-on issues #1095–#1100) is merged below;
> the status remains **Proposed** until Alex explicitly approves.

## Status

Proposed — awaiting approval from Alex Place.

## Context

The infrastructure ADRs (0002–0007) record *how the system is built* — one Convergence Core,
one CSF module, append-only memory, interchangeable providers, dual-boot topology, monoworkstream.
**None of them records *what the end product is for a user*.** That definition has lived only
implicitly, and the two existing statements pull in different directions:

- The North Star frames it narrowly: "a persistent reasoning **and coding** system"
  ([CONVERGANCE-SIGMA0-BRIEFING.md](../CONVERGANCE-SIGMA0-BRIEFING.md)).
- The codemap frames it broadly: "a local-first operating **cockpit**" already spanning chat,
  trading, media creation, RAG/research, and orchestration
  ([CODEMAP.md §1](../CODEMAP.md); [ARCHITECTURE.md §4/§8](../ARCHITECTURE.md)).

The practical consequence of the missing definition: when asked "can it help a user look up
information, fill out a job application, or make a resume?", the honest answer today is *no* —
the only model-callable tool surface is the chat tool-loop's **7 repo-coding tools** (Read, LS,
Glob, Grep, Bash, PowerShell, Write, Edit), all **sandboxed to the repo**
([`tool-runner.js:33-136`](../apps/lantern-garage/lib/tool-runner.js)). The trained Ouro adapter
likewise clones *coding-session* behavior. Without a decided product scope, every such request
gets reframed as "a different product," and capability never accretes toward a coherent whole.

This ADR fixes the scope: **Keystone OS is a personal AI wrapper** — a single local-first pane
through which its owner gets real things done — and decides *where new user-facing capability lives*
so that broadening scope does **not** become sprawl (which ADR-0002 forbids).

## Decision

1. **End-product definition.** Keystone OS is a **local-first personal AI operating cockpit
   ("the wrapper")**: the owner's single surface for getting real-world tasks done — look up and
   ground information, create artifacts (documents, resumes, media), assist with multi-step tasks
   (e.g. job applications), code, trade, and remember — all backed by the Convergence loop and
   persistent memory. This **broadens** the briefing's "reasoning and coding" framing to
   **general personal capability**; coding and trading become two capabilities among many, not the
   ceiling.

2. **Capabilities are Tools + Skills, not subsystems.** Every new user-facing ability is added as a
   **Tool** (a `name + input + output + success` capability — the core Tool object,
   [`objects.py:95`](../src/convergence/objects.py)) registered in the canonical registry
   ([`tool-runner.js`](../apps/lantern-garage/lib/tool-runner.js) /
   [`tool_registry.py`](../src/convergence/tool_registry.py)), optionally orchestrated by a **Skill**
   (a workflow over tools). They run in the loop's **Act** stage and are grounded in **Verify**.
   This keeps ADR-0002 intact: a resume builder is *Act-stage extension*, never a top-level system.

3. **Model-agnostic capability.** Tools/Skills are independent of which model calls them (ADR-0005):
   the served local model (Ouro) handles cheap / private / offline / narrow calls; cloud models
   handle hard multi-step reasoning. The same `<tool_call>` protocol drives both
   ([`tool-runner.js:150` preamble](../apps/lantern-garage/lib/tool-runner.js);
   [`stream-chat.js:1579-1634` local tool loop](../apps/lantern-garage/lib/stream-chat.js)).

4. **Two scopes of filesystem access.** The repo sandbox (`_safe()` rejecting paths outside the
   repo) is correct for *coding* tools but blocks *user* tools. A capability that produces a user
   artifact (a resume PDF) must write to a **user workspace** distinct from the repo
   (`~/.keystone/workspace/` by default, configurable via `KEYSTONE_WORKSPACE`), gated by the
   same operator/consent checks — not by widening the repo sandbox.

5. **No autonomous submission.** The human must confirm any action that affects external state
   (sending email, submitting a form, publishing content). The `web_fetch` tool reads; it does
   not post.

## Options Considered

### Option A: Define the wrapper; capabilities are Tools + Skills in the one loop (chosen)
| Dimension | Assessment |
|---|---|
| Sprawl risk | Low — every capability names the Act stage; ADR-0002 gate still applies |
| Coherence | High — one tool registry, one loop, one memory |
| Reach | High — scope is "what a person needs," extensible without new subsystems |

**Pros:** broadens the product to the owner's real goals while preserving the single spine; the
trained model + cloud fallback both drive the same tools; capability compounds.
**Cons:** requires building a *user* tool surface (information, documents, workspace) and real
Skills — today's surface is coding-only; needs the discipline to keep adding Tools, not systems.

### Option B: Keep it a coding/trading system; treat lookup/resume/job-app as out of scope (rejected)
**Cons:** contradicts the owner's stated intent ("a wrapper that can do all of the above and more");
leaves the cockpit a half-product; wastes the persistent-memory + loop substrate on a narrow domain.

### Option C: Add each user capability as its own subsystem/app (rejected)
**Cons:** the exact sprawl ADR-0002 forbids — N parallel engines, duplicated memory/state, no shared
grounding. A "resume app" beside the loop cannot reuse memory, verification, or routing.

## Trade-off Analysis

The scarce resource for a solo-owned, agent-built system is **coherence**, not feature count
(ADR-0002). Option A buys broad reach *without* spending coherence: the registry + loop are the
integration point, so a new capability is discoverable and reusable by every agent and every model
the moment it lands. The cost is honest — the user tool surface and Skills must actually be built —
but it is *extension* work on an existing spine, not new architecture.

## Consequences

- **Positive:** a decided product scope; "can it help with X?" has a principled answer (yes, as a
  Tool/Skill); the trained Ouro adapter + cloud models share one capability surface; memory and
  grounding apply uniformly to every task.
- **Negative / trade-offs:** the current surface is coding-only, so the wrapper vision is *aspirational
  until the user tool surface exists*; building it must resist the urge to spin up subsystems.
- **Follow-ups (filed as issues #1095–#1100, each an Act-stage Tool/Skill — not a subsystem):**
  1. **Information tools** — `web_search` / `web_fetch` with cited, grounded results (Observe/Verify). (#1095)
  2. **User workspace** — a non-repo, consent-gated file area for user artifacts (distinct from `_safe()`). (#1096)
  3. **Document/artifact tools** — resume / cover-letter / DOCX / PDF generation over templates. (#1097)
  4. **Job-application Skill** — a workflow orchestrating lookup → document → fill/submit, human-in-loop. (#1098)
  5. **Real Skills** — only 4 of 17 skill dirs are implemented ([ARCHITECTURE.md §9.2](../ARCHITECTURE.md));
     user capabilities need genuine implementations, not contracts. (#1099)
  6. **Training data** — capability behavior (lookup/resume/forms) is not coding-session data; capture
     or synthesize those trajectories separately if the local model is to drive them. (#1100)

## Alternatives considered

See Options above. "Leave the end product undefined" was rejected: it is the status quo that makes
every user-capability request a scope argument instead of a build task.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| No existing ADR defines the end-product/user-capability scope | [docs/adr/](.) ADRs 0001–0007 are all infrastructure | High | repo |
| Briefing frames product as "reasoning and coding" | [CONVERGANCE-SIGMA0-BRIEFING.md](../CONVERGANCE-SIGMA0-BRIEFING.md) | High | project doc |
| Codemap/architecture already span chat, trading, media, orchestration | [CODEMAP.md §1](../CODEMAP.md), [ARCHITECTURE.md §4/§8](../ARCHITECTURE.md) | High | project docs |
| Only model-callable tools today are 7 repo-coding tools, repo-sandboxed | [`tool-runner.js:33-136`](../apps/lantern-garage/lib/tool-runner.js) | High | code |
| Local model gets a tool-exec loop when `CHAT_TOOL_EXEC=1` | [`stream-chat.js:1579-1634`](../apps/lantern-garage/lib/stream-chat.js) | High | code |
| Tool is a core object; capabilities belong in Act | [`objects.py:95`](../src/convergence/objects.py), [ARCHITECTURE.md §3](../ARCHITECTURE.md) | High | code/doc |
| Only 4 of 17 skills implemented | [ARCHITECTURE.md §9.2](../ARCHITECTURE.md), [CLAUDE.md](../CLAUDE.md) | High | project docs |
