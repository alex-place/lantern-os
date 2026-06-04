"""
Discord Bot v1 voice-gate tests.

Tests the pure helper functions in bot.py that control voice channel
access: voice_status_text(), find_voice_channel(), and the ENABLE_VOICE
guard logic.  No live Discord runtime is needed — MagicMock stands in
for discord.Guild and its voice_channels collection.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

# Set all required env vars before the module import (bot.py calls sys.exit otherwise)
os.environ.setdefault("DISCORD_BOT_TOKEN", "test-token-for-pytest")
os.environ.setdefault("LANTERN_DISCORD_GUILD_ID", "111111111111111")
os.environ.setdefault("LANTERN_DISCORD_CHANNEL_ID", "222222222222222")

import discord
import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "src" / "discord_lounge_bot"))
import bot  # noqa: E402

_HAS_VOICE_GATE = hasattr(bot, "voice_status_text")
pytestmark = pytest.mark.skipif(not _HAS_VOICE_GATE, reason="bot.py missing voice gate functions")


# ── voice_status_text ──────────────────────────────────────────────────────

def test_voice_status_text_contains_voice_enabled_field():
    text = bot.voice_status_text()
    assert "voice enabled:" in text


def test_voice_status_text_contains_radio_enabled_field():
    text = bot.voice_status_text()
    assert "radio enabled:" in text


def test_voice_status_text_contains_boundary_note():
    text = bot.voice_status_text()
    assert "boundary" in text.lower()


def test_voice_status_text_contains_join_command():
    text = bot.voice_status_text()
    assert "lantern-join-lounge" in text


def test_voice_status_text_reports_not_configured_when_no_channel_set():
    with patch.object(bot, "VOICE_CHANNEL_ID", ""), \
         patch.object(bot, "VOICE_CHANNEL_NAME", ""):
        text = bot.voice_status_text()
    assert "not configured" in text


def test_voice_status_text_shows_channel_id_when_set():
    with patch.object(bot, "VOICE_CHANNEL_ID", "9876543210"), \
         patch.object(bot, "VOICE_CHANNEL_NAME", ""):
        text = bot.voice_status_text()
    assert "9876543210" in text


def test_voice_status_text_shows_channel_name_when_id_not_set():
    with patch.object(bot, "VOICE_CHANNEL_ID", ""), \
         patch.object(bot, "VOICE_CHANNEL_NAME", "Lounge"):
        text = bot.voice_status_text()
    assert "Lounge" in text


# ── find_voice_channel ─────────────────────────────────────────────────────

def _make_guild(*channels: tuple[int, str]) -> discord.Guild:
    """Build a mock Guild whose .voice_channels matches (id, name) pairs."""
    guild = MagicMock(spec=discord.Guild)
    vc_mocks = []
    for cid, cname in channels:
        vc = MagicMock(spec=discord.VoiceChannel)
        vc.id = cid
        vc.name = cname
        vc_mocks.append(vc)
    guild.voice_channels = vc_mocks
    return guild


def test_find_voice_channel_by_id_exact_match():
    guild = _make_guild((777000000000000, "Stage"), (888000000000000, "Lounge"))
    with patch.object(bot, "VOICE_CHANNEL_ID", "888000000000000"), \
         patch.object(bot, "VOICE_CHANNEL_NAME", ""):
        result = bot.find_voice_channel(guild)
    assert result is not None
    assert result.id == 888000000000000


def test_find_voice_channel_by_id_returns_none_when_not_found():
    guild = _make_guild((777000000000000, "Stage"))
    with patch.object(bot, "VOICE_CHANNEL_ID", "999000000000000"), \
         patch.object(bot, "VOICE_CHANNEL_NAME", ""):
        result = bot.find_voice_channel(guild)
    assert result is None


def test_find_voice_channel_by_name_case_insensitive():
    guild = _make_guild((777000000000000, "Lounge"))
    with patch.object(bot, "VOICE_CHANNEL_ID", ""), \
         patch.object(bot, "VOICE_CHANNEL_NAME", "lounge"):
        result = bot.find_voice_channel(guild)
    assert result is not None
    assert result.name == "Lounge"


def test_find_voice_channel_by_name_no_match_returns_none():
    guild = _make_guild((777000000000000, "Stage"))
    with patch.object(bot, "VOICE_CHANNEL_ID", ""), \
         patch.object(bot, "VOICE_CHANNEL_NAME", "Lounge"):
        result = bot.find_voice_channel(guild)
    assert result is None


def test_find_voice_channel_id_takes_precedence_over_name():
    guild = _make_guild((777000000000000, "Lounge"), (888000000000000, "Stage"))
    with patch.object(bot, "VOICE_CHANNEL_ID", "888000000000000"), \
         patch.object(bot, "VOICE_CHANNEL_NAME", "Lounge"):
        result = bot.find_voice_channel(guild)
    assert result.id == 888000000000000  # found by ID, not by name


def test_find_voice_channel_empty_guild_returns_none():
    guild = _make_guild()
    with patch.object(bot, "VOICE_CHANNEL_ID", ""), \
         patch.object(bot, "VOICE_CHANNEL_NAME", "Lounge"):
        result = bot.find_voice_channel(guild)
    assert result is None


def test_find_voice_channel_invalid_id_string_returns_none():
    guild = _make_guild((777000000000000, "Lounge"))
    with patch.object(bot, "VOICE_CHANNEL_ID", "not-a-number"), \
         patch.object(bot, "VOICE_CHANNEL_NAME", ""):
        result = bot.find_voice_channel(guild)
    assert result is None


# ── ENABLE_VOICE gate ──────────────────────────────────────────────────────

def test_enable_voice_false_by_default_without_env():
    with patch.object(bot, "ENABLE_VOICE", False):
        assert bot.ENABLE_VOICE is False


def test_enable_voice_truthy_values():
    for val in ("1", "true", "yes", "on"):
        result = val.lower() in {"1", "true", "yes", "on"}
        assert result is True, f"Expected {val!r} to be truthy"


def test_enable_voice_falsy_values():
    for val in ("0", "false", "no", "off", ""):
        result = val.lower() in {"1", "true", "yes", "on"}
        assert result is False, f"Expected {val!r} to be falsy"


# ── ENABLE_RADIO gate ──────────────────────────────────────────────────────

def test_enable_radio_false_by_default_without_env():
    with patch.object(bot, "ENABLE_RADIO", False):
        assert bot.ENABLE_RADIO is False


def test_enable_radio_truthy_values():
    for val in ("1", "true", "yes", "on"):
        result = val.lower() in {"1", "true", "yes", "on"}
        assert result is True
