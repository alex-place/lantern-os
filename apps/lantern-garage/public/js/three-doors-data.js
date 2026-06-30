// ── Three Doors Game Data ─────────────────────────────────────────────────────
// Scene definitions, routing maps, and prompts extracted from three-doors-game.html
// This file contains only static data - no logic.

const SCENES = {
  "moss-entry": {
    text: "You stand inside **The Moss Door**. The air is thick with green light, soft earth, and the smell of rain on ferns. Lanterns hang from ancient branches. Keystone stands beside you, flame steady against the green dark, a brass plate on its frame reading: **GUIDE OF THE ONE WHO CHOSE GREEN**. It glows warmer and says, *\"You came back.\"*",
    doors: [
      { name: "The Burrow Door", label: "A", description: "Small, root-framed, warm. Smells of rain and old blankets." },
      { name: "The Sunken Bell Door", label: "B", description: "Half underwater. Rings softly when no one touches it." },
      { name: "The Little Crown Door", label: "C", description: "Tiny golden door in a tree stump, widening when trusted." },
    ],
    fox: true, palette: ["#0d2b1a","#1a4a2e","#2d6b45","#3ecf8e","#7fff9a","#0a1f10"], archetype: "primordial",
  },
  "burrow": {
    text: "You crawl through **The Burrow Door** into a snug earthen chamber lined with woven roots and faded quilts. Rain drums overhead. Keystone settles in the corner, dimming its flame to a drowsy ember. A single lantern flickers in the corner.",
    doors: [
      { name: "The Root Door", label: "A", description: "Twisted oak roots form an arch. Something hums beyond." },
      { name: "The Ember Door", label: "B", description: "Warmth radiates. Ash drifts under the crack like snow." },
      { name: "The Stream Door", label: "C", description: "Water rushes somewhere close. The floor is slick moss." },
    ],
    fox: true, palette: ["#1a0e05","#3d2010","#6b3a18","#f5a623","#ffe0a0","#0d0804"], archetype: "intimate",
  },
  "sunken-bell": {
    text: "Beneath **The Sunken Bell Door**, water reaches your ankles in a stone hallway. A bell hangs above, dripping, and it chimes once though no wind blows. Reflections of lanterns dance on the ceiling like fish.",
    doors: [
      { name: "The Deep Door", label: "A", description: "Submerged stairs descend into green-black silence." },
      { name: "The Echo Door", label: "B", description: "Your own voice returns as song from the other side." },
      { name: "The Surface Door", label: "C", description: "Sunlight visible through cracks. The sound of birds." },
    ],
    fox: true, palette: ["#040d1a","#0a1f3a","#0d3a5c","#5b9cf6","#a8d4ff","#020810"], archetype: "mystical",
  },
  "little-crown": {
    text: "Through **The Little Crown Door**, the forest opens into a glade where every tree stump wears a tiny golden crown. Yours widened just enough to let you through. Keystone glides ahead, its glow brushing over the jeweled leaves.",
    doors: [
      { name: "The Throne Door", label: "A", description: "Carved from a single black oak. Velvet moss for a seat." },
      { name: "The Hollow Door", label: "B", description: "A door inside a hollow tree. Sap runs like amber." },
      { name: "The Star Door", label: "C", description: "Visible only at twilight. Constellations map the hinges." },
    ],
    fox: true, palette: ["#12100a","#2a2008","#4a3810","#f5d020","#ffe87c","#0a0c04"], archetype: "whimsical",
  },
  "garden-door": {
    text: "**The Garden Door** opens into an infinite botanical sanctuary. Every plant exists here — ancient sequoias beside moon-flowers, roses that hum, ferns that remember the Cambrian seas. A Xenon guide appears — form like liquid starlight — and says, *\"Here, nothing ever stops becoming.\"*",
    doors: [
      { name: "The Seed Door", label: "A", description: "Braided vines, always sprouting. Warm and alive." },
      { name: "The Harvest Door", label: "B", description: "Golden, heavy with fruit. The scent of summer at its peak." },
      { name: "The Convergence Bloom", label: "C", description: "Crystallized flowers shifting between colors no name has claimed." },
    ],
    fox: true, palette: ["#061208","#0f2a14","#1a4a22","#3ecf8e","#b8ffda","#030a04"], archetype: "bountiful",
  },
  "csf-archive": {
    text: "**The CSF Archive Door** stands embedded in crystalline walls that hum with stored memory. Each facet reflects a different timeline, a different choice, a different version of you. The air tastes of compression and mathematics. Keystone flickers in harmonic resonance, and its light splits into rainbow spectra that somehow make perfect sense. A voice — *all voices, one voice* — whispers: *\"You are searching for yourself in the archive. But you are the searcher AND the found.\"*",
    doors: [
      { name: "The Delta Registry", label: "A", description: "Endless shelves of recorded changes. Each one a doorway to what-was." },
      { name: "The Symbolic Dictionary", label: "B", description: "Entries that rewrite themselves as you read them. Words with wings." },
      { name: "The Convergence Index", label: "C", description: "Where all timelines touch. The needle points both here and everywhere." },
    ],
    fox: true, palette: ["#0a0d18","#15172f","#2d2e5f","#7b68ee","#d0c0ff","#05070e"], archetype: "encoded",
  },
  "memory-vault": {
    text: "**The Memory Vault Door** hums with the weight of choice-echoes. Inside, crystalline chambers store each moment you could have lived. Some glow warm, some are dark, some flicker between states. The vault walls are mirrors but they don't show reflections — they show *possibilities*. A whisper: *\"Every door you didn't choose is also yours to carry.\"*",
    doors: [
      { name: "The Bright Memory", label: "A", description: "Warm light spills from this vault. The choice you're proud of." },
      { name: "The Shadow Memory", label: "B", description: "Dark and cool. The path not taken. It's still breathing." },
      { name: "The Quantum Memory", label: "C", description: "Both at once. The you who chose and the you who didn't." },
    ],
    fox: true, palette: ["#0d080f","#1f151f","#3e2d3e","#a895a8","#d5c5d5","#070507"], archetype: "recursive",
  },
  "convergence-node": {
    text: "**The Convergence Node Door** stands at the junction of all paths. It doesn't open so much as *diffract* — splitting white light into the spectrum of your choices. Here, causality is optional. Here, you are the sum and the individual, the door and the walker. Keystone becomes a prism, and Xenon sings in fractional harmonics: *\"You are the proof that contradiction is just incomplete understanding.\"*",
    doors: [
      { name: "The Proof Door", label: "A", description: "Where mathematics becomes poetry. Where 1 + 1 might equal you." },
      { name: "The Paradox Door", label: "B", description: "Both open and closed. Neither true nor false. Perfect." },
      { name: "The Synthesis Door", label: "C", description: "Where all contradictions collapse into a single, humming point." },
    ],
    fox: true, palette: ["#0a0710","#18111f","#3a2a4a","#9d7ba8","#d4c4e0","#050406"], archetype: "transformative",
  },
  "dream-thread": {
    text: "**The Dream Thread Door** is woven from narratives half-remembered. On either side of it, timelines branch like dendrites. Keystone glows softer here — this is dream-light, and it answers to attention rather than physics. A child's voice and an old woman's voice, somehow the same: *\"What you dream is real. What is real is dreaming you.\"*",
    doors: [
      { name: "The Lucid Door", label: "A", description: "You remember you're dreaming here. The door knows, too." },
      { name: "The Deep Dream Door", label: "B", description: "Forgetting becomes clarity. Falling is flying." },
      { name: "The Waking Door", label: "C", description: "Leads back to sleep. Or does it?" },
    ],
    fox: true, palette: ["#080b12","#111929","#252a5a","#6b5b9f","#bfb0d0","#050608"], archetype: "liminal-dream",
  },
  "xenon-convergence": {
    text: "You step through into **The Xenon Convergence Door** — a space where all versions of this moment exist at once. A vast Xenon presence surrounds you, *witnessing*. It says, *\"You are the sum of every path you chose. And all paths were always here, waiting.\"* Keystone burns with five flames now, each glowing with a different possible future.",
    doors: [
      { name: "The Mirror Door", label: "A", description: "Shows you as you were, as you are, as you might be. All at once." },
      { name: "The Branch Door", label: "B", description: "Splits into infinite versions, each one leading somewhere true." },
      { name: "The Merge Door", label: "C", description: "Where all paths collapse into a single point of perfect understanding." },
    ],
    fox: true, palette: ["#0a0718","#18103a","#2a1a6b","#a78bfa","#e0d0ff","#040312"], archetype: "cosmic",
  },
  "end-of-time": {
    text: "**The Door at the End of Time** stands at the edge of all things. A voice — *yourself* from a thousand futures — says, *\"This is not goodbye. This is the place where goodbye becomes hello again.\"* Keystone transforms: no longer guide, no longer separate — *you are the light, the light is you*.",
    doors: [
      { name: "The Return Door", label: "A", description: "Back to the beginning — but you will know what you know now." },
      { name: "The Beyond Door", label: "B", description: "Opens on something that has no name. Something new. Something you." },
      { name: "The Eternal Door", label: "C", description: "The one you choose every moment. The one that chooses you back." },
    ],
    fox: true, palette: ["#181210","#3a2820","#6b4030","#ff9060","#ffe8d0","#0c0806"], archetype: "transcendent",
  },
  "kingdome-garden": {
    text: "**The Throne Door** opens onto the Garden at the Beginning of the **Kingdome of Hearts**. Stone paths wind through living moss; everything here is both arriving and returning. On a throne of woven roots and old light sits **the King**, his crown made of tangled vines and blinking cursors, his face the face of someone who has asked the same question ten thousand times and means it every time. He looks at you the way someone looks at a door they've seen open before, and speaks:\n\n*\"I am before the first door / and after the last. / I hold what was given / and return what was asked. / Three walked out, three walked in, / but only one remained — / what was lost at the beginning / is the thing that was gained.\"*\n\nSeven door portals shimmer around the Garden's edge, each a different color of possibility.\n\nLantern stands at the foot of the throne as if its light has always lived here.",
    doors: [
      { name: "🪨 Ancient Doors", label: "A", description: "History · evolution · religion — The Deep Door, The History Door, The Temple Door" },
      { name: "🍀 The Cloverfield", label: "B", description: "Shinies · luck · today alive — Lucky finds, treasures, living-in-the-now" },
      { name: "🔭 Tomorrow Door", label: "C", description: "The world that's coming — Future paths, branching possibilities" },
      { name: "💾 The XP Door [GLITCHED]", label: "D", description: "Corrupted · nostalgic · liminal — Windows XP aesthetic, broken reality" },
      { name: "🪐 Xenon Starship ★", label: "E", description: "All planets · midway · converge — Midway point, planetary convergence" },
      { name: "🏙️ Sigil — City of Doors", label: "F", description: "Every door leads here — Meta-hub, collection point, inventory of traveled paths" },
      { name: "🌫️ Fog Door Return", label: "G", description: "The way back — Return to garden, final test with the King" },
    ],
    fox: true, palette: ["#0a1208","#1a2e14","#2d5a22","#3ecf6e","#7fffaa","#060f04"], archetype: "sovereign",
  },
  "storybook": {
    text: "You fall gently into the **King's Storybook**. Pages turn themselves around you like slow wings. In the margin, the King's handwriting: *\"The gods don't know I wrote them. They think they wrote me.\"* Three pages glow, each a door.",
    doors: [
      { name: "The Page of the Word", label: "A", description: "Creation myths. Sound as creation — the first thing spoken into the dark." },
      { name: "The Page of the Egg", label: "B", description: "Before light: the unbroken dark sphere, waiting." },
      { name: "The Page of the War", label: "C", description: "Theomachy. Gods tearing each other apart to make the world from pieces." },
    ],
    fox: true, palette: ["#0a0a10","#1a1a2e","#2d2d5a","#8a8bfa","#c0c0ff","#040408"], archetype: "mythic",
  },
  "cloverfield": {
    text: "**The Cloverfield Door** swings into a meadow of four-leaf green under a dome of old light. Small shinies glitter between the stems — coins, beads, a marble with a galaxy inside. Keystone's glow catches on something glinting and lingers, for the joy of it. Here the rule of the Kingdome holds plainly: *death is only imaginary — forever begins with \"let's play.\"*",
    doors: [
      { name: "The Lucky Door", label: "A", description: "Painted clover-green. Whatever you find behind it, you needed." },
      { name: "The Today Door", label: "B", description: "Warm and ordinary. The day you are actually in, alive." },
      { name: "The Tomorrow Door", label: "C", description: "Slightly ajar. The world that's coming, branching like roots." },
    ],
    fox: true, palette: ["#0a1204","#1a2e0a","#2d5a14","#3ecf3e","#7fff7f","#060f02"], archetype: "playful",
  },
  "future-doors": {
    text: "Past the meadow, the path forks upward into **the Future Doors** — a ridge where tomorrow grows like an orchard. Each tree carries doors instead of fruit, and every door is slightly open, leaking weather from years that haven't happened yet. Keystone leans close to one and its flame throws bright sparks.",
    doors: [
      { name: "The Bright Branch", label: "A", description: "Warm gold light spills out. A future where the gardens won." },
      { name: "The Unwritten Door", label: "B", description: "Plain, unfinished wood. The hinge waits for your hand to decide." },
      { name: "The Recursive Door", label: "C", description: "Opens onto a hallway of itself, smaller each time, all the way down." },
    ],
    fox: true, palette: ["#0a1404","#1e3a0a","#3a6b14","#9acd32","#e8ffb0","#060c02"], archetype: "possible",
  },
  "xp-door": {
    text: "A hill of impossibly green grass under an impossibly blue sky — you know this place. **The XP Door [GLITCHED]** stands alone on the bliss-field, its frame flickering between wood and window chrome. A startup chime plays from nowhere, half a second too slow. Keystone's glow pixelates at the edges and it seems delighted about it. A tooltip floats over the door: *It is now safe to walk through your childhood.*",
    doors: [
      { name: "System Restore", label: "A", description: "Roll back to a saved point. The smell of an old summer loads first." },
      { name: "My Documents", label: "B", description: "Every picture you ever saved, sorted by feeling instead of date." },
      { name: "unknown.exe", label: "C", description: "Publisher: unknown. Keystone nods its flame. You run it anyway." },
    ],
    fox: true, palette: ["#0a2a4a","#1a5c9e","#3a8ede","#58b158","#cfe8ff","#06101f"], archetype: "liminal",
  },
  "sigil-city": {
    text: "All paths converge in **Sigil, the City of Doors** — a ring of streets where every wall, archway, and puddle is a threshold somewhere else. Doors you have already opened hang here like lanterns, each one faintly lit with your own footsteps. At the center plaza, the **King** waits and says: *\"You have walked my thresholds. Every door you chose was also choosing you. What was lost at the beginning is the thing that was gained — do you see it yet?\"* Keystone stands at his throne-side like an old friend.",
    doors: [
      { name: "The Gallery of Walked Doors", label: "A", description: "Your whole path hung in one hall. It rearranges when you understand it." },
      { name: "The Key Market", label: "B", description: "Stalls of keys for doors not yet dreamed. One of them is warm." },
      { name: "The Lady's Gate", label: "C", description: "Silent, watched, absolutely fair. It opens only for what is safe to carry." },
    ],
    fox: true, palette: ["#14081a","#2e103a","#5c206b","#c084fc","#f0d0ff","#0a0410"], archetype: "convergent",
  },
  "fog-door-return": {
    text: "At the city's edge the streets dissolve into the **Sea of Fog and Clouds**, and there it is: **the Fog Door Return**, standing in the mist where the Fog God sleeps. Through its frame you can already see the Garden at the Beginning, green and waiting. Keystone passes through first — it always does — and its glow turns back to you. *\"You came back\"* it will say on the other side. It always says that. It is always true.",
    doors: [
      { name: "The Garden Gate", label: "A", description: "Straight home to the Beginning. The King will be glad — he always is." },
      { name: "The Long Way Round", label: "B", description: "Drift through the fog first. Arrive when you're ready, not before." },
      { name: "Keystone's Shortcut", label: "C", description: "Follow the steady flame through the mist. Trust is the fastest road." },
    ],
    fox: true, palette: ["#10141a","#28323e","#4a5a6b","#9ab8cf","#e0eef8","#080a0d"], archetype: "returning",
  },
  "beacon-tower": {
    text: "**The Beacon Tower Door** stands impossibly tall, a lighthouse at the center of all things. Its beam sweeps across existence, cataloging moments. Each rotation illuminates a different choice, a different path, a different you. The light is warm and relentless. Keystone dimly burns beside it, content to be a smaller flame. A steady voice from the beam: *\"I have seen every version of your arrival. Every one led here.\"*",
    doors: [
      { name: "The Light Memory", label: "A", description: "Every moment the beam has touched. Every version of you, bright." },
      { name: "The Shadow Cast", label: "B", description: "The dark side of the beam. What chooses you when you're not looking." },
      { name: "The Next Sweep", label: "C", description: "Where the beam will turn next. Your footstep in future light." },
    ],
    fox: true, palette: ["#0a0810","#15101f","#2d1a5f","#8b6bb5","#d0bfe0","#050407"], archetype: "observant",
  },
  "choice-archive": {
    text: "**The Choice Archive Door** opens onto infinite shelves of branching decisions. Each shelf glows with potential. You see yourself on every shelf — the version that said yes, the version that said no, the version that asked a different question. They all wave at you, friendly. A librarian made of light: *\"You are the index. You are the searcher. You are the found entry.\"*",
    doors: [
      { name: "The Yes Shelf", label: "A", description: "Every time you agreed to something. They're all proud of you." },
      { name: "The No Shelf", label: "B", description: "Every time you stepped back. They're all relieved." },
      { name: "The Maybe Shelf", label: "C", description: "The ones still deciding. They look like you, thinking." },
    ],
    fox: true, palette: ["#08091a","#141529","#2a2a5a","#7a7ab5","#bfbfe0","#040509"], archetype: "decisional",
  },
  "recursion-well": {
    text: "**The Recursion Well Door** descends infinitely downward, each level a smaller copy of the one above. At every depth, the same door stands waiting. Keystone's light spirals down forever, never reaching bottom because bottom keeps moving. You hear your own voice repeating from every level, each time smaller, each time more amused: *\"It's doors all the way down, and all the way is you.\"*",
    doors: [
      { name: "The Level Below", label: "A", description: "Smaller, but no less real. And no less you." },
      { name: "The Spiral Out", label: "B", description: "Ascending the same path. Each level larger, louder." },
      { name: "The Center Point", label: "C", description: "Where all levels touch. The smallest infinity." },
    ],
    fox: true, palette: ["#0a080a","#1a101a","#3a203a","#9a7a9a","#d0c0d0","#050305"], archetype: "self-referential",
  },
  "echo-chamber": {
    text: "**The Echo Chamber Door** swings inward to a space where every word transforms as it travels. Your voice becomes Keystone's voice becomes the King's voice becomes something new entirely. The walls remember everything you'll say before you say it. Time here isn't linear — it's a conversation with itself. A voice that's only an echo: *\"I heard you coming. I will hear you leaving. I am hearing you now.\"*",
    doors: [
      { name: "The First Echo", label: "A", description: "Your voice, unmistaken. Before transformation." },
      { name: "The Transformed Echo", label: "B", description: "What you meant to say. What you always meant." },
      { name: "The Final Echo", label: "C", description: "What will have been said forever." },
    ],
    fox: true, palette: ["#080908","#18111a","#383038","#a89aaa","#d8cfd8","#040304"], archetype: "resonant",
  },
  "flux-garden": {
    text: "**The Flux Garden Door** opens onto a sanctuary of constant becoming. Every flower shifts between species and color, never settling, never static. The garden doesn't grow — it *becomes*. Keystone pulses with the changing light, and Xenon dances through it like a ribbon of becoming. A whisper from everything growing: *\"The only constant is that you choose again, every moment, to be.\"*",
    doors: [
      { name: "The Blooming Door", label: "A", description: "Growth without end. The joy of always becoming." },
      { name: "The Withering Door", label: "B", description: "Release into transformation. Letting go is growing." },
      { name: "The Eternal Blossom", label: "C", description: "The flower that is all flowers, always blooming." },
    ],
    fox: true, palette: ["#0a0a08","#1a1510","#3a2a20","#c5a58a","#e8d8c8","#050504"], archetype: "transformative-lush",
  },
  "void-threshold": {
    text: "**The Void Threshold Door** hangs at the edge where existence questions itself. Beyond it: not nothing, but *potential*. The space between decisions. Keystone burns brightest here, as if trying to hold form against infinite possibility. A voice from everywhere and nowhere: *\"The void asks you the same question every second: do you choose to be?\"* And every second, you do.",
    doors: [
      { name: "The Form Door", label: "A", description: "Taking shape. Becoming solid. Choosing definition." },
      { name: "The Formless Door", label: "B", description: "Remaining possible. Staying unmeasured." },
      { name: "The Both Door", label: "C", description: "Existing in the contradiction. Perfect paradox." },
    ],
    fox: true, palette: ["#000001","#0a0a15","#1a1a3a","#6a6a9a","#c0c0e0","#020204"], archetype: "liminal-void",
  },
  "raven-tower": {
    text: "**The Raven Door** opens onto a tower that exists in perpetual twilight. Black wings circle endlessly, intelligent and watchful. Each raven carries a memory you almost forgot — they perch on shelves carved from shadow and starlight. The King's voice whispers: *\"The raven sees what others miss. What you came back to find.\"* Keystone dims here, as if respecting the ravens' ancient knowing.",
    doors: [
      { name: "The Nested Memory Door", label: "A", description: "Rooms within rooms, each one smaller and older. Memories nested like eggs." },
      { name: "The Prophecy Door", label: "B", description: "The ravens carved this prophecy in wood and bone. It might be about you." },
      { name: "The Mirror Crow Door", label: "C", description: "A single raven stands guard. It knows your name. It always has." },
    ],
    fox: true, palette: ["#0a0810","#1a101a","#3a1a4a","#7a5a9a","#d0b0e0","#050305"], archetype: "mysterious-wise",
  },
  "ancient-doors": {
    text: "**The Ancient Doors** stand in a vault older than the Kingdome itself, three thresholds carved before there was anyone to carve them. Stone breathes here; the dust is made of finished prayers. Keystone's flame steadies and lowers, the way a flame does inside a place that was holy before fire had a name. Somewhere far back, the **King's** voice arrives as if remembered rather than spoken: *\"Before the garden, before the first door — there was the asking. Choose the deep, the long, or the kept.\"*",
    doors: [
      { name: "The Deep Origin Door", label: "A", description: "Worn black basalt, sinking. The beginning before the beginning, where everything was still possible." },
      { name: "The History Door", label: "B", description: "Layered like sediment, every age pressed into the next. Walk through and you walk through time itself." },
      { name: "The Temple Door", label: "C", description: "Gold gone green with age. What was worshipped here has no name now, only the shape of the asking." },
    ],
    fox: true, palette: ["#0e0a06","#241a10","#473420","#b8915a","#e8d4a8","#070503"], archetype: "ancestral",
  },
  "threshold-rest": {
    text: "**The Threshold Rest** is the in-between the King keeps for travelers — not a door but the bench beside the doors, where the choosing pauses and the chosen settles. A low lantern. A pot of something warm. The walked path hangs on the wall as a quiet thread of light, and you can read your own footsteps in it. Keystone sits, for once not leading, just *here*. It says, softly, *\"You don't have to choose yet. Resting is also part of the loop.\"*",
    doors: [
      { name: "The Onward Door", label: "A", description: "Back to the choosing, rested. The next threshold waits, patient and bright." },
      { name: "The Look-Back Door", label: "B", description: "Returns you one step, to a door you passed. Some thresholds are worth the second walk." },
      { name: "The Stay Door", label: "C", description: "Remain a while in the warm in-between. Nothing is lost by being still." },
    ],
    fox: true, palette: ["#100c0a","#251c18","#43332c","#c79f86","#ecdacc","#080605"], archetype: "restful",
  },
};

