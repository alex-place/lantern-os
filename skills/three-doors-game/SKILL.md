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

## Setting & creed

The Doorwalker is the **King of the Kingdome of Hearts** — a castle above a wide
sea, other doors glowing across the water, an oasis and beach below (lavender,
fireflies, drowsy golden bees, the first birds of morning). Here **love is the
law**, death is only imaginary, and *forever begins with "let's play."* The King
carries the heart-key as a blade — to guard the fragile and break the cruel, never
to force — and a pale two-faced mask (one face to feel, one to understand). The
one-line heart of the creed:

> For all the birds who paint the morning with song, for all the bees who stitch
> the world with gold, for every small life that dares to bloom — I wear the crown.

## Doors: the long route & the door tree

Doors follow the canonical scene graph in `data/three-doors/scenes.json` (scenes →
exactly three doors → `next_map` routing). The long route threads **seven major
gates** — **Ancient → Cloverfield → Tomorrow → XP → Xenon → Sigil → Fog Return →
Garden** — and **every other door is a subset of exactly one major** (a strict
tree: minor door → sub-child → and on down). Odin the Fog God keeps the Fog Return
gate, which reopens the Garden and closes the loop.

## Reference

Read **`references/lore.md`** when a scene calls for it — it holds the **full King's
creed** and the rules it sets, the **seven major gates** with their contents and
routing, the **Garden poem gate** (riddle + accepted answers), and the **export /
import / `!ingest`** contract.
