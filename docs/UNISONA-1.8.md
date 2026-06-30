# Unisona 1.8 — the personal reasoning cockpit goes public

**Released:** 2026-06-30 · **Version:** 1.8.0 · **Codename:** *one front door*

Unisona 1.8 is a consolidation milestone, not a pile of new architecture. The
project is now **unisona.ai** end to end, and the one loop it has always been —
**Observe → Remember → Reason → Act → Verify → Converge** — now has a
user-facing cockpit at *every* stage. The whole point of 1.8 is that the loop is
finally legible to a person actually using it.

Everything below already shipped across the 1.7.1xx line; 1.8 is the version that
names it.

---

## What's new, by loop stage

The system is one loop with four core objects (Memory, Task, Tool, Convergence
Record). 1.8 doesn't add a stage — it gives each existing stage a surface you can
see and drive.

### 🔭 Observe — the Explore feed
A single ranked feed (`/explore.html`) of things worth your attention — games,
reading, builds, docs, beliefs — every card carrying a `why` and a `source` per
the Verify rule. The 1.8 release itself appears here as a card.

### 🧠 Remember — confidence-decay memory (#1422)
Memory that forgets *gracefully*. A fact's confidence decays over time unless it's
reinforced, so stale claims fade instead of being asserted forever. Persistence is
still append-only JSONL + CSF archive — nothing is deleted, confidence just shifts.

### 💭 Reason — the personal cockpits
- **Financial reasoning cockpit** (#1434) — reasons over your own numbers and
  shows the evidence behind every answer.
- **Personal preference model** (#1426) — retrieval-based: grounds
  recommendations in what you've actually said before, instead of guessing.
- **Learn-anything tutor** (#1438) — an interactive tutor for any topic that
  tracks what you actually retain over time.

### ⚙️ Act — autowork you can steer
In-chat **Approve / Rework / Discard** for autowork draft PRs (#1503), with the
Σ₀ council wired into self-coding runs so convergence Δ accrues on real decisions
(#1598). The harness *is* the product — you stay in the loop.

### ✅ Verify — grounding you can read
- **Fact-check button** (#1430) — paste a claim, get a grounded verdict with
  sources.
- **Grounding Diff viewer** (#1420) — see claim · evidence · source · confidence
  side by side.
- **Drift canaries** (#1428) — passive observability that watches for behavioral
  drift and surfaces it as a signal.
- **Symptom journal** (#1435) — calibrated, cite-or-abstain honesty about health:
  it cites a source or abstains rather than guessing.
- The Σ₀ **council exec-verify** now defaults ON (#1640) and grounds its verdict
  on a real execution check, closing the refuted→retry loop in chat (#1568): a run
  test is ground truth, and execution overrides text.

### 🎯 Converge — calibration and replay
- **Decision journal + calibration** (#1436) — log a decision with your predicted
  confidence, record the outcome later, and get scored on whether your gut calls
  are actually good.
- **Convergence replay / time-travel debugger** (#1419) — step back through the
  convergence records to replay exactly how a conclusion was reached.
- **Verified-patch / honesty / route-quality metrics** (#1411) are now recorded
  as first-class convergence signals.

---

## Under the hood

- **Brand** — home rebranded with canonical + social meta (#1657); every page's
  chrome, nav, and footer rebranded to unisona.ai (#1661); the Triagon low-poly
  signal mascot added (#1604).
- **CSF** — ships the CSF-Col transform and corrects compression on the live
  paths (#1601); the own-the-model PLT training package lands with ADR-0011
  (Proposed) (#1645).
- **Stock trader** — fee-aware trade-EV gate (#1648), surfaced market news
  (#1582), and a global header with a working light/dark toggle (#1579).
- **Chat** — production-grade, continuous voice-to-text dictation (#1607).
- **Security & hygiene** — automation `git` helpers and self-edit/auto-version
  steps routed off the shell through `lib/safe-exec.js`; the consolidation linter
  made multiline-aware to catch interpolated `execSync` sites.

---

## The principle behind 1.8

> Nothing is accepted without evidence. Every important claim carries
> **[claim, evidence, confidence, source]**.

Every cockpit in this release ships under that External Reality Rule. None of them
assert — they cite, or they abstain. That's the whole product: a loop you can
watch ground itself.

**Observe. Remember. Reason. Act. Verify. Converge.**

---

*See also: [Changelog](/changelog.html) · [What's New](/whats-new.html) ·
[Σ₀ Briefing](/repo/docs/CONVERGANCE-SIGMA0-BRIEFING.md)*
