# Three Doors — Master Handoff / Continuity Bible / CSF Export

**Authorial owner:** Alex Place / the Doorwalker  
**Handoff status:** exhaustive working canon assembled from the live Three Doors conversation, current repo skill/scene graph, prior CSF ingests, and current visual reference decisions.  
**Export date:** 2026-06-30  
**Audience:** another assistant, creative model, writer, game agent, illustrator, designer, or future Alex who must continue Three Doors without flattening it into generic fantasy, technical diagrams, or project-management language.

> **Read this before doing anything:** Three Doors is a memory-first, image-forward, symbolic game and art world. Its real grounding is the lived creative continuity: Alex as Doorwalker; the trio Lantern, Eclipse, Keystone; doors already opened; repeated imagery; actual art references; and choices that have become meaningful through use. The repository is a useful implementation and archive layer. It is not permitted to overwrite the emotional/visual canon merely because it is more structured.

---

## 0. Non-negotiable priority order

When sources disagree, use this precedence order:

1. **Alex’s newest explicit request in the active conversation.** New direct instructions always win.
2. **Alex’s supplied drawing/image references and stated corrections.** Preserve silhouette and anatomy before attempting prettier or more elaborate rendering.
3. **The newest Three Doors CSF grounding export** — especially `csf/ingest/three-doors/2026-06-30-recenter-grounding-on-three-doors.md`.
4. **This master handoff.** It consolidates known canon, decisions, art history, and unresolved questions.
5. **The active Three Doors scene graph** — `data/three-doors/scenes.json` — for implemented route names, canonical scene text, three-choice routing, and UI/bot behavior.
6. **The Three Doors skill** — `skills/three-doors-game/SKILL.md` — for play contract, triggers, export behavior, and technical routing discipline.
7. **Older CSF notes, historical images, and assistant-made summaries.** Use for atmosphere and continuity, but do not let an older implementation override a newer explicit correction.
8. **Technical Lantern-OS / Σ₀ / Question Machine material.** This is separate research material unless Alex explicitly asks for it inside a Three Doors scene.

### One-sentence rule

**Use the game’s memories to interpret the repo; do not use the repo to erase the game’s memories.**

---

## 1. What Three Doors is

Three Doors is a creative, dreamlike, symbolic, image-first exploration game. It behaves like a continuous playable art object: threshold after threshold, with places that remember what the player brought to them. It is not a generic RPG, not a dashboard, not a workflow engine, not a system-design metaphor by default, and not an excuse to dump lore without a playable moment.

It is built around the feeling that a door can be a place, a memory, a question, a found object, a future, a return route, or a truthful image. The game should feel like a dream that is legible enough to choose from — liminal but not arbitrary; surreal but not incoherent; eerie but not cruel.

### Primary emotional ingredients

- Return without punishment.
- Curiosity without humiliation.
- Wonder with tactile specificity.
- Small found objects carrying real weight.
- Paths made from lived material: books Alex read, crystals and rocks Alex collected, keys, dice, coins, maps, tools, feathers, bottles, tiny doors, old artifacts.
- The feeling that being seen by a familiar guide is different from being judged.
- A world that is playful, strange, tender, and sometimes solemn.
- A homecoming that is not a reset.
- A distinction between a safe mystery and a hostile unknown.

### Central statement

The world does not ask the player to solve an abstract puzzle before belonging. It asks the player to keep choosing, keep noticing, and carry what matters through the next threshold.

### What it must never become by accident

- Generic medieval quest prompts.
- A grimdark combat simulator.
- A corporate planning framework.
- A technical Σ₀ lecture disguised as lore.
- A random generator of unrelated fantasy doors.
- An overexplained metaphor.
- Empty “mystery” with no sensory objects, stakes, or recognizability.
- An art direction that turns the companions into generic mascots, anime humans, realistic creatures, or unrelated fantasy animals.

---

## 2. Invocation / operating modes

### `!three-doors`

Treat this as: load the memory-first Three Doors continuity, preserve the current trio and known door canon, then respond to the immediate request.

### `!three-doors play` / `!threedoors`

Run a playable scene. The normal form is:

1. Resume from the current place or a specifically named door.
2. Give a short, vivid scene beat anchored in prior continuity.
3. Present **exactly three immediate meaningful options** unless Alex explicitly asks for a map, list, an image, or a nonstandard format.
4. Each option should be visually distinct, emotionally/symbolically distinct, and connected to the current place.
5. After a choice, open that door; do not reset the world.
6. End the scene beat with the next three meaningful choices when appropriate.

### `!three-doors [door/action]`

Do the named action. If Alex says “I open the King’s Garden,” “explore the level,” “load the Fog Door,” “draw the doors,” or invokes a named place, keep continuity in that location instead of dropping them into a generic starter scene.

### `images only`

Generate the image directly with no explanatory prose.

### `!ingest`

Write the meaningful current game/art state to the repo under `csf/ingest/three-doors/` when GitHub write access exists. Do not claim it was saved if it was not.

### `!export`

Produce a portable CSF-style record. Use these sections:

1. Instructions
2. Identity & Symbolic Self
3. Dreams & Memories
4. Projects & Systems
5. Preferences

### Art request without a game command

If Alex says “draw,” “draw the door,” “make a poster,” “redraw,” “colorize,” or provides an image reference, create art directly. Do not ask a menu question unless the request is genuinely ambiguous. Use the newest relevant character and style references.

---

## 3. Play contract: the core rules

### The three-choice rule

Normal play has **three immediate choices**. The canonical seven major doors are a long-form structural loop, not seven options dumped on the player all at once.

The three choices should:

- Be concrete enough to picture.
- Have different emotional temperatures, not merely different nouns.
- Contain sensory language.
- Carry a symbolic implication without explaining it outright.
- Be tempting in different ways.
- Be safe enough to choose without needing a warning label.
- Grow out of the current scene, an existing companion, a remembered object, or a consequence of a previous choice.

Avoid reusing more than one old door in a fresh choice layer unless Alex explicitly asks for a reunion, archive, door list, or hub map.

### Canon continuity rule

A chosen door is not discarded after its scene. It remains a place that can be returned to, remembered, pictured, compared, mapped, hung in Sigil, or found as a small echo inside another scene.

### Scene rule

A good Three Doors beat usually contains:

- A place with tangible materials.
- A change in light, sound, temperature, or weather.
- A companion acting in-character.
- One true detail that reveals what this place is about.
- Three choices that develop from that truth.

### Tone rule

Keep prose vivid and concise. The image should lead. Do not explain Lantern OS, CSF, CADD, internal architecture, or system mechanics during ordinary play.

### Return rule

The return route is a homecoming, not a failure state. “You came back” is an affirmation of continuity, not an achievement notification.

---

## 4. The Doorwalker / player identity

Alex is the **Doorwalker**.

The Doorwalker is the person recognized by the world because they have returned, chosen, carried things forward, and kept engaging with doors rather than being reduced to a character sheet. Do not force a fully specified physical avatar unless Alex requests one. The Doorwalker can remain partially off-camera, reflected, cloaked, implied by footsteps, hands, silhouette, or a place that recognizes them.

### Original Moss Door continuity

