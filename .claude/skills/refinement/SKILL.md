---
name: refinement
description: Groom the Keystone OS GitHub backlog to the agile Definition-of-Ready bar — route every open issue to a dev lane (kriskin / mookman / alex), set its milestone, set its priority (p0/p1/p2), fill its type, flag thin issues needs-triage, and set its assignee, then report what changed. Use this whenever the user types `/refinement`, or asks to "refine the backlog", "groom the backlog", "triage the issues", "prioritize the backlog", "assign lanes", "label the backlog by lane", "set milestones on the issues", "assign the issues to kriskin/mookman/alex", "sort the backlog into lanes", or otherwise wants open issues distributed across the three contributor lanes with labels, milestones, priorities, and assignees. Trigger even when the user doesn't say "refinement" — any request to organize/distribute/triage/prioritize the open GitHub issues is this skill. Do NOT use it to actually write code for an issue (that's autowork), to grade the app (that's report-card), or to review a single PR diff (that's code-review).
---

# Backlog Refinement

Keystone OS is built by three contributor lanes. The backlog is only useful if every open
issue is *ready to pull from the top* — sitting in the right lane, in the right milestone,
prioritized, typed, and owned. This skill does that grooming pass —
**route → milestone → prioritize → type → readiness-check → assign → report** — and nothing
more. It does not write code and does not invent work; it organizes what already exists.

