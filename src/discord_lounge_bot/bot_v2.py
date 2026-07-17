"""
Lantern OS Discord Bot v2 -- Slash Commands + Role Gating + Prefix Fallback

Generated: 2026-05-31.
Purpose: monetized Discord server with tiered access and slash commands.
Also remembers v1 prefix commands (!dream, !note, !threedoors).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import random
import re
import shutil
import sys
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

try:
    import discord
    from discord import app_commands
except Exception as exc:
    print(f"[FATAL] Missing dependency 'discord.py': {exc}")
    sys.exit(1)

try:
    from account_link import resolve_web_role
except ImportError:
    def resolve_web_role(discord_id, repo_root=None):  # type: ignore[misc]
        return None

# -- Load .env and .env.local (canonical env first, then local overrides) --
for _env_candidate in [
    Path(__file__).resolve().parents[2] / ".env",
    Path(__file__).resolve().parents[2] / ".env.local",
]:
    if _env_candidate.exists():
        for _line in _env_candidate.read_text("utf-8").splitlines():
            _line = _line.strip()
            if not _line or _line.startswith("#") or "=" not in _line:
                continue
            _k, _v = _line.split("=", 1)
            _k = _k.strip()
            if _k and _k not in os.environ:
                os.environ[_k] = _v.strip()

# -- Configuration --
TOKEN = os.getenv("DISCORD_BOT_TOKEN", os.getenv("DISCORD_TOKEN", "")).strip()
GUILD_ID = os.getenv("LANTERN_DISCORD_GUILD_ID", "").strip()
STATUS_URL = os.getenv("LANTERN_STATUS_URL", "http://127.0.0.1:4177/api/status").strip()
REPO_ROOT = Path(__file__).resolve().parents[2]
DREAMER_NOTEBOOK_DIR = REPO_ROOT / "data" / "dreamer" / "notebooks"
SUBSCRIBER_DATA_PATH = Path(os.getenv("SUBSCRIBER_DATA_PATH", REPO_ROOT / "data" / "discord" / "subscribers.json"))
MAX_NOTEBOOK_TEXT_LENGTH = 2000
THREE_DOORS_DATA_DIR = REPO_ROOT / "data" / "discord" / "three-doors"

# Role name constants — matched case-insensitively against member.roles
# Server uses: Wanderer (free) / Deep Dreamer ($20 Pro) / Synthesasia Guild (pilot) / founder / admin
ROLE_PUBLIC = "@everyone"
ROLE_SUPPORTER = "supporter"          # canonical bot name
ROLE_DEEP_DREAMER = "deep_dreamer"    # the web's $20 Pro tier (#2659)
ROLE_PILOT = "pilot"                  # canonical bot name
ROLE_FOUNDER = "founder"              # matches server role exactly

# Aliases: server's actual role names map to canonical tiers. The Discord "Deep Dreamer"
# server role is the $20 paid tier, so it maps to the web's `deep_dreamer` (Pro) — NOT to
# `supporter`, which is a distinct, lower web tier (#2659). Keeping them separate stops the
# lossy round-trip (web Pro → Discord "Deep Dreamer" → bot supporter) and frees the
# "Deep Dreamer" label to mean the same tier on both surfaces.
_ROLE_ALIASES: dict[str, str] = {
    "wanderer":           ROLE_PUBLIC,
    "deep dreamer":       ROLE_DEEP_DREAMER,
    "synthesasia guild":  ROLE_PILOT,
    "patreon":            ROLE_PILOT,    # treat Patreon supporters as pilot tier
    "admin":              ROLE_FOUNDER,  # admins get founder-level access
}

TIER_ORDER = {
    ROLE_PUBLIC: 0,
    ROLE_SUPPORTER: 1,
    ROLE_DEEP_DREAMER: 2,
    ROLE_PILOT: 3,
    ROLE_FOUNDER: 4,
}

# -- Lazy environment checks (called from main so imports don't crash) --
GUILD_ID_INT: int | None = None
if GUILD_ID:
    try:
        GUILD_ID_INT = int(GUILD_ID)
    except ValueError:
        pass


def _validate_config() -> None:
    """Exit if required config is missing. Called from main() so imports don't crash."""
    if not TOKEN:
        print("[FATAL] Missing DISCORD_BOT_TOKEN (or DISCORD_TOKEN)")
        sys.exit(1)
    if GUILD_ID and GUILD_ID_INT is None:
        print("[FATAL] LANTERN_DISCORD_GUILD_ID must be numeric")
        sys.exit(1)


# -- Discord client setup --
intents = discord.Intents.default()
intents.guilds = True
intents.members = True
intents.message_content = True

client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)

# -- Helpers --

def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def notebook_user_id(user: discord.User | discord.Member) -> str:
    return f"discord-{user.id}"


def notebook_path(user_id: str) -> Path:
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "-", user_id).strip("-").lower() or "discord-user"
    return DREAMER_NOTEBOOK_DIR / f"{safe}.jsonl"


def generate_entry_id() -> str:
    return str(uuid.uuid4())


def generate_ternary_id(seed: str = "") -> str:
    base = seed or str(uuid.uuid4())
    h = hashlib.sha256(base.encode("utf-8")).hexdigest()
    val = int(h[:16], 16)
    digits = []
    for _ in range(12):
        digits.append(str(val % 3))
        val //= 3
    return "".join(reversed(digits))


def append_notebook_entry(user: discord.User | discord.Member, kind: str, text: str, **kwargs) -> dict:
    clean_text = text.strip()[:MAX_NOTEBOOK_TEXT_LENGTH]
    if not clean_text:
        raise ValueError("text_required")
    user_id = notebook_user_id(user)
    entry_id = generate_entry_id()
    record = {
        "id": entry_id,
        "recordedAt": now_utc(),
        "user": user_id,
        "kind": kind,
        "source": "discord",
        "discordAuthorId": str(user.id),
        "discordAuthorName": str(user),
        "text": clean_text,
        "name": kwargs.get("name") or None,
        "mood": kwargs.get("mood") or None,
        "links": kwargs.get("links", []),
        "tags": kwargs.get("tags", []),
        "ternaryId": generate_ternary_id(entry_id + clean_text),
        "private": True,
    }
    path = notebook_path(user_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return record


def recall_notebook_entries(user: discord.User | discord.Member, query: str = "", limit: int = 5) -> list[dict]:
    path = notebook_path(notebook_user_id(user))
    if not path.exists():
        return []
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    needle = query.strip().lower()
    if needle:
        rows = [row for row in rows if needle in str(row.get("text", "")).lower()]
    return rows[-limit:]


def format_recall(entries: list[dict]) -> str:
    if not entries:
        return "No matching notebook entries found."
    lines = ["Notebook recall:"]
    for entry in reversed(entries):
        text = str(entry.get("text", "")).replace("\n", " ").strip()
        if len(text) > 160:
            text = text[:157] + "..."
        tid = entry.get("ternaryId", "")
        tid_str = f" [{tid}]" if tid else ""
        lines.append(f"- {entry.get('kind', 'note')}{tid_str} at {entry.get('recordedAt', 'unknown')}: {text}")
    return "\n".join(lines)


# -- Three Doors helpers --

def three_doors_path(user_id: str) -> Path:
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "-", user_id).strip("-").lower() or "discord-user"
    return THREE_DOORS_DATA_DIR / f"{safe}.json"