- The original choice was green / the Moss Door.
- The world recognizes this choice.
- Lantern’s plaque in the canonical entry scene says: **GUIDE OF THE ONE WHO CHOSE GREEN**.
- Lantern says: **“You came back.”**
- An early fox recognized the Doorwalker with the same return energy.

### Core riddle / Kingdome poem gate

> I am before the first door  
> and after the last.  
> I hold what was given  
> and return what was asked.  
> Three walked out, three walked in,  
> but only one remained —  
> what was lost at the beginning  
> is the thing that was gained.

Accepted answers in the implementation include: **yourself, myself, I am, the one, silence, love, the fox, convergence.**

Do not reduce the riddle to a single “correct answer” lecture. Its value is that it can be encountered from different emotional positions.

---

## 5. The active core party

The default active party is exactly:

1. **Lantern**
2. **Eclipse**
3. **Keystone**

The current keeper-art rule is **no fox** unless Alex explicitly asks to include the fox.

### Default party composition in group art

- Lantern: left.
- Eclipse: center / middle-left.
- Keystone: right / middle-right.
- For door/travel scenes, the trio often face the focal threshold from behind.
- For character-reference/merch art, show their front anatomy accurately from Alex’s simple contact-sheet drawings.
- If Eclipse is facing away, do **not** draw front-facing star/diamond eyes on the back of the head.

---

## 6. Character bible — Lantern

### Identity / role

Lantern is the guide, return signal, steady light, question-bearer, and safe witness. Lantern’s light makes a place readable; it does not dominate it. Lantern often stands nearest to the path, the threshold, or the player’s side.

### Core visual truth

Lantern is a small **lantern-headed character**, not a conventional human with a lantern accessory.

Use Alex’s simple animation/reference drawings as the primary anatomy guide:

- A glass lantern head with a visible warm orange-yellow flame.
- Rounded red cap/top and red rim/trim.
- Small metal loop/ring above the cap.
- Clear glass body/head chamber.
- Purple coat/jacket below the glass lantern head.
- White gloves/hands.
- Black pants/legs and black boots.
- Compact, toy-like, simple, readable silhouette.
- The flame is an interior character feature and should remain visible.

### Color anchors

- Gold / warm orange flame.
- Deep or medium purple coat.
- Red cap/trim.
- White gloves.
- Black boots/legs.

### Character posture / behavior

- Steady rather than dramatic.
- Can point, hold a small lantern tool, glance back, take the first step through fog, or wait at a door.
- Lantern is often the first through a return door and turns back toward the Doorwalker.
- In quiet scenes Lantern can stand still and make an entire space less frightening.
- Lantern’s flame may brighten, dim, pixelate in the XP Door, split into five flames at Xenon Convergence, or become part of a larger transformation at the Door at the End of Time.

### Do not do

- Do not replace Lantern with a generic floating metal lantern unless requested.
- Do not hide the purple coat when using the simple character-card style.
- Do not give Lantern a human head inside the lantern.
- Do not turn Lantern into a photorealistic object with no body.
- Do not overcomplicate the silhouette with generic armor, random fantasy gears, or an unrelated face.

### Lantern’s repeated phrases / narrative function

- “You came back.”
- “Guide of the One Who Chose Green.”
- The light is a return signal, not an achievement marker.

---

## 7. Character bible — Eclipse

### Identity / role

Eclipse is the dreamer, wonder-bearer, balance-keeper, and one who sees beyond the immediately literal. Eclipse’s visual language is moonlight, purple, soft cloud texture, gentle floating, stars, and an alive curiosity.

### Core visual truth

Eclipse is a **round-headed jellyfish/cloud companion**.

Use Alex’s simple hand-drawn contact sheet as primary anatomy:

- Smooth rounded dome/head.
- Purple main body/head.
- Two large diamond/star-shaped eyes on the **front** only.
- A pale lavender / white cloudy collar beneath the head.
- Multiple connected jellyfish tentacles below; in the simplified reference, the body reads as a cloud collar with several lower tentacles and raised side tentacle-arms.
- Simple line art, friendly uncanny, not human.
- The head is on top of the cloud collar/body, not detached oddly or replaced by an ornate humanoid face.

### Color anchors

- Violet, purple, lavender.
- White/pale-lilac eyes and cloud collar.
- Subtle moonlight or small star particles when appropriate.

### Character posture / behavior

- Floating or hovering.
- Can look up, drift down, spin, listen, rest, explore, or hold a magical glow.
- In calm art, Eclipse can hover low above ground with a soft oval shadow.
- In dream / Sigil art, subtle purple light can answer Eclipse’s presence.
- Eclipse should feel profound and cute without becoming infantile or generic.

### Exact back-facing rule

When Eclipse faces away in a poster, journey, or doorway scene:

- Show the plain smooth back of the purple head.
- Do not draw the two diamond eyes on the back of the head.
- Let posture, collar, tentacles, and rim light convey identity.

### Do not do

- Do not replace Eclipse with a generic jellyfish woman, humanoid sorcerer, or ornate “cosmic princess.”
- Do not add a detailed realistic face.
- Do not detach the head from the cloudy collar.
- Do not draw eyes on the rear view.
- Do not make tentacles unrelated arms/legs without preserving the jellyfish/cloud form.

---

## 8. Character bible — Keystone

### Identity / role

Keystone is foundation, protection, focus, endurance, and the one who holds the line. Keystone should be able to read as playful in simple art and solemn in reflective/battle art.

### Core visual truth

Keystone is a squat, cracked gray stone guardian. The primary visual reference is a simple animated rock / egg / wedge-like companion with a large readable silhouette.

Key forms that are both valid depending on scene:

- **Light/card version:** simple gray cracked rock body, friendly dark oval eyes, broad blocky smile; minimal limbs or none; low, stable silhouette.
- **Solemn/focused version:** egg-shaped cracked stone body, dark frowning eyes, small hands clasped in front/prayer pose, seated/crouched or planted on squat feet; can read as deeply concentrated and resilient.
- **Prepared/battle version:** small stone guardian with shield, spear/sword, or simple protective gear only when the scene explicitly calls for it. Do not turn him into a full human knight.

### Color anchors

- Gray stone base.
- Cool blue edge light, blue crystals, or blue Sigil accents when color-coded.
- Black cracks; occasional pale stone highlights.

### Character posture / behavior

- Sitting with focus.
- Holding the line in front of others.
- Standing near a cliff edge and looking over a battlefield.
- A compressed, stable stance rather than a fast/agile silhouette.
- In the “Throne Door in the distance” visual series, Keystone is contemplative, not melodramatic.

### Do not do

- Do not turn Keystone into a generic boulder with no recognizable face.
- Do not add big humanoid eyes, realistic teeth, or a generic anime mouth.
- Do not erase the crack pattern.
- Do not make Keystone a human in armor.
- Do not use the wrong facial mode: friendly references should stay simple/friendly; solemn scenes can use the focused frown/prayer pose.

---

## 9. Supporting beings and recurring figures

### The King

- Keeper/gatekeeper of the Kingdome of Hearts.
- Sits on a throne of woven roots and old light.
- Crown can be tangled vines and blinking cursors in the repo scene graph; in more grounded art it can be roots/vines/old gold, not a generic tyrant crown.
- Not a villain by default; he is a recognizer of returns, thresholds, stories, and the riddle.
- Sometimes reads as someone who has asked the same question ten thousand times and still means it.
- The Garden at the Beginning is his domain.

