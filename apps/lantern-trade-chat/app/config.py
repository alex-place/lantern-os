"""Runtime configuration for the Lantern trading chat app.

Everything sensitive (Kalshi keys, OAuth secrets, allowlist) comes from the
environment. Nothing is read from the repo. Defaults are intentionally safe:
- live trading OFF unless LANTERN_LIVE_ENABLED is explicitly truthy
- demo environment unless KALSHI_ENVIRONMENT=prod
- conservative per-order / per-day / trades-per-day caps
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


# Kalshi REST bases. The demo environment is the safe default.
KALSHI_BASES = {
    "demo": "https://demo-api.kalshi.co",
    "prod": "https://api.elections.kalshi.com",
}

def _data_dir() -> Path:
    """Resolve the kalshi data dir.

    Order: explicit LANTERN_DATA_DIR env -> repo `data/kalshi` if running from a
    checkout -> a writable fallback under HOME (for containers/standalone). This
    must never raise at import time (it runs on every boot).
    """
    override = os.environ.get("LANTERN_DATA_DIR")
    if override:
        return Path(override)
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "data" / "kalshi"
        if candidate.is_dir():
            return candidate
    return Path(os.environ.get("HOME", "/tmp")) / ".lantern" / "kalshi"


DATA_DIR = _data_dir()


@dataclass(frozen=True)
class Settings:
    # --- access control ---
    allowed_logins: frozenset[str] = field(default_factory=frozenset)
    github_client_id: str = ""
    github_client_secret: str = ""
    session_secret: str = ""

    # --- kalshi ---
    environment: str = "demo"
    api_key_id: str = ""
    private_key_pem: str = ""

    # --- trading gates ---
    live_enabled: bool = False
    max_per_order_usd: float = 40.0
    max_daily_loss_usd: float = 40.0
    max_trades_per_day: int = 1

    # --- runtime ---
    kill_switch_path: Path = DATA_DIR / "LIVE-KILL-SWITCH"
    ledger_path: Path = DATA_DIR / "kalshi-live-ledger.jsonl"

    @property
    def base_url(self) -> str:
        return KALSHI_BASES.get(self.environment, KALSHI_BASES["demo"])

    @property
    def has_credentials(self) -> bool:
        return bool(self.api_key_id and self.private_key_pem)

    @property
    def oauth_configured(self) -> bool:
        return bool(self.github_client_id and self.github_client_secret)

    def is_allowed(self, login: str | None) -> bool:
        return bool(login) and login.lower() in self.allowed_logins


def load_settings() -> Settings:
    logins_raw = os.environ.get("GITHUB_ALLOWED_LOGINS", "alex-place")
    allowed = frozenset(
        item.strip().lower() for item in logins_raw.split(",") if item.strip()
    )
    env = os.environ.get("KALSHI_ENVIRONMENT", "demo").strip().lower()
    if env not in KALSHI_BASES:
        env = "demo"
    return Settings(
        allowed_logins=allowed,
        github_client_id=os.environ.get("GITHUB_OAUTH_CLIENT_ID", ""),
        github_client_secret=os.environ.get("GITHUB_OAUTH_CLIENT_SECRET", ""),
        session_secret=os.environ.get("LANTERN_SESSION_SECRET", ""),
        environment=env,
        api_key_id=os.environ.get("KALSHI_API_KEY_ID", ""),
        private_key_pem=os.environ.get("KALSHI_PRIVATE_KEY", ""),
        live_enabled=_truthy(os.environ.get("LANTERN_LIVE_ENABLED")),
        max_per_order_usd=_float("LANTERN_MAX_PER_ORDER_USD", 40.0),
        max_daily_loss_usd=_float("LANTERN_MAX_DAILY_LOSS_USD", 40.0),
        max_trades_per_day=_int("LANTERN_MAX_TRADES_PER_DAY", 1),
    )