def load_three_doors_state(user: discord.User | discord.Member) -> dict | None:
    path = three_doors_path(notebook_user_id(user))
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text("utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def save_three_doors_state(user: discord.User | discord.Member, state: dict) -> None:
    path = three_doors_path(notebook_user_id(user))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


# Pre-defined scenes for the Three Doors game
_THREE_DOORS_SCENES = {
    "moss-entry": {
        "text": (
            "You stand inside **The Moss Door**. The air is thick with green light, soft earth, and the smell of rain on ferns. "
            "Lanterns hang from ancient branches. A moss-covered fox sits beside you, wearing a brass tag that reads: "
            "**FRIEND OF THE ONE WHO CHOSE GREEN**. It looks up and says, *\"You came back.\"*"
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
            "You crawl through **The Burrow Door** into a snug earthen chamber lined with woven roots and faded quilts. "
            "Rain drums overhead. The fox curls up on a blanket and closes its eyes. A single lantern flickers in the corner."
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
            "Beneath **The Sunken Bell Door**, water reaches your ankles in a stone hallway. A bell hangs above, dripping, "
            "and it chimes once though no wind blows. Reflections of lanterns dance on the ceiling like fish."
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
            "Through **The Little Crown Door**, the forest opens into a glade where every tree stump wears a tiny golden crown. "
            "Yours widened just enough to let you through. The fox trots ahead, its tail brushing against jeweled leaves."
        ),
        "doors": [
            {"name": "The Throne Door", "label": "A", "description": "Carved from a single black oak. Velvet moss for a seat."},
            {"name": "The Hollow Door", "label": "B", "description": "A door inside a hollow tree. Sap runs like amber."},
            {"name": "The Star Door", "label": "C", "description": "Visible only at twilight. Constellations map the hinges."},
        ],
        "fox_present": True,
    },
    "kingdome-garden": {
        "text": (
            "**The Throne Door** opens onto the Garden at the Beginning of the **Kingdome of Hearts**. "
            "Stone paths wind through living moss; everything here is both arriving and returning. "
            "On a throne of woven roots and old light sits **the King**, his crown made of tangled vines and blinking cursors. "
            "He looks at you the way someone looks at a door they've seen open before, and speaks:\n\n"
            "*\"I am before the first door / and after the last. / I hold what was given / and return what was asked. / "
            "Three walked out, three walked in, / but only one remained — / what was lost at the beginning / "
            "is the thing that was gained.\"*\n\n"
            "The fox sits at the foot of the throne as if it has always lived here."
        ),
        "doors": [
            {"name": "The Storybook Door", "label": "A", "description": "Bound in vine and brass. The King's own book — the gods don't know he wrote them."},
            {"name": "The Cloverfield Door", "label": "B", "description": "Green and gold beyond. Shinies, luck, and today, alive."},
            {"name": "The Fog Door Return", "label": "C", "description": "Mist coils past the Garden's gate, where the Fog God sleeps. The way back."},
        ],
        "fox_present": True,
    },
    "storybook": {
        "text": (
            "You fall gently into the **King's Storybook**. Pages turn themselves around you like slow wings. "
            "In the margin, the King's handwriting: *\"The gods don't know I wrote them. They think they wrote me.\"* "
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
            "The fox pounces at something glinting and misses, on purpose, for the joy of it. "
            "Here the rule of the Kingdome holds plainly: *death is only imaginary — forever begins with \"let's play.\"*"
        ),
        "doors": [
            {"name": "The Lucky Door", "label": "A", "description": "Painted clover-green. Whatever you find behind it, you needed."},
            {"name": "The Today Door", "label": "B", "description": "Warm and ordinary. The day you are actually in, alive."},
            {"name": "The Tomorrow Door", "label": "C", "description": "Slightly ajar. The world that's coming, branching like roots."},
        ],
        "fox_present": True,
    },
}


_THREE_DOORS_NEXT_MAP = {
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
    # Kingdome of Hearts loop
    "the storybook door": "storybook",
    "the cloverfield door": "cloverfield",
    "the fog door return": "moss-entry",
    "the page of the word": "kingdome-garden",
    "the page of the egg": "kingdome-garden",
    "the page of the war": "kingdome-garden",
    "the lucky door": "kingdome-garden",
    "the today door": "moss-entry",
    "the tomorrow door": "kingdome-garden",
}


# ── Mirror canonical contract (prevents drift with web UI / engine) ──
def _load_three_doors_contract() -> None:
    global _THREE_DOORS_SCENES, _THREE_DOORS_NEXT_MAP
    path = REPO_ROOT / "data" / "three-doors" / "scenes.json"
    try:
        data = json.loads(path.read_text("utf-8"))
        if "scenes" in data:
            _THREE_DOORS_SCENES = data["scenes"]
        if "next_map" in data:
            _THREE_DOORS_NEXT_MAP = data["next_map"]
    except Exception:
        pass


_load_three_doors_contract()


def _advance_three_doors(state: dict, door_name: str) -> dict | None:
    """Return a new state after choosing a door, or None if choice is invalid."""
    door_name_lower = door_name.lower().strip()
    current_doors = state.get("doors", [])
    chosen = None
    for d in current_doors:
        if d["label"].lower() == door_name_lower or d["name"].lower() == door_name_lower:
            chosen = d
            break
    if not chosen:
        return None
    next_key = _THREE_DOORS_NEXT_MAP.get(chosen["name"].lower(), "moss-entry")
    next_scene = _THREE_DOORS_SCENES[next_key]
    return {
        "scene_key": next_key,
        "text": next_scene["text"],
        "doors": next_scene["doors"],
        "fox_present": next_scene["fox_present"],
        "history": state.get("history", []) + [f"Chose {chosen['name']}"],
    }


def _format_three_doors_embed(state: dict) -> discord.Embed:
    embed = discord.Embed(
        title="Three Doors",
        description=state["text"],
        color=0x2E8B57,
    )
    if state.get("fox_present"):
        embed.set_footer(text="The fox is with you.")
    for d in state.get("doors", []):
        embed.add_field(
            name=f"{d['label']}. {d['name']}",
            value=d["description"],
            inline=False,
        )
    return embed


_TIER_LABELS = {
    ROLE_PUBLIC: "Wanderer",
    ROLE_SUPPORTER: "Supporter",
    ROLE_DEEP_DREAMER: "Deep Dreamer",
    ROLE_PILOT: "Synthesasia Guild",
    ROLE_FOUNDER: "Founder",
}


def _tier_display(tier: str) -> str:
    return _TIER_LABELS.get(tier, tier.title())


def get_user_tier(member: discord.Member | discord.User) -> str:
    """Return the highest tier role the user has (checks aliases too)."""
    if not isinstance(member, discord.Member):
        return ROLE_PUBLIC
    role_names_lower = {r.name.lower() for r in member.roles}
    # Resolve each role name to its canonical tier, then take the highest
    best = TIER_ORDER[ROLE_PUBLIC]
    for rn in role_names_lower:
        canonical = _ROLE_ALIASES.get(rn, rn)  # alias lookup, else use as-is
        level = TIER_ORDER.get(canonical, 0)
        if level > best:
            best = level
    return next(t for t, v in TIER_ORDER.items() if v == best)


def require_tier(minimum: str):
    """Decorator to gate slash commands by role tier."""
    min_level = TIER_ORDER.get(minimum.lower(), 0)

    async def predicate(interaction: discord.Interaction) -> bool:
        if not isinstance(interaction.user, discord.Member):
            if not interaction.response.is_done():
                await interaction.response.send_message("This command must be used in a server.", ephemeral=True)
            return False
        tier = get_user_tier(interaction.user)
        level = TIER_ORDER.get(tier, 0)
        if level < min_level:
            if not interaction.response.is_done():
                await interaction.response.send_message(
                    f"This command requires **{_tier_display(minimum)}** tier or higher. "
                    "Use `/subscribe` to upgrade.",
                    ephemeral=True,
                )
            return False
        return True

    return app_commands.check(predicate)


# ── Lounge: catalog config ─────────────────────────────────────────────────────

# archive.org item identifiers by playback mode.
# Resolved to direct MP3 URLs at bot startup via the metadata API.
_LOUNGE_CATALOG_IDS: dict[str, list[str]] = {
    "sinatra": [
        "FrankSinatraRadioCollection",  # 217 episodes (1940s-50s radio: Your Hit Parade, etc.)
        "Frank_Sinatra_Tape_1_1940",    # transcription disc, Side A/B ~60 min each
        "YourHitParade19440506",
        "file-002_20260213",            # Tommy Dorsey w/ Sinatra, Feb 1940
    ],
    "dreams": [
        # delta (0.5-4 Hz) + theta (4-8 Hz) for sleep and dream entry
        "BrainwaveFrequenciesBinauralBeats",
        "RelaxingSleepMusic.DeltaWavesBinauralBeatsHealingForDeepSleepStressReliefMeditation",
        "deepsleepmusicforstressreliefhealingdeltabinauralbeatsforbrainpower",
    ],
    "focus": [
        # alpha (8-14 Hz) + beta (14-30 Hz) for focus and flow
        "BrainwaveFrequenciesBinauralBeats",
        "greenred-528-hz-music-with-healing-frequency",
    ],
}

_LOUNGE_FILENAME_FILTER: dict[str, list[str] | None] = {
    "sinatra": None,
    "dreams":  ["delta", "theta", "sleep", "dream", "relax", "heal"],
    "focus":   ["alpha", "beta", "focus", "528", "concent", "energy", "study"],
}

_LOUNGE_DEFAULT_VC = os.getenv("LOUNGE_VOICE_CHANNEL", "Sinatra Lounge")
_LOUNGE_FFMPEG_OK: bool = shutil.which("ffmpeg") is not None


# ── Lounge: data models ────────────────────────────────────────────────────────

@dataclass
class LoungeTrack:
    title: str
    url: str
    identifier: str
    mode: str
    duration_secs: int = 0

    def label(self) -> str:
        return f"**{self.title}** · _{self.identifier}_"


@dataclass
class LoungeState:
    voice_client: Optional[discord.VoiceClient] = None
    queue: list[LoungeTrack] = field(default_factory=list)
    current: Optional[LoungeTrack] = None
    mode: str = "sinatra"
    loop: bool = False
    volume: float = 0.7
    text_channel: Optional[discord.TextChannel] = None
    _pool: dict[str, list[LoungeTrack]] = field(default_factory=dict)


# Memory limits to prevent unbounded growth
_MAX_QUEUE_SIZE = 50
_MAX_CATALOG_TRACKS = 200
_MAX_GUILD_STATES = 100

_LOUNGE_STATES: dict[int, LoungeState] = {}
_LOUNGE_CATALOG: dict[str, list[LoungeTrack]] = {}


def _lounge_state(guild_id: int) -> LoungeState:
    if guild_id not in _LOUNGE_STATES:
        # LRU eviction if too many guild states
        if len(_LOUNGE_STATES) >= _MAX_GUILD_STATES:
            # Remove oldest state (first key in dict)
            oldest_guild = next(iter(_LOUNGE_STATES))
            del _LOUNGE_STATES[oldest_guild]
        _LOUNGE_STATES[guild_id] = LoungeState()
    return _LOUNGE_STATES[guild_id]


def _lounge_refill(state: LoungeState, mode: str) -> None:
    pool = list(_LOUNGE_CATALOG.get(mode, []))
    if not pool:
        return
    random.shuffle(pool)
    # Limit queue size to prevent unbounded growth
    remaining_slots = _MAX_QUEUE_SIZE - len(state.queue)
    if remaining_slots > 0:
        state.queue.extend(pool[:remaining_slots])


# ── Lounge: catalog resolution ─────────────────────────────────────────────────

def _lounge_fetch(url: str) -> dict | list | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "LanternLounge/1.0"})
        with urllib.request.urlopen(req, timeout=12) as r:
            return json.loads(r.read())
    except Exception as exc:
        print(f"  [lounge] fetch error {url[:70]}: {exc}")
        return None