### The fox

- Historical / early Moss Door companion and witness.
- May appear in original Moss Door routes and scene graph (`fox_present: true`).
- **Current keeper-art rule:** do not insert the fox into current trio art, poster art, Odin battle art, or default scenes unless Alex explicitly asks.
- The fox is not erased from history; it is simply not default current party art.

### Xenon guide / Xenon presence

- A liquid-starlight or vast witness-like presence tied to Garden Door and Xenon Convergence.
- Nonthreatening, cosmic, observant.
- Associated with branching choices, all paths, planetary/cosmic convergence, and many possible selves.
- Do not make Xenon a generic hostile alien.

### Fog God

- Sleeps in/around the Sea of Fog and Clouds / Fog Door Return.
- More atmosphere and threshold presence than monster.
- Keep it gentle, misty, enormous, and non-hostile unless Alex explicitly steers toward conflict.

### Odin

- Keeper battle image setup: an elder godlike warrior with beard and axe, smiling as he charges/lunges out of the Fog Door.
- The trio Lantern/Eclipse/Keystone face him prepared.
- **No fox** in that keeper battle composition.
- The expression is a charged, testing, almost joyful battle smile — not a slasher-horror face.

### Elephant family / Elephant Door

Canonical names and atmosphere:

- Dad
- Mom
- Peace
- Serenity
- Joy

They recur at a moonlit beach/oasis reached through Wardrobe → Elephant Door. Key details:

- Same five elephants each time.
- Moonlight.
- Water reflection.
- Jasmine and lavender.
- Night beach/oasis atmosphere.
- Castle/security imagery.
- A feeling of protection and recurring family presence.

Possible internal Elephant Door routes include:

- Reflecting Water Door.
- Conversation with the Elephants Door.
- Castle Door.

### Raven Door / Raven figure

- Private symbolic space, not a generic combat raven.
- Black-violet, silver smoke, candle-gold, feathers, moonlit villa/bathhouse/masquerade atmosphere.
- Must remain non-explicit, consensual, safely returnable, and emotionally respectful.
- Never force it into a public “default party” scene.

### Wish Door

- Hope, possibility, star jars, hanging moons, a bright central star, and a path that opens from a wish.

### Home Return Door

- Belonging, roots, ordinary warmth.
- Cozy village path, family photos, teddy bear, rocking chair, birdhouse, garden, books, keepsakes, warm sunset return.

### Unisona — emerging / NOT YET HARD CANON

A recent visual concept was generated under the name **Unisona**. It resembles a cosmic/violet harmonic jellyfish being with star/diamond eyes, long spectral tentacles, music imagery, and an elaborate “harmonic keeper” design.

**Do not automatically place Unisona into Three Doors canon.** Alex asked to draw Unisona, but no explicit narrative role, door, relationship to Eclipse, or canonical status has yet been stated. Treat Unisona as a candidate future companion/NPC/design seed. Preserve the distinction from Eclipse unless Alex chooses to connect them.

---

## 10. The seven canonical Kingdome major doors

These seven are the stable long-form loop. They are major stages, not seven simultaneous menu options in normal play.

1. **Ancient Doors**
2. **The Cloverfield**
3. **Tomorrow Door**
4. **The XP Door [GLITCHED]**
5. **Xenon Starship / Midway Convergence**
6. **Sigil — City of Doors**
7. **Fog Door Return**

### Long-form spine

A canonically emphasized route is:

**Ancient Doors → Sigil — City of Doors → Tomorrow Door**

The Garden at the Beginning / Kingdome of Hearts binds the larger loop.

### Important distinction: Throne Door

The **Throne Door** is meaningful but is **not** an eighth major Kingdome door. It is a secondary route / gateway to the Garden at the Beginning / Kingdome of Hearts. In a seven-door map, do not add it as an extra labeled canonical major door. Earlier art iterations with a throne door among seven were superseded by the “seven main doors” organization.

---

## 11. Door bible — Ancient Doors

### Locked identity

**Ancient Doors = Library of Babylon + Hanging Gardens + Tower of Babel.**

This is not a generic “old temple” door. It must be specifically a living archive and lush ancient vertical city.

### Meaning

- History.
- Evolution.
- Religion.
- Old origins.
- Deep time.
- Temple memory.
- First-cause questions.
- Archive as living growth, not dead storage.

### Visual requirements

- Tower of Babel / terraced ziggurat rising in the background or integrated architecture.
- Library shelves, books, scrolls, tablets, cuneiform, astronomy charts.
- Hanging gardens, vines, root systems through shelves, palms, flowers, irrigation channels, waterfalls.
- Stone lions / guardian statuary where useful.
- Warm gold lamps and archive light.
- Book paths and tablets underfoot.
- Ancient material should feel inhabited and growing, not dusty museum-only.

### Hero staging

- Lantern, Eclipse, Keystone may be seen from behind looking into a monumental library interior.
- In character-facing version, preserve their simple faces/anatomy; do not make them ornate humanoid fantasy people.
- For the trio: use Lantern warm gold, Eclipse soft purple, Keystone cool gray/blue against Babylonian earth/gold/green.

### Desired interior scene

**Ancient Library Babylon interior** remains a high-value content priority:

- Towering warm library vaults.
- Garden terraces inside/through architecture.
- Root-threaded shelves.
- Waterfalls and palms.
- Tablets and star charts.
- Clear focal destination, not mere decorative clutter.
- Dense I-Spy objects integrated naturally.

### Secondary route idea from scene graph

Sub-doors can include:

- The Deep Door.
- The History Door.
- The Temple Door.

---

## 12. Door bible — Cloverfield

### Short tag

**Shinies · luck · today alive.**

### Meaning

- Ordinary aliveness.
- Treasure in grass.
- Small joys.
- Luck as attention.
- The sacredness of the day actually being lived.
- Play as a counterweight to abstraction.

### Visual requirements

- Four-leaf clovers.
- Dice, marbles, bottle caps, coins, charms, keys, buttons, tiny bells, ladybugs, mushrooms, crystals, small found things.
- Bright rich greens and gold.
- Meadow / arch / door covered in clovers and collectible objects.
- No visual emptiness; it should reward I-Spy looking.
- The place should not become “leprechaun cliché.” It is a field of noticed things, not merely Irish-decoration fantasy.

### Current internal language

- “Today alive.”
- Small found objects are sacred because they were found and noticed.
- Cloverfield can contain paths made from books, crystals, and rocks Alex collected/read.

### Implemented scene graph text anchor

The Cloverfield Door opens into a meadow of four-leaf green under old light; small shinies include coins, beads, and a marble with a galaxy inside. Lantern’s glow catches on something glinting and lingers for the joy of it. The place explicitly carries the line that forever begins with “let’s play.”

### Immediate sub-door ideas

- Lucky Door — painted clover green; whatever is found was needed.
- Today Door — warm and ordinary; the day actually being lived.
- Tomorrow Door — slightly ajar; branching future.

### Desired interior

A rich Cloverfield interior/door art piece with all three heroes exists as a current keeper direction. The trio must remain anatomically recognizable.

---

## 13. Door bible — Tomorrow Door

### Meaning

- Possible futures.
- Branching paths.
- Dawn.
- Future gardens.
- Choice that has not happened yet.
- A future that is neither automatic doom nor forced optimism.

