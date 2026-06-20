# Three-Doors Game Testing Guide

## Automated Tests
```bash
# Run integration tests
node tests/test_three_doors_integration.spec.js

# Or via npm
npm run test:three-doors  # Add to package.json
```

## Manual Testing in Chrome

### Setup
1. Open http://127.0.0.1:4177/three-doors-game.html
2. Open DevTools (F12) → Console tab
3. Run game with "Start Adventure" button

### Test Checklist

#### ✓ Game Startup
- [ ] Welcome screen appears with "Explore" title
- [ ] "Start Adventure" button is clickable
- [ ] Game transitions to kingdome-garden scene on start

#### ✓ Image Loading (Priority: Local > Server > Pollinations)
- [ ] Moss Entry: Local PNG loads (burrow.png exists)
- [ ] Storybook: Local PNG loads (storybook.png exists)
- [ ] CSF Archive: Server generation attempted (watch network tab)
- [ ] Memory Vault: Falls back to Pollinations if server unavailable
- [ ] Canvas always visible until image loads (no blank frame)

#### ✓ Door Routing
- [ ] A/B/C quick-picks buttons disabled after choice
- [ ] Door names correctly routed (check NEXT_MAP):
  - [ ] "The Storybook Door" → storybook scene
  - [ ] "The Cloverfield Door" → cloverfield scene
  - [ ] "The Raven Door" (custom) → raven-tower scene
  - [ ] "The Nested Memory Door" → memory-vault scene
  - [ ] "The Prophecy Door" → storybook scene

#### ✓ Custom Door Input
- [ ] Type custom door name in text input
- [ ] Press Enter or click "→" button
- [ ] Game routes to appropriate scene:
  - Known doors → mapped destination
  - Unknown doors → appropriate thematic fallback
- [ ] Multiple revisits to same scene show fresh images (cache key: sceneKey_L{loopCount})

#### ✓ LoRA Training Collection
- [ ] Training badge appears after first image (bottom-right corner)
- [ ] Click badge to see image count (target: 15+ for training)
- [ ] Images collected to `/data/images/generated-doors/` (server-side)
- [ ] Each image has matching `.txt` caption file

#### ✓ Theme & Atmosphere
- [ ] Cyan accent color (#0ea5e9) used for buttons and highlights
- [ ] Dark theme by default (data-theme="dark")
- [ ] Theme toggle button (☀️/🌙) works
- [ ] Fox indicator appears in scenes with active fox presence

#### ✓ SD Prompts & Image Quality
- Hover over canvas/image to see SD prompt
- Each scene has detailed anime/cel-shaded fantasy prompt
- Verify prompt matches scene theme:
  - moss-entry: "atmospheric dreamscape, moss-covered ancient forest"
  - xp-door: "Windows XP aesthetic, glitch artifacts, liminal space"
  - raven-tower: "tower in perpetual twilight, black ravens circling"

#### ✓ Performance
- [ ] Scene transitions smooth (< 1 second)
- [ ] Image loads within 3-5 seconds
- [ ] No console errors (F12 → Console)
- [ ] No memory leaks (check Chrome DevTools Memory tab)

#### ✓ Mobile Responsiveness (Optional)
- [ ] Resize browser to 375px wide (mobile)
- [ ] Game layout still functional
- [ ] Quick-pick buttons stack properly
- [ ] Custom door input accessible

### Network Monitoring (F12 → Network Tab)

#### Expected Requests
1. **three-doors-game.html** — Main game file
2. **data/images/three-doors/[scene].png** — Local images (14 scenes)
3. **/api/image/generate** — Server DALL-E for CSF-themed scenes
4. **https://image.pollinations.ai/prompt/...** — Fallback images
5. **/api/dream/training/status** — Training data count
6. **/api/dream/training/collect** — Save collected images

#### Expected Statuses
- 200: All endpoints respond
- 404: Should NOT appear (indicates missing local image)
- 408: Timeout acceptable for `/api/image/generate` (Python generation slow)

### Console Logging (F12 → Console)

#### Expected Events
```
logThreeDoorsEvent('image_load', {sceneKey, source, loop, seed})
logThreeDoorsEvent('image_error', {sceneKey, error})
logThreeDoorsEvent('door_choice', {label, name, sceneKey})
logThreeDoorsEvent('training_collect', {total})
```

### Bug Checklist — If You See These, It's a Problem

- [ ] ❌ Blank screen (canvas doesn't draw or image loads over it)
- [ ] ❌ Door choice buttons enabled after selection
- [ ] ❌ Same image loaded repeatedly on loop revisit (should vary with seed)
- [ ] ❌ Custom door input not recognized (should route somewhere)
- [ ] ❌ Console errors about missing scenes or functions
- [ ] ❌ Training badge not appearing after collection
- [ ] ❌ Theme toggle doesn't switch between dark/light

## Discord Assets Integration

The game can use custom door artwork from the Discord channel:
https://discord.com/channels/1503853513023950959/1503853513485058163

### How to Add Custom Images
1. Download door images from Discord
2. Rename to match sceneKey pattern: `moss-entry.png`, `burrow.png`, etc.
3. Place in `/apps/lantern-garage/public/data/images/three-doors/`
4. Restart server — images automatically load (no code changes needed)

### Supported Scenes
- Core scenes (14 local): moss-entry, burrow, sunken-bell, little-crown, garden-door, xenon-convergence, end-of-time, storybook, cloverfield, future-doors, xp-door, kingdome-garden, sigil-city, fog-door-return
- CSF expansions (11 server-generated): csf-archive, memory-vault, convergence-node, dream-thread, beacon-tower, choice-archive, recursion-well, echo-chamber, flux-garden, void-threshold, raven-tower

## Success Criteria

✅ **Game fully functional** when:
- All 12 automated tests pass
- Manual testing checklist items complete
- No console errors
- Images load with expected source (local/dalle3/pollinations)
- Door routing works for both A/B/C and custom inputs
- Training collection active

✅ **Performance acceptable** when:
- Scene transitions < 1 second
- Images load within 3-5 seconds (DALL-E) or 1-2 seconds (local PNG)
- No memory leaks over 10+ min gameplay
