---
author: Alex Place
created: 2026-06-19
updated: 2026-06-20
---

# Wiring the rest of the agent — the Convergence Core is coded but doesn't run end-to-end

> ## 📖 In plain English (start here)
>
> **What this is about:** we keep asking "could Lantern be a *real* agent — something that
> notices things, holds a goal, acts, checks itself, and gets better?" Last time the answer was
> *the safety part is built; now design the rest of the car.* This page is that design — grounded
> against what's **actually on disk**, and corrected after an adversarial re-check that caught the
> first draft underselling how much already exists.
>
> **The real surprise:** almost the whole car is already built — and not just the parts. The
> four pieces every agent needs (memory, task, tool, record-of-one-thought), a loop that runs
> *notice → remember → think → act → check → settle*, **and** the "learn from how it turned out"
> wire are **all already written in code**. The chat path already files a record after every reply.
>
> **So what's actually missing?** Not the engine — the **ignition and the drivetrain coupling.**
> The written loop and the learn-from-outcome wire **don't run end-to-end in the live product**: the
> chat files a record but nothing ever grades it, and the one place with a real right/wrong answer
> to grade against (trading — a bet either wins or loses) isn't plugged in. The lesson-learning code
> exists and is never triggered.
>
> **The honest ceiling (unchanged):** finishing this wiring gives a **dependable, bounded** agent —
> it won't quietly fall apart, won't run away, and improves by stacking up checked experience. It is
> **not** a general "smart-at-everything" mind. The safety math (Σ₀) guarantees it won't *collapse*;
> it does not guarantee it will be *clever*. Where it drives is set by the tools and tasks you give it.
>
> *🎙️ Want it read aloud? Press the **Listen** bar at the bottom of this page.*
>
> The rest of this page is the precise, technical version. ↓

**Date:** 2026-06-19
**Type:** Design note (grounds the "what is the rest of the agent" question against the repo)
**Status:** Design-only. Changes no serving code; selects nothing. Specifies what to *wire*, not what to *ship*. Every repo-claim was read on disk 2026-06-19.
**Grounding contract:** External Reality Rule — every file/symbol cited was opened and verified. An adversarial re-grounding pass corrected an earlier draft that **understated** what exists (it missed `kernel.py`, `verify.py`, and the live `dream.js` emit). The corrected claim — *loop and closure are coded but not wired into the serving path* — is the on-disk fact.

Related canon: [`CONVERGANCE-SIGMA0-BRIEFING.md`](../CONVERGANCE-SIGMA0-BRIEFING.md) · [`convergence-core-mapping.md`](../convergence-core-mapping.md) · [`SIGMA0-COLLAPSE-CERTIFICATE.md`](../SIGMA0-COLLAPSE-CERTIFICATE.md) · [`RESEARCH-CANON.md`](../RESEARCH-CANON.md)

---

## 0. The correction: the loop is written; it just doesn't run

The architecture spec ([`convergence-core-mapping.md`](../convergence-core-mapping.md)) reads as a *future* migration ("Action: create a Memory class…"). Read against the actual tree on 2026-06-19, almost all of it has **already landed** — including the parts a first draft of this note wrongly called missing. The honest gap is not "build the four objects" or "build the feedback loop." It is:

> **the six-stage loop and its write-back closure are coded in Python, one reasoner already emits records, but nothing runs the closure end-to-end in the live serving path — and the only reasoner with a checkable outcome isn't wired in.**

CLAUDE.md's North Star is the test every line below must pass:

> **THE ENTIRE PROJECT IS ONE LOOP:** `Observe → Remember → Reason → Act → Verify → Converge`
> **FOUR CORE OBJECTS:** Memory · Task · Tool · Convergence Record
> *Reject architectural sprawl. Prefer extension over addition. Maintain a single Convergence Core.*

This note proposes **zero new subsystems**. It is entirely wiring + ignition of code that already exists.

---

## 1. The chassis and the orchestrator — already built (Python)

The four core objects exist as immutable dataclasses in [`src/convergence/objects.py`](../../src/convergence/objects.py), **and** a full six-stage orchestrator wires them: [`src/convergence/kernel.py`](../../src/convergence/kernel.py) (`class Kernel`, docstring "implements the six-stage loop … Observe→…→Converge").

