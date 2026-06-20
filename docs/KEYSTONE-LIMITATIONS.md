# Keystone — What it can't do (yet)

**Date:** 2026-06-20 · An honest, evidence-tagged audit of current limitations, per the External Reality Rule. Tags: **[measured]** / **[observed]** (seen live) / **[design]** (a deliberate constraint) / **[fixed]** (resolved in this pass).

## Answering & chat
- **No live web fetch by default.** Answers draw on the model's training knowledge; "latest / today / current price" questions can be stale unless web-grounding supplies fresh sources. [observed]
- **Media only with known-real URLs.** It renders inline images and YouTube embeds, but won't *invent* a media URL — so for things it isn't sure of, it links the source page instead of embedding. [design]
- **Mislabeled/misrouted questions.** The intent classifier used substring matching, so `pr` matched inside "com**pr**ehensive" and `ui` inside "b**ui**ld" — tagging ordinary questions as the "code / GitHub route". **[fixed]** — now whole-word matching (`convergance-os/model-router.js`).
- **No image/file input in the answer path.** The composer's attachment is for journaling, not "analyze this screenshot and answer." [observed — verify]
- **No automatic cross-session recall in chat.** Within a session, context carries (#772); across sessions it does not auto-recall — that lives in the journal / CSF and is manual. [observed]

## Autonomy & the convergence loop
- **The loop doesn't run end-to-end in the live serving path.** Chat emits Convergence Records but nothing grades most of them, so Keystone does **not** yet learn from ordinary conversations — only the Kalshi trade slice closes Reason→Verify→Converge. [agent-spine note]
- **Governors aren't gating live actions.** The grounding throttle and the Σ₀ surprise canary exist but aren't yet wired onto every action. [agent-spine §6.5]

## Autowork (autonomous issue-fixing)
- **Reuses `auto/issue-N` branches** → a second run on the same issue fails to push (non-fast-forward), and a prior bad run poisons re-runs. [observed]
- **Runs in the main checkout**, so any dirty working tree blocks it (its own error suggests "use a dedicated worktree"). [observed]
- **Patch quality is LLM-bound** — it self-corrects via a retry loop, but can still produce weak or mis-targeted diffs. [observed]

## Skills & the local kernel
- **Only 4 skills are real** — `dream_journal`, `lucid_dreaming`, `archive_curator`, `voice_curator`; the rest are design contracts, not live. [CLAUDE.md]
- **The local kernel (Ouro-1.4B) is weak** — ~10% pass@1 on HumanEval — so quality depends on cloud routing; "models are interchangeable" by design. [measured]

## Housekeeping
- A couple of autowork runtime logs (`data/agi-benchmark.jsonl`, `data/convergence-autonomous-work.jsonl`) are untracked churn — candidates for the gitignore sweep. [observed]

---

**Improved in this pass:** the intent-classifier substring bug above. The remaining items are the live backlog; the highest-leverage next ones are wiring §6.5 (grounding gate + Σ₀ canary) so chat interactions actually feed the loop, and isolating autowork in a dedicated worktree.