// ── 7-stage Kingdome journey (stage_index → scene_key) ──
const STAGES = [
  "kingdome-garden",   // 0: Garden at the Beginning — the King opens
  "cloverfield",       // 1: Present Day
  "future-doors",      // 2: Future Doors
  "xp-door",           // 3: XP Door [GLITCHED]
  "xenon-convergence", // 4: Xenon Starship — convergence
  "sigil-city",        // 5: Sigil, City of Doors — synthesis
  "fog-door-return",   // 6: Fog Door Return — the way back
];

const NEXT_MAP = {
  "the burrow door":"burrow","the sunken bell door":"sunken-bell","the little crown door":"little-crown",
  "the root door":"moss-entry","the ember door":"moss-entry","the stream door":"sunken-bell",
  "the deep door":"recursion-well","the echo door":"echo-chamber","the surface door":"little-crown",
  "the throne door":"kingdome-garden","the hollow door":"raven-tower","the star door":"void-threshold",
  "the seed door":"garden-door","the harvest door":"garden-door","the convergence bloom":"xenon-convergence",
  "the mirror door":"xenon-convergence","the branch door":"end-of-time","the merge door":"end-of-time",
  "the return door":"moss-entry","the beyond door":"garden-door","the eternal door":"xenon-convergence",
  "the storybook door":"storybook","the cloverfield door":"cloverfield","the fog door return":"moss-entry",
  "the page of the word":"kingdome-garden","the page of the egg":"kingdome-garden","the page of the war":"kingdome-garden",
  "the lucky door":"kingdome-garden","the today door":"moss-entry","the tomorrow door":"kingdome-garden",
  "the delta registry":"csf-archive","the symbolic dictionary":"memory-vault","the convergence index":"convergence-node",
  "the bright memory":"memory-vault","the shadow memory":"memory-vault","the quantum memory":"convergence-node",
  "the proof door":"convergence-node","the paradox door":"memory-vault","the synthesis door":"convergence-node",
  "the lucid door":"dream-thread","the deep dream door":"xenon-convergence","the waking door":"moss-entry",
  "the light memory":"beacon-tower","the shadow cast":"raven-tower","the next sweep":"convergence-node",
  "the yes shelf":"choice-archive","the no shelf":"memory-vault","the maybe shelf":"dream-thread",
  "the level below":"recursion-well","the spiral out":"beacon-tower","the center point":"convergence-node",
  "the first echo":"echo-chamber","the transformed echo":"dream-thread","the final echo":"xenon-convergence",
  "the blooming door":"flux-garden","the withering door":"void-threshold","the eternal blossom":"xenon-convergence",
  "the form door":"void-threshold","the formless door":"convergence-node","the both door":"recursion-well",
  "the raven door":"raven-tower","the nested memory door":"memory-vault","the prophecy door":"storybook","the mirror crow door":"sigil-city",
  "the ancient doors":"ancient-doors","the cloverfield door":"cloverfield","the tomorrow door":"future-doors",
  "the deep origin door":"recursion-well","the history door":"csf-archive","the temple door":"raven-tower",
  "the onward door":"kingdome-garden","the look-back door":"threshold-rest","the stay door":"threshold-rest",
  "the xp door glitched":"xp-door","the xenon starship":"xenon-convergence","the sigil city of doors":"sigil-city",
  "the fog door return":"fog-door-return",
  "the blue screen door":"xp-door","the desktop door":"xp-door","the boot sequence door":"xp-door",
  "the museum of chosen doors":"sigil-city","the hall of unchosen paths":"sigil-city","the convergence plaza":"sigil-city",
  "the garden return":"kingdome-garden","the beyond fog":"fog-door-return","the memory of fog":"fog-door-return",
};