def _lounge_resolve_item(identifier: str, mode: str) -> list[LoungeTrack]:
    meta = _lounge_fetch(f"https://archive.org/metadata/{identifier}")
    if not meta or "files" not in meta:
        return []
    name_filters = _LOUNGE_FILENAME_FILTER.get(mode)
    tracks: list[LoungeTrack] = []
    for f in meta["files"]:
        name: str = f.get("name", "")
        name_lower = name.lower()
        if not name_lower.endswith(".mp3") and "mp3" not in f.get("format", "").lower():
            continue
        if any(name_lower.endswith(s) for s in ("_vbrmp3.m3u", ".m3u", "_64kb.mp3", "_128kb.mp3")):
            continue
        if name_filters and not any(kw in name_lower for kw in name_filters):
            continue
        try:
            size_bytes = int(f.get("size", 0))
        except (ValueError, TypeError):
            size_bytes = 999_999
        if size_bytes < 200_000:
            continue
        title = f.get("title") or name.rsplit(".", 1)[0].replace("_", " ")
        url = f"https://archive.org/download/{identifier}/{urllib.parse.quote(name)}"
        try:
            secs = int(float(f.get("length", 0)))
        except (ValueError, TypeError):
            secs = 0
        tracks.append(LoungeTrack(title=title, url=url, identifier=identifier, mode=mode, duration_secs=secs))
    if tracks:
        print(f"  [lounge] {identifier}: {len(tracks)} track(s)")
    return tracks


def _lounge_build_catalog() -> dict[str, list[LoungeTrack]]:
    catalog: dict[str, list[LoungeTrack]] = {}
    for mode, ids in _LOUNGE_CATALOG_IDS.items():
        tracks: list[LoungeTrack] = []
        for ident in ids:
            tracks.extend(_lounge_resolve_item(ident, mode))
        # Limit catalog size to prevent unbounded memory growth
        if len(tracks) > _MAX_CATALOG_TRACKS:
            tracks = tracks[:_MAX_CATALOG_TRACKS]
        catalog[mode] = tracks
        print(f"  [lounge] mode={mode}: {len(tracks)} tracks total")
    return catalog


async def _lounge_catalog_init() -> None:
    """Run catalog build in thread executor (blocking HTTP, ~15s). Called from on_ready."""
    global _LOUNGE_CATALOG
    if not _LOUNGE_FFMPEG_OK:
        print("[LOUNGE] ffmpeg not found — voice commands disabled. Install: winget install Gyan.FFmpeg")
        return
    print("[LOUNGE] Fetching catalog from archive.org (runs in background)...")
    try:
        loop = asyncio.get_event_loop()
        _LOUNGE_CATALOG = await loop.run_in_executor(None, _lounge_build_catalog)
        total = sum(len(v) for v in _LOUNGE_CATALOG.values())
        print(f"[LOUNGE] Catalog ready — {total} tracks")
    except Exception as exc:
        print(f"[LOUNGE] Catalog build error: {exc}")
    sys.stdout.flush()


