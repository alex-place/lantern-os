"""
Kingdome of Hearts Game Engine — shared between Discord bot, web API, and chat
(formerly Three Doors; expanded to the 7-stage Kingdome journey)

Usage:
    from three_doors_engine import ThreeDoorsEngine, SCENES

    engine = ThreeDoorsEngine("user-id-123")
    state = engine.start_game()          # returns current state dict
    new_state = engine.choose_door("A")  # advance by door letter or name
    image_prompt = engine.sd_prompt_for_state()  # Stable Diffusion prompt
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Optional

from csf.status_cube import StatusCube, NUM_STAGES

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data" / "csf"

# ── The 7-stage Kingdome journey (stage_index → scene_key) ──
STAGES = [
    "kingdome-garden",     # 0: Garden at the Beginning — the King opens
    "cloverfield",         # 1: Present Day — shinies, luck, today alive
    "future-doors",        # 2: Future Doors — branching possibility
    "xp-door",             # 3: XP Door [GLITCHED] — liminal nostalgia
    "xenon-convergence",   # 4: Xenon Starship — convergence midway
    "sigil-city",          # 5: Sigil, City of Doors — synthesis, King returns
    "fog-door-return",     # 6: Fog Door Return — the way back
]

# ── Canonical scene library ──
SCENES = {
    "moss-entry": {
        "text": (
            "You stand inside **The Moss Door**. The air is thick with green light, soft earth, "
            "and the smell of rain on ferns. Lanterns hang from ancient branches. Lantern stands beside you, "
            "flame steady against the green dark, a brass plate on its frame reading: **GUIDE OF THE ONE WHO CHOSE GREEN**. "
            "It glows warmer and says, *\"You came back.\"*"
        ),
        "doors": [
            {"name": "The Burrow Door", "label": "A", "description": "Small, root-framed, warm. Smells of rain and old blankets."},
            {"name": "The Sunken Bell Door", "label": "B", "description": "Half underwater. Rings softly when no one touches it."},
            {"name": "The Little Crown Door", "label": "C", "description": "Tiny golden door in a tree stump, widening when trusted."},
        ],
        "fox_present": True,
    },
    "burrow": {
        "text": (
            "You crawl through **The Burrow Door** into a snug earthen chamber lined with woven roots "
            "and faded quilts. Rain drums overhead. Lantern settles in the corner, dimming its flame to a drowsy ember. "
            "A single lantern flickers in the corner."
        ),
        "doors": [
            {"name": "The Root Door", "label": "A", "description": "Twisted oak roots form an arch. Something hums beyond."},
            {"name": "The Ember Door", "label": "B", "description": "Warmth radiates. Ash drifts under the crack like snow."},
            {"name": "The Stream Door", "label": "C", "description": "Water rushes somewhere close. The floor is slick moss."},
        ],
        "fox_present": True,
    },
    "sunken-bell": {
        "text": (
            "Beneath **The Sunken Bell Door**, water reaches your ankles in a stone hallway. A bell hangs "
            "above, dripping, and it chimes once though no wind blows. Reflections of lanterns dance on "
            "the ceiling like fish."
        ),
        "doors": [
            {"name": "The Deep Door", "label": "A", "description": "Submerged stairs descend into green-black silence."},
            {"name": "The Echo Door", "label": "B", "description": "Your own voice returns as song from the other side."},
            {"name": "The Surface Door", "label": "C", "description": "Sunlight visible through cracks. The sound of birds."},
        ],
        "fox_present": True,
    },
    "little-crown": {
        "text": (
            "Through **The Little Crown Door**, the forest opens into a glade where every tree stump wears "
            "a tiny golden crown. Yours widened just enough to let you through. Lantern glides ahead, "
            "its glow brushing over the jeweled leaves."
        ),
        "doors": [
            {"name": "The Throne Door", "label": "A", "description": "Carved from a single black oak. Velvet moss for a seat."},
            {"name": "The Hollow Door", "label": "B", "description": "A door inside a hollow tree. Sap runs like amber."},
            {"name": "The Star Door", "label": "C", "description": "Visible only at twilight. Constellations map the hinges."},
        ],
        "fox_present": True,
    },
    "garden-door": {
        "text": (
            "**The Garden Door** opens into an infinite botanical sanctuary. Every plant exists here—ancient sequoias "
            "beside moon-flowers, roses that hum, ferns that remember the Cambrian seas. The air tastes of growth and rain. "
            "A Xenon guide appears—form like liquid starlight—and says, *\"Here, nothing ever stops becoming.\"* "
            "Lantern rests beneath a willow that whispers in languages you're learning to understand."
        ),
        "doors": [
            {"name": "The Seed Door", "label": "A", "description": "A door made of braided vines, always sprouting new growth. Warm and alive."},
            {"name": "The Harvest Door", "label": "B", "description": "Golden, heavy with fruit. The scent of summer at its peak. Bees circle it."},
            {"name": "The Convergence Bloom", "label": "C", "description": "A door of crystallized flowers. They shift between colors no name has claimed yet."},
        ],
        "fox_present": True,
    },
    "xenon-convergence": {
        "text": (
            "You step through into **The Xenon Convergence Door**—a space where all versions of this moment exist at once. "
            "The walls are made of *choice itself*: every decision you could have made branches here as a visible path. "
            "A vast Xenon presence surrounds you, not threatening, but *witnessing*. It says, *\"You are the sum of every path you chose. "
            "And all paths were always here, waiting.\"* Your reflection shows in crystal—but there are thousands of them, "
            "each one you, each one real. Lantern burns with five flames now, each glowing with a different possible future."
        ),
        "doors": [
            {"name": "The Mirror Door", "label": "A", "description": "Shows you as you were, as you are, as you might be. All at once."},
            {"name": "The Branch Door", "label": "B", "description": "A door that splits into infinite versions, each one leading somewhere true."},
            {"name": "The Merge Door", "label": "C", "description": "Where all paths collapse into a single point of perfect understanding."},
        ],
        "fox_present": True,
    },
    "end-of-time": {
        "text": (
            "**The Door at the End of Time** stands at the edge of all things. Beyond it: silence that has always been, "
            "and always will be. The door itself is ancient—so old it has worn smooth, become simple, become *kind*. "
            "On its threshold sit all the moments you've lived, shimmering like light through water. A voice—not Xenon, "
            "not Lantern, but *yourself* from a thousand futures—says, *\"This is not goodbye. This is the place where goodbye "
            "becomes hello again.\"* Lantern transforms one final time: no longer guide, no longer separate—*you are the light, "
            "the light is you, always were, always will be*. The door opens on a light so warm it tastes like home."
        ),
        "doors": [
            {"name": "The Return Door", "label": "A", "description": "Takes you back to the beginning—but you will know what you know now."},
            {"name": "The Beyond Door", "label": "B", "description": "Opens on something that has no name. Something new. Something you."},
            {"name": "The Eternal Door", "label": "C", "description": "The one you choose every moment. The one that chooses you back."},
        ],
        "fox_present": True,
    },
    "kingdome-garden": {
        "text": (
            "**The Throne Door** opens onto the Garden at the Beginning of the **Kingdome of Hearts**. "
            "Stone paths wind through living moss; everything here is both arriving and returning. "
            "On a throne of woven roots and old light sits **the King**, his crown made of tangled vines and blinking cursors, "
            "his face the face of someone who has asked the same question ten thousand times and means it every time. "
            "He looks at you the way someone looks at a door they've seen open before, and speaks:\n\n"
            '*"I am before the first door / and after the last. / I hold what was given / and return what was asked. / '
            'Three walked out, three walked in, / but only one remained — / what was lost at the beginning / '
            'is the thing that was gained."*\n\n'
            "Lantern stands at the foot of the throne as if its light has always lived here."
        ),
        "doors": [
            {"name": "Ancient Doors", "label": "A", "emoji": "🪨", "description": "History · evolution · religion. The oldest threshold in the Garden."},
            {"name": "The Cloverfield", "label": "B", "emoji": "🍀", "description": "Shinies · luck · today alive. Green and gold beyond."},
            {"name": "Tomorrow Door", "label": "C", "emoji": "🔭", "description": "The world that's coming. Slightly ajar, leaking light from unborn years."},
            {"name": "The XP Door", "label": "D", "emoji": "💾", "description": "[GLITCHED] Corrupted · nostalgic · liminal. It is now safe to walk through your childhood."},
            {"name": "Xenon Starship", "label": "E", "emoji": "🪐", "description": "★ All planets · midway · converge. A Xenon guide waits in liquid-starlight form."},
            {"name": "Sigil — City of Doors", "label": "F", "emoji": "🏙️", "description": "Every door leads here. The ring-city where all paths synthesize."},
            {"name": "Fog Door Return", "label": "G", "emoji": "🌫️", "description": "The way back. Mist coils past the Garden's gate, where the Fog God sleeps."},
        ],
        "fox_present": True,
    },
    "storybook": {
        "text": (
            "You fall gently into the **King's Storybook**. Pages turn themselves around you like slow wings. "
            'In the margin, the King\'s handwriting: *"The gods don\'t know I wrote them. They think they wrote me."* '
            "Three pages glow, each a door."
        ),
        "doors": [
            {"name": "The Page of the Word", "label": "A", "description": "Creation myths. Sound as creation — the first thing spoken into the dark."},
            {"name": "The Page of the Egg", "label": "B", "description": "Before light: the unbroken dark sphere, waiting."},
            {"name": "The Page of the War", "label": "C", "description": "Theomachy. Gods tearing each other apart to make the world from pieces."},
        ],
        "fox_present": True,
    },
    "cloverfield": {
        "text": (
            "**The Cloverfield Door** swings into a meadow of four-leaf green under a dome of old light. "
            "Small shinies glitter between the stems — coins, beads, a marble with a galaxy inside. "
            "Lantern's glow catches on something glinting and lingers, for the joy of it. "
            'Here the rule of the Kingdome holds plainly: *death is only imaginary — forever begins with "let\'s play."*'
        ),
        "doors": [
            {"name": "The Lucky Door", "label": "A", "description": "Painted clover-green. Whatever you find behind it, you needed."},
            {"name": "The Today Door", "label": "B", "description": "Warm and ordinary. The day you are actually in, alive."},
            {"name": "The Tomorrow Door", "label": "C", "description": "Slightly ajar. The world that's coming, branching like roots."},
        ],
        "fox_present": True,
    },
    "future-doors": {
        "text": (
            "Past the meadow, the path forks upward into **the Future Doors** — a ridge where tomorrow "
            "grows like an orchard. Each tree carries doors instead of fruit, and every door is slightly open, "
            "leaking weather from years that haven't happened yet. Lantern leans close to one and its flame throws bright sparks. "
            "Somewhere ahead, a low hum: engines, or bees, or both."
        ),
        "doors": [
            {"name": "The Bright Branch", "label": "A", "description": "Warm gold light spills out. A future where the gardens won."},
            {"name": "The Unwritten Door", "label": "B", "description": "Plain, unfinished wood. The hinge waits for your hand to decide."},
            {"name": "The Recursive Door", "label": "C", "description": "Opens onto a hallway of itself, smaller each time, all the way down."},
        ],
        "fox_present": True,
    },
    "xp-door": {
        "text": (
            "A hill of impossibly green grass under an impossibly blue sky — you know this place. "
            "**The XP Door [GLITCHED]** stands alone on the bliss-field, its frame flickering between "
            "wood and window chrome. A startup chime plays from nowhere, half a second too slow. "
            "Lantern's glow pixelates at the edges and it seems delighted about it. "
            "A tooltip floats over the door: *It is now safe to walk through your childhood.*"
        ),
        "doors": [
            {"name": "System Restore", "label": "A", "description": "Roll back to a saved point. The smell of an old summer loads first."},
            {"name": "My Documents", "label": "B", "description": "Every picture you ever saved, sorted by feeling instead of date."},
            {"name": "unknown.exe", "label": "C", "description": "Publisher: unknown. Lantern nods its flame. You run it anyway."},
        ],
        "fox_present": True,
    },
    "sigil-city": {
        "text": (
            "All paths converge in **Sigil, the City of Doors** — a ring of streets where every wall, "
            "archway, and puddle is a threshold somewhere else. Doors you have already opened hang here "
            "like lanterns, each one faintly lit with your own footsteps. At the center plaza, the **King** "
            "waits beneath a street sign that points everywhere at once. He studies you, then the doors "
            "you've gathered, and says: *\"You have walked my thresholds. Every door you chose was also "
            "choosing you. What was lost at the beginning is the thing that was gained — do you see it yet?\"* "
            "Lantern stands at his throne-side like an old friend."
        ),
        "doors": [
            {"name": "The Gallery of Walked Doors", "label": "A", "description": "Your whole path hung in one hall. It rearranges when you understand it."},
            {"name": "The Key Market", "label": "B", "description": "Stalls of keys for doors not yet dreamed. One of them is warm."},
            {"name": "The Lady's Gate", "label": "C", "description": "Silent, watched, absolutely fair. It opens only for what is safe to carry."},
        ],
        "fox_present": True,
    },
    "fog-door-return": {
        "text": (
            "At the city's edge the streets dissolve into the **Sea of Fog and Clouds**, and there it is: "
            "**the Fog Door Return**, standing in the mist where the Fog God sleeps. Through its frame you can "
            "already see the Garden at the Beginning, green and waiting, the throne of woven roots glowing softly. "
            "Lantern passes through first — it always does — and its glow turns back to you. "
            "*\"You came back\"* it will say on the other side. It always says that. It is always true."
        ),
        "doors": [
            {"name": "The Garden Gate", "label": "A", "description": "Straight home to the Beginning. The King will be glad — he always is."},
            {"name": "The Long Way Round", "label": "B", "description": "Drift through the fog first. Arrive when you're ready, not before."},
            {"name": "Lantern's Shortcut", "label": "C", "description": "Follow the steady flame through the mist. Trust is the fastest road."},
        ],
        "fox_present": True,
    },
}

# ── Door-to-next-scene map ──
_NEXT_MAP = {
    "the burrow door": "burrow",
    "the sunken bell door": "sunken-bell",
    "the little crown door": "little-crown",
    "the root door": "moss-entry",
    "the ember door": "moss-entry",
    "the stream door": "moss-entry",
    "the deep door": "sunken-bell",
    "the echo door": "burrow",
    "the surface door": "little-crown",
    "the throne door": "kingdome-garden",
    "the hollow door": "burrow",
    "the star door": "moss-entry",
    "the seed door": "garden-door",
    "the harvest door": "garden-door",
    "the convergence bloom": "xenon-convergence",
    "the mirror door": "xenon-convergence",
    "the branch door": "end-of-time",
    "the merge door": "end-of-time",
    "the return door": "moss-entry",
    "the beyond door": "garden-door",
    "the eternal door": "xenon-convergence",
    # Kingdome of Hearts hub-and-spoke routes (7-door garden)
    "the storybook door": "storybook",
    "the cloverfield door": "cloverfield",
    "ancient doors": "storybook",
    "the cloverfield": "cloverfield",
    "tomorrow door": "future-doors",
    "the xp door": "xp-door",
    "xenon starship": "xenon-convergence",
    "sigil — city of doors": "sigil-city",
    "fog door return": "fog-door-return",
    "the fog door return": "moss-entry",
    "the page of the word": "kingdome-garden",
    "the page of the egg": "kingdome-garden",
    "the page of the war": "kingdome-garden",
    "the lucky door": "kingdome-garden",
    "the today door": "moss-entry",
    "the tomorrow door": "kingdome-garden",
    # 7-stage journey scenes (stage routing handles progression; these are
    # lore-consistent fallbacks for free-roam mode)
    "the bright branch": "xp-door",
    "the unwritten door": "xp-door",
    "the recursive door": "xp-door",
    "system restore": "xenon-convergence",
    "my documents": "xenon-convergence",
    "unknown.exe": "xenon-convergence",
    "the gallery of walked doors": "fog-door-return",
    "the key market": "fog-door-return",
    "the lady's gate": "fog-door-return",
    "the garden gate": "kingdome-garden",
    "the long way round": "kingdome-garden",
    "lantern's shortcut": "kingdome-garden",
}

# ── Image prompt templates per scene ──
_SD_PROMPTS = {
    "moss-entry": (
        "atmospheric dreamscape, moss-covered ancient forest doorway, glowing green lanterns hanging from "
        "twisted branches, a lantern-headed guide with a warm steady flame standing on soft earth, rain on ferns, volumetric fog, "
        "cinematic lighting, dark fantasy, liminal space, soft pastel anime aesthetic, cel-shaded, 16:9"
    ),
    "burrow": (
        "cozy underground burrow chamber, woven tree roots as walls, faded patchwork quilts, warm lantern glow, "
        "lantern-headed guide resting, flame dimmed low, rain drumming on earth ceiling, soft amber light, dark fantasy, "
        "anime aesthetic, cel-shaded, intimate composition, 16:9"
    ),
    "sunken-bell": (
        "submerged stone hallway, water at ankles, ancient bronze bell dripping, chimes without wind, "
        "lantern reflections dancing on wet ceiling, green-black silence, volumetric mist, dark fantasy, "
        "anime aesthetic, cel-shaded, eerie but friendly, 16:9"
    ),
    "little-crown": (
        "enchanted forest glade at twilight, every tree stump wears a tiny golden crown, jeweled leaves, "
        "a lantern-headed guide drifting through dappled light, widening magical doorway, soft warm glow, dark fantasy, "
        "anime aesthetic, cel-shaded, magical realism, 16:9"
    ),
    "garden-door": (
        "infinite botanical sanctuary, ancient sequoias beside moon-flowers, roses that hum, ferns from the Cambrian, "
        "liquid starlight Xenon guide form, lantern-headed guide under a whispering willow, lush growth, rain-washed air, bioluminescent plants, "
        "dark fantasy, anime aesthetic, cel-shaded, botanical dreamscape, volumetric fog, 16:9"
    ),
    "xenon-convergence": (
        "interdimensional space where all choices exist at once, crystal walls made of branching paths, "
        "thousands of reflections of you, each one real, lantern-headed guide with five glowing flames, vast Xenon presence, "
        "fractal geometry, crystalline architecture, impossible light, surreal, mind-bending, anime aesthetic, "
        "cel-shaded, psychedelic but calm, convergence of realities, 16:9"
    ),
    "end-of-time": (
        "the edge of all things, ancient smooth door standing eternal, moments shimmering like light through water, "
        "lantern-headed guide merging with a human form into one being of light, warm light like coming home, end and beginning at once, "
        "transcendent, peaceful, timeless, glowing warmth, anime aesthetic, cel-shaded, cosmic yet intimate, "
        "the final threshold, acceptance and transformation, 16:9"
    ),
    "kingdome-garden": (
        "mystical garden at the beginning of time, stone paths through living moss, throne of woven roots and old light, "
        "King with crown of tangled vines and blinking cursors, lantern-headed guide standing at foot of throne, green and golden light, "
        "bioluminescent moss, dark fantasy, anime aesthetic, cel-shaded, sovereign atmosphere, 16:9"
    ),
    "storybook": (
        "falling into a giant storybook, pages turning like slow wings, ancient handwritten margin notes, "
        "three glowing pages each a door, creation myths and cosmogony, dark fantasy, anime aesthetic, cel-shaded, "
        "mythic atmosphere, soft golden light, 16:9"
    ),
    "cloverfield": (
        "meadow of four-leaf clover under dome of old light, small shinies glittering between stems, "
        "coins, beads, galaxy marble, lantern-headed guide glowing playfully, green and gold light, dark fantasy, anime aesthetic, "
        "cel-shaded, playful atmosphere, 16:9"
    ),
    "future-doors": (
        "orchard ridge where trees grow doors instead of fruit, every door slightly open leaking light "
        "from unborn years, branching paths upward, lantern-headed guide scattering sparks, golden hour, dark fantasy, "
        "anime aesthetic, cel-shaded, hopeful and uncertain at once, 16:9"
    ),
    "xp-door": (
        "rolling bliss-green hill under saturated blue sky, lone door flickering between wood and "
        "early-2000s window chrome, floating tooltip, pixelating lantern-headed guide, glitch artifacts, nostalgia, "
        "liminal space, vaporwave undertones, anime aesthetic, cel-shaded, 16:9"
    ),
    "sigil-city": (
        "impossible ring-city where every wall and archway is a door, walked doors hanging like lit "
        "lanterns, central plaza with vine-crowned king beneath a sign pointing everywhere, lantern-headed "
        "guide at throne-side, fractal architecture, dark fantasy, anime aesthetic, cel-shaded, 16:9"
    ),
    "fog-door-return": (
        "sea of fog and clouds at a city's edge, single door standing in mist showing a green garden "
        "through its frame, sleeping fog god silhouette in clouds, lantern-headed guide stepping through and glancing back, "
        "soft grey-green light, dark fantasy, anime aesthetic, cel-shaded, gentle homecoming, 16:9"
    ),
}


# ── Load canonical contract (merged over hardcoded defaults if present) ──
def _load_scenes_contract() -> None:
    global SCENES, _NEXT_MAP, _SD_PROMPTS
    path = REPO_ROOT / "data" / "three-doors" / "scenes.json"
    try:
        data = json.loads(path.read_text("utf-8"))
        # Merge so scenes defined only in code (or only in the contract) both survive
        if "scenes" in data:
            SCENES = {**SCENES, **data["scenes"]}
            for k, v in data["scenes"].items():
                if v.get("image_prompt"):
                    _SD_PROMPTS[k] = v["image_prompt"]
        if "next_map" in data:
            _NEXT_MAP = {**_NEXT_MAP, **data["next_map"]}
    except Exception:
        pass


_load_scenes_contract()


# ── Personalization: archetype + agent lenses over the base doors ──

_ARCHETYPE_FLAVOR = {
    "seeker": "Something just beyond it pulls at you.",
    "healer": "It feels warm, like a place that will hold you.",
    "explorer": "No one has opened this one quite your way before.",
}

_AGENT_FLAVOR = {
    "lantern": "Lantern's glow steadies on this one.",
    "blinkbug": "Blinkbug's static crackles excitedly around the frame.",
    "keystone": "Keystone hums: this rhymes with a door you already walked.",
    "waterfall": "Waterfall's mist beads gently along its edge.",
    "xenon": "Xenon charts three futures through it; all of them glow.",
    "founder": "The Founder marks it safe — a wish could pass through here.",
}


def personalize_doors(doors: list[dict], archetype: str, agent: str = "",
                      symbols: dict | None = None) -> list[dict]:
    """Return copies of the base doors flavored through the player's
    archetype lens, active agent, and crystallized symbols. Routing is
    unchanged — personalization is a lens, not a fork."""
    symbols = symbols or {}
    out = []
    for door in doors:
        d = dict(door)
        notes = []
        # Crystallized affinity — the strongest signal, shown first
        slug = re.sub(r"[^a-z0-9]+", "-", d["name"].lower()).strip("-")
        if f"affinity-{slug}" in symbols:
            notes.append("You have stood here before. It remembers you.")
        # Archetype lens highlights the door that matches the player's pattern
        from csf.status_cube import _infer_archetype_for_door
        if _infer_archetype_for_door(d["name"]) == archetype:
            notes.append(_ARCHETYPE_FLAVOR.get(archetype, ""))
        if agent and agent.lower() in _AGENT_FLAVOR and notes:
            notes.append(_AGENT_FLAVOR[agent.lower()])
        if notes:
            d["description"] = d["description"] + " " + " ".join(n for n in notes if n)
            d["resonance"] = True
        out.append(d)
    return out


class ThreeDoorsEngine:
    """Session-bound Three Doors game engine, persisted as a StatusCube
    (one CSF v0.7 file per player — their ImagniVerse)."""

    def __init__(self, user_id: str, data_dir: Path | None = None):
        self.user_id = user_id
        self.data_dir = data_dir or DATA_DIR
        self.cube = StatusCube.load(user_id, self.data_dir)
        self.agent: str = ""  # active companion persona for this session

    # ── State assembly ──

    def _scene_for_stage(self, stage_index: int) -> tuple[str, dict]:
        key = STAGES[stage_index % NUM_STAGES]
        return key, SCENES.get(key, SCENES["kingdome-garden"])

    def _build_state(self) -> dict:
        scene_key, scene = self._scene_for_stage(self.cube.stage_index)
        doors = personalize_doors(
            scene["doors"], self.cube.archetype, self.agent, self.cube.symbols)
        return {
            "scene_key": scene_key,
            "text": scene["text"],
            "doors": doors,
            "fox_present": scene.get("fox_present", True),
            "history": list(self.cube.history),
            "stage_index": self.cube.stage_index,
            "stage_count": NUM_STAGES,
            "loop_count": self.cube.loop_count,
            "archetype": self.cube.archetype,
        }

    def load(self) -> dict | None:
        """Return current state, or None if no game has been started."""
        if not self.cube.scene_key and not self.cube.history:
            return None
        return self._build_state()

    def save(self, state: dict | None = None) -> None:
        """Persist the cube. The state dict is derived, so only the cube is written."""
        self.cube.scene_key = STAGES[self.cube.stage_index % NUM_STAGES]
        self.cube.save()

    # ── Gameplay ──

    def start_game(self) -> dict:
        """Begin a new journey or resume an existing one."""
        existing = self.load()
        if existing is not None:
            return existing
        self.cube.stage_index = 0
        self.cube.history = ["Entered the Garden at the Beginning"]
        self.save()
        return self._build_state()

    def choose_door(self, choice: str) -> dict | None:
        """Advance by door letter (A/B/C) or full name. Records the choice as
        a CSF observation, advances the stage, and consolidates observations
        into crystallized symbols when a loop completes."""
        state = self.load()
        if not state:
            return None
        choice_lower = choice.lower().strip()
        chosen = None
        for d in state.get("doors", []):
            if d["label"].lower() == choice_lower or d["name"].lower() == choice_lower:
                chosen = d
                break
        if not chosen:
            # Accept single-word custom doors (e.g. a player-named door).
            # Reject multi-word phrases that don't match any real door.
            stripped = choice.strip()
            if len(stripped) > 1 and ' ' not in stripped:
                chosen = {"label": "CUSTOM", "name": stripped}
            else:
                return None

        self.cube.add_observation(
            stage=self.cube.stage_index,
            choice=chosen["label"],
            door=chosen["name"],
            agent=self.agent,
            scene_key=state["scene_key"],
        )
        self.cube.history.append(f"Chose {chosen['name']}")

        loop_completed = self.cube.advance_stage()
        if loop_completed:
            self.cube.history.append(
                f"Returned to the Garden — loop {self.cube.loop_count} complete")

        self.save()
        new_state = self._build_state()
        new_state["loop_completed"] = loop_completed
        return new_state

    def reset(self) -> dict:
        """Start fresh, discarding the saved cube."""
        self.cube.delete()
        self.cube = StatusCube(self.user_id, self.data_dir)
        return self.start_game()

    # ── Image / AI integration ──

    def sd_prompt_for_state(self, state: dict | None = None) -> str:
        """Return a Stable Diffusion prompt for the current (or given) scene,
        contextualized by the player's archetype, agent, and crystallized symbols."""
        s = state or self.load()
        key = (s or {}).get("scene_key") or STAGES[self.cube.stage_index % NUM_STAGES]
        base = _SD_PROMPTS.get(key, _SD_PROMPTS["kingdome-garden"])
        context = [base]
        arch = self.cube.archetype
        arch_mood = {
            "seeker": "sense of discovery, horizon light",
            "healer": "soft warmth, sheltering light",
            "explorer": "untrodden path, bold contrast",
        }.get(arch)
        if arch_mood:
            context.append(arch_mood)
        if self.cube.loop_count > 0:
            context.append("subtle traces of earlier journeys, footprints of light")
        if self.agent:
            context.append(f"{self.agent} companion presence")
        return ", ".join(context)

    def image_suggestions_for_ai(self) -> list[dict]:
        """Return image generation suggestions for the doors of the current stage.
        In the 7-stage journey all doors lead onward, so each suggestion previews
        the next stage flavored by the chosen door."""
        state = self.load()
        if not state:
            return []
        next_key, _ = self._scene_for_stage(self.cube.stage_index + 1)
        prompt = _SD_PROMPTS.get(next_key, _SD_PROMPTS["kingdome-garden"])
        return [
            {
                "prompt": f"{prompt}, approached through {door['name'].lower()}",
                "scene_key": next_key,
                "description": door["description"],
                "door_name": door["name"],
                "door_label": door["label"],
            }
            for door in state.get("doors", [])
        ]

    def to_api_response(self, state: dict | None = None) -> dict:
        """Serialize state for JSON API response."""
        s = state or self.load() or self._build_state()
        scene_key = s.get("scene_key", STAGES[0])

        return {
            "scene_key": scene_key,
            "text": s.get("text", ""),
            "doors": s.get("doors", []),
            "fox_present": s.get("fox_present", False),
            "history": s.get("history", []),
            "stage_index": s.get("stage_index", self.cube.stage_index),
            "stage_count": NUM_STAGES,
            "loop_count": s.get("loop_count", self.cube.loop_count),
            "archetype": s.get("archetype", self.cube.archetype),
            "symbols": self.cube.symbols,
            "image_prompt": self.sd_prompt_for_state(s),
            "image_available": bool(os.getenv("STABLE_DIFFUSION_URL") or os.getenv("SD_WEBUI_URL")),
            "classification": self._classify_scene(scene_key),
        }

    def _classify_scene(self, scene_key: str) -> dict:
        """Classify scene archetype and aesthetic"""
        archetypes = {
            "moss-entry": "primordial",
            "burrow": "intimate",
            "sunken-bell": "mystical",
            "little-crown": "whimsical",
            "garden-door": "bountiful",
            "xenon-convergence": "cosmic",
            "end-of-time": "transcendent",
            "kingdome-garden": "sovereign",
            "storybook": "mythic",
            "cloverfield": "playful",
            "future-doors": "possible",
            "xp-door": "liminal",
            "sigil-city": "convergent",
            "fog-door-return": "returning",
        }

        aesthetic_tags = {
            "moss-entry": ["dark-fantasy", "anime", "cel-shaded", "liminal", "forest"],
            "garden-door": ["botanical", "bioluminescent", "lush", "dreamscape"],
            "xenon-convergence": ["psychedelic", "fractal", "crystalline", "surreal"],
            "end-of-time": ["cosmic", "transcendent", "peaceful", "transformation"],
            "kingdome-garden": ["garden", "throne", "king", "moss", "old-light"],
            "storybook": ["creation", "myth", "pages", "handwriting"],
            "cloverfield": ["meadow", "clover", "shinies", "luck", "play"],
            "future-doors": ["orchard", "tomorrow", "branching", "possibility"],
            "xp-door": ["glitch", "nostalgia", "bliss-hill", "liminal", "windows"],
            "sigil-city": ["city-of-doors", "synthesis", "king", "thresholds"],
            "fog-door-return": ["fog", "return", "sea-of-clouds", "homecoming"],
        }

        return {
            "archetype": archetypes.get(scene_key, "unknown"),
            "tags": aesthetic_tags.get(scene_key, []),
            "confidence": 0.95,
        }


def _demo():
    engine = ThreeDoorsEngine("demo-user")
    state = engine.start_game()
    print("Started:", state["scene_key"])
    print("Prompt:", engine.sd_prompt_for_state())
    new_state = engine.choose_door("A")
    if new_state:
        print("Chose A:", new_state["scene_key"])
        print("New prompt:", engine.sd_prompt_for_state(new_state))


if __name__ == "__main__":
    _demo()