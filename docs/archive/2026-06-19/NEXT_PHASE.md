# 🎮 NEXT PHASE: Three-Doors Kingdome

**Status:** Ready for Execution  
**Target Launch:** 2026-06-20 (9 days)  
**Delivery Model:** Convergence Loop (Phase 0 → 4 Sprints → Integration → Deploy → Feedback)

---

## 🎯 Vision

**Kingdome of Hearts** is an infinitely replayable narrative game where players journey through 7 canonical stages. Same game structure, but doors personalize based on:

- **Player Archetype** — seeker/healer/explorer (dimensional observer lens)
- **Agent Persona** — Lantern, Blinkbug, Keystone, Waterfall, Xenon, Founder
- **Consolidated Symbols** — player's own patterns reflected back
- **Live Observations** — current loop's choices

**Core Innovation:** CSF file (StatusCube) IS the game. Every choice recorded as delta records, consolidated into symbols at loop boundaries, used to generate new doors on replay.

---

## 🏗️ Architecture

| Component | Location | Role |
|-----------|----------|------|
| **Data Layer** | `src/csf/v07/` | CsfArchive API — single source of truth |
| **Game Engine** | `src/three_doors_engine.py` | Reads/writes CSF instead of JSON |
| **API** | `apps/lantern-garage/routes/dream.js` | `/api/dream/doors` endpoint |
| **Client** | `apps/lantern-garage/public/three-doors-game.html` | Stage-aware UI |
| **Agents** | `data/contexts/personas.json` | 6 personas, each filters doors differently |

---

## 🎭 7-Stage Journey

```
0. garden-at-beginning      — King's opening poem
1. present-day              — Cloverfield, lucky doors, today alive
2. future-doors             — Branches of possibility, tomorrow
3. xp-door                  — Windows XP liminal glitch/nostalgia
4. xenon-starship           — Convergence, all timelines visible
5. sigil-city-of-doors      — Synthesis hub, King returns, fractal architecture
6. fog-door-return          — Escape hatch, loops back to stage 0
```

Each loop: observations consolidate into symbols → new doors appear on next playthrough

---

## 📋 Execution Plan: Convergence Loop Phases

### Phase 0: Intake (0.5 days) — **START HERE**

**Goal:** Archive old data, verify CSF v07, establish baseline

- [ ] Archive old data structures to `D:\tmp/lantern-os-archive-{date}/`
  - `src/csf/v06/`
  - `data/discord/three-doors/*.json`
  - Old memory formats
- [ ] Create archive manifest with recovery instructions
- [ ] Verify Google Drive backup complete
- [ ] Review CSF v07 API + canonical lore
- [ ] Create git issue #309 tracking this phase

**Git Issue:** #309 Phase 0: Data Migration & Cleanup

---

### Sprint 1: CSF Backend (2 days)

**Goal:** Integrate CsfArchive, consolidation, loop tracking

- [ ] Connect `three_doors_engine.py` to CSF v07
- [ ] Implement delta recording (player choices → CSF deltas)
- [ ] Implement consolidation (boundary symbols)
- [ ] Test file size constraint (<10KB after 100 loops)

**Git Issue:** #305 Phase 1: CSF Backend

---

### Sprint 2: Stage Routing (1.5 days)

**Goal:** Implement 7-stage path, UI breadcrumbs, loop increment

- [ ] Implement stage router (0→1→2→3→4→5→6→0)
- [ ] Add loop counter (how many times through the 7 stages)
- [ ] Create stage-aware UI with breadcrumbs
- [ ] Verify stage-to-stage persistence

**Git Issue:** #306 Phase 2: Stage Routing + Loop Tracking

---

### Sprint 3: Personalized Doors (2 days)

**Goal:** Archetype/agent/symbol filtering

- [ ] Implement archetype detection
- [ ] Implement agent persona filtering
- [ ] Implement consolidated symbol matching
- [ ] Generate context-specific doors for each combo

