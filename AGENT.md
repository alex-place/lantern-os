# AGENT.md — The Convergence Agent (the one agent)

> **Scope note.** This is the canonical description of **the single agent** Lantern OS runs going
> forward. It is distinct from [`AGENTS.md`](AGENTS.md), which covers git/workflow lanes for
> *contributor coding-agents* (Claude/Gemini/Codex/etc.). This file is about the **product agent**:
> the Convergence Core that observes, remembers, reasons, acts, verifies, and converges.
>
> **Grounding contract (Σ₀ External Reality Rule):** every architectural claim below is anchored to
> a file on disk or an existing canon doc, and each capability is marked **✅ wired**, **🟡 coded /
> not wired**, or **⬜ designed**. Nothing unbuilt is described as live. When this doc and the code
> disagree, the code wins — fix the doc.

**Status:** Living spec. Supersedes the napkin framing; consolidates
[`docs/research/2026-06-19-convergence-core-agent-spine.md`](docs/research/2026-06-19-convergence-core-agent-spine.md)
into the top-level statement of what the agent *is*.

**Canon this builds on:**
[`CLAUDE.md`](CLAUDE.md) ·
[`docs/CONVERGANCE-SIGMA0-BRIEFING.md`](docs/CONVERGANCE-SIGMA0-BRIEFING.md) ·
[`docs/convergence-core-mapping.md`](docs/convergence-core-mapping.md) ·
[`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`](docs/SIGMA0-COLLAPSE-CERTIFICATE.md) ·
[`docs/research/2026-06-19-convergence-core-agent-spine.md`](docs/research/2026-06-19-convergence-core-agent-spine.md) ·
[`PROVIDERS.md`](PROVIDERS.md) ·
[`docs/PATREON-OAUTH.md`](docs/PATREON-OAUTH.md)

---

> ## 📖 In plain English (start here)
>
> Lantern OS runs **one agent**, not a zoo of them. That agent is a single loop: it **notices**
> something, **remembers** it, **thinks** about it, **does** something with a tool, **checks** whether
> that worked against the real world, and **settles** what it learned. Everything the product does —
> the chat, the trading desk, the dream journal, the task queue — is that same loop pointed at a
> different job.
>
> Two things make it different from a typical "AI agent":
> 1. **It learns from outcomes, not from retraining.** When a prediction can be checked (a trade wins
>    or loses), the agent grades its own past record and keeps the verified ones. Memory is the
>    learning mechanism; the model's weights are a slow, separately-gated capability layer.
> 2. **It has a safety floor (Σ₀).** Proven math keeps the loop from collapsing (agreeing with itself
>    into nonsense) or running away. That floor guarantees the agent stays *dependable and bounded* —
>    it does **not** guarantee it is *smart*. Where it drives is set by the tools and tasks you give it.
>
> The honest state today: the spine and the learn-from-outcome wire are **built**, one real slice
> (trading) **closes end-to-end**, and the remaining work is *wiring* — making the safety governors
> gate the live loop, and scheduling the grading pass. The rest of this page is the precise version. ↓

---

## 1. What the agent is (and the non-negotiables)

The agent **is** the Convergence Core. There is exactly one. Per [`CLAUDE.md`](CLAUDE.md):

> **THE ENTIRE PROJECT IS ONE LOOP:** `Observe → Remember → Reason → Act → Verify → Converge`
> **FOUR CORE OBJECTS:** Memory · Task · Tool · Convergence Record
> *Reject architectural sprawl. Prefer extension over addition. Maintain a single Convergence Core.*

Five non-negotiables govern every line of the agent:

| Principle | What it means operationally | Source |
|---|---|---|
| **One loop** | Every feature must strengthen exactly one stage of `Observe→…→Converge`. No top-level subsystem that doesn't improve the loop. | [`CLAUDE.md`](CLAUDE.md) |
| **External Reality Rule** | Nothing is accepted without evidence. Every important claim carries `[claim, evidence, confidence, source]`. | [`CLAUDE.md`](CLAUDE.md), [`SIGMA0-COLLAPSE-CERTIFICATE.md`](docs/SIGMA0-COLLAPSE-CERTIFICATE.md) |
| **Persistent learning, not weight modification** | Improve by accumulating *verified* memories + convergence records and retrieving them — not by retraining on every interaction. Weight changes are a slow, eval-gated ratchet (§7), never the primary loop. | [`CLAUDE.md`](CLAUDE.md) |
| **Models are interchangeable** | The Core never assumes a specific LLM. Any model plugs in as a replacement behind one dispatch seam. | [`CLAUDE.md`](CLAUDE.md), [`PROVIDERS.md`](PROVIDERS.md) |
| **Bounded by design (Σ₀)** | The agent is guaranteed not to *collapse* or *run away*; it is **not** guaranteed to be clever. | [`SIGMA0-COLLAPSE-CERTIFICATE.md`](docs/SIGMA0-COLLAPSE-CERTIFICATE.md) |