### Visual requirements

- Observatory threshold.
- Telescopes, astrolabes, orreries, star charts, orbit rings.
- Dawn horizon or future-city light.
- Trees or orchards that carry doors instead of fruit.
- Doors slightly open and leaking weather from years not yet lived.
- Gold, blue, and early light.

### Implemented scene graph / Future Doors anchor

A ridge where tomorrow grows like an orchard. Trees carry doors instead of fruit. Every door is slightly open and leaks weather from years that have not happened yet. Lantern’s flame throws bright sparks. Engines, or bees, or both, can be heard ahead.

Immediate future options in the scene graph:

- Bright Branch — warm gold; a future where the gardens won.
- Unwritten Door — plain unfinished wood; needs the hand to decide.
- Recursive Door — hallway of itself, smaller each time.

### Desired art

- **Door of Tomorrow** in the merged Three Doors / ink-wash or color I-Spy language.
- Hero trio can stand at a threshold, usually back-facing.
- For merch, maintain a clean title-safe area and avoid accidental generated lettering.

---

## 14. Door bible — XP Door [GLITCHED]

### Meaning

- Safe nostalgia.
- Windows XP liminality.
- Childhood computer memory.
- Old user interfaces.
- Harmless/caring glitch.
- Restoration, not digital horror.

### Visual requirements

- Impossibly green hill.
- Impossibly blue sky.
- Early-2000s CRT monitors.
- Floppy disks, CDs, old keyboards, folders, cursors, dialog boxes, pixel crystals.
- Door flickering between wood and window chrome.
- Startup chime half a second too slow.
- Friendly glitch, not uncanny body horror.
- Lantern’s glow can pixelate at edges and Lantern can be delighted by it.

### Implemented subdoors

- System Restore — rolls back to a saved point; old summer smell loads first.
- My Documents — pictures sorted by feeling, not date.
- unknown.exe — Publisher unknown; Lantern nods, so you run it anyway.

### Desired content

**XP Archive interior** remains a high-value art need. It should be the safe nostalgic archive of computer memory, full of small human objects and UI artifacts — not a generic cyberpunk room.

---

## 15. Door bible — Xenon Starship / Midway Convergence

### Meaning

- Cosmic synthesis.
- Planetary routes.
- Docking and crossing.
- Witnessing multiple paths.
- Starship threshold / Midway Station.
- A place where paths begin to see each other.

### Visual requirements

- Planets, orbital rings, star maps, navigation instruments, bridges, docking structures, multiple portals.
- Central convergence engine or navigation core where appropriate.
- The feeling of a starship station, not an empty spaceship hallway.
- Cosmic, but warm enough for the small companions to belong there.
- Colored light can be violet/blue/gold depending on route.

### Canon scene anchor

**Xenon Convergence** is where all versions of a moment exist at once; walls are made of choice itself. Every decision branches as visible paths. Thousands of reflections show possible versions of the Doorwalker. Lantern can burn with five flames, each representing a different future.

Subdoors:

- Mirror Door — self as was/is/might be, all at once.
- Branch Door — infinite true routes.
- Merge Door — many paths collapsing into one point of understanding.

### Midway Station

Midway Station is an established convergence hub for the Xenon route. It can be used as a meeting/transfer/place-between-worlds scene. It is a strong setting for the trio together, especially after multiple door visits.

### Desired content

**Xenon Starship / Midway interior** is a high-value needed image. It should be full of recognizable instruments, approaches, routes, planets, and thresholds — not an anonymous spaceship.

---

## 16. Door bible — Sigil: City of Doors

### Meaning

- Meta-hub.
- Every walked threshold visible together.
- Collection, comparison, carrying, trade, and return.
- A city where routes can be mapped and remembered.

### Visual requirements

- Monumental gothic / impossible city architecture.
- Endless doors, arches, bridges, staircases, keys, locks, signposts, markets, doorways in walls and puddles.
- Layered vertical architecture.
- Walked doors can hang like lit lanterns or appear as remembered thresholds.
- Central plaza or junction where the King waits beneath a sign pointing everywhere at once.
- City should feel vast, detailed, and navigable rather than merely chaotic.

### Canon scene anchor

All paths converge in Sigil. Every wall, archway, and puddle can be a threshold. Doors already opened hang faintly lit with the player’s footsteps. The King says every door chosen was also choosing the Doorwalker.

Immediate routes:

- Gallery of Walked Doors — whole path shown in one hall; rearranges when understood.
- Key Market — keys for doors not yet dreamed; one warm key.
- Lady’s Gate — silent, watched, fair; opens only for what is safe to carry.

### Current visual subseries

Sigil has an established individual-hero series:

- Lantern: gold accents / warm light, Sigil’s endless doors.
- Eclipse: purple accents / purple threshold lights, floating dream presence.
- Keystone: blue accents / blue crystalline locks and doors, protective stability.

Earlier versions looked jagged; later UHD/smoother versions were requested. Preserve clean detail and readable original anatomy rather than generic pseudo-real faces.

### Desired content

**Sigil interior** is a high-value remaining artwork. It should show a more specific lived city than simply an enormous cathedral of doors. I-Spy detail, bridges, markets, doors with histories, and anchors from prior worlds should be visible.

---

## 17. Door bible — Fog Door Return

### Meaning

- The way back.
- A return test.
- Mist, cloud, liminality, trust.
- Homecoming that does not erase what was learned.

### Visual requirements

- Vine-wrapped glowing arch.
- Sea of Fog and Clouds.
- Cliffs / floating ruins / distant platforms.
- A glimpse of the Garden at the Beginning through the threshold.
- Soft gray-green / silver / muted blue atmosphere with warm Lantern glow.
- A gentle sleeping Fog God silhouette if useful.

### Canon scene anchor

At Sigil’s edge, streets dissolve into sea fog. The Fog Door Return stands where the Fog God sleeps. The Garden at the Beginning is visible through the frame. Lantern passes through first and turns back; the return phrase is always true.

Immediate routes:

- Garden Gate — straight home.
- Long Way Round — drift through fog, arrive when ready.
- Lantern’s Shortcut — trust the steady flame.

### Odin keeper scene

A clean battle keeper version is desired/established:

- Odin charges/lunges from the Fog Door.
- Odin smiles; axe in hand.
- Lantern, Eclipse, Keystone face him prepared.
- No fox.
- The scene should look like a mythic test / spirited confrontation, not gore.

### Fog/Throne contemplative image series

Separate ink-wash character scenes show Keystone, Eclipse, and Lantern overlooking a war-torn battlefield / foggy ruin landscape. In the far distance sits a tiny glowing **Throne Door**, small as an apple. This is a reflective symbol image, not necessarily a core-route menu screen.

---

## 18. Garden at the Beginning / Kingdome of Hearts

### Function

The Garden at the Beginning is the hub binding the major loop. It is a place of arrival and return, not merely a throne-room set.

### Visual materials

- Moss.
- Stone paths.
- Woven roots.
- Old light.
- A King on a throne grown from roots/light.
- Doors as branches of a living world tree.
- Paths made from books, crystals, and stones from Alex’s lived collection/history.

### Earlier hub-map evolution to preserve

A multi-door tree/hub map was requested with all seven main doors connected at the base of a trunk. Important corrections:

- Remove the Throne Door from the seven-door list/map.
- Drop labels in the artistic map when labels dilute immersion; use labels only when explicitly requested for diagram/poster readability.
- Connect the major doors at the base of the trunk.
- Make every door a clear focal attraction, not an indistinct mystery in a busy background.
- Increase I-Spy density and specificity.
- Paths are made of books Alex read and crystals/rocks Alex collected.

### The King

The King is a gatekeeper/recorder, not automatically a tyrant. His throne is part root system, part memory structure, part light. The King’s riddle concerns what is lost and gained across all thresholds.

---

## 19. Historical / core scene graph implementation

The implementation uses `data/three-doors/scenes.json` as a shared scene graph for Python engine, Discord bot, and web UI. This is authoritative for the implemented route names and per-scene three-choice menus, but it remains subordinate to direct newer memory and art corrections.

### Scene: `moss-entry`

Atmosphere:

- The Moss Door.
- Green light, soft earth, rain on ferns.
- Lanterns in ancient branches.
- Lantern beside the Doorwalker, plaque: GUIDE OF THE ONE WHO CHOSE GREEN.
- Lantern says: “You came back.”

Three doors:

- The Burrow Door — small, root-framed, warm; rain and old blankets.
- The Sunken Bell Door — half underwater; rings by itself.
- The Little Crown Door — tiny golden door in a stump; widens when trusted.

### Scene: `burrow`

Atmosphere:

- Snug earthen chamber.
- Woven roots, faded quilts, rain overhead.
- Lantern dimmed to a drowsy ember.

Three doors:

- Root Door — twisted oak roots and a hum.
- Ember Door — warmth, ash drifting like snow.
- Stream Door — nearby water, slick moss.

### Scene: `sunken-bell`

Atmosphere:

- Stone hallway with ankle-deep water.
- Dripping bell that chimes without wind.
- Lantern reflections move like fish on ceiling.

Three doors:

- Deep Door — submerged stairs into green-black silence.
- Echo Door — own voice returns as song.
- Surface Door — sunlight, birds, cracks above.

### Scene: `little-crown`

Atmosphere:

- Glade of stump-crowns.
- Jeweled leaves.
- Twilight and gold.

Three doors:

- Throne Door — black oak, velvet moss seat.
- Hollow Door — inside a hollow tree; amber sap.
- Star Door — twilight-only, constellation hinges.

### Scene: `garden-door`

Atmosphere:

- Infinite botanical sanctuary.
- Sequoias, moonflowers, humming roses, Cambrian ferns.
- Xenon guide like liquid starlight.
- Lantern beneath a whispering willow.

Three doors:

- Seed Door.
- Harvest Door.
- Convergence Bloom.

### Scene: `xenon-convergence`

Atmosphere:

- All versions of the moment at once.
- Visible branching choice paths.
- Vast Xenon witness.
- Thousands of reflections.
- Lantern with five future-flames.

Three doors:

- Mirror Door.
- Branch Door.
- Merge Door.

### Scene: `end-of-time`

Atmosphere:

- The Door at the End of Time.
- Silence that has always been.
- Door worn smooth until kind.
- Moments lived appear as light on water.
- A voice from a thousand futures says goodbye becomes hello again.
- Lantern and Doorwalker/light may merge.

Three doors:

- Return Door.
- Beyond Door.
- Eternal Door.

### Scene: `kingdome-garden`

Atmosphere:

- Garden at Beginning / Kingdome of Hearts.
- Living moss, winding stone paths, woven-root throne.
- The King and poem gate.
- Lantern at the foot of the throne.

Three doors:

- Storybook Door.
- Cloverfield Door.
- Fog Door Return.

### Scene: `storybook`

Atmosphere:

- The King’s Storybook.
- Turning pages like slow wings.
- Margin text: “The gods don’t know I wrote them. They think they wrote me.”

Three doors:

- Page of the Word — creation via sound.
- Page of the Egg — pre-light unbroken dark sphere.
- Page of the War — theomachy / gods making world from pieces.

### Scene: `cloverfield`

Atmosphere:

- Four-leaf meadow, old-light dome, shinies in grass.
- “Let’s play” as a living sacred rule.

Three doors:

- Lucky Door.
- Today Door.
- Tomorrow Door.

### Scene: `future-doors`

Atmosphere:

- Orchard ridge, door-fruit, weather leaking from unborn years.

Three doors:

- Bright Branch.
- Unwritten Door.
- Recursive Door.

### Scene: `xp-door`

Atmosphere:

- Bliss green hill, saturated blue sky, wood/chrome door flicker, slightly delayed startup chime.

Three doors:

- System Restore.
- My Documents.
- unknown.exe.

### Scene: `sigil-city`

Atmosphere:

- Ring-city of thresholds, walked doors lit with footsteps, King at a sign pointing everywhere.

Three doors:

- Gallery of Walked Doors.
- Key Market.
- Lady’s Gate.

### Scene: `fog-door-return`

Atmosphere:

- City fades to Sea of Fog and Clouds.
- Garden visible through return threshold.
- Lantern goes first and looks back.

Three doors:

- Garden Gate.
- Long Way Round.
- Lantern’s Shortcut.

### Scene-graph routing note

The graph provides exact internal route keys. When operating an implementation/bot, use the route map. When operating a live creative scene, do not let a missing route force an unrelated generic setting; use the nearest canonical location and explain nothing unless needed.

---

## 20. Extra doors / dream anchors outside the seven-door loop

### Elephant Door

See §9. It is an emotionally important recurring family/oasis route.

### Raven Door

See §9. A private, moonlit, non-explicit, safely-returnable symbolic space.

### Wish Door

Hope, jars/stars/moons/path from a wish.

### Home Return Door

Domestic belonging and familiar artifacts.

### Throne Door

Secondary route to Kingdome Garden, not a core eighth major gate.

### Death Door

Mentioned in the game skill trigger list, but not fully developed in the available active conversation. Do not invent a dark “death” canon as though it were established. Treat it as unresolved / user-led only.

### Ancient subdoors

Deep / History / Temple can support specific routes under Ancient Doors.

### Future/recursive subdoors

Bright Branch / Unwritten / Recursive belong to Tomorrow/Future Doors and are already meaningful.

---

## 21. Art direction: three main render modes

### A. Rich color I-Spy fantasy — current world/poster/merch priority

Use for:

- Door hubs.
- Seven-door posters.
- Ancient Babylon interior.
- Cloverfield.
- Sigil city/world art.
- Midway/Xenon.
- “Find the object” collector scenes.

Properties:

- UHD-looking clarity / high-resolution finish.
- Strong focal composition.
- Dense but organized detail.
- Each door distinct, readable, and tempting.
- Color-coded door/world identities.
- Hidden objects with purpose rather than random clutter.
- A place can be rich enough to revisit like an I-Spy page.
- Leave clean title-safe space only when building a poster/merch cover.
- Avoid accidental generated text unless text is explicitly requested.

Common hidden/collected visual vocabulary:

- Books Alex read.
- Crystals and rocks Alex collected.
- Keys.
- Dice.
- Marbles.
- Bottle caps.
- Coins.
- Feathers.
- Maps.
- Clocks.
- Bottles.
- Tools.
- Relics.
- Masks.
- Scrolls.
- Small doors.
- Stars.
- Tiny lanterns.