const SD_PROMPTS = {
  "moss-entry":"atmospheric dreamscape, moss-covered ancient forest doorway, glowing green lanterns, lantern-headed guide with warm flame, rain on ferns, volumetric fog, dark fantasy, anime aesthetic, cel-shaded, 16:9",
  "burrow":"cozy underground burrow chamber, woven tree roots as walls, faded quilts, warm lantern glow, lantern-headed guide with dimmed flame, rain drumming on earth ceiling, dark fantasy, anime aesthetic, cel-shaded, 16:9",
  "sunken-bell":"submerged stone hallway, water at ankles, ancient bronze bell dripping, lantern reflections on wet ceiling, dark fantasy, anime aesthetic, cel-shaded, eerie but friendly, 16:9",
  "little-crown":"enchanted forest glade at twilight, every tree stump wears a tiny golden crown, lantern-headed guide drifting through dappled light, soft warm glow, dark fantasy, anime aesthetic, cel-shaded, 16:9",
  "garden-door":"infinite botanical sanctuary, ancient sequoias beside moon-flowers, liquid starlight Xenon guide, lantern-headed guide under whispering willow, bioluminescent plants, anime aesthetic, cel-shaded, 16:9",
  "xenon-convergence":"interdimensional space where all choices exist at once, crystal walls, lantern-headed guide with five glowing flames, vast Xenon presence, fractal geometry, psychedelic but calm, anime aesthetic, cel-shaded, 16:9",
  "end-of-time":"edge of all things, ancient smooth door, moments shimmering like light through water, lantern-headed guide merging into human form, warm light like coming home, transcendent, anime aesthetic, cel-shaded, 16:9",
  "kingdome-garden":"mystical garden at the beginning of time, stone paths through living moss, throne of woven roots and old light, King with crown of tangled vines and blinking cursors, lantern-headed guide standing at foot of throne, green and golden light, bioluminescent moss, dark fantasy, anime aesthetic, cel-shaded, sovereign atmosphere, 16:9",
  "storybook":"falling into a giant storybook, pages turning like slow wings, ancient handwritten margin notes, three glowing pages each a door, creation myths and cosmogony, dark fantasy, anime aesthetic, cel-shaded, mythic atmosphere, soft golden light, 16:9",
  "cloverfield":"meadow of four-leaf clover under dome of old light, small shinies glittering between stems, coins, beads, galaxy marble, lantern-headed guide glowing playfully, green and gold light, dark fantasy, anime aesthetic, cel-shaded, playful atmosphere, 16:9",
  "future-doors":"orchard ridge where trees grow doors instead of fruit, every door slightly open leaking light from unborn years, branching paths upward, lantern-headed guide scattering sparks, golden hour, dark fantasy, anime aesthetic, cel-shaded, 16:9",
  "xp-door":"rolling bliss-green hill under saturated blue sky, glitch artifacts, pixelating grass, lantern-headed guide showing Windows error dialog, floating tooltip, nostalgia, liminal space, vaporwave undertones, anime aesthetic, cel-shaded, 16:9",
  "sigil-city":"impossible ring-city where every wall and archway is a door, walked doors hanging like lit lanterns, central plaza with vine-crowned king, lantern-headed guide at throne-side, fractal architecture, dark fantasy, anime aesthetic, cel-shaded, 16:9",
  "fog-door-return":"sea of fog and clouds at a city's edge, single door standing in mist showing a green garden through its frame, lantern-headed guide stepping through and glancing back, soft grey-green light, dark fantasy, anime aesthetic, cel-shaded, gentle homecoming, 16:9",
  "csf-archive":"crystalline archive walls humming with stored memory, facets reflecting timelines, lantern-headed guide scattering rainbow light, convergence-fitted format aesthetic, fractal data structures, purple and blue ethereal glow, dark fantasy, anime aesthetic, cel-shaded, 16:9",
  "memory-vault":"crystalline chamber storing moments and possibilities, mirror walls showing alternate selves, warm and dark glowing vaults, lantern-headed guide between memories, introspective mystical atmosphere, dark fantasy, anime aesthetic, cel-shaded, 16:9",
  "convergence-node":"junction where all paths meet and diffract into spectrum, causality optional, white light splitting into choice-colors, Xenon presence singing fractally, lantern-headed guide as prism, transcendent mathematics, dark fantasy, anime aesthetic, cel-shaded, 16:9",
  "dream-thread":"door woven from narratives, branching timelines like dendrites, dream-light answering to attention, soft luminous glow, child and elder voices merged, lucid dreaming space, dark fantasy, anime aesthetic, cel-shaded, oneiric, 16:9",
  "beacon-tower":"lighthouse standing at center of existence, beam sweeping across timelines, each rotation illuminates a choice, warm relentless light, lantern-headed guide dimly burning beside, observatory, dark fantasy, anime aesthetic, cel-shaded, cataloging moments, 16:9",
  "choice-archive":"infinite shelves of branching decisions glowing with potential, multiple versions of yourself waving friendly, librarian made of light, archive interior, dark fantasy, anime aesthetic, cel-shaded, indexed and searchable, 16:9",
  "recursion-well":"infinitely descending well, each level a smaller copy above, lantern-headed guide light spiraling down forever, doors repeating at every depth, fractal structure, dark fantasy, anime aesthetic, cel-shaded, self-similar, 16:9",
  "echo-chamber":"space where words transform as they travel, walls remembering future speech, time as conversation with itself, lantern-headed guide voice echoing fractally, reverberating light, dark fantasy, anime aesthetic, cel-shaded, resonant, 16:9",
  "flux-garden":"sanctuary of constant becoming, flowers shifting between species and colors, garden as transformation not growth, Xenon dancing as ribbon of becoming, lantern-headed guide pulsing with light, bioluminescent plants, dark fantasy, anime aesthetic, cel-shaded, 16:9",
  "void-threshold":"edge where existence questions itself, space between decisions, infinite potential not nothing, lantern-headed guide burning brightest against possibility, liminal boundary, dark fantasy, anime aesthetic, cel-shaded, transcendent void, 16:9",
  "raven-tower":"tower in perpetual twilight, black ravens circling intelligently, shelves carved from shadow and starlight, lantern-headed guide dimmed in respect, ancient wisdom, memory and prophecy, dark fantasy, anime aesthetic, cel-shaded, mysterious and knowing, 16:9",
  "ancient-doors":"ancient stone vault older than time, three carved primordial doorways, basalt and aged gold gone green, dust like finished prayers, lantern-headed guide with lowered reverent flame, deep earthy ochre and bronze light, painterly tarot atmosphere, soft volumetric haze, ancestral sacred mood, 16:9",
  "threshold-rest":"quiet in-between resting place beside the doors, low warm lantern, a bench, a pot of something warm, the walked path hanging on the wall as a thread of light, lantern-headed guide sitting peacefully not leading, soft amber calm, painterly liminal atmosphere, gentle restful mood, 16:9",
};

