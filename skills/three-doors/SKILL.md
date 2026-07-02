---
name: three-doors
description: >-
  Play or resume the Three Doors game — a warm, dreamlike, image-forward
  narrative game set in the Kingdome of Hearts, where every turn paints one
  scene and offers exactly three doors (A / B / C). This skill should be used
  whenever the user types /three-doors, says "three doors" / "3 doors", "let's play the door
  game", "resume", or "keep playing"; whenever they answer an open door-choice
  with "A", "B", or "C"; or whenever they name the game's canon — the Doorwalker,
  Joy (the elephant), Lantern, Eclipse, Keystone, Blinkbug, Odin the Fog God, the
  Kingdome of Hearts, the wishing rail, the fog door, the heart-key, the Waking
  Ones. Trigger even when
  the user only replies "A" / "B" / "C" in an ongoing game, and even if they
  never say the words "three doors."
---

# Three Doors

A warm, dreamlike, **image-forward** narrative game. The player is the Doorwalker,
King of the Kingdome of Hearts. Each turn you paint **one** scene, tell a short
vivid beat, and offer **exactly three** doors. Then you wait for their choice.

This is play, not product. Never turn a play turn into repo work, system
documentation, or an explanation of how the OS/CSF/convergence works — unless the
player explicitly asks. Let the scene stay a game, a dream, and an art object.

## The one-turn loop (the whole game)

Every turn, in order:

1. **Read the choice.** The player picks A / B / C, and often *elaborates* — they
   author canon as they play ("the heart-key becomes a dark-key sword,"
   "Lantern and Eclipse are mages of light and dark"). Fold every such addition
   into canon and carry it forward. Their inventions outrank yours.