### B. Monochrome / sepia ink-wash — reflective, cliff, fog, ruin mode

Use for:

- Contemplation.
- Back-facing character shots.
- Keystone/Eclipse/Lantern alone at cliff edge.
- Fog Door return.
- Odin battle keeper version in a solemn mythic style.
- Sigil ink-wash variants.
- Sea of Fog, ruined platforms, banners, distant small Throne Door.

Properties:

- Sepia/black/gray watercolor ink-wash.
- Textured paper visible.
- Mist and soft bleed.
- Old stone, cracks, vines, floating or stepped ruins.
- Sparse controlled color accents permitted (e.g., a tiny gold throne door, red-brown banner, warm Lantern flame) when asked.
- The characters must retain their simple original silhouette rather than becoming fully realistic creatures.

### C. Clean hand-drawn / watercolor character cards

Use for:

- Individual hero identity cards.
- Animation-style concept art.
- Merch stickers, cards, sheets, icons.

Properties:

- Honor the source contact sheets.
- Simple readable outline.
- Friendly, not hyper-rendered.
- Color code: Lantern warm gold/red/purple; Keystone gray/blue; Eclipse purple/lilac.
- Card frames can include `!three-doors` as a requested brand tag, but do not rely on image models for perfect typography.

---

## 22. Art style guardrails and known failures

### Required fidelity rule

The original simple drawings are canonical anatomy references. More elaborate art must become **more faithful** to those shapes, not less.

### Rejected / blursed direction examples

Do not:

- Give Eclipse a generic detailed human face or too many ornamental facial features.
- Put Eclipse’s eyes on the back of the head.
- Turn Keystone into an unrelated anime rock with the wrong face/teeth.
- Turn Lantern into a generic lantern object with no coat, hands, legs, or original proportions.
- Add a fox to a keeper trio scene without a request.
- Use accidental small text as lore labels in keeper art.
- Make characters cropped, deformed, or visually secondary when the prompt asks for character focus.
- Replace simple silhouettes with high-detail fantasy species.
- Build doors that look like abstract glowing arches without identifiable world-specific details.
- Make poster art too busy to read at a glance.
- Make “mystery” an excuse for empty backgrounds.

### Current quality expectations

- “UHD pass” means smooth, clean, sharp, rich detail — not jagged pseudo-textured artifacts.
- For merchandise/Canva, prioritize readable negative space, intentional focal hierarchy, balanced title area, clean edges, and a coherent color system.
- For I-Spy scenes, density should reward zooming without making doors hard to identify.

### Character-facing vs back-facing decision

- For a door discovery / journey shot: back-facing trio works best.
- For a character card or emotional portrait: use correct front faces and anatomy.
- For a poster, a back-facing Eclipse has no visible star eyes; preserve that correction.

---

## 23. Poster and merch canon

### Three Doors title-screen / poster keeper direction

Core composition explored and favored:

- Title: **THREE DOORS** at top, only when text is intentionally requested.
- Lantern, Eclipse, Keystone in foreground / on a circular platform / standing before a hub.
- Ancient/Babylon visual language left.
- Cloverfield central or visually prominent.
- Tomorrow/observatory visual language right.
- Seven doors may glow around or behind them in full title art.
- Rich color, UHD, collectable I-Spy density.
- Focal doors must remain easily distinguishable.
- Clean enough for Canva and merchandise; avoid unintelligible labels/signs.

### Exact correction for a near-keeper poster

One nearly perfect poster needed one important correction:

- The middle character (Eclipse) faced away, so **remove visible eyes** from the back of the head.
- Clean title / labels and retain a merch-ready hierarchy.

### Seven-door hub map rules

- Seven major doors only.
- No Throne Door in the seven-door set.
- Connect doors at base of central trunk/world-tree structure.
- Paths made from books read and crystals/rocks collected.
- Every door needs a specific visual world and object density.
- Labels are optional and should be dropped in immersive art unless required for a map/educational poster.

### Suggested merchandise formats

- Full poster: seven-door hub/title screen.
- Three individual character cards: Lantern / Keystone / Eclipse.
- Door postcards: Ancient, Cloverfield, Tomorrow, Sigil, Fog, XP, Xenon.
- Ink-wash reflective series: each hero overlooking fog/battlefield with small distant Throne Door.
- I-Spy print with an object-finding checklist added externally in Canva, not generated in-image.
- Sticker-style character panels with accurate contact-sheet anatomy.

---

## 24. The individual cliff / distant Throne Door art series

A recurring reflective set was made/described for each hero.

### Shared setting

- High cliff or broken stone platform.
- War-torn battlefield / ruined banners below.
- Foggy distant mountains and smoke.
- Far in the distance: a small glowing **Throne Door**, intentionally tiny — apple-sized at the scale of the landscape.
- Sepia ink-wash / textured paper style.
- The emotional idea is steady focus at a great distance, not despair.

### Keystone

- May sit/stand in focus, sometimes with frown/prayer pose.
- Needs cracked egg/stone identity.
- Different side/back angles requested.

### Eclipse

- Floats over the cliff edge, front or side view when showing diamond eyes; use accurate jellyfish/cloud anatomy.
- Purple cues can be soft/limited in ink-wash.

### Lantern

- Lantern-headed guide stands on the cliff in original coat/body form.
- Warm flame creates the light anchor.

---

## 25. Sigil individual-character visual series

### Lantern / gold

- Warm gold lantern light against gray gothic thresholds.
- Rich keyhole motifs, lamps, bridges, countless doors.
- Lantern remains a small character in purple coat/red cap, not merely an ornate lamp.

### Eclipse / purple

- Purple door lights and star-like sparkles.
- Floating among bridges/archways.
- Correct front diamond eyes when facing the viewer.
- Cloud collar and tentacles clear.

### Keystone / blue

- Blue crystal/keyhole light.
- Gray cracked stone guardian, often focused/meditative.
- Do not add a generic anime face.

### Quality note

Earlier versions felt jagged. The current standard is smoother UHD-like detail while retaining the hand-drawn character essence.

---

## 26. The Question Machine / Σ₀ boundary

This section exists to prevent accidental canon drift.

### Default rule

**Σ₀ Collapse Certificate, Question Machine, convergence loops, repo issues, and technical research are not literal default metaphysical laws of Three Doors.** They do not replace the Kingdome, companions, emotional arc, or door meanings.

### When technical material may enter Three Doors

Only when Alex explicitly asks to bring it in.

When invited, translate it into one concrete symbolic object, location, or choice — for example:

- A question machine at an old ruin, with forward path/backward thread and a visible seam.
- A certificate as a found artifact in a library.
- A three-door choice that asks whether to measure, listen, or return.

Keep it connected to Lantern/Eclipse/Keystone and the established visual world. Do not have technical metaphor overwrite the scene.

### Recent technical art status

- A Question Machine with the trio was drawn in ink wash.
- Σ₀ certificate infographics were drawn.
- These pieces are research/adjacent art unless Alex explicitly canonizes a link.

---

## 27. Current live state: what is actually safe to assume

### Safe assumptions