# ── Lounge: playback ───────────────────────────────────────────────────────────

_FFMPEG_BEFORE = "-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5"
_FFMPEG_OPTS   = "-vn"


def _lounge_make_source(url: str, volume: float) -> discord.AudioSource:
    raw = discord.FFmpegPCMAudio(url, before_options=_FFMPEG_BEFORE, options=_FFMPEG_OPTS)
    return discord.PCMVolumeTransformer(raw, volume=volume)


def _lounge_after(guild_id: int, loop: asyncio.AbstractEventLoop):
    def after(error: Exception | None):
        if error:
            print(f"[LOUNGE {guild_id}] audio error: {error}")
        asyncio.run_coroutine_threadsafe(_lounge_advance(guild_id), loop)
    return after


async def _lounge_advance(guild_id: int) -> None:
    state = _lounge_state(guild_id)
    vc = state.voice_client
    if vc is None or not vc.is_connected():
        return
    if state.loop and state.current:
        track = state.current
    else:
        if len(state.queue) < 2:
            _lounge_refill(state, state.mode)
        if not state.queue:
            state.current = None
            return
        track = state.queue.pop(0)
    state.current = track
    try:
        source = _lounge_make_source(track.url, state.volume)
        vc.play(source, after=_lounge_after(guild_id, asyncio.get_event_loop()))
        if state.text_channel:
            dur = (f" `{track.duration_secs // 60}:{track.duration_secs % 60:02d}`"
                   if track.duration_secs else "")
            await state.text_channel.send(f"▶️ {track.label()}{dur}")
    except Exception as exc:
        print(f"[LOUNGE {guild_id}] play error: {exc}")
        await _lounge_advance(guild_id)


async def _lounge_join(ctx) -> tuple[discord.VoiceClient | None, str | None]:
    """Join author's voice channel, or the default Sinatra Lounge channel."""
    if isinstance(ctx, discord.Interaction):
        guild, author = ctx.guild, ctx.user
    else:
        guild, author = ctx.guild, ctx.author
    if guild is None:
        return None, "Must be used in a server."
    target_vc: discord.VoiceChannel | None = None
    if isinstance(author, discord.Member) and author.voice:
        target_vc = author.voice.channel  # type: ignore
    if target_vc is None:
        target_vc = discord.utils.find(
            lambda c: isinstance(c, discord.VoiceChannel)
            and _LOUNGE_DEFAULT_VC.lower() in c.name.lower(),
            guild.channels,
        )
    if target_vc is None:
        target_vc = next((c for c in guild.channels if isinstance(c, discord.VoiceChannel)), None)
    if target_vc is None:
        return None, "No voice channel found. Join one first, or create a 'Sinatra Lounge' voice channel."
    state = _lounge_state(guild.id)
    vc = state.voice_client
    if vc and vc.is_connected():
        if vc.channel.id != target_vc.id:
            await vc.move_to(target_vc)
    else:
        vc = await target_vc.connect()
    state.voice_client = vc
    return vc, None


async def _lounge_start(ctx, mode: str) -> None:
    """Switch lounge mode and start playing."""
    if isinstance(ctx, discord.Interaction):
        guild = ctx.guild
        ch = ctx.channel
    else:
        guild = ctx.guild
        ch = getattr(ctx, "channel", None)
    if guild is None:
        return
    if not _LOUNGE_FFMPEG_OK:
        msg = "⚠️ Voice requires ffmpeg. Install: `winget install Gyan.FFmpeg` then restart the bot."
        if isinstance(ctx, discord.Interaction):
            if not ctx.response.is_done():
                await ctx.response.send_message(msg, ephemeral=True)
        else:
            try: await ctx.channel.send(msg)
            except Exception: pass
        return
    if not _LOUNGE_CATALOG.get(mode):
        msg = f"⚠️ Catalog for `{mode}` is still loading — try again in a few seconds."
        if isinstance(ctx, discord.Interaction):
            if not ctx.response.is_done():
                await ctx.response.send_message(msg, ephemeral=True)
        else:
            try: await ctx.channel.send(msg)
            except Exception: pass
        return
    vc, err = await _lounge_join(ctx)
    if err:
        if isinstance(ctx, discord.Interaction):
            if not ctx.response.is_done():
                await ctx.response.send_message(f"⚠️ {err}", ephemeral=True)
        else:
            try: await ctx.channel.send(f"⚠️ {err}")
            except Exception: pass
        return
    state = _lounge_state(guild.id)
    state.mode = mode
    state.text_channel = ch  # type: ignore
    if vc and vc.is_playing():
        vc.stop()
    state.queue.clear()
    _lounge_refill(state, mode)
    labels = {"sinatra": "🎙️ Sinatra", "dreams": "🌙 Dreams", "focus": "🧠 Focus"}
    msg = f"{labels.get(mode, mode)} — starting ▶️"
    if isinstance(ctx, discord.Interaction):
        if not ctx.response.is_done():
            await ctx.response.send_message(msg)
    else:
        try: await ctx.channel.send(msg)
        except Exception: pass
    await _lounge_advance(guild.id)


# ── Slash Commands --

@tree.command(name="status", description="Check system health and status")
async def cmd_status(interaction: discord.Interaction):
    embed = discord.Embed(title="Lantern OS Status", color=0x0D9488)
    embed.add_field(name="Time", value=now_utc(), inline=False)
    embed.add_field(name="Service", value="lantern-garage", inline=True)
    embed.add_field(name="Tier", value=get_user_tier(interaction.user).title(), inline=True)
    embed.set_footer(text="Local-first. Evidence-backed.")
    await interaction.response.send_message(embed=embed)


@tree.command(name="help", description="List available commands for your tier")
async def cmd_help(interaction: discord.Interaction):
    tier = get_user_tier(interaction.user)
    embed = discord.Embed(
        title="🏮 Lantern OS Commands",
        description=f"Your access tier: **{_tier_display(tier)}**",
        color=0x0D9488
    )
    
    # Music & Voice (available to all)
    embed.add_field(
        name="� Music Lounge",
        value="`/lounge` — Sinatra radio\n`/dreams` — Sleep & dream waves\n`/focus` — Focus & flow beats\n`/skip` — Skip track\n`/nowplaying` — Current track\n`/volume <0-100>` — Set volume\n`/leave` — Disconnect voice",
        inline=False
    )
    
    # Core (available to all)
    embed.add_field(
        name="🌿 Core",
        value="`/status` — System health\n`/help` — This menu\n`/subscribe` — Upgrade tier\n`/threedoors` — Enter the game",
        inline=False
    )
    
    # Notebook (Supporter+)
    if tier in (ROLE_SUPPORTER, ROLE_DEEP_DREAMER, ROLE_PILOT, ROLE_FOUNDER):
        embed.add_field(
            name="📓 Notebook",
            value="`/dream` — Save a dream\n`/note` — Save a note\n`/wish` — Save a wish\n`/recall` — Search entries\n`/mirror` — View all facets\n`/place` — Save a place\n`/character` — Save a character\n`/symbol` — Save a symbol\n`/wallet` — Subscription status",
            inline=False
        )
    
    # Fleet (Pilot+)
    if tier in (ROLE_PILOT, ROLE_FOUNDER):
        embed.add_field(
            name="🚀 Fleet",
            value="`/converge` — Convergence report\n`/rag-status` — RAG intake status\n`/queue` — Agent fleet queue",
            inline=False
        )
    
    # Founder only
    if tier == ROLE_FOUNDER:
        embed.add_field(
            name="🔐 Founder",
            value="`/dispatch` — Dispatch fleet\n`/controls` — Local controls\n`/boot-check` — Dual boot check\n`/release-gate` — v1.0.0 gate",
            inline=False
        )
    
    embed.set_footer(text="Local-first. Evidence-backed. Lantern OS v2")
    await interaction.response.send_message(embed=embed, ephemeral=True)