**Forbidden** (architectural sprawl — rejected outright): separate dream engine, multiple memory
systems, independent agent ecosystems / swarms, digital-twin / mind-upload concepts, any top-level
subsystem that doesn't improve the loop. (See the Feature Gate in [`CLAUDE.md`](CLAUDE.md).)

---

## 2. The loop — the agent's spine

The agent is a six-stage loop over the four objects. The reference orchestrator is
[`src/convergence/kernel.py`](src/convergence/kernel.py) (`class Kernel`, "implements the six-stage
loop"); the objects are immutable dataclasses in
[`src/convergence/objects.py`](src/convergence/objects.py).

| Stage | What happens | Real symbol | Status |
|---|---|---|---|
| **Observe** | Ingest a signal (chat turn, market tick, telemetry) as a `Memory`. | `Kernel.observe()` | 🟡 coded; serving path emits records but doesn't drive the Kernel |
| **Remember** | Query prior memories by pattern / confidence. | `Kernel.query_memory(pattern, min_confidence, order_by, limit)` | 🟡 coded; in-memory, not called by serving |
| **Reason** | Form/advance a `Task` (goal + constraints), pick the next action. | `Kernel.reason()` | 🟡 coded; no live reasoner emits Tasks yet |
| **Act** | Execute a `Tool` (a route / MCP tool). | `Kernel.act()` → `tool.call()` | 🟡 `Kernel.act()` coded; concrete `Tool` bodies are the open work (§6) |
| **Verify** | Grade the result against reality; update confidence. | [`src/convergence/verify.py`](src/convergence/verify.py): `verify_with_test()` / `_surprise()` / `_monitor()` | ✅ coded **and closed for the trading slice** (§5) |
| **Converge** | Pull high-confidence records into reusable patterns. | `Kernel.extract_patterns(min_confidence=0.85)` | 🟡 coded; folded by [`scripts/convergence_close_loop.py`](scripts/convergence_close_loop.py) for the trading slice |

**The precise honest gap** (from the spine note): the loop and its write-back closure are *written
in Python*, the chat path *emits* a `ConvergenceRecord` after every reply
([`apps/lantern-garage/routes/dream.js`](apps/lantern-garage/routes/dream.js)), and the **trading
slice closes end-to-end** (§5) — but the serving path does not yet *drive the Kernel itself*, and the
safety governors don't yet *gate* the live loop (§6, §8). This is wiring, not new subsystems.

> There is a second, unrelated "convergence loop" — [`src/convergence_io_engine.py`](src/convergence_io_engine.py)
> (`ConvergenceLoop`, a 20-phase **repo/CI promotion** loop). It is **not** the runtime agent loop;
> keep the two labelled so they're never conflated.

---

## 3. The four core objects

Everything the agent manipulates is one of four immutable objects
([`src/convergence/objects.py`](src/convergence/objects.py)). Everything else is implementation.

- **Memory** — `{id, timestamp, source, confidence, content, evidence_ids}`. Append-only JSONL +
  the CSF archive ([`src/csf/`](src/csf/)). The single memory system — **not** several.
- **Task** — `{goal, constraints, status, required_memories, dependencies}` + `is_blocked()`,
  `TaskStatus`. A "need" is a Task (§6).
- **Tool** — `{name, description, input_schema, output_schema}` + `call()`. Wraps a real route or MCP
  tool. (The abstract `call()` is `NotImplementedError`; concrete bodies are open work.)
- **Convergence Record** — `{hypothesis, evidence, result, confidence, source}`. The unit of
  learning. Emitted to `data/convergence/records.jsonl`
  ([`apps/lantern-garage/lib/convergence-records.js`](apps/lantern-garage/lib/convergence-records.js)),
  graded by Verify, compiled by Converge.

---

## 4. The reasoning substrate (the model) — interchangeable, with a local default

**Models are interchangeable.** The agent never hard-binds to one LLM; models plug in behind the
dispatch seam ([`swarm-orchestrator.js`](apps/lantern-garage/lib/swarm-orchestrator.js):
single / parallel / consensus / council) and the provider fallback chain
([`PROVIDERS.md`](PROVIDERS.md), 10 providers). The model is a *replaceable part*, not the agent.

The agent serves in two modes ([`src/serving_modes.py`](src/serving_modes.py)):

| Mode | Trigger | Engine | Use |
|---|---|---|---|
| **FAST** | default | cached KV inference (Ollama / merged LoRA), sub-2s | interactive chat, UX |
| **DEEP** | `OURO_NATIVE=1` (or high time-dilation) | native Σ₀ Q-exit loop, [`src/sigma0/loop_lm.py`](src/sigma0/loop_lm.py) | architecture decisions, grounded reasoning |

### The local default: the Σ₀ Ouro coder
The DEEP path's local substrate is **`ByteDance/Ouro-1.4B`** — a *weight-tied looped transformer*
whose native mechanism is "loop until it converges," which is why it fits the Reason→Converge stages
— plus the **Σ₀ LoRA adapter**. `loop_lm.py` implements the paper's **Q-exit** (adaptive per-token
depth) and a **convergence-exit** (iterate the block to a latent fixed point). Two registry entries
([`apps/lantern-garage/lib/model-registry.js`](apps/lantern-garage/lib/model-registry.js)):