The goal is the agile **Definition of Ready**: a backlog item is "ready" when it's *Detailed,
Estimated/typed, and Prioritized* (the DEEP model), so a lane can pull the top item and start
without re-litigating scope. Refinement is what gets each item to that bar — see
[What "groomed" means](#what-groomed-means--the-definition-of-ready) below.

## The three lanes (the routing rubric)

These are the live `lane:*` labels and their charters. Route each issue to the **one** lane
whose charter best fits the work — not the person, the *work*:

| Lane label | Owner login | Charter — route here when the issue is about… |
|---|---|---|
| `lane:kriskin` | `kriskin9-hash` | **Frontend.** Trader / Kalshi terminal, UI & UX, Explore feed, dream-chat front-end, CSS / responsive / theming, Three Doors & deck visuals. Title prefixes like `[trader]` are a dead giveaway. |
| `lane:mookman` | `Mookman11` | **Model.** Σ₀ PLT, CSF, evals & benchmarks, reasoning, training, Ouro, local models, distillation, parity work. |
| `lane:alex` | `alex-place` | **Backend & direction.** Ops / infra, deploy, providers, security, chat reliability, autowork / orchestration, data plumbing, North-Star / scope-discipline. **This is also the catch-all** — when an issue is genuinely cross-cutting or you can't confidently place it, it lands here. |

**Mapping gotcha — burn this in:** the lane *label* short-name is **not** the GitHub handle.
`lane:kriskin` → `kriskin9-hash`, `lane:mookman` → `Mookman11`, `lane:alex` → `alex-place`.
The mapping lives in one place — [`scripts/_lane-map.sh`](scripts/_lane-map.sh) — and the scripts
derive the login from the lane themselves, so you never pass a login by hand. If the handles ever
change, edit that one file. (Assuming login == lane name once invited two unrelated strangers.)

**How to route well.** You're smart enough to read an issue and know whose work it is — use
the charter as the rubric, not a keyword lookup. Strong signals, in order:
1. **Existing non-lane labels.** `ui`, `three-doors`, `door-game`, `deck` → kriskin. `ouro`,
   `training`, `eval`, `local-model`, `sigma0-*`, `csf-agent` → mookman. `security`, `deploy`,
   `op-health`, `fleet`, `orchestrator`, `cloud-provider`, `scope-discipline` → alex.
2. **Title prefix / subject.** `[trader]…` → kriskin; "Σ₀ own-model / parity / benchmark" → mookman.
3. **The body.** Read the 400-char excerpt the fetch script returns; it usually settles ties.

When two lanes both seem plausible, pick the one matching the issue's *primary deliverable*
(the thing that gets built), and when it's truly ambiguous, default to `lane:alex` — that's
what its catch-all charter is for. Don't agonize; a defensible route beats a stalled run.

> The charters are stable, but **verify the live state each run** — milestones and collaborator
> membership drift. Don't hardcode; read them (the scripts do this for you).

## Decisions baked into this skill

These were chosen for this backlog and are the defaults every run follows:

- **Lane is recorded two ways:** the `lane:*` label *and* the GitHub assignee for that lane.
- **Milestone target is `1.9`**, applied **fill-gaps only** — set `1.9` on issues that have no
  milestone; never yank an issue out of a milestone it's already in. (Override per run if asked.)
- **Priority is required** — every issue gets `p0`/`p1`/`p2` (fill-gap; don't override an
  existing one unless re-prioritizing is asked for).
- **Type is fill-gap** — add a `bug`/`enhancement`/`documentation` label only when the issue
  has none; never fight the author's existing categorization.
- **Thin issues are flagged, not assigned** — an issue that fails the Definition of Ready gets
  `needs-triage` and is left *unassigned* (you don't put un-ready work on someone's plate).
- **Apply automatically.** Don't gate the routing behind a confirmation prompt — make the
  changes, then show a summary of everything that moved.
- **One human gate, and only one:** sending a collaborator **invite**. Inviting a real person
  emails them and is hard to undo, so it always waits for an explicit yes (see below).

## What "groomed" means — the Definition of Ready

Grooming isn't just sorting; it's bringing each item up to the bar where a lane can pull it and
start. Four checks, each mapped to an existing repo label so we add rigor, not sprawl:

**1. Prioritized** (`p0` / `p1` / `p2`). Every backlog item should carry a priority so the lane
pulls the highest-value work first. Use this taxonomy (adapted from Kubernetes' battle-tested
tiers to the repo's three buckets):

| Label | Means | Route here when… |
|---|---|---|
| `p0` *(Pull first)* | **Critical / urgent.** Drop-everything. | Security holes, data loss/leak, prod down, broken build/tests, user-visible breakage of a core feature. Signals: `security`, `op-health`, "regression", "crash", "down", "leak". |
| `p1` *(Pull second)* | **Important / soon.** The default for real, ready work this cycle. | Concrete `fix(`/`feat(` work, actionable bugs and features with a clear deliverable. |
| `p2` *(Backlog)* | **Nice-to-have / long-term.** | Research, exploration, `[Epic]`s, `scope-discipline`, `needs-evidence`, anything not staffed for soon. Also the home for issues that fail readiness. |

**2. Detailed enough (Definition of Ready).** An issue must be clear enough that someone could
start it without asking "what does this even mean?" If the body is empty/near-empty or a
placeholder ("Issue reported from screenshot", a bare title, a TODO), it **fails DoR**: flag it
`needs-triage`, drop it to `p2`, and **don't assign it**. It needs a human to flesh it out
before it's pullable. (Removing `needs-triage` later, once detailed, marks it ready again.)

**3. Typed** (`bug` / `enhancement` / `documentation` / `refactor`). Categorize so the backlog
is filterable. Infer from the conventional-commit title: `fix(…)` → `bug`, `feat(…)` →
`enhancement`, `docs(…)` → `documentation`. Fill-gap only — leave an existing type alone.

**4. Owned** (lane + assignee). Covered by the routing rubric above.

> **Epics aren't leaf tasks.** An `[Epic]`/parent issue is a container, not a unit of work —
> give it a lane and `p2`, but don't treat it as "ready to pull" or size it like a normal issue.
> Its child issues are where the real grooming happens. (GitHub Projects: break big work into
> small sub-issues and mark dependencies.)

## The run

All four scripts live in `scripts/` next to this file. Run them with the Bash tool.
Let `SK` be this skill's directory.

### 1. Fetch what needs grooming (read-only)

```bash
bash "$SK/scripts/fetch-backlog.sh"            # un-groomed open issues (the default target)
bash "$SK/scripts/fetch-backlog.sh --all"      # re-evaluate everything (use to fix a misroute)
bash "$SK/scripts/fetch-backlog.sh 1712 1711"  # only specific issues
```

You get a JSON array of `{number, title, labels, milestone, assignees, lane, body}`. An issue
is "un-groomed" if it's missing a lane, a milestone, **or** an assignee — so most issues will
appear until assignees are filled in.

### 2. Check assignability, and offer to invite (the one gate)

```bash
bash "$SK/scripts/check-collaborators.sh"
```

Each lane user prints as `collaborator` (assignable now), `invited` (pending — **not** yet
assignable), or `none`. GitHub won't accept an assignee who isn't an *accepted* collaborator.

- If a lane user you're about to assign is `none`: **stop and ask the user** whether to invite
  them, e.g. *"`kriskin9-hash` and `Mookman11` aren't collaborators yet — invite them (push
  access) so they can be assigned? Otherwise I'll set lane labels + milestones and leave
  assignees for later."* **Confirm the exact login with the user before inviting** — a wrong
  handle emails an unrelated stranger. Only on an explicit **yes** run (use the real logins):
  ```bash
  bash "$SK/scripts/invite-collaborator.sh" kriskin9-hash
  bash "$SK/scripts/invite-collaborator.sh" Mookman11
  ```
- Newly invited (or already `invited`) users still can't be assigned until they accept. That's
  fine — `apply-refinement.sh` sets the label + milestone and reports the assignee as
  **deferred**. Re-run refinement after they accept to fill the assignees in.
- `alex-place` is the owner and always assignable.

Never invite without that yes. Everything else in the run is automatic.

### 3. Decide and apply, one issue at a time

For each fetched issue, make the four readiness calls (lane, priority, type, readiness) from
the rubric above, then apply them in a single command:

```bash
# Ready issue → lane + milestone (gap) + priority + type + assignee:
bash "$SK/scripts/apply-refinement.sh" 1712 kriskin --milestone 1.9 --priority p1 --type enhancement --ready

# Thin issue (fails Definition of Ready) → flagged + parked at p2, NOT assigned:
bash "$SK/scripts/apply-refinement.sh" 1738 alex --milestone 1.9 --priority p2 --triage

# Issue that already has a milestone → omit --milestone (fill-gap):
bash "$SK/scripts/apply-refinement.sh" 1703 mookman --priority p1 --type bug --ready
```

Flags: `--milestone <t>` · `--priority p0|p1|p2` · `--type bug|enhancement|documentation` ·
`--triage` (flag un-ready; also skips assignee) · `--ready` (clear a stale `needs-triage`) ·
`--no-assignee`. The assignee login is derived from the lane — you never pass it.

The script batches every label + milestone change into **one** `gh issue edit` call (fast,
atomic), is idempotent (skips already-correct fields), and sets the assignee as a separate step
that **re-reads to confirm it stuck** — GitHub silently drops an assignee whose invite isn't
accepted while `gh` still exits 0, so the script reports `deferred` honestly rather than
claiming a phantom assignment. Apply milestone fill-gaps: omit `--milestone` (or pass `-`) when
the fetched issue already has one.

Process issues directly — there's no confirmation gate here (that was the chosen mode). With
~100 issues this is a real batch; the cleanest path is to compute each issue's decision in a
small script (mirroring the rubric) into a worklist, then loop the apply over it, keeping each
one-line output so you can summarize.

### 4. Report what changed

End with a compact markdown summary the user can scan — this is the deliverable of an
auto-apply run, the receipt for what just happened:

```
## Refinement — N issues groomed
| Lane | Issues | → 1.9 | Assigned | Deferred | p0 / p1 / p2 |
|---|---|---|---|---|---|
| kriskin | 36 | 25 | 36 | 0 | 1 / 28 / 7 |
| mookman | 26 | 19 | 6 | 20 | 0 / 18 / 8 |
| alex    | 44 | 30 | 44 | 0 | 3 / 25 / 16 |

Readiness: 5 issues failed Definition of Ready → needs-triage (parked p2, unassigned): #1738 …
Deferred assignees (waiting on invite acceptance): Mookman11 ×20 — re-run after they accept.
A couple of judgment calls: #1747 → alex p0 (groundedness regression); #1742 [Epic] → alex p2.
```

Surface anything the user should know: deferred assignees, the `needs-triage`/un-ready list,
any `p0` you raised (and why), and any issue you deliberately left alone.

## Arguments

`/refinement` accepts free-text after it; interpret it against these defaults:
- **issue numbers** (`/refinement 1712 1711`) — groom only those.
- **`--all`** — re-evaluate every open issue, not just un-groomed ones (to fix misroutes).
- **a different milestone** ("into 1.8", "milestone 1.8") — use that instead of `1.9`.
- **"plan only" / "dry run" / "don't apply"** — do steps 1–2 and print the routing table you
  *would* apply, then stop. Honour this even though auto-apply is the default; it's the safe
  way to preview a big batch.
- **a single lane** ("just the trader stuff", "only kriskin") — fetch all, but only apply to
  issues you route to that lane.
- **"re-prioritize" / "re-triage"** — override the fill-gap defaults and re-evaluate priority
  (and type) on issues that already have them, not just the gaps.

## Gotchas

- **`gh pr create` is broken in this environment** — irrelevant here (we only touch issues via
  `gh issue edit` and `gh api`), but don't reach for it.
- **Assignee ≠ label.** The label is the durable routing record; the assignee is a courtesy
  that depends on collaborator acceptance. A deferred assignee is not a failure — the lane is
  still recorded by the label.
- **Don't re-milestone silently.** Fill-gaps is deliberate: moving an issue already slotted
  into 1.8 (the current sprint) out to 1.9 would quietly de-prioritize it. Only overwrite a
  milestone if the user asked.
- **Lanes are exclusive.** One `lane:*` per issue — the apply script enforces this, so a
  re-route cleans up the old lane label automatically.
- **This skill never writes code.** If an issue needs *doing*, that's `autowork` (`!work #N`),
  a separate skill. Refinement only organizes.
- **Priority/type are fill-gap by default.** Don't churn labels someone set deliberately. Only
  re-prioritize / re-type when the user explicitly asks ("re-prioritize the backlog").
- **Don't over-promote to `p0`.** p0 means drop-everything; if everything is p0, nothing is.
  Reserve it for genuine urgency (security, data loss, prod down, broken build).

## Why these fields (grounded)

The readiness bar isn't invented here — it's standard agile backlog hygiene, adapted to the
repo's existing labels:
- **DEEP** (Detailed, Emergent, Estimated, Prioritized) and the **Definition of Ready** — a
  backlog item should be clear and small enough to start, and carry a priority:
  [Atlassian — Backlog refinement](https://www.atlassian.com/agile/scrum/backlog-refinement),
  [Aha! — Product backlog refinement](https://www.aha.io/roadmapping/guide/release-management/product-backlog-refinement).
- **Priority taxonomy** — adapted from Kubernetes' critical-urgent / important-soon / backlog
  tiers down to `p0`/`p1`/`p2`:
  [Kubernetes — Issue Triage Guidelines](https://www.kubernetes.dev/docs/guide/issue-triage/).
- **Milestones, labels, priority, assignees, breaking work into small issues** as the core
  planning metadata:
  [GitHub Docs — Best practices for Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/best-practices-for-projects).