**Git Issue:** #307 Phase 3: Personalized Door Generation

---

### Sprint 4: Missing Scenes (2 days)

**Goal:** Stage 2, 3, 5 narration + contextualized images

- [ ] Write narration for future-doors (stage 2)
- [ ] Write narration for xp-door (stage 3)
- [ ] Write narration for sigil-city (stage 5)
- [ ] Generate/source contextualized images for each stage
- [ ] Integrate images into door templates

**Git Issue:** #308 Phase 4: Missing Scenes + Contextualized Images

---

### Integration Phase (1-2 days)

**Goal:** Full 2-3 loop playthroughs as different archetypes

- [ ] Full 2-3 loop playthroughs (seeker, healer, explorer)
- [ ] Multi-agent testing (Lantern, Xenon, Waterfall voices distinct)
- [ ] Offline mode verification
- [ ] CSF consolidation + file size <10KB constraint
- [ ] Performance benchmarks

---

### Deployment (1 day)

- [ ] Merge to master
- [ ] Deploy to Railway
- [ ] Smoke test
- [ ] Monitor logs, verify metrics

---

## 📊 Success Metrics

- ✓ Player can enter, navigate 7 stages, loop infinitely
- ✓ Doors personalize based on archetype + agent + symbols
- ✓ Each replay shows different doors (player-pattern-driven, not random)
- ✓ Game playable offline
- ✓ CSF file stays <10KB after 100 loops
- ✓ All 7 stages have distinct narration + contextualized images
- ✓ Deployed to production + monitored

---

## 🔄 Why This Matters

Three-Doors is the interactive layer of Convergence IO — the symbolic navigation system. It tests:

- **CSF persistence** — player state stays compact
- **Consolidation in practice** — observations → symbols works
- **Personalization from patterns** — emerges from player's own history, not algorithms
- **Infinite replayability** — finite memory footprint, endless variation

Success here de-risks the full **Comet Leap v0.2-infinite-cube** product roadmap.

---

## 🎯 Next Immediate Action

**START WITH PHASE 0 (Intake):**

```bash
# 1. Archive old data structures
mkdir -p D:\tmp/lantern-os-archive-$(date +%Y-%m-%d)
cp -r src/csf/v06 D:\tmp/lantern-os-archive-$(date +%Y-%m-%d)/
cp -r data/discord/three-doors D:\tmp/lantern-os-archive-$(date +%Y-%m-%d)/

# 2. Create recovery manifest
cat > D:\tmp/lantern-os-archive-$(date +%Y-%m-%d)/README.md <<EOF
# Lantern OS Archive

Archived: three-doors old game data (JSON format)
Date: $(date)
Reason: Migrating to CSF v07 (StatusCube format)

To restore: cp -r * $LANTERN_ROOT/
EOF

# 3. Create git issue #309
gh issue create \
  --title "Phase 0: Data Migration & Cleanup (Three-Doors Kingdome)" \
  --body "Archive old CSF v06 and three-doors JSON to backup. Verify Google Drive backup complete."

# 4. Continue with Sprint 1
```

---

## 📅 Timeline

```
Week 1 (Jun 11-20):
  Jun 11: Keystone complete + sync master
  Jun 12: Phase 0 Intake (0.5 day)
  Jun 13-14: Sprint 1 CSF Backend (2 days)
  Jun 15: Sprint 2 Stage Routing (1.5 days)
  Jun 16-17: Sprint 3 Personalized Doors (2 days)
  Jun 18-19: Sprint 4 Missing Scenes (2 days)
  Jun 20: Integration + Deployment (2 days)

Target Launch: 2026-06-20
```

---

## 🚀 Ready to Begin

Keystone (LLM Agent integration) is complete and on master.

Three-Doors Kingdome (interactive narrative game) is the next layer.

Both together form the foundation of **Human Flourishing Frameworks** — the dashboard where Convergence IO visualizes player patterns and agent performance.

**Let's build it.** 🎮✨
