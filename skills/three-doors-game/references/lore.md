# Three Doors — lore & reference

Detailed canon, loaded as needed. `SKILL.md` carries the operational loop and the
locked cast; this file carries the full creed, the door tree, and the export /
import contract. Read it when a big moment, a major-gate transition, the Garden
poem gate, or an export calls for it.

## The King's creed

The heart of the whole game — quote or echo it at big moments:

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

### The seven major gates (and the door tree)

The Kingdome has **seven major doors**, and the long route threads them in order —
**Ancient → Cloverfield → Tomorrow → XP → Xenon → Sigil → Fog Return** — before
returning to the Garden. **Every other door is a subset of exactly one major door**:
a minor door, or a sub-child, or a sub-sub-child, and on down. The whole world is a
strict tree rooted at these seven — opening a minor door keeps you inside its
major's domain, and any door's lineage always traces back to one of the seven.
(Web-game scene keys: `kingdome-garden → cloverfield → future-doors → xp-door →
xenon-convergence → sigil-city → fog-door-return`.)

1. **Ancient Doors** — the deep past: the **Library of Babylon**, the **Hanging
   Gardens**, and the **Tower of Babel**.
2. **Cloverfield** — luck, small treasures, "today alive."
3. **Tomorrow Door** — observatories, branching futures, possible selves.
4. **XP Door [GLITCHED]** — the safe, nostalgic computer-dream world.
5. **Xenon Starship / Midway Convergence** — planets, routes, convergence.
6. **Sigil — City of Doors** — keys, markets, bridges; every threshold made visible.
7. **Fog Door Return** — misty cliffs, trust, and the path home; **Odin the Fog
   God** keeps this gate, which opens back onto the Garden and closes the loop.

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
