# Backlog, Issue & PR Review Standards

**Status:** Living standard · **Owner:** Alex Place · **Last updated:** 2026-06-29

How we review the backlog, label issues, and triage PRs in Keystone OS. The goal is a backlog that is **honest, prioritised, and small** — every open item is real, scored, and tied to the one loop (Observe → Remember → Reason → Act → Verify → Converge). This doc adapts mainstream GitHub triage practice to the Σ₀ North Star.

> **Σ₀ tie-in.** The backlog is itself a Convergence object. Reviewing it *is* the Converge stage applied to our own work: reject sprawl, demand evidence, keep one source of truth. An issue with no loop-stage and no evidence is not a task — it is noise.

---

## 1. Principles (what "good" looks like)

Drawn from GitHub Docs and current community practice (sources at the bottom):

1. **Every triaged item carries at least three facets: a *kind*, a *priority*, and a *status*.** No bare issues.
2. **Kind labels are mutually exclusive** — pick the one primary intent (`bug` *or* `enhancement`, not both).
3. **Labels use lowercase, hyphenated names with a consistent prefix** (`type:`, `priority:`, `status:`, `area:`). Colour groups by facet so the board is scannable at a glance.
4. **Triage on a cadence, not reactively.** A scheduled pass beats firefighting. Close stale/duplicate items fast (≤48h target) to keep the backlog clean.
5. **Small, focused, single-purpose** issues and PRs. One issue = one outcome. One PR = one reviewable change.
6. **Evidence before assertion (Σ₀).** Any claim of a bug or a result needs `[claim, evidence, confidence, source]`. Unverified claims are tagged, not trusted.
7. **Every shipped surface names a loop stage** or is scheduled for deletion/extraction. This is the sprawl gate.

---

## 2. The label taxonomy

The repo's current labels grew organically (~70 labels, many with empty descriptions and no prefix). **Target state:** every label belongs to exactly one facet below. New labels MUST follow the `facet:value` convention; legacy bare labels are migrated opportunistically during triage.

### 2.1 `type:` — kind (mutually exclusive, exactly one)
| Label | Meaning | Legacy alias |
|---|---|---|
| `type:bug` | Broken behaviour — worked before or should per docs | `bug` |
| `type:feature` | New capability / enhancement | `enhancement` |
| `type:docs` | Documentation only | `documentation`, `docs` |
| `type:refactor` | Code restructuring, no behaviour change | `refactor`, `cleanup` |
| `type:test` | Test / validation work | `test` |
| `type:research` | Investigation, spike, written-up findings | `research` |
| `type:epic` | Umbrella tracking child issues | (prefix `[Epic]` in title) |

### 2.2 `priority:` — urgency (exactly one)
| Label | Meaning | Legacy alias |
|---|---|---|
| `priority:p0` | Pull first — blocks the loop / boot / users | `p0` |
| `priority:p1` | Pull second — important, not blocking | `p1` |
| `priority:p2` | Backlog — do when capacity allows | `p2`, `master-backlog` |

Priority is set **relative to the one loop**: anything that breaks Observe→Converge or the running app is p0. Colour ramp yellow→red.

### 2.3 `status:` — state (exactly one while in flight)
| Label | Meaning |
|---|---|
| `status:needs-triage` | New, not yet assessed (`needs-triage`, `triage`) |
| `status:needs-info` | Blocked on more detail from filer |
| `status:needs-evidence` | Claim not yet reproduced (Σ₀ gate) — `needs-evidence` |
| `status:ready` | Triaged, scoped, pullable by an agent lane (`agent-task`) |
| `status:in-progress` | Has an open PR / active lane |
| `status:blocked` | Waiting on a dependency or a human gate (`needs-founder`) |

### 2.4 `area:` — subsystem (zero or more, but prefer one)
Maps to the loop stage / subsystem: `area:chat`, `area:convergence`, `area:trading`, `area:explore`, `area:mcp`, `area:csf`, `area:infra`, `area:fleet`. Each `area:` should be defensible against the one-loop gate (§4).

### 2.5 Cross-cutting flags (optional)
`good-first-issue`, `help-wanted`, `duplicate`, `wontfix`, `invalid`, `needs-founder` (human gate: security, providers, lore canon, `data/`, pricing), `grade-remediation` (from a grade card).

> **Cleanup task:** the empty-description labels (`debug`, `queue`, `shortcut`, `candidate`, `one-world-leader`, `deck`, …) are either renamed into a facet above or deleted. A label that can't be placed in a facet is a sprawl smell — see [SCOPE-3 #1559].

---

## 3. The review workflow

Run this as a **scheduled pass** (weekly, or after any grade card). Each step is one loop turn.

### Step 1 — Observe: pull the raw state
```bash
gh issue list --state open --limit 200 --json number,title,labels,updatedAt
gh pr list   --state open --limit 100 --json number,title,isDraft,headRefName,reviewDecision,mergeable
```

### Step 2 — Remember: dedupe against history
Before touching an item, check it isn't already done. **Most open issues here are already-implemented-but-unclosed** — grep `master` first. Mark true dupes `duplicate` and close, pointing at the canonical issue.

