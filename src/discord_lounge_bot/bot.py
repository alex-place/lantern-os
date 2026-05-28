"""
Lantern Discord Lounge Bot

Status-only bot for one allowlisted channel:
- posts startup status in the configured channel;
- replies to !lantern-status with a safe health summary;
- ignores all other channels.
"""

import os
import sys
from datetime import datetime, timezone

try:
    import discord
except Exception as exc:
    print(f"[FATAL] Missing dependency 'discord.py': {exc}")
    print("Install with: pip install discord.py")
    sys.exit(1)


TOKEN = os.getenv("DISCORD_BOT_TOKEN", "").strip()
GUILD_ID = os.getenv("LANTERN_DISCORD_GUILD_ID", "").strip()
CHANNEL_ID = os.getenv("LANTERN_DISCORD_CHANNEL_ID", "").strip()
STATUS_URL = os.getenv("LANTERN_STATUS_URL", "http://127.0.0.1:5001/api/status").strip()

if not TOKEN:
    print("[FATAL] Missing DISCORD_BOT_TOKEN")
    sys.exit(1)
if not GUILD_ID:
    print("[FATAL] Missing LANTERN_DISCORD_GUILD_ID")
    sys.exit(1)
if not CHANNEL_ID:
    print("[FATAL] Missing LANTERN_DISCORD_CHANNEL_ID")
    sys.exit(1)

try:
    GUILD_ID_INT = int(GUILD_ID)
    CHANNEL_ID_INT = int(CHANNEL_ID)
except ValueError:
    print("[FATAL] Guild/channel IDs must be numeric Discord snowflakes.")
    sys.exit(1)

intents = discord.Intents.default()
intents.guilds = True
intents.messages = True
intents.message_content = True

client = discord.Client(intents=intents)


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def status_text() -> str:
    return (
        "Lantern lounge bot online.\n"
        f"- time: {now_utc()}\n"
        f"- guild: {GUILD_ID_INT}\n"
        f"- channel: {CHANNEL_ID_INT}\n"
        f"- local status endpoint: {STATUS_URL}\n"
        "- command: !lantern-status"
    )


@client.event
async def on_ready():
    print(f"[READY] Logged in as {client.user} at {now_utc()}")
    channel = client.get_channel(CHANNEL_ID_INT)
    if channel is None:
        print("[WARN] Configured channel was not found in cache. Check bot permissions and IDs.")
        return
    try:
        await channel.send(status_text())
    except Exception as exc:
        print(f"[WARN] Failed to send startup status message: {exc}")


@client.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return
    if message.channel.id != CHANNEL_ID_INT:
        return
    if message.content.strip().lower() == "!lantern-status":
        await message.reply(status_text())


def main():
    print("[INFO] Starting Lantern Discord lounge bot...")
    print("[INFO] No secrets are printed. Stop with Ctrl+C.")
    client.run(TOKEN)


if __name__ == "__main__":
    main()
