# Keystone — Progress Report (Shareholder Edition)

**Period ending:** 2026-06-19 · **Product:** Keystone chat (the Convergence Core / Σ₀ agent) · **Status:** Active development, pre-revenue.

> **Reading contract.** This report follows Keystone's own **External Reality Rule**: every material claim carries evidence (a commit, a test count, a measured number) and is tagged **[shipped]**, **[measured]**, or **[design]**. We do not report aspiration as achievement. No financial or user-base figures are claimed — Keystone is solo-built and pre-revenue; this is an engineering-progress report.

---

## 1. The thesis, in one line

**Keystone is a self-driving car for reasoning** — it observes, remembers, reasons, acts, verifies, and improves from *checked* experience, with a safety system (Σ₀) that mathematically bounds it so it won't collapse or run away.

"**Tesla-class**" is the honest version of the metaphor: a *real, autonomous, production* vehicle — **not** a concept car, and **not** a claim of general intelligence. It drives well on the roads you give it. It is engineered to stay on the road and not crash itself. Where it drives is set by the tools and tasks you put in it.

---

## 2. The car, part by part (and how complete each is)

| Part of the car | What it is in Keystone | Status |
|---|---|---|
| **Engine** | the six-stage loop: Observe → Remember → Reason → Act → Verify → Converge | **built** (Python `kernel.py`) |
| **Drivetrain coupling** | the loop actually *running* end-to-end in the live product | **first slice now engaged** — see §3 |
| **Memory / odometer** | append-only JSONL + CSF archive; per-session token-budgeted context | **shipped** (#772) |
| **Lane-keeping** | grounding throttle — buy evidence when uncertain, "stop reasoning, go look" | built; **not yet gating Act** |
| **Crash-avoidance (the differentiator)** | Σ₀ collapse certificate + surprise canary — won't collapse or run away | **built + proven** (30 passing tests) |
| **Self-improvement** | grade decisions against real outcomes; compile what survives | **first reasoner now closing** (§3) |

The crash-avoidance math is the part most "agent" products never ship. Keystone has it, proven.

---

## 3. Shipped this period (evidence-tagged)

1. **Σ₀-K1 kernel spec frozen + a real measurement harness.** [shipped `fb523163` / `7b0a776a`]
   Replaced a 10-prompt trivia eval with a **65-prompt, repo-grounded golden set** (Gate A) so every model/serving change is *graded, not asserted*. **Measured cold baseline: 34%** on the local kernel, with a clean difficulty gradient (100/50/29/13% across smoke→hard) — proof the harness discriminates. [measured — `data/eval/leaderboard.jsonl`]

2. **Token-budgeted memory (the REMEMBER stage).** [shipped `66ad7024`, closes #772]
   Long chats used to **silently drop** their own beginning. Keystone now assembles a token-budgeted context — a rolling summary of older turns plus recent verbatim turns within the active model's window — from the full session log. **28 unit tests; live in production.**

3. **The loop's first real slice now closes end-to-end.** [shipped `8608e5e7` + `25101abf`]
   The Kalshi trading reasoner — which has *ground truth* (a trade wins or loses) — now runs **Reason → Verify → Converge**: it emits a prediction, the settled market grades it, and the survivors compile into patterns. **Demonstrated: a record went unverified 0.90 → verified 0.95 → extracted as a pattern.** [measured, end-to-end] **12 unit tests.**

**Why slice #3 matters most:** it is the difference between an agent that *talks* about improving and one that *measurably* does. Keystone now has at least one loop where experience is checked against reality and compounded — the foundation everything else stacks on.

---

## 4. Metrics that are real (no vanity numbers)

| Metric | Value | Source |
|---|---|---|
| Golden-set baseline (cold local kernel) | **34%** (22/65) | [measured] `leaderboard.jsonl` |
| Golden-set difficulty gradient | 100 / 50 / 29 / 13% | [measured] |
| Loop slices closing end-to-end | **1** (Kalshi: Reason→Verify→Converge) | [measured] §3 |
| Σ₀ safety certificate | **30 passing tests** | [shipped] `SIGMA0-COLLAPSE-CERTIFICATE.md` |
| New automated tests added this period | **47** (7 Gate A + 28 #772 + 12 Kalshi) | [shipped] |

We deliberately do **not** report the local kernel as "smart": it scores ~10% pass@1 on HumanEval. That is the point of the architecture — value comes from the **loop, grounding, and provider routing**, not a single model. Models are interchangeable; the Core is the asset.

---

## 5. The honest ceiling (forward-looking statement)

Keystone is becoming a **dependable, bounded** agent: it won't quietly fall apart, won't run away, and improves by stacking checked experience. It is **not** a general "smart-at-everything" mind:

- **Σ₀ guarantees it won't *collapse*; it does not guarantee it will be *clever*.** Safety ≠ capability.
- The local kernel is intentionally small/cheap; capability is bought via grounding + cloud routing, not a bigger brain.
- One loop slice closes today; the chat path emits records but has no ground truth to grade against yet.

This is a larger, more honest claim than most agent stacks ship — *because it is bounded and verified*, not despite it.

---

## 6. Roadmap — next milestones

| Next | What it buys | Source |
|---|---|---|
| **Gate Act with the grounding throttle + attach the Σ₀ canary** to the live loop | lane-keeping + crash-avoidance engaged on every action | agent-spine §6.5 |
| **Schedule the close-loop pass** (periodic / on-settlement) | the Kalshi slice closes continuously, unattended | this period's follow-up |
| **State-ABI shim** (Σ₀-K1 component 6) | connect the Ouro reasoning loop to the hot-swap VM | `SIGMA0-K1-KERNEL-SPEC.md` |
| **Grow the golden set + measure grounded-vs-cold lift** | turn the 34% baseline into a tracked, improving curve | Gate B |

---

## 7. Governance & honesty note

Every claim above is traceable to a commit, a test, or a measured artifact on disk. This report contains no projected revenue, user counts, or capability claims unsupported by a run. Keystone's credibility *is* the External Reality Rule — we would rather under-claim and be trusted than over-claim and be checked.

---

### Sources (verified on disk 2026-06-19)
- Loop + four objects — [`docs/research/2026-06-19-convergence-core-agent-spine.md`](research/2026-06-19-convergence-core-agent-spine.md)
- Kernel spec + Gate A — [`docs/SIGMA0-K1-KERNEL-SPEC.md`](SIGMA0-K1-KERNEL-SPEC.md) · `data/eval/leaderboard.jsonl`
- Token-budgeted memory — `apps/lantern-garage/lib/stream-chat/context-budget.js` (#772)
- Loop-closing slice — `apps/lantern-garage/lib/kalshi-convergence-outcomes.js` · `scripts/convergence_close_loop.py`
- Safety certificate — [`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`](SIGMA0-COLLAPSE-CERTIFICATE.md)