| Object | On disk | Real symbol | What's still open |
|---|---|---|---|
| **Memory** | ✓ built + queryable | `@dataclass Memory{id, timestamp, source, confidence, content, evidence_ids}`; `Kernel.observe()` / `Kernel.query_memory(pattern, min_confidence, order_by, limit)` | no JS counterpart; Kernel is in-memory, not called by the serving path |
| **Task** | ✓ built | `@dataclass Task{…, constraints, status, required_memories, dependencies}` + `is_blocked()`; `TaskStatus` enum | no reasoner emits Tasks; constraints unused at runtime |
| **Tool** | ⚠ abstract | `@dataclass Tool{name, description, input_schema, output_schema}`; `Kernel.act()` awaits `tool.call()` | **`Tool.call()` is `raise NotImplementedError`** — no concrete tool wraps the 60+ routes / MCP tools, so `act()` over real tools can't run |
| **ConvergenceRecord** | ✓ built (both langs) + emitted | Python `@dataclass`; JS `emitConvergenceRecord()` → `data/convergence/records.jsonl` ([`convergence-records.js`](../../apps/lantern-garage/lib/convergence-records.js)); **emitted live** by dream-chat ([`routes/dream.js:299-311`](../../apps/lantern-garage/routes/dream.js)) | confidence is a frozen v1 heuristic (0.7 online / 0.3 offline); never graded |

**Flagged defect — now resolved.** While grounding this note, [`src/convergence/objects.py`](../../src/convergence/objects.py) was found to define `ToolResult` **twice** (an `Enum` shadowed by a `@dataclass`), so `ToolResult.SUCCESS` no longer resolved. Fixed in commit `84954240`: the enum was renamed `ToolOutcome` (line 29), leaving `ToolResult` unambiguously the dataclass (line 117). Recorded here as a worked example of the External Reality Rule catching a real bug in the chassis it documents.

**Reading:** the chassis *and* a runtime orchestrator exist in Python. What's missing is (a) a concrete `Tool` body and (b) the **serving path actually calling the Kernel** — today Node and Python share only the `records.jsonl` schema, not the loop.

---

## 2. Two loops exist — neither is the runtime agent loop in production

There are **two** distinct "convergence loops" on disk; they serve different axes, and the napkin draft conflated them.

| Loop | What it converges over | Status |
|---|---|---|
| [`src/convergence/kernel.py`](../../src/convergence/kernel.py) `Kernel` | the **runtime four objects** — Observe→Remember→Reason→Act→Verify→Converge over Memory/Task/Tool/ConvergenceRecord | the real agent loop; **in-memory reference impl, not invoked by the serving path** |
| [`src/convergence_io_engine.py`](../../src/convergence_io_engine.py) `ConvergenceLoop` | **repo / artifact state** — a 20-phase CI self-correction loop (`PHASES` 1–20: `inspect_repo → … → run_validation → fix_failures → promote_or_hold`) | a build/promotion loop, not the runtime agent loop; [`tesseract_convergence.py`](../../src/tesseract_convergence.py) is a re-export shim of it |

(The `convergence_io_engine.py` *module docstring* says "12-step," but the implemented `ConvergenceLoop.PHASES` is **20 phases** — cite the code, not the docstring.)

**The gap, precisely:** the runtime `Kernel` is the right spine, but it is a library object — the live serving path (dream-chat, trading) never instantiates or drives it. Wiring the serving path to run the Kernel (or porting its `verify`/`extract_patterns` to a Node job over `records.jsonl`) is open work.

---

## 3. The governors — built, but not yet gating the live loop

These are the parts most agent projects never get, and they are real and tested ([`SIGMA0-COLLAPSE-CERTIFICATE.md`](../SIGMA0-COLLAPSE-CERTIFICATE.md), 30 passing tests).

| Governor | Role | Real symbols (verified) |
|---|---|---|
| **Grounding throttle** | turn uncertainty into an external-grounding budget; deflate toward act/go-look near collapse | [`grounding-policy.js`](../../apps/lantern-garage/lib/grounding-policy.js): `dilation()`, `groundingPolicy()`, `chatDilation()`, `D_MIN=0.1`/`D_MAX=5.0` — JS mirror of `src/convergence_io/dilation.py` |
| **Σ₀ immune system** | detect collapse / re-excite stuck modes; canary on model-vs-reality drift | [`collapse.py`](../../src/cio_sde/collapse.py): free fns `collapse_certificate()`, `lyapunov_value()`; classes `SemanticCollapseOperator`, `AntiCollapseOperator` (methods `.proximity()`, `.excite()`), `ReconstructionOperator`. [`surprise.py`](../../src/cio_sde/surprise.py): `SurpriseMonitor` (Kalman NIS in `.evaluate()`, `.sigma0_proximity()`, `.anti_collapse_signal()`) |

**What's missing is the teeth, not the tools.** Two wires:

1. **Grounding-as-a-gate on Act.** `groundingPolicy(D)` should be a *hard precondition*: no important `result` is acted on unless its record carries `[evidence_ids, confidence, source]` above the dilation-D threshold. High uncertainty → buy more grounding first; rising collapse-proximity → deflate D → "stop reasoning, go look."
2. **Σ₀ watching the live loop.** `SurpriseMonitor`/`AntiCollapseOperator` should observe the running loop and fire `anti_collapse_signal()` (`inject_novelty`/`truncate_context`/`switch_agent`) when it starts agreeing with itself. (The verify layer in §4 already knows how to consume a `SurpriseMonitor` reading — nothing feeds it one yet.)