@tree.command(name="subscribe", description="View subscription tiers and upgrade options")
async def cmd_subscribe(interaction: discord.Interaction):
    embed = discord.Embed(title="Lantern OS Subscriptions", color=0x0D9488)
    embed.add_field(name="Supporter -- $20/month", value="Weekly digest, report packs, Discord priority.\n[Subscribe](https://buy.stripe.com/test_00g2aRcWk2Xa6OI144)", inline=False)
    embed.add_field(name="Pilot -- $200/month", value="Guided cleanup sprint, 1:1 review, custom integration.\n[Subscribe](https://buy.stripe.com/test_3cs8z42zCeUe4GA288)", inline=False)
    embed.add_field(name="Public -- Free", value="Status, docs, health endpoints. No subscription needed.", inline=False)
    embed.set_footer(text="Payments recorded in the Lantern wallet ledger. Cancel anytime.")
    await interaction.response.send_message(embed=embed, ephemeral=True)


@tree.command(name="sync-roles", description="Sync your Patreon subscriber role to Discord (#697)")
async def cmd_sync_roles(interaction: discord.Interaction):
    """Resolve the linked Patreon web role and grant the matching Discord server role."""
    discord_id = str(interaction.user.id)
    web_role = resolve_web_role(discord_id)
    if not web_role:
        await interaction.response.send_message(
            "No linked Patreon account found.\n\n"
            "To link: sign into the web app at the Patreon OAuth page, then visit **Profile → Link Discord** "
            "and enter your Discord user ID (`" + discord_id + "`). Then run `/sync-roles` again.",
            ephemeral=True,
        )
        return

    # Map web role → Discord server role name
    _WEB_TO_DISCORD: dict[str, str] = {
        "founder":      "founder",
        "deep_dreamer": "Deep Dreamer",
        "pilot":        "Synthesasia Guild",
        "supporter":    "supporter",
    }
    target_role_name = _WEB_TO_DISCORD.get(web_role, web_role)

    guild = interaction.guild
    if guild is None:
        await interaction.response.send_message("This command must be run in a server.", ephemeral=True)
        return

    server_role = discord.utils.find(lambda r: r.name.lower() == target_role_name.lower(), guild.roles)
    if server_role is None:
        await interaction.response.send_message(
            f"Your web role is **{web_role}** but the Discord role `{target_role_name}` doesn't exist on this server. "
            "Ask an admin to create it.",
            ephemeral=True,
        )
        return

    member = guild.get_member(interaction.user.id) or await guild.fetch_member(interaction.user.id)
    if server_role in member.roles:
        await interaction.response.send_message(
            f"✓ You already have **{server_role.name}** — nothing to sync.", ephemeral=True
        )
        return

    try:
        await member.add_roles(server_role, reason="Patreon identity sync via /sync-roles (#697)")
        await interaction.response.send_message(
            f"✓ Role **{server_role.name}** granted based on your linked Patreon account (`{web_role}`).",
            ephemeral=True,
        )
        print(f"[identity-sync] Granted {server_role.name} to {interaction.user} (web_role={web_role})")
    except discord.Forbidden:
        await interaction.response.send_message(
            "I don't have permission to manage roles. Ask a server admin to grant the bot `Manage Roles`.",
            ephemeral=True,
        )


async def _auto_sync_role(member: discord.Member) -> None:
    """Called from on_member_join — grant role if a link already exists."""
    discord_id = str(member.id)
    web_role = resolve_web_role(discord_id)
    if not web_role:
        return
    _WEB_TO_DISCORD: dict[str, str] = {
        "founder":      "founder",
        "deep_dreamer": "Deep Dreamer",
        "pilot":        "Synthesasia Guild",
        "supporter":    "supporter",
    }
    target_role_name = _WEB_TO_DISCORD.get(web_role, web_role)
    guild = member.guild
    server_role = discord.utils.find(lambda r: r.name.lower() == target_role_name.lower(), guild.roles)
    if server_role and server_role not in member.roles:
        try:
            await member.add_roles(server_role, reason="Auto-sync Patreon role on join (#697)")
            print(f"[identity-sync] Auto-granted {server_role.name} to {member} on join (web_role={web_role})")
        except discord.Forbidden:
            pass


@tree.command(name="dream", description="Record a dream to your private notebook")
@app_commands.describe(text="What did you see?")
@require_tier(ROLE_SUPPORTER)
async def cmd_dream(interaction: discord.Interaction, text: str):
    record = append_notebook_entry(interaction.user, "dream", text)
    await interaction.response.send_message(f"Dream saved. ID: `{record['id']}`", ephemeral=True)


@tree.command(name="note", description="Save a note to your private notebook")
@app_commands.describe(text="What do you want to remember?")
@require_tier(ROLE_SUPPORTER)
async def cmd_note(interaction: discord.Interaction, text: str):
    record = append_notebook_entry(interaction.user, "note", text)
    await interaction.response.send_message(f"Note saved. ID: `{record['id']}`", ephemeral=True)


@tree.command(name="wish", description="Record a wish to your private notebook")
@app_commands.describe(text="What do you wish for?")
@require_tier(ROLE_SUPPORTER)
async def cmd_wish(interaction: discord.Interaction, text: str):
    record = append_notebook_entry(interaction.user, "wish", text)
    await interaction.response.send_message(f"Wish saved behind the door. ID: `{record['id']}`", ephemeral=True)


@tree.command(name="recall", description="Search your notebook entries")
@app_commands.describe(query="Search query (empty for latest)")
@require_tier(ROLE_SUPPORTER)
async def cmd_recall(interaction: discord.Interaction, query: Optional[str] = None):
    entries = recall_notebook_entries(interaction.user, query or "", limit=10)
    text = format_recall(entries)
    if len(text) > 1900:
        text = text[:1897] + "..."
    await interaction.response.send_message(f"```{text}```", ephemeral=True)


@tree.command(name="mirror", description="View all your notebook entries")
@require_tier(ROLE_SUPPORTER)
async def cmd_mirror(interaction: discord.Interaction):
    entries = recall_notebook_entries(interaction.user, "", limit=500)
    ids = [e.get("id") for e in entries if e.get("kind") != "mirror" and e.get("id")]
    if not ids:
        await interaction.response.send_message("No facets to mirror yet. Drop something in the well first.", ephemeral=True)
        return
    mirror_text = f"Mirror of {len(ids)} facets"
    record = append_notebook_entry(interaction.user, "mirror", mirror_text)
    await interaction.response.send_message(f"Mirrored {len(ids)} facets. ID: `{record['id']}`", ephemeral=True)


@tree.command(name="wallet", description="View subscription and wallet status")
@require_tier(ROLE_SUPPORTER)
async def cmd_wallet(interaction: discord.Interaction):
    tier = get_user_tier(interaction.user)
    embed = discord.Embed(title="Lantern Wallet", color=0xF59E0B)
    embed.add_field(name="Tier", value=tier.title(), inline=True)
    embed.add_field(name="User", value=str(interaction.user), inline=True)
    embed.add_field(name="Notebook", value=notebook_path(notebook_user_id(interaction.user)).name, inline=False)
    embed.set_footer(text="Local ledger. No bank or crypto wallet.")
    await interaction.response.send_message(embed=embed, ephemeral=True)