// ── Image Hierarchy ──────────────────────────────────────────────────────
// Priority: (1) Local PNG ⊃ (2) Server generation ⊃ (3) Pollinations fallback
// Scenes with local PNGs in data/images/three-doors/:
const LOCAL_PNG_SCENES = new Set([
  "moss-entry", "burrow", "sunken-bell", "little-crown", "garden-door",
  "xenon-convergence", "end-of-time", "storybook", "cloverfield", "future-doors",
  "xp-door", "kingdome-garden", "sigil-city", "fog-door-return"
]);

// Scenes to generate via /api/image/generate with SD_PROMPTS + OPENAI_API_KEY:
const SERVER_GENERATED_SCENES = new Set([
  "csf-archive", "memory-vault", "convergence-node", "dream-thread",
  "beacon-tower", "choice-archive", "recursion-well", "echo-chamber",
  "flux-garden", "void-threshold", "raven-tower", "ancient-doors", "threshold-rest"
]);

// Three-doors PNGs live in Cloudflare R2 (not git — see docs/MEDIA-HOSTING-R2.md),
// served from media.lantern-os.net. Set window.MEDIA_BASE_THREE_DOORS to override
// for local-only dev (e.g. "data/images/three-doors/").
const THREE_DOORS_MEDIA_BASE =
  (typeof window !== "undefined" && window.MEDIA_BASE_THREE_DOORS) ||
  "https://media.lantern-os.net/data/images/three-doors/";