### Step 3 — Reason: classify each issue
For every open issue, ensure it has **type + priority + status + ≥1 area**. Apply the one-loop gate (§4). If it names no loop stage and isn't a bug/op-health item → it's sprawl; route to the scope decision, don't silently keep it.

### Step 4 — Act: update labels, titles, links
- Normalise the title (imperative, scoped, `[Epic]`/`[AREA-n]` prefix where used).
- Set labels per §2. Link children to epics and related issues (`Depends on #`, `Closes #`).
- Add a short triage comment when you change something non-obvious.

### Step 5 — Verify: reproduce claims (Σ₀)
For any `type:bug` or asserted result, attempt a **cheap reproduction** (grep the code, run the check). Upgrade `(verify)` / `status:needs-evidence` → confirmed evidence with `file:line`, or downgrade/close if it doesn't reproduce. *Example: OH-1 #1548 was reproduced to `trader-agent.js:431` + 5 sibling `spawn('python')` sites during the 2026-06-29 pass.*

### Step 6 — Converge: record the pass
Append a convergence record (date, counts before/after, issues closed, items refined, new highest-value work filed). When a grade card drives the pass, the record is the grade-card entry (see the `make grade` capstone [#1563]).

---

## 4. The one-loop gate (sprawl control)

Before keeping **or filing** any issue, answer: **which loop stage does this strengthen?**

| Stage | Keep if it improves… |
|---|---|
| Observe | input capture / status |
| Remember | memory retrieval, JSONL/CSF persistence |
| Reason | planning, routing, model selection |
| Act | tool execution, reliability, observability |
| Verify | grounding, evidence, eval, canaries |
| Converge | metrics, sprawl reduction, dedupe |

Names a stage → keep and label `area:`. **Names no stage** → it's a candidate for extraction or deletion; attach to the scope decision (e.g. [SCOPE-4 #1560]) rather than leaving it as live backlog. New product surfaces that add an independent ecosystem (separate agent fleets, separate memory systems, digital-twin features) are **forbidden** regardless of apparent value.

---

## 5. PR triage standards

A PR is reviewed on four components: **title, description, diff, metadata** (labels, linked issue, CI). Standards:

- **Small and single-purpose.** Large multi-concern PRs get sent back to split.
- **Links its issue** (`Closes #N`) so merge auto-closes the work.
- **Draft = not-ready-but-open-for-feedback.** In this repo, the fleet opens DRAFT PRs; a draft is *work-in-progress*, not a merge candidate.
- **Triage rule (Keystone-specific):** fleet **DRAFT** slop with no real diff → **close**, don't merge. `pr-watcher.js` auto-merges only **READY** PRs that pass the verdict gate. Conflicts are almost always CHANGELOG/`package.json` bumps.
- **Per-agent lane rule:** one open PR lane per agent prefix (`claude/`, `gemini/`, …). Don't open a second lane branch until the first merges.
- **Stale PRs:** if a branch has rotted against `origin/master` or duplicates landed work, close it with a reason rather than letting it linger.
- **Merge method:** squash by default; commits on an open PR branch ride the squash.

---

## 6. Definition of Done for a triaged backlog

A pass is complete when:
- [ ] Every open issue has `type:` + `priority:` + `status:` + ≥1 `area:`.
- [ ] No issue asserts an unreproduced bug without `status:needs-evidence`.
- [ ] Duplicates/stale items closed with a pointer.
- [ ] Every kept item names a loop stage (§4); sprawl routed to a scope decision.
- [ ] Epics link their children; children link back.
- [ ] PR lanes ≤1 per agent; draft-slop closed; ready+green PRs merged.
- [ ] A convergence record / grade-card entry appended for the pass.

---

## Sources

GitHub's own docs plus current (2025–2026) community practice:

- [Managing labels — GitHub Docs](https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/managing-labels)
- [Best practices for Projects — GitHub Docs](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/best-practices-for-projects)
- [Helping others review your changes — GitHub Docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/getting-started/helping-others-review-your-changes)
- [Issues Triaging — microsoft/vscode Wiki](https://github.com/microsoft/vscode/wiki/Issues-Triaging)
- [GitHub labels — Python Developer's Guide](https://devguide.python.org/triage/labels/)
- [How to Use GitHub Labels: The Definitive 2025 Guide](https://flavor365.com/mastering-github-labels-for-issues-pull-requests/)
- [Best Practices for Organizing and Using GitHub Labels](https://bestpractices.net/best-practices-for-organizing-and-using-github-labels/)
- [Mastering GitHub Issues — GitProtect.io](https://gitprotect.io/blog/mastering-github-issues-best-practices-and-pro-tips/)
- [GitHub PR Review: Best Practices and Tools (2026) — DEV](https://dev.to/rahulxsingh/github-pr-review-best-practices-and-tools-2026-1p90)
- [Pull Request Best Practices: A Complete Guide (2026) — DeployHQ](https://www.deployhq.com/blog/the-perfect-pull-request-best-practices-for-collaborative-development)
- [Issue Tracking Best Practices — Kunj Patel](https://www.kunj.dev/blog/2025-08-16-issue-tracking-best-practices)
