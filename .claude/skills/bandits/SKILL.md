---
name: bandits
description: Chase the convergence loop's highest-value open uncertainties — treat each unresolved question/PR/GAP/unverified-claim/planned-benchmark as a bandit arm, score them by value-of-information per cost, pull the top *cheap and reversible* one by acting to resolve it, record what reality answers, and report what's next by value. Use whenever the user types `/bandits` or `!bandits`, or asks to "chase bandits", "what's the highest-value thing to resolve/work on next", "steer the loop", "which experiment should we run", "explore/exploit", "what should I burn tokens on", "pick the next move by value", or "what's the most valuable unknown to close". Trigger even when they don't say "bandit" — any request to *rank the open uncertainties by value and act on the best one* is this skill. Do NOT use it to merge every ready PR (that's a converge/refinement pass), to grade the app (report-card), to review a PR diff (code-review), or to run the full benchmark suite (benchmarks) — those are single-arm pulls this skill may *recommend*, not the skill itself.
---

# Bandits — directed exploration of the convergence loop

The user wants the single most valuable move the system could make right now — **not a status
report, not "merge everything," but the one uncertainty whose resolution buys the most, resolved
by acting.** This is the Converge stage run as a practice: enumerate the open unknowns as *arms*,
score them by value-of-information per cost, pull the best cheap/reversible one by taking a real
action, and record what reality answers.

It is the operational form of the loop's own theory. The [collapse certificate §10 (Part IV)](../../../docs/SIGMA0-COLLAPSE-CERTIFICATE.md)
and the [Oracle design §7](../../../docs/CONVERGENCE-ORACLE-DESIGN.md) split exploration into two
legs: a **no-regret floor** (anti-collapse = persistent excitation = never get permanently stuck)
and **directed steering** (spend each token on the highest-value experiment). Anti-collapse gives
the first for free. *This skill is the second.*

## The bandit picture — say it honestly, then act

The classic stochastic bandit is *solved* (Lai–Robbins 1985 lower bound; UCB/Thompson match it).
The loop's bandit is **not** — it is non-stationary, structured, VoI-rewarded, and ultimately
open-ended (the arm set keeps growing), so **there is no fixed optimum to "solve" toward.** You do
not need it solved. You need **no-regret** (never lock out a good arm — the anti-collapse floor
already provides it) plus **directed VoI steering** (this skill). "Burning tokens" is not a tax you
pay until the bandit is solved and then stop — for an open-ended loop it is the *permanent cost of
exploration*, and the whole game is spending it on the highest-value arm each tick. Never promise
"solved." Promise: *the most valuable resolvable unknown, pulled.*

## The four moves (every run does all four)

1. **PLACE** — enumerate the arms (below), and separate the **resolvable** from the **pins**. A pin
   is a structurally-unresolvable-now unknown (an un-run future, an undecidable, a question no
   available action settles). **Name pins, never bluff them** — they get VoI 0 and are excluded, not
   guessed at.
2. **SCORE** — value-of-information per cost, using the scorer `experiments/oracle_voi_select.py`
   (PR #2821): VoI ≈ the prior uncertainty the arm would resolve (high for *corpus-absent /
   only-knowable-by-acting*, low for things inference already knows), cost by **reversibility**
   (cheap+undoable = 1; money/irreversible = high). Rank by VoI ÷ cost. This is Howard 1966 (value
   of information) / Lindley 1956 (optimal experimental design) / Krause–Guestrin greedy —
   **established, no novelty claimed.**
3. **PULL** — take the resolving **action** on the top arm(s) within a budget, *cheapest and most
   reversible first* (the design's staging-by-irreversibility). Local code execution, a test run, a
   web-check, a `!work #N`, a benchmark harness → each **manufactures a corpus-absent fact** the
   loop did not have. **Default budget: pull the single top cheap+reversible arm and report.** Money
   or irreversible pulls (a live trade, a deploy, a mass edit) are **recommended, then require an
   explicit go** — they stay behind the same NAP/approval gates that govern the trader.
4. **RECORD** — file the resolved fact as a grounded record `[claim, evidence, confidence→resolved,
   source=the action]` (the shape `experiments/oracle_active_loop.py` writes to
   `data/oracle/active-loop-runs.jsonl`), so the pull compounds. Claim **only what the action
   resolved** — an unresolved prediction stays unverified; a pin stays a pin.

## Where the arms come from (enumerate these, live, every run)

Do not invent arms — read them off the real system this session:

| Arm source | How to enumerate | A "pull" is |
|---|---|---|
| **Open PRs needing a resolving action** | `gh pr list --state open` + `gh pr checks` / mergeable | run CI, resolve a conflict, review, or merge a green+reviewed one |
| **Planned benchmarks (📋)** | `docs/BENCHMARKS.md` rows marked 📋 / 🟡 | run the harness → a measured number (a corpus-absent fact) |
| **Unverified / seam_open claims** | convergence records + design docs' `[claim … confidence]` lines, honesty/verify ledgers | run the verifying action (test, web-check, execution) |
| **Design GAPs / next rungs** | blueprint GAPs, certificate open gaps, Oracle design §5 rungs | build + measure the next brick |
| **Autowork-able issues** | `gh issue list` where an action resolves it | `!work #N` → real patch + tests |
| **Candidate-novel conjectures** | IP register / design docs graded `seam_open` | the prior-art clearance search or the empirical run that settles it |

Each is an arm whose payoff is *fresh verified truth*. The most valuable are usually **cheap,
reversible, high-uncertainty, and resolvable now** — a planned benchmark you can run, a seam_open
claim one test would settle, a green PR one command lands. The least valuable: obvious facts
inference already has, and pins.

## The no-regret rule (don't become the 42-machine of one arm)

Chasing bandits is **not** grinding one arm to the exclusion of all others — that is premature
exploitation, which *is* the σ=0 / 42-state collapse the certificate is built against. Two guards:

- **Rotate.** If the last N pulls all hit the same source (all PRs, or all one subsystem), force the
  next pull to a *different* arm source even at slightly lower VoI — persistent excitation across the
  arm space. A skill run that only ever merges PRs is stuck, not steering.
- **Re-score every run.** VoI is not static — resolving one arm changes the others' value (that's
  the submodularity the greedy guarantee leans on). Never cache a ranking across runs.

## Output format

1. **The board** — a ranked table of the top ~6–8 arms: `VoI/cost · VoI · cost · source · one-line`,
   with pins listed separately as *excluded, named* (never scored into the pull).
2. **The pull** — which arm(s) you took, the *actual action run*, and **what reality answered**
   (the resolved fact), or — for a money/irreversible arm — the recommendation + the explicit
   confirm you're waiting on.
3. **The record** — the grounded line filed, and any calibration/ledger update.
4. **Next** — the top 1–2 arms for the next tick, and one honest line on whether the loop got
   *stronger* (a real unknown closed) or just churned.

## Tone & honesty (non-negotiable — this is a Σ₀ artifact)

- **Never bluff a pin.** "No action available now resolves this" is a valid, valuable output.
- **Claim only what resolved.** The pull's fact is certain *because reality answered it*; everything
  else keeps its prior confidence. Do not report a plan as a result.
- **Stage by irreversibility.** Cheap+reversible pulls run by default; money/irreversible ones are
  recommended and gated on an explicit go.
- **No "solved."** The honest promise is a valuable unknown *closed*, and the next one named — the
  staircase climbs one measured step, it does not arrive.
- **Ground every arm.** An arm you cannot point at in the real system (a PR number, a ledger row, a
  GAP line) is not an arm. Read them; don't imagine them.