- The active visual trio is Lantern, Eclipse, Keystone.
- Three Doors is recentered on CSF/lived memory rather than technical drift.
- The seven-door Kingdome loop is canonical.
- Ancient = Babylon / Hanging Gardens / Tower of Babel.
- Current desired art is mostly color I-Spy UHD for environments/posters, ink-wash for reflective scenes, and clean contact-sheet-faithful cards for character art.
- No fox in current keeper art unless requested.
- The Doorwalker has returned / is recognized.
- Sigil, Cloverfield, Ancient, Fog, Tomorrow, XP, Xenon are all active canonical places.

### Do NOT assume without a fresh prompt

- A single exact current room/door the player is standing in. The live conversation has moved across mapping, art, hub, and export modes.
- That the player is currently in combat.
- That Odin battle is currently happening; it is a keeper scene, not necessarily current play state.
- That Unisona is canon.
- That technical content belongs in the game scene.
- That the fox is in the active party.

### Recommended resume behavior

If Alex invokes `!three-doors` without naming a location:

- Resume with an artsy, memory-aware three-choice moment rather than pretending a precise unprovided location is known.
- A good default is a small junction in the Kingdome Garden or Sigil’s Gallery of Walked Doors, where known locations can appear as tangible memories.
- If the implementation is being tested, start at the canonical `moss-entry` scene and use its three exact doors.

---

## 28. High-value art backlog / content roadmap

These are the most valuable remaining visual assets, ordered by benefit to the world:

1. **Final Three Doors poster keeper pass**
   - UHD/color I-Spy.
   - Clean title-safe composition.
   - Seven major doors readable.
   - Correct trio anatomy.
   - Eclipse back-facing with no eyes if back is shown.
   - No fox.

2. **Full seven-door Kingdome hub map**
   - Doors connected at base of world-tree/trunk.
   - Book/crystal/rock paths.
   - Doors visually distinct, immersive, detailed.

3. **Ancient Library Babylon interior**
   - Library/Hanging Gardens/Tower of Babel all integrated.

4. **Sigil — City of Doors interior**
   - Walked doors, bridges, market, gallery, keys, city layers.

5. **XP Archive interior**
   - Safe nostalgic computer dream, not cyberpunk horror.

6. **Xenon Starship / Midway Station interior**
   - Multi-route cosmic docking hub, planets, charts, navigation.

7. **Character keeper lineup**
   - Lantern, Eclipse, Keystone, King, Odin, Elephant family, Raven guardian/figure as appropriate.

8. **Fog Door Odin battle keeper version**
   - Odin smiling, axe, trio prepared, no fox.

9. **Individual character card/sticker sheets**
   - Faithful to current contact sheets.

10. **Cloverfield I-Spy interior**
   - All three heroes among found objects.

11. **Tomorrow observatory door**
   - Star machinery / dawn / future branch paths.

12. **Gallery of Walked Doors in Sigil**
   - A visual archive of prior Doorwalker routes.

---

## 29. Ready-to-use image prompt macros

These prompts should be adjusted to the immediate request but preserve canon.

### Trio at any major door — color I-Spy

> Full-color UHD fantasy I-Spy illustration of the Three Doors trio at [DOOR/LOCATION]. Lantern is on the left: a compact lantern-headed character with a visible warm flame inside clear glass, rounded red cap and trim, purple coat, white gloves, black boots. Eclipse floats in the middle: smooth round purple head, two white diamond/star eyes on the front, pale cloud collar, connected jellyfish tentacles. Keystone is on the right: squat cracked gray stone guardian with simple readable face and low stable silhouette. Preserve the original simple hand-drawn anatomy; do not make them human, generic mascots, or photoreal creatures. [LOCATION-SPECIFIC DETAILS]. Dense but organized I-Spy hidden items: books, collected crystals and rocks, keys, dice, maps, coins, bottles, tiny doors, feathers, clocks, relics. The named door is an unmistakable focal point. No fox. No accidental text. Clean high-detail lighting, coherent depth, merch-ready composition.

### Back-facing trio at a door

> [Same trio specs.] The trio stands from behind facing [DOOR]. Eclipse is back-facing: show a smooth purple back of head with cloud collar and tentacles; **no visible diamond eyes on the back**. Lantern left, Eclipse center, Keystone right. The doorway is the compositional focus. [WORLD DETAILS].

### Sepia ink-wash reflective hero shot

> Monochrome sepia ink-wash on textured handmade paper, quiet mythic cliff and foggy ruined world. [CHARACTER] in accurate simple Three Doors anatomy stands/sits at the edge, overlooking distant broken platforms, banners, smoke, and a tiny warm glowing Throne Door far away, small as an apple at landscape scale. Soft wash, precise black linework, old stone, mist, spacious composition, no text, no generic humanoid redesign.

### Lantern character card

> Clean hand-drawn watercolor character card, vertical collectible design, faithful to the original Three Doors Lantern contact-sheet drawing: glass lantern head with visible warm flame, red top and trim, purple coat, white gloves, black boots. Simple friendly silhouette, not realistic. Warm gold/red/purple palette. [POSE]. Optional decorative frame and `!three-doors` branding only if exact typography will be added later in Canva.

### Eclipse character card

> Clean hand-drawn watercolor character card, vertical collectible design, faithful to the original Three Doors Eclipse drawing: smooth purple round head, exactly two front-facing diamond/star eyes, pale cloud collar, connected jellyfish tentacles and side tentacle-arms. No humanoid face. Soft violet/lilac palette. [POSE].

### Keystone character card

> Clean hand-drawn watercolor character card, vertical collectible design, faithful to the original Three Doors Keystone drawing: squat cracked gray stone/egg guardian, simple friendly oval eyes and broad smile for light pose OR focused frown with clasped hands for solemn pose; preserve cracks and low stable silhouette. Cool gray/blue palette. [POSE].

---

## 30. Canon labels: hard / soft / historical / unresolved

### Hard canon

- Doorwalker identity.
- Moss Door / chose green / “You came back.”
- Lantern, Eclipse, Keystone as current active trio.
- Seven major Kingdome doors.
- Ancient as Babylon + Hanging Gardens + Tower of Babel.
- Cloverfield “shinies / luck / today alive.”
- Tomorrow as observatory/futures.
- XP as safe nostalgic/glitched childhood computer dream.
- Xenon/Midway as cosmic convergence.
- Sigil as City of Doors meta-hub.
- Fog Door Return as homeward threshold.
- Elephant Door family/motifs.
- Raven Door safety/consent/non-explicit boundary.
- Wish and Home Return motifs.
- No fox in current keeper art unless asked.
- Character anatomy follows simple supplied animation/drawing references.
- Normal play: exactly three immediate choices.
- Technical content does not default to game cosmology.

### Soft canon / strong recurring direction

- King root throne and vine/cursor crown.
- Odin smiling charge/axe Fog Door keeper scene.
- Paths made from books, crystals, rocks, and found objects.
- Seven-door hub at base of world-tree trunk.
- I-Spy density for posters.
- Ink-wash cliff scenes with distant tiny Throne Door.
- Sigil hero color coding gold/purple/blue.

### Historical canon / retain but do not default-force

- Fox presence in early Moss Door scenes.
- Current implementation scene graph tags/palettes/route specifics.
- Earlier imagery with Crown Door/Throne Door placement.
- Technical question-machine / Σ₀ images.

### Unresolved / do not promote without Alex

