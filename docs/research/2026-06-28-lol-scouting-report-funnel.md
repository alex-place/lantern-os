# Handoff: LoL Scouting Report — the free→paid conversion feature

**Date:** 2026-06-28
**Author:** Keystone (engineering)
**Status:** Proposed (needs Alex's ADR sign-off before code — see [ADR approval gate](../adr/README.md))
**One-liner:** A Discord/lantern-os command that pulls a League player's Riot match data and returns an AI scouting report. The *free* version is the recruiting hook; the *paid* version is the conversion. One new Tool surface feeding the existing Convergence Core — not a new system.

---

## 1. Why this feature

Goal (from Alex): **recruit LoL randoms via Discord and convert them into lantern-os + Patreon engagement.** Not auto-join, not a generic LFG bot. The scouting report is the single artifact that does all three jobs:

- **Hook** — randoms love seeing their own account analyzed; it's inherently shareable.
- **Bridge** — generating the report links a Discord user to a lantern-os identity (via their Riot account).
- **Conversion** — the report is deliberately split across a free/paid boundary so the free taste sells the paid depth.

The product they fall for is the **lantern-os agent doing the reasoning**, not League. League is the doorway.

---

## 2. Σ₀ fit (must pass the feature gate)

Per [CONVERGANCE-SIGMA0-BRIEFING.md](../CONVERGANCE-SIGMA0-BRIEFING.md), every feature names a loop stage or it's rejected. The scouting report maps cleanly and adds **no new memory system and no independent agent ecosystem** (both forbidden):

| Piece | Σ₀ component | Loop stage |
|---|---|---|
| Riot match-history + mastery ingest | [03] LANTERN-MEMORY (append-only JSONL) | Observe / Remember |
| Report generation (coaching reasoning) | [06] LANTERN-CODER *as a task type* | Reason |
| Discord reply / lantern-os.net render | [05] LANTERN-TOOLS (MCP-compatible Tool) | Act |
| Post-game outcome confirms/denies coaching | [07] LANTERN-VERIFY (`claim/evidence/confidence/source`) | Verify |
| Player coaching patterns accrue confidence | [11] LANTERN-CONVERGENCE | Converge |

**Tension to hold honestly:** Principle 6 (local-first, no cloud dependency). Discord is an external edge. It is allowed only as a *thin Tool* — the Convergence Core stays local and authoritative; Discord reads/writes the same JSONL memory. If the Discord side ever grows its own state/agent, it becomes sprawl and must be rejected.

---

## 3. Grounding (claim / evidence / confidence / source)

The free/paid plan is gated by two external realities verified on 2026-06-28:

1. **Public use requires an approved Riot *production* key + RSO; personal keys may not serve public consumption (incl. open beta). Review is weekly to ~3 weeks.** — *Confidence: high.* Source: [Riot Dev Portal FAQs](https://developer.riotgames.com/docs/faqs), [RSO docs](https://support-developer.riotgames.com/hc/en-us/articles/22801670382739-RSO-Riot-Sign-On), [API T&C](https://support-developer.riotgames.com/hc/en-us/articles/22698917218323-API-Terms-and-Conditions).
2. **Patreon→Discord tier→role sync is native (first-party bot, daily sync); lantern-os only reads the role.** — *Confidence: high.* Source: [Patreon Discord setup](https://support.patreon.com/hc/en-us/articles/213552323-Setting-up-Discord-for-your-members), [Patreon X Discord](https://discord.com/safety/patreon-x-discord).
3. **Match-V5 + champion-mastery are accessible on a personal key (rate-limited, no increases), so the free report is buildable now for a small private community.** — *Confidence: medium-high.* Source: Riot Dev Portal.

**Consequence — two phases, not one:**
- **Phase 0 (now):** private squad tool, personal key, no RSO. Legal. Becomes the *working prototype* Riot requires.
- **Phase 1 (public recruiting):** submit Phase-0 prototype for production key + RSO **before** onboarding randoms. Bake the approval wait into the timeline.

---

## 4. The free / paid boundary (the core design)

Same command, same data fetch — the **depth and persistence** of the reasoning is what's gated. The free tier must feel genuinely useful so the paid tier feels obviously worth it.

### FREE (`/scout <riot-id>`) — the hook
- Last-20-games summary: winrate, top champs, primary role, KDA trend.
- **One** AI insight ("you die most in the 10–15min window").
- Rate-limited: **N free scouts/day** (start N=3).
- Footer CTA: *"Members get unlimited scouts + full coaching + tracked progress → <patreon link>"*.
- **No persistence** beyond the ephemeral reply — free reports are not written as durable Memory.

### PAID (Patreon role unlocks it)
- Unlimited scouts.
- **Full coaching report**: per-phase breakdown, champion-specific advice, matchup notes, itemization tendencies.
- **Account tracking** — report is written to LANTERN-MEMORY; the agent *remembers the player across games* and coaching improves over time (retrieval, not retraining — Principle 5).
- **Convergence loop**: each piece of advice becomes a ConvergenceRecord; the *next* report cites whether the player improved on the last suggestion (`claim → evidence → confidence`). This is the genuine differentiator — "a coach that learns your account" — and it is the Verify→Converge stage made visible.
- Renders the full history on **lantern-os.net** (continuity = stickiness; pulls them off Discord onto the product).

**The boundary is the moat:** the free report is a static read; the paid report is the *loop* (memory + verification + convergence). That mapping is both the sales pitch and the Σ₀ justification — the paid tier is literally "more of the core loop."

---

## 5. Conversion plumbing (mostly off-the-shelf)
- Patreon's native Discord bot syncs tier → Discord role daily (grant it **Manage Roles + Create Invite**, drag it above other roles, "Sync All Members" to backfill).
- lantern-os does **not** rebuild any of this — it only **reads the Discord role** to decide free vs. paid behavior in the bot handler.
- Tiers map to existing Keystone plans (Member $5 / Supporter $20 / Pilot $200) — see [patreon-revenue-streams](../../README.md).

---

## 6. Build scope — Phase 0 MVP (smallest thing that recruits)
1. Discord bot with **one** command: `/scout`.
2. Riot client (personal key): resolve Riot ID → PUUID → Match-V5 last 20 + champion-mastery. Rate-limit aware (personal-key budget).
3. Report generator: route the match summary through the existing chat/coder reasoning path (no new agent — a task type). Free vs. paid branch on Discord role.
4. Free-scout daily counter per user (append-only JSONL — reuse `file-queue.js` pattern, no new store).
5. Paid path writes report as Memory + emits ConvergenceRecord; free path stays ephemeral.
6. Patreon Discord bot wired for role sync (config, not code).

**Out of scope for Phase 0:** RSO login, lantern-os.net history page, auto-LFG, anything needing a production key.

**Definition of done (Phase 0):** `/scout` returns a real report for a verified account in a private Discord; paid branch unlocks for a test Patreon role; free counter caps at N/day with the CTA. Verify through the real Discord UI, not curl — per [feedback: user-path verification only].

---

## 7. Open questions for Alex
1. **Approve the two-phase Riot plan?** (Phase 0 private now; production-key submission before public launch.)
2. **Free daily cap N** — start at 3?
3. **Which Patreon tier** unlocks paid scouting — Member ($5) or Supporter ($20)?
4. **OK to draft the ADR** (Status: Proposed) so this is on the record before any code?

---

## 8. Risks
- **Riot ToS / production-key rejection** — mitigated by building Phase 0 as the required prototype; no public use on a personal key.
- **Rate limits** — personal key is tight; design the free cap around it, don't promise unlimited until production key lands.
- **Sprawl drift** — if the Discord bot starts holding its own state or "agents," it violates Σ₀. Keep it a thin Tool over the local Core. Re-check at review.
- **Local-first tension** — Discord is cloud edge by nature; keep the Core authoritative and local.