@tree.command(name="converge", description="Run convergence loop analysis")
@require_tier(ROLE_PILOT)
async def cmd_converge(interaction: discord.Interaction):
    await interaction.response.send_message("Convergence loop report requested. Check #queue-visibility for results.", ephemeral=True)


@tree.command(name="rag-status", description="Check RAG dollhouse intake status")
@require_tier(ROLE_PILOT)
async def cmd_rag_status(interaction: discord.Interaction):
    await interaction.response.send_message("RAG status: flat-rag-house is current. Use /queue for intake details.", ephemeral=True)


@tree.command(name="queue", description="View agent fleet queue status")
@require_tier(ROLE_PILOT)
async def cmd_queue(interaction: discord.Interaction):
    await interaction.response.send_message("Agent fleet queue is operational. 36 designed ring slots, 64 elastic pool target.", ephemeral=True)


@tree.command(name="place", description="Record a place to your notebook")
@app_commands.describe(text="Describe the place")
@require_tier(ROLE_PILOT)
async def cmd_place(interaction: discord.Interaction, text: str):
    record = append_notebook_entry(interaction.user, "place", text)
    await interaction.response.send_message(f"Place saved. ID: `{record['id']}`", ephemeral=True)


@tree.command(name="character", description="Record a character to your notebook")
@app_commands.describe(text="Describe the character")
@require_tier(ROLE_PILOT)
async def cmd_character(interaction: discord.Interaction, text: str):
    record = append_notebook_entry(interaction.user, "character", text)
    await interaction.response.send_message(f"Character saved. ID: `{record['id']}`", ephemeral=True)


@tree.command(name="symbol", description="Record a symbol to your notebook")
@app_commands.describe(text="Describe the symbol")
@require_tier(ROLE_PILOT)
async def cmd_symbol(interaction: discord.Interaction, text: str):
    record = append_notebook_entry(interaction.user, "symbol", text)
    await interaction.response.send_message(f"Symbol saved. ID: `{record['id']}`", ephemeral=True)


@tree.command(name="dispatch", description="Dispatch agent fleet to task")
@require_tier(ROLE_FOUNDER)
async def cmd_dispatch(interaction: discord.Interaction):
    await interaction.response.send_message("Agent fleet dispatch signal sent. Held until operator confirmation.", ephemeral=True)


@tree.command(name="controls", description="View local controls status")
@require_tier(ROLE_FOUNDER)
async def cmd_controls(interaction: discord.Interaction):
    await interaction.response.send_message("Local controls: held. Require operator-machine auth proof.", ephemeral=True)


@tree.command(name="boot-check", description="Check dual boot readiness")
@require_tier(ROLE_FOUNDER)
async def cmd_boot_check(interaction: discord.Interaction):
    await interaction.response.send_message("Dual boot: held until physical operator action. Windows remains host.", ephemeral=True)


@tree.command(name="release-gate", description="Check v1.0.0 promotion gate status")
@require_tier(ROLE_FOUNDER)
async def cmd_release_gate(interaction: discord.Interaction):
    await interaction.response.send_message("v1.0.0 gate: held. No release without operator approval and evidence.", ephemeral=True)


# -- Lounge slash commands --

@tree.command(name="lounge", description="Join voice and start Sinatra radio")
async def cmd_lounge(interaction: discord.Interaction):
    await interaction.response.defer()
    await _lounge_start(interaction, "sinatra")


@tree.command(name="dreams", description="Play sleep & dream binaural beats")
async def cmd_dreams(interaction: discord.Interaction):
    await interaction.response.defer()
    await _lounge_start(interaction, "dreams")


@tree.command(name="focus", description="Play focus & flow binaural beats")
async def cmd_focus(interaction: discord.Interaction):
    await interaction.response.defer()
    await _lounge_start(interaction, "focus")


@tree.command(name="skip", description="Skip to next track")
async def cmd_skip(interaction: discord.Interaction):
    state = _lounge_state(interaction.guild_id)
    vc = state.voice_client
    if vc and vc.is_playing():
        vc.stop()
        await interaction.response.send_message("⏭️ Skipped.", ephemeral=True)
    else:
        await interaction.response.send_message("Nothing playing in the lounge.", ephemeral=True)


@tree.command(name="leave", description="Stop music and disconnect from voice")
async def cmd_leave(interaction: discord.Interaction):
    state = _lounge_state(interaction.guild_id)
    vc = state.voice_client
    if vc and vc.is_connected():
        if vc.is_playing():
            vc.stop()
        await vc.disconnect()
        state.voice_client = None
        state.current = None
        await interaction.response.send_message("👋 Disconnected.", ephemeral=True)
    else:
        await interaction.response.send_message("Not in a voice channel.", ephemeral=True)


@tree.command(name="nowplaying", description="Show currently playing track")
async def cmd_nowplaying(interaction: discord.Interaction):
    state = _lounge_state(interaction.guild_id)
    if not state.current:
        await interaction.response.send_message(
            "Nothing playing. Try `/lounge`, `/dreams`, or `/focus`.", ephemeral=True
        )
        return
    vc = state.voice_client
    icon = "▶️" if (vc and vc.is_playing()) else "⏸️"
    labels = {"sinatra": "🎙️ Sinatra", "dreams": "🌙 Dreams", "focus": "🧠 Focus"}
    embed = discord.Embed(title=f"{icon} Now Playing", color=0xC9A84C)
    embed.add_field(name="Track", value=state.current.title, inline=False)
    embed.add_field(name="Mode", value=labels.get(state.mode, state.mode), inline=True)
    embed.add_field(name="Volume", value=f"{int(state.volume * 100)}%", inline=True)
    if state.current.duration_secs:
        d = state.current.duration_secs
        embed.add_field(name="Length", value=f"{d // 60}:{d % 60:02d}", inline=True)
    if state.loop:
        embed.set_footer(text="🔁 Loop on")
    await interaction.response.send_message(embed=embed, ephemeral=True)


@tree.command(name="volume", description="Set volume level (0-100)")
@app_commands.describe(level="Volume 0–100")
async def cmd_volume(interaction: discord.Interaction, level: int):
    vol = max(0, min(100, level)) / 100.0
    state = _lounge_state(interaction.guild_id)
    state.volume = vol
    vc = state.voice_client
    if vc and vc.source and hasattr(vc.source, "volume"):
        vc.source.volume = vol  # type: ignore
    await interaction.response.send_message(f"🔊 Volume: {int(vol * 100)}%", ephemeral=True)


# -- Three Doors slash commands --

@tree.command(name="threedoors", description="Enter the Three Doors game")
async def cmd_threedoors(interaction: discord.Interaction):
    state = load_three_doors_state(interaction.user)
    if state is None:
        scene = _THREE_DOORS_SCENES["moss-entry"]
        state = {
            "scene_key": "moss-entry",
            "text": scene["text"],
            "doors": scene["doors"],
            "fox_present": scene["fox_present"],
            "history": ["Entered The Moss Door"],
        }
        save_three_doors_state(interaction.user, state)
        await interaction.response.send_message(
            "The game begins. Three doors await.", embed=_format_three_doors_embed(state)
        )
    else:
        await interaction.response.send_message(embed=_format_three_doors_embed(state))


