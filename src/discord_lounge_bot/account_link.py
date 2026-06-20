"""
Resolve a Discord identity to its linked web (Patreon) profile/role (#697).

The web side (apps/lantern-garage/lib/user-profiles.js) maintains two append-only
JSONL stores under data/profiles/:
  index.jsonl         — profile records keyed by Patreon id (latest record wins)
  account-links.jsonl — {patreonId, discordId, linkedAt} link records (latest wins)

This helper is the read side for the Discord bot: given a Discord snowflake it finds
the newest link, then the newest profile, and returns the web role. No write side here
(linking is done from the authenticated web session); and actually granting/removing a
Discord guild role still requires a live bot token + manage_roles in the guild, which is
out of scope for this file.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

# repo_root/src/discord_lounge_bot/account_link.py -> repo_root
_DEFAULT_ROOT = Path(__file__).resolve().parents[2]


def _profiles_dir(repo_root: Optional[Path] = None) -> Path:
    return (Path(repo_root) if repo_root else _DEFAULT_ROOT) / "data" / "profiles"


def _latest(jsonl_path: Path, match_key: str, match_val: str) -> Optional[dict]:
    """Return the last record in jsonl_path whose record[match_key] == match_val."""
    if not jsonl_path.exists():
        return None
    latest = None
    for line in jsonl_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if str(rec.get(match_key)) == str(match_val):
            latest = rec
    return latest


def get_link(discord_id: str, repo_root: Optional[Path] = None) -> Optional[dict]:
    """Newest {patreonId, discordId, linkedAt} link for a Discord id, or None."""
    return _latest(_profiles_dir(repo_root) / "account-links.jsonl", "discordId", discord_id)


def get_profile_by_discord_id(discord_id: str, repo_root: Optional[Path] = None) -> Optional[dict]:
    """Resolve a Discord id to its linked web profile record, or None."""
    link = get_link(discord_id, repo_root)
    if not link:
        return None
    return _latest(_profiles_dir(repo_root) / "index.jsonl", "id", link["patreonId"])


def resolve_web_role(discord_id: str, repo_root: Optional[Path] = None) -> Optional[str]:
    """Return the linked web role for a Discord id (e.g. 'deep_dreamer'), or None."""
    profile = get_profile_by_discord_id(discord_id, repo_root)
    return profile.get("role") if profile else None