- `text.coderLoop` — the Ouro **DEEP** coder (this substrate), served via `loop_lm.py`, adapter at
  `D:/lantern-train/ouro-sigma0-adapters/final`.
- `text.coder` — the **Qwen2.5-Coder-3B** Ollama **FAST** coder (`lantern-sigma0-coder-v2`), a
  *different* model for the cached path.

**Measured (2026-06-20, #781):** after retraining the Ouro adapter on an execution-verified coding
corpus, `validate_ouro_coding.py` = **8/8** and HumanEval (n=20 A/B, same conditions) = **75% vs 5%**
baseline. *Honest caveat:* HumanEval is partially memorized by any GitHub-pretrained base; the jump is
mostly the fine-tune fixing **output format** so pretrained competence surfaces cleanly. The robust
signal is the A/B delta + the unseen-task pass, not the absolute number. A 1.4B has a real capability
ceiling — it is the local reasoning substrate, not a frontier mind.

---

## 5. Trade chat — the one slice that closes end-to-end

The Kalshi trading desk ([`apps/lantern-garage/public/kalshi-terminal.html`](apps/lantern-garage/public/kalshi-terminal.html),
60+ routes in [`apps/lantern-garage/routes/trading.js`](apps/lantern-garage/routes/trading.js)) is the
agent pointed at markets — and the **only reasoner with a real ground truth** (a bet wins or loses),
which makes it the first fully-closed instance of the loop:

```
Observe   kalshi-collector (6s poll) → market snapshot              [kalshi-collector.js]
Reason    kalshi-suggest (tight-band entry) → emits a Convergence Record on entry
Act       order placement via the Kalshi REST client                [kalshi-api.js]
Verify    kalshi-convergence-outcomes.js reads the record, looks up GET /markets/{ticker},
          and on settlement writes {record_id, passed} → outcomes.jsonl   ✅ landed
Converge  convergence_close_loop.py folds the outcome into confidence + extract_patterns()
```

This is the template every other surface should follow: **emit a record → grade it against reality →
keep the survivors.** (Demonstrated unverified 0.90 → verified 0.95 → pattern; 12 tests in
[`tests/test_kalshi_outcomes.js`](tests/test_kalshi_outcomes.js).) **Still open:** *scheduling* the
grading pass (periodic / on-settlement) so it runs without a human.

Routing for trade chat is cached deterministically by
[`convergence-router.js`](apps/lantern-garage/lib/convergence-router.js) (120 Keystone routes, >70%
hit rate); live data flows collector → server snapshot → UI poll (no UI-direct Kalshi calls).

---

## 6. Creating needs — how goals enter the agent

A **"need" is a `Task`** ([`src/convergence/objects.py`](src/convergence/objects.py)): a goal + its
`constraints`, a `status` (`TaskStatus`), `required_memories`, and `dependencies` (`is_blocked()`
enforces ordering). There is no separate "needs system"; needs are Tasks flowing through the one loop.

Needs enter from three places (all funnel to the same Task object):

1. **User-initiated** — a chat turn in dream-chat / trade chat becomes a Task for the loop.
2. **Agent-initiated** — Converge surfaces a pattern (e.g. a recurring trade edge) that proposes a
   follow-up Task.
3. **Dispatched** — the MCP surface ([`src/mcp_server/server.py`](src/mcp_server/server.py),
   `task_intake` / `dispatch_work` / `queue_status`) admits external work as Tasks onto the queue.

**Design rule for needs:** a Task is only *actionable* when its inputs carry evidence above the
grounding threshold for the current uncertainty (the grounding gate, §8). A high-uncertainty need
should first spawn a *go-look* Task (buy grounding) before an *act* Task. This keeps "create needs"
from manufacturing ungrounded action. *(The gate is coded but not yet enforced on Act — §8.)*

---

## 7. Users, requirements & roles

User identity and entitlement gate which surfaces and tools a request may reach
([`docs/PATREON-OAUTH.md`](docs/PATREON-OAUTH.md)). When Patreon OAuth is configured, the whole site
sits behind login (`/auth.html`); Patreon tiers map to roles:

| Role | Source | Typical entitlement |
|---|---|---|
| **guest** | unauthenticated / free | read-only public surfaces |
| **supporter** | Patreon supporter tier | dream-chat, dream journal |
| **founder** | founder tier | trade chat, deeper surfaces |
| **admin** | owner | full control, feature flags, DEEP mode |

Requirements the agent must honor per user:
- **Identity continuity** — a known issue is that **Web (Patreon) and Discord identities are not yet
  linked** ([#697](https://github.com/alex-place/lantern-os/issues/697)); the agent should treat them
  as one principal once linked.
- **Privacy boundary** — local-private data (memories, receipts) stays local; the PCSF receipt layer
  records the privacy boundary per interaction.
- **Entitlement as a precondition on Act** — a Tool call must be allowed for the requesting role.
- **Per-user memory** — the dreamer/conversation stores
  ([`dreamer-store.js`](apps/lantern-garage/lib/dreamer-store.js),
  [`conversation-store.js`](apps/lantern-garage/lib/conversation-store.js)) keep per-user JSONL so
  Remember is scoped to the principal.

---

## 8. Connections — what the one agent plugs into

The agent is the hub; everything else is a **Tool**, a **provider**, or a **surface**.

- **Model providers (10)** — Anthropic / OpenAI / Gemini / + the local Ollama/Ouro stack, with a
  fallback chain ([`PROVIDERS.md`](PROVIDERS.md)). Dispatched via
  [`swarm-orchestrator.js`](apps/lantern-garage/lib/swarm-orchestrator.js). Embodies *models are
  interchangeable*.
- **MCP surface** — [`src/mcp_server/server.py`](src/mcp_server/server.py) (FastAPI + SSE) exposes
  `queue_status`, `task_intake`, `dispatch_work`, `boot_check`, `list_skills`, `get_status`. Only
  tools with real implementations are registered.
- **Markets** — Kalshi REST ([`kalshi-api.js`](apps/lantern-garage/lib/kalshi-api.js)) for trade chat.
- **Chat / community** — Discord ([`src/discord_lounge_bot/`](src/discord_lounge_bot/)); web UI
  surfaces (dream-chat, trade dashboard, three-doors) served by
  [`apps/lantern-garage/server.js`](apps/lantern-garage/server.js).
- **Repo / deploy** — GitHub (PRs/issues) + Railway (auto-deploys `master`).

**Connection rule:** every external connection is wrapped as a `Tool` with an `input_schema` /
`output_schema` so `Act` is uniform and `Verify` can grade any tool's result the same way. New routes
must register **before** the `surfaces.js` static catch-all or they are silently shadowed.

---

## 9. The governors — the Σ₀ safety floor

These are the parts most agent stacks never build, and they are real and tested (30 passing tests,
[`SIGMA0-COLLAPSE-CERTIFICATE.md`](docs/SIGMA0-COLLAPSE-CERTIFICATE.md)):

| Governor | Role | Symbols | Status |
|---|---|---|---|
| **Grounding throttle** | turn uncertainty into an external-grounding budget; near collapse, deflate toward "stop reasoning, go look" | [`grounding-policy.js`](apps/lantern-garage/lib/grounding-policy.js) (`dilation()`, `groundingPolicy()`, `D_MIN=0.1`/`D_MAX=5.0`) | 🟡 coded; not yet a hard gate on Act |
| **Σ₀ immune system** | detect collapse / re-excite stuck modes; canary on model-vs-reality drift | [`src/cio_sde/collapse.py`](src/cio_sde/collapse.py), [`src/cio_sde/surprise.py`](src/cio_sde/surprise.py) (`SurpriseMonitor`, `AntiCollapseOperator`) | 🟡 coded; not yet observing the live loop ([#766](https://github.com/alex-place/lantern-os/issues/766)) |

**The honest guarantee:** Σ₀ proves the loop won't *collapse* (agree itself into nonsense) or *run
away*. It does **not** prove the agent is *smart*. Safety floor ≠ capability ceiling.

---

## 10. Persistent learning — memory first, weights as a gated ratchet

Two learning timescales, deliberately separated:

- **Fast / primary (always-on): memory + convergence records.** The agent improves by accumulating
  *verified* records and retrieving them — no retraining. This is the "runs forever, keeps learning"
  mechanism, and it is auditable (every gain has `[evidence, confidence, source]`).
- **Slow / secondary: the weight ratchet.** Periodically re-fit the local model — but as an
  **eval-gated ratchet, not a telemetry treadmill**:
  1. **Trigger by evidence** (eval gap / enough new verified episodes), not a bare clock.
  2. **Train only on execution-VERIFIED episodes** (the sandboxed compile+exec+assert gate from
     [`scripts/build_ouro_coding_dataset.py`](scripts/build_ouro_coding_dataset.py)). Never raw
     telemetry or the model's own unverified output — that is model-autophagy / collapse.
  3. **Accumulate, don't replace** (cumulative corpus > "latest"), to avoid catastrophic forgetting.
  4. **Promote only on a measured win, with rollback** — A/B vs the incumbent on the harness +
     leaderboard; keep the prior adapter as a backup (the `final.bak-*` pattern, #781).

This keeps weight changes rare, reversible, and evidence-gated — consistent with *persistent
learning, not weight modification*. The retrain belongs to the **Converge** stage, fed only by
**Verified** records; it is not a separate subsystem.

---

## 11. Current status & roadmap (grounded in open issues)

What's **done**: the four objects, the Kernel orchestrator, the verify closure, the trading slice that
**closes end-to-end**, the live record emit, the retrained local DEEP substrate (#781), the Σ₀ safety
math (30 tests).

What's **open** (the wiring, by loop stage):

| # | Work | Stage | Issue |
|---|---|---|---|
| 1 | Concrete `Tool` bodies wrapping real routes / MCP tools | Act | (spine §6.1) |
| 2 | Schedule the close-loop grading pass (periodic / on-settlement) | Verify→Converge | spine §4 "still open" |
| 3 | Gate `Act` with the grounding throttle (hard precondition on evidence) | Act | spine §6.5 |
| 4 | Wire `loop_lm.generate()` into the collapse canary (Σ₀ watching the live loop) | Verify | [#766](https://github.com/alex-place/lantern-os/issues/766) |
| 5 | Persist DEEP realized depth + contraction to the leaderboard | (measurement) | [#777](https://github.com/alex-place/lantern-os/issues/777) |
| 6 | Standing executable coding benchmark (HumanEval/MBPP) persisted | (measurement) | [#776](https://github.com/alex-place/lantern-os/issues/776) |
| 7 | Link Web (Patreon) ↔ Discord identity into one principal | Users | [#697](https://github.com/alex-place/lantern-os/issues/697) |
| 8 | Hygiene: reframe `three-doors-convergence-loop.js` as a Task through the one loop | (debt) | spine §6.6 |

Each step leaves a working system; none adds a subsystem.

---

## 12. What this agent is — and isn't

Running §1–§11 yields a **real, durable, bounded** agent: it perceives (collectors), holds goals
(Task), acts through tools (Tool/routes), checks itself against reality (the verify closure + Σ₀
canary + grounding gate), and improves by accumulating *verified* records instead of retraining.
That is more than most "agent" stacks ship, and most of it is already written.

It is **not** "truly agentic" in the AGI sense: no general world-model, no open-ended goal formation,
no transfer beyond the tools and tasks provided. **Σ₀ guarantees the loop won't collapse or run away;
it does not guarantee it will be smart.** The car will drive, stay on the road, and not crash itself —
where it drives is set by the tools and tasks put in it.

---

*Authored against the on-disk repo and the Σ₀ canon. When code and this doc disagree, fix the doc.*