@tree.command(name="threedoors-choose", description="Choose a door (A, B, or C)")
@app_commands.describe(door="Door name or letter (A, B, C)")
async def cmd_threedoors_choose(interaction: discord.Interaction, door: str):
    state = load_three_doors_state(interaction.user)
    if not state:
        await interaction.response.send_message(
            "No active Three Doors game. Use `/threedoors` to begin.", ephemeral=True
        )
        return
    new_state = _advance_three_doors(state, door)
    if new_state is None:
        await interaction.response.send_message(
            f'"{door}" does not match any door. Choose A, B, C, or the full door name.', ephemeral=True
        )
        return
    save_three_doors_state(interaction.user, new_state)
    await interaction.response.send_message(
        "You chose the door. The path opens...", embed=_format_three_doors_embed(new_state)
    )


# -- Events --

@client.event
async def on_ready():
    print(f"[READY] Logged in as {client.user} (id={client.user.id}) at {now_utc()}")
    guild_list = [f"{g.name} ({g.id})" for g in client.guilds]
    print(f"[GUILDS] In {len(guild_list)} guild(s): {guild_list}")
    asyncio.create_task(_lounge_catalog_init())
    sys.stdout.flush()
    await client.change_presence(
        status=discord.Status.online,
        activity=discord.Activity(type=discord.ActivityType.watching, name="dreams | /help")
    )
    print("[PRESENCE] Set status to online: watching dreams | /help")
    if GUILD_ID_INT:
        guild = discord.Object(id=GUILD_ID_INT)
        tree.copy_global_to(guild=guild)
        try:
            synced = await tree.sync(guild=guild)
            print(f"[SYNC] Synced {len(synced)} slash commands to guild {GUILD_ID_INT}")
        except discord.errors.Forbidden:
            print(f"[WARN] Slash sync 403 Forbidden — bot needs 'applications.commands' scope in guild {GUILD_ID_INT}")
            print("[INFO] Bot is online; prefix commands work. Re-invite with correct scope to enable slash.")
        except Exception as exc:
            print(f"[WARN] Slash sync skipped ({type(exc).__name__}: {exc}) — bot may not be in guild yet.")
            print("[INFO] Add bot to server via invite URL, then restart to sync slash commands.")
    else:
        print("[WARN] No GUILD_ID set; slash commands will not sync. Set LANTERN_DISCORD_GUILD_ID.")
    sys.stdout.flush()


@tree.error
async def on_app_command_error(interaction: discord.Interaction, error: app_commands.AppCommandError):
    """Global slash command error handler — suppress stale-interaction noise, surface real errors."""
    orig = getattr(error, "original", error)
    # 10062 = Unknown Interaction (expired >3s window) — transient, nothing to do
    if isinstance(orig, discord.NotFound) and orig.code == 10062:
        return
    # 40060 = Interaction already acknowledged — race condition, safe to ignore
    if isinstance(orig, discord.HTTPException) and orig.code == 40060:
        return
    # CheckFailure means require_tier already sent a response — ignore
    if isinstance(error, app_commands.errors.CheckFailure):
        return
    print(f"[SLASH ERROR] {type(orig).__name__}: {orig}")
    try:
        if not interaction.response.is_done():
            await interaction.response.send_message("Something went wrong. Try again.", ephemeral=True)
        else:
            await interaction.followup.send("Something went wrong. Try again.", ephemeral=True)
    except Exception:
        pass


@client.event
async def on_member_join(member: discord.Member):
    """Welcome new members; auto-grant role if Patreon link already exists (#697)."""
    await _auto_sync_role(member)
    try:
        await member.send(
            f"Welcome to Lantern OS, {member.display_name}!\n\n"
            "Available commands:\n"
            "- `/status` -- Health check\n"
            "- `/help` -- List commands for your tier\n"
            "- `/subscribe` -- Upgrade to Supporter or Pilot\n"
            "- `!threedoors` -- Play the Three Doors game\n\n"
            "Public tier is free. Supporter ($20/mo) unlocks dreamer commands. Pilot ($200/mo) unlocks workspace commands."
        )
    except discord.Forbidden:
        pass


