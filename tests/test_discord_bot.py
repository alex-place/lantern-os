"""
Discord Bot v2 tests — uses dpytest (discord.ext.test) as the OSS bot test
framework, with pytest-asyncio for coroutine support and unittest.mock for
interaction mocking.

OSS test framework: https://github.com/CraftSpider/dpytest (installed as
discord.ext.test, imported below).
"""

from __future__ import annotations

import os
import re
import sys
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# Set required env vars before bot module imports (it calls sys.exit otherwise)
os.environ.setdefault("DISCORD_BOT_TOKEN", "test-token-for-pytest")
os.environ.setdefault("LANTERN_DISCORD_GUILD_ID", "111111111111111")

# OSS Discord bot test framework (dpytest)
from discord.ext import test as dpytest  # noqa: F401 — pulled in for test env

import discord
import pytest

# Add bot directory to path
sys.path.insert(0, str(Path(__file__).parents[1] / "src" / "discord_lounge_bot"))
try:
    import bot_v2  # noqa: E402
except ModuleNotFoundError:
    bot_v2 = None

pytestmark = pytest.mark.skipif(bot_v2 is None, reason="bot_v2 module not found")


# ── Pure-function tests (no Discord runtime needed) ────────────────────────

def test_now_utc_iso8601_format():
    result = bot_v2.now_utc()
    assert re.match(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", result), \
        f"Unexpected format: {result}"


def test_notebook_user_id_prefixes_discord():
    user = MagicMock()
    user.id = 123456789
    assert bot_v2.notebook_user_id(user) == "discord-123456789"


def test_notebook_path_returns_jsonl():
    p = bot_v2.notebook_path("discord-123456789")
    assert p.name == "discord-123456789.jsonl"
    assert p.suffix == ".jsonl"


def test_notebook_path_sanitizes_special_chars():
    p = bot_v2.notebook_path("discord-user with spaces/and+symbols!")
    assert "/" not in p.name
    assert " " not in p.name


def test_generate_entry_id_is_valid_uuid():
    eid = bot_v2.generate_entry_id()
    uuid.UUID(eid)  # raises ValueError if not valid UUID


def test_generate_entry_id_unique():
    ids = {bot_v2.generate_entry_id() for _ in range(20)}
    assert len(ids) == 20


def test_generate_ternary_id_length_and_charset():
    tid = bot_v2.generate_ternary_id("deterministic-seed")
    assert len(tid) == 12
    assert all(c in "012" for c in tid), f"Non-ternary chars in {tid!r}"


def test_generate_ternary_id_deterministic():
    a = bot_v2.generate_ternary_id("same-seed")
    b = bot_v2.generate_ternary_id("same-seed")
    assert a == b


# ── Role tier tests ────────────────────────────────────────────────────────

def _member_with_roles(*role_names: str) -> discord.Member:
    member = MagicMock(spec=discord.Member)
    roles = []
    for name in role_names:
        r = MagicMock()
        r.name = name
        roles.append(r)
    member.roles = roles
    return member


def test_get_user_tier_founder():
    assert bot_v2.get_user_tier(_member_with_roles("Founder")) == "founder"


def test_get_user_tier_pilot():
    assert bot_v2.get_user_tier(_member_with_roles("Pilot")) == "pilot"


def test_get_user_tier_supporter():
    assert bot_v2.get_user_tier(_member_with_roles("Supporter")) == "supporter"


def test_get_user_tier_public_with_no_special_roles():
    assert bot_v2.get_user_tier(_member_with_roles("Member")) == "@everyone"


def test_get_user_tier_founder_wins_over_pilot():
    member = _member_with_roles("Pilot", "Founder")
    assert bot_v2.get_user_tier(member) == "founder"


# ── format_recall tests ────────────────────────────────────────────────────

def test_format_recall_empty_returns_no_match_message():
    result = bot_v2.format_recall([])
    assert "No matching" in result


def test_format_recall_includes_kind_and_text():
    entries = [{"kind": "dream", "text": "flying over the city", "recordedAt": "2026-01-01T00:00:00Z"}]
    result = bot_v2.format_recall(entries)
    assert "dream" in result
    assert "flying over the city" in result


def test_format_recall_truncates_long_text():
    long_text = "x" * 300
    entries = [{"kind": "note", "text": long_text, "recordedAt": "2026-01-01T00:00:00Z"}]
    result = bot_v2.format_recall(entries)
    assert "..." in result


# ── Notebook write/read integration ───────────────────────────────────────

def _mock_user(user_id: int = 999) -> discord.Member:
    user = MagicMock(spec=discord.Member)
    user.id = user_id
    user.__str__ = lambda self: f"testuser#{user_id}"
    return user


def test_append_notebook_entry_returns_record(tmp_path, monkeypatch):
    monkeypatch.setattr(bot_v2, "DREAMER_NOTEBOOK_DIR", tmp_path)
    user = _mock_user(42)

    record = bot_v2.append_notebook_entry(user, "dream", "I was flying")

    assert record["kind"] == "dream"
    assert record["text"] == "I was flying"
    assert record["source"] == "discord"
    assert record["private"] is True
    uuid.UUID(record["id"])  # valid UUID
    assert len(record["ternaryId"]) == 12


def test_append_notebook_entry_persists_to_disk(tmp_path, monkeypatch):
    monkeypatch.setattr(bot_v2, "DREAMER_NOTEBOOK_DIR", tmp_path)
    user = _mock_user(43)

    bot_v2.append_notebook_entry(user, "note", "remember this")

    user_id = bot_v2.notebook_user_id(user)
    path = tmp_path / f"{user_id}.jsonl"
    assert path.exists()
    assert "remember this" in path.read_text()


def test_append_notebook_entry_rejects_empty_text(tmp_path, monkeypatch):
    monkeypatch.setattr(bot_v2, "DREAMER_NOTEBOOK_DIR", tmp_path)
    user = _mock_user(44)
    with pytest.raises(ValueError, match="text_required"):
        bot_v2.append_notebook_entry(user, "note", "   ")


def test_recall_returns_empty_when_no_notebook(tmp_path, monkeypatch):
    monkeypatch.setattr(bot_v2, "DREAMER_NOTEBOOK_DIR", tmp_path)
    user = _mock_user(45)
    entries = bot_v2.recall_notebook_entries(user, "anything")
    assert entries == []


def test_recall_finds_matching_entries(tmp_path, monkeypatch):
    monkeypatch.setattr(bot_v2, "DREAMER_NOTEBOOK_DIR", tmp_path)
    user = _mock_user(46)
    bot_v2.append_notebook_entry(user, "dream", "flying over the city")
    bot_v2.append_notebook_entry(user, "note", "buy milk")

    results = bot_v2.recall_notebook_entries(user, "flying")
    assert len(results) == 1
    assert results[0]["text"] == "flying over the city"


def test_recall_respects_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(bot_v2, "DREAMER_NOTEBOOK_DIR", tmp_path)
    user = _mock_user(47)
    for i in range(10):
        bot_v2.append_notebook_entry(user, "note", f"entry {i}")

    results = bot_v2.recall_notebook_entries(user, "", limit=3)
    assert len(results) == 3


# ── Slash command handler tests (async, pytest-asyncio) ───────────────────

@pytest.mark.asyncio
async def test_cmd_status_sends_embed():
    interaction = AsyncMock(spec=discord.Interaction)
    interaction.user = _member_with_roles()
    interaction.response = AsyncMock()

    # app_commands.Command — call the underlying coroutine via .callback
    await bot_v2.cmd_status.callback(interaction)

    interaction.response.send_message.assert_awaited_once()
    embed = interaction.response.send_message.call_args.kwargs.get("embed")
    assert embed is not None
    assert embed.title == "Lantern OS Status"


@pytest.mark.asyncio
async def test_cmd_help_sends_ephemeral():
    interaction = AsyncMock(spec=discord.Interaction)
    interaction.user = _member_with_roles()
    interaction.response = AsyncMock()

    await bot_v2.cmd_help.callback(interaction)

    call_kwargs = interaction.response.send_message.call_args.kwargs
    assert call_kwargs.get("ephemeral") is True
    assert call_kwargs.get("embed") is not None


@pytest.mark.asyncio
async def test_cmd_subscribe_sends_tier_info():
    interaction = AsyncMock(spec=discord.Interaction)
    interaction.user = _member_with_roles()
    interaction.response = AsyncMock()

    await bot_v2.cmd_subscribe.callback(interaction)

    call_kwargs = interaction.response.send_message.call_args.kwargs
    embed = call_kwargs.get("embed")
    assert embed is not None
    field_names = " ".join(f.name for f in embed.fields).lower()
    assert "supporter" in field_names or "pilot" in field_names


@pytest.mark.asyncio
async def test_cmd_dream_saves_entry(tmp_path, monkeypatch):
    monkeypatch.setattr(bot_v2, "DREAMER_NOTEBOOK_DIR", tmp_path)

    interaction = AsyncMock(spec=discord.Interaction)
    interaction.user = _mock_user(888)
    interaction.response = AsyncMock()

    await bot_v2.cmd_dream.callback(interaction, text="giant waves")

    interaction.response.send_message.assert_awaited_once()
    reply = interaction.response.send_message.call_args.args[0] if \
        interaction.response.send_message.call_args.args else \
        interaction.response.send_message.call_args.kwargs.get("content", "")
    assert "Dream saved" in reply or "saved" in reply.lower()


# ── require_tier gate tests ────────────────────────────────────────────────

def test_require_tier_returns_callable_decorator():
    decorator = bot_v2.require_tier("supporter")
    assert callable(decorator)


def test_require_tier_decorated_function_is_callable():
    async def _stub(interaction):
        pass

    decorated = bot_v2.require_tier("supporter")(_stub)
    assert callable(decorated)


def test_require_tier_debug_mode_preserves_function():
    """In debug mode require_tier is a noop — the wrapped function is unchanged."""
    async def _stub(interaction):
        pass

    decorated = bot_v2.require_tier("founder")(_stub)
    assert decorated is _stub


@pytest.mark.asyncio
async def test_require_tier_debug_mode_does_not_block_any_user():
    """In debug mode all tiers are unlocked — decorated command runs for anyone."""
    called = []

    async def _stub(interaction):
        called.append(True)

    decorated = bot_v2.require_tier("founder")(_stub)

    interaction = AsyncMock(spec=discord.Interaction)
    interaction.user = _member_with_roles("Member")
    await decorated(interaction)

    assert called, "Command should have executed (debug mode — no tier gate)"
