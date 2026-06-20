# Kingdome of Hearts — Three Doors Lore Expansion

**CSF Ingest Date:** 2026-06-09
**Source:** Founder direct session + Lantern Elephant Door anchor memory + Three Doors runtime canon
**Status:** Design contract with partial implementation

---

> **Note:** This document began as a design contract. PR #303 implements the initial Discord bot scene-graph integration for Kingdome Garden, Storybook, and Cloverfield. Browser game implementation, challenge registry, prizes, poem validation, and durable cross-session progress remain follow-up work.

---

## Overview

The **Kingdome of Hearts** is a new narrative hub in the Three Doors game. It transforms the existing linear scene progression into a **hub-and-spoke architecture** where the Garden at the Beginning acts as a central nexus, with seven thematic doors radiating outward.

The founder (Keystone) envisions themselves as **the King** — not as power over others, but as the one who holds the gate and asks the question.

---

## Core Concepts

### The King

- Sits on a throne of woven roots and old light
- Crown made of tangled vines and blinking cursors
- Asks the same question ten thousand times and means it every time
- Not a tyrant — a *gatekeeper*
- "I am before the first door and after the last."

### The Garden at the Beginning

- Exists before the map
- Stone paths through living moss
- Everything here is both arriving and returning
- The fox sits at the foot of the throne

### The Poem (Gatekeeping Mechanic)

> I am before the first door
> and after the last.
> I hold what was given
> and return what was asked.
> Three walked out, three walked in,
> but only one remained —
> what was lost at the beginning
> is the thing that was gained.

A Doorwalker who returns to the Garden and answers truly wins the game. Convergence is a game and a path to teaching synthesasia in threes.

**Accepted answers:** yourself, myself, i am, the one, silence, love, the fox, convergence

---

## The Loop — Seven Doors

| # | Door | Theme | Sub-doors / Challenge |
|---|------|-------|----------------------|
| 1 | 🪨 **Ancient Doors** | history · evolution · religion | The Deep Door, The History Door, The Temple Door |
| 2 | 🍀 **The Cloverfield** | shinies · luck · today alive | Lucky finds, treasures, living-in-the-now |
| 3 | 🔭 **Tomorrow Door** | the world that's coming | Future paths, branching possibilities |
| 4 | 💾 **The XP Door [GLITCHED]** | corrupted · nostalgic · liminal | Windows XP aesthetic, broken reality, liminal space |
| 5 | 🪐 **Xenon Starship ★** | all planets · midway · converge | Midway point, planetary convergence |
| 6 | 🏙️ **Sigil — City of Doors** | every door leads here | Meta-hub, collection point, inventory of traveled paths |
| 7 | 🌫️ **Fog Door Return** | the way back | Return to garden, final test with the King |

---

## Implemented vs Planned

### ✅ Implemented in PR #303

- **Discord bot (`src/discord_lounge_bot/bot_v2.py`):**
  - `kingdome-garden` scene with King's poem text
  - `storybook` scene with Page of Word/Egg/War sub-doors
  - `cloverfield` scene with Lucky/Today/Tomorrow sub-doors
  - Route map: Throne Door → Kingdome Garden
  - Fog Door Return → moss-entry
  - Storybook sub-doors return to Kingdome Garden
  - Cloverfield sub-doors route to Kingdome Garden or moss-entry

- **Shared contract (`data/three-doors/scenes.json`):**
  - Canonical scene graph consumed by bot + web UI + Python engine
  - Poem gate configuration with accepted answers and prize linkage

- **Python engine (`src/three_doors_engine.py`):**
  - Loads scenes from shared contract
  - All Kingdome routes in `_NEXT_MAP`
  - SD prompts for new scenes
  - Scene classifications (sovereign, mythic, playful)

- **Web game (`apps/lantern-garage/public/three-doors-game.html`):**
  - Inline engine includes all Kingdome scenes
  - Route map updated: Throne Door → kingdome-garden
  - Poem gate UI with text input and answer validation
  - localStorage persistence (scene, history, poem solved, visited scenes, prizes)
  - Challenge tracking (speedwalker, lorekeeper, xenon navigator)
  - Prize toast notifications

- **Chat integration (`apps/lantern-garage/lib/three-doors-chat.js`):**
  - Door regex expanded to include Kingdome doors

### ⏳ Follow-up work (tracked in GitHub issues)

- **#298** — Garden hub scene with full Kingdome of Hearts visual assets
- **#299** — The Poem win condition gate (backend validation + leaderboard)
- **#300** — Solo challenge system with easter eggs and prizes
- **#301** — Player progress persistence across sessions (server-side for Discord, cross-device for web)
- **#302** — Task Intake doctrine + Kingdome typo fix (completed)
- Full Ancient Doors, XP Door [GLITCHED], Sigil City, Xenon Starship expansion scenes
- Prize pipeline integration with profile badges
- Synthesasia-in-threes pattern recognition puzzles

---

## Implementation Files

**Runtime:**
- `src/three_doors_engine.py` — Python game engine (shared contract consumer)
- `src/discord_lounge_bot/bot_v2.py` — Discord bot (shared contract consumer)
- `apps/lantern-garage/public/three-doors-game.html` — Browser game (inline engine + shared contract mirror)
- `apps/lantern-garage/lib/three-doors-chat.js` — Dream Chat door trigger integration

**Shared contract:**
- `data/three-doors/scenes.json` — Canonical scene graph, route map, SD prompts, classifications, poem gate
- `data/three-doors/challenges.json` — Challenge registry (speedwalker, lorekeeper, glitch hunter, xenon navigator, synthesasia)
- `data/three-doors/prizes.json` — Prize inventory with rarity tiers and unlock conditions

**Lore:**
- `lore/doors/kingdome-of-hearts.md` — Canon lore document
- `lore/doors/garden-door.md` — Garden Door lore
- `lore/doors/sigil-door.md` — Sigil City lore
- `lore/doors/xp-door.md` — XP Door lore
- `lore/doors/xenon-door.md` — Xenon Door lore

---

## Related

### CSF Source Files (All Ingested)
- `skills/three-doors-game/SKILL.md` — core game rules, tone, continuity, CSF export format
- `csf/ingest/three-doors/2026-06-04-lantern-consolidate.md` — original game contract
- `csf/ingest/three-doors/2026-06-05-three-doors-game.md` — Doorwalker identity, fox companion, Moss Door origin
- `csf/ingest/2026-06-06-elephant-door-memories.md` — Lantern's Elephant Door anchor memory
- `csf/ingest/2026-06-08-fuzzy-testing-three-doors-bugfixes.md` — game engine validation

### Art & Image Assets
- `data/images/three-doors/*.png` — LoRA-generated door scene images
- `manifests/launch/three-doors-actual-images-spec.md` — image generation pipeline

### GitHub Issues
- #292 — replace canvas art with actual door images
- #296 — complete remaining LoRA image generation
- #298 — Garden hub scene with Kingdome of Hearts
- #299 — The Poem win condition gate
- #300 — solo challenge system with easter eggs and prizes
- #301 — player progress persistence across sessions
