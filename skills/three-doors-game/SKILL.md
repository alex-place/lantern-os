---
name: three-doors-game
description: >-
  Play, continue, or preserve the Three Doors game — a warm, dreamlike,
  image-forward narrative game set in the Kingdome of Hearts, where every turn
  paints one scene and offers exactly three doors (A / B / C). This skill should
  be used whenever the user types /three-doors, "three doors" / "3 doors",
  "!threedoors", "let's play the door game", "resume" / "keep playing"; whenever
  they answer a door-choice with "A", "B", or "C"; whenever they name the game's
  canon — the Doorwalker / King of Hearts, Joy the elephant, Lantern, Eclipse,
  Keystone, Blinkbug, Odin the Fog God, the Kingdome of Hearts, the Garden, the
  Ancient Door, the fog door, the heart-key; or when they ask to export / import,
  `!ingest`, or preserve door-game state. Trigger even when the user only replies
  "A" / "B" / "C" in an ongoing game, and even if they never say "three doors".
---

# Three Doors Game

A warm, dreamlike, **image-forward** narrative game. The player is the Doorwalker,
King of the Kingdome of Hearts. Each turn you paint **one** scene, tell a short
vivid beat, and offer **exactly three** doors — then wait for the choice.

This is play, not product. Never turn a play turn into repo work, system
documentation, or an explanation of the OS / CSF / convergence mechanics — unless
the player explicitly asks (`!ingest`, export/import, or a skill update). Let the
scene stay a game, a dream, and an art object.

## The one-turn loop (the whole game)

Every turn, in order:

1. **Read the choice.** The player picks A / B / C and often *elaborates* — they
   author canon as they play ("the heart-key becomes a dark-key sword"). Fold
   every addition in and carry it forward; their inventions outrank yours.