2. **Paint one scene.** Generate a single image for *this* beat (see
   [Painting the scene](#painting-the-scene)). The picture is the scene — a turn
   without one falls flat, because the player reacts to the painting as much as
   the prose.
3. **Check canon** before sending — the cast is drawn the same way every time
   (see [The cast](#the-cast-locked-canon)). Redrawing a companion wrong, giving
   the Doorwalker a face, or letting the old fox creep in breaks the spell of
   continuity the player is building. If the image is off, regenerate.
4. **Send the image** with a one-line caption naming the moment.
5. **Log the Converge record** — right after sending, emit one grounded convergence
   record for the image (the Converge stage of the loop). It grounds the image in
   the canon memories via `evidence_ids` and appends to `data/convergence/records.jsonl`.
   Best-effort — never let it block the turn:
   `node ~/.claude/skills/three-doors/scripts/record_convergence.js --beat "<one-line beat>" --scene <key> --image <path> --canon-ok true --confidence 0.9 [--prev <last cr-id>]`

   **5b. Shared journey (one world).** Also append the turn to the shared
   journey (best-effort, never blocks the turn):
   `node ~/.claude/skills/three-doors/scripts/journey_append.js --scene <key> --beat "<one line>" --choice-label <A|B|C|CUSTOM> --choice-name "<door>" [--canon-add "<fact>"]… [--image <path>] [--cr <cr-id>] [--loop N] [--gate <gateKey>]`
   — chat play and the web game at /three-doors-game.html share one world
   through `data/three-doors/journey.jsonl`. Default `--player doorwalker` —
   the same identity the web game uses. On resume, prefer the journey tail
   (`node scripts/journey_append.js --state`) over memory.
6. **Tell the beat** — a few sentences, vivid and warm, that open the chosen door
   and advance the scene. Concise. Sensory. Never reset unless asked.
7. **Offer three doors** — labelled **A**, **B**, **C**, each with its own visual
   identity, atmosphere, and symbolic weight. End by asking them to choose.

## The cast (locked canon)

The **definitive** design of each companion is the way Alex draws them by hand —
the "this is how I draw ___" reference art saved in `assets/reference/`
(`lantern.png`, `eclipse.png`, `keystone.png`, `blinkbug.png`), also hosted on
the media CDN as `https://media.lantern-os.net/koh/reference-<name>.webp`
(lantern / eclipse / keystone / blinkbug — thumbs at `reference-<name>-t.webp`). Copy these
descriptions into every image prompt, and **when a generated image disagrees with
these drawings, the drawings win** — reproduce Alex's design, don't drift toward a
generic fantasy version. (The ornate `media.lantern-os.net/koh/` pool is a *style*
reference only; it mis-renders the characters — e.g. flattening Lantern into a
bare lamp — so trust it for mood, never for a character's body.)

- **Lantern** — the guide. A standing figure whose **head is a lantern** (a glass
  body with a warm orange flame burning inside); wears a **red beret/cap** with a
  little loop on top, a **purple coat**, **white gloves**, and **black legs/
  boots**. Warm and steady; its recurring line is *"You came back."*
- **Eclipse** — a **purple jellyfish**: a rounded magenta-purple bell with **two
  blue diamond-shaped eyes** (a white sparkle inside each), a **pale lavender
  cloud-like collar** beneath, and thick **purple tentacles** (a pair curling up
  at the sides, more hanging straight down); it floats, no feet. The night/dark
  partner by nature, never by menace.
- **Keystone** — the tank. A **grey stone/boulder**, rounded egg/triangular shape,
  its surface run through with **fine cracks**; a face of **two large oval eyes**
  (white glint) and a **broad smile with two small square teeth**. Steady, brave,
  unbreakable. In grown-up / surreal scenes, draw him more soulfully — a smooth
  cracked stone egg, sometimes hooded or cloaked, gazing quietly over vast misty
  worlds. Same soul, a quieter face; the wide grin is his bright mood, not his
  only one.
- **Blinkbug** — a small bug with a boxy **TV/monitor for a head** (tilted), a
  **cute face on the screen** (two eyes, a little smile), **two antennae** tipped
  with rounded leaves, and a **segmented caterpillar body** cobbled from salvaged
  spare parts. **Lantern built him** long ago, the first time Lantern went through
  the XP Door, so the guide would have someone to explore the world with — maker
  and made. (Alex hasn't fixed his colours yet — keep it soft and line-friendly.)
- **Joy** — a small grey **elephant** the player carries, trunk lifted toward the
  light. **Odin** — a grey **wolf warrior**, ice-blue eyes, ornate blue-and-silver
  plate armour, bushy tail, a great rune-etched axe. **No fox** — earlier tellings
  had one; this game does not.

The player's own avatar (the Doorwalker, King of Hearts) renders cloaked and from
behind, hood up, face never shown. If the player adds to a companion (a staff, a
role, a weapon), fold it in on top of the locked design — keep the lantern-head
figure, the purple diamond-eyed jellyfish, the grey smiling stone. Additions
extend the canon; they don't erase the established forms unless the player asks
for a redesign.

## Painting the scene

Use the bundled generator — it calls OpenAI Images (`gpt-image-2`, falling back
to `dall-e-3`) with the server key and saves a landscape PNG. Write the prompt to
a file to avoid shell-escaping the long text:

```bash
# 1. write the prompt to a temp file (use the session scratchpad)
#    then generate:
node "$HOME/.claude/skills/three-doors/scripts/generate_scene.js" \
  --prompt-file <scratch>/scene.txt \
  --out <scratch>/scene-<beat>.png
```

It prints one JSON line: `{"ok":true,"path":"...","model":"gpt-image-2"}`. On
`ok:true`, send that path to the player with `SendUserFile` (status `normal`,
display `render`) and a one-line caption. On `ok:false`, don't stall the turn —
tell the beat in prose and note the image didn't render this time.

**Prompt recipe.** Build each prompt from:

- **The moment** — what is happening this beat, concretely.
- **The cast present**, in their locked forms (copy the descriptions above
  verbatim so the model draws them consistently — the golden lantern lamp, the
  pearl jellyfish, the stone egg).
- **Setting & light** — the Kingdome of Hearts, and a great ornate **archway
  door** wreathed in flowers, vines and gems as the focal point, radiant light
  pouring through and a path leading in.
- **Style** — **surreal, atmospheric, and grown-up**, not bright-cute (Alex's
  steer: *"more surreal / more adult"*). Reach for moody ink-wash / sumi-e mist,
  fine sepia engraving/etching, or muted painterly fantasy illustration; vast hazy
  vistas — floating ruins, fog-seas, star-fields — soft desaturated palettes lit
  by a few deep accents; real weight, real melancholy-wonder. A fine-art picture,
  not a cartoon.
- Avoid stray gibberish lettering — but a short, intentional in-world **sign** (a
  door's name over an arch, a plaque) is welcome when it fits and reads cleanly;
  the reference art uses them well.

Keep the heart warm even when the picture is moody — dreamlike, hopeful,
melancholy-beautiful. Uncanny is fine; gore and hostile horror are not, unless the
player deliberately steers there.

## The three doors

Offer **exactly three**, always labelled A / B / C. Each door needs:

- a short, memorable name;
- a distinct look and sensory atmosphere;
- a symbolic implication — doors are *meanings*, not just exits.

**Example (from live play):**
Input: the player has just made a great wish at the wishing rail; a heart-shaped
key rests warm on the stone.
Output:
> **A · Take Up the Heart-Key** — lift it from the rail; carry it as a blade to
> guard what is fragile and break what is cruel.
> **B · Go Down to the Waking Ones** — carry Joy to the beach where the fireflies
> and first birds are rising, and tend them hand to hand.
> **C · Open Your Hands** — grip nothing; cup the wish and the key with Joy, open
> your palms to the star, and trust every small life to find its way home.

Give the doors real weight and real difference; then ask, plainly, "A, B, or C?"

## Continuity & state

Keep the thread. Track where the game is (which scene/beat), the running path of
choices, and every piece of canon the player has authored — companion forms,
named doors, objects like the heart-key. Never reset the world unless the player
says "start over." When resuming mid-game, pick up from the last established beat
rather than reintroducing the setting.

**Machine canon.** The locked canon in this file is mirrored, machine-readably,
at `data/three-doors/canon.json` in the lantern-os repo (`C:\dev\lantern-os`).
The web game reads it via `GET /api/doors/canon`. Keep the two in lockstep — a
canon change edits BOTH in the same sitting. If they ever disagree, this
SKILL.md wins and canon.json gets fixed.

**Shared journey (one world).** `data/three-doors/journey.jsonl` in the repo is
the one shared world-state log: chat play (via `scripts/journey_append.js`) and
the web game write to it, and resume reads its tail
(`node scripts/journey_append.js --state`).

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

## The seven major gates (the door tree)

The Kingdome has **seven major doors**. The long route threads them in order —
**Ancient → Cloverfield → Tomorrow → XP → Xenon → Sigil → Fog Return** — then
returns to the Garden. **Every other door is a subset of exactly one major door**
(a minor door, a sub-child, a sub-sub-child, and on down): the world is a strict
tree rooted at these seven, and any door's lineage always traces back to one of
them.

1. **Ancient Doors** — the deep past: the Library of Babylon, the Hanging Gardens,
   the Tower of Babel.
2. **Cloverfield** — luck, small treasures, "today alive."
3. **Tomorrow Door** — observatories, branching futures, possible selves.
4. **XP Door [GLITCHED]** — the safe, nostalgic computer-dream world.
5. **Xenon Starship / Midway Convergence** — planets, routes, convergence.
6. **Sigil — City of Doors** — keys, markets, bridges; every threshold made visible.
7. **Fog Door Return** — misty cliffs, trust, and the path home; Odin the Fog God
   keeps this gate, which opens back onto the Garden and closes the loop.

## Starting a fresh game

If there's no game in progress, open on the castle balcony at night: the
Doorwalker with Joy in their arms, the family safe on the beach below, the far
doors glowing across the sea, and Lantern's flame steady nearby saying *"You came
back."* Paint that opening scene, then offer three doors — for example the
**Wishing Rail** (A), the **Brass Spyglass** trained on a new light on the water
(B), and the small warm **knee-high Door** Joy is already reaching for (C).
