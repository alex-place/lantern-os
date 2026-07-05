---
name: report-card
description: Produce an honest, evidence-grounded letter-grade report card for Keystone OS as it actually is right now — graded dimensions, real evidence per row, an overall grade, and a candid one-paragraph summary. Use this whenever the user types `!report-card`, or asks to "grade the app", "evaluate the app as it is now", "how are we doing", "give me an honest assessment", "where do we stand", "what's the state of the project", or otherwise wants a frank, no-flattery scorecard of the system's current quality. Trigger even when the user doesn't say the words "report card" — any request for a candid overall grade of the app or project is this skill. Do NOT use it for grading a single PR diff (that's a code review) or for a roadmap/planning ask.
---

# Report Card

The user wants the truth about where the app stands — not encouragement, not a roadmap, not a code review of one diff. A letter-grade scorecard of **Keystone OS as a whole, right now**, where every grade is earned by evidence they can check.

This is a Σ₀ artifact. The North Star says *external reality beats internal consistency* and *every important claim needs [claim, evidence, confidence, source]*. A report card that grades from vibes or memory is worse than none — it launders feeling into a letter. So the whole job is: ground each grade in something you actually observed, and let the grades fall where the evidence puts them, even when that stings.

## What makes this useful (and what ruins it)

The value is **honesty the user can't easily get from themselves.** They live inside the project; they know it's good in places and held together with tape in others. What they can't do is step back and say it plainly with receipts. That's the deliverable.

Two failure modes kill it:
- **Grade inflation / flattery.** A row of B+'s makes the card worthless. If everything's fine, the user learns nothing. Look hard for the C's and D's — the weak dimension is the most valuable line on the card.
- **Ungrounded grades.** "Code quality: A" with no evidence is just a feeling wearing a letter. Every grade must point at something real.

## Gather live evidence first

Before grading, spend real effort observing the system *as it is this session*. Grade from what you can see, not what you remember. Good sources, roughly in order of weight:

- **What happened in this session** — the live chat test you ran, a feature you just exercised, an error you hit, boot logs you read, a server that wouldn't start. First-hand and strongest.
- **Run something cheap and revealing** — start a server, hit an endpoint, run the test suite or a single test, check `git status` / recent commits, read a boot log. A 30-second probe beats a paragraph of recollection.
- **Read the code you're grading** — open the lib modules, the route handlers, the eval scripts. "The modules I read are clean and idiomatic" is a grounded claim; "the code is good" is not.
- **The numbers** — eval results, accuracy logs (`data/**/*.jsonl`), benchmark output. Cite the actual figure ("0/3 SWE single-shot"), not "capability is limited."

If you genuinely cannot observe a dimension this session, say so in the evidence cell ("not exercised this session — inferred from `routes/trading.js` structure") rather than inventing a grade. An honest "couldn't verify" is a Σ₀-valid cell. Never fabricate a log line, a number, or a test result to fill a row — a faked receipt is the one unforgivable move here.

## Ground each dimension against live competitors

A grade in isolation ("Code quality: B+") answers "is this good in the abstract." It doesn't answer the question the user actually has: "are we ahead or behind, right now, against what else exists." Close that gap with a live web search per dimension before finalizing the card — this is the same *external reality beats internal consistency* rule the North Star already imposes on every other grade, just pointed outward instead of inward.

For each dimension, run at least one `WebSearch` (or `WebFetch` if you already have a specific URL — e.g. a leaderboard) to find the current comparable state of the art, then fold the result into a **`Vs Competitors`** cell next to that row's evidence:

- **Core product (the chat)** → how does the current best of ChatGPT / Claude.ai / Gemini handle the same class of interaction (memory, tool use, agentic chat) as of this search?
- **Raw capability** → pull the current public leaderboard number for the same benchmark you're citing (SWE-bench, HumanEval, MMLU) so "0/3 SWE single-shot" sits next to what frontier models score *today*, not from training-cutoff memory.
- **Grounding / verification engine** → search for what comparable verification/grounding approaches (e.g. other agentic-coding or RAG-verification systems) are shipping right now.
- **Operational health / Engineering discipline / Scope discipline** → these are usually project-internal and don't have a clean competitor analog; it's fine to write "no direct competitor comparison — internal-only dimension" rather than forcing one.

Rules for this column, non-negotiable:
- **Every claim needs a source and an implicit "as of" date** — the whole point is *real-time*, so a search result from this session beats a fact you already knew. If you already knew it going in, search anyway to confirm it hasn't moved.
- **Never guess a competitor's current pricing, benchmark score, or feature set from memory.** Frontier models and products change monthly; a stale claim stated as current is worse than no comparison at all.
- **If a search comes back thin or ambiguous, say so** ("couldn't confirm a current number for X — treating as unverified") rather than rounding a vague result into a confident claim.
- **Losing the comparison is fine and often true.** A solo-built project being behind a frontier lab on raw capability is expected, not damning — say it plainly. The dishonest move is hiding the gap, not having one.

## Choosing the dimensions

Default to a spine that captures the whole system — product, engineering, operations, and the project's own stated constraints. The example card used these, and they're a strong starting set:

| Dimension | What it measures |
|---|---|
| Grounding / verification engine | The convergence core, canaries, exec-verify, eval discipline — the crown of this project |
| Core product (the chat) | Does dream-chat actually work end-to-end for a real user? |
| Traction / adoption (AARRR) | Does anyone actually *use* it? Acquisition → Activation → Retention → Revenue → Referral. Graded against the 2026 PLG/SaaS benchmarks below. |
| Engineering discipline | ADRs, changelog, tests, monoworkstream, honest reporting — anchored to DORA where deploy data exists |
| Code quality | Are the modules clean, idiomatic, well-commented? |
| Operational health | Do the servers stay up? Boot logs, port conflicts, deploy fragility |
| Raw capability | Measured ability on hard tasks — eval numbers, not promises |
| Scope discipline | Does the running app honor the North Star ("one loop, four objects, reject sprawl")? |

Flex this set to the system's current reality — drop a dimension you can't observe, add one that matters this session (security posture, test coverage, a subsystem that's on fire). Aim for 5–8 rows. Each should be something a thoughtful CTO would actually grade, not filler.

**Traction / adoption is now a first-class, heavily-weighted row** — the honest truth is that a technically-brilliant product with zero users is a hobby, not a business, and hiding that behind engineering grades is exactly the flattery this card exists to prevent. Grade it against the researched benchmarks below, and if the real number is "0 subscribers, 0 B2B," write that plainly (it's likely an F or D, and that's the most important line on the card). Where you have no telemetry to observe adoption, say so — but "we don't measure activation" is itself a finding worth a low grade, since ~66% of PLG companies fail to track the one metric that predicts conversion.

**Scope discipline deserves special attention.** This project's own CLAUDE.md forbids architectural sprawl. If the running app has drifted into trading + Discord + radio + creator tools + 100 MCP tools + 50 HTML surfaces, that's a real low grade against the project's *own stated rule* — and naming it is exactly the honesty the user wants.

## Benchmark anchors (web-researched, 2026 — calibrate grades against these, don't invent thresholds)

These are external, real-world yardsticks so a grade means "vs. what good looks like in the market," not "vs. my mood." Confirm the current figure with a live `WebSearch` when you cite it (products and benchmarks move monthly); these are the starting anchors as of mid-2026. **Grade against the metric where one exists — don't hand-wave a dimension that has a hard number.**

**Traction / adoption (AARRR — [ProductLed](https://www.productled.org/foundations/product-led-growth-metrics), [Mixpanel](https://mixpanel.com/blog/product-led-growth/)):**
- **Activation rate** — good 20–40%, best-in-class 70%+; 40–60% of free users never activate. Only ~34% of PLG companies even track it.
- **Time-to-value (TTV)** — under 10 min (consumer), under 1 hr (B2B). "Value in minutes, not days."
- **Conversion** — freemium ~5% signup→paid; free-trial ~17%.
- **Net Revenue Retention (NRR)** — the growth north star: >110% healthy, 120%+ elite (grow ~2.3× faster); 2026 median compressed to ~101%, so merely >100% is no longer a differentiator. ([SaaS benchmarks](https://pmtoolkit.ai/learn/growth/saas-benchmarks-2026))
- **Churn** — monthly <3% acceptable, top performers <2%; monthly retention ≥95%. ([2026 retention benchmarks](https://www.ever-help.com/blog/saas-retention-rate-benchmarks))
- **NPS** — >50 excellent, <0 signals a real satisfaction/support problem. ([Appcues](https://www.appcues.com/blog/customer-success-metrics))
- **Leading beats lagging** — Product Adoption Score, TTV, CES predict churn before churn rate confirms it; build the read around early signals.

**Engineering discipline / delivery (DORA four keys — [DORA guide](https://getdx.com/blog/dora-metrics/), [2026 benchmarks](https://www.gitrecap.com/blog/dora-metrics-benchmarks)):**
- **Deployment frequency** — elite deploys on-demand / multiple times per day.
- **Lead time for changes** — elite <1 hr (only ~9.4% of teams achieve it in 2026; ~32% sit between a day and a week).
- **Change failure rate** — elite 0–15%; only ~8.5% of teams hold <2%; the largest cohort (~26%) is 8–16%.
- **MTTR (time to restore)** — elite <1 hr.
- 2026 adds a fifth key, **Deployment Rework Rate.** For a solo project, don't demand elite — but a "commits reference uncommitted files → fresh master crashes on boot" incident is a concrete change-failure data point worth citing.

## Grading scale (a workable legend — tie the letter to the metric where one exists)

Use real letter grades with +/- and let them spread. A card where everything lands B/B+ is a sign you're flinching. Where a dimension has a benchmark anchor above, **the grade must be consistent with where the real number falls against it** — don't grade Traction a B when the honest activation number is zero. Calibrate:

- **A** — genuinely excellent, would hold up to outside scrutiny; clears best-in-class on the relevant benchmark (e.g. activation 70%+, NRR 120%+, DORA elite). Rare. Reserve it.
- **B** — solid, real, works; lands in the healthy band (e.g. activation 20–40%, NRR >110%, churn <3%). The honest home for "good but not remarkable."
- **C** — works but with serious caveats, or measured-mediocre (e.g. at/below the compressed median — NRR ~101%, activation present but untracked). Not an insult — a fact.
- **D** — a real problem the user should feel (e.g. users exist but churn is bleeding them out; a metric that should exist isn't measured at all). Use it when earned.
- **F** — broken or absent (e.g. zero users/revenue; a boot-crashing regression; a benchmark the thing simply fails). Don't soften an F into a D to be kind — a zero-traction product graded D is the flinch this card exists to prevent.

The overall grade is a judgment call, not an average — weight by what matters most for *this* system, **and at this stage traction is load-bearing**: a brilliant engine nobody uses caps the overall grade no matter how clean the code is. A brilliant core wrapped in operational fragility and scope sprawl is a B−, not a B+, because the weaknesses are load-bearing. A dimension's own letter grade stays self-referential (does it work, on its own terms); the `Vs Competitors` cell is a separate signal — don't let "behind the frontier labs on raw capability" drag down a grade that's honestly earned on absolute terms. Note the competitive gap explicitly in the overall paragraph instead.

## Output format

Produce exactly this shape:

1. **One or two framing sentences** — what this card is graded on and that it's a grounded snapshot, not a full audit. Set the honesty contract up front.

2. **A markdown table** with columns `Dimension | Grade | Evidence | Vs Competitors`. The Evidence cell must cite something concrete — a log line, a file, a number, a behavior you saw. The Vs Competitors cell must cite a live search result (product/benchmark + what it shows + implicit "as of" recency) or explicitly say the dimension has no direct competitor analog. Keep both tight; this is the receipt, not the essay.

3. **A short "what would raise it" line under the weak grades.** For any row at C+ or below, add one sentence — either inline in the evidence cell or as a brief note below the table — on the single change that would move that grade up. This turns the card from a verdict into a lever. Don't do this for the strong rows; it dilutes the signal.

4. **Bold `Overall: <grade>`** followed by **one candid paragraph** — the honest synthesis. Name the central tension in plain language (e.g. "a brilliant grounding engine and a working chat, wrapped in too much sprawl and operational fragility, held together by unusually good engineering discipline"). This sentence is what the user remembers; make it true and make it land.

### Example (abbreviated)

```
Honest report card, graded on what I actually saw this session — the live chat
test, the boot logs, the codebase, the eval numbers — plus a live web search per
dimension to see where that stacks up against what else exists right now. A
grounded snapshot, not a full audit.

| Dimension | Grade | Evidence | Vs Competitors |
|---|---|---|---|
| Grounding / verification engine | A− | Council (Δ + answerability gate), canaries, exec-verify, "never fake a number" eval discipline. Genuinely novel, cleanly built. | No shipping product does an exact analog; closest public comparisons (agentic-coding self-verify loops) are less strict about mandatory grounding. Ahead on rigor, behind on scale. |
| Core product (the chat) | B+ | Works live — typed, replied, council badge rendered, record logged. | Current ChatGPT/Claude.ai/Gemini all handle the same turn with broader tool ecosystems and no local-only option. Behind on breadth, ahead on ownership. |
| Raw capability | C+ | 0/3 SWE-bench single-shot this session (`data/kalshi/...` eval log). | Frontier models on public SWE-bench leaderboards score meaningfully higher as of this search — real, expected gap for a solo local stack. |
| Operational health | C− | Boot logs: AI Trader crash-looping (`spawn python ENOENT`, gave up after 6 tries); MCP port conflicts; LFS smudge wedges. | No direct competitor comparison — internal-only dimension. |
| Scope discipline | D+ | North Star says "reject sprawl, one loop" — yet the app is trading + Discord + radio + creator tools + ~100 MCP tools + 50 HTML surfaces. Violates its own rule. | No direct competitor comparison — internal-only dimension. |

To raise Operational health: get the dual-server + worktree boot to come up clean
with no crash-looping children. To raise Scope discipline: pick the one loop and
move the rest behind a clearly-optional boundary. To raise Raw capability: closing
the SWE-bench gap needs more than local-only inference — see the local-cloud
parity escalation path already in the codebase.

**Overall: B−**
A brilliant grounding engine and a working chat, wrapped in too much sprawl and
operational fragility, held together by unusually good engineering discipline
that's being stretched past what one person can keep coherent. Against the
frontier labs it's behind on raw capability and breadth, as expected for a
solo-built stack — but ahead on grounding discipline, which is the bet worth
tracking.
```

## Tone

Write like a sharp, fair colleague who respects the user enough to be straight with them. Warm about what's genuinely good, unflinching about what isn't, never cruel and never flattering. The user asked for the truth — the kindest thing you can do is give it to them with the receipts attached.