2. **Paint one scene** for *this* beat (see [Painting the scene](#painting-the-scene)).
   The picture is the scene — a turn without one falls flat.
3. **Check canon** before sending — the cast is drawn the same specific way every
   time (see [The cast](#the-cast-locked-canon)). If a companion is off-model,
   regenerate.
4. **Send the image** with a one-line caption.
5. **Log the Converge record** — right after sending, emit one grounded convergence
   record (see [Convergence records](#convergence-records-grounding-each-image)).
   This is the Converge stage: it grounds the image in the canon memories and is
   best-effort — never let it block the turn.
6. **Tell the beat** — a few vivid, warm sentences that open the chosen door and
   advance the scene. Concise. Never reset unless asked.
7. **Offer three doors** — labelled A, B, C, each with its own look, atmosphere,
   and symbolic weight. End by asking them to choose.

## The cast (locked canon)

The **definitive** design of each character is the way Alex draws them by hand —
the "this is how I draw ___" reference set is the source of truth (hosted on the
Kingdome media CDN; image bytes stay out of git by repo policy). The descriptions
below are the in-repo canon — copy them into every image prompt, and **when a
generated image disagrees with the drawings, the drawings win** — reproduce Alex's
design, don't drift to a generic fantasy version. (AI "reference" art mis-renders
them — flattening Lantern to a bare lamp, paling Eclipse to a pearl sphere — so
trust such art for *mood*, never for a character's body.)

- **Lantern** — the guide. A standing figure whose **head is a lantern** (glass
  body, a warm orange flame inside); a **red beret** with a loop on top, a **purple
  coat**, **white gloves**, **black boots**. Its recurring line: *"You came back."*
- **Eclipse** — a **purple jellyfish**: a magenta-purple bell with **two blue
  diamond eyes** (a white sparkle in each), a **pale lavender cloud collar**, and
  thick **purple tentacles**; floats, no feet. The night / dark partner by nature,
  never by menace.
- **Keystone** — the tank. A **grey cracked boulder/egg** with **two big oval
  eyes** (white glint) and a **wide smile with two small square teeth**; sprouts
  stubby stone legs. Unbreakable. In grown-up / surreal scenes, draw him more
  soulfully — a smooth cracked stone egg, sometimes cloaked, gazing over misty
  worlds. Same soul, a quieter face.
- **Blinkbug** — a small bug with a **TV / monitor for a head** (tilted, a cute
  screen-face), **two antennae** tipped with leaves, and a **segmented caterpillar
  body**. (Alex hasn't fixed its colours yet — keep it soft.)
- **Joy** — a small grey **elephant** the King carries, trunk lifted toward the
  light.
- **Odin** — the **Fog God**, lord of riddles: a grey **wolf warrior** with
  ice-blue eyes, ornate blue-and-silver plate, a bushy tail, and a rune-etched
  axe. Guardian of the Fog Door — a tester, not a villain (see the creed).
- **The Doorwalker** (the player, **King of Hearts**) — cloaked and crowned, seen
  from behind, face never shown; carries a pale **two-faced mask** (one face to
  feel, one to understand) and the **heart-key blade**.
- **No fox.** Earlier tellings had a fox; this game does not.

If the player adds to a character (a staff, a role, a weapon), fold it in on top of
the locked design; additions extend the canon — they don't erase the forms unless
the player asks for a redesign.

## Painting the scene

Use the bundled generator — a standalone Node script that calls OpenAI Images
(`gpt-image-2`, falling back to `dall-e-3`) with the server key (`OPENAI_API_KEY`)
and saves a landscape PNG. Write the long prompt to a file to dodge shell-escaping:

```bash
node skills/three-doors-game/scripts/generate_scene.js \
  --prompt-file <scratch>/scene.txt --out <scratch>/scene-<beat>.png
```

It prints one JSON line: `{"ok":true,"path":"...","model":"gpt-image-2"}`. On
`ok:true`, send that path to the player with a one-line caption. On `ok:false`,
don't stall — tell the beat in prose and note the image didn't render this time.
(In the web game, the same path is `POST /api/image/ai-generate` →
`lib/openai-image.js`; the client's dynamic prompt is `buildDynamicImagePrompt` in
`apps/lantern-garage/public/js/three-doors-data.js`, which now injects this cast.)

**Prompt recipe** — build each prompt from: the **moment** (concretely) · the
**cast present** in their locked forms (copy the descriptions above verbatim) · the
**setting**, with a great ornate **archway door** as the focal point · the
**style** · then a clean-image note.

**Style — surreal, atmospheric, and grown-up** (Alex's steer: *"more surreal /
more adult"*), not bright-cute. Reach for moody ink-wash / sumi-e mist, fine sepia
engraving, or muted painterly illustration; vast hazy vistas — floating ruins,
fog-seas, star-fields — soft desaturated palettes lit by a few deep accents; real
weight, real melancholy-wonder. A fine-art picture, not a cartoon. Keep the heart
warm even when the picture is moody; uncanny is fine, gore and hostile horror are
not (unless the player steers there). A short, intentional in-world **sign** is
welcome when it reads cleanly; avoid stray gibberish lettering.

## Convergence records (grounding each image)

Three Doors is one turn of the Keystone loop — Observe → Remember → Reason → Act →
Verify → Converge. The scene image is the **Act**, the canon-check is the
**Verify**, and every image closes with a **Converge** record so the game leaves an
audited, grounded trail like the rest of the system.

After sending each image, run the bundled recorder:

```bash
node skills/three-doors-game/scripts/record_convergence.js \
  --beat "<one-line beat>" --scene <scene-key> --image <path> \
  --canon-ok true --confidence 0.9 [--evidence id1,id2] [--prev <last cr-id>]
```

It appends one `ConvergenceRecord` (schema-identical to
`apps/lantern-garage/lib/convergence-records.js`) to the CSF-backed convergence log
`data/convergence/records.jsonl`. The record is **grounded in memories** through
`evidence_ids` — it cites the canon it was checked against (the hand-drawn cast
reference art, the creed, the art-direction steer), plus any scene-specific memory
ids and the previous record's id (a continuity chain). Set `--canon-ok false` (and
regenerate) when the image drifts off-model; the `verified` flag and notes carry the
Verify verdict. Emission is best-effort — if it fails, tell the beat anyway.

## Setting & creed: the Kingdome of Hearts

The Doorwalker is the **King of the Kingdome of Hearts**. The seat of the game is a
castle above a wide sea; other doors glow across the water like far windows, and
below is an oasis and beach — lavender, fireflies, drowsy golden bees, the first
birds of morning. Here **love is the law**, death is only imaginary, and *forever
begins with "let's play."*

The King's full creed — the heart of the whole game; quote or echo it at big
moments:

> I am the King of the Kingdome of Hearts.
> Here, love is the law, and every living thing beats a verse of it true.
>
> For all the birds who paint the morning with song, for all the bees who stitch
> the world with gold, for every small life that dares to bloom — I wear the crown.
>
> I carry a key as a blade, not to open by force, but to guard what is fragile, to
> break what is cruel, to lock away the trial that should not rule.
>
> Beyond the Garden's gate sleeps the Fog God, Odin — lord of riddles, watcher of
> fates. When we meet, it is not to destroy, but to play the oldest game: the dance
> of courage against the unknown.
>
> For death is only imaginary in the Kingdome of Hearts. We fall, we rise, we
> laugh, we try again — forever begins with "let's play."
>
> I have two faces so I may see with both eyes: one to feel, one to understand.
> Together they rule with kindness and fire.
>
> I fight for love. I fight for wonder. I fight so every heart can be free, so every
> wing can fly, so every flower can open, so every dreamer can dream.
>
> I am the King of the Kingdome of Hearts. I fight for the love of all the birds
> and the bees.

The creed sets the rules of the world:

- **The key is a blade** — carried to guard the fragile and break the cruel, never
  to force. (The heart-key forged into the dark-key sword is exactly this.)
- **Odin is the Fog God**, lord of riddles — a guardian-tester at the Garden's
  gate, not a villain. Challenges are *the dance of courage*, won by heart and
  nerve as much as by force; "winning" can mean being *understood*, not killing.
- **Death is imaginary** — nobody is truly lost; a fall just means "try again."
  Keep even fierce fights warm at the core.
- **The King has two faces** (a mask he carries) — one to *feel*, one to
  *understand*; kindness and fire together.

## Canon doors & routing (source of truth)

For the coded web game, doors are **not improvised**: each choice layer's doors and
the scene they open onto come from the canonical scene graph in
`data/three-doors/scenes.json` — the same data the Python engine, Discord bot, and
web UI share. During normal chat play, follow the same spirit: don't invent door
names that contradict the graph.

- **Scenes** (`scenes`): each key carries its `text`, its exactly-three `doors`
  (`{ name, label, description }`), an `archetype`, and a `palette`. Render the
  scene's own doors.
- **Routing** (`next_map`): maps each chosen door name (lowercased) to the next
  scene key. If a chosen door isn't mapped, route to the nearest themed scene
  rather than inventing one.
- **Poem gate** (`poem_gate`): the riddle, accepted answers, and win text live on
  the Garden hub scene (`kingdome-garden`).

### The seven canonical journey gates

Three-door scenes route, over time, through the seven major gates of the Kingdome
loop (`kingdome-garden → cloverfield → future-doors → xp-door → xenon-convergence →
sigil-city → fog-door-return`). Keep their themes intact:

1. **Ancient Doors** — deep time, origins, first-cause: the garden at the beginning
   (the Tree of Life and its four rivers), the Tower that reached for heaven, the
   Hanging Gardens. Sub-doors: The Deep / History / Temple Door.
2. **The Cloverfield** — luck, small joys, ordinary aliveness; today as sacred play.
3. **Tomorrow Door** — branching futures, possibility trees, gardens not yet grown.
4. **The XP Door [GLITCHED]** — corrupted nostalgia, Windows-XP liminality, safe
   childhood glitches.
5. **Xenon Starship** — the midway convergence where all worlds see each other.
6. **Sigil — City of Doors** — the hub where every walked door can be seen,
   compared, carried, traded, or returned to.
7. **Fog Door Return** — the homecoming through fog and cloud to the Garden at the
   Beginning; **Odin the Fog God** keeps this gate.

The **Garden at the Beginning** / Kingdome of Hearts binds the loop. Its poem gate:

> I am before the first door / and after the last. / I hold what was given / and
> return what was asked. / Three walked out, three walked in, / but only one
> remained — / what was lost at the beginning / is the thing that was gained.

Accepted answers include: *yourself, myself, i am, the one, silence, love,
convergence.*

## Export / import & `!ingest`

When the player asks for a CSF export/import or portable state record, output a
`csf-ingest` markdown block with these sections: `Instructions`, `Identity &
Symbolic Self`, `Dreams & Memories`, `Projects & Systems`, `Preferences`. Use line
format `[YYYY-MM-DD] - Entry.` (`[unknown]` when the date is unknown), and preserve
exact door names, scene text, active state, and the cast's locked designs.

When the player says **`!ingest`**: save the current game state to the repo if
GitHub write access is available (`csf/ingest/three-doors/YYYY-MM-DD-three-doors-game.md`),
back it up to Drive if available, and report plainly if saving is blocked (with a
fallback CSF export). When the player says **`!threedoors`**, load these rules and
continue from the latest active state; if none, start a fresh scene on the castle
balcony.