@client.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return

    content = (message.content or "").strip()
    if not content:
        return
    lower = content.lower()

    async def reply(text: str = None, **kwargs):
        try:
            await message.channel.send(text, **kwargs)
        except discord.Forbidden:
            try:
                await message.author.send(
                    f"I can't send messages in that channel. Here's your reply:\n\n{text or ''}"
                )
            except discord.Forbidden:
                pass

    # -- Three Doors prefix commands --
    if lower.startswith("!threedoors") or lower.startswith("!three-doors"):
        state = load_three_doors_state(message.author)
        if state is None:
            scene = _THREE_DOORS_SCENES["moss-entry"]
            state = {
                "scene_key": "moss-entry",
                "text": scene["text"],
                "doors": scene["doors"],
                "fox_present": scene["fox_present"],
                "history": ["Entered The Moss Door"],
            }
            save_three_doors_state(message.author, state)
            await reply(
                "The game begins. Three doors await.", embed=_format_three_doors_embed(state)
            )
        else:
            await reply(embed=_format_three_doors_embed(state))
        return

    if lower.startswith("!choose ") or lower.startswith("!pick ") or lower.startswith("!door "):
        door_arg = content.split(None, 1)[1].strip()
        state = load_three_doors_state(message.author)
        if not state:
            await reply("No active game. Start with `!threedoors`.")
            return
        new_state = _advance_three_doors(state, door_arg)
        if new_state is None:
            await reply(
                f'"{door_arg}" does not match any door. Try A, B, C, or the door name.'
            )
            return
        save_three_doors_state(message.author, new_state)
        await reply(
            "You chose the door. The path opens...", embed=_format_three_doors_embed(new_state)
        )
        return

    # -- Classic v1 prefix commands --
    if lower.startswith("!dream "):
        text = content[7:].strip()
        if text:
            record = append_notebook_entry(message.author, "dream", text)
            await reply(f"Dream saved. ID: `{record['id']}`")
        else:
            await reply("Usage: `!dream <text>`")
        return

    if lower.startswith("!note "):
        text = content[6:].strip()
        if text:
            record = append_notebook_entry(message.author, "note", text)
            await reply(f"Note saved. ID: `{record['id']}`")
        else:
            await reply("Usage: `!note <text>`")
        return

    if lower.startswith("!wish ") or lower == "!wish":
        text = content[6:].strip() if lower.startswith("!wish ") else ""
        if text:
            record = append_notebook_entry(message.author, "wish", text)
            await reply(f"Wish saved behind the door. ID: `{record['id']}`")
        else:
            await reply("Usage: `!wish <text>`")
        return

    if lower.startswith("!recall"):
        query = content[7:].strip() if len(content) > 7 else ""
        entries = recall_notebook_entries(message.author, query, limit=5)
        result = format_recall(entries)
        if len(result) > 1900:
            result = result[:1897] + "..."
        await reply(f"```{result}```")
        return

    if lower == "!status":
        tier = get_user_tier(message.author) if isinstance(message.author, discord.Member) else "public"
        await reply(
            f"**Lantern OS Status**\n"
            f"Time: {now_utc()}\n"
            f"Service: lantern-garage\n"
            f"Tier: {tier.title()}"
        )
        return

    if lower == "!help":
        tier = get_user_tier(message.author) if isinstance(message.author, discord.Member) else ROLE_PUBLIC
        lines = [
            "**Lantern OS — Text Commands**",
            "```",
            "!threedoors        — Enter the Three Doors dream game",
            "!choose A|B|C      — Choose a door (also !pick, !door)",
            "!dream  <text>     — Save a dream to your notebook",
            "!note   <text>     — Save a note",
            "!wish   <text>     — Save a wish",
            "!recall [query]    — Search your notebook",
            "!mirror            — Mirror all notebook facets",
            "!wallet            — Check your tier and notebook",
            "!status            — Lantern OS health check",
            "!subscribe         — Subscription info",
            "!help              — This message",
            "!lounge-help       — Voice/music commands",
            "```",
            "**Slash commands:** `/status` `/help` `/dream` `/note` `/wish` `/recall` `/threedoors` `/threedoors-choose` `/subscribe` `/wallet` `/mirror` `/lounge` `/dreams` `/focus` `/skip` `/leave` `/nowplaying` `/volume`",
            f"*Your tier: {_tier_display(tier)}*",
        ]
        await reply("\n".join(lines))
        return

    if lower == "!subscribe":
        await reply(
            "**Lantern OS Subscriptions**\n"
            "🌿 **Supporter — $20/month:** Weekly digest, report packs, Discord priority.\n"
            "🚀 **Pilot — $200/month:** Guided cleanup sprint, 1:1 review, custom integration.\n"
            "🔓 **Public — Free:** Status, docs, Three Doors game.\n\n"
            "Use `/subscribe` for secure checkout links."
        )
        return

    if lower == "!mirror":
        entries = recall_notebook_entries(message.author, "", limit=500)
        ids = [e.get("id") for e in entries if e.get("kind") != "mirror" and e.get("id")]
        if not ids:
            await reply("No facets to mirror yet. Drop something in the well first.")
            return
        mirror_text = f"Mirror of {len(ids)} facets"
        record = append_notebook_entry(message.author, "mirror", mirror_text)
        await reply(f"Mirrored {len(ids)} facets. ID: `{record['id']}`")
        return

    if lower == "!wallet":
        tier = get_user_tier(message.author) if isinstance(message.author, discord.Member) else ROLE_PUBLIC
        await reply(
            f"**Lantern Wallet**\n"
            f"User: {message.author}\n"
            f"Tier: {tier.title()}\n"
            f"Notebook: `{notebook_path(notebook_user_id(message.author)).name}`"
        )
        return

    # -- Lounge voice commands --

    if lower in ("!lounge", "!sinatra"):
        await _lounge_start(message, "sinatra")
        return

    if lower in ("!dreams", "!dream-mode", "!binaural-dreams"):
        await _lounge_start(message, "dreams")
        return

    if lower in ("!focus", "!binaural-focus"):
        await _lounge_start(message, "focus")
        return

    if lower in ("!skip", "!s", "!next"):
        state = _lounge_state(message.guild.id)
        vc = state.voice_client
        if vc and vc.is_playing():
            vc.stop()
            await message.add_reaction("⏭️")
        else:
            await reply("Nothing playing in the lounge.")
        return

    if lower in ("!stop", "!pause"):
        state = _lounge_state(message.guild.id)
        vc = state.voice_client
        if vc and vc.is_playing():
            vc.pause()
            await reply("⏸️ Paused. `!resume` to continue.")
        else:
            await reply("Nothing playing.")
        return

    if lower in ("!resume", "!unpause"):
        state = _lounge_state(message.guild.id)
        vc = state.voice_client
        if vc and vc.is_paused():
            vc.resume()
            await message.add_reaction("▶️")
        else:
            await reply("Nothing paused.")
        return

    if lower in ("!leave", "!bye", "!disconnect"):
        state = _lounge_state(message.guild.id)
        vc = state.voice_client
        if vc and vc.is_connected():
            if vc.is_playing():
                vc.stop()
            await vc.disconnect()
            state.voice_client = None
            state.current = None
            await reply("👋 Disconnected from voice.")
        else:
            await reply("Not in a voice channel.")
        return

    if lower in ("!np", "!nowplaying", "!now"):
        state = _lounge_state(message.guild.id)
        if state.current:
            vc = state.voice_client
            icon = "▶️" if (vc and vc.is_playing()) else "⏸️"
            labels = {"sinatra": "🎙️ Sinatra", "dreams": "🌙 Dreams", "focus": "🧠 Focus"}
            dur = (f" `{state.current.duration_secs // 60}:{state.current.duration_secs % 60:02d}`"
                   if state.current.duration_secs else "")
            loop_str = " 🔁" if state.loop else ""
            await reply(
                f"{icon}{dur}{loop_str} {state.current.label()}\n"
                f"Mode: {labels.get(state.mode, state.mode)}  Volume: {int(state.volume * 100)}%"
            )
        else:
            await reply("Nothing playing. Try `!lounge`, `!dreams`, or `!focus`.")
        return

    if lower.startswith("!volume ") or lower.startswith("!vol "):
        parts = lower.split()
        if len(parts) >= 2 and parts[1].isdigit():
            vol = max(0, min(100, int(parts[1]))) / 100.0
            state = _lounge_state(message.guild.id)
            state.volume = vol
            vc = state.voice_client
            if vc and vc.source and hasattr(vc.source, "volume"):
                vc.source.volume = vol  # type: ignore
            await reply(f"🔊 Volume: {int(vol * 100)}%")
        else:
            await reply("Usage: `!volume 0-100`")
        return

    if lower in ("!loop", "!repeat"):
        state = _lounge_state(message.guild.id)
        state.loop = not state.loop
        await reply(f"🔁 Loop {'ON' if state.loop else 'OFF'}")
        return

    if lower == "!lounge-help":
        await reply(
            "**🎙️ Lounge Commands**\n```"
            "!lounge / !sinatra   — Sinatra radio\n"
            "!dreams              — binaural sleep beats\n"
            "!focus               — binaural focus beats\n"
            "!skip / !s           — skip track\n"
            "!stop / !resume      — pause/resume\n"
            "!leave / !bye        — disconnect\n"
            "!np                  — now playing\n"
            "!volume 0-100        — volume\n"
            "!loop                — toggle loop\n"
            "```"
        )
        return


@client.event
async def on_voice_state_update(
    member: discord.Member, before: discord.VoiceState, after: discord.VoiceState
):
    """Auto-disconnect from voice if the bot is left alone for 30 seconds."""
    if member.bot:
        return
    guild_id = member.guild.id
    state = _lounge_state(guild_id)
    vc = state.voice_client
    if vc and vc.is_connected():
        human_members = [m for m in vc.channel.members if not m.bot]
        if not human_members:
            await asyncio.sleep(30)
            vc = state.voice_client
            if vc and vc.is_connected():
                if not [m for m in vc.channel.members if not m.bot]:
                    if vc.is_playing():
                        vc.stop()
                    await vc.disconnect()
                    state.voice_client = None
                    if state.text_channel:
                        await state.text_channel.send("🌙 Channel empty — Lantern Lounge disconnected.")


# -- Main --

def main():
    _validate_config()
    print("[INFO] Starting Lantern OS Discord Bot v2...")
    print("[INFO] Slash commands + role gating + notebook integration + Three Doors.")
    print("[INFO] Prefix commands: !threedoors !choose !pick !door !dream !note !wish !recall !mirror !wallet !status !help !subscribe")
    print("[INFO] No secrets are printed. Stop with Ctrl+C.")
    client.run(TOKEN)


if __name__ == "__main__":
    main()
