"""Tests for the Discord-side account-link resolver (#697).

Writes temp index.jsonl + account-links.jsonl mirroring the web store and asserts a
Discord snowflake resolves to the linked web role.
"""
import json

from src.discord_lounge_bot import account_link


def _write(root, profiles_dir):
    profiles_dir.mkdir(parents=True, exist_ok=True)
    (profiles_dir / "index.jsonl").write_text(
        json.dumps({"id": "49294581", "role": "deep_dreamer", "discordId": "123"}) + "\n",
        encoding="utf-8",
    )
    (profiles_dir / "account-links.jsonl").write_text(
        json.dumps({"patreonId": "49294581", "discordId": "123", "linkedAt": "2026-06-19T00:00:00Z"}) + "\n",
        encoding="utf-8",
    )


def test_resolve_web_role(tmp_path):
    _write(tmp_path, tmp_path / "data" / "profiles")
    assert account_link.resolve_web_role("123", repo_root=tmp_path) == "deep_dreamer"


def test_get_profile_by_discord_id(tmp_path):
    _write(tmp_path, tmp_path / "data" / "profiles")
    prof = account_link.get_profile_by_discord_id("123", repo_root=tmp_path)
    assert prof is not None and prof["id"] == "49294581"


def test_unknown_discord_id_is_none(tmp_path):
    _write(tmp_path, tmp_path / "data" / "profiles")
    assert account_link.resolve_web_role("999", repo_root=tmp_path) is None


def test_latest_link_wins(tmp_path):
    profiles_dir = tmp_path / "data" / "profiles"
    profiles_dir.mkdir(parents=True, exist_ok=True)
    (profiles_dir / "index.jsonl").write_text(
        json.dumps({"id": "A", "role": "supporter"}) + "\n"
        + json.dumps({"id": "B", "role": "admin"}) + "\n",
        encoding="utf-8",
    )
    (profiles_dir / "account-links.jsonl").write_text(
        json.dumps({"patreonId": "A", "discordId": "777"}) + "\n"
        + json.dumps({"patreonId": "B", "discordId": "777"}) + "\n",
        encoding="utf-8",
    )
    assert account_link.resolve_web_role("777", repo_root=tmp_path) == "admin"