---

## 4. The write-back closure — coded (wq-007), but never triggered

This is the highest-value gap, and the first draft got it exactly backwards. The closure is **not missing** — it is written and matches the spec:

- [`src/convergence/verify.py`](../../src/convergence/verify.py) (wq-007) — `verify_with_test()` (pass boosts confidence, fail collapses it), `verify_with_surprise()` (NIS "spook" collapses, consistent nudges up), `verify_with_monitor()` (folds a `SurpriseMonitor.evaluate()` dict). Each sets `verified=True`, writes `verification_notes`, and updates `confidence`. Docstring: "closes Reason → Act → Verify."
- [`kernel.py`](../../src/convergence/kernel.py) — `Kernel.verify()` does the same post-facto confidence update; `Kernel.extract_patterns(min_confidence=0.85)` is the Stage-6 Converge step that pulls high-confidence records into pattern summaries.

**So the real gap is the trigger, not the code.** On the live path:

1. dream-chat emits a record (§1) with a **frozen heuristic confidence** and **nothing ever grades it** — a chat reply has no ground truth to verify against, so `verify_with_test` is never called.
2. The reasoner that *does* have a resolvable outcome — `kalshi-suggest` (a trade settles win/lose) — **does not emit a record at all**, so `verify.py` has nothing from the trading path to grade.
3. Nothing reads `records.jsonl` back to run `extract_patterns()`; the Converge primitive exists but is invoked nowhere.

**The first genuinely-closed slice:** `kalshi-suggest` emits a record on entry → on trade resolution call `verify_with_test()` (or `Kernel.verify()`) → confidence is graded by the real outcome → `extract_patterns()` compiles the survivors. That single slice turns "coded but open" into "running and closing."

> **✅ Landed (2026-06-19).** The trigger now exists: [`kalshi-convergence-outcomes.js`](../../apps/lantern-garage/lib/kalshi-convergence-outcomes.js) reads each emitted `kalshi-suggest` record, looks up its market via the live Kalshi `GET /markets/{ticker}`, and writes `{record_id, passed}` to `data/convergence/outcomes.jsonl` once the market settles — which [`convergence_close_loop.py`](../../scripts/convergence_close_loop.py) already folds into confidence + `extract_patterns`. End-to-end demonstrated (unverified 0.90 → verified 0.95 → pattern); 12 unit tests in [`tests/test_kalshi_outcomes.js`](../../tests/test_kalshi_outcomes.js). Fetch is injectable (no keys/network in tests) and the pass is idempotent. **Still open:** scheduling the pass (periodic / on-settlement) and §6 step 5.

---

## 5. Sprawl census — naming, not duplication

The napkin draft feared "several half-built cars." On disk it's milder: **one runtime orchestrator (`kernel.py`), one separate repo-promotion loop (`convergence_io_engine.py`), and JS modules whose names *say* convergence but own different axes.** No second copy of the runtime loop exists.

| Module | What it actually is | Overlaps the runtime loop role? |
|---|---|---|
| [`src/convergence/kernel.py`](../../src/convergence/kernel.py) | the runtime six-stage orchestrator over the four objects | **this is the spine** (just not wired to serving) |
| [`src/convergence_io_engine.py`](../../src/convergence_io_engine.py) | 20-phase repo/artifact promotion loop | no — different axis (CI self-correction) |
| [`src/tesseract_convergence.py`](../../src/tesseract_convergence.py) | re-export shim of the engine above | no (alias) |
| [`convergence-agent.js`](../../apps/lantern-garage/lib/convergence-agent.js) | LLM-free keyword router → grounded local answers | no — Q&A router, name only |
| [`unified-agent.js`](../../apps/lantern-garage/lib/unified-agent.js) | Node→Python process bridge | no — delegates |
| [`swarm-orchestrator.js`](../../apps/lantern-garage/lib/swarm-orchestrator.js) | provider/model dispatch (single/parallel/consensus/council) | no — orchestrates *models* ("models are interchangeable") |
| [`three-doors-convergence-loop.js`](../../apps/lantern-garage/lib/three-doors-convergence-loop.js) | bespoke game pipeline (intake→design→build→verify→integrate) | **consolidation candidate** — reframe as a Task through the one loop |

**Verdict:** the debt is *concept/naming* sprawl. The one genuine consolidation target is `three-doors-convergence-loop.js`, whose 5-stage pipeline duplicates the *shape* of the loop for a single domain.

---

## 6. Build order (re-grounded against verified reality)

Phase 1 of [`convergence-core-mapping.md`](../convergence-core-mapping.md) (the objects) **and** much of Phases 2–4 (orchestrator, verify, pattern extraction) are already landed in Python. Re-scored against §1–§5, the real next steps are about **running** what's written:

> **Status (updated 2026-06-19):** steps **1, 2, 4 landed** in `25101abf` (concrete `RepoStatTool`, `kalshi-suggest` emit, the `convergence_close_loop.py` Converge pass). Step **3 (the Verify trigger) now landed** via `kalshi-convergence-outcomes.js` — the kalshi slice runs **Reason → Verify → Converge end-to-end** (see §4). **Remaining:** step 5 (grounding gate + Σ₀ canary on the live loop) and step 6 (hygiene), plus scheduling the close-loop pass.

1. **Implement one concrete `Tool`** wrapping a real route/MCP tool — gives `Kernel.act()` a body (the `ToolResult` name-shadowing bug in §1 is already fixed). *(Act)*
2. **Make a reasoner with a *resolvable outcome* emit** — `kalshi-suggest` carries a real conviction score; emit a record on entry, alongside the existing dream-chat emit. *(Reason)*
3. **Trigger the existing write-back:** on trade resolution call `verify_with_test()` / `Kernel.verify()` on that record. One slice now actually closes. *(Verify → Converge)*
4. **Invoke `extract_patterns()` periodically** over `records.jsonl`; feed the patterns back into Reason. *(Converge)*
5. **Gate Act with the grounding throttle and attach the `SurpriseMonitor` canary** to the live loop. *(Act / Verify)*
6. **Hygiene — no loop stage, debt paydown:** reduce naming sprawl; reframe `three-doors-convergence-loop.js` as a Task through the one loop; keep the `kernel.py` (runtime) vs `convergence_io_engine.py` (repo-promotion) split labelled so they're not conflated again.

Each step leaves a working system; none adds a subsystem.

---

## 7. What this is and isn't (the unchanged ceiling)

Running §1–§6 yields a **real, durable, bounded agent**: it perceives (collectors), holds goals (Task), acts through tools (Tool/routes), checks itself against reality (the verify closure + Σ₀ canary + grounding gate), and improves by accumulating *verified* records instead of retraining. That is more than most "agent" stacks ship — and most of it is already written.

It is **not** "truly agentic" in the AGI sense: no general world-model, no open-ended goal formation, no transfer beyond the tools and tasks provided. **Σ₀ guarantees the loop won't collapse or run away; it does not guarantee it will be smart.** The car will drive, stay on the road, and not crash itself — where it drives is set by the tools and tasks put in it.

---

### Sources (internal, verified on disk 2026-06-19)
- Four core objects — [`src/convergence/objects.py`](../../src/convergence/objects.py) (Memory, Task/TaskStatus, Tool/ToolResult, ConvergenceRecord)
- Runtime orchestrator — [`src/convergence/kernel.py`](../../src/convergence/kernel.py) (`Kernel`: observe / query_memory / reason / act / verify / extract_patterns)
- Write-back closure — [`src/convergence/verify.py`](../../src/convergence/verify.py) (wq-007: verify_with_test / _surprise / _monitor)
- Record emitter + live emit — [`apps/lantern-garage/lib/convergence-records.js`](../../apps/lantern-garage/lib/convergence-records.js) → `data/convergence/records.jsonl`; [`apps/lantern-garage/routes/dream.js`](../../apps/lantern-garage/routes/dream.js) (`emitConvergenceRecord`, lines 299-311)
- Repo-promotion loop (separate axis) — [`src/convergence_io_engine.py`](../../src/convergence_io_engine.py) (`ConvergenceLoop.PHASES`, 20 phases) · shim [`src/tesseract_convergence.py`](../../src/tesseract_convergence.py)
- Governors — [`src/cio_sde/collapse.py`](../../src/cio_sde/collapse.py) · [`src/cio_sde/surprise.py`](../../src/cio_sde/surprise.py) · [`apps/lantern-garage/lib/grounding-policy.js`](../../apps/lantern-garage/lib/grounding-policy.js)
- Architecture spec / roadmap — [`docs/convergence-core-mapping.md`](../convergence-core-mapping.md)
- North Star — [`CLAUDE.md`](../../CLAUDE.md) · [`CONVERGANCE-SIGMA0-BRIEFING.md`](../CONVERGANCE-SIGMA0-BRIEFING.md) · Σ₀ limits [`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`](../SIGMA0-COLLAPSE-CERTIFICATE.md)

**Sprawl census modules:** [`convergence-agent.js`](../../apps/lantern-garage/lib/convergence-agent.js) · [`unified-agent.js`](../../apps/lantern-garage/lib/unified-agent.js) · [`swarm-orchestrator.js`](../../apps/lantern-garage/lib/swarm-orchestrator.js) · [`three-doors-convergence-loop.js`](../../apps/lantern-garage/lib/three-doors-convergence-loop.js)