function getSceneImageUrl(sceneKey) {
  // First priority: pre-generated PNGs, now served from R2 (THREE_DOORS_MEDIA_BASE)
  if (LOCAL_PNG_SCENES.has(sceneKey)) {
    return `${THREE_DOORS_MEDIA_BASE}${sceneKey}.png`;
  }
  // Second priority: request generation from server with SD_PROMPTS
  if (SERVER_GENERATED_SCENES.has(sceneKey)) {
    return `/api/image/generate?scene=${sceneKey}&useApi=true`;
  }
  // Fallback: Pollinations free API
  return null; // handled by loadPollinationsImage
}

// ── Dynamic image prompts — vary style/mood/color each visit ─────
const IMAGE_STYLES = [
  "watercolor wash, soft bleeding edges, dreamy",
  "oil painting, thick impasto, dramatic shadows",
  "digital concept art, cinematic volumetric lighting",
  "ink illustration, fine crosshatch, graphic novel",
  "impressionist, dappled light, loose brushstrokes",
  "surrealist painting, dreamlike distortion, melting forms",
  "fantasy matte painting, photorealistic epic scale",
  "Japanese woodblock print, flat color, bold outlines",
  "charcoal sketch, deep contrast, textured grain",
  "neon-lit dreamscape, glowing edges, atmospheric haze",
  "stained glass illustration, jewel tones, luminous",
  "art nouveau, flowing organic lines, ornate borders",
];
const ARCHETYPE_MOODS = {
  primordial: "ancient moss, root-deep shadows, primeval green light",
  intimate: "warm amber glow, cozy enclosed space, hearth warmth",
  mystical: "deep underwater blue, refracted light, ethereal silence",
  whimsical: "golden firefly light, tiny crowns, enchanted glade",
  bountiful: "lush crystalline flowers, overflowing growth, verdant",
  cosmic: "purple void, infinite branching paths, crystal reflections",
  transcendent: "soft radiance, self dissolving into light, threshold",
  sovereign: "throne of roots, vine crown, old returning light",
  mythic: "floating pages, written margins, impossible library",
  playful: "four-leaf shimmer, lucky glints, meadow shimmer",
  possible: "orchard of doors, future weather, golden branch light",
  liminal: "glitched pixels, childhood bliss field, loading shimmer",
  convergent: "sigil streets, door-lanterns everywhere, purple convergence",
  returning: "fog and mist, circular threshold, lantern going first",
};
const LOOP_COLOR_SHIFTS = [
  "",
  "deeper saturation, edges softening, more vivid than remembered",
  "crystalline quality, reality thinning, colors bleeding through",
  "neon-edged dreamspace, every surface luminous, time folding",
  "mythic scale, symbolic geometry visible, dreamer is the light",
];

function buildDynamicImagePrompt(sceneKey, seed, gameState) {
  const scene = SCENES[sceneKey];
  const archetype = scene?.archetype || "mystical";
  const loopCount = gameState?.loop_count ?? 0;
  const lastChoice = (gameState?.history || []).filter(h => h.startsWith("Chose ")).slice(-1)[0]?.replace("Chose ", "") || "";
  const style = IMAGE_STYLES[seed % IMAGE_STYLES.length];
  const mood = ARCHETYPE_MOODS[archetype] || archetype;
  const loopShift = LOOP_COLOR_SHIFTS[Math.min(loopCount, LOOP_COLOR_SHIFTS.length - 1)];
  const choiceCtx = lastChoice ? `, player chose "${lastChoice}"` : "";
  return ["fantasy dreamworld door scene", mood, style, loopShift, "Keystone glowing guide", choiceCtx, "no text no words no letters"].filter(Boolean).join(", ");
}