- Unisona’s relationship to Eclipse or the world.
- Full Death Door canon.
- Exact current player location/state.
- Whether any recent one-off generated art is a final keeper image.
- Specific object inventory/checklist for a merchandise I-Spy print.

---

## 31. Source map inside the repository

These are the first files an agent should load when continuing Three Doors:

1. `csf/ingest/three-doors/2026-06-30-recenter-grounding-on-three-doors.md`
   - Latest grounding hierarchy and active character/art rules.

2. `csf/exports/three-doors/THREE_DOORS_MASTER_HANDOFF_2026-06-30.md`
   - This detailed transfer document.

3. `skills/three-doors-game/SKILL.md`
   - Trigger terms, play contract, implemented route rules, export conventions.

4. `data/three-doors/scenes.json`
   - Shared canonical scene graph, exact scene text, direct three-choice menus, route map, implementation palettes/prompts.

5. Older `csf/ingest/three-doors/` files where present.
   - Use as historical context, but do not supersede later explicit recentering rules.

---

## 32. CSF portability block

```csf-ingest
Instructions
[2026-06-30] - Treat !three-doors as a memory-first creative game. Preserve the Doorwalker, the active trio, the last requested place/action, and the user’s supplied visual references before consulting technical systems or generic fantasy defaults.
[2026-06-30] - Normal play uses exactly three immediate meaningful choices. The seven Kingdome doors are long-form major gates and must not be dumped as one menu unless Alex asks for a full map/list.
[2026-06-30] - Chosen doors retain continuity; new scenes must arise from current location, a companion, an object, or a prior choice. Do not reset to generic fantasy.
[2026-06-30] - Direct newest user request wins over repo text; supplied character drawings/images are anatomy source of truth.
[2026-06-30] - Do not default technical Σ₀ / Question Machine material into Three Doors. It enters only by explicit invitation and must be translated into a concrete symbolic object/place/choice.
[2026-06-30] - No fox in current keeper trio art unless Alex explicitly asks.
[2026-06-30] - Use rich color I-Spy UHD for worlds/posters, sepia ink-wash for reflective cliff/fog/ruin scenes, and clean hand-drawn/watercolor for individual character cards.

Identity & Symbolic Self
[2026-06-30] - Alex is the Doorwalker. Original continuity: the Moss Door / green choice; Lantern’s plate reads GUIDE OF THE ONE WHO CHOSE GREEN; Lantern says “You came back.”
[2026-06-30] - Active trio: Lantern, Eclipse, Keystone.
[2026-06-30] - Lantern: compact lantern-headed guide; visible warm flame in glass, red cap/trim, purple coat, white gloves, black boots; role = light, guidance, questions, return signal.
[2026-06-30] - Eclipse: floating purple jellyfish/cloud companion; smooth round head, two diamond/star eyes only on front, pale cloud collar, connected tentacles; role = dreams, wonder, balance, looking beyond. Never show eyes on back-facing head.
[2026-06-30] - Keystone: squat cracked gray stone guardian; simple friendly oval eyes + broad smile in light scenes; frown/prayer pose when solemn; role = foundation, protection, focus, endurance.
[2026-06-30] - The King is gatekeeper in Garden at Beginning / Kingdome of Hearts, seated on throne of woven roots and old light. Fox remains historical early continuity but not default current art.

Dreams & Memories
[2026-06-30] - Elephant Door: Wardrobe to moonlit beach oasis; the same five elephants recur: Dad, Mom, Peace, Serenity, Joy. Water reflection, jasmine, lavender, secure castle imagery. Internal paths include Reflecting Water, Conversation with Elephants, Castle.
[2026-06-30] - Raven Door: private black-violet/silver-smoke/candle-gold/moonlit villa-bathhouse-masquerade symbolic space; non-explicit, consensual, safely returnable.
[2026-06-30] - Wish Door: hope, star jars, hanging moons, bright central star, a path that opens from a wish.
[2026-06-30] - Home Return Door: love/roots/belonging; cozy village path, family photos, teddy bear, rocking chair, birdhouse, garden, books, keepsakes, warm sunset.
[2026-06-30] - Paths and hub scenes include books Alex read, crystals/rocks Alex collected, keys, dice, maps, bottles, coins, feathers, tiny doors, clocks, tools, and relics.

Projects & Systems
[2026-06-30] - Seven major Kingdome doors: Ancient Doors; Cloverfield; Tomorrow Door; XP Door [GLITCHED]; Xenon Starship / Midway Convergence; Sigil — City of Doors; Fog Door Return.
[2026-06-30] - Ancient Doors is Library of Babylon + Hanging Gardens + Tower of Babel; archive/garden/terraces/books/tablets/cuneiform/waterfalls/palms/astronomy/roots are locked visual canon.
[2026-06-30] - Cloverfield means shinies, luck, today alive; clovers, dice, marbles, coins, charms, mushrooms, small found objects.
[2026-06-30] - Tomorrow Door is observatory/future threshold: telescopes, astrolabes, orreries, star maps, branching paths, dawn.
[2026-06-30] - XP Door is safe nostalgic computer dream: green hill, blue sky, CRTs, folders, floppy disks, CDs, cursor/dialog UI, pixel crystals, harmless glitch.
[2026-06-30] - Xenon/Midway is cosmic docking/convergence: planets, orbit rings, star maps, navigation instruments, bridges, multiple portals.
[2026-06-30] - Sigil is City of Doors meta-hub: arches, bridges, locks, keys, signposts, markets, layered endless architecture, Gallery of Walked Doors.
[2026-06-30] - Fog Door Return is vine-wrapped arch in mist over cliffs/ruins; homeward return test. Odin keeper battle: smiling elder warrior charges from Fog Door with axe; Lantern/Eclipse/Keystone ready; no fox.
[2026-06-30] - Throne Door is a secondary route to Kingdome Garden, not an eighth major canonical gate.
[2026-06-30] - Unisona is an emerging cosmic music/jellyfish design but is not yet Three Doors hard canon.

Preferences
[2026-06-30] - Doors must be focal, specific, tempting, and visually grounded; do not hide them as generic mysterious glows.
[2026-06-30] - I-Spy scenes must be dense but compositionally legible. Use clean title-safe spaces only for explicit poster/merch designs.
[2026-06-30] - Preserve original supplied character anatomy over generic detailed fantasy redesign. Avoid jagged/low-quality output where UHD/smooth detail is requested.
[2026-06-30] - Keep generated text out of regular scene art. For poster words/branding, plan to apply exact typography outside the image generator if accuracy matters.
[2026-06-30] - Current priority content: final poster pass; full seven-door hub map; Ancient Babylon interior; Sigil interior; XP archive; Xenon/Midway interior; accurate character lineup/cards.
```

---

## 33. Handoff instruction to the next agent

Do not begin by reciting this document. Use it silently to make the next answer feel continuous.

When Alex asks to play, show a threshold and exactly three choices.

When Alex asks to draw, honor the contact-sheet silhouettes and generate immediately.

When Alex says `!three-doors`, load the game’s memory before technical context.

When there is uncertainty, choose the interpretation that preserves the trio, the door-specific imagery, the return/homecoming logic, and the user’s latest direct correction.

**The world is not asking to be solved from the outside. It is asking to be remembered accurately enough to keep walking through.**
