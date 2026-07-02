#!/usr/bin/env python3
"""
agents.py — Autonomous 3-Agent Market Scanner

Fixes:
  1. Never enters a position already held
  2. Crypto scans correctly 24/7
  3. When market is bearish — skips stock entries, focuses on crypto only
"""

import os, json, math, re, logging, sqlite3
from datetime import datetime
from dotenv import load_dotenv
import anthropic
from openai import OpenAI
import alpaca_trade_api as tradeapi

load_dotenv()
log = logging.getLogger(__name__)

# ── Clients ───────────────────────────────────────────────────────────────────
claude = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

# ── Model routing ────────────────────────────────────────────────────────────
# Sonnet: final decisions requiring deep reasoning
# Haiku:  fast rule checks, simple classifications, logging
CLAUDE_SONNET = "claude-sonnet-4-5"
CLAUDE_HAIKU  = "claude-haiku-4-5-20251001"


grok   = OpenAI(api_key=os.getenv("XAI_API_KEY"), base_url="https://api.x.ai/v1")

# Grok-with-fallback (#1701). Models are interchangeable (CLAUDE.md): when xAI is
# down — out of credits, rate-limited, network — route the SAME analysis prompt to
# Claude Haiku instead of letting every ticker default to NEUTRAL (which silently
# halts all trading). One env flag (SCANNER_LLM_FALLBACK=0) disables it.
def grok_chat(messages, max_tokens=2500, timeout=30):
    """Return the model's text for an OpenAI-style `messages` list. Grok first;
    on ANY failure, fall back to Claude Haiku (mapping the single prompt across
    the Anthropic interface). Raises only if BOTH providers fail."""
    try:
        resp = grok.chat.completions.create(
            model="grok-3-mini", messages=messages, max_tokens=max_tokens, timeout=timeout)
        return resp.choices[0].message.content
    except Exception as e:
        if os.getenv("SCANNER_LLM_FALLBACK") == "0":
            raise
        log.warning("Grok unavailable (%s) — falling back to Claude Haiku", str(e)[:100])
        log_agent("system", "LLM", f"Grok down ({str(e)[:40]}) → Claude Haiku fallback")
        sys_txt = "\n".join(m["content"] for m in messages if m.get("role") == "system")
        umsgs = [{"role": m["role"], "content": m["content"]}
                 for m in messages if m.get("role") in ("user", "assistant")] \
                or [{"role": "user", "content": messages[-1]["content"]}]
        kw = {"model": CLAUDE_HAIKU, "max_tokens": max_tokens, "messages": umsgs}
        if sys_txt:
            kw["system"] = sys_txt
        r = claude.messages.create(**kw)
        return r.content[0].text if r.content else ""

alpaca = tradeapi.REST(
    os.getenv("ALPACA_API_KEY"),
    os.getenv("ALPACA_SECRET_KEY"),
    "https://paper-api.alpaca.markets",
    api_version="v2"
)

# ── Config ────────────────────────────────────────────────────────────────────
PORTFOLIO_VALUE   = float(os.getenv("PORTFOLIO_VALUE", 100_000))
CONFIDENCE_THRESH = int(os.getenv("CONFIDENCE_THRESH", 60))
MAX_POSITIONS     = 8
MARKET_PROXY      = "SPY"

DEFAULT_WATCHLIST = [
    "AAPL", "AMZN", "INTC", "AMD",  "SHOP",
    "SPY",  "TSLA", "NVDA", "ASML", "META",
    "MSFT", "JPM",  "GLD",
    # ── Crypto — scans 24/7 via dedicated job ──────────────────────────────
    # "BTCUSD", "ETHUSD", "SOLUSD",
]

# ── Asset profiles ────────────────────────────────────────────────────────────
# Each asset has its own personality:
#   style       — "longterm" or "trading"
#   stop_loss   — how much loss before hard exit (%)
#   take_profit — target gain before taking profits (%)
#   min_size    — minimum position size (% of portfolio)
#   max_size    — maximum position size (% of portfolio)
#   conf_thresh — minimum confidence needed to enter
#
# Sizing rules:
#   longterm:  always uses max_size (up to 5%) — conviction hold
#   trading:   scales with confidence:
#              65-74% → min_size
#              75-84% → mid between min and max
#              85%+   → max_size

ASSET_PROFILES = {
    # ── Stable large caps — long term holds, tight stops, modest targets
    # beta = historical sensitivity to SPY (1.0 = moves with market, 1.5 = 50% more volatile)
    "AAPL":   {"style":"trading",  "stop":-2.5,  "tp":+5.0,  "min":2.0, "max":5.0, "conf": 30, "beta":1.20},
    "AMZN":   {"style":"trading",  "stop":-2.5,  "tp":+5.0,  "min":2.0, "max":5.0, "conf": 30, "beta":1.15},
    "SPY":    {"style":"trading",  "stop":-1.5,  "tp":+3.0,  "min":2.0, "max":5.0, "conf": 30, "beta":1.00},
    "NVDA":   {"style":"trading",  "stop":-4.0,  "tp":+10.0, "min":1.5, "max":4.0, "conf": 30, "beta":1.75},
    "INTC":   {"style":"trading",  "stop":-3.0,  "tp":+6.0,  "min":1.5, "max":4.0, "conf": 30, "beta":0.90},
    "AMD":    {"style":"trading",  "stop":-4.0,  "tp":+9.0,  "min":1.5, "max":4.0, "conf": 30, "beta":1.65},

    # ── High volatility stocks — shorter trades, tighter sizing
    "TSLA":   {"style":"trading",  "stop":-5.0,  "tp":+12.0, "min":1.0, "max":3.0, "conf": 45, "beta":2.00},
    "SHOP":   {"style":"trading",  "stop":-5.0,  "tp":+10.0, "min":1.0, "max":3.0, "conf": 45, "beta":1.55},
    # ── European ADR — semiconductor equipment monopoly, high price per share
    "ASML":   {"style":"trading",  "stop":-2.5,  "tp":+6.0,  "min":1.0, "max":3.0, "conf": 45, "beta":1.45},
    # ── Mega-cap tech — AI/ad revenue plays, high beta
    "META":   {"style":"trading",  "stop":-2.5,  "tp":+6.0,  "min":1.5, "max":4.0, "conf": 45, "beta":1.35},

    # ── Crypto — very high volatility, wider stops, bigger moves expected
    "BTCUSD": {"style":"trading",  "stop":-6.0,  "tp":+15.0, "min":1.0, "max":3.0, "conf": 30, "beta":3.00},
    "ETHUSD": {"style":"trading",  "stop":-7.0,  "tp":+18.0, "min":1.0, "max":3.0, "conf": 30, "beta":3.50},
    "SOLUSD": {"style":"trading",  "stop":-8.0,  "tp":+20.0, "min":1.0, "max":2.5, "conf": 30, "beta":4.00},
    # ── Diversification tickers — different sector drivers ────────────────────
    "MSFT":   {"style":"trading",  "stop":-2.0,  "tp":+4.0,  "min":0.5, "max":8.0, "conf": 45, "beta":0.90},  # big tech, AI cloud
    "JPM":    {"style":"trading",  "stop":-2.0,  "tp":+4.0,  "min":0.5, "max":8.0, "conf": 45, "beta":1.10},  # financials, rate-sensitive
    "GLD":    {"style":"trading",  "stop":-1.5,  "tp":+3.0,  "min":0.5, "max":8.0, "conf": 45, "beta":0.10},  # gold ETF, risk-off hedge
}

# Fallback profile for unlisted tickers
DEFAULT_PROFILE = {"style":"trading", "stop":-4.0, "tp":+8.0, "min":1.0, "max":3.0, "conf":60, "beta":1.20}

# ── Delta limits ──────────────────────────────────────────────────────────────
# Max portfolio delta as % of equity per 1% market move
# e.g. 0.15 = portfolio should not move more than 15% for a 1% SPY move
MAX_PORTFOLIO_DELTA_PCT = 0.15   # 15% of equity
DELTA_ALERT_PCT         = 0.12   # warn at 12%

# ── Sector correlation map ────────────────────────────────────────────────────
# Tickers in the same group are correlated — don't hold more than MAX_SECTOR_EXPOSURE

SECTOR_MAP = {
    "semiconductors": {"NVDA", "AMD", "INTC", "ASML"},
    "big_tech":       {"AAPL", "AMZN", "META", "MSFT"},
    "ev_growth":      {"TSLA"},
    "ecommerce":      {"SHOP", "AMZN"},
    "broad_market":   {"SPY"},
    "financials":     {"JPM"},
    "commodities":    {"GLD"},

}

# Human-readable sector names for Grok prompts
SECTOR_NAMES = {
    "semiconductors": "Semiconductors & Chips",
    "big_tech":       "Big Tech & Cloud",
    "ev_growth":      "EV & Clean Energy",
    "ecommerce":      "E-Commerce & Retail",
    "financials":     "Banks & Financials",
    "commodities":    "Gold & Commodities",
    "broad_market":   "Broad Market ETF",
    "crypto_major":   "Major Crypto (BTC/ETH)",
    "crypto_alt":     "Alt Crypto (SOL/ETH)",
}

MAX_SECTOR_POSITIONS = 2
MAX_SECTOR_EXPOSURE  = 8.0

# ── Sector rotation scanner ───────────────────────────────────────────────────

_rotation_cache: dict = {}
ROTATION_CACHE_SECONDS = 3600 * 6  # refresh every 6 hours

def scan_sector_rotation() -> dict:
    """
    Ask Grok which sectors are seeing institutional inflows this week.
    Returns confidence adjustments per sector (+/- points).
    Cached for 6 hours — runs in background, not per-trade.
    """
    import time as _time
    now = _time.time()

    if "rotation" in _rotation_cache:
        cached_time, result = _rotation_cache["rotation"]
        if now - cached_time < ROTATION_CACHE_SECONDS:
            return result

    try:
        sector_list = "\n".join(
            f"- {k}: {v}" for k, v in SECTOR_NAMES.items()
        )

        prompt = f"""You are a sector rotation analyst tracking institutional money flows.

Analyze the current market and identify which sectors are seeing:
1. Strong institutional INFLOWS (money moving in)
2. Strong institutional OUTFLOWS (money moving out)
3. Neutral / no clear rotation

Sectors to evaluate:
{sector_list}

Look at: ETF flows, earnings momentum, macro tailwinds/headwinds,
Fed policy impact, recent news and X/Twitter sentiment per sector.

Return ONLY valid JSON — sector keys exactly as listed above:
{{
  "hot": ["sector_key1", "sector_key2"],
  "cold": ["sector_key3"],
  "neutral": ["sector_key4", "sector_key5"],
  "summary": "one sentence on current rotation theme",
  "macro_theme": "one sentence on dominant macro driver"
}}"""

        resp = grok.chat.completions.create(
            model="grok-3-mini",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=300,
        )
        data = extract_json(resp.choices[0].message.content)

        # Build confidence adjustment map
        # hot sector  → +8 confidence points
        # cold sector → -8 confidence points
        adjustments = {}
        for sector in data.get("hot", []):
            adjustments[sector] = +8
        for sector in data.get("cold", []):
            adjustments[sector] = -8
        for sector in data.get("neutral", []):
            adjustments[sector] = 0

        result = {
            "adjustments": adjustments,
            "hot":         data.get("hot", []),
            "cold":        data.get("cold", []),
            "summary":     data.get("summary", ""),
            "macro_theme": data.get("macro_theme", ""),
            "timestamp":   datetime.now().strftime("%H:%M %d/%m"),
        }

        _rotation_cache["rotation"] = (now, result)
        log_agent("grok", "ROTATION",
            f"Hot: {result['hot']} | Cold: {result['cold']} | "
            f"{result['summary']}")
        return result

    except Exception as e:
        log.warning("Sector rotation scan failed: %s", e)
        result = {"adjustments": {}, "hot": [], "cold": [],
                  "summary": "", "macro_theme": "", "timestamp": ""}
        _rotation_cache["rotation"] = (now, result)
        return result

def get_sector_rotation_adjustment(ticker: str) -> int:
    """
    Get the confidence adjustment for a ticker based on its sector's rotation status.
    Returns: +8 (hot), 0 (neutral), -8 (cold)
    Crypto tickers are exempt — they move too fast for 6-hour sector calls to be reliable.
    """
    # Crypto exempt from sector rotation penalty
    if is_crypto(ticker):
        return 0

    rotation = scan_sector_rotation()
    adjustments = rotation.get("adjustments", {})
    ticker_upper = ticker.upper()

    best_adj = 0  # default neutral
    for sector, members in SECTOR_MAP.items():
        if ticker_upper in members and sector in adjustments:
            adj = adjustments[sector]
            if abs(adj) > abs(best_adj):
                best_adj = adj

    return best_adj



def check_correlation(ticker: str, open_positions: dict, equity: float) -> tuple[bool, str]:
    """
    Check if adding this ticker would overexpose the portfolio to one sector.
    Returns (ok_to_enter, reason).
    """
    ticker_upper = ticker.upper()

    # Find which sector(s) this ticker belongs to
    ticker_sectors = [
        sector for sector, members in SECTOR_MAP.items()
        if ticker_upper in members
    ]

    if not ticker_sectors:
        return True, ""  # not in any sector map — allow

    for sector in ticker_sectors:
        sector_members = SECTOR_MAP[sector]

        # Find currently held positions in this sector
        held_in_sector = []
        sector_exposure_pct = 0.0

        for sym, pos in open_positions.items():
            clean_sym = sym.replace("/", "").upper()
            if clean_sym in sector_members:
                held_in_sector.append(clean_sym)
                # Calculate exposure %
                try:
                    mkt_val = float(pos.market_value) if hasattr(pos, "market_value") else 0
                    sector_exposure_pct += (mkt_val / equity * 100) if equity > 0 else 0
                except:
                    pass

        # Block if too many positions in sector
        if len(held_in_sector) >= MAX_SECTOR_POSITIONS:
            reason = (
                f"Sector overexposure ({sector}): "
                f"already holding {', '.join(held_in_sector)} "
                f"— max {MAX_SECTOR_POSITIONS} per sector"
            )
            return False, reason

        # Block if sector exposure % is too high
        if sector_exposure_pct >= MAX_SECTOR_EXPOSURE:
            reason = (
                f"Sector exposure too high ({sector}): "
                f"{sector_exposure_pct:.1f}% of portfolio "
                f"— max {MAX_SECTOR_EXPOSURE}%"
            )
            return False, reason

    return True, ""



# ── Shortable tickers ─────────────────────────────────────────────────────────
# Only these tickers can be shorted — must be liquid and margin-eligible.
# Crypto cannot be shorted on Alpaca.
SHORTABLE = {"SPY", "NVDA", "TSLA", "AAPL", "AMZN", "INTC", "AMD", "SHOP", "ASML", "META", "MSFT", "JPM", "GLD"}
SHORT_CONFIDENCE_THRESH      = 65   # stocks: slightly higher than long
SHORT_CONFIDENCE_THRESH_CRYPTO = 60  # crypto: slightly lower — more liquid/24h
SHORT_SIZE_MULTIPLIER   = 0.7  # shorts use 70% of normal size — more conservative

def can_short(ticker: str) -> bool:
    return ticker.upper() in SHORTABLE

def is_short_position(position) -> bool:
    """Check if an existing position is a short (negative qty)."""
    try:
        return float(position.qty) < 0
    except:
        return getattr(position, "side", "") == "short"

def get_profile(ticker: str) -> dict:
    return ASSET_PROFILES.get(ticker.upper(), DEFAULT_PROFILE)

def get_kelly_position_size(ticker: str, confidence: int,
                             earnings_risk: str = "LOW") -> float:
    """
    Half-Kelly position sizing using per-ticker historical win rate.
    Reduces size when earnings approaching.
    """
    profile = get_profile(ticker)
    try:
        con  = sqlite3.connect(LESSONS_DB)
        rows = con.execute(
            "SELECT pnl_pct FROM trade_history "
            "WHERE symbol=? AND status='closed' AND pnl_pct IS NOT NULL "
            "ORDER BY id DESC LIMIT 30",
            (ticker,)
        ).fetchall()
        con.close()
        pnl_list = [r[0] for r in rows if r[0] is not None]
        wins     = [p for p in pnl_list if p > 0]
        losses   = [abs(p) for p in pnl_list if p <= 0]
        if len(pnl_list) >= 10 and wins and losses:
            W        = len(wins) / len(pnl_list)
            R        = (sum(wins)/len(wins)) / (sum(losses)/len(losses))
            half_k   = (W - (1-W)/R) * 0.5
            kelly_pct = max(profile["min"], min(profile["max"], round(half_k*100, 2)))
            if earnings_risk == "HIGH":
                kelly_pct = max(profile["min"], round(kelly_pct * 0.5, 2))
            elif earnings_risk == "MEDIUM":
                kelly_pct = max(profile["min"], round(kelly_pct * 0.75, 2))
            log_agent("system", "KELLY",
                f"{ticker} Kelly: W={W:.0%} ({len(wins)}/{len(pnl_list)}) "
                f"R={R:.2f} earn={earnings_risk} → {kelly_pct}%")
            return kelly_pct
    except Exception as e:
        log.warning("Kelly failed %s: %s", ticker, e)
    # Confidence fallback
    base = profile["max"] if (profile["style"]=="longterm" or confidence>=85) else            round((profile["min"]+profile["max"])/2,1) if confidence>=75 else profile["min"]
    if earnings_risk == "HIGH":   base = max(profile["min"], round(base*0.5,2))
    elif earnings_risk == "MEDIUM": base = max(profile["min"], round(base*0.75,2))
    return base


def get_position_size(ticker: str, confidence: int,
                      earnings_risk: str = "LOW") -> float:
    """Wrapper — uses Kelly if enough history, otherwise confidence-based."""
    return get_kelly_position_size(ticker, confidence, earnings_risk)

agent_log = []

def log_agent(agent_type: str, agent: str, body: str):
    agent_log.append({
        "type":  agent_type,
        "agent": agent,
        "body":  body,
        "time":  datetime.now().strftime("%H:%M:%S")
    })
    if len(agent_log) > 100:
        agent_log.pop(0)
    # Safe print for Windows terminals that don't support Unicode
    safe_body = body.encode("ascii", errors="replace").decode("ascii")
    log.info("[%s] %s", agent, safe_body)

# ── Lessons database ──────────────────────────────────────────────────────────

LESSONS_DB = "lessons.db"

def init_lessons_db():
    con = sqlite3.connect(LESSONS_DB)
    con.execute("""
        CREATE TABLE IF NOT EXISTS lessons (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            ts        TEXT,
            symbol    TEXT,
            pnl_pct   REAL,
            lesson    TEXT,
            avoid     TEXT,
            pattern   TEXT
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS trade_history (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            ts         TEXT,
            symbol     TEXT,
            action     TEXT,
            qty        REAL,
            entry_price REAL,
            exit_price  REAL,
            pnl_pct    REAL,
            pnl_usd    REAL,
            confidence INTEGER,
            reasoning  TEXT,
            close_reason TEXT,
            style      TEXT,
            status     TEXT
        )
    """)
    # Persist stop/TP price levels across restarts
    con.execute("""
        CREATE TABLE IF NOT EXISTS position_state (
            symbol          TEXT PRIMARY KEY,
            stop_price      REAL,
            tp_price        REAL,
            classification  TEXT,
            eod_action      TEXT,
            hold_period     TEXT,
            updated_at      TEXT
        )
    """)
    # Daily EOD analysis — one row per trading day
    con.execute("""
        CREATE TABLE IF NOT EXISTS daily_analysis (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            date         TEXT UNIQUE,
            trades       INTEGER,
            wins         INTEGER,
            losses       INTEGER,
            win_rate     REAL,
            total_pnl    REAL,
            avg_win      REAL,
            avg_loss     REAL,
            vix_regime   TEXT,
            market_bias  TEXT,
            patterns_worked  TEXT,
            patterns_failed  TEXT,
            vix_assessment   TEXT,
            tomorrow_focus   TEXT,
            tomorrow_avoid   TEXT,
            verdict      TEXT,
            metadata     TEXT,
            ts           TEXT
        )
    """)
    # Migration: add metadata column to existing databases that predate it
    try:
        con.execute("ALTER TABLE daily_analysis ADD COLUMN metadata TEXT")
    except Exception:
        pass  # column already exists
    # Migration: add closed_ts so realized P&L is bucketed by the day a trade was
    # CLOSED, not the day it was opened. Without it, an overnight hold's realized
    # P&L is credited to its OPEN date (ts), so "today's realized" mis-attributes
    # any position that spans a day boundary. Legacy rows have NULL closed_ts and
    # fall back to ts (open date) via COALESCE at read time.
    try:
        con.execute("ALTER TABLE trade_history ADD COLUMN closed_ts TEXT")
    except Exception:
        pass  # column already exists
    # Migration: add risk_pct (the entry stop distance as a %) so realized R can be
    # computed EXACTLY per trade (R = pnl_pct / risk_pct) instead of proxied from
    # avg win% / avg loss% (which silently assumes a uniform stop distance). Legacy
    # rows have NULL risk_pct and fall back to the pnl_pct proxy at read time.
    try:
        con.execute("ALTER TABLE trade_history ADD COLUMN risk_pct REAL")
    except Exception:
        pass  # column already exists
    # Success patterns from winning trades — complement to lessons (losses)
    con.execute("""
        CREATE TABLE IF NOT EXISTS success_patterns (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            ts           TEXT,
            symbol       TEXT,
            pnl_pct      REAL,
            pattern      TEXT,
            what_worked  TEXT,
            repeat_when  TEXT
        )
    """)
    con.commit()
    con.close()

init_lessons_db()


def save_position_state(symbol: str, adj: dict):
    """Persist position adjustments (stop/TP levels) to DB so they survive restarts."""
    try:
        con = sqlite3.connect(LESSONS_DB)
        con.execute("""
            INSERT INTO position_state
                (symbol, stop_price, tp_price, classification, eod_action, hold_period, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol) DO UPDATE SET
                stop_price=excluded.stop_price,
                tp_price=excluded.tp_price,
                classification=excluded.classification,
                eod_action=excluded.eod_action,
                hold_period=excluded.hold_period,
                updated_at=excluded.updated_at
        """, (
            symbol,
            adj.get("stop_price"),
            adj.get("tp_price"),
            adj.get("classification", ""),
            adj.get("eod_action", ""),
            adj.get("hold_period", ""),
            datetime.now().isoformat(),
        ))
        con.commit()
        con.close()
    except Exception as e:
        log.warning("save_position_state failed %s: %s", symbol, e)


def load_position_states():
    """Load persisted stop/TP levels from DB into _position_adjustments on startup."""
    try:
        con  = sqlite3.connect(LESSONS_DB)
        rows = con.execute(
            "SELECT symbol, stop_price, tp_price, classification, "
            "eod_action, hold_period FROM position_state"
        ).fetchall()
        con.close()

        loaded = {}
        for sym, stop_p, tp_p, cls, eod, hold in rows:
            if stop_p is not None and tp_p is not None:
                loaded[sym] = {
                    "stop_price":     stop_p,
                    "tp_price":       tp_p,
                    "classification": cls or "",
                    "eod_action":     eod  or "",
                    "hold_period":    hold or "",
                }
        log.info("Loaded position state for %d symbols: %s",
                 len(loaded), list(loaded.keys()))
        return loaded
    except Exception as e:
        log.warning("load_position_states failed: %s", e)
        return {}


def clear_position_state(symbol: str):
    """Remove a symbol from persisted state when position is closed."""
    try:
        con = sqlite3.connect(LESSONS_DB)
        con.execute("DELETE FROM position_state WHERE symbol=?", (symbol,))
        con.commit()
        con.close()
    except Exception as e:
        log.warning("clear_position_state failed %s: %s", symbol, e)



def log_trade_history(symbol: str, action: str, qty: float,
                      entry_price: float, confidence: int,
                      reasoning: str, style: str, stop_pct: float = None):
    """Log a new entry trade to persistent history.

    `stop_pct` is the entry stop distance as a % (from calculate_smart_levels);
    stored as risk_pct so realized R can be computed exactly on close.
    """
    try:
        risk_pct = abs(float(stop_pct)) if stop_pct is not None else None
    except (TypeError, ValueError):
        risk_pct = None
    try:
        con = sqlite3.connect(LESSONS_DB)
        con.execute(
            "INSERT INTO trade_history "
            "(ts,symbol,action,qty,entry_price,exit_price,pnl_pct,"
            "pnl_usd,confidence,reasoning,close_reason,style,status,risk_pct) "
            "VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,NULL,?,'open',?)",
            (datetime.now().isoformat(), symbol, action, qty,
             entry_price, confidence, reasoning, style, risk_pct)
        )
        con.commit()
        con.close()
    except Exception as e:
        log.warning("Failed to log trade history: %s", e)

def close_trade_history(symbol: str, exit_price: float,
                        pnl_pct: float, pnl_usd: float, reason: str):
    """Update the most recent open trade for symbol with exit data."""
    try:
        con = sqlite3.connect(LESSONS_DB)
        # SQLite doesn't support ORDER BY in UPDATE — use subquery to find latest id
        con.execute(
            "UPDATE trade_history SET exit_price=?, pnl_pct=?, pnl_usd=?, "
            "close_reason=?, status='closed', closed_ts=? "
            "WHERE id = ("
            "  SELECT id FROM trade_history "
            "  WHERE symbol=? AND status='open' "
            "  ORDER BY id DESC LIMIT 1"
            ")",
            (exit_price, pnl_pct, pnl_usd, reason,
             datetime.now().isoformat(), symbol)
        )
        con.commit()
        con.close()
    except Exception as e:
        log.warning("Failed to close trade history: %s", e)
    # Σ₀ Verify/Converge — grade this trade's convergence record against its P&L.
    try:
        _conv_grade_close(symbol, pnl_pct)
    except Exception as e:
        log.warning("sigma0 convergence grade failed %s: %s", symbol, e)

def scan_for_new_tickers(current_watchlist: list) -> tuple:
    """
    Deep market research to find and vet new ticker candidates.

    Stage 1 — Grok broad scan: finds 10-15 candidates from global news,
               X/Twitter buzz, unusual volume, sector momentum
    Stage 2 — Fundamental filter: checks market cap, liquidity, Alpaca tradability
    Stage 3 — Technical screen: checks if Alpaca has bar data, basic trend
    Stage 4 — Sonnet deep research: for top 5 candidates, full analysis
               including why it fits the strategy, risks, optimal entry zone

    Returns (suggestions, market_theme)
    """
    try:
        current = ", ".join(current_watchlist)

        # ── Stage 1: Grok broad market scan ──────────────────────────────────
        stage1_prompt = f"""You are a market intelligence analyst with real-time web and X/Twitter access.

Current watchlist (skip these): {current}

Scan ALL of the following for trading opportunities RIGHT NOW:
1. X/Twitter trending financial topics and unusual stock mentions
2. Breaking news — earnings surprises, FDA approvals, M&A, product launches
3. Unusual volume spikes in US equities (check unusual whales, volume leaders)
4. Sector rotation — which sectors are getting institutional inflows TODAY
5. Reddit/WallStreetBets momentum plays
6. Short squeeze candidates (high short interest + rising price)
7. Technical breakouts — stocks breaking 52-week highs or key resistance

Find 10 ticker candidates NOT on the current watchlist.
Only US-listed stocks, market cap > $2B, liquid (avg volume > 500k/day).

Return ONLY valid JSON:
{{
  "candidates": [
    {{
      "ticker": "SYMBOL",
      "name": "Company Name",
      "price": 0.0,
      "market_cap_b": 0.0,
      "why_now": "specific reason this is interesting TODAY",
      "direction": "LONG or SHORT",
      "risk": "LOW|MEDIUM|HIGH",
      "category": "momentum|reversal|breakout|squeeze|catalyst",
      "confidence": 0
    }}
  ],
  "market_theme": "one sentence on what's driving markets this week",
  "hot_sectors": ["sector1", "sector2"],
  "avoid_sectors": ["sector3"]
}}"""

        resp1 = grok.chat.completions.create(
            model="grok-3-mini",
            messages=[{"role": "user", "content": stage1_prompt}],
            max_tokens=1200,
        )
        stage1 = extract_json(resp1.choices[0].message.content)
        candidates = stage1.get("candidates", [])
        theme      = stage1.get("market_theme", "")
        hot_sectors = stage1.get("hot_sectors", [])

        log_agent("grok", "RESEARCH",
            f"Stage 1: {len(candidates)} candidates | Theme: {theme}")

        if not candidates:
            return [], theme

        # ── Stage 2: Alpaca tradability filter ───────────────────────────────
        tradable = []
        for c in candidates[:12]:
            ticker = c.get("ticker", "").upper().strip()
            if not ticker or len(ticker) > 5:
                continue
            try:
                # Check Alpaca has this asset and it's tradable
                asset = alpaca.get_asset(ticker)
                if not asset.tradable:
                    log_agent("system", "RESEARCH", f"{ticker} — not tradable on Alpaca")
                    continue
                if not asset.fractionable and float(c.get("price", 999)) > 500:
                    log_agent("system", "RESEARCH", f"{ticker} — too expensive, not fractionable")
                    continue

                # Check we can get bar data
                bars = alpaca.get_bars(ticker, "1Hour", limit=5, feed="iex").df
                if bars.empty:
                    log_agent("system", "RESEARCH", f"{ticker} — no bar data on IEX feed")
                    continue

                c["current_price"] = float(bars["close"].iloc[-1])
                c["tradable"]      = True
                tradable.append(c)
                log_agent("system", "RESEARCH", f"{ticker} — tradable ✓ @ ${c['current_price']:.2f}")

            except Exception as e:
                log_agent("system", "RESEARCH", f"{ticker} — filter failed: {e}")
                continue

        log_agent("system", "RESEARCH", f"Stage 2: {len(tradable)}/{len(candidates)} tradable")

        if not tradable:
            return [], theme

        # ── Stage 3: Sonnet deep research on top candidates ──────────────────
        # Sort by confidence and take top 5
        tradable.sort(key=lambda x: x.get("confidence", 0), reverse=True)
        top5 = tradable[:5]

        researched = []
        for c in top5:
            ticker = c["ticker"]
            try:
                # Fetch recent news for this ticker
                news_items = alpaca.get_news(symbol=ticker, limit=8)
                news_text  = "\n".join([
                    f"  - {n.headline}" for n in news_items
                ][:5]) if news_items else "  No recent news"

                # Fetch basic technicals
                bars_1h = alpaca.get_bars(ticker, "1Hour", limit=48, feed="iex").df
                if not bars_1h.empty:
                    closes   = bars_1h["close"].tolist()
                    highs    = bars_1h["high"].tolist()
                    lows     = bars_1h["low"].tolist()
                    price    = closes[-1]
                    high_24h = max(highs[-24:])
                    low_24h  = min(lows[-24:])
                    chg_24h  = (price - closes[-24]) / closes[-24] * 100 if len(closes) >= 24 else 0
                    atr      = sum(highs[i]-lows[i] for i in range(-14, 0)) / 14
                else:
                    price = c.get("current_price", 0)
                    high_24h = low_24h = price
                    chg_24h = atr = 0

                research_prompt = f"""You are a senior trading analyst doing deep research on a stock candidate.

Ticker: {ticker} ({c.get('name', '')})
Current price: ${price:.2f}
24h change: {chg_24h:+.2f}%
24h range: ${low_24h:.2f} — ${high_24h:.2f}
ATR (14h): ${atr:.2f}
Direction signal: {c.get('direction', '?')}
Category: {c.get('category', '?')}
Initial thesis: {c.get('why_now', '')}

Recent news:
{news_text}

Hot sectors this week: {', '.join(hot_sectors)}
Current watchlist for context: {current}

Analyze this stock for adding to an active intraday trading watchlist.
The strategy: reversal trading + trend following, intraday positions, 15-min scans.

Evaluate:
1. Does this fit the intraday trading strategy? (reversals, momentum)
2. What's the specific entry zone to watch? (price level, RSI condition)
3. What's the main risk if this trade fails?
4. Does it complement or overlap with the existing watchlist?
5. Rate 1-10: how strongly do you recommend adding this?

Return ONLY valid JSON:
{{
  "recommendation": "ADD|WATCH|SKIP",
  "rating": 7,
  "entry_zone": "specific price level or condition to enter",
  "thesis": "2 sentence investment thesis",
  "risk": "main downside risk",
  "overlap": "does this overlap with existing watchlist? how?",
  "optimal_time": "best time of day to trade this (morning/midday/power hour)",
  "suggested_stop_pct": -2.5,
  "suggested_tp_pct": 5.0,
  "add_reason": "why add to watchlist now vs later"
}}"""

                resp3 = claude.messages.create(
                    model=CLAUDE_SONNET,
                    max_tokens=300,
                    messages=[{"role": "user", "content": research_prompt}],
                )
                deep = extract_json(resp3.content[0].text)

                if deep.get("recommendation") in ("ADD", "WATCH"):
                    researched.append({
                        "ticker":        ticker,
                        "name":          c.get("name", ""),
                        "price":         round(price, 2),
                        "direction":     c.get("direction", "LONG"),
                        "risk":          c.get("risk", "MEDIUM"),
                        "confidence":    c.get("confidence", 60),
                        "category":      c.get("category", ""),
                        "why_now":       c.get("why_now", ""),
                        "rating":        deep.get("rating", 5),
                        "recommendation":deep.get("recommendation", "WATCH"),
                        "entry_zone":    deep.get("entry_zone", ""),
                        "thesis":        deep.get("thesis", ""),
                        "research_risk": deep.get("risk", ""),
                        "overlap":       deep.get("overlap", ""),
                        "optimal_time":  deep.get("optimal_time", ""),
                        "stop_pct":      deep.get("suggested_stop_pct", -2.5),
                        "tp_pct":        deep.get("suggested_tp_pct", 5.0),
                        "add_reason":    deep.get("add_reason", ""),
                    })
                    log_agent("system", "RESEARCH",
                        f"{ticker} → {deep.get('recommendation')} "
                        f"(rating {deep.get('rating')}/10)")
                else:
                    log_agent("system", "RESEARCH",
                        f"{ticker} → SKIP — {deep.get('add_reason','no reason given')}")

            except Exception as e:
                log.warning("Deep research failed %s: %s", ticker, e)

        # Sort by rating
        researched.sort(key=lambda x: x.get("rating", 0), reverse=True)
        log_agent("system", "RESEARCH",
            f"Research complete: {len(researched)} recommendations "
            f"({sum(1 for r in researched if r['recommendation']=='ADD')} ADD, "
            f"{sum(1 for r in researched if r['recommendation']=='WATCH')} WATCH)")

        return researched, theme

    except Exception as e:
        log.warning("Watchlist scan failed: %s", e)
        return [], ""



def get_weekly_stats() -> dict:
    """Pull trade stats for the last 7 days for the weekly report."""
    try:
        from datetime import datetime, timedelta
        cutoff = (datetime.now() - timedelta(days=7)).isoformat()
        con    = sqlite3.connect(LESSONS_DB)

        rows = con.execute(
            "SELECT symbol, action, pnl_pct, pnl_usd, confidence, "
            "reasoning, close_reason, style, ts "
            "FROM trade_history "
            "WHERE status='closed' AND ts >= ? "
            "ORDER BY ts DESC",
            (cutoff,)
        ).fetchall()

        lessons = con.execute(
            "SELECT symbol, pnl_pct, lesson, avoid, pattern "
            "FROM lessons WHERE ts >= ? ORDER BY id DESC",
            (cutoff,)
        ).fetchall()

        con.close()

        if not rows:
            return {"trades": [], "lessons": [], "summary": None}

        pnl_values = [r[2] for r in rows if r[2] is not None]
        usd_values = [r[3] for r in rows if r[3] is not None]
        wins  = [p for p in pnl_values if p > 0]
        losses= [p for p in pnl_values if p <= 0]

        return {
            "trades": rows,
            "lessons": lessons,
            "summary": {
                "total":       len(rows),
                "wins":        len(wins),
                "losses":      len(losses),
                "win_rate":    round(len(wins) / len(rows) * 100, 1) if rows else 0,
                "total_pnl":   round(sum(usd_values), 2),
                "avg_win":     round(sum(wins) / len(wins), 2) if wins else 0,
                "avg_loss":    round(sum(losses) / len(losses), 2) if losses else 0,
                "best_trade":  max(pnl_values) if pnl_values else 0,
                "worst_trade": min(pnl_values) if pnl_values else 0,
                "by_symbol":   {},
            }
        }
    except Exception as e:
        log.warning("Weekly stats failed: %s", e)
        return {"trades": [], "lessons": [], "summary": None}


def get_graduation_analysis() -> dict:
    """
    Evaluate whether the paper trading system is ready for live trading.
    Requires: 30+ days of data, 20+ trades, win rate >= 55%, Sharpe >= 1.0

    Returns full analysis dict with recommendation.
    """
    import math
    from datetime import datetime, timedelta

    try:
        cutoff = (datetime.now() - timedelta(days=30)).isoformat()
        con    = sqlite3.connect(LESSONS_DB)

        rows = con.execute(
            "SELECT symbol, action, pnl_pct, pnl_usd, confidence, style, ts "
            "FROM trade_history "
            "WHERE status='closed' AND ts >= ? "
            "ORDER BY ts ASC",
            (cutoff,)
        ).fetchall()

        # Check how many days of data we have
        all_rows = con.execute(
            "SELECT MIN(ts), MAX(ts), COUNT(*) FROM trade_history WHERE status='closed'"
        ).fetchone()
        con.close()

        first_trade = all_rows[0]
        total_ever  = all_rows[2] or 0

        if not rows:
            return {
                "ready":       False,
                "reason":      "No completed trades in the last 30 days",
                "trades":      0,
                "days_active": 0,
                "win_rate":    0,
                "sharpe":      0,
                "meets_trades":  False,
                "meets_winrate": False,
                "meets_sharpe":  False,
            }

        # Calculate days active
        if first_trade:
            first_dt   = datetime.fromisoformat(first_trade)
            days_active = (datetime.now() - first_dt).days
        else:
            days_active = 0

        pnl_values = [r[2] for r in rows if r[2] is not None]
        usd_values = [r[3] for r in rows if r[3] is not None]
        n          = len(pnl_values)

        if n == 0:
            return {"ready": False, "reason": "No P&L data available",
                    "trades": 0, "days_active": days_active,
                    "win_rate": 0, "sharpe": 0,
                    "meets_trades": False, "meets_winrate": False, "meets_sharpe": False}

        wins     = [p for p in pnl_values if p > 0]
        losses   = [p for p in pnl_values if p <= 0]
        win_rate = len(wins) / n

        # Sharpe ratio — annualized using daily returns proxy
        avg_ret  = sum(pnl_values) / n
        if n > 1:
            variance = sum((p - avg_ret) ** 2 for p in pnl_values) / (n - 1)
            std_dev  = math.sqrt(variance) if variance > 0 else 0.001
        else:
            std_dev  = 0.001
        # Annualize: assume ~2 trades per day on average
        sharpe   = round((avg_ret / std_dev) * math.sqrt(252 * 2), 2) if std_dev > 0 else 0

        # Graduation criteria
        MIN_TRADES   = 20
        MIN_WIN_RATE = 0.55
        MIN_SHARPE   = 1.0
        MIN_DAYS     = 30

        meets_trades  = n >= MIN_TRADES
        meets_winrate = win_rate >= MIN_WIN_RATE
        meets_sharpe  = sharpe >= MIN_SHARPE
        meets_days    = days_active >= MIN_DAYS

        ready = meets_trades and meets_winrate and meets_sharpe and meets_days

        # Build missing criteria list
        missing = []
        if not meets_days:
            missing.append(f"Need {MIN_DAYS} days active (have {days_active})")
        if not meets_trades:
            missing.append(f"Need {MIN_TRADES} trades (have {n})")
        if not meets_winrate:
            missing.append(f"Need {MIN_WIN_RATE*100:.0f}% win rate "
                           f"(have {win_rate*100:.1f}%)")
        if not meets_sharpe:
            missing.append(f"Need Sharpe ≥ {MIN_SHARPE} (have {sharpe:.2f})")

        return {
            "ready":         ready,
            "reason":        "All criteria met" if ready else " | ".join(missing),
            "trades":        n,
            "total_ever":    total_ever,
            "days_active":   days_active,
            "win_rate":      round(win_rate * 100, 1),
            "sharpe":        sharpe,
            "avg_return":    round(avg_ret, 2),
            "total_pnl_usd": round(sum(usd_values), 2),
            "wins":          len(wins),
            "losses":        len(losses),
            "avg_win":       round(sum(wins)/len(wins), 2) if wins else 0,
            "avg_loss":      round(sum(losses)/len(losses), 2) if losses else 0,
            "meets_trades":  meets_trades,
            "meets_winrate": meets_winrate,
            "meets_sharpe":  meets_sharpe,
            "meets_days":    meets_days,
        }

    except Exception as e:
        log.warning("Graduation analysis failed: %s", e)
        return {
            "ready": False, "reason": f"Analysis error: {e}",
            "trades": 0, "days_active": 0, "win_rate": 0, "sharpe": 0,
            "meets_trades": False, "meets_winrate": False, "meets_sharpe": False,
            "meets_days": False,
        }


def save_lesson(symbol: str, pnl_pct: float,
                lesson: str, avoid: str, pattern: str):
    con = sqlite3.connect(LESSONS_DB)
    con.execute(
        "INSERT INTO lessons VALUES (NULL,?,?,?,?,?,?)",
        (datetime.now().isoformat(), symbol, pnl_pct,
         lesson, avoid, pattern)
    )
    con.commit()
    con.close()
    log_agent("system", "LEARNER",
        f"Lesson saved for {symbol} ({pnl_pct:+.2f}%): {lesson}")

def get_recent_lessons(limit: int = 5) -> list[dict]:
    """Load the most recent lessons to inject into agent prompts."""
    try:
        con = sqlite3.connect(LESSONS_DB)
        rows = con.execute(
            "SELECT symbol, pnl_pct, lesson, avoid, pattern "
            "FROM lessons ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        con.close()
        return [
            {"symbol": r[0], "pnl_pct": r[1],
             "lesson": r[2], "avoid": r[3], "pattern": r[4]}
            for r in rows
        ]
    except:
        return []

def get_symbol_lessons(symbol: str, limit: int = 3) -> list[dict]:
    """Load lessons specific to one symbol."""
    try:
        con = sqlite3.connect(LESSONS_DB)
        rows = con.execute(
            "SELECT pnl_pct, lesson, avoid, pattern FROM lessons "
            "WHERE symbol=? ORDER BY id DESC LIMIT ?",
            (symbol, limit)
        ).fetchall()
        con.close()
        return [
            {"pnl_pct": r[0], "lesson": r[1],
             "avoid": r[2], "pattern": r[3]}
            for r in rows
        ]
    except:
        return []

def format_lessons_for_prompt(lessons: list[dict]) -> str:
    """Format lessons into a readable block for agent prompts."""
    if not lessons:
        return ""
    lines = ["\nPast mistakes to learn from:"]
    for l in lessons:
        lines.append(
            f"- {l.get('symbol','?')} ({l.get('pnl_pct',0):+.1f}%): "
            f"{l.get('lesson','')} | Avoid: {l.get('avoid','')} | "
            f"Pattern: {l.get('pattern','')}"
        )
    return "\n".join(lines)

def save_success_pattern(symbol: str, pnl_pct: float,
                         pattern: str, what_worked: str, repeat_when: str):
    try:
        con = sqlite3.connect(LESSONS_DB)
        con.execute(
            "INSERT INTO success_patterns (ts,symbol,pnl_pct,pattern,what_worked,repeat_when) "
            "VALUES (?,?,?,?,?,?)",
            (datetime.now().isoformat(), symbol, pnl_pct, pattern, what_worked, repeat_when)
        )
        con.commit()
        con.close()
        log_agent("system", "LEARNER",
            f"Success pattern saved {symbol} ({pnl_pct:+.2f}%): {pattern}")
    except Exception as e:
        log.warning("save_success_pattern failed %s: %s", symbol, e)

def get_recent_success_patterns(limit: int = 3) -> list[dict]:
    """Load recent winning-trade patterns to inject into prompts."""
    try:
        con = sqlite3.connect(LESSONS_DB)
        rows = con.execute(
            "SELECT symbol, pnl_pct, pattern, what_worked, repeat_when "
            "FROM success_patterns ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        con.close()
        return [{"symbol": r[0], "pnl_pct": r[1], "pattern": r[2],
                 "what_worked": r[3], "repeat_when": r[4]}
                for r in rows]
    except:
        return []

def format_success_for_prompt(patterns: list[dict]) -> str:
    """Format success patterns into a readable block for agent prompts."""
    if not patterns:
        return ""
    lines = ["\nRecent winning patterns to repeat:"]
    for p in patterns:
        lines.append(
            f"- {p.get('symbol','?')} ({p.get('pnl_pct',0):+.1f}%): "
            f"{p.get('what_worked','')} | Repeat when: {p.get('repeat_when','')}"
        )
    return "\n".join(lines)

def get_recent_daily_analyses(days: int = 3) -> str:
    """
    Read the last N days of EOD analysis for injection into prompts.
    Returns a formatted multi-day summary string, or '' if no data.
    """
    try:
        con = sqlite3.connect(LESSONS_DB)
        rows = con.execute(
            "SELECT date, win_rate, total_pnl, patterns_worked, patterns_failed, "
            "tomorrow_focus, tomorrow_avoid, verdict "
            "FROM daily_analysis ORDER BY date DESC LIMIT ?",
            (days,)
        ).fetchall()
        con.close()
        if not rows:
            return ""
        lines = []
        for r in rows:
            date, wr, pnl, worked, failed, focus, avoid, verdict = r
            lines.append(
                f"[{date}] {verdict or '?'} | WR {(wr or 0):.0f}% | P&L ${(pnl or 0):+.2f}\n"
                f"  Worked: {(worked or 'n/a')[:120]}\n"
                f"  Failed: {(failed or 'n/a')[:120]}\n"
                f"  Focus:  {(focus or 'n/a')[:80]}\n"
                f"  Avoid:  {(avoid or 'n/a')[:80]}"
            )
        return "\n\n".join(lines)
    except Exception as e:
        log.warning("get_recent_daily_analyses failed: %s", e)
        return ""


def get_yesterday_analysis() -> dict:
    """
    Read the most recent daily_analysis row as a dict.
    Includes parsed `metadata` JSON if present.
    Returns {} if no data exists.
    """
    try:
        con = sqlite3.connect(LESSONS_DB)
        row = con.execute(
            "SELECT date, tomorrow_avoid, verdict, metadata "
            "FROM daily_analysis ORDER BY date DESC LIMIT 1"
        ).fetchone()
        con.close()
        if not row:
            return {}
        result = {
            "date":          row[0] or "",
            "tomorrow_avoid": row[1] or "",
            "verdict":       row[2] or "",
        }
        if row[3]:
            try:
                result.update(json.loads(row[3]))
            except Exception:
                pass
        return result
    except Exception:
        return {}


# ── Post-mortem agent ─────────────────────────────────────────────────────────

def agent_post_mortem(symbol: str, entry: float, exit_price: float,
                      pnl_pct: float, close_reason: str,
                      notify_fn=None):
    """
    Claude reviews a closed trade and extracts a lesson (loss) or success
    pattern (win ≥ +1%). Losses go to lessons DB; wins go to success_patterns.
    """
    if -1.0 < pnl_pct < 1.0:
        return  # skip trivial trades — not enough signal either way

    # Externally closed at a profit (GTC order filled, trailing stop fired correctly)
    # — don't ask Claude, we already know what worked. Save pattern directly.
    _is_external = any(kw in close_reason.lower() for kw in (
        "externally closed", "gtc order", "gtc fill", "overnight stop",
        "trailing stop", "already closed by alpaca",
    ))
    if _is_external and pnl_pct >= 1.0:
        _pattern = "trailing stop profit" if "trailing" in close_reason.lower() \
                   else "GTC exit profit"
        _what    = (f"Position closed externally with {pnl_pct:+.2f}% profit — "
                    f"GTC order or trailing stop fired correctly")
        _when    = "When GTC orders or trailing stops are set and price reaches target"
        save_success_pattern(symbol, pnl_pct, _pattern, _what, _when)
        log_agent("system", "LEARNER",
            f"External win pattern saved for {symbol} ({pnl_pct:+.2f}%): {_pattern}")
        if notify_fn:
            notify_fn(
                f"✅ *Win Pattern: {symbol}*\n"
                f"📈 {pnl_pct:+.2f}% — {_what}\n"
                f"🔁 Repeat when: {_when}"
            )
        return

    is_win = pnl_pct >= 1.0

    log_agent("system", "LEARNER",
        f"{'Win analysis' if is_win else 'Post-mortem'} on {symbol} ({pnl_pct:+.2f}%)...")

    if is_win:
        prompt = f"""You are a trading coach reviewing a winning trade to extract a repeatable success pattern.

Trade details:
- Symbol: {symbol}
- Entry price: ${entry:.4f}
- Exit price: ${exit_price:.4f}
- P&L: {pnl_pct:+.2f}%
- Closed because: {close_reason}

Extract what made this trade work so the system can repeat it.

Return ONLY valid JSON:
{{
  "pattern": "short label e.g. 'reversal at support', 'breakout continuation', 'short at resistance'",
  "what_worked": "one sentence on what signal or condition led to the win",
  "repeat_when": "one sentence on when to look for this setup again"
}}"""
    else:
        prompt = f"""You are a trading coach reviewing a losing trade to extract lessons.

Trade details:
- Symbol: {symbol}
- Entry price: ${entry:.4f}
- Exit price: ${exit_price:.4f}
- P&L: {pnl_pct:+.2f}%
- Closed because: {close_reason}

Return ONLY valid JSON:
{{
  "lesson": "one sentence — what went wrong",
  "avoid": "one sentence — what to avoid next time",
  "pattern": "short label e.g. 'early entry', 'news fade', 'bearish market entry'"
}}"""

    try:
        resp = claude.messages.create(
            model=CLAUDE_HAIKU,
            max_tokens=200,
            messages=[{"role": "user", "content": prompt}],
        )
        result = extract_json(resp.content[0].text)

        if is_win:
            save_success_pattern(
                symbol, pnl_pct,
                result.get("pattern", "unknown"),
                result.get("what_worked", ""),
                result.get("repeat_when", "")
            )
            if notify_fn:
                notify_fn(
                    f"✅ *Win Pattern: {symbol}*\n"
                    f"📈 {pnl_pct:+.2f}% — {result.get('what_worked','')}\n"
                    f"🔁 Repeat when: {result.get('repeat_when','')}"
                )
        else:
            lesson  = result.get("lesson", "Unknown failure")
            avoid   = result.get("avoid", "")
            pattern = result.get("pattern", "unknown")
            save_lesson(symbol, pnl_pct, lesson, avoid, pattern)
            if notify_fn:
                notify_fn(
                    f"📚 *Post-Mortem: {symbol}*\n"
                    f"📉 Loss: {pnl_pct:+.2f}%\n"
                    f"🔍 What went wrong: {lesson}\n"
                    f"⚠️ Avoid next time: {avoid}\n"
                    f"🏷 Pattern: {pattern}"
                )
    except Exception as e:
        log.error("Post-mortem failed for %s: %s", symbol, e)


# ── Helpers ───────────────────────────────────────────────────────────────────

def extract_json(text: str) -> dict:
    text = text.strip()
    # Strip markdown code fences (```json ... ``` or ``` ... ```)
    match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if match:
        text = match.group(1).strip()
    # Strip markdown headers/bullets/explanatory lines that don't contain '{' or '}' —
    # models sometimes prepend "Here's my analysis:\n## Summary\n..." before the JSON.
    text = "\n".join(
        ln for ln in text.split("\n")
        if "{" in ln or "}" in ln or re.match(r"^\s*[\"\w].*[:,]", ln)
    ).strip() or text
    end = text.rfind("}") + 1
    if end == 0:
        raise ValueError(f"No JSON in: {text!r}")
    # Try every '{' as a possible object start — explanatory text can contain
    # braces (e.g. "{ticker}") that aren't the start of the real JSON object.
    for m in re.finditer(r"\{", text):
        try:
            return json.loads(text[m.start():end])
        except (json.JSONDecodeError, ValueError):
            continue
    raise ValueError(f"No JSON in: {text!r}")

CRYPTO_TICKERS = {
    "BTCUSD","ETHUSD","SOLUSD","DOGEUSD","AVAXUSD",
    "MATICUSD","LINKUSD","LTCUSD","XRPUSD"
}

def is_crypto(ticker: str) -> bool:
    return ticker.upper() in CRYPTO_TICKERS

def alpaca_symbol(ticker: str) -> str:
    if is_crypto(ticker):
        base = ticker[:-3]
        return f"{base}/USD"
    return ticker

def get_price(ticker: str) -> float:
    try:
        if is_crypto(ticker):
            sym = alpaca_symbol(ticker)
            from datetime import timezone, timedelta as _td
            _now   = datetime.now(timezone.utc)
            _end   = _now.isoformat()
            _start = (_now - _td(minutes=60)).isoformat()
            for tf, lim, max_age_sec in [
                ("1Min",  2, 2100),
                ("5Min",  2, 2400),
                ("1Hour", 2, 5400),
            ]:
                try:
                    bars = alpaca.get_crypto_bars(
                        sym, tf, start=_start, end=_end, limit=lim).df
                    if bars.empty:
                        continue
                    last_ts = bars.index[-1]
                    if hasattr(last_ts, "to_pydatetime"):
                        last_ts = last_ts.to_pydatetime()
                    if last_ts.tzinfo is None:
                        last_ts = last_ts.replace(tzinfo=timezone.utc)
                    if (_now - last_ts).total_seconds() <= max_age_sec:
                        return float(bars["close"].iloc[-1])
                except Exception:
                    continue
            return 0.0
        else:
            bar = alpaca.get_latest_bar(ticker, feed="iex")
            return float(bar.c)
    except Exception as e:
        log.warning("Price fetch failed %s: %s", ticker, e)
        return 0.0


def calculate_portfolio_delta(equity: float = None) -> dict:
    """
    Calculate portfolio delta — dollar sensitivity to a 1% market move.

    Delta per position = position_value × beta
    Portfolio delta    = sum of all position deltas (longs positive, shorts negative)
    Net delta %        = portfolio_delta / equity × 100

    Returns:
    {
      "net_delta_usd":   float,   # $ portfolio moves per 1% SPY move
      "net_delta_pct":   float,   # % of equity that moves per 1% SPY move
      "long_delta_usd":  float,   # gross long exposure delta
      "short_delta_usd": float,   # gross short exposure delta
      "positions":       list,    # per-position breakdown
      "overexposed":     bool,    # net delta > MAX_PORTFOLIO_DELTA_PCT
      "alert":           str,     # human-readable alert if overexposed
    }
    """
    try:
        if equity is None:
            equity = get_portfolio_equity()
        positions = alpaca.list_positions()
        if not positions:
            return {"net_delta_usd": 0, "net_delta_pct": 0,
                    "long_delta_usd": 0, "short_delta_usd": 0,
                    "positions": [], "overexposed": False, "alert": ""}

        long_delta  = 0.0
        short_delta = 0.0
        pos_details = []

        for p in positions:
            sym          = p.symbol
            qty          = float(p.qty)
            price        = float(p.current_price)
            profile      = get_profile(sym)
            beta         = profile.get("beta", 1.20)
            pos_value    = abs(qty) * price
            pos_delta    = pos_value * beta  # $ moved per 1% market move / 100
            # Expressed as $ per 1% move
            delta_per_pct = pos_delta / 100

            if qty > 0:
                long_delta  += delta_per_pct
            else:
                short_delta += delta_per_pct

            pos_details.append({
                "symbol":       sym,
                "qty":          qty,
                "value":        round(pos_value, 2),
                "beta":         beta,
                "delta_usd":    round(delta_per_pct * (1 if qty > 0 else -1), 2),
                "delta_pct":    round(delta_per_pct / equity * 100, 3),
                "side":         "long" if qty > 0 else "short",
            })

        net_delta_usd = long_delta - short_delta
        net_delta_pct = net_delta_usd / equity * 100
        overexposed   = abs(net_delta_pct) > (MAX_PORTFOLIO_DELTA_PCT * 100)

        alert = ""
        if overexposed:
            direction = "LONG" if net_delta_usd > 0 else "SHORT"
            alert = (f"⚠️ Portfolio delta {net_delta_pct:+.1f}% per 1% SPY move — "
                     f"overexposed {direction}. Consider reducing position size.")

        return {
            "net_delta_usd":   round(net_delta_usd, 2),
            "net_delta_pct":   round(net_delta_pct, 3),
            "long_delta_usd":  round(long_delta, 2),
            "short_delta_usd": round(short_delta, 2),
            "positions":       pos_details,
            "overexposed":     overexposed,
            "alert":           alert,
        }
    except Exception as e:
        log.warning("Delta calculation failed: %s", e)
        return {"net_delta_usd": 0, "net_delta_pct": 0,
                "long_delta_usd": 0, "short_delta_usd": 0,
                "positions": [], "overexposed": False, "alert": ""}

def get_open_positions() -> dict:
    """
    Returns ALL tickers we have exposure to —
    includes filled positions AND pending/accepted orders.
    Prevents double-entry when orders are accepted but not yet filled.
    """
    held = {}
    try:
        for p in alpaca.list_positions():
            held[p.symbol] = p
    except:
        pass
    try:
        pending_statuses = {"accepted", "new", "partially_filled", "pending_new"}
        for o in alpaca.list_orders(status="open", limit=50):
            if o.status in pending_statuses and o.side == "buy":
                if o.symbol not in held:
                    held[o.symbol] = o
                    log_agent("system", "SCANNER",
                        f"Pending order for {o.symbol} — treating as held")
    except:
        pass
    return held

def get_portfolio_equity() -> float:
    try:
        return float(alpaca.get_account().equity)
    except:
        return PORTFOLIO_VALUE

def already_has_position(ticker: str, positions: dict) -> bool:
    clean = ticker.replace("/", "").upper()
    for k in positions:
        if clean == k.replace("/", "").upper():
            return True
    return False

def get_position_side(ticker: str, positions: dict) -> str:
    """Returns 'long', 'short', or 'none' for a given ticker."""
    clean = ticker.replace("/", "").upper()
    for k, p in positions.items():
        if clean == k.replace("/", "").upper():
            try:
                qty = float(p.qty) if hasattr(p, "qty") else 0
                return "short" if qty < 0 else "long"
            except:
                return "long"
    return "none"

def is_market_hours() -> bool:
    """Returns True only during NYSE market hours. Stocks never trade outside this."""
    try:
        import pytz
        ET  = pytz.timezone("America/New_York")
        now = datetime.now(ET)
    except Exception:
        from datetime import timezone, timedelta
        ET_offset = timedelta(hours=-4)  # EDT fallback
        now = datetime.now(timezone(ET_offset))
    
    if now.weekday() >= 5:
        return False
    if now.hour < 9 or now.hour >= 16:
        return False
    if now.hour == 9 and now.minute < 30:
        return False
    log.debug("Market hours check: %s ET → OPEN", now.strftime("%H:%M"))
    return True

def is_good_entry_time() -> tuple[bool, str]:
    """
    Check if current time is good for new stock entries.
    Keeps only the last 15 min (3:45-4pm) as a hard close gate.
    Riley zone gate handles opening noise — no separate block needed.
    Crypto is never affected — checked separately.
    Returns (ok_to_enter, reason).
    """
    import pytz
    ET  = pytz.timezone("America/New_York")
    now = datetime.now(ET)

    # Not market hours at all — handled separately
    if not is_market_hours():
        return True, ""

    h, m = now.hour, now.minute

    # Last 15 minutes — 3:45 to 4:00pm — too close to close for new entries
    if h == 15 and m >= 45:
        remaining = 60 - m
        return (False,
            f"Closing window (3:45-4pm ET) — "
            f"{remaining}min until market close — no new entries")

    return True, ""



def is_market_open_alpaca() -> bool:
    """Check market status directly from Alpaca — most reliable."""
    try:
        clock = alpaca.get_clock()
        return clock.is_open
    except:
        return is_market_hours()

def get_market_condition() -> str:
    """
    Uses both 1-day and 5-day SPY change for a more sensitive signal.
    BEARISH if today down -0.5%+ OR 5-day trend down -1%+.
    """
    try:
        bars = alpaca.get_bars(MARKET_PROXY, "1Day", limit=10, feed="iex").df
        if len(bars) < 2:
            return "NEUTRAL"
        closes = bars["close"].tolist()
        pct_1d = ((closes[-1] - closes[-2]) / closes[-2]) * 100
        pct_5d = ((closes[-1] - closes[-5]) / closes[-5]) * 100 if len(closes) >= 5 else 0

        log_agent("system", "MARKET",
            f"SPY — today: {pct_1d:+.2f}% | 5-day: {pct_5d:+.2f}%")

        if pct_1d <= -0.5 or pct_5d <= -1.0:
            condition = "BEARISH"
        elif pct_1d >= 0.5 and pct_5d >= 0.5:
            condition = "BULLISH"
        else:
            condition = "NEUTRAL"

        log_agent("system", "MARKET", f"Condition: {condition}")
        return condition
    except Exception as e:
        log.warning("Market check failed: %s", e)
        return "NEUTRAL"

# ── VIX volatility regime ─────────────────────────────────────────────────────

_vix_cache: dict = {}
VIX_CACHE_SECONDS = 1800  # refresh every 30 min

# VIX thresholds — 3 user-visible regimes
VIX_CALM     = 15   # below 15  = normal trading
VIX_ELEVATED = 25   # 15-25     = elevated (wider stops, smaller size)
VIX_HIGH     = 40   # 25-40     = high (much wider stops, smaller size)
# above 40          = extreme (all new entries halted)

def get_vix() -> float:
    """
    Fetch latest VIX approximation using VIXY ETF.
    VIXY price closely tracks VIX level directly (no multiplier needed).
    Falls back to SPY realized volatility if VIXY unavailable.
    """
    import time as _time
    now = _time.time()
    if "vix" in _vix_cache:
        cached_time, val = _vix_cache["vix"]
        if now - cached_time < VIX_CACHE_SECONDS:
            return val

    try:
        bars = alpaca.get_bars("VIXY", "1Day", limit=3, feed="iex").df
        if bars.empty:
            raise ValueError("No VIXY data")
        # VIXY price directly approximates VIX level (e.g. VIXY $27 ≈ VIX 27)
        vix_approx = round(float(bars["close"].iloc[-1]), 1)
        _vix_cache["vix"] = (now, vix_approx)
        log_agent("system", "VIX", f"VIXY ${vix_approx:.2f} → VIX approx {vix_approx:.1f}")
        return vix_approx
    except Exception:
        # Fallback — SPY realized volatility
        try:
            bars = alpaca.get_bars("SPY", "1Day", limit=21, feed="iex").df
            if len(bars) < 10:
                return 15.0
            closes  = bars["close"].tolist()
            returns = [(closes[i] - closes[i-1]) / closes[i-1]
                       for i in range(1, len(closes))]
            import math
            std        = math.sqrt(sum(r**2 for r in returns) / len(returns))
            vix_approx = round(std * math.sqrt(252) * 100, 1)
            _vix_cache["vix"] = (now, vix_approx)
            log_agent("system", "VIX",
                f"VIX from SPY realized vol: {vix_approx:.1f}")
            return vix_approx
        except Exception as e:
            log.warning("VIX fetch failed: %s", e)
            return 15.0

def get_vix_regime() -> dict:
    """
    Returns the current volatility regime with sizing/stop adjustments.

    3 user-visible regimes (CALM / ELEVATED / HIGH) + internal EXTREME:
      CALM     VIX < 15 : normal operation
      ELEVATED VIX 15-25: stops ×1.6, size ×0.7
      HIGH     VIX 25-40: stops ×2.0, size ×0.5
      EXTREME  VIX > 40 : all new entries halted

    Keys:
      stop_mult: float         — multiply stop distance from entry by this
      size_multiplier: float
      allow_new_entries: bool
    """
    vix = get_vix()

    if vix < VIX_CALM:
        regime = {
            "vix":              vix,
            "regime":           "CALM",
            "allow_stocks":     True,
            "allow_crypto":     True,
            "allow_new_entries":True,
            "size_multiplier":  1.0,
            "stop_mult":        1.0,
            "description":      f"VIX {vix:.1f} — calm market, normal operation",
        }
    elif vix < VIX_ELEVATED:
        regime = {
            "vix":              vix,
            "regime":           "ELEVATED",
            "allow_stocks":     True,
            "allow_crypto":     True,
            "allow_new_entries":True,
            "size_multiplier":  0.7,
            "stop_mult":        1.6,   # stops 60% wider
            "description":      f"VIX {vix:.1f} — elevated fear, wider stops ×1.6, size ×0.7",
        }
    elif vix < VIX_HIGH:
        regime = {
            "vix":              vix,
            "regime":           "HIGH",
            "allow_stocks":     True,
            "allow_crypto":     True,
            "allow_new_entries":True,
            "size_multiplier":  0.5,
            "stop_mult":        2.0,   # stops 100% wider
            "description":      f"VIX {vix:.1f} — high fear, stops ×2.0, size ×0.5",
        }
    else:
        regime = {
            "vix":              vix,
            "regime":           "EXTREME",
            "allow_stocks":     False,
            "allow_crypto":     False,
            "allow_new_entries":False,
            "size_multiplier":  0.0,
            "stop_mult":        1.8,
            "description":      f"VIX {vix:.1f} — extreme fear, all new entries halted",
        }

    log_agent("system", "VIX",
        f"Regime: {regime['regime']} (VIX {vix:.1f}) | "
        f"stop×{regime['stop_mult']:.1f} | "
        f"size×{regime['size_multiplier']:.1f}")
    return regime


# ── Market bias (SPY multi-timeframe) ────────────────────────────────────────
_market_bias_cache: dict = {}
_market_bias_cache_time: float = 0.0

def get_market_bias() -> str:
    """
    Determine broad market trend from SPY's 15-min trend (EMA9/EMA21 via
    _get_tf_direction) — the SAME timeframe and method used by
    check_spy_qqq_alignment, so the two can never contradict in reports.
    Cached 15 minutes to avoid excessive API calls.
    """
    global _market_bias_cache, _market_bias_cache_time
    import time as _time
    if _time.time() - _market_bias_cache_time < 900 and _market_bias_cache:
        return _market_bias_cache.get("bias", "NEUTRAL")
    try:
        spy_dir = _get_tf_direction("SPY", "15Min")
        bias = spy_dir if spy_dir in ("BULLISH", "BEARISH") else "NEUTRAL"

        _market_bias_cache = {"bias": bias, "15Min": spy_dir}
        _market_bias_cache_time = _time.time()
        log_agent("system", "BIAS", f"SPY market bias (15-min): {bias}")
        return bias
    except Exception as e:
        log.warning("Market bias check failed: %s", e)
        return "NEUTRAL"


_spy_qqq_cache = {}
_spy_qqq_cache_time = 0.0


def check_spy_qqq_alignment() -> dict:
    """
    Secondary correlation check — QQQ as a stock-tradable proxy for NQ futures
    (we trade stocks, not futures), confirming or contradicting the SPY/ES
    market bias.

    Compares SPY's and QQQ's 15-min trend direction (EMA9/EMA21 crossover):
    - Aligned (both bullish or both bearish) → strong signal, proceed normally
    - Diverged (one bullish, one bearish)    → 'ES/NQ DIVERGENCE — staying
      cautious': raises the confidence threshold (+15) so entries are much
      harder to trigger, without blocking them outright

    SPY remains the PRIMARY bias filter ([[get_market_bias]]) — this is
    additive confirmation only. Cached 15 minutes to avoid excess API calls.
    """
    global _spy_qqq_cache, _spy_qqq_cache_time
    import time as _time
    if _time.time() - _spy_qqq_cache_time < 900 and _spy_qqq_cache:
        return _spy_qqq_cache

    spy_dir = _get_tf_direction("SPY", "15Min")
    qqq_dir = _get_tf_direction("QQQ", "15Min")

    _directional = ("BULLISH", "BEARISH")
    diverged = (spy_dir in _directional and qqq_dir in _directional and spy_dir != qqq_dir)
    aligned  = (spy_dir in _directional and spy_dir == qqq_dir)

    result = {
        "spy_dir":            spy_dir,
        "qqq_dir":            qqq_dir,
        "aligned":            aligned,
        "diverged":           diverged,
        "confidence_penalty": 15 if diverged else 0,
        "summary":            f"SPY:{spy_dir} / QQQ:{qqq_dir}"
                              + (" — DIVERGED ⚠️" if diverged
                                 else " — aligned ✅" if aligned else " — mixed"),
    }

    if diverged:
        log_agent("system", "BIAS",
            f"ES/NQ DIVERGENCE — staying cautious (SPY:{spy_dir} vs QQQ:{qqq_dir}) "
            f"— confidence threshold +{result['confidence_penalty']} for all entries")
    else:
        log_agent("system", "BIAS",
            f"SPY/QQQ alignment: SPY:{spy_dir} QQQ:{qqq_dir} "
            f"— {'aligned, strong signal' if aligned else 'mixed/neutral'}")

    _spy_qqq_cache = result
    _spy_qqq_cache_time = _time.time()
    return result


# ── Agent 1 — Grok ────────────────────────────────────────────────────────────


def get_earnings_calendar(tickers: list) -> dict:
    """
    Fetch next earnings date for each ticker using Alpaca news + pattern detection.
    Returns {ticker: {"date": "YYYY-MM-DD", "days_away": int, "risk": "HIGH"|"LOW"}}
    """
    import re
    from datetime import datetime, timedelta, timezone

    results = {}
    today   = datetime.now(timezone.utc).date()

    for ticker in tickers:
        try:
            # Fetch recent news mentioning earnings
            news = alpaca.get_news(symbol=ticker, limit=10)
            earnings_date = None

            for article in news:
                headline = (article.headline or "").lower()
                summary  = (article.summary  or "").lower()
                text     = headline + " " + summary

                # Look for upcoming earnings mentions
                if any(kw in text for kw in
                       ["earnings", "quarterly results", "q1", "q2", "q3", "q4",
                        "fiscal quarter", "eps", "revenue report"]):
                    # Try to extract a date
                    date_patterns = [
                        r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}",
                        r"\d{1,2}/\d{1,2}/\d{2,4}",
                        r"\d{4}-\d{2}-\d{2}",
                    ]
                    for pat in date_patterns:
                        match = re.search(pat, text, re.IGNORECASE)
                        if match:
                            try:
                                raw = match.group()
                                # Try parsing common formats
                                for fmt in ["%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"]:
                                    try:
                                        earnings_date = datetime.strptime(raw, fmt).date()
                                        break
                                    except:
                                        pass
                            except:
                                pass
                    if earnings_date:
                        break

            if earnings_date and earnings_date >= today:
                days_away = (earnings_date - today).days
                results[ticker] = {
                    "date":      str(earnings_date),
                    "days_away": days_away,
                    "risk":      "HIGH" if days_away <= 3 else "MEDIUM" if days_away <= 7 else "LOW",
                }
            else:
                results[ticker] = {"date": None, "days_away": 999, "risk": "LOW"}

        except Exception as e:
            log.warning("Earnings check failed %s: %s", ticker, e)
            results[ticker] = {"date": None, "days_away": 999, "risk": "LOW"}

    return results


def get_premarket_analysis(watchlist: list, equity: float) -> dict:
    """
    Run at 9:00am ET — analyze overnight developments before market open.

    Fetches:
    - Overnight futures direction (SPY pre-market)
    - News since previous close for each ticker
    - Earnings risk for the day
    - Sector rotation update

    Returns a pre-market brief sent to Telegram.
    """
    import pytz
    ET  = pytz.timezone("America/New_York")
    now = datetime.now(ET)

    log_agent("system", "PREMARKET", f"Pre-market analysis starting — {now.strftime('%H:%M ET')}")

    results = {
        "tickers":     {},
        "market_bias": "NEUTRAL",
        "alerts":      [],
        "earnings":    {},
    }

    # 1. Fetch SPY pre-market direction
    try:
        spy_bars = alpaca.get_bars("SPY", "5Min", limit=6, feed="iex").df
        if not spy_bars.empty:
            spy_open  = float(spy_bars["open"].iloc[0])
            spy_close = float(spy_bars["close"].iloc[-1])
            spy_chg   = (spy_close - spy_open) / spy_open * 100
            if spy_chg > 0.3:
                results["market_bias"] = "BULLISH"
            elif spy_chg < -0.3:
                results["market_bias"] = "BEARISH"
            results["spy_premarket_chg"] = round(spy_chg, 2)
            log_agent("system", "PREMARKET", f"SPY pre-market: {spy_chg:+.2f}%")
    except Exception as e:
        log.warning("SPY pre-market fetch failed: %s", e)
        results["spy_premarket_chg"] = 0.0

    # 2. Earnings calendar for today + next 3 days
    stocks = [t for t in watchlist if not is_crypto(t)]
    earnings = get_earnings_calendar(stocks)
    results["earnings"] = earnings

    high_risk = [t for t, e in earnings.items() if e["risk"] == "HIGH"]
    if high_risk:
        results["alerts"].append(
            f"⚠️ Earnings within 3 days: {', '.join(high_risk)} — "
            f"reduce position size, widen stops"
        )

    # 3. Per-ticker overnight scan via Grok
    for ticker in stocks[:6]:  # limit API calls
        try:
            news = alpaca.get_news(symbol=ticker, limit=5)
            news_text = " | ".join([
                (n.headline or "")
                for n in news
            ][:3]) if news else "No recent news"

            earnings_note = ""
            if earnings.get(ticker, {}).get("risk") in ("HIGH", "MEDIUM"):
                d = earnings[ticker]
                earnings_note = (f"EARNINGS IN {d['days_away']} DAYS ({d['date']}) — "
                                 f"this is HIGH RISK. Be very cautious.")

            prompt = f"""Pre-market analysis for {ticker}.
Market context: SPY pre-market {results.get('spy_premarket_chg', 0):+.2f}%
Overnight news: {news_text}
{earnings_note}

In 2 sentences: what is the likely opening bias for {ticker} today and why?
Consider BOTH directions equally:
- BULLISH: if there's positive news, the stock is near support, or it's oversold
- BEARISH: if there's negative news, the stock is near resistance, or it's overbought
- NEUTRAL: if there's no clear edge in either direction

Rate: BULLISH / BEARISH / NEUTRAL with confidence 0-100.
Also identify the key price level to watch (support for longs, resistance for shorts).

Return JSON only:
{{"bias": "BULLISH|BEARISH|NEUTRAL", "confidence": 65,
  "summary": "two sentence summary",
  "watch_level": "key price level to watch at open",
  "setup_type": "LONG_REVERSAL|SHORT_REVERSAL|CONTINUATION|NEUTRAL"}}"""

            resp = grok.chat.completions.create(
                model="grok-3-mini",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=150,
            )
            raw = resp.choices[0].message.content.strip()
            analysis = extract_json(raw)
            results["tickers"][ticker] = analysis
            log_agent("system", "PREMARKET",
                f"{ticker}: {analysis.get('bias','?')} {analysis.get('confidence','?')}% — "
                f"{analysis.get('summary','')[:80]}")

        except Exception as e:
            log.warning("Pre-market analysis failed %s: %s", ticker, e)
            results["tickers"][ticker] = {"bias": "NEUTRAL", "confidence": 50,
                                          "summary": "No data", "watch_level": "N/A"}

    return results


# Cache adaptive RSI thresholds — recalculated once per session per ticker
_rsi_threshold_cache: dict = {}

def get_adaptive_rsi_thresholds(ticker: str) -> dict:
    """
    Calculate stock-specific RSI oversold/overbought thresholds based on
    90 days of historical RSI values.

    Instead of generic 35/65:
    - Oversold threshold  = 15th percentile of historical RSI
    - Overbought threshold = 85th percentile of historical RSI

    Examples:
    - SPY (low vol):   oversold ~38, overbought ~62  (narrow range, rare extremes)
    - TSLA (high vol): oversold ~28, overbought ~72  (wide range, hits extremes often)
    - NVDA (momentum): oversold ~30, overbought ~75  (tends to stay overbought)

    Results cached per session to avoid repeated API calls.
    """
    global _rsi_threshold_cache
    if ticker in _rsi_threshold_cache:
        return _rsi_threshold_cache[ticker]

    FALLBACK = {"oversold": 35, "overbought": 65,
                "p10": 30, "p25": 40, "p75": 60, "p90": 70,
                "median": 50, "source": "fallback"}

    try:
        from datetime import timezone, timedelta
        start = (datetime.now(timezone.utc) - timedelta(days=90)).strftime("%Y-%m-%d")
        bars  = alpaca.get_bars(ticker, "1Hour", start=start,
                                limit=2200, feed="iex").df

        if bars.empty or len(bars) < 50:
            _rsi_threshold_cache[ticker] = FALLBACK
            return FALLBACK

        closes = bars["close"].tolist()

        # Calculate RSI at every bar using 14-period
        def calc_rsi_series(closes, period=14):
            rsi_vals = []
            for i in range(period, len(closes)):
                window = closes[i - period:i + 1]
                gains  = [max(window[j] - window[j-1], 0) for j in range(1, len(window))]
                losses = [max(window[j-1] - window[j], 0) for j in range(1, len(window))]
                ag = sum(gains) / period
                al = sum(losses) / period
                if al == 0:
                    rsi_vals.append(100.0)
                else:
                    rs = ag / al
                    rsi_vals.append(round(100 - (100 / (1 + rs)), 1))
            return rsi_vals

        rsi_series = calc_rsi_series(closes)
        if len(rsi_series) < 20:
            _rsi_threshold_cache[ticker] = FALLBACK
            return FALLBACK

        rsi_sorted = sorted(rsi_series)
        n          = len(rsi_sorted)

        def percentile(p):
            idx = int(p / 100 * n)
            return round(rsi_sorted[min(idx, n-1)], 1)

        thresholds = {
            "oversold":   percentile(15),   # historically oversold
            "overbought": percentile(85),   # historically overbought
            "p10":        percentile(10),   # extreme oversold
            "p25":        percentile(25),   # mild oversold
            "p75":        percentile(75),   # mild overbought
            "p90":        percentile(90),   # extreme overbought
            "median":     percentile(50),
            "source":     f"90d history ({n} RSI values)",
        }

        _rsi_threshold_cache[ticker] = thresholds
        log_agent("system", "RSI_ADAPT",
            f"{ticker} RSI thresholds: "
            f"oversold={thresholds['oversold']} "
            f"overbought={thresholds['overbought']} "
            f"median={thresholds['median']} "
            f"(from {thresholds['source']})")
        return thresholds

    except Exception as e:
        log.warning("Adaptive RSI failed %s: %s", ticker, e)
        _rsi_threshold_cache[ticker] = FALLBACK
        return FALLBACK


# ─────────────────────────────────────────────────────────────────────────────
# RILEY COLEMAN STRATEGY ENGINE
# Support/resistance zones on 15-min → 1-min entry confirmation
# ─────────────────────────────────────────────────────────────────────────────

# Riley break-and-retest tracking.
# _broken_zones: {ticker: [{"ticker", "zone_level", "zone_top", "zone_bottom",
#                           "zone_type", "direction_broken", "time_broken",
#                           "max_excursion_pct", "retested"}, ...]}
# A support zone closed below on the 15-min chart is "broken to the downside";
# a resistance zone closed above is "broken to the upside". A retest occurs
# when price returns to within 0.5% of (or back inside the range of) a broken
# zone after having moved at least 0.3% beyond it — Riley then watches the
# OPPOSITE direction of the original break (broken support retest = SHORT,
# broken resistance retest = LONG).
_broken_zones: dict = {}
_broken_zones_last_bar: dict = {}


def _riley_update_broken_zones_and_retests(ticker: str, price: float,
                                            good_zones: list, times: list,
                                            closes: list) -> None:
    """
    Riley break-and-retest detection — runs once per fresh 15-min candle:
    1) Marks SUPPORT zones broken when a 15-min candle closes below their
       range, and RESISTANCE zones broken when one closes above.
    2) Tracks each broken zone's maximum excursion beyond its level.
    3) Flags a retest once price returns into the zone's range (wick-to-body
       width — a range, not a line) or within 0.5% of its level, having moved
       at least 0.3% beyond it first — and adds the ticker to watch mode in
       the OPPOSITE direction of the break.
    """
    global _broken_zones, _broken_zones_last_bar
    try:
        if not times or not closes:
            return
        last_bar_t = str(times[-1])
        if _broken_zones_last_bar.get(ticker) == last_bar_t:
            return  # already processed this 15-min candle
        _broken_zones_last_bar[ticker] = last_bar_t

        last_close = closes[-1]

        broken_list = _broken_zones.setdefault(ticker, [])

        # ── New breaks: a 15-min candle closes beyond a zone's range ─────────
        for z in good_zones:
            # Only track breaks of zones that are actually fresh (recency tier
            # "today"/"recent"/"weekly" — not "older"/"structural", which are
            # months-old levels that flood the system when marked "broken")
            # and strong enough to matter (strength >= 70 — weak zones ignored).
            if (z.get("recency") not in ("today", "recent", "weekly")
                    or z.get("strength", 0) < 70
                    or z.get("type") not in ("SUPPORT", "RESISTANCE")):
                continue
            zone_level, zone_top, zone_bottom = z["mid"], z["top"], z["bottom"]
            already = any(abs(b["zone_level"] - zone_level) / zone_level < 0.001
                          and b["zone_type"] == z["type"] for b in broken_list)
            if already:
                continue

            # Distance filter — a zone broken far from current price is no
            # longer relevant for retest watching (e.g. SOL broke $62
            # resistance but is now at $67 — 7% away, not actionable).
            if abs(price - zone_level) / price > 0.05:
                continue

            if z["type"] == "SUPPORT" and last_close < zone_bottom:
                broken_list.append({
                    "ticker":            ticker,
                    "zone_level":        zone_level,
                    "zone_top":          zone_top,
                    "zone_bottom":       zone_bottom,
                    "zone_type":         "SUPPORT",
                    "direction_broken":  "DOWN",
                    "time_broken":       datetime.now().isoformat(),
                    "max_excursion_pct": abs(price - zone_level) / zone_level * 100,
                    "retested":          False,
                })
                log_agent("system", "RILEY",
                    f"{ticker} BREAK: support ${zone_level:.4f} closed below "
                    f"on 15-min — watching for retest")
            elif z["type"] == "RESISTANCE" and last_close > zone_top:
                broken_list.append({
                    "ticker":            ticker,
                    "zone_level":        zone_level,
                    "zone_top":          zone_top,
                    "zone_bottom":       zone_bottom,
                    "zone_type":         "RESISTANCE",
                    "direction_broken":  "UP",
                    "time_broken":       datetime.now().isoformat(),
                    "max_excursion_pct": abs(price - zone_level) / zone_level * 100,
                    "retested":          False,
                })
                log_agent("system", "RILEY",
                    f"{ticker} BREAK: resistance ${zone_level:.4f} closed above "
                    f"on 15-min — watching for retest")

        # Keep only the 3 most recently broken zones per ticker — older
        # entries are dropped so the system doesn't flood with stale breaks.
        if len(broken_list) > 3:
            broken_list.sort(key=lambda b: b["time_broken"], reverse=True)
            del broken_list[3:]

        # ── Track excursion + detect retest on already-broken zones ──────────
        for b in broken_list:
            if b["retested"] or b["zone_level"] <= 0:
                continue
            zone_level = b["zone_level"]
            dist_pct   = abs(price - zone_level) / zone_level * 100

            # Only count excursion while price is still on the broken side
            beyond = (price < zone_level) if b["direction_broken"] == "DOWN" else (price > zone_level)
            if beyond:
                b["max_excursion_pct"] = max(b["max_excursion_pct"], dist_pct)

            in_zone_range = b["zone_bottom"] <= price <= b["zone_top"]
            near_level    = dist_pct <= 0.5
            if b["max_excursion_pct"] >= 0.3 and (in_zone_range or near_level):
                b["retested"] = True
                watch_side = "SHORT" if b["zone_type"] == "SUPPORT" else "LONG"
                from_side  = "below" if b["zone_type"] == "SUPPORT" else "above"
                log_agent("system", "RILEY",
                    f"RETEST WATCH: {ticker} broken {b['zone_type']} retesting "
                    f"from {from_side} — watching for {watch_side}")
                if (ticker not in _watch_mode
                        and len(_watch_mode) < WATCH_MODE_MAX_TICKERS):
                    _watch_mode[ticker] = {
                        "ticker":          ticker,
                        "side":            watch_side,
                        "zone_level":      zone_level,
                        "zone_strength":   70,
                        "confidence":      70,
                        "time_entered":    datetime.now().isoformat(),
                        "candles_checked": 0,
                        "trigger_level":   None,
                        "retest":          True,
                    }
    except Exception as e:
        log.warning("Riley broken-zone/retest check failed %s: %s", ticker, e)


def find_sr_zones(ticker: str, price: float) -> dict:
    """
    Stage 1: Identify high-probability S/R ZONES on 15-min chart.
    
    Uses TIERED lookback — recent zones weighted more heavily:
    - Today's levels (intraday high/low/open) — highest weight
    - Last 2 days — high weight  
    - Last 5 days — normal weight
    - Weekly levels (Mon open, weekly high/low) — structural
    
    Zones recalculate every scan so they always reflect current structure.
    """
    try:
        from datetime import timezone, timedelta
        import pytz
        ET = pytz.timezone("America/New_York")

        # Fetch 15-min bars — 10 days for weekly structure
        start = (datetime.now(timezone.utc) - timedelta(days=10)).strftime("%Y-%m-%d")
        if is_crypto(ticker):
            sym  = alpaca_symbol(ticker)
            bars = alpaca.get_crypto_bars(sym, "15Min",
                                           start=start, limit=1000).df
        else:
            bars = alpaca.get_bars(ticker, "15Min",
                                   start=start, limit=1000, feed="iex").df
        if bars.empty or len(bars) < 20:
            log.warning("find_sr_zones %s: insufficient bars (%d) — returning empty zones",
                        ticker, len(bars) if not bars.empty else 0)
            return {"zones": [], "in_zone": False, "zone_type": "NONE",
                    "zone_strength": 0, "nearest_zone": None,
                    "dist_to_nearest": 99}
        if not price or price <= 0:
            log.warning("find_sr_zones %s: invalid price %s — returning empty zones",
                        ticker, price)
            return {"zones": [], "in_zone": False, "zone_type": "NONE",
                    "zone_strength": 0, "nearest_zone": None,
                    "dist_to_nearest": 99}

        highs  = bars["high"].tolist()
        lows   = bars["low"].tolist()
        closes = bars["close"].tolist()
        opens  = bars["open"].tolist()
        times  = bars.index.tolist()

        now_et  = datetime.now(ET)
        today   = now_et.date()

        # ── Split bars into recency tiers ────────────────────────────────────
        def _et_date(ts):
            """Convert a bar timestamp to an ET date, handling naive timestamps."""
            try:
                if ts.tzinfo is None:
                    return ET.localize(ts.to_pydatetime() if hasattr(ts, 'to_pydatetime') else ts).date()
                return ts.astimezone(ET).date()
            except Exception:
                return today  # fallback: treat as today rather than crash

        today_idxs    = [i for i, t in enumerate(times)
                         if _et_date(t) == today]
        # Crypto UTC fix: if no today bars, use last 24h (timezone boundary)
        if not today_idxs and is_crypto(ticker):
            today_idxs = [i for i, t in enumerate(times)
                          if (today - _et_date(t)).days <= 1]
        today_set     = set(today_idxs)
        recent_idxs   = [i for i, t in enumerate(times)
                         if 0 <= (today - _et_date(t)).days <= 2
                         and i not in today_set]
        recent_set    = set(recent_idxs)
        older_idxs    = [i for i in range(len(times))
                         if i not in today_set and i not in recent_set]

        # ── Key levels from today + pre-market ──────────────────────────────
        # Riley explicitly uses pre-market highs/lows as key zones
        today_zones = []
        if today_idxs:
            day_open  = opens[today_idxs[0]]
            day_high  = max(highs[i] for i in today_idxs)
            day_low   = min(lows[i]  for i in today_idxs)
            today_zones.append({
                "type": "TODAY_OPEN", "price": day_open,
                "strength": 75, "recency": "today"
            })
            if abs(day_high - price) / price > 0.002:
                today_zones.append({
                    "type": "TODAY_HIGH", "price": day_high,
                    "strength": 70, "recency": "today"
                })
            if abs(day_low - price) / price > 0.002:
                today_zones.append({
                    "type": "TODAY_LOW", "price": day_low,
                    "strength": 70, "recency": "today"
                })

        # Pre-market levels — fetch extended hours bars
        try:
            pm_start = (datetime.now(timezone.utc) - timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%SZ")
            pm_bars  = alpaca.get_bars(ticker, "15Min", start=pm_start,
                                       limit=20, feed="iex").df
            if not pm_bars.empty:
                # Filter to pre-market (before 9:30am ET today)
                def _pm_et(ts):
                    try:
                        return ts.astimezone(ET) if ts.tzinfo else ET.localize(
                            ts.to_pydatetime() if hasattr(ts, 'to_pydatetime') else ts)
                    except Exception:
                        return ts
                pm_filtered = [i for i, t in enumerate(pm_bars.index.tolist())
                               if _pm_et(t).hour < 9 or
                               (_pm_et(t).hour == 9 and _pm_et(t).minute < 30)]
                if pm_filtered:
                    pm_h = pm_bars["high"].tolist()
                    pm_l = pm_bars["low"].tolist()
                    pm_high = max(pm_h[i] for i in pm_filtered)
                    pm_low  = min(pm_l[i] for i in pm_filtered)
                    if abs(pm_high - price) / price > 0.001:
                        today_zones.append({
                            "type": "PREMARKET_HIGH", "price": pm_high,
                            "strength": 72, "recency": "today"
                        })
                    if abs(pm_low - price) / price > 0.001:
                        today_zones.append({
                            "type": "PREMARKET_LOW", "price": pm_low,
                            "strength": 72, "recency": "today"
                        })
        except Exception:
            pass  # Pre-market data optional — don't break if unavailable

        # ── Weekly levels ─────────────────────────────────────────────────────
        weekly_zones = []
        week_start = today - timedelta(days=today.weekday())  # Monday
        # Crypto bars use UTC — use last 5 days to avoid timezone boundary gaps
        lookback_start = today - timedelta(days=5)
        week_idxs  = [i for i, t in enumerate(times)
                      if _et_date(t) >= (lookback_start if is_crypto(ticker) else week_start)]
        if week_idxs:
            week_highs_vals = [highs[i] for i in week_idxs if i < len(highs)]
            week_lows_vals  = [lows[i]  for i in week_idxs if i < len(lows)]
            if not week_highs_vals or not week_lows_vals:
                week_idxs = []   # skip if we got nothing valid
            else:
                week_high = max(week_highs_vals)
                week_low  = min(week_lows_vals)
                week_open = opens[week_idxs[0]] if week_idxs[0] < len(opens) else week_high
        if week_idxs:
            weekly_zones.extend([
                {"type": "WEEK_HIGH",  "price": week_high,
                 "strength": 75, "recency": "weekly"},
                {"type": "WEEK_LOW",   "price": week_low,
                 "strength": 75, "recency": "weekly"},
                {"type": "WEEK_OPEN",  "price": week_open,
                 "strength": 70, "recency": "weekly"},
            ])

        # ── Swing high/low detection (recency-weighted) ───────────────────────
        def find_swings(idxs, lookback=2):
            s_highs, s_lows = [], []
            n_idx = len(idxs)
            if n_idx < lookback * 2 + 1:   # not enough points for this lookback
                return s_highs, s_lows
            for pos, i in enumerate(idxs):
                if pos < lookback or pos >= n_idx - lookback:
                    continue
                try:
                    window_h = [highs[idxs[pos+k]] for k in range(-lookback, lookback+1)]
                    window_l = [lows[idxs[pos+k]]  for k in range(-lookback, lookback+1)]
                    if not window_h or not window_l:
                        continue
                    wh_max = max(window_h)
                    wl_min = min(window_l)
                    if highs[i] == wh_max:
                        s_highs.append({"price": highs[i],
                                        "body": max(opens[i], closes[i]),
                                        "idx": i})
                    if lows[i] == wl_min:
                        s_lows.append({"price": lows[i],
                                       "body": min(opens[i], closes[i]),
                                       "idx": i})
                except (IndexError, ValueError):
                    continue
            return s_highs, s_lows

        # Recency multipliers for strength scoring
        today_sh,  today_sl  = find_swings(today_idxs,  lookback=2)
        recent_sh, recent_sl = find_swings(recent_idxs, lookback=3)
        older_sh,  older_sl  = find_swings(older_idxs,  lookback=4)

        def recency_strength(base, recency):
            return {
                "today":  min(100, base * 1.4),
                "recent": min(100, base * 1.2),
                "older":  base,
            }.get(recency, base)

        # ── Cluster zones (within 0.3% = same zone) ──────────────────────────
        def cluster_to_zones(swing_pts, zone_type, recency, base_strength=40):
            """
            Riley's zone drawing:
            - Top boundary = extreme of WICKS (highest/lowest price reached)
            - Bottom boundary = MEAT of candle bodies (where majority reversed)
            """
            if not swing_pts:
                return []
            key = "price"
            try:
                sorted_pts = sorted(swing_pts, key=lambda x: x[key])
            except (KeyError, TypeError):
                return []

            clusters, current = [], [sorted_pts[0]]
            for pt in sorted_pts[1:]:
                ref = current[0][key]
                if ref <= 0:        # guard against zero/negative prices
                    clusters.append(current)
                    current = [pt]
                    continue
                if abs(pt[key] - ref) / ref < 0.005:
                    current.append(pt)
                else:
                    clusters.append(current)
                    current = [pt]
            clusters.append(current)

            zones = []
            for cluster_pts in clusters:
                if not cluster_pts:
                    continue
                try:
                    touches = len(cluster_pts)
                    wick_extreme = sum(p["price"] for p in cluster_pts) / touches
                    body_meat    = sum(p["body"]  for p in cluster_pts) / touches

                    strong_move = False
                    last_idx = max(p["idx"] for p in cluster_pts)
                    if 0 <= last_idx < len(closes) - 3 and closes[last_idx] != 0:
                        move = abs(closes[last_idx+2] - closes[last_idx]) / closes[last_idx] * 100
                        strong_move = move > 0.25

                    strength = recency_strength(
                        min(100, touches * 25 + (20 if strong_move else 0) + base_strength),
                        recency
                    )

                    if zone_type == "RESISTANCE":
                        top, bot = wick_extreme, body_meat
                    else:
                        top, bot = body_meat, wick_extreme

                    top, bot = max(top, bot), min(top, bot)
                    if top <= 0 or bot <= 0:    # skip degenerate zones
                        continue

                    zones.append({
                        "type":        zone_type,
                        "top":         round(top, 4),
                        "bottom":      round(bot, 4),
                        "mid":         round((top + bot) / 2, 4),
                        "touches":     touches,
                        "strong_move": strong_move,
                        "strength":    round(strength),
                        "recency":     recency,
                    })
                except (IndexError, ValueError, ZeroDivisionError):
                    continue
            return zones

        zones = []

        # ── Riley pre-market zones take priority during the 9:30am-3:30pm window ──
        try:
            _hr_pmz = now_et.hour + now_et.minute / 60
            if 9.5 <= _hr_pmz < 15.5:
                zones += list(_premarket_zones.get(ticker, []))
        except Exception:
            pass

        zones += cluster_to_zones(today_sh,  "RESISTANCE", "today",  base_strength=50)
        zones += cluster_to_zones(today_sl,  "SUPPORT",    "today",  base_strength=50)
        zones += cluster_to_zones(recent_sh, "RESISTANCE", "recent", base_strength=40)
        zones += cluster_to_zones(recent_sl, "SUPPORT",    "recent", base_strength=40)
        zones += cluster_to_zones(older_sh,  "RESISTANCE", "older",  base_strength=30)
        zones += cluster_to_zones(older_sl,  "SUPPORT",    "older",  base_strength=30)

        # Add today/weekly key levels as zones
        for lvl in today_zones + weekly_zones:
            p = lvl["price"]
            # Zone type based on structural role, not just price position
            # TODAY_HIGH/WEEK_HIGH = RESISTANCE (price ran up to it)
            # TODAY_LOW/WEEK_LOW   = SUPPORT    (price bounced from it)
            # TODAY_OPEN/WEEK_OPEN = depends on which side price is on
            lvl_type = lvl["type"]
            if "HIGH" in lvl_type:
                zone_type_key = "RESISTANCE"
            elif "LOW" in lvl_type:
                zone_type_key = "SUPPORT"
            else:
                # OPEN levels: above current price = resistance, below = support
                zone_type_key = "RESISTANCE" if p > price else "SUPPORT"

            zones.append({
                "type":        zone_type_key,
                "top":         round(p * 1.001, 4),
                "bottom":      round(p * 0.999, 4),
                "mid":         round(p, 4),
                "touches":     2,
                "strong_move": False,
                "strength":    lvl["strength"],
                "recency":     lvl["recency"],
            })

        # ── Psychological round levels ────────────────────────────────────────
        base = round(price / 50) * 50
        for mult in range(-8, 9):
            lvl = base + mult * 50
            if 0 < abs(lvl - price) / price < 0.04:
                zones.append({
                    "type":     "PSYCHOLOGICAL",
                    "top":      round(lvl * 1.001, 4),
                    "bottom":   round(lvl * 0.999, 4),
                    "mid":      round(lvl, 4),
                    "touches":  1,
                    "strong_move": False,
                    "strength": 40,
                    "recency":  "structural",
                })

        # ── Detect if approach to zone is healthy or unhealthy ──────────────────
        # Riley: unhealthy (parabolic) approach = HIGH probability reversal
        # Healthy (stair-step) = lower probability, market may just push through
        unhealthy_approach = False
        approach_desc = ""
        if len(closes) >= 10:
            recent_moves = [abs(closes[i] - closes[i-1]) for i in range(-5, 0)]
            prior_moves  = [abs(closes[i] - closes[i-1]) for i in range(-10, -5)]
            avg_recent = sum(recent_moves) / len(recent_moves)
            avg_prior  = sum(prior_moves) / len(prior_moves)
            # Parabolic if recent bars 2x faster than prior bars
            if avg_prior > 0 and avg_recent > avg_prior * 2.0:
                unhealthy_approach = True
                approach_desc = f"parabolic ({avg_recent/avg_prior:.1f}x faster than prior)"
            # Also check: 3+ consecutive same-direction candles of increasing size
            elif (all(closes[i] < closes[i-1] for i in range(-3, 0)) or
                  all(closes[i] > closes[i-1] for i in range(-3, 0))):
                bodies = [abs(closes[i]-opens[i]) for i in range(-3, 0)]
                if bodies[-1] > bodies[0] * 1.5:
                    unhealthy_approach = True
                    approach_desc = "accelerating stair-step (unhealthy)"

        # ── Find current zone ─────────────────────────────────────────────────
        in_zone      = False
        zone_type    = "NONE"
        zone_strength = 0
        nearest_zone  = None
        min_dist      = float("inf")

        # Riley premarket-priority zones take precedence over regular zone
        # detection during the 9:30am-3:30pm window — pick the nearest one first
        # if any exist, before falling back to the regular nearest-zone search
        _priority_zones = [z for z in zones if z.get("recency") == "premarket_priority"]
        _search_order = _priority_zones if _priority_zones else zones
        for z in _search_order:
            dist = abs(price - z["mid"]) / price * 100
            if z["bottom"] <= price <= z["top"]:
                in_zone       = True
                zone_type     = z["type"]
                zone_strength = z["strength"]
                nearest_zone  = z
                break
            if dist < min_dist:
                min_dist     = dist
                nearest_zone = z

        if _priority_zones and not in_zone:
            for z in zones:
                if z.get("recency") == "premarket_priority":
                    continue
                if z["bottom"] <= price <= z["top"]:
                    in_zone       = True
                    zone_type     = z["type"]
                    zone_strength = z["strength"]
                    nearest_zone  = z
                    break

        # Keep quality zones only — 2+ touches OR today/weekly/premarket levels
        good_zones = [z for z in zones
                      if z["touches"] >= 2
                      or z["recency"] in ("today", "weekly", "premarket_priority")
                      or z["type"] == "PSYCHOLOGICAL"]
        good_zones.sort(key=lambda z: abs(z["mid"] - price))

        # ── Classify zones as EXTREME vs MINOR ───────────────────────────────
        # Riley: extremes = where institutions reverse, minor = checkpoints only
        # Extremes: today's high/low, weekly high/low, multi-touch swings (3+)
        # Minor: single touches, middle-of-range levels, weaker swings
        for z in good_zones:
            touches  = z.get("touches", 0)
            recency  = z.get("recency", "older")
            strength = z.get("strength", 0)
            is_extreme = (
                "HIGH" in z.get("type", "") or
                "LOW"  in z.get("type", "") or
                recency in ("today", "weekly", "premarket_priority") or
                touches >= 3 or
                strength >= 70
            )
            z["tier"] = "EXTREME" if is_extreme else "MINOR"

        # Sort: Riley premarket-priority zones first, then extremes, then by distance
        good_zones.sort(key=lambda z: (
            0 if z.get("recency") == "premarket_priority" else (1 if z["tier"] == "EXTREME" else 2),
            abs(z["mid"] - price)
        ))

        if not good_zones:
            log.warning("find_sr_zones %s: no quality zones found (price=%.4f, bars=%d)",
                        ticker, price, len(bars))

        # Riley break-and-retest detection — runs once per fresh 15-min candle
        _riley_update_broken_zones_and_retests(ticker, price, good_zones, times, closes)

        log_agent("system", "RILEY",
            f"{ticker} | {len(good_zones)} zones | "
            f"In zone: {in_zone} ({zone_type}) | "
            + (f"Nearest: ${nearest_zone['mid']:.2f} "
               f"({nearest_zone['type']} {nearest_zone.get('recency','')} "
               f"tier={nearest_zone.get('tier','?')}) "
               f"strength {nearest_zone['strength']} "
               f"dist {min_dist:.2f}%"
               if nearest_zone else "no zones"))

        # Clamp min_dist — float("inf") is not JSON-serialisable
        safe_dist = round(min_dist, 3) if min_dist < 1e9 else 99

        return {
            "zones":              good_zones[:12],
            "in_zone":            in_zone,
            "zone_type":          zone_type,
            "zone_strength":      zone_strength,
            "nearest_zone":       nearest_zone,
            "dist_to_nearest":    safe_dist,
            "unhealthy_approach": unhealthy_approach,
            "approach_desc":      approach_desc,
        }

    except Exception as e:
        log.warning("find_sr_zones %s CRASHED (%s: %s) — returning empty zones",
                    ticker, type(e).__name__, e)
        return {"zones": [], "in_zone": False, "zone_type": "NONE",
                "zone_strength": 0, "nearest_zone": None,
                "dist_to_nearest": 99}



# ─────────────────────────────────────────────────────────────────────────────
# RILEY COLEMAN CANDLE PATTERN DETECTION
# Based on Riley's specific patterns: failed breakouts, bait candles,
# head & shoulders, double tops, break & retest, unhealthy moves
# ─────────────────────────────────────────────────────────────────────────────

def _safe_max(seq):
    """max() that returns None instead of raising on an empty sequence."""
    seq = list(seq)
    return max(seq) if seq else None

def _safe_min(seq):
    """min() that returns None instead of raising on an empty sequence."""
    seq = list(seq)
    return min(seq) if seq else None

def detect_candle_patterns(ticker: str, direction: str) -> dict:
    """
    Detect Riley Coleman's specific price action patterns on 1-min chart.
    
    Riley's hierarchy (highest to lowest conviction):
    1. Failed Breakout — #1 pattern, major trend shift signal
    2. Bait Candle — massive fast candle that gets fully recovered
    3. Head & Shoulders — "bread and butter" reversal
    4. Double Top/Bottom — conservative reversal
    5. Unhealthy/Exhaustive move — parabolic, likely to snap back
    6. Break & Retest — continuation (stair-step)
    
    Riley does NOT use: hammers, dojis, engulfing as primary signals.
    He focuses on CONTEXT and SEQUENCE, not individual candle shapes.
    """
    try:
        # Get bars for candle pattern detection.
        # Always supply explicit start+end for crypto — without them the Alpaca data
        # API can serve a cached response for the same limit=N URL across repeated
        # calls, causing the same pattern to fire on every scan for hours.
        sym = alpaca_symbol(ticker)
        if is_crypto(ticker):
            from datetime import timezone, timedelta as _td
            _now   = datetime.now(timezone.utc)
            _end   = _now.isoformat()
            _s5m   = (_now - _td(hours=4)).isoformat()   # 4h window → 48 × 5-min bars
            _s15m  = (_now - _td(hours=6)).isoformat()   # 6h window → 24 × 15-min bars
            bars_1m  = alpaca.get_crypto_bars(
                sym, "5Min",  start=_s5m,  end=_end, limit=30).df
            bars_15m = alpaca.get_crypto_bars(
                sym, "15Min", start=_s15m, end=_end, limit=20).df
        else:
            bars_1m  = alpaca.get_bars(ticker, "1Min",  limit=30, feed="iex").df
            bars_15m = alpaca.get_bars(ticker, "15Min", limit=20, feed="iex").df

        if bars_1m.empty or len(bars_1m) < 10:
            return {"pattern": "NONE", "strength": 0, "bias": "NEUTRAL",
                    "confirms_direction": False, "description": ""}

        o  = bars_1m["open"].tolist()
        h  = bars_1m["high"].tolist()
        l  = bars_1m["low"].tolist()
        c  = bars_1m["close"].tolist()
        v  = bars_1m["volume"].tolist() if "volume" in bars_1m.columns else [1]*len(o)

        # Average candle metrics for context — clamp lookback to actual list
        # length (the empty-bars check only guarantees >= 10, but this loop
        # wants 15; range(-15, 0) on a 10-14 element list raises IndexError).
        if len(h) < 2 or len(l) < 2 or len(c) < 2 or len(o) < 2 or not v:
            return {"pattern": "NONE", "strength": 0, "bias": "NEUTRAL",
                    "confirms_direction": False, "description": ""}
        _navg_range = min(15, len(h), len(l))
        _navg_body  = min(15, len(c), len(o))
        _navg_vol   = min(10, len(v))
        avg_range  = sum(h[i]-l[i] for i in range(-_navg_range, 0)) / _navg_range
        avg_body   = sum(abs(c[i]-o[i]) for i in range(-_navg_body, 0)) / _navg_body
        avg_vol    = sum(v[i] for i in range(-_navg_vol, 0)) / _navg_vol

        patterns = []

        # ── 1. FAILED BREAKOUT (Riley's #1 pattern) ──────────────────────────
        # Price breaks above recent high (or below recent low),
        # baiting breakout traders, then immediately reverses back
        recent_high = _safe_max(h[-15:-1])
        recent_low  = _safe_min(l[-15:-1])
        max_h5      = _safe_max(h[-5:])
        min_l5      = _safe_min(l[-5:])

        # Bearish failed breakout: broke above recent high, now reversing
        if (recent_high is not None and recent_low is not None and max_h5 is not None
            and max_h5 > recent_high and            # broke above
            c[-1] < recent_high and                 # now below the high again
            c[-1] < o[-1] and                       # current candle bearish
            (h[-1] - l[-1]) > avg_range * 0.8       # meaningful candle
            and (max_h5 - recent_low) != 0):
            trap_size = (max_h5 - recent_high) / recent_high * 100
            recovery  = (max_h5 - c[-1]) / (max_h5 - recent_low) * 100
            strength  = min(100, int(75 + recovery * 0.25))
            patterns.append({
                "pattern":     "FAILED_BREAKOUT_BEARISH",
                "strength":    strength,
                "bias":        "BEARISH",
                "riley_grade": "A",
                "description": f"Failed breakout: broke ${recent_high:.2f} by "
                               f"{trap_size:.2f}%, now reversing — TRAP"
            })

        # Bullish failed breakout: broke below recent low, now reversing up
        if (recent_low is not None and min_l5 is not None
            and min_l5 < recent_low
            and c[-1] > recent_low
            and c[-1] > o[-1]
            and (h[-1] - l[-1]) > avg_range * 0.8):
            trap_size = (recent_low - min_l5) / recent_low * 100
            strength  = min(100, int(75 + trap_size * 5))
            patterns.append({
                "pattern":     "FAILED_BREAKOUT_BULLISH",
                "strength":    strength,
                "bias":        "BULLISH",
                "riley_grade": "A",
                "description": f"Failed breakdown: broke ${recent_low:.2f} by "
                               f"{trap_size:.2f}%, now recovering — TRAP"
            })

        # ── 2. BAIT CANDLE ────────────────────────────────────────────────────
        # Massive fast candle in one direction that gets FULLY recovered
        # The recovery of the entire bait candle range = reversal signal
        for i in range(-6, -1):  # Riley: recovery must happen within a couple candles
            bait_range = h[i] - l[i]
            bait_bearish = c[i] < o[i]
            bait_bullish = c[i] > o[i]

            # Must be a significantly large candle (2x+ average)
            if bait_range < avg_range * 2.0:
                continue

            # Bearish bait: big red candle, then price recovers ABOVE its open
            if bait_bearish:
                recovery_high = _safe_max(h[i+1:])
                if recovery_high is not None and recovery_high >= o[i]:  # fully recovered the bait candle
                    strength = min(100, int(70 + (bait_range / avg_range - 2) * 10))
                    patterns.append({
                        "pattern":     "BAIT_CANDLE_BULLISH",
                        "strength":    strength,
                        "bias":        "BULLISH",
                        "riley_grade": "A",
                        "description": f"Bait candle: {bait_range/avg_range:.1f}x avg "
                                       f"bearish candle fully recovered — fake move"
                    })
                    break

            # Bullish bait: big green candle, then price drops BELOW its open
            if bait_bullish:
                recovery_low = _safe_min(l[i+1:])
                if recovery_low is not None and recovery_low <= o[i]:  # fully recovered the bait candle
                    strength = min(100, int(70 + (bait_range / avg_range - 2) * 10))
                    patterns.append({
                        "pattern":     "BAIT_CANDLE_BEARISH",
                        "strength":    strength,
                        "bias":        "BEARISH",
                        "riley_grade": "A",
                        "description": f"Bait candle: {bait_range/avg_range:.1f}x avg "
                                       f"bullish candle fully recovered — fake move"
                    })
                    break

        # ── 3. HEAD AND SHOULDERS (micro, on 1-min) ───────────────────────────
        # Three peaks: left shoulder < head > right shoulder
        # Right shoulder = lower high = momentum dying
        # Riley uses this as final confirmation of trend reversal
        if len(h) >= 20:
            # Find local peaks in last 20 bars
            peaks = []
            for i in range(2, min(20, len(h)) - 2):
                idx = -i
                if h[idx] > h[idx-1] and h[idx] > h[idx-2] and                    h[idx] > h[idx+1] and h[idx] > h[idx+2]:
                    peaks.append((idx, h[idx]))

            # Bearish H&S: 3 peaks where middle is highest
            if len(peaks) >= 3:
                p1, p2, p3 = peaks[-3], peaks[-2], peaks[-1]
                head_h = p2[1]
                ls_h   = p1[1]
                rs_h   = p3[1]
                if (head_h > ls_h and                  # head higher than left shoulder
                    head_h > rs_h and                  # head higher than right shoulder
                    rs_h < ls_h * 1.02 and             # right shoulder ≤ left (+2% tolerance)
                    c[-1] < min(l[p1[0]], l[p3[0]])):  # broke neckline
                    strength = min(100, int(
                        70 + (1 - rs_h/head_h) * 100))
                    patterns.append({
                        "pattern":     "HEAD_AND_SHOULDERS",
                        "strength":    strength,
                        "bias":        "BEARISH",
                        "riley_grade": "A",
                        "description": f"H&S: head ${head_h:.2f} > LS ${ls_h:.2f} > RS ${rs_h:.2f} "
                                       f"— neckline broken"
                    })

        # ── 4. DOUBLE TOP / DOUBLE BOTTOM ─────────────────────────────────────
        # Two tests of same level — doesn't need exact same price
        # Riley: second test can even make slight new high and still be valid
        window = min(25, len(h))
        top1   = _safe_max(h[-window:-window//2])
        top2   = _safe_max(h[-window//2:])
        bot1   = _safe_min(l[-window:-window//2])
        bot2   = _safe_min(l[-window//2:])
        tol    = avg_range * 3  # tolerance = 3x avg 1-min range

        # Double top: two similar highs, now pulling back
        if (top1 is not None and top2 is not None and recent_low is not None
            and abs(top1 - top2) <= tol             # within tolerance
            and top1 > recent_low + avg_range * 5   # meaningful highs
            and c[-1] < min(top1, top2) * 0.995     # now below both tops
            and c[-1] < o[-1]):                      # current candle bearish
            strength = int(65 + max(0, 1 - abs(top1-top2)/avg_range) * 20)
            patterns.append({
                "pattern":     "DOUBLE_TOP",
                "strength":    min(85, strength),
                "bias":        "BEARISH",
                "riley_grade": "B",
                "description": f"Double top: ${top1:.2f} and ${top2:.2f} "
                               f"({abs(top1-top2):.2f} apart) — second test failing"
            })

        # Double bottom: two similar lows, now recovering
        if (bot1 is not None and bot2 is not None
            and abs(bot1 - bot2) <= tol
            and c[-1] > max(bot1, bot2) * 1.005
            and c[-1] > o[-1]):
            strength = int(65 + max(0, 1 - abs(bot1-bot2)/avg_range) * 20)
            patterns.append({
                "pattern":     "DOUBLE_BOTTOM",
                "strength":    min(85, strength),
                "bias":        "BULLISH",
                "riley_grade": "B",
                "description": f"Double bottom: ${bot1:.2f} and ${bot2:.2f} — second test holding"
            })

        # ── 5. UNHEALTHY/EXHAUSTIVE MOVE ──────────────────────────────────────
        # Parabolic move — too fast, likely to snap back
        # Riley: these are the moves he FADES, not follows
        last_5_ranges  = [h[i]-l[i] for i in range(-5, 0)]
        last_5_bodies  = [abs(c[i]-o[i]) for i in range(-5, 0)]
        acceleration   = last_5_ranges[-1] / max(sum(last_5_ranges[:-1])/4, 0.001)
        all_same_dir   = all(c[i] < o[i] for i in range(-4, 0)) or                          all(c[i] > o[i] for i in range(-4, 0))
        shrinking_body = last_5_bodies[-1] < last_5_bodies[-2] * 0.6  # losing steam

        if acceleration > 2.5 or (all_same_dir and shrinking_body):
            # Parabolic bearish move — potential exhaustion LONG
            if all(c[i] < o[i] for i in range(-4, 0)):
                strength = min(100, int(55 + acceleration * 10))
                patterns.append({
                    "pattern":     "EXHAUSTIVE_DROP",
                    "strength":    min(75, strength),
                    "bias":        "BULLISH",
                    "riley_grade": "B",
                    "description": f"Exhaustive drop: {acceleration:.1f}x acceleration, "
                                   f"{'shrinking bodies' if shrinking_body else 'parabolic'} — "
                                   f"snap-back likely"
                })
            # Parabolic bullish move — potential exhaustion SHORT
            elif all(c[i] > o[i] for i in range(-4, 0)):
                strength = min(100, int(55 + acceleration * 10))
                patterns.append({
                    "pattern":     "EXHAUSTIVE_SPIKE",
                    "strength":    min(75, strength),
                    "bias":        "BEARISH",
                    "riley_grade": "B",
                    "description": f"Exhaustive spike: {acceleration:.1f}x acceleration — "
                                   f"snap-back likely"
                })

        # ── 6. BREAK AND RETEST (stair-step continuation) ────────────────────
        # Previous resistance broken, now retesting as support
        # Riley uses this for continuation trades in established trend
        if not bars_15m.empty and len(bars_15m) >= 5:
            prev_resistance = _safe_max(bars_15m["high"].tolist()[-10:-5])
            curr_max_h10    = _safe_max(h[-10:])
            curr_price      = c[-1]
            # Price broke above resistance and now retesting it from above
            if (prev_resistance is not None and curr_max_h10 is not None
                and curr_price > prev_resistance * 0.998   # at prior resistance
                and curr_price < prev_resistance * 1.015   # within 1.5%
                and curr_max_h10 > prev_resistance         # did break above
                and c[-1] > o[-1]):                         # current bullish
                patterns.append({
                    "pattern":     "BREAK_AND_RETEST_BULLISH",
                    "strength":    65,
                    "bias":        "BULLISH",
                    "riley_grade": "B",
                    "description": f"Break & retest: previous resistance ${prev_resistance:.2f} "
                                   f"now acting as support"
                })

        if not patterns:
            return {"pattern": "NONE", "strength": 0, "bias": "NEUTRAL",
                    "confirms_direction": False, "description": ""}

        # Sort by Riley grade then strength
        grade_order = {"A": 0, "B": 1, "C": 2}
        patterns.sort(key=lambda p: (grade_order.get(p.get("riley_grade","C"), 2),
                                     -p["strength"]))
        best = patterns[0]

        confirms = (
            (best["bias"] == "BEARISH" and direction == "BEARISH") or
            (best["bias"] == "BULLISH" and direction == "BULLISH")
        )

        log_agent("system", "CANDLE",
            f"{ticker} {best['pattern']} [Grade {best.get('riley_grade','?')}] "
            f"strength={best['strength']} bias={best['bias']} "
            f"confirms={confirms} | {best['description'][:60]}")

        return {
            **best,
            "confirms_direction": confirms,
            "all_patterns": [p["pattern"] for p in patterns]
        }

    except Exception as e:
        log.warning("Candle pattern failed %s: %s", ticker, e)
        return {"pattern": "NONE", "strength": 0, "bias": "NEUTRAL",
                "confirms_direction": False, "description": ""}


def check_market_structure_shift(ticker: str, direction: str) -> dict:
    """
    Stage 2: Drop to 1-min chart. Confirm structure shift.

    Riley's actual entry signal:
    1. Price near 15-min zone
    2. 1-min trend starts making a lower high (for short) or higher low (for long)
    3. A STRONG CANDLE breaks the most recent 1-min swing low (short) or swing high (long)
       — that strong candle IS the entry trigger / sell stop placement point

    NOT just a mechanical lower-high/lower-low detection —
    it's specifically about the strong candle that breaks the minor swing level.
    """
    try:
        sym = alpaca_symbol(ticker)
        if is_crypto(ticker):
            from datetime import timezone, timedelta as _td
            _now  = datetime.now(timezone.utc)
            _end  = _now.isoformat()
            _s5m  = (_now - _td(hours=6)).isoformat()   # 6h → 72 × 5-min bars
            bars_1m = alpaca.get_crypto_bars(
                sym, "5Min", start=_s5m, end=_end, limit=60).df
        else:
            bars_1m = alpaca.get_bars(ticker, "1Min", limit=60, feed="iex").df
        if bars_1m.empty or len(bars_1m) < 10:
            return {"structure_shifted": False, "exhaustive": False,
                    "shift_type": "NONE", "confidence": 0, "entry_candle": None,
                    "swing_break": False, "candle_confirms": False}

        opens  = bars_1m["open"].tolist()
        closes = bars_1m["close"].tolist()
        highs  = bars_1m["high"].tolist()
        lows   = bars_1m["low"].tolist()

        # ── Find recent 1-min swing points ───────────────────────────────────
        # Looking at last 20 bars for structure
        recent_h = highs[-20:]
        recent_l = lows[-20:]
        recent_c = closes[-20:]
        recent_o = opens[-20:]

        # Find the most recent 1-min swing high and swing low
        # Swing high = local peak (higher than 2 bars either side)
        # Swing low  = local trough
        swing_highs, swing_lows = [], []
        for i in range(2, len(recent_h) - 1):
            if recent_h[i] > recent_h[i-1] and recent_h[i] > recent_h[i-2] and \
               recent_h[i] >= recent_h[i+1]:
                swing_highs.append((i, recent_h[i]))
            if recent_l[i] < recent_l[i-1] and recent_l[i] < recent_l[i-2] and \
               recent_l[i] <= recent_l[i+1]:
                swing_lows.append((i, recent_l[i]))

        # Most recent swing points
        last_swing_high = swing_highs[-1][1] if swing_highs else max(recent_h[:-3])
        last_swing_low  = swing_lows[-1][1]  if swing_lows  else min(recent_l[:-3])

        # ── Detect prior approach trend (into the zone) ───────────────────────
        first_half_h = recent_h[:10]
        first_half_l = recent_l[:10]
        second_half_h = recent_h[10:]
        second_half_l = recent_l[10:]

        bullish_approach = (first_half_h[-1] > first_half_h[0] and
                            first_half_l[-1] > first_half_l[0])
        bearish_approach = (first_half_l[-1] < first_half_l[0] and
                            first_half_h[-1] < first_half_h[0])

        # ── Core: has a strong candle broken the recent swing? ────────────────
        # This is Riley's actual entry: strong candle breaks minor 1-min support/resistance
        last_body = abs(closes[-1] - opens[-1])
        avg_body  = sum(abs(closes[i] - opens[i]) for i in range(-10, 0)) / 10
        strong_candle  = last_body > avg_body * 1.1
        bearish_candle = closes[-1] < opens[-1]
        bullish_candle = closes[-1] > opens[-1]

        swing_break       = False
        structure_shifted = False
        shift_type        = "NONE"
        entry_candle      = None

        if direction == "BEARISH":
            # For short: need lower high forming, then strong red candle breaks
            # the most recent 1-min swing LOW
            lower_high = (len(second_half_h) > 0 and
                          max(second_half_h) < max(first_half_h))
            # Strong red candle that breaks below the recent swing low
            if bearish_candle and strong_candle and closes[-1] < last_swing_low:
                swing_break       = True
                structure_shifted = True
                shift_type        = "BEARISH_SWING_BREAK"
                entry_candle      = "STRONG_BEARISH"
            elif lower_high and bearish_candle and strong_candle:
                # Lower high + strong red = partial confirmation
                shift_type   = "PARTIAL_BEARISH"
                entry_candle = "STRONG_BEARISH"
            elif lower_high:
                shift_type = "PARTIAL_BEARISH"

        elif direction == "BULLISH":
            # For long: need higher low forming, then strong green candle breaks
            # the most recent 1-min swing HIGH
            higher_low = (len(second_half_l) > 0 and
                          min(second_half_l) > min(first_half_l))
            # Strong green candle that breaks above the recent swing high
            if bullish_candle and strong_candle and closes[-1] > last_swing_high:
                swing_break       = True
                structure_shifted = True
                shift_type        = "BULLISH_SWING_BREAK"
                entry_candle      = "STRONG_BULLISH"
            elif higher_low and bullish_candle and strong_candle:
                shift_type   = "PARTIAL_BULLISH"
                entry_candle = "STRONG_BULLISH"
            elif higher_low:
                shift_type = "PARTIAL_BULLISH"

        # No clear directional approach — check simple 3-bar drift
        if shift_type == "NONE":
            if direction == "BEARISH" and closes[-1] < closes[-2] < closes[-3]:
                structure_shifted = True
                shift_type = "BEARISH_DRIFT"
            elif direction == "BULLISH" and closes[-1] > closes[-2] > closes[-3]:
                structure_shifted = True
                shift_type = "BULLISH_DRIFT"

        # ── Exhaustive/parabolic move detection ───────────────────────────────
        last_5_moves = [abs(closes[i] - closes[i-1]) for i in range(-5, 0)]
        avg_move     = sum(last_5_moves) / len(last_5_moves)
        exhaustive   = last_5_moves[-1] > avg_move * 2.5

        # ── Confidence score ──────────────────────────────────────────────────
        confidence = 0
        if swing_break:       confidence += 50   # actual swing level broken with strong candle
        elif structure_shifted: confidence += 30
        if exhaustive:        confidence += 20
        if entry_candle:      confidence += 20
        if (direction == "BEARISH" and bullish_approach) or \
           (direction == "BULLISH" and bearish_approach):
            confidence += 10  # correct approach direction

        candle_confirms = bool(entry_candle and (
            (direction == "BEARISH" and entry_candle == "STRONG_BEARISH") or
            (direction == "BULLISH" and entry_candle == "STRONG_BULLISH")
        ))

        log_agent("system", "RILEY",
            f"1-min structure | shift: {structure_shifted} ({shift_type}) | "
            f"swing_break: {swing_break} | "
            f"exhaustive: {exhaustive} | candle: {entry_candle} | "
            f"conf: {confidence}/100 | "
            f"last_swing_H: ${last_swing_high:.2f} last_swing_L: ${last_swing_low:.2f}")



        return {
            "structure_shifted": structure_shifted,
            "shift_type":        shift_type,
            "exhaustive":        exhaustive,
            "entry_candle":      entry_candle,
            "confidence":        confidence,
            "approach":          "BULLISH" if bullish_approach else
                                 "BEARISH" if bearish_approach else "NONE",
        }

    except Exception as e:
        log.warning("Structure shift check failed %s: %s", ticker, e)
        return {"structure_shifted": False, "exhaustive": False,
                "shift_type": "NONE", "confidence": 0, "entry_candle": None,
                "approach": "NONE"}


def _score_counter_direction(sr: dict, counter_dir: str,
                              rsi: float, mtf: dict | None) -> tuple[int, str]:
    """
    Compute a quick counter-direction confidence score using already-fetched data.
    No extra API calls — uses zone info, RSI, and MTF already computed for primary.
    Returns (score 0-100, reason string).
    """
    score = 45  # neutral starting point (slightly below threshold)
    reasons = []

    zone_type  = sr.get("zone_type", "NONE") if sr.get("in_zone") else "NONE"
    nearest    = (sr.get("nearest_zone") or {}).get("type", "NONE")
    zone_str   = sr.get("zone_strength", 0) or 0
    dist       = sr.get("dist_to_nearest", 99)

    if counter_dir == "BEARISH":
        # Short setup best at resistance
        if zone_type == "RESISTANCE":
            score += 15 + min(zone_str // 10, 10)
            reasons.append(f"at resistance (str={zone_str})")
        elif zone_type == "SUPPORT":
            score -= 15
            reasons.append("at support — risky for short")
        elif nearest == "RESISTANCE" and dist < 2.0:
            score += 8
            reasons.append(f"near resistance ({dist:.1f}% away)")
        if rsi > 65:
            score += 10; reasons.append(f"RSI overbought ({rsi:.0f})")
        elif rsi < 35:
            score -= 15; reasons.append(f"RSI oversold ({rsi:.0f}) — risky short")
    else:  # BULLISH
        if zone_type == "SUPPORT":
            score += 15 + min(zone_str // 10, 10)
            reasons.append(f"at support (str={zone_str})")
        elif zone_type == "RESISTANCE":
            score -= 15
            reasons.append("at resistance — risky for long")
        elif nearest == "SUPPORT" and dist < 2.0:
            score += 8
            reasons.append(f"near support ({dist:.1f}% away)")
        if rsi < 35:
            score += 10; reasons.append(f"RSI oversold ({rsi:.0f})")
        elif rsi > 65:
            score -= 15; reasons.append(f"RSI overbought ({rsi:.0f}) — risky long")

    # MTF alignment for counter direction
    if mtf:
        m15 = mtf.get("m15", "NEUTRAL")
        m5  = mtf.get("m5", "NEUTRAL")
        if m15 == counter_dir:
            score += 8; reasons.append(f"15min aligned ({m15})")
        elif m15 and m15 != "NEUTRAL" and m15 != counter_dir:
            score -= 10; reasons.append(f"15min against ({m15})")
        if m5 == counter_dir:
            score += 5

    score = max(0, min(100, score))
    return score, " | ".join(reasons) if reasons else "no clear setup"


def _riley_zone_is_broken(ticker: str, zone: dict) -> bool:
    """
    True if this zone already appears in _broken_zones — the break-and-retest
    system (_riley_update_broken_zones_and_retests) owns broken-zone state;
    this just checks it so the gate doesn't re-block a confirmed breakout/down.
    """
    try:
        zone_level = zone.get("mid", 0)
        zone_type  = zone.get("type")
        if not zone_level or not zone_type:
            return False
        for b in _broken_zones.get(ticker, []):
            if (b.get("zone_type") == zone_type
                    and abs(b.get("zone_level", 0) - zone_level) / zone_level < 0.001):
                return True
        return False
    except Exception:
        return False


def _riley_detect_stair_step_trend(ticker: str) -> str:
    """
    Riley: 3+ consecutive higher-highs + higher-lows (or lower-highs + lower-lows)
    on the 15-min chart is a strong directional stair-step — the zone standing
    in the trend's way is likely to break rather than hold, so counter-trend
    reversals there should be skipped.
    Returns "BULLISH_STAIRSTEP" | "BEARISH_STAIRSTEP" | "NONE".
    """
    try:
        sym = alpaca_symbol(ticker)
        if is_crypto(ticker):
            bars = alpaca.get_crypto_bars(sym, "15Min", limit=6).df
        else:
            bars = alpaca.get_bars(ticker, "15Min", limit=6, feed="iex").df
        if bars.empty or len(bars) < 4:
            return "NONE"
        highs = bars["high"].tolist()
        lows  = bars["low"].tolist()
        if all(highs[i] > highs[i-1] and lows[i] > lows[i-1] for i in range(-3, 0)):
            return "BULLISH_STAIRSTEP"
        if all(highs[i] < highs[i-1] and lows[i] < lows[i-1] for i in range(-3, 0)):
            return "BEARISH_STAIRSTEP"
        return "NONE"
    except Exception:
        return "NONE"


def _riley_detect_consecutive_trend(ticker: str) -> dict:
    """
    Strong trend filter — counts consecutive lower highs and consecutive
    higher lows on the 15-min chart (most recent bars first).
    5+ consecutive lower highs = an obvious downtrend (blocks counter-trend
    longs). 5+ consecutive higher lows = an obvious uptrend (blocks
    counter-trend shorts).
    Returns {"lower_highs": int, "higher_lows": int}
    """
    try:
        sym = alpaca_symbol(ticker)
        if is_crypto(ticker):
            bars = alpaca.get_crypto_bars(sym, "15Min", limit=10).df
        else:
            bars = alpaca.get_bars(ticker, "15Min", limit=10, feed="iex").df
        if bars.empty or len(bars) < 6:
            return {"lower_highs": 0, "higher_lows": 0}

        highs = bars["high"].tolist()
        lows  = bars["low"].tolist()

        lower_highs = 0
        for i in range(len(highs) - 1, 0, -1):
            if highs[i] < highs[i-1]:
                lower_highs += 1
            else:
                break

        higher_lows = 0
        for i in range(len(lows) - 1, 0, -1):
            if lows[i] > lows[i-1]:
                higher_lows += 1
            else:
                break

        return {"lower_highs": lower_highs, "higher_lows": higher_lows}
    except Exception:
        return {"lower_highs": 0, "higher_lows": 0}


def riley_strategy_gate(ticker: str, price: float, direction: str,
                         conf: int) -> dict:
    """
    Master Riley gate — runs both stages and returns entry decision.

    Returns:
      approved: bool
      confidence_boost: int  (+0 to +20)
      zone: dict
      structure: dict
      reason: str
      entry_quality: PERFECT | GOOD | WAIT | NO
    """
    # Initialise ALL accumulators at the very top so no code path can crash
    # with "cannot access local variable ... not associated with a value".
    reasons   = []
    _rsi_adj  = 0

    # Stage 1: Are we in a valid 15-min zone?
    sr = find_sr_zones(ticker, price)

    # Zone proximity — Riley's approach: zone itself is the alert area
    # Don't use fixed %, use zone tier to determine acceptable proximity
    nearest = sr.get("nearest_zone") or {}
    zone_tier = nearest.get("recency", "older")
    zone_strength = nearest.get("strength", 0)

    # Proximity thresholds by zone tier (how close to start watching)
    # Extremes (today/weekly) = wider alert area, minor levels = tighter
    proximity_limit = {
        "today":      3.0,   # today's high/low — watch from 3% away
        "weekly":     3.0,   # weekly extremes — same
        "recent":     2.0,   # 2-day swings — watch from 2% away
        "older":      1.5,   # older levels — tighter
        "structural": 2.5,   # psychological levels
    }.get(zone_tier, 2.0)

    # Extreme zones (strength > 70) get extra buffer — institutions defend these
    if zone_strength >= 70:
        proximity_limit += 0.5

    if not sr["in_zone"] and sr["dist_to_nearest"] > proximity_limit:
        return {
            "approved":         False,
            "confidence_boost": 0,
            "zone":             sr,
            "structure":        {},
            "reason":           f"Price not near any zone (nearest {sr['dist_to_nearest']:.1f}% away, limit {proximity_limit:.1f}%)",
            "entry_quality":    "NO",
        }

    # Validate zone type matches direction — use RSI to resolve ambiguity
    zone = sr.get("nearest_zone") or {}
    zone_type = zone.get("type", "NONE")

    # ── Riley Rule: minor/middle zones are profit-target checkpoints only ──────
    # They're not where institutions reverse — only EXTREME zones (multi-touch,
    # today/weekly extremes, strength >= 70) are valid entry triggers.
    if sr["in_zone"] and (zone.get("tier") == "MINOR"
                          or zone.get("recency") == "structural"
                          or (zone.get("strength", 0) or 0) < 70):
        log_agent("system", "RILEY",
            f"{ticker} skipping minor zone — too weak for entry, use as profit target only")
        return {
            "approved":         False,
            "confidence_boost": 0,
            "zone":             sr,
            "structure":        {},
            "reason":           "RILEY: skipping minor zone — too weak for entry, use as profit target only",
            "entry_quality":    "NO",
        }

    # ── Riley Rule: at an UNBROKEN zone, only the zone-aligned side is valid ───
    # Resistance = shorts only, Support = longs only. Once a zone is confirmed
    # broken, _riley_update_broken_zones_and_retests / watch mode takes over —
    # leave that logic untouched and skip this directional check entirely.
    if sr["in_zone"] and not _riley_zone_is_broken(ticker, zone):
        if zone_type == "RESISTANCE" and direction == "BULLISH":
            log_agent("system", "RILEY",
                f"{ticker} resistance zone — longs only valid after confirmed breakout")
            return {
                "approved":         False,
                "confidence_boost": 0,
                "zone":             sr,
                "structure":        {},
                "reason":           "RILEY: resistance zone — longs only valid after confirmed breakout",
                "entry_quality":    "NO",
            }
        if zone_type == "SUPPORT" and direction == "BEARISH":
            log_agent("system", "RILEY",
                f"{ticker} support zone — shorts only valid after confirmed breakdown")
            return {
                "approved":         False,
                "confidence_boost": 0,
                "zone":             sr,
                "structure":        {},
                "reason":           "RILEY: support zone — shorts only valid after confirmed breakdown",
                "entry_quality":    "NO",
            }

    # Pre-compute 1-min structure shift so the stair-step filter below can
    # exemption confirmed reversals (a pattern-confirmed counter-trend entry
    # at a major zone is valid even against a trend — Riley's bait candle).
    # Computed here once; Stage 2 below reuses this result.
    _early_struct = check_market_structure_shift(ticker, direction)
    _has_1min_confirm = bool(_early_struct.get("structure_shifted"))

    # ── Riley Rule: a strong stair-step trend overpowers the zone ahead of it ──
    # 3+ consecutive higher-highs+higher-lows means resistance likely to break
    # (skip counter-trend shorts); 3+ lower-highs+lower-lows means support
    # likely to break (skip counter-trend longs).
    # Exception: if there IS a 1-min structure-shift confirmation, the zone is
    # holding despite the trend — allow the entry (the pattern IS the signal).
    if sr["in_zone"]:
        _stairstep = _riley_detect_stair_step_trend(ticker)
        if (_stairstep == "BULLISH_STAIRSTEP" and zone_type == "RESISTANCE"
                and direction == "BEARISH" and not _has_1min_confirm):
            log_agent("system", "RILEY",
                f"{ticker} strong bullish trend — resistance likely to break, skipping short (no 1-min confirm)")
            return {
                "approved":         False,
                "confidence_boost": 0,
                "zone":             sr,
                "structure":        {},
                "reason":           "RILEY: strong bullish trend — resistance likely to break, skipping short (no 1-min confirm)",
                "entry_quality":    "NO",
            }
        if (_stairstep == "BEARISH_STAIRSTEP" and zone_type == "SUPPORT"
                and direction == "BULLISH" and not _has_1min_confirm):
            log_agent("system", "RILEY",
                f"{ticker} strong bearish trend — support likely to break, skipping long (no 1-min confirm)")
            return {
                "approved":         False,
                "confidence_boost": 0,
                "zone":             sr,
                "structure":        {},
                "reason":           "RILEY: strong bearish trend — support likely to break, skipping long (no 1-min confirm)",
                "entry_quality":    "NO",
            }

    def _quick_rsi(ticker_sym, period=14):
        """Inline RSI calc — avoids scope issue with locally-defined calc_rsi."""
        try:
            # Crypto uses different bars endpoint (no IEX feed)
            if is_crypto(ticker_sym) or "/" in ticker_sym:
                sym = ticker_sym if "/" in ticker_sym else ticker_sym.replace("USD", "/USD")
                bars = alpaca.get_crypto_bars(sym, "1Hour", limit=40).df
            else:
                bars = alpaca.get_bars(ticker_sym, "5Min", limit=40, feed="iex").df
            if bars.empty or len(bars) < period + 1:
                return 50.0
            closes = bars["close"].tolist()
            gains, losses = [], []
            for i in range(1, len(closes)):
                d = closes[i] - closes[i-1]
                gains.append(max(d, 0))
                losses.append(max(-d, 0))
            if len(gains) < period:
                return 50.0
            avg_g = sum(gains[:period]) / period
            avg_l = sum(losses[:period]) / period
            for i in range(period, len(gains)):
                avg_g = (avg_g * (period-1) + gains[i]) / period
                avg_l = (avg_l * (period-1) + losses[i]) / period
            if avg_l == 0:
                return 100.0
            rs = avg_g / avg_l
            return round(100 - (100 / (1 + rs)), 1)
        except:
            return 50.0

    # RSI zone-mismatch adjustments — no hard blocks, just confidence signals.
    # RSI confirming the trade direction: +15 boost.
    # ── Context-aware RSI scoring ─────────────────────────────────────────────
    # RSI weight depends on whether the market is TRENDING or RANGING.
    # In a trend, RSI stays in neutral range for extended periods → less useful.
    # In a ranging market, RSI is reliable for mean reversion → higher weight.
    # (reasons and _rsi_adj already initialised at top of function)
    try:
        _trending = get_market_condition() in ("BULLISH", "BEARISH")
    except Exception:
        _trending = False

    # Weights by market context
    _rsi_confirm_w  = 5  if _trending else 15   # RSI confirms signal
    _rsi_neutral_w  = 0  if _trending else -5   # RSI neutral (40-60)
    _rsi_oppose_w   = -5 if _trending else -20  # RSI contradicts signal

    if sr["in_zone"]:
        if direction == "BEARISH" and sr["zone_type"] == "SUPPORT":
            rsi_th    = get_adaptive_rsi_thresholds(ticker)
            rsi_val   = _quick_rsi(ticker)
            ob_thresh = rsi_th.get("overbought", 65)
            # For shorts at support: best when overbought (strong confirmation),
            # risky when genuinely oversold (RSI < 40 regardless of market context).
            if rsi_val >= ob_thresh:
                _rsi_adj = _rsi_confirm_w
                reasons.append(f"RSI {rsi_val:.0f} overbought at support — short confirmation")
            elif rsi_val < 40:
                _rsi_adj = -20   # genuine oversold = always risky to short
                reasons.append(f"RSI {rsi_val:.0f} oversold at support — risky for short")
            else:
                _rsi_adj = _rsi_neutral_w
                reasons.append(f"RSI {rsi_val:.0f} at support — {'trend mode' if _trending else 'neutral'}")
            # Extreme RSI bonus (rare, high-conviction regardless of context)
            if rsi_val > 80:
                _rsi_adj += 10; reasons.append(f"RSI extreme ({rsi_val:.0f}) +10")
            elif rsi_val > 90:
                _rsi_adj += 15
            log_agent("system", "RILEY",
                f"{ticker} BEARISH@SUPPORT RSI={rsi_val:.0f} "
                f"({'trending' if _trending else 'ranging'}) → adj {_rsi_adj:+d}")

        if direction == "BULLISH" and sr["zone_type"] == "RESISTANCE":
            rsi_th    = get_adaptive_rsi_thresholds(ticker)
            rsi_val   = _quick_rsi(ticker)
            os_thresh = rsi_th.get("oversold",   35)
            ob_thresh = rsi_th.get("overbought", 65)
            if rsi_val <= os_thresh:
                _rsi_adj = _rsi_confirm_w
                reasons.append(f"RSI {rsi_val:.0f} oversold at resistance — long confirmation")
            elif rsi_val >= ob_thresh:
                _rsi_adj = _rsi_oppose_w
                reasons.append(f"RSI {rsi_val:.0f} overbought at resistance — risky for long")
            else:
                _rsi_adj = _rsi_neutral_w
                reasons.append(f"RSI {rsi_val:.0f} at resistance — {'trend mode' if _trending else 'neutral'}")
            # Extreme RSI bonus
            if rsi_val < 20:
                _rsi_adj += 10; reasons.append(f"RSI extreme ({rsi_val:.0f}) +10")
            elif rsi_val < 10:
                _rsi_adj += 15
            log_agent("system", "RILEY",
                f"{ticker} BULLISH@RESISTANCE RSI={rsi_val:.0f} "
                f"({'trending' if _trending else 'ranging'}) → adj {_rsi_adj:+d}")

    # Stage 2: 1-min structure shift confirmation (computed early above — reuse)
    struct = _early_struct

    # Stage 2b: Candle pattern detection
    candle = detect_candle_patterns(ticker, direction)
    if candle["pattern"] != "NONE":
        struct["entry_candle"] = candle["pattern"]
        struct["candle_strength"] = candle["strength"]
        struct["candle_confirms"] = candle["confirms_direction"]
        if candle["confirms_direction"] and candle["strength"] >= 65:
            # Strong confirming candle boosts confidence score
            struct["confidence"] = min(100,
                struct.get("confidence", 0) + int(candle["strength"] * 0.3))

    # Score the overall setup
    boost = 0
    quality = "WAIT"
    approved = False

    # Apply RSI zone-mismatch adjustment computed above
    boost += _rsi_adj

    if sr["in_zone"]:
        boost   += 8
        reasons.append(f"In {sr['zone_type']} zone (strength {sr['zone_strength']})")

    if zone.get("touches", 0) >= 3:
        boost   += 5
        reasons.append(f"{zone['touches']} touches on zone — high conviction")
    elif zone.get("touches", 0) >= 2:
        boost   += 3
        reasons.append("2 touches confirmed")

    if zone.get("strong_move"):
        boost   += 4
        reasons.append("Strong prior rejection from this zone")

    if struct["structure_shifted"]:
        boost   += 15   # upgraded from 6 — structure shift is the key entry signal
        reasons.append(f"1-min structure shift confirmed ({struct['shift_type']})")

    if struct["exhaustive"]:
        boost   += 5
        reasons.append("Parabolic/exhaustive move detected")

    if struct["entry_candle"]:
        boost   += 4
        reasons.append(f"Strong entry candle ({struct['entry_candle']})")

    if zone_type == "PSYCHOLOGICAL":
        boost   += 3
        reasons.append("Psychological round number")

    # Entry quality — purely score-based; structure shift is a contributor not a gate
    total_score = struct["confidence"] + (sr["zone_strength"] or 0) / 2

    if total_score >= 80 and sr["in_zone"]:
        quality  = "PERFECT"
        approved = True
    elif total_score >= 55 and (sr["in_zone"] or sr.get("dist_to_nearest", 99) < 1.0):
        quality  = "GOOD"
        approved = True
    elif total_score >= 35:
        quality  = "WAIT"
        approved = False   # advisory — scan_ticker applies penalty and passes through
    else:
        quality  = "NO"
        approved = False   # advisory — scan_ticker applies penalty and passes through

    reason = " | ".join(reasons) if reasons else "No valid setup"

    log_agent("system", "RILEY",
        f"{ticker} Riley gate: {quality} | approved={approved} | "
        f"boost={boost:+d} | {reason}")

    return {
        "approved":         approved,
        "confidence_boost": boost,
        "zone":             sr,
        "structure":        struct,
        "reason":           reason,
        "entry_quality":    quality,
    }

def analyze_reversal_zone(ticker: str, price: float) -> dict:
    """
    Analyzes price + volume to determine if the stock is in a reversal zone.
    
    Reversal zones are identified by:
    - Price near key support/resistance (within 0.5-2%)
    - RSI oversold (<35) for longs or overbought (>65) for shorts
    - Volume divergence (price making new extreme but volume declining)
    - Candle patterns: hammer, shooting star, doji at extremes
    - Price exhaustion after extended move (3+ bars same direction)
    
    Returns:
    - in_reversal_zone: bool
    - zone_type: "OVERSOLD" | "OVERBOUGHT" | "NONE"
    - strength: 0-100 (how strong the reversal signal is)
    - entry_quality: "IDEAL" | "GOOD" | "WAIT" | "NO"
    - wait_for: description of what to wait for if not ideal
    - key_level: the support/resistance price being tested
    """
    _safe_default = {"in_reversal_zone": False, "zone_type": "NONE",
                     "strength": 0, "entry_quality": "WAIT",
                     "wait_for": "insufficient data", "key_level": price,
                     "rsi": 50, "vol_divergence": False,
                     "extended_move": False, "reversal_candle": False, "dist_to_level": 0}
    try:
        sym = alpaca_symbol(ticker)
        # Bar fetch — guarded on its own: the Alpaca SDK can raise
        # "list index out of range" internally when a symbol (e.g. BTCUSD,
        # ETHUSD) has no/sparse bars for the requested window.
        try:
            if is_crypto(ticker):
                # Crypto uses different bars endpoint
                bars_5m = alpaca.get_crypto_bars(sym, "15Min", limit=78).df
                from datetime import timezone, timedelta
                start = (datetime.now(timezone.utc) - timedelta(days=5)).strftime("%Y-%m-%d")
                bars_1h = alpaca.get_crypto_bars(sym, "1Hour", limit=60).df
            else:
                # Fetch 5min bars for last 2 days (intraday detail)
                bars_5m = alpaca.get_bars(ticker, "5Min", limit=78, feed="iex").df
                # Fetch 1H bars for context
                from datetime import timezone, timedelta
                start = (datetime.now(timezone.utc) - timedelta(days=5)).strftime("%Y-%m-%d")
                bars_1h = alpaca.get_bars(ticker, "1Hour", start=start,
                                           limit=60, feed="iex").df
        except (IndexError, Exception) as _e_fetch:
            log.warning("Reversal bar fetch failed %s: %s", ticker, _e_fetch)
            return dict(_safe_default)

        if bars_5m is None or bars_1h is None or bars_5m.empty or bars_1h.empty:
            return dict(_safe_default)

        closes_5m = [c for c in bars_5m["close"].tolist()  if c is not None]
        highs_5m  = [h for h in bars_5m["high"].tolist()   if h is not None]
        lows_5m   = [l for l in bars_5m["low"].tolist()    if l is not None]
        vols_5m   = [v for v in bars_5m["volume"].tolist() if v is not None]
        closes_1h = [c for c in bars_1h["close"].tolist()  if c is not None]
        highs_1h  = [h for h in bars_1h["high"].tolist()   if h is not None]
        lows_1h   = [l for l in bars_1h["low"].tolist()    if l is not None]

        # Defensive guard — every list below is indexed by position; bail out
        # to the safe default rather than risk an out-of-range access if any
        # came back short or empty (sparse crypto data, gaps, etc).
        if not closes_5m or not highs_5m or not lows_5m or not vols_5m \
                or not closes_1h or not highs_1h or not lows_1h:
            return dict(_safe_default)

        # RSI on 5min
        def calc_rsi(closes, period=14):
            if len(closes) < period + 1:
                return 50
            gains = [max(closes[i]-closes[i-1],0) for i in range(1,len(closes))]
            losses= [max(closes[i-1]-closes[i],0) for i in range(1,len(closes))]
            avg_g = sum(gains[-period:]) / period
            avg_l = sum(losses[-period:]) / period
            if avg_l == 0: return 100
            rs = avg_g / avg_l
            return round(100 - (100 / (1 + rs)), 1)

        rsi = calc_rsi(closes_5m)

        # ── Adaptive RSI thresholds — stock-specific percentiles ──────────────
        rsi_thresh = get_adaptive_rsi_thresholds(ticker)
        OVERSOLD_THRESH    = rsi_thresh["oversold"]    # e.g. SPY=38, TSLA=28
        OVERBOUGHT_THRESH  = rsi_thresh["overbought"]  # e.g. SPY=62, TSLA=72
        EXTREME_OVERSOLD   = rsi_thresh["p10"]         # very rare extreme
        EXTREME_OVERBOUGHT = rsi_thresh["p90"]

        # Key levels from 1H (swing highs/lows in last 5 days)
        swing_highs = []
        swing_lows  = []
        if len(highs_1h) >= 5 and len(lows_1h) >= 5:
            for i in range(2, len(closes_1h) - 2):
                if highs_1h[i] > highs_1h[i-1] and highs_1h[i] > highs_1h[i-2] and                highs_1h[i] > highs_1h[i+1] and highs_1h[i] > highs_1h[i+2]:
                    swing_highs.append(highs_1h[i])
                if lows_1h[i] < lows_1h[i-1] and lows_1h[i] < lows_1h[i-2] and                lows_1h[i] < lows_1h[i+1] and lows_1h[i] < lows_1h[i+2]:
                    swing_lows.append(lows_1h[i])

        # Find nearest key level to current price
        all_levels = swing_highs + swing_lows
        nearest_level = min(all_levels, key=lambda x: abs(x - price)) if all_levels else price
        dist_to_level = abs(price - nearest_level) / price * 100

        # Volume divergence: price making new extreme but volume declining
        recent_vols   = vols_5m[-6:]
        recent_closes = closes_5m[-6:]
        _recent3  = closes_5m[-3:]
        _prior6   = closes_5m[-9:-3]   # empty when len < 9 for sparse crypto bars
        if _recent3 and _prior6:
            making_new_low  = min(_recent3) < min(_prior6)
            making_new_high = max(_recent3) > max(_prior6)
        else:
            making_new_low  = False
            making_new_high = False
        vol_declining   = (recent_vols[-1] < sum(recent_vols[:-1]) / max(len(recent_vols)-1, 1)
                           if len(recent_vols) >= 2 else False)
        vol_divergence  = (making_new_low or making_new_high) and vol_declining

        # Extended move: 3+ bars same direction
        if len(closes_5m) >= 4:
            last_moves = [closes_5m[i] - closes_5m[i-1] for i in range(-4, 0)]
            all_up   = all(m > 0 for m in last_moves)
            all_down = all(m < 0 for m in last_moves)
            extended_move = all_up or all_down
        else:
            extended_move = False

        # Candle pattern at extreme (hammer/shooting star approximation)
        if len(closes_5m) >= 2 and len(lows_5m) >= 1 and len(highs_5m) >= 1:
            last_open  = closes_5m[-2]
            last_close = closes_5m[-1]
            last_high  = highs_5m[-1]
            last_low   = lows_5m[-1]
            body       = abs(last_close - last_open)
            lower_wick = (min(last_open, last_close) - last_low)
            upper_wick = (last_high - max(last_open, last_close))
            hammer          = lower_wick > body * 2 and upper_wick < body * 0.5
            shooting_star   = upper_wick > body * 2 and lower_wick < body * 0.5
            reversal_candle = hammer or shooting_star
        else:
            reversal_candle = False

        # ── Time-of-day multiplier ───────────────────────────────────────────
        # Morning reversals (9:30-10:30am) are strongest — opening panic/gap fills
        # Midday (11am-2pm) are weakest — low volume, choppy
        # Power hour (3-4pm) reversals are strong but risky (EOD selling)
        import pytz as _ptz
        _ET  = _ptz.timezone("America/New_York")
        _now = datetime.now(_ET)
        _hour = _now.hour + _now.minute / 60

        if 9.5 <= _hour <= 10.5:
            tod_multiplier = 1.30   # opening hour — strongest reversals
            tod_label = "opening"
        elif 10.5 < _hour <= 11.5:
            tod_multiplier = 1.15   # late morning — still good
            tod_label = "late morning"
        elif 11.5 < _hour <= 14.0:
            tod_multiplier = 0.85   # midday — weak/choppy, discount signal
            tod_label = "midday"
        elif 14.0 < _hour <= 15.0:
            tod_multiplier = 1.10   # early power hour
            tod_label = "early power hour"
        elif 15.0 < _hour <= 16.0:
            tod_multiplier = 1.20   # power hour — strong but EOD risk
            tod_label = "power hour"
        else:
            tod_multiplier = 1.0
            tod_label = "normal"

        # Score the reversal zone strength using ADAPTIVE thresholds
        strength  = 0
        zone_type = "NONE"

        if rsi <= OVERSOLD_THRESH:
            zone_type = "OVERSOLD"
            base = 30 + (OVERSOLD_THRESH - rsi)
            if rsi <= EXTREME_OVERSOLD:
                base += 10  # extra credit for historically rare extreme
            strength += min(50, base)
        elif rsi >= OVERBOUGHT_THRESH:
            zone_type = "OVERBOUGHT"
            base = 30 + (rsi - OVERBOUGHT_THRESH)
            if rsi >= EXTREME_OVERBOUGHT:
                base += 10
            strength += min(50, base)

        if dist_to_level < 1.5:
            strength += 25
        elif dist_to_level < 3.0:
            strength += 10

        if vol_divergence:  strength += 20
        if extended_move:   strength += 15
        if reversal_candle: strength += 15

        # Time-of-day no longer discounts zone strength — applied as a direct
        # confidence adjustment in scan_ticker instead, keeping strength honest.
        strength = min(strength, 100)

        # Entry quality — uses adaptive thresholds
        at_extreme = (rsi <= OVERSOLD_THRESH or rsi >= OVERBOUGHT_THRESH)
        if strength >= 70 and at_extreme:
            entry_quality = "IDEAL"
        elif strength >= 45:
            entry_quality = "GOOD"
        elif strength >= 25:
            entry_quality = "WAIT"
        else:
            entry_quality = "NO"

        in_zone = zone_type != "NONE" and strength >= 35  # slightly looser gate

        # What to wait for — uses adaptive thresholds in message
        wait_for = ""
        if not in_zone:
            if not at_extreme:
                wait_for = (f"RSI {rsi:.0f} not at extreme for {ticker} "
                            f"(need <{OVERSOLD_THRESH:.0f} oversold "
                            f"or >{OVERBOUGHT_THRESH:.0f} overbought)")
            elif dist_to_level > 3:
                wait_for = f"Price ${price:.2f} not near key level ${nearest_level:.2f} ({dist_to_level:.1f}% away)"
            else:
                wait_for = "No reversal confluence — wait for exhaustion signal"

        result = {
            "in_reversal_zone":  in_zone,
            "zone_type":         zone_type,
            "strength":          round(strength),
            "entry_quality":     entry_quality,
            "wait_for":          wait_for,
            "rsi_oversold_thresh":   OVERSOLD_THRESH,
            "rsi_overbought_thresh": OVERBOUGHT_THRESH,
            "key_level":        round(nearest_level, 4),
            "rsi":              rsi,
            "vol_divergence":   vol_divergence,
            "extended_move":    extended_move,
            "reversal_candle":  reversal_candle,
            "dist_to_level":    round(dist_to_level, 2),
        }

        result["tod_label"]      = tod_label
        result["tod_multiplier"] = tod_multiplier

        log_agent("system", "REVERSAL",
            f"{ticker} | Zone: {zone_type} | Strength: {strength} | "
            f"RSI: {rsi} | Level: ${nearest_level:.2f} ({dist_to_level:.1f}% away) | "
            f"Quality: {entry_quality} | ToD: {tod_label} (×{tod_multiplier:.2f})")

        return result

    except Exception as e:
        log.warning("Reversal analysis failed %s: %s", ticker, e)
        return {"in_reversal_zone": False, "zone_type": "NONE", "strength": 0,
                "entry_quality": "WAIT", "wait_for": str(e),
                "key_level": price, "rsi": 50, "vol_divergence": False,
                "extended_move": False, "reversal_candle": False, "dist_to_level": 0}



def get_news_velocity(ticker: str) -> dict:
    """
    Measure news acceleration — not just whether there's news,
    but whether it's increasing rapidly (catalyst developing).

    Compares:
    - Articles in last 1 hour vs last 24 hours (normalized)
    - Average sentiment shift over time
    - Breaking news keywords (FDA, earnings, merger, lawsuit, upgrade, downgrade)

    Returns:
    - velocity: "ACCELERATING" | "NORMAL" | "QUIET"
    - articles_1h: count in last hour
    - articles_24h: count in last 24h
    - hourly_rate: articles per hour over last 24h
    - acceleration: ratio of recent vs baseline
    - breaking: bool (high-impact keyword detected)
    - summary: one-line description
    """
    from datetime import datetime, timezone, timedelta

    BREAKING_KEYWORDS = [
        "fda approval", "fda approved", "merger", "acquisition", "buyout",
        "earnings beat", "earnings miss", "guidance raised", "guidance cut",
        "upgrade", "downgrade", "initiated", "short seller", "fraud",
        "sec investigation", "lawsuit", "bankruptcy", "restructuring",
        "ceo resign", "ceo fired", "partnership", "contract win",
        "recall", "safety", "data breach", "hack",
    ]

    try:
        now    = datetime.now(timezone.utc)
        cutoff_1h  = (now - timedelta(hours=1)).isoformat()
        cutoff_24h = (now - timedelta(hours=24)).isoformat()

        news_all = alpaca.get_news(symbol=ticker, limit=30)
        if not news_all:
            return {"velocity": "QUIET", "articles_1h": 0, "articles_24h": 0,
                    "hourly_rate": 0, "acceleration": 1.0,
                    "breaking": False, "summary": "No recent news"}

        # Count by time window
        articles_1h  = 0
        articles_24h = 0
        breaking     = False
        headlines    = []

        for article in news_all:
            ts = article.created_at
            if hasattr(ts, 'isoformat'):
                ts_str = ts.isoformat()
            else:
                ts_str = str(ts)

            if ts_str >= cutoff_24h:
                articles_24h += 1
                headline = (article.headline or "").lower()
                headlines.append(headline)

                if ts_str >= cutoff_1h:
                    articles_1h += 1

                # Check for breaking keywords
                if any(kw in headline for kw in BREAKING_KEYWORDS):
                    breaking = True

        # Hourly rate over 24h baseline
        hourly_rate  = articles_24h / 24
        acceleration = (articles_1h / max(hourly_rate, 0.1))  # ratio vs baseline

        if acceleration >= 3.0 or breaking:
            velocity = "ACCELERATING"
            summary  = (f"{'⚡ Breaking news — ' if breaking else ''}"
                        f"{articles_1h} articles in last hour vs "
                        f"{hourly_rate:.1f}/hr baseline")
        elif acceleration >= 1.5:
            velocity = "ACCELERATING"
            summary  = f"News picking up: {articles_1h}/hr vs {hourly_rate:.1f}/hr avg"
        elif articles_24h == 0:
            velocity = "QUIET"
            summary  = "No news in 24 hours"
        else:
            velocity = "NORMAL"
            summary  = f"{articles_24h} articles in 24h, {articles_1h} in last hour"

        log_agent("system", "NEWS_VEL",
            f"{ticker} | {velocity} | {articles_1h}/hr (baseline {hourly_rate:.1f}/hr) "
            f"| acc {acceleration:.1f}x | breaking: {breaking}")

        return {
            "velocity":     velocity,
            "articles_1h":  articles_1h,
            "articles_24h": articles_24h,
            "hourly_rate":  round(hourly_rate, 2),
            "acceleration": round(acceleration, 2),
            "breaking":     breaking,
            "summary":      summary,
        }

    except Exception as e:
        log.warning("News velocity failed %s: %s", ticker, e)
        return {"velocity": "NORMAL", "articles_1h": 0, "articles_24h": 0,
                "hourly_rate": 0, "acceleration": 1.0,
                "breaking": False, "summary": "News data unavailable"}

def agent_grok_analyst(ticker: str, price: float) -> dict:
    asset_type = "cryptocurrency" if is_crypto(ticker) else "US stock"

    # Load lessons (losses) and success patterns (wins)
    sym_lessons     = get_symbol_lessons(ticker, limit=3)
    general_lessons = get_recent_lessons(limit=3)
    all_lessons     = sym_lessons + [
        l for l in general_lessons if l.get("symbol") != ticker
    ]
    lessons_block = format_lessons_for_prompt(all_lessons)
    lessons_block += format_success_for_prompt(get_recent_success_patterns(limit=3))

    # Upcoming event warning for stocks
    event_warning = ""
    if not is_crypto(ticker):
        has_event, event_desc = is_event_risk(ticker)
        if has_event:
            event_warning = f"\n⚠️ UPCOMING EVENT: {event_desc}\nFactor increased uncertainty into your confidence score."

    # Sector rotation context
    rotation_block = ""
    rotation_adj   = get_sector_rotation_adjustment(ticker)
    rotation       = scan_sector_rotation()
    if rotation.get("summary"):
        ticker_sectors = [s for s, m in SECTOR_MAP.items() if ticker.upper() in m]
        sector_status  = ""
        for s in ticker_sectors:
            if s in rotation.get("hot", []):
                sector_status += f"\n✅ {SECTOR_NAMES.get(s, s)} is HOT — institutional inflows"
            elif s in rotation.get("cold", []):
                sector_status += f"\n❌ {SECTOR_NAMES.get(s, s)} is COLD — institutional outflows"
        if sector_status:
            rotation_block = (
                f"\nSector rotation: {rotation['summary']}"
                f"{sector_status}"
                f"\nMacro: {rotation.get('macro_theme','')}\n"
            )

    # Fetch recent news for this ticker and score each article's market impact
    news_block = ""
    news_velocity = {"velocity": "NORMAL", "breaking": False, "summary": "", "acceleration": 1.0}
    try:
        from datetime import datetime as _dt, timezone as _tz, timedelta as _td

        # Fetch news velocity first — measures acceleration not just presence
        if not is_crypto(ticker):
            news_velocity = get_news_velocity(ticker)

        news_start = (_dt.now(_tz.utc) - _td(hours=48)).strftime("%Y-%m-%dT%H:%M:%SZ")
        news_end   = _dt.now(_tz.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        # Only fetch for stocks — crypto news is handled via X/Twitter by Grok
        if not is_crypto(ticker):
            try:
                articles = alpaca.get_news(symbol=ticker, limit=8)
            except Exception:
                articles = []

            if articles:
                scored = []
                for a in articles:
                    hl = (a.headline or "").lower()
                    impact = 40
                    high_impact = ["earnings", "beat", "miss", "guidance", "revenue",
                                   "acquisition", "merger", "bankruptcy", "fda", "lawsuit",
                                   "ceo", "layoff", "buyback", "dividend", "split",
                                   "upgrade", "downgrade", "record", "billion"]
                    low_impact  = ["analyst", "note", "watch", "monitor", "consider",
                                   "could", "might", "potential", "rumor"]
                    for kw in high_impact:
                        if kw in hl: impact = min(100, impact + 15)
                    for kw in low_impact:
                        if kw in hl: impact = max(10, impact - 10)
                    scored.append((impact, a.headline))

                scored.sort(key=lambda x: x[0], reverse=True)

                news_lines = []
                for impact, headline in scored[:5]:
                    bar = "🔴" if impact >= 70 else "🟡" if impact >= 40 else "⚪"
                    news_lines.append(f"  {bar} [{impact}/100] {headline}")

                # Add velocity context to news block
                vel  = news_velocity["velocity"]
                acc  = news_velocity["acceleration"]
                vel_line = ""
                if vel == "ACCELERATING":
                    vel_line = (f"\n⚡ NEWS ACCELERATING: {acc:.1f}x normal rate"
                                f"{'  — BREAKING NEWS DETECTED' if news_velocity['breaking'] else ''}"
                                f"\n  {news_velocity['summary']}")
                elif news_velocity["velocity"] == "QUIET":
                    vel_line = "\n🔇 News quiet — no significant coverage in 24h"

                news_block = (
                    f"\nNews velocity: {vel} ({acc:.1f}x baseline){vel_line}\n"
                    f"Recent news (impact scored 0-100):\n"
                    + "\n".join(news_lines)
                    + "\nWeight your news_score based on impact ratings. "
                    "If news is ACCELERATING, increase news_score by 15+.\n"
                )
    except Exception as e:
        log.warning("News fetch failed for %s: %s", ticker, e)

    prompt = f"""You are a reversal-focused market analyst with real-time web and X/Twitter access.

Analyze {asset_type}: {ticker} at ${price:.4f}

FOCUS ON REVERSALS — not trend continuation.
Ask yourself:
1. Has price made an extended move in one direction (overbought/oversold)?
2. Is sentiment extreme (euphoric = sell signal, fearful = buy signal)?
3. Are there signs of exhaustion (news priced in, volume fading on new highs/lows)?
4. Where is the nearest key support (buy reversal) or resistance (sell reversal)?

Check: recent X/Twitter posts, news, whether the move is exhausted or just starting.
{lessons_block}{event_warning}{rotation_block}{news_block}
If any past mistakes above are relevant to the current setup, factor them into your confidence score.

Return ONLY valid JSON:
{{
  "direction": "BULLISH|BEARISH|NEUTRAL",
  "confidence": 0-100,
  "technical_score": 0-100,
  "sentiment_score": 0-100,
  "news_score": 0-100,
  "catalyst": "main reversal driver one sentence",
  "risk": "main risk if reversal fails",
  "exhaustion_signal": "what signals the move is exhausted",
  "key_reversal_level": "price level where reversal most likely",
  "action": "BUY|SELL|HOLD"
}}"""
    result = extract_json(grok_chat([{"role": "user", "content": prompt}], max_tokens=300, timeout=25))
    result["direction"]     = result.get("direction", "NEUTRAL").upper()
    result["action"]        = result.get("action", "HOLD").upper()
    result["news_velocity"] = news_velocity.get("velocity", "NORMAL")
    result["news_breaking"] = news_velocity.get("breaking", False)
    result["news_accel"]    = news_velocity.get("acceleration", 1.0)

    # Breaking news + accelerating → boost confidence (real developing catalyst)
    if news_velocity.get("breaking") and news_velocity.get("acceleration", 1) >= 2.0:
        old_conf = result.get("confidence", 60)
        result["confidence"] = min(100, old_conf + 10)
        log_agent("system", "NEWS_VEL",
            f"{ticker} breaking news boost: {old_conf}% → {result['confidence']}%")

    return result

# ── Agent 2 — Claude decision ─────────────────────────────────────────────────

def agent_trade_classifier(ticker: str, price: float,
                            analysis: dict, bars_1h: list = None,
                            bars_15m: list = None,
                            mtf: dict = None) -> dict:
    """
    Classifies the trade as DAY or SWING based on chart structure.

    DAY trade characteristics:
    - Strong intraday momentum (gap, news catalyst today)
    - Trend clear on 5m/15m but unclear on daily
    - Near end of day — less than 3h of trading left
    - High volume spike today vs average
    - R:R better on intraday level

    SWING trade characteristics:
    - Daily trend clearly established
    - Strong weekly support/resistance levels
    - Catalyst is multi-day (earnings, product launch, macro)
    - Low intraday noise relative to the move size
    - 1D and 4H aligned with signal

    Returns classification + suggested hold_period, stop%, tp%, eod_action
    """
    import pytz
    ET  = pytz.timezone("America/New_York")
    now = datetime.now(ET)
    hours_left = max(0, 16 - now.hour - now.minute/60)

    mtf_summary = mtf.get("summary","") if mtf else ""
    mtf_score   = mtf.get("score", 0)    if mtf else 0
    daily_aligned = "1D" in mtf_summary and (
        analysis.get("direction","") in mtf_summary
    ) if mtf else False

    # Fetch intraday bars for volume analysis
    volume_spike = False
    intraday_range_pct = 0.0
    try:
        sym = ticker
        bars_today = alpaca.get_bars(
            sym, "5Min",
            limit=78, feed="iex"  # full trading day
        ).df
        if not bars_today.empty and len(bars_today) > 10:
            avg_vol   = bars_today["volume"].mean()
            last_vol  = bars_today["volume"].iloc[-1]
            volume_spike = last_vol > avg_vol * 2.0
            day_high  = bars_today["high"].max()
            day_low   = bars_today["low"].min()
            intraday_range_pct = (day_high - day_low) / day_low * 100
    except:
        pass

    prompt = f"""You are a trade classifier. Analyze this setup and decide: DAY TRADE or SWING TRADE.

Ticker: {ticker} @ ${price:.4f}
Direction: {analysis.get("direction","?")} | Confidence: {analysis.get("confidence","?")}%
Catalyst: {analysis.get("catalyst","")}
Risk: {analysis.get("risk","")}

Market context:
- Hours left in trading day: {hours_left:.1f}h
- Multi-timeframe alignment: {mtf_summary} ({mtf_score}/3 timeframes)
- Daily timeframe aligned: {"YES" if daily_aligned else "NO"}
- Volume spike vs average: {"YES — strong momentum" if volume_spike else "NO"}
- Intraday range today: {intraday_range_pct:.2f}%

DAY TRADE if:
- Catalyst is intraday (news today, gap fill, technical breakout)
- Less than 4h left in trading day and momentum is strong
- Daily chart unclear or ranging — only intraday setup visible
- High volume spike confirming intraday move
- Holding overnight adds significant risk (earnings tomorrow, macro event)

SWING TRADE if:
- Daily trend clearly aligned with signal
- Catalyst is multi-day (earnings beat, sector rotation, fundamental change)
- 1D timeframe confirmed in the direction
- Setup has room to run over multiple days
- Low overnight risk

Return ONLY valid JSON:
{{
  "classification": "DAY|SWING",
  "hold_period": "intraday|1-3 days|3-7 days|1-2 weeks",
  "eod_action": "CLOSE|HOLD",
  "stop_pct": -2.5,
  "tp_pct": 4.0,
  "reasoning": "one sentence explaining the classification"
}}

Rules for stop/TP:
- DAY trade: tighter stop (-1.5% to -3%), smaller TP (2-5%), close EOD
- SWING trade: wider stop (-3% to -6%), larger TP (5-15%), hold overnight
- Always maintain minimum 1.5:1 reward/risk ratio
- Be specific based on the actual setup, not generic"""

    try:
        resp = claude.messages.create(
            model=CLAUDE_SONNET,
            max_tokens=200,
            messages=[{"role": "user", "content": prompt}],
        )
        result = extract_json(resp.content[0].text)

        classification = result.get("classification", "DAY")
        stop_pct       = float(result.get("stop_pct", -2.5))
        tp_pct         = float(result.get("tp_pct", 4.0))
        eod_action     = result.get("eod_action", "CLOSE")
        hold_period    = result.get("hold_period", "intraday")
        reasoning      = result.get("reasoning", "")

        # Safety bounds
        stop_pct = max(min(stop_pct, -1.0), -7.0)   # -1% to -7%
        tp_pct   = max(tp_pct, abs(stop_pct) * 1.5)  # min 1.5:1 R:R

        log_agent("claude", "CLASSIFIER",
            f"{ticker} → {classification} | {hold_period} | "
            f"Stop {stop_pct:.1f}% TP +{tp_pct:.1f}% | EOD: {eod_action} | "
            f"{reasoning}")

        return {
            "classification": classification,
            "hold_period":    hold_period,
            "eod_action":     eod_action,
            "stop_pct":       stop_pct,
            "tp_pct":         tp_pct,
            "reasoning":      reasoning,
        }

    except Exception as e:
        log.warning("Trade classifier failed for %s: %s — defaulting to DAY", ticker, e)
        return {
            "classification": "DAY",
            "hold_period":    "intraday",
            "eod_action":     "CLOSE",
            "stop_pct":       -2.5,
            "tp_pct":         4.0,
            "reasoning":      "classifier failed — using conservative defaults",
        }


def agent_claude_decision(ticker: str, price: float,
                           analysis: dict, equity: float,
                           backtest: dict = None,
                           mtf: dict = None,
                           profile_override: dict = None,
                           earnings: dict = None,
                           trade_mode: str = "REVERSAL") -> dict:
    profile    = profile_override if profile_override else get_profile(ticker)
    style      = profile.get("style", "trading")
    conf       = analysis.get("confidence", 0)
    _earn_risk = (earnings or {}).get("risk", "LOW")
    size       = get_position_size(ticker, conf, earnings_risk=_earn_risk)
    order_type = "MARKET" if conf >= 75 else "LIMIT"

    # Yesterday's EOD analysis — injected as context so Claude can factor
    # recent successes and failures into its decision.
    if "_yesterday_ctx" not in analysis:
        try:
            _yd = get_recent_daily_analyses(days=1)
            if _yd:
                analysis["_yesterday_ctx"] = (
                    f"\nYesterday's trading analysis:\n{_yd}\n"
                    "Factor the identified strengths and weaknesses into your decision.\n"
                )
                log_agent("system", "LEARNING",
                    f"Learning loop ACTIVE — injecting yesterday's EOD analysis "
                    f"into Claude decision for {ticker}")
            else:
                analysis["_yesterday_ctx"] = ""
        except Exception:
            analysis["_yesterday_ctx"] = ""

    # Backtest context
    bt_block = ""
    if backtest and backtest.get("verdict") != "INSUFFICIENT":
        bt_block = (
            f"\nHistorical backtest (90d): {backtest['summary']}\n"
            f"Verdict: {backtest['verdict']} — "
            f"factor this into your sizing and confidence.\n"
        )

    # MTF context
    mtf_block = ""
    if mtf:
        mtf_block = (
            f"\nMulti-timeframe: {mtf['summary']}\n"
            f"Timeframe score: {mtf['score']}/3 aligned "
            f"(confidence penalty already applied — do not re-penalize)\n"
        )

    riley_block = (
        f"\nRiley S/R Analysis:\n"
        f"- Setup quality: {analysis.get('riley_quality','?')}\n"
        f"- Zone: {analysis.get('riley_zone','?')} ({analysis.get('riley_touches',0)} touches)\n"
        f"- 1-min structure shift: {analysis.get('riley_structure','?')}\n"
        f"- Exhaustive/parabolic move: {analysis.get('riley_exhaustive',False)}\n"
        f"- Candle pattern: {analysis.get('riley_candle','NONE')} "
        f"(strength {analysis.get('riley_candle_str',0)})\n"
        f"- Entry method: STOP ORDER just beyond 1-min minor support break\n"
        f"- Riley rule: trade ONLY at zone extremes, NEVER in middle of range\n"
        f"- Riley rule: unhealthy/parabolic approach = HIGH probability reversal\n"
    ) if analysis.get("riley_quality") else ""
    if trade_mode == "TREND":
        mode_rules = (
            "TREND MODE — follow the trend direction shown above.\n"
            "MTF penalties have ALREADY been applied to the confidence score. "
            "Do NOT re-evaluate timeframe alignment — that work is done.\n"
            "Your job: decide if the zone + catalyst + risk justify entering NOW.\n"
            "BULLISH = BUY | BEARISH = SELL. RSI does NOT need to be at extreme.\n"
            "HOLD only if: confidence is below threshold, setup is mid-range (not at zone), "
            "or risk/reward is unfavorable."
        )
    elif trade_mode == "REVERSAL":
        mode_rules = (
            "REVERSAL MODE — price at extreme, looking for mean reversion.\n"
            "OVERSOLD = BUY reversal | OVERBOUGHT = SELL reversal.\n"
            "Only enter if clearly at support/resistance extreme — NOT mid-trend."
        )
    else:
        mode_rules = (
            "SETUP MODE — price is near a key zone with confirmation signals.\n"
            "MTF penalties have ALREADY been applied to the confidence score.\n"
            "BULLISH signal at support = BUY | BEARISH signal at resistance = SELL.\n"
            "HOLD only if: zone confirmation absent or risk/reward is poor."
        )

    # Counter-direction block — shown when the opposite setup scores ≥ 50
    _counter_conf   = analysis.get("counter_conf", 0)
    _counter_reason = analysis.get("counter_reason", "")
    _primary_dir    = analysis.get("direction", "NEUTRAL")
    _counter_dir    = "BEARISH" if _primary_dir == "BULLISH" else "BULLISH"
    if _counter_conf >= 50 and _primary_dir in ("BULLISH", "BEARISH"):
        _counter_block = (
            f"\nAlternative setup (counter-direction, no extra data fetched):\n"
            f"{_counter_dir}: {_counter_conf}% | {_counter_reason}\n"
            f"Primary ({_primary_dir}): {conf}% | Primary\n"
            f"If the counter setup is significantly stronger, you may switch direction.\n"
        )
    else:
        _counter_block = ""

    prompt = f"""You are a disciplined trading agent operating in {trade_mode} mode.

{ticker} @ ${price:.4f} | Confidence: {conf}/100 | Direction: {analysis.get('direction')}
Mode: {trade_mode} | RSI: {analysis.get('reversal_zone','?')} zone | Quality: {analysis.get('reversal_quality','?')}

{mode_rules}

Setup:
- Key level: ${analysis.get('key_level', price):.4f}
- Catalyst: {analysis.get('catalyst')}
- Risk: {analysis.get('risk')}
- Exhaustion signal: {analysis.get('exhaustion_signal','')}

Scores — Technical: {analysis.get('technical_score')} | Sentiment: {analysis.get('sentiment_score')} | News: {analysis.get('news_score')}
{riley_block}{bt_block}{mtf_block}
Parameters: size {size}% | Stop {profile.get('stop')}% | TP {profile.get('tp')}% | Min conf {profile.get('conf')}%
Order type: {order_type}
Portfolio delta: {analysis.get('portfolio_delta_pct', 0):+.1f}% per 1% SPY move ({"⚠️ HIGH" if abs(analysis.get('portfolio_delta_pct', 0)) > 10 else "OK"})
{_counter_block}{analysis.get('_yesterday_ctx', '')}
DECISION RULE — The confidence score already encodes ALL technical factors:
zone quality, RSI positioning, structure shift, MTF alignment, time-of-day,
earnings risk, and backtest performance are all embedded as penalties/bonuses.
Your job is to decide if this confidence level justifies the trade given CURRENT
PORTFOLIO RISK — not to re-evaluate technical setup quality.
EXECUTE (BUY or SELL) unless: price data is invalid, portfolio is at max positions,
or portfolio delta limit is hit.
HOLD only for hard portfolio risk reasons — technical concerns are already in the score.

Return ONLY JSON:
{{"execute": true, "action": "BUY|SELL|HOLD", "size_pct": {size}, "order_type": "{order_type}", "limit_price": null, "reasoning": "one sentence"}}"""

    resp = claude.messages.create(
        model=CLAUDE_SONNET,
        max_tokens=300,
        messages=[{"role": "user", "content": prompt}],
    )
    try:
        result = extract_json(resp.content[0].text)
    except Exception as e:
        log.warning("Claude decision JSON parse failed for %s: %s — raw: %.300s",
                    ticker, e, resp.content[0].text)
        log_agent("claude", "CLAUDE",
            f"{ticker} — JSON parse failed, defaulting to HOLD")
        return {"execute": False, "action": "HOLD", "size_pct": 0,
                "order_type": order_type, "limit_price": None,
                "reasoning": "JSON parse failed — defaulting to HOLD"}

    # If Sonnet is uncertain, let it re-analyze with more context
    action = result.get("action","HOLD")
    if action == "HOLD" and result.get("reasoning","").lower().count("uncertain") > 0:
        log_agent("claude", "CLAUDE",
            f"{ticker} — Sonnet uncertain, requesting deeper analysis...")
        deeper_prompt = prompt + f"""

Your initial assessment was HOLD due to uncertainty.
Please analyze more deeply:
1. What would need to be TRUE for this to be a BUY?
2. What would need to be TRUE for this to be a SELL?
3. Given the current data, which scenario is more likely?

Commit to a decision. Return the same JSON format."""
        resp2 = claude.messages.create(
            model=CLAUDE_SONNET,
            max_tokens=400,
            messages=[
                {"role": "user",      "content": prompt},
                {"role": "assistant", "content": resp.content[0].text},
                {"role": "user",      "content": deeper_prompt},
            ],
        )
        try:
            result2 = extract_json(resp2.content[0].text)
        except Exception as e:
            log.warning("Claude deeper-analysis JSON parse failed for %s: %s — raw: %.300s",
                        ticker, e, resp2.content[0].text)
            result2 = {}
        if result2.get("action") in ("BUY","SELL"):
            log_agent("claude", "CLAUDE",
                f"{ticker} — deeper analysis → {result2.get('action')}")
            result = result2

    # Hard clamp size to profile limits regardless of what model says
    result["size_pct"] = min(
        max(float(result.get("size_pct", size)), profile["min"]),
        profile["max"]
    )
    return result

# ── Agent 3 — Risk Manager ────────────────────────────────────────────────────

def agent_risk_manager(ticker: str, price: float, decision: dict,
                        equity: float, open_positions: dict) -> dict:
    # ── Delta check first ─────────────────────────────────────────────────
    is_long_trade  = decision.get("action") == "BUY"
    is_short_trade = decision.get("action") == "SELL"
    delta = calculate_portfolio_delta(equity)
    net_pct = delta["net_delta_pct"]

    # Block new longs if already heavily net long (delta > 12%)
    if is_long_trade and net_pct > (DELTA_ALERT_PCT * 100):
        return {"approved": False,
                "reason": f"Portfolio delta {net_pct:+.1f}% already overexposed LONG — "
                          f"new long would increase directional risk",
                "size_pct": 0}
    # Block new shorts if already heavily net short (delta < -12%)
    if is_short_trade and net_pct < -(DELTA_ALERT_PCT * 100):
        return {"approved": False,
                "reason": f"Portfolio delta {net_pct:+.1f}% already overexposed SHORT — "
                          f"new short would increase directional risk",
                "size_pct": 0}

    # Reduce position size proportionally when approaching delta limit
    size_pct = decision.get("size_pct", 2.0)
    if is_long_trade and net_pct > 8:
        scale = max(0.5, 1 - (net_pct - 8) / 8)
        size_pct = round(size_pct * scale, 2)
        log_agent("risk", "DELTA",
            f"{ticker} size reduced {decision.get('size_pct',2):.1f}% → {size_pct:.1f}% "
            f"(portfolio delta {net_pct:+.1f}%)")
        decision = dict(decision)
        decision["size_pct"] = size_pct
    elif is_short_trade and net_pct < -8:
        scale = max(0.5, 1 - (abs(net_pct) - 8) / 8)
        size_pct = round(size_pct * scale, 2)
        log_agent("risk", "DELTA",
            f"{ticker} size reduced {decision.get('size_pct',2):.1f}% → {size_pct:.1f}% "
            f"(portfolio delta {net_pct:+.1f}%)")
        decision = dict(decision)
        decision["size_pct"] = size_pct

    n        = len(open_positions)
    has      = already_has_position(ticker, open_positions)
    pos_side = get_position_side(ticker, open_positions)
    profile  = get_profile(ticker)
    action   = decision.get("action", "HOLD")
    is_short = action == "SELL" and not has  # opening a new short

    # Shorts use reduced size
    max_size = profile["max"] * SHORT_SIZE_MULTIPLIER if is_short else profile["max"]

    short_note = ""
    if is_short:
        if not can_short(ticker):
            short_note = f"{ticker} is NOT in the shortable list."
        else:
            short_note = f"This is a SHORT position. Max size reduced to {max_size:.1f}%."

    prompt = f"""Risk manager review for {ticker}.

Action: {action} @ ${price:.4f}
Proposed size: {decision.get("size_pct")}% of ${equity:,.2f}
Asset style: {profile["style"]} | Max allowed: {max_size:.1f}%
Open positions: {n}/{MAX_POSITIONS} | Current position: {pos_side}
{short_note}

Block if:
- Already long + trying to BUY again
- Already short + trying to SELL again  
- Trying to short a non-shortable ticker
- Price = 0
- Positions full
- Size > {max_size:.1f}%

Return ONLY JSON:
{{"approved": true, "size_pct": {decision.get("size_pct", 2)}, "reason": "one sentence"}}"""

    resp = claude.messages.create(
        model=CLAUDE_HAIKU,
        max_tokens=120,
        messages=[{"role": "user", "content": prompt}],
    )
    result = extract_json(resp.content[0].text)
    result["size_pct"] = min(float(result.get("size_pct", 2)), max_size)

    # Hard block conditions — cannot be bypassed
    if action == "BUY" and pos_side == "long":
        result["approved"] = False
        result["reason"]   = f"Already long {ticker} — no double entry"
    if action == "SELL" and pos_side == "short":
        result["approved"] = False
        result["reason"]   = f"Already short {ticker} — no double short"
    if action == "SELL" and not has and not can_short(ticker):
        result["approved"] = False
        result["reason"]   = f"{ticker} not in shortable list"
    _short_thresh = SHORT_CONFIDENCE_THRESH_CRYPTO if is_crypto(ticker) else SHORT_CONFIDENCE_THRESH
    if is_short:
        _short_conf = decision.get("confidence", 0)
        log_agent("risk", "RISK",
            f"{ticker} SHORT conf check: {_short_conf}% vs threshold {_short_thresh}% | "
            f"shortable={can_short(ticker)}")
        if _short_conf < _short_thresh:
            result["approved"] = False
            result["reason"]   = (f"Short requires {_short_thresh}%+ confidence "
                                  f"({_short_conf}% given)")
    if is_short and is_crypto(ticker):
        result["approved"] = False
        result["reason"]   = "Crypto shorts not supported on Alpaca paper (no borrowing available)"
    if price <= 0:
        result["approved"] = False
        result["reason"]   = "Price unavailable"
    if n >= MAX_POSITIONS:
        result["approved"] = False
        result["reason"]   = f"Max {MAX_POSITIONS} positions reached"
    if is_short and result.get("approved"):
        log_agent("risk", "RISK",
            f"{ticker} SHORT APPROVED — size {result.get('size_pct','?')}% | "
            f"{result.get('reason','')}")
    return result

# ── Order execution ───────────────────────────────────────────────────────────


def _detect_1min_pattern_extreme(ticker: str, action: str, entry_price: float = None) -> dict:
    """
    Riley Coleman 1-min entry-pattern detection — identifies the structural
    pattern behind this entry and the price level the stop must sit one tick
    beyond.

    Checked in order: bait candle, head & shoulders, double top/bottom,
    break & retest, exhaustive drop (long entries only), and finally the
    strong swing-break candle.

    Hard 2% rule: the detected extreme must sit within 2% of `entry_price` —
    otherwise it's a historical level rather than the immediate reversal
    candle, and is discarded entirely. There is no fallback: if nothing is
    found, the caller (calculate_smart_levels) skips the trade.

    Returns {"extreme": float|None, "pattern": str|None,
             "zone_high": float|None, "zone_low": float|None}
    `zone_high`/`zone_low` are the recent 15-min range, used only for the
    informational 3R-vs-zone check.
    """
    try:
        sym = alpaca_symbol(ticker)
        if is_crypto(ticker):
            bars    = alpaca.get_crypto_bars(sym, "1Min", limit=30).df
            bars_15 = alpaca.get_crypto_bars(sym, "15Min", limit=20).df
        else:
            bars    = alpaca.get_bars(sym, "1Min", limit=30, feed="iex").df
            bars_15 = alpaca.get_bars(sym, "15Min", limit=20, feed="iex").df

        highs  = bars["high"].tolist()
        lows   = bars["low"].tolist()
        opens  = bars["open"].tolist()
        closes = bars["close"].tolist()
        if len(highs) < 4:
            return {"extreme": None, "pattern": None, "zone_high": None, "zone_low": None}

        zone_high = float(bars_15["high"].max()) if not bars_15.empty else None
        zone_low  = float(bars_15["low"].min())  if not bars_15.empty else None

        is_short = action == "SELL"
        candidate = None

        # ── Bait candle: range >= 1.5x the average range of the previous 5
        # candles, AND one of the next 1-3 candles fully covers its range and
        # breaks its high or low. If price chops more than 3 candles without
        # fully recovering/breaking, the bait candle is invalid.
        for i in range(len(highs) - 2, max(len(highs) - 9, 5) - 1, -1):
            rng = highs[i] - lows[i]
            if rng <= 0:
                continue
            prev_ranges = [highs[j] - lows[j] for j in range(i - 5, i)]
            avg_prev_rng = sum(prev_ranges) / len(prev_ranges)
            if avg_prev_rng <= 0 or rng < 1.5 * avg_prev_rng:
                continue

            confirmed = False
            for k in range(i + 1, min(i + 4, len(highs))):
                covers = highs[k] >= highs[i] and lows[k] <= lows[i]
                breaks = highs[k] > highs[i] or lows[k] < lows[i]
                if covers and breaks:
                    confirmed = True
                    break
            if not confirmed:
                continue

            if is_short and closes[i] > opens[i]:       # bullish bait reversed → short here
                candidate = {"extreme": highs[i],
                              "pattern": f"BAIT_CANDLE_BEARISH (bait high ${highs[i]:.4f})"}
                break
            if not is_short and closes[i] < opens[i]:   # bearish bait reversed → long here
                candidate = {"extreme": lows[i],
                              "pattern": f"BAIT_CANDLE_BULLISH (bait low ${lows[i]:.4f})"}
                break

        # ── Head & shoulders: a peak/trough flanked by two lower/higher
        # neighbours — treated as "the head" for stop placement.
        if candidate is None:
            for i in range(len(highs) - 3, max(len(highs) - 9, 1) - 1, -1):
                if is_short and highs[i] > highs[i-1] and highs[i] > highs[i+1]:
                    candidate = {"extreme": highs[i],
                                  "pattern": f"HEAD_AND_SHOULDERS (head high ${highs[i]:.4f})"}
                    break
                if not is_short and lows[i] < lows[i-1] and lows[i] < lows[i+1]:
                    candidate = {"extreme": lows[i],
                                  "pattern": f"HEAD_AND_SHOULDERS (head low ${lows[i]:.4f})"}
                    break

        # ── Double top / double bottom: two similar highs/lows, current
        # candle now reversing away from them.
        if candidate is None:
            window = min(25, len(highs))
            if window >= 6:
                half = window // 2
                navg = min(15, len(highs))
                avg_range = sum(highs[i] - lows[i] for i in range(-navg, 0)) / navg
                tol = avg_range * 3
                top1, top2 = max(highs[-window:-half]), max(highs[-half:])
                bot1, bot2 = min(lows[-window:-half]),  min(lows[-half:])
                if (is_short and abs(top1 - top2) <= tol
                        and closes[-1] < opens[-1]):
                    candidate = {"extreme": max(top1, top2),
                                  "pattern": f"DOUBLE_TOP (tops ${top1:.4f}/${top2:.4f})"}
                elif (not is_short and abs(bot1 - bot2) <= tol
                        and closes[-1] > opens[-1]):
                    candidate = {"extreme": min(bot1, bot2),
                                  "pattern": f"DOUBLE_BOTTOM (bottoms ${bot1:.4f}/${bot2:.4f})"}

        # ── Break & retest: prior 15-min resistance/support broken, current
        # 1-min candle now retesting it.
        if candidate is None and bars_15 is not None and not bars_15.empty and len(bars_15) >= 10:
            h15 = bars_15["high"].tolist()
            l15 = bars_15["low"].tolist()
            if not is_short:
                prev_resistance = max(h15[-10:-5])
                if (max(highs[-10:]) > prev_resistance
                        and closes[-1] > opens[-1]
                        and prev_resistance * 0.998 < closes[-1] < prev_resistance * 1.015):
                    candidate = {"extreme": lows[-1],
                                  "pattern": f"BREAK_AND_RETEST_BULLISH (retest low ${lows[-1]:.4f})"}
            else:
                prev_support = min(l15[-10:-5])
                if (min(lows[-10:]) < prev_support
                        and closes[-1] < opens[-1]
                        and prev_support * 0.985 < closes[-1] < prev_support * 1.002):
                    candidate = {"extreme": highs[-1],
                                  "pattern": f"BREAK_AND_RETEST_BEARISH (retest high ${highs[-1]:.4f})"}

        # ── Exhaustive drop (long entries only): parabolic down move likely
        # to snap back — stop goes below the drop candle's low.
        if candidate is None and not is_short and len(closes) >= 5:
            ranges = [highs[i] - lows[i] for i in range(-5, 0)]
            accel  = ranges[-1] / max(sum(ranges[:-1]) / 4, 0.0001)
            if accel > 2.5 and all(closes[i] < opens[i] for i in range(-4, 0)):
                candidate = {"extreme": lows[-1],
                              "pattern": f"EXHAUSTIVE_DROP (drop low ${lows[-1]:.4f})"}

        # ── Strong swing-break candle (last resort): the candle that broke
        # the recent 1-min swing in the trade direction.
        if candidate is None and len(closes) >= 10:
            last_body = abs(closes[-1] - opens[-1])
            avg_body  = sum(abs(closes[i] - opens[i]) for i in range(-10, 0)) / 10
            if last_body > avg_body * 1.1:
                if is_short and closes[-1] < opens[-1]:
                    candidate = {"extreme": highs[-1],
                                  "pattern": f"STRONG_BEARISH (candle high ${highs[-1]:.4f})"}
                elif not is_short and closes[-1] > opens[-1]:
                    candidate = {"extreme": lows[-1],
                                  "pattern": f"STRONG_BULLISH (candle low ${lows[-1]:.4f})"}

        if candidate is None:
            return {"extreme": None, "pattern": None, "zone_high": zone_high, "zone_low": zone_low}

        # Hard 2% rule — the pattern extreme must be the *immediate* reversal
        # candle, not a historical level. If it's further than 2% from the
        # current price, discard it entirely — the caller skips the trade.
        if (entry_price and entry_price > 0
                and abs(candidate["extreme"] - entry_price) / entry_price > 0.02):
            return {"extreme": None, "pattern": None, "zone_high": zone_high, "zone_low": zone_low}

        candidate["zone_high"] = zone_high
        candidate["zone_low"]  = zone_low
        return candidate
    except Exception as e:
        log.warning("1-min pattern detection failed %s: %s", ticker, e)
        return {"extreme": None, "pattern": None, "zone_high": None, "zone_low": None}


def calculate_smart_levels(ticker: str, entry_price: float,
                            action: str, profile: dict,
                            risk_multiplier: float = 1.0) -> dict:
    """
    Riley Coleman structural stop + fixed-$-risk sizing + 3R take profit.

    Stop:  one tick beyond the structural extreme of the entry pattern
           (H&S head, bait candle, double top/bottom, break & retest,
           exhaustive drop, or strong swing-break candle — see
           _detect_1min_pattern_extreme). There is NO fallback: if no
           pattern extreme is found within the hard 2% rule, the trade
           is skipped entirely.
    Size:  shares = target_risk / abs(entry - stop), where target_risk is
           $500 normally, $350 in ELEVATED VIX, $250 in HIGH/EXTREME VIX.
           If the resulting share count rounds to 0, the trade is skipped.
    TP:    3x the stop distance (3R) from entry. If the 3R target lies
           beyond the recent 15-min range (a major S/R zone), a warning is
           logged but the trade is still taken.

    Returns {"stop_price", "tp_price", "stop_pct", "tp_pct",
             "shares", "target_risk", "stop_reason", "tp_reason"}
    on success, or {"skip": True, "reason": str} if the trade should be
    skipped entirely.
    """
    is_long = action == "BUY"
    tick = entry_price * 0.0001 if is_crypto(ticker) else 0.01

    # ── Structural stop: pattern extreme, one tick beyond it ─────────────────
    # No fallback — if no pattern extreme is found, skip the trade entirely.
    _pat    = _detect_1min_pattern_extreme(ticker, action, entry_price)
    extreme = _pat.get("extreme")
    pattern = _pat.get("pattern")

    if extreme is None:
        log_agent("system", "RILEY",
            f"{ticker} SKIP — no structural stop available, no valid pattern extreme")
        return {"skip": True, "reason": "no structural stop available, no valid pattern extreme"}

    stop_price  = round(extreme + tick, 4) if action == "SELL" else round(extreme - tick, 4)
    stop_reason = f"Riley stop: ${tick:.4f} behind {pattern} extreme"

    log_agent("system", "RILEY", f"{ticker} {stop_reason}")

    stop_distance = abs(entry_price - stop_price)
    if stop_distance <= 0:
        stop_distance = entry_price * 0.005   # guard against a zero-distance stop

    # ── Fixed-$-risk position sizing ──────────────────────────────────────────
    try:
        _vix_regime_name = get_vix_regime().get("regime", "CALM")
    except Exception:
        _vix_regime_name = "CALM"

    if _vix_regime_name == "ELEVATED":
        target_risk = 350
    elif _vix_regime_name in ("HIGH", "EXTREME"):
        target_risk = 250
    else:
        target_risk = 500

    # Edge-proportional risk: scale the flat $ risk by the Σ₀ conviction (bounded
    # 0.5×–1.5×). risk_multiplier defaults to 1.0 (unchanged behaviour) and is
    # only moved by the caller when SIGMA0_EDGE_SIZING is on. Kept inside the VIX
    # tiers so a high-conviction trade in a calm tape can lean in, a marginal one
    # in a HIGH-VIX tape leans out.
    try:
        _rm = float(risk_multiplier)
    except (TypeError, ValueError):
        _rm = 1.0
    _rm = max(0.5, min(1.5, _rm))
    if abs(_rm - 1.0) > 1e-9:
        target_risk = round(target_risk * _rm, 2)
        log_agent("system", "RILEY",
            f"{ticker} edge-sizing ×{_rm:.2f} → risk ${target_risk}")

    raw_shares = target_risk / stop_distance
    shares = round(raw_shares, 6) if is_crypto(ticker) else math.floor(raw_shares)

    if (is_crypto(ticker) and shares <= 0) or (not is_crypto(ticker) and shares < 1):
        log_agent("system", "RILEY",
            f"{ticker} SKIP — stop too wide, position size would be 0 shares "
            f"(stop ${stop_distance:.4f} away, risk ${target_risk})")
        return {"skip": True, "reason": "stop too wide, position size would be 0 shares"}

    # ── Sanity cap: never risk more than 5% of equity in shares ──────────────
    try:
        _cap_equity = get_portfolio_equity()
        max_shares  = (0.05 * _cap_equity) / entry_price
        if shares > max_shares:
            log_agent("system", "RILEY",
                f"{ticker} Riley sizing WARNING: {shares} shares exceeds 5% equity cap "
                f"({max_shares:.6f} max @ ${entry_price:.4f}, equity ${_cap_equity:.2f}) — capping size")
            shares = round(max_shares, 6) if is_crypto(ticker) else max(1, math.floor(max_shares))
    except Exception as _cap_e:
        log.warning("Riley sizing cap check failed %s: %s", ticker, _cap_e)

    log_agent("system", "RILEY",
        f"{ticker} Riley sizing: {shares} shares | risk ${target_risk} | "
        f"stop ${stop_distance:.4f} away")

    # ── 3R take profit ────────────────────────────────────────────────────────
    tp_price = round(entry_price + 3 * stop_distance, 4) if is_long \
               else round(entry_price - 3 * stop_distance, 4)
    log_agent("system", "RILEY", f"{ticker} Riley TP: ${tp_price:.4f} (3R target)")

    # ── 3R-vs-zone informational check — still take the trade, zone system
    # will handle the exit if the 3R target overshoots a major S/R zone.
    _zone_high = _pat.get("zone_high")
    _zone_low  = _pat.get("zone_low")
    if is_long and _zone_high is not None and tp_price > _zone_high:
        log_agent("system", "RILEY",
            f"{ticker} WARNING: 3R target ${tp_price:.4f} is beyond recent resistance "
            f"${_zone_high:.4f} — zone system will manage the exit")
    elif not is_long and _zone_low is not None and tp_price < _zone_low:
        log_agent("system", "RILEY",
            f"{ticker} WARNING: 3R target ${tp_price:.4f} is beyond recent support "
            f"${_zone_low:.4f} — zone system will manage the exit")

    stop_pct = round((stop_price - entry_price) / entry_price * 100, 2)
    tp_pct   = round((tp_price   - entry_price) / entry_price * 100, 2)

    log_agent("system", "LEVELS",
        f"{ticker} {'LONG' if is_long else 'SHORT'} @ ${entry_price:.4f} | "
        f"Stop ${stop_price:.4f} ({stop_pct:+.1f}%) | "
        f"TP ${tp_price:.4f} ({tp_pct:+.1f}%) | {shares} sh @ ${target_risk} risk")

    return {
        "stop_price":  stop_price,
        "tp_price":    tp_price,
        "stop_pct":    stop_pct,
        "tp_pct":      tp_pct,
        "shares":      shares,
        "target_risk": target_risk,
        "stop_reason": stop_reason,
        "tp_reason":   f"Riley TP: 3R target — ${3 * stop_distance:.4f} beyond entry",
    }

def place_order(ticker: str, action: str, size_pct: float,
                price: float, order_type: str, limit_price=None,
                qty_override: float = None) -> dict:
    if price <= 0:
        return {"status": "skipped", "reason": "invalid price"}

    if qty_override is not None:
        # Riley fixed-$-risk sizing already determined the share count
        qty = qty_override
        if is_crypto(ticker):
            qty = round(qty, 6)
            if qty < 0.0001:
                return {"status": "skipped", "reason": "crypto qty too small"}
        else:
            qty = math.floor(qty)
            if qty < 1:
                return {"status": "skipped", "reason": "qty < 1 share"}
    else:
        equity    = get_portfolio_equity()
        trade_val = equity * (size_pct / 100)

        if is_crypto(ticker):
            # Crypto supports fractional quantities — round to 6 decimal places
            qty = round(trade_val / price, 6)
            if qty < 0.0001:
                return {"status": "skipped", "reason": "crypto qty too small"}
        else:
            # Stocks use whole shares — enforce minimum 1
            qty = math.floor(trade_val / price)
            if qty < 1:
                return {"status": "skipped", "reason": "qty < 1 share"}

    try:
        tif = "gtc" if is_crypto(ticker) else "day"
        order = alpaca.submit_order(
            symbol        = alpaca_symbol(ticker),
            qty           = qty,
            side          = action.lower(),
            type          = order_type.lower(),
            time_in_force = tif,
            limit_price   = round(float(limit_price), 4) if limit_price else None
        )
        return {"status": "placed", "order_id": order.id,
                "ticker": ticker, "action": action, "qty": qty, "price": price}
    except Exception as e:
        log.error("Order failed %s: %s", ticker, e)
        return {"status": "error", "error": str(e)}


def check_pending_crypto_order_timeouts():
    """
    Cancel crypto orders (GTC — they never expire on their own) that have sat
    in a pending state for more than 3 minutes. Without this, a stale order on
    an illiquid pair can tie up buying power indefinitely.
    """
    from datetime import timezone as _tz_co, timedelta as _td_co
    try:
        open_orders = alpaca.list_orders(status="open")
    except Exception as e:
        log.warning("check_pending_crypto_order_timeouts: list_orders failed: %s", e)
        return

    pending_statuses = {"accepted", "new", "partially_filled", "pending_new"}
    now_utc = datetime.now(_tz_co.utc)
    for o in open_orders:
        try:
            symbol = getattr(o, "symbol", "")
            if "/" not in symbol and not is_crypto(symbol):
                continue
            if o.status not in pending_statuses:
                continue
            submitted = getattr(o, "submitted_at", None) or getattr(o, "created_at", None)
            if submitted is None:
                continue
            if submitted.tzinfo is None:
                submitted = submitted.replace(tzinfo=_tz_co.utc)
            if now_utc - submitted > _td_co(minutes=3):
                alpaca.cancel_order(o.id)
                log_agent("system", "EXECUTOR", "Order timeout — cancelled after 3min pending")
        except Exception as e:
            log.warning("check_pending_crypto_order_timeouts: error on order %s: %s",
                        getattr(o, "id", "?"), e)


# ── Riley Coleman watch mode — stop-order-style entry trigger ────────────────

def _watch_mode_trigger_level(ticker: str, side: str):
    """
    Identify the structural level that must break to confirm a watched setup:
    - LONG:  trigger at the most recent 1-min swing HIGH — price must break
             ABOVE it (break above swing high = bullish structure confirmed).
    - SHORT: trigger at the most recent 1-min swing LOW  — price must break
             BELOW it (break below swing low = bearish structure confirmed).
    One tick beyond the level; caller fires when price >= trigger (LONG) or
    price <= trigger (SHORT).
    Returns the trigger price, or None if there isn't enough 1-min structure yet.
    """
    try:
        sym = alpaca_symbol(ticker)
        if is_crypto(ticker):
            bars = alpaca.get_crypto_bars(sym, "1Min", limit=15).df
        else:
            bars = alpaca.get_bars(sym, "1Min", limit=15, feed="iex").df

        highs  = bars["high"].tolist()
        lows   = bars["low"].tolist()
        closes = bars["close"].tolist()
        if len(highs) < 5:
            return None

        swing_highs, swing_lows = [], []
        for i in range(2, len(highs) - 2):
            if highs[i] > highs[i-1] and highs[i] > highs[i-2] and highs[i] > highs[i+1] and highs[i] > highs[i+2]:
                swing_highs.append(highs[i])
            if lows[i] < lows[i-1] and lows[i] < lows[i-2] and lows[i] < lows[i+1] and lows[i] < lows[i+2]:
                swing_lows.append(lows[i])

        tick = closes[-1] * 0.0001 if is_crypto(ticker) else 0.01
        if side == "LONG":
            # Enter long on break ABOVE the swing high — confirms bullish momentum
            if swing_highs:
                level = max(swing_highs)
                source = f"swing high (of {len(swing_highs)} detected)"
            else:
                level = max(highs[-5:])
                source = "recent 5-bar high (no swing high detected)"
            trigger = round(level + tick, 4)
            log_agent("system", "WATCH",
                f"{ticker} LONG trigger set ${trigger:.4f} — break ABOVE {source} "
                f"@ ${level:.4f}")
            return trigger
        else:
            # Enter short on break BELOW the swing low — confirms bearish momentum
            if swing_lows:
                level = min(swing_lows)
                source = f"swing low (of {len(swing_lows)} detected)"
            else:
                level = min(lows[-5:])
                source = "recent 5-bar low (no swing low detected)"
            trigger = round(level - tick, 4)
            log_agent("system", "WATCH",
                f"{ticker} SHORT trigger set ${trigger:.4f} — break BELOW {source} "
                f"@ ${level:.4f}")
            return trigger
    except Exception as e:
        log.warning("Watch mode trigger level failed %s: %s", ticker, e)
        return None


def execute_watch_mode_entry(ticker: str, side: str, trigger_level: float,
                             current_price: float, notify_fn=None,
                             confidence: int = 0) -> dict:
    """
    Fire the order for a watched setup once price has traded through its
    structural trigger level. Sizes with Riley's fixed-$-risk method (same as
    a normal scan_ticker entry) and stores the resulting stop/TP for management.
    `confidence` carries the confidence the ticker entered watch mode with, so
    the executed-trade record and Telegram reports show the actual % rather
    than a placeholder.
    """
    action  = "BUY" if side == "LONG" else "SELL"
    profile = get_profile(ticker)

    log_agent("system", "WATCH",
        f"Entry triggered: price broke ${trigger_level:.4f} — executing {ticker} {side}")

    levels = calculate_smart_levels(ticker, current_price, action, profile)
    if levels.get("skip"):
        log_agent("system", "WATCH",
            f"{ticker} entry skipped — {levels.get('reason')}")
        return {"status": "skipped", "reason": levels.get("reason")}

    result = place_order(
        ticker       = ticker,
        action       = action,
        size_pct     = 0,
        price        = current_price,
        order_type   = "MARKET",
        qty_override = levels.get("shares"),
    )

    if result.get("status") in ("placed", "simulated"):
        result["confidence"] = confidence
        result["direction"]  = "BULLISH" if action == "BUY" else "BEARISH"
        result["ticker"]     = ticker

        # Surface in scan reports (e.g. crypto status, /review) so watch mode
        # entries show their actual confidence % instead of a "?%" placeholder.
        try:
            _last = getattr(scan_all, "_last_results", None)
            if _last is not None:
                _last.setdefault("trades", []).append(result)
        except Exception:
            pass

        _position_adjustments[ticker] = {
            "stop_price":         levels["stop_price"],
            "initial_stop_price": levels["stop_price"],
            "tp_price":       levels["tp_price"],
            "classification": "DAY",
            "eod_action":     "CLOSE",
            "hold_period":    "intraday",
            "entry_time":     datetime.now().isoformat(),
            "position_side":  "short" if action == "SELL" else "long",
            "entry_price":    current_price,
            "peak_price":     current_price,
        }
        save_position_state(ticker, _position_adjustments[ticker])
        log_trade_history(
            symbol      = ticker,
            action      = action,
            qty         = float(result.get("qty", 0)),
            entry_price = current_price,
            confidence  = confidence,
            reasoning   = f"Watch mode entry — broke trigger ${trigger_level:.4f}",
            style       = profile["style"],
            stop_pct    = levels.get("stop_pct"),
        )
        log_agent("system", "WATCH",
            f"{ticker} levels set: Stop ${levels['stop_price']:.4f} | "
            f"TP ${levels['tp_price']:.4f} | {levels.get('shares','?')} sh | "
            f"risk ${levels.get('target_risk','?')}")

        if notify_fn:
            _icon = "🟢 LONG" if action == "BUY" else "🔴 SHORT"
            notify_fn(
                f"\U0001f441 *WATCH MODE ENTRY: {ticker}*\n"
                f"{_icon} @ ${current_price:.4f}\n"
                f"📊 Qty: {result.get('qty','?')} | Riley risk: ${levels.get('target_risk','?')}\n"
                f"🛑 Stop: ${levels['stop_price']:.4f} | ✅ TP: ${levels['tp_price']:.4f}\n"
                f"💡 Triggered on break of ${trigger_level:.4f}"
            )
    return result


# ── Position management ───────────────────────────────────────────────────────

def close_position(symbol: str, qty: float, reason: str,
                   notify_fn=None, entry: float = 0.0,
                   current: float = 0.0, pnl_pct: float = 0.0):
    import time
    MAX_RETRIES = 3

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            # Step 1: Cancel any pending orders for this symbol first
            try:
                open_orders = alpaca.list_orders(status="open")
                for o in open_orders:
                    if o.symbol == symbol:
                        alpaca.cancel_order(o.id)
                        log_agent("system", "EXECUTOR",
                            f"Cancelled pending order {o.id} for {symbol}")
                if any(o.symbol == symbol for o in open_orders):
                    time.sleep(1.0)  # wait for cancellations to process
            except Exception as e:
                log.warning("Order cancel failed %s: %s", symbol, e)

            # Step 2: Get actual qty from Alpaca (may differ from our records)
            try:
                pos = alpaca.get_position(symbol)
                actual_qty = abs(float(pos.qty))
                side = "sell" if float(pos.qty) > 0 else "buy"
            except Exception:
                log.warning("Position %s not found — already closed externally", symbol)
                # Bug 2 fix: position closed outside this function (e.g. Alpaca auto-close,
                # or closed between trailing-stop update and stop-hit check).
                # Still record the exit and send the notification using caller-supplied values.
                try:
                    _is_short = qty < 0
                    _pnl_usd_ext = (
                        ((entry - current) * abs(qty) if _is_short
                         else (current - entry) * abs(qty))
                        if entry > 0 and current > 0 else 0.0
                    )
                    close_trade_history(symbol, current, pnl_pct, _pnl_usd_ext, reason)
                    if notify_fn:
                        _emoji = "✅" if pnl_pct >= 0 else "❌"
                        _label = "🩳 SHORT" if _is_short else "📈 LONG"
                        notify_fn(
                            f"{_emoji} *Position Exited: {symbol}* ({_label})\n"
                            f"💰 P&L: {pnl_pct:+.2f}%"
                            f"{f' (${_pnl_usd_ext:+.2f})' if _pnl_usd_ext != 0 else ''}\n"
                            f"📌 Entry: ${entry:.4f} → Exit: ${current:.4f}\n"
                            f"💡 Reason: {reason}"
                        )
                    if pnl_pct < -1.0 and not any(
                            kw in reason.lower() for kw in
                            ("reviewer", "manual", "command", "telegram")):
                        agent_post_mortem(symbol, entry, current,
                                          pnl_pct, reason, notify_fn)
                except Exception as _e2:
                    log.warning("Exit notification failed for already-closed %s: %s",
                                symbol, _e2)
                return

            # Step 3: Submit market order for exact qty
            # Crypto requires "gtc" (good-till-cancelled); stocks use "day"
            _tif = "gtc" if ("/" in symbol or is_crypto(symbol)) else "day"
            alpaca.submit_order(
                symbol=symbol,
                qty=actual_qty,
                side=side,
                type="market",
                time_in_force=_tif,
            )
            log_agent("system", "EXECUTOR",
                f"Close order sent {symbol} qty={actual_qty} {side} "
                f"(attempt {attempt}) — {reason}")

            # Step 4: Verify closed — re-fetch position before next attempt
            time.sleep(2.0)
            try:
                still_open = alpaca.get_position(symbol)
                if still_open:
                    log.warning("Close verify failed %s attempt %d — retrying",
                                symbol, attempt)
                    if attempt < MAX_RETRIES:
                        # Re-fetch actual qty so next attempt uses current position size,
                        # preventing "insufficient qty" errors from partial fills.
                        try:
                            _recheck = alpaca.get_position(symbol)
                            actual_qty = abs(float(_recheck.qty))
                            side = "sell" if float(_recheck.qty) > 0 else "buy"
                        except Exception:
                            actual_qty = 0
                        if actual_qty == 0:
                            log.info("Position %s already closed on re-check", symbol)
                            break   # treat as success
                        time.sleep(1.0)
                        continue
                    else:
                        log.error("Close FAILED after %d attempts: %s", MAX_RETRIES, symbol)
                        if notify_fn:
                            notify_fn(f"⚠️ *Close Failed: {symbol}*\n"
                                     f"Still open after {MAX_RETRIES} attempts.\n"
                                     f"Please close manually on Alpaca.")
                        return
            except Exception:
                pass  # get_position throws = position gone = success

            # Confirmed closed
            log_agent("system", "EXECUTOR", f"Confirmed closed {symbol} — {reason}")

            # Bug 1 fix: P&L in USD must flip sign for short positions.
            # "sell" order = closing a long (profit when current > entry).
            # "buy" order  = closing a short (profit when current < entry).
            is_short_pos = (side == "buy")
            if is_short_pos:
                pnl_usd = (entry - current) * actual_qty if entry > 0 and current > 0 else 0.0
            else:
                pnl_usd = (current - entry) * actual_qty if entry > 0 and current > 0 else 0.0
            close_trade_history(symbol, current, pnl_pct, pnl_usd, reason)

            emoji      = "✅" if pnl_pct >= 0 else "❌"
            if is_crypto(symbol):
                side_label = "₿ SHORT" if is_short_pos else "₿ LONG"
            else:
                side_label = "🩳 SHORT" if is_short_pos else "📈 LONG"

            # Hold duration from stored entry_time
            _hold_str = ""
            try:
                _adj = _position_adjustments.get(symbol, {})
                _et_str = _adj.get("entry_time", "")
                if _et_str:
                    _entry_dt = datetime.fromisoformat(_et_str)
                    _held_sec = (datetime.now() - _entry_dt).total_seconds()
                    _hold_str = (
                        f"{int(_held_sec // 3600)}h {int((_held_sec % 3600) // 60)}m"
                        if _held_sec >= 3600
                        else f"{int(_held_sec // 60)}m"
                    )
            except Exception:
                pass

            if notify_fn:
                notify_fn(
                    f"{emoji} *Position Exited: {symbol}* ({side_label})\n"
                    f"💰 P&L: {pnl_pct:+.2f}%"
                    f"{f' (${pnl_usd:+.2f})' if pnl_usd != 0 else ''}\n"
                    f"📌 Entry: ${entry:.4f} → Exit: ${current:.4f}\n"
                    f"{f'⏱ Held: {_hold_str}' + chr(10) if _hold_str else ''}"
                    f"💡 Reason: {reason}"
                )

            # Only run post-mortem on genuine rule-triggered closes (stop hit, TP hit,
            # EOD close, etc.). Skip for position-reviewer-initiated closes, which
            # can be erroneous (action/reasoning mismatch), and for manual closes.
            _reviewer_close = any(kw in reason.lower() for kw in
                                  ("position reviewer", "reviewer", "claude review"))
            _manual_close   = any(kw in reason.lower() for kw in
                                  ("manual", "command", "telegram"))
            if not _reviewer_close and not _manual_close:
                agent_post_mortem(symbol, entry, current,
                                  pnl_pct, reason, notify_fn)
            return  # success

        except Exception as e:
            _err = str(e).lower()
            # Detect Alpaca errors that mean the position is already gone
            _already_gone = any(phrase in _err for phrase in (
                "insufficient qty",
                "qty available",
                "cannot be greater than",
                "position does not exist",
                "no shares to sell",
                "no position",
            ))
            if _already_gone:
                log.warning("Close %s: Alpaca says position already gone ('%s') — "
                            "treating as externally closed", symbol, e)
                try:
                    _is_short_ag = qty < 0
                    _pnl_usd_ag = (
                        ((entry - current) * abs(qty) if _is_short_ag
                         else (current - entry) * abs(qty))
                        if entry > 0 and current > 0 else 0.0
                    )
                    close_trade_history(symbol, current, pnl_pct, _pnl_usd_ag,
                                        reason + " (position already closed by Alpaca)")
                    if notify_fn:
                        _emoji_ag = "✅" if pnl_pct >= 0 else "❌"
                        if is_crypto(symbol):
                            _label_ag = "₿ SHORT" if _is_short_ag else "₿ LONG"
                        else:
                            _label_ag = "🩳 SHORT" if _is_short_ag else "📈 LONG"
                        notify_fn(
                            f"{_emoji_ag} *Position Exited: {symbol}* ({_label_ag})\n"
                            f"💰 P&L: {pnl_pct:+.2f}%"
                            f"{f' (${_pnl_usd_ag:+.2f})' if _pnl_usd_ag != 0 else ''}\n"
                            f"📌 Entry: ${entry:.4f} → Exit: ${current:.4f}\n"
                            f"💡 Reason: {reason}\n"
                            f"⚠️ Position was already closed by Alpaca before bot reached it"
                        )
                    if pnl_pct < -1.0 and not any(
                            kw in reason.lower() for kw in
                            ("reviewer", "manual", "command", "telegram")):
                        agent_post_mortem(symbol, entry, current,
                                          pnl_pct, reason, notify_fn)
                    log_agent("system", "EXECUTOR",
                        f"{symbol} already-closed detected via insufficient-qty error — "
                        f"state cleaned, P&L {pnl_pct:+.2f}%")
                except Exception as _ag_e:
                    log.warning("Already-gone exit handling failed %s: %s", symbol, _ag_e)
                return  # treat as success — position is gone
            log.error("Close error %s attempt %d: %s", symbol, attempt, e)
            if attempt < MAX_RETRIES:
                time.sleep(1.0)
            else:
                if notify_fn:
                    notify_fn(f"⚠️ *Close Error: {symbol}*\n{e}\n"
                             f"Please close manually.")

def agent_position_reviewer(symbol: str, entry: float, current: float,
                             pnl_pct: float, profile: dict,
                             effective_stop: float = None,
                             effective_tp: float = None) -> dict:
    """
    Claude reviews an open position: HOLD or CLOSE only.
    Stop/TP levels are managed exclusively by the trailing stop system.
    """
    style        = profile["style"]
    stop         = effective_stop if effective_stop is not None else profile["stop"]
    tp           = effective_tp   if effective_tp   is not None else profile["tp"]
    room_to_tp   = tp - pnl_pct
    room_to_stop = pnl_pct - stop

    prompt = f"""You manage a live position. Based ONLY on the numbers below, decide HOLD or CLOSE.
No chart or market data available — use only what is given here.

{symbol}: Entry ${entry:.4f} → Now ${current:.4f} | P&L {pnl_pct:+.2f}%
Stop buffer:  {room_to_stop:.1f}%  (P&L minus stop — negative = stop already exceeded)
TP remaining: {room_to_tp:.1f}%   (target minus P&L — negative = target already exceeded)

Rules — apply in order, use only the numbers above:
1. CLOSE if stop buffer ≤ 0          (stop hit or exceeded)
2. CLOSE if TP remaining ≤ 0         (target reached)
3. CLOSE if P&L < -2% AND stop buffer < 0.5%  (about to stop out, cut early)
4. HOLD in every other case — the trailing stop system handles all other exits

CRITICAL: Your action field MUST match your reasoning.
If your reasoning concludes no exit rules are triggered, your action MUST be HOLD.
Never return action=CLOSE if your own reasoning says to hold or that no rules fired.
When uncertain: always HOLD. Do NOT ask for more data.
Return ONLY valid JSON: {{"action": "HOLD", "reason": "brief reason stating which rule applied"}}"""

    try:
        resp = claude.messages.create(
            model=CLAUDE_HAIKU,
            max_tokens=120,
            messages=[{"role": "user", "content": prompt}],
        )
        result = extract_json(resp.content[0].text)
    except Exception as e:
        log.warning("Position reviewer failed %s — defaulting HOLD: %s", symbol, e)
        result = {"action": "HOLD", "reason": "reviewer unavailable — holding"}

    result.pop("new_stop_pct", None)
    result.pop("new_tp_pct",   None)

    # Consistency check: if action=CLOSE but reasoning says HOLD, default to HOLD.
    # The reasoning is more reliable than the action field when they conflict.
    action   = result.get("action", "HOLD")
    reasoning = (result.get("reason", "") or "").lower()
    _hold_keywords = ("hold", "no rules", "no exit", "rule 4", "rule4",
                      "not triggered", "trailing stop")
    if action == "CLOSE" and any(kw in reasoning for kw in _hold_keywords):
        log.warning(
            "Position reviewer contradiction on %s: action=CLOSE but reasoning='%s' "
            "— overriding to HOLD",
            symbol, result.get("reason", "")
        )
        result["action"] = "HOLD"
        result["reason"] = f"[override: contradictory response] {result.get('reason','')}"

    if result.get("action") not in ("HOLD", "CLOSE"):
        result["action"] = "HOLD"
    return result


# In-memory adjustment store — tracks per-position dynamic levels
# {symbol: {"stop_pct": float, "tp_pct": float}}
_position_adjustments: dict = load_position_states()  # persisted across restarts

# ── Session stop-loss cooldown ────────────────────────────────────────────────
# Tickers that hit a stop loss today — blocked from re-entry until next market open.
_session_stopped_tickers: set = set()
_session_date: str = ""

def _check_reset_session_cooldown():
    """Reset the stop-loss cooldown set when the calendar date changes (market open)."""
    global _session_date, _session_stopped_tickers
    import pytz as _ptz_cd
    today = datetime.now(_ptz_cd.timezone("America/New_York")).strftime("%Y-%m-%d")
    if today != _session_date:
        if _session_stopped_tickers:
            log_agent("system", "COOLDOWN",
                f"New session — clearing stop-loss cooldown: {sorted(_session_stopped_tickers)}")
        _session_date = today
        _session_stopped_tickers = set()

# ── Riley Coleman watch mode ──────────────────────────────────────────────────
# Tickers sitting in a 15-min zone with the 15-min trend aligned but no 1-min
# confirmation yet — watched for a bait/H&S reversal and a structural break
# before entering. Capped at 2 simultaneous tickers (Riley only watches a
# couple of setups at a time).
# {ticker: {side, zone_level, zone_strength, time_entered, candles_checked, trigger_level}}
_watch_mode: dict = {}
WATCH_MODE_MAX_TICKERS = 2

# Riley pre-market zones — computed once at 9:15am ET each trading day and
# cached for the full session. {ticker: [zone_dict, ...]}
# These take priority over regular find_sr_zones detection during the
# 9:30am-3:30pm Riley window (see find_sr_zones's premarket-priority merge).
_premarket_zones: dict = {}


def _psychological_levels(ticker: str, ref_price: float) -> list:
    """
    Riley psychological round-number levels near the reference price:
    nearest $1 increments for stocks under $100, $5 increments for $100-500,
    $50 increments for crypto.
    """
    if not ref_price or ref_price <= 0:
        return []
    if is_crypto(ticker):
        step = 50
    elif ref_price < 100:
        step = 1
    elif ref_price <= 500:
        step = 5
    else:
        step = 50

    base = round(ref_price / step) * step
    levels = []
    for mult in (-1, 0, 1):
        lvl = base + mult * step
        if lvl > 0:
            levels.append(round(lvl, 2))
    return levels


def compute_riley_premarket_zones(ticker: str) -> dict:
    """
    Riley pre-market zone identification (runs at 9:15am ET, weekdays).
    Identifies: previous day high/low, pre-market high/low, and psychological
    round numbers. Returns {"zones": [...], "summary": "..."} where each zone
    is shaped like a find_sr_zones zone entry, tagged recency="premarket_priority"
    so it takes precedence over regular zone detection during the 9:30am-3:30pm window.
    """
    try:
        import pytz as _ptz_pmz
        from datetime import timezone as _tz_pmz, timedelta as _td_pmz
        ET_pmz = _ptz_pmz.timezone("America/New_York")
        sym    = alpaca_symbol(ticker)
        now_et = datetime.now(ET_pmz)
        today  = now_et.date()

        # Previous trading day's high/low — daily bars
        prev_high = prev_low = None
        try:
            if is_crypto(ticker):
                day_bars = alpaca.get_crypto_bars(sym, "1Day", limit=5).df
            else:
                day_bars = alpaca.get_bars(ticker, "1Day", limit=5, feed="iex").df
            if not day_bars.empty:
                def _d_et(ts):
                    return ts.astimezone(ET_pmz) if ts.tzinfo else ET_pmz.localize(
                        ts.to_pydatetime() if hasattr(ts, "to_pydatetime") else ts)
                day_dates = [_d_et(t).date() for t in day_bars.index.tolist()]
                prior_idxs = [i for i, d in enumerate(day_dates) if d < today]
                if prior_idxs:
                    i = prior_idxs[-1]
                    prev_high = float(day_bars["high"].iloc[i])
                    prev_low  = float(day_bars["low"].iloc[i])
        except Exception:
            pass

        # Pre-market high/low — today's bars before 9:30am ET
        pm_high = pm_low = None
        try:
            pm_start = (datetime.now(_tz_pmz.utc) - _td_pmz(hours=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
            if is_crypto(ticker):
                pm_bars = alpaca.get_crypto_bars(sym, "5Min", start=pm_start, limit=200).df
            else:
                pm_bars = alpaca.get_bars(ticker, "5Min", start=pm_start, limit=200, feed="iex").df
            if not pm_bars.empty:
                def _pm_et(ts):
                    return ts.astimezone(ET_pmz) if ts.tzinfo else ET_pmz.localize(
                        ts.to_pydatetime() if hasattr(ts, "to_pydatetime") else ts)
                pm_idxs = [i for i, t in enumerate(pm_bars.index.tolist())
                           if _pm_et(t).date() == today and
                           (_pm_et(t).hour < 9 or (_pm_et(t).hour == 9 and _pm_et(t).minute < 30))]
                if pm_idxs:
                    pm_h = pm_bars["high"].tolist()
                    pm_l = pm_bars["low"].tolist()
                    pm_high = max(pm_h[i] for i in pm_idxs)
                    pm_low  = min(pm_l[i] for i in pm_idxs)
        except Exception:
            pass

        ref_price = pm_high or prev_high
        if not ref_price:
            try:
                ref_price = get_price(ticker)
            except Exception:
                ref_price = None

        psych_levels = _psychological_levels(ticker, ref_price) if ref_price else []

        zones, labels = [], []

        def _add(level_type, lvl, zone_kind, strength):
            if lvl is None:
                return
            zones.append({
                "type":        zone_kind,
                "top":         round(lvl * 1.001, 4),
                "bottom":      round(lvl * 0.999, 4),
                "mid":         round(lvl, 4),
                "touches":     2,
                "strong_move": False,
                "strength":    strength,
                "recency":     "premarket_priority",
                "label":       level_type,
            })
            labels.append(f"{level_type} ${lvl:.2f}")

        _add("PREV_DAY_HIGH",  prev_high, "RESISTANCE",  85)
        _add("PREV_DAY_LOW",   prev_low,  "SUPPORT",     85)
        _add("PREMARKET_HIGH", pm_high,   "RESISTANCE",  85)
        _add("PREMARKET_LOW",  pm_low,    "SUPPORT",     85)
        for lvl in psych_levels:
            zone_kind = "RESISTANCE" if (ref_price and lvl > ref_price) else "SUPPORT"
            _add("PSYCH_LEVEL", lvl, zone_kind, 60)

        return {"zones": zones, "summary": ", ".join(labels) if labels else "none found"}
    except Exception as e:
        log.warning("compute_riley_premarket_zones failed %s: %s", ticker, e)
        return {"zones": [], "summary": "error"}


def job_riley_premarket_zones(watchlist: list) -> None:
    """
    Riley 9:15am ET pre-market zone identification job. Computes and caches
    previous-day high/low, pre-market high/low, and psychological round-number
    levels for each ticker — these take priority over regular zone detection
    during the 9:30am-3:30pm Riley window.
    """
    global _premarket_zones
    _premarket_zones = {}
    for ticker in watchlist:
        result = compute_riley_premarket_zones(ticker)
        if result["zones"]:
            _premarket_zones[ticker] = result["zones"]
        log_agent("system", "RILEY", f"Riley premarket zones: {ticker} — {result['summary']}")

# Zone cache for dashboard — updated every scan, served via /api/zones
# {ticker: {zones, riley_result, confidence, direction, timestamp, ...}}
_last_zones: dict = {}

# Pre-seed VIX regime DB entry if missing — prevents false alerts on first scan
try:
    _con = sqlite3.connect(LESSONS_DB)
    _existing = _con.execute(
        "SELECT hold_period FROM position_state WHERE symbol='__VIX_REGIME__'"
    ).fetchone()
    if not _existing:
        _con.execute(
            "INSERT INTO position_state (symbol, hold_period, updated_at) VALUES (?,?,?)",
            ('__VIX_REGIME__', 'CALM', datetime.now().isoformat())
        )
        _con.commit()
    _con.close()
except Exception as _e:
    pass


def get_effective_levels(symbol: str, profile: dict,
                         entry_price: float = 0.0) -> tuple[float, float]:
    """
    Get effective stop/TP as PERCENTAGES from entry.
    If price levels stored, convert back to % using entry_price.
    Falls back to profile % if no adjustment stored.
    """
    adj = _position_adjustments.get(symbol, {})

    # Price level mode (new system)
    if "stop_price" in adj and entry_price > 0:
        stop_price = adj["stop_price"]
        tp_price   = adj["tp_price"]
        stop_pct   = (stop_price - entry_price) / entry_price * 100
        tp_pct     = (tp_price   - entry_price) / entry_price * 100
        return round(stop_pct, 2), round(tp_pct, 2)

    # Legacy % mode
    stop = adj.get("stop_pct", profile["stop"])
    tp   = adj.get("tp_pct",   profile["tp"])
    return stop, tp


def get_effective_price_levels(symbol: str, profile: dict,
                                entry_price: float) -> tuple[float, float]:
    """
    Get effective stop/TP as PRICE LEVELS.
    Returns (stop_price, tp_price).
    Direction-aware fallback: reads position_side from _position_adjustments
    so short positions get stop ABOVE entry and TP BELOW entry.
    """
    adj = _position_adjustments.get(symbol, {})
    if "stop_price" in adj:
        return adj["stop_price"], adj["tp_price"]
    # Direction-aware fallback
    is_short = adj.get("position_side", "long") == "short"
    if is_short:
        stop_price = entry_price * (1 - profile["stop"] / 100)  # above entry
        tp_price   = entry_price * (1 - profile["tp"]   / 100)  # below entry
    else:
        stop_price = entry_price * (1 + profile["stop"] / 100)  # below entry
        tp_price   = entry_price * (1 + profile["tp"]   / 100)  # above entry
    return round(stop_price, 4), round(tp_price, 4)


def _check_sr_strength_against_position(symbol: str, position_side: str,
                                          current_price: float) -> str:
    """
    Riley Coleman rule: if price shows strength AGAINST the position right at a
    major S/R level, exit immediately rather than waiting for the stop to be hit.
    Returns a close reason string when this fires, otherwise "".
    """
    try:
        zones = find_sr_zones(symbol, current_price)
        major = [z for z in zones.get("zones", [])
                 if z.get("strength", 0) >= 70
                 and current_price > 0
                 and abs(z.get("price", z.get("mid", current_price)) - current_price)
                     / current_price <= 0.0035]
        if not major:
            return ""

        sym_alp = alpaca_symbol(symbol)
        if is_crypto(symbol):
            bars = alpaca.get_crypto_bars(sym_alp, "1Min", limit=3).df
        else:
            bars = alpaca.get_bars(sym_alp, "1Min", limit=3, feed="iex").df
        if bars.empty:
            return ""

        o = float(bars["open"].iloc[-1]); c = float(bars["close"].iloc[-1])
        h = float(bars["high"].iloc[-1]); l = float(bars["low"].iloc[-1])
        rng = h - l
        if rng <= 0:
            return ""
        body = abs(c - o)

        strong_against = (
            (position_side == "long"  and c < o and body / rng >= 0.6) or
            (position_side == "short" and c > o and body / rng >= 0.6)
        )
        if strong_against:
            zone = min(major, key=lambda z: abs(z.get("price", z.get("mid", current_price)) - current_price))
            zone_price = zone.get("price", zone.get("mid", current_price))
            return (f"Strong {'bearish' if position_side == 'long' else 'bullish'} "
                    f"1-min candle against {position_side} at {zone['type']} "
                    f"zone ${zone_price:.4f} (str={zone.get('strength', 0)})")
        return ""
    except Exception as e:
        log.warning("S/R strength-against check failed %s: %s", symbol, e)
        return ""


def _riley_confirmed_swing_level(highs: list, lows: list, is_long: bool):
    """
    Most recent 1-min swing low (longs) / swing high (shorts) "confirmed" by
    a later swing high (longs) / swing low (shorts) that exceeds everything
    seen before that swing formed — i.e. the trend structure continued after
    the pullback. Returns None if nothing is confirmed yet.
    """
    n = len(highs)
    swing_high_idx = [i for i in range(2, n - 2)
                       if highs[i] > highs[i-1] and highs[i] > highs[i-2]
                       and highs[i] > highs[i+1] and highs[i] > highs[i+2]]
    swing_low_idx = [i for i in range(2, n - 2)
                      if lows[i] < lows[i-1] and lows[i] < lows[i-2]
                      and lows[i] < lows[i+1] and lows[i] < lows[i+2]]

    if is_long:
        extreme_idx, confirm_idx = swing_low_idx, swing_high_idx
        extreme_vals, confirm_vals = lows, highs
        better, best = (lambda a, b: a > b), max
    else:
        extreme_idx, confirm_idx = swing_high_idx, swing_low_idx
        extreme_vals, confirm_vals = highs, lows
        better, best = (lambda a, b: a < b), min

    confirmed_level = None
    last_idx  = None
    baseline  = None
    confirmed = False
    for i in range(n):
        if i in extreme_idx:
            last_idx  = i
            baseline  = best(confirm_vals[:i]) if i > 0 else confirm_vals[0]
            confirmed = False
        if (i in confirm_idx and last_idx is not None and not confirmed
                and baseline is not None and better(confirm_vals[i], baseline)):
            confirmed = True
        if last_idx is not None and confirmed:
            confirmed_level = extreme_vals[last_idx]

    return confirmed_level


def update_trailing_stop(symbol: str, pnl_pct: float,
                          profile: dict, notify_fn=None,
                          entry_price: float = 0.0, current_price: float = 0.0):
    """
    Riley Coleman fluid exit management.

    1R is the ORIGINAL stop distance (entry_price <-> initial_stop_price),
    fixed for the life of the trade — it never shifts once breakeven/trailing
    moves stop_price. Before 1R, only the hard stop loss applies (handled by
    the caller) — nothing here fires.

    From 1R on, every check:
      - Market health: if the last 3 of the last 10 1-min candle ranges are
        each > 2x the 10-candle average range, the move is PARABOLIC,
        otherwise HEALTHY.
      - HEALTHY: trail behind the most recent CONFIRMED 1-min swing low
        (longs) / swing high (shorts) — confirmed by a later swing high/low
        that shows the trend continued.
      - PARABOLIC: trail behind the last 1-min candle's low (longs) / high
        (shorts).
      - A buffer of 10% of the 1-min ATR(14) is placed beyond the structural
        level. The stop only ever moves favorably, never backward.
      - Double top/bottom (last two swings within 0.1%) nudges the stop to
        breakeven if that's not a backward move.
      - At 2R, trailing is forced PARABOLIC regardless of market health.
      - At 3R, the take-profit target moves to the 3R level and the trail
        tightens to one tick behind the last 1-min candle extreme.
      - 50% pullback rule: if a 1-min candle's BODY (open AND close, not
        wicks) closes entirely beyond the 50% retracement of the
        entry-to-peak move, the position is closed immediately.
    """
    if entry_price <= 0 or current_price <= 0:
        return

    if symbol not in _position_adjustments:
        _position_adjustments[symbol] = {}
    adj = _position_adjustments[symbol]

    position_side = adj.get("position_side", "long")
    is_long = position_side == "long"

    if "stop_price" in adj:
        current_stop_price = adj["stop_price"]
    elif is_long:
        current_stop_price = round(entry_price * (1 + profile["stop"] / 100), 4)
    else:
        current_stop_price = round(entry_price * (1 - profile["stop"] / 100), 4)

    # 1R = distance from entry to the ORIGINAL stop — fixed for the trade's
    # life so 1R/2R/3R math doesn't shift once breakeven/trailing moves
    # stop_price. Falls back to the profile's stop % for in-flight positions
    # opened before this field existed.
    initial_stop = adj.get("initial_stop_price")
    if initial_stop is None:
        if is_long:
            initial_stop = round(entry_price * (1 + profile["stop"] / 100), 4)
        else:
            initial_stop = round(entry_price * (1 - profile["stop"] / 100), 4)
        adj["initial_stop_price"] = initial_stop
    one_r = abs(entry_price - initial_stop)
    if one_r <= 0:
        return

    pnl_per_share = (current_price - entry_price) if is_long else (entry_price - current_price)

    # ── Item 1: before 1R, only the hard stop loss applies ────────────────
    if pnl_per_share < one_r:
        return

    # Track the highest (longs) / lowest (shorts) price reached since entry
    peak_close = adj.get("peak_close", entry_price)
    peak_close = max(peak_close, current_price) if is_long else min(peak_close, current_price)
    adj["peak_close"] = peak_close

    # ── Pull 1-min bars for ATR / swing / market-health analysis ──────────
    try:
        sym_alp = alpaca_symbol(symbol)
        if is_crypto(symbol):
            bars = alpaca.get_crypto_bars(sym_alp, "1Min", limit=50).df
        else:
            bars = alpaca.get_bars(sym_alp, "1Min", limit=50, feed="iex").df
        if bars.empty or len(bars) < 11:
            return
    except Exception as e:
        log.warning("Riley trail bar fetch failed %s: %s", symbol, e)
        return

    highs  = bars["high"].tolist()
    lows   = bars["low"].tolist()
    opens  = bars["open"].tolist()
    closes = bars["close"].tolist()

    # ── ATR(14): average range of the last 14 1-min candles ───────────────
    atr_n = min(14, len(highs))
    atr = sum(highs[i] - lows[i] for i in range(-atr_n, 0)) / atr_n

    # ── Baseline ATR(50) — used by the no-confirmed-swing fallback trail ──
    baseline_n   = min(50, len(highs))
    baseline_atr = sum(highs[i] - lows[i] for i in range(-baseline_n, 0)) / baseline_n

    # ── Item 3: market health — last 3 ranges vs 2x the 10-candle average ──
    avg_n = min(10, len(highs))
    avg_range = sum(highs[i] - lows[i] for i in range(-avg_n, 0)) / avg_n
    last3_ranges = [highs[i] - lows[i] for i in range(-3, 0)]
    parabolic = avg_range > 0 and all(r > 2 * avg_range for r in last3_ranges)

    # ── R-multiple levels off the fixed 1R ─────────────────────────────────
    two_r_level   = entry_price + 2 * one_r if is_long else entry_price - 2 * one_r
    three_r_level = entry_price + 3 * one_r if is_long else entry_price - 3 * one_r
    reached_2r = (current_price >= two_r_level)   if is_long else (current_price <= two_r_level)
    reached_3r = (current_price >= three_r_level) if is_long else (current_price <= three_r_level)

    if reached_2r and not adj.get("two_r_logged"):
        adj["two_r_logged"] = True
        log_agent("system", "RILEY", f"{symbol} 2R reached — switching to aggressive trail")

    if reached_3r and not adj.get("three_r_logged"):
        adj["three_r_logged"] = True
        adj["tp_price"] = round(three_r_level, 4)
        save_position_state(symbol, adj)
        log_agent("system", "RILEY",
            f"{symbol} 3R target reached — locking in gains aggressively "
            f"(TP set to ${three_r_level:.4f})")

    # ── Item 10: 50% pullback rule — full candle BODY beyond the 50% level ──
    peak_move = (peak_close - entry_price) if is_long else (entry_price - peak_close)
    if peak_move > 0:
        retrace_50  = (entry_price + peak_close) / 2
        body_top    = max(opens[-1], closes[-1])
        body_bottom = min(opens[-1], closes[-1])
        violated = (body_top < retrace_50) if is_long else (body_bottom > retrace_50)
        if violated:
            log_agent("system", "RILEY",
                f"{symbol} Aggressive 50% violation — exiting "
                f"(entry ${entry_price:.4f} peak ${peak_close:.4f} "
                f"50% level ${retrace_50:.4f}, candle body "
                f"${body_bottom:.4f}-${body_top:.4f})")
            try:
                pos = alpaca.get_position(symbol)
                qty = abs(float(pos.qty))
                close_position(symbol, qty,
                    f"Aggressive 50% violation — 1-min candle body closed "
                    f"beyond 50% retracement (${retrace_50:.4f})",
                    notify_fn, entry_price, current_price, pnl_pct)
            except Exception as e:
                log.warning("Riley 50%% violation close failed %s: %s", symbol, e)
            _position_adjustments.pop(symbol, None)
            clear_position_state(symbol)
            return

    # ── Item 7: double top/bottom — last 2 swings within 0.1% → breakeven ──
    n = len(highs)
    swing_high_idx = [i for i in range(2, n - 2)
                       if highs[i] > highs[i-1] and highs[i] > highs[i-2]
                       and highs[i] > highs[i+1] and highs[i] > highs[i+2]]
    swing_low_idx = [i for i in range(2, n - 2)
                      if lows[i] < lows[i-1] and lows[i] < lows[i-2]
                      and lows[i] < lows[i+1] and lows[i] < lows[i+2]]

    double_pattern = False
    if is_long and len(swing_high_idx) >= 2:
        h1, h2 = highs[swing_high_idx[-2]], highs[swing_high_idx[-1]]
        double_pattern = h1 > 0 and abs(h1 - h2) / h1 < 0.001
    elif not is_long and len(swing_low_idx) >= 2:
        l1, l2 = lows[swing_low_idx[-2]], lows[swing_low_idx[-1]]
        double_pattern = l1 > 0 and abs(l1 - l2) / l1 < 0.001

    if double_pattern and not adj.get("double_top_bottom_logged"):
        adj["double_top_bottom_logged"] = True
        be_stop = round(entry_price * 1.0001, 4) if is_long else round(entry_price * 0.9999, 4)
        be_is_favorable = (be_stop > current_stop_price) if is_long else (be_stop < current_stop_price)
        if be_is_favorable:
            adj["stop_price"]          = be_stop
            adj["breakeven_triggered"] = True
            current_stop_price = be_stop
            save_position_state(symbol, adj)
        log_agent("system", "RILEY",
            f"{symbol} Double top/bottom detected — stop moved to breakeven (${be_stop:.4f})")

    # ── Items 4-6, 8-9: structural trail level + buffer ────────────────────
    force_parabolic = parabolic or reached_2r
    tick = current_price * 0.0001 if is_crypto(symbol) else 0.01

    if reached_3r:
        # Item 9: tightest trail — one tick behind the last 1-min extreme
        structural_level = lows[-1] if is_long else highs[-1]
        buffer = tick
        mode_label = "3R-AGGRESSIVE"
        source = "last 1-min candle " + ("low" if is_long else "high")
    elif force_parabolic:
        # Items 5/8: last 1-min candle extreme, every check
        structural_level = lows[-1] if is_long else highs[-1]
        buffer = atr * 0.10
        mode_label = "PARABOLIC"
        source = "last 1-min candle " + ("low" if is_long else "high")
    else:
        # Item 4: most recent CONFIRMED 1-min swing low/high
        structural_level = _riley_confirmed_swing_level(highs, lows, is_long)
        buffer = atr * 0.10
        mode_label = "HEALTHY"
        source = "confirmed 1-min swing " + ("low" if is_long else "high")

        if structural_level is None:
            # Fallback: no confirmed swing yet — trail behind an
            # ATR-adaptive N-candle lookback until one forms. Higher
            # volatility (vs the 50-candle baseline) -> shorter lookback (5);
            # lower volatility -> longer lookback (10); interpolate between.
            atr_ratio = (atr / baseline_atr) if baseline_atr > 0 else 1.0
            if atr_ratio >= 1.5:
                lookback_n = 5
            elif atr_ratio <= 0.7:
                lookback_n = 10
            else:
                lookback_n = 10 - (atr_ratio - 0.7) / 0.8 * 5
            lookback_n = max(1, min(int(round(lookback_n)), len(highs)))

            structural_level = min(lows[-lookback_n:]) if is_long else max(highs[-lookback_n:])
            mode_label = "HEALTHY-FALLBACK"
            source = f"last {lookback_n} 1-min candle " + ("low" if is_long else "high")
            log_agent("system", "TRAIL",
                f"{symbol} [TRAIL] FALLBACK: no confirmed swing yet — trailing "
                f"behind last {lookback_n} candles (ATR ratio {atr_ratio:.2f})")

    new_stop = round(structural_level - buffer, 4) if is_long \
               else round(structural_level + buffer, 4)
    moved_favorably = (new_stop > current_stop_price) if is_long \
                      else (new_stop < current_stop_price)
    if not moved_favorably:
        return  # never move the stop backward

    adj["stop_price"] = new_stop
    save_position_state(symbol, adj)  # persist across restarts

    old_pct = (current_stop_price - entry_price) / entry_price * 100
    new_pct = (new_stop           - entry_price) / entry_price * 100

    log_agent("system", "TRAIL",
        f"{symbol} Riley {mode_label} trail: ${current_stop_price:.4f} ({old_pct:+.1f}%) "
        f"→ ${new_stop:.4f} ({new_pct:+.1f}%) — behind {source} "
        f"${structural_level:.4f} (buffer ${buffer:.4f})")

    if notify_fn:
        notify_fn(
            f"📌 *Trailing Stop: {symbol}*\n"
            f"📈 P&L: {pnl_pct:+.1f}% @ ${current_price:.4f}\n"
            f"🛡 Stop: ${current_stop_price:.4f} → ${new_stop:.4f} "
            f"({new_pct:+.1f}%)\n"
            f"{'✅ Profit locked in!' if new_pct > 0 else '📉 Breakeven protected'}"
        )


def apply_adjustment(symbol: str, new_stop: float | None,
                     new_tp: float | None, notify_fn=None):
    """Store a dynamic adjustment and notify via Telegram."""
    if symbol not in _position_adjustments:
        _position_adjustments[symbol] = {}

    changes = []
    if new_stop is not None:
        _position_adjustments[symbol]["stop_pct"] = new_stop
        changes.append(f"Stop loss → {new_stop:.1f}%")
    if new_tp is not None:
        _position_adjustments[symbol]["tp_pct"] = new_tp
        changes.append(f"Take profit → +{new_tp:.1f}%")

    if changes:
        summary = " | ".join(changes)
        log_agent("claude", "CLAUDE", f"Adjusted {symbol}: {summary}")
        if notify_fn:
            notify_fn(
                f"⚙️ *Levels Adjusted: {symbol}*\n"
                + "\n".join(f"  • {c}" for c in changes)
            )


def manage_positions(notify_fn=None):
    # Portfolio delta check every cycle
    try:
        eq    = get_portfolio_equity()
        delta = calculate_portfolio_delta(eq)
        log_agent("system", "DELTA",
            f"Portfolio delta: {delta['net_delta_pct']:+.2f}% per 1% SPY move | "
            f"Long ${delta['long_delta_usd']:,.0f} | Short ${delta['short_delta_usd']:,.0f}")
        if delta["overexposed"] and notify_fn:
            notify_fn(delta["alert"])
    except Exception as e:
        log.warning("Delta check failed: %s", e)

    try:
        positions = alpaca.list_positions()
    except Exception as e:
        log.error("Fetch positions failed: %s", e)
        return

    # ── Position reconciliation ───────────────────────────────────────────────
    # Compare _position_adjustments (what the bot thinks is open) against the
    # actual live Alpaca positions.  Any symbol the bot tracks but Alpaca no
    # longer shows was closed externally — GTC order filled overnight, trailing
    # stop on Alpaca's side fired, margin call, or manual close on the platform.
    _alpaca_syms = {p.symbol for p in positions}
    for _ext_sym in list(_position_adjustments.keys()):
        if _ext_sym.startswith("__"):
            continue  # skip internal sentinel keys e.g. __VIX_REGIME__
        # Check both raw ticker form (BTCUSD) and Alpaca slash form (BTC/USD)
        _alt_sym = alpaca_symbol(_ext_sym) if is_crypto(_ext_sym) else _ext_sym
        if _ext_sym in _alpaca_syms or _alt_sym in _alpaca_syms:
            continue  # still showing as open in Alpaca — nothing to do

        # ── Externally closed ────────────────────────────────────────────────
        _ext_adj = _position_adjustments[_ext_sym]
        log.warning("RECONCILE: %s is tracked by bot but NOT in Alpaca positions — "
                    "was closed externally (GTC fill, overnight stop, or manual close)",
                    _ext_sym)

        # Recover entry price and side from trade_history
        _ext_entry  = 0.0
        _ext_qty    = 0.0
        _ext_action = "BUY"
        try:
            _con = sqlite3.connect(LESSONS_DB)
            _row = _con.execute(
                "SELECT entry_price, qty, action FROM trade_history "
                "WHERE symbol=? AND status='open' ORDER BY id DESC LIMIT 1",
                (_ext_sym,)
            ).fetchone()
            _con.close()
            if _row:
                _ext_entry  = float(_row[0] or 0)
                _ext_qty    = float(_row[1] or 0)
                _ext_action = _row[2] or "BUY"
        except Exception as _db_e:
            log.warning("Reconcile: could not read trade_history for %s: %s",
                        _ext_sym, _db_e)

        # Get the last known market price for P&L estimate
        _ext_price = 0.0
        try:
            _ext_price = get_price(_ext_sym)
        except Exception:
            pass

        # Calculate estimated P&L
        _ext_is_short = (_ext_action == "SELL" or
                         _ext_adj.get("position_side") == "short")
        _ext_pnl_pct = 0.0
        _ext_pnl_usd = 0.0
        if _ext_entry > 0 and _ext_price > 0:
            if _ext_is_short:
                _ext_pnl_pct = (_ext_entry - _ext_price) / _ext_entry * 100
                _ext_pnl_usd = (_ext_entry - _ext_price) * abs(_ext_qty)
            else:
                _ext_pnl_pct = (_ext_price - _ext_entry) / _ext_entry * 100
                _ext_pnl_usd = (_ext_price - _ext_entry) * abs(_ext_qty)

        _ext_reason = ("Externally closed by Alpaca "
                       "(GTC order filled, overnight stop fired, or manual close)")
        try:
            close_trade_history(_ext_sym, _ext_price or _ext_entry,
                                _ext_pnl_pct, _ext_pnl_usd, _ext_reason)
        except Exception as _hist_e:
            log.warning("Reconcile: failed to record close history for %s: %s",
                        _ext_sym, _hist_e)

        if notify_fn:
            try:
                _ext_emoji = "✅" if _ext_pnl_pct >= 0 else "❌"
                if is_crypto(_ext_sym):
                    _ext_label = "₿ SHORT" if _ext_is_short else "₿ LONG"
                else:
                    _ext_label = "🩳 SHORT" if _ext_is_short else "📈 LONG"
                notify_fn(
                    f"{_ext_emoji} *Externally Closed: {_ext_sym}* ({_ext_label})\n"
                    f"💰 Est. P&L: {_ext_pnl_pct:+.2f}%"
                    f"{f' (${_ext_pnl_usd:+.2f})' if _ext_pnl_usd != 0 else ''}\n"
                    f"📌 Entry: ${_ext_entry:.4f} → Last price: ${_ext_price:.4f}\n"
                    f"⚠️ Closed externally — GTC order, overnight stop, or manual close\n"
                    f"🔄 Bot state synced automatically"
                )
            except Exception as _ntfy_e:
                log.warning("Reconcile notification failed for %s: %s",
                            _ext_sym, _ntfy_e)

        _position_adjustments.pop(_ext_sym, None)
        clear_position_state(_ext_sym)
        log_agent("system", "RECONCILE",
            f"{_ext_sym} externally closed — state cleaned | "
            f"entry ${_ext_entry:.4f} last ${_ext_price:.4f} "
            f"est P&L {_ext_pnl_pct:+.2f}%")

        # Both wins and losses go through agent_post_mortem.
        # For wins, the shortcut inside agent_post_mortem saves a success pattern
        # directly (GTC exit / trailing stop profit) without calling Claude.
        if abs(_ext_pnl_pct) >= 1.0:
            try:
                agent_post_mortem(_ext_sym, _ext_entry, _ext_price,
                                  _ext_pnl_pct, _ext_reason, notify_fn)
            except Exception:
                pass

    if not positions:
        return

    log_agent("system", "MANAGER", f"Reviewing {len(positions)} position(s)...")

    # ── Overnight hard floor: close any position held overnight that is at or
    # below its profile stop at market open (gap-down protection).
    # Checked only during the first 10 minutes after open (9:30-9:40 ET).
    import pytz as _ptz
    _et_now = datetime.now(_ptz.timezone("America/New_York"))
    _is_open_window = (
        _et_now.weekday() < 5 and
        _et_now.hour == 9 and 30 <= _et_now.minute < 40
    )

    for p in positions:
        sym     = p.symbol
        qty     = float(p.qty)
        entry   = float(p.avg_entry_price)
        current = float(p.current_price)
        pnl_pct = float(p.unrealized_plpc) * 100

        # Profile lookup — handle BTC/USD → BTCUSD
        profile_key = sym.replace("/", "") + "USD" if "/" in sym else sym
        profile = get_profile(profile_key)

        # ── Overnight hard floor ──────────────────────────────────────────────
        # If market just opened AND position was held overnight AND P&L is at or
        # below the profile hard stop, close it before it gets worse.
        if _is_open_window and not is_crypto(sym):
            adj = _position_adjustments.get(sym, {})
            entry_time_str = adj.get("entry_time", "")
            _held_overnight = False
            if entry_time_str:
                try:
                    _entry_dt = datetime.fromisoformat(entry_time_str)
                    _today_open = _et_now.replace(
                        hour=9, minute=30, second=0, microsecond=0)
                    if _entry_dt.tzinfo is None:
                        _entry_dt = _ptz.timezone("America/New_York").localize(_entry_dt)
                    _held_overnight = _entry_dt < _today_open.astimezone(
                        _ptz.timezone("America/New_York"))
                except Exception:
                    pass
            if _held_overnight and pnl_pct <= profile["stop"]:
                log_agent("risk", "RISK",
                    f"OVERNIGHT HARD FLOOR: {sym} @ ${current:.4f} "
                    f"({pnl_pct:+.2f}% ≤ floor {profile['stop']:+.1f}%) — closing at open")
                if notify_fn:
                    notify_fn(
                        f"🚨 *Overnight Floor: {sym}*\n"
                        f"📉 Opened at {pnl_pct:+.2f}% (floor: {profile['stop']:+.1f}%)\n"
                        f"💡 Closing immediately at open to limit gap-down loss"
                    )
                close_position(sym, qty,
                    f"Overnight hard floor hit at open ({pnl_pct:+.2f}%, floor {profile['stop']:+.1f}%)",
                    notify_fn, entry, current, pnl_pct)
                _position_adjustments.pop(sym, None)
                clear_position_state(sym)
                continue

        # Get effective price levels
        stop_price, tp_price = get_effective_price_levels(sym, profile, entry)
        stop_pct, tp_pct     = get_effective_levels(sym, profile, entry)

        # Detect short position
        position_side = "short" if float(p.qty) < 0 else "long"

        log_agent("system", "MANAGER",
            f"{sym} [{position_side.upper()}] P&L: {pnl_pct:+.2f}% | "
            f"Stop: ${stop_price:.4f} ({stop_pct:+.1f}%) | "
            f"TP: ${tp_price:.4f} ({tp_pct:+.1f}%) | "
            f"Style: {profile['style']}")

        # ── Break-even stop management (Riley style) ─────────────────────────
        # Move stop to entry once pnl reaches initial risk amount (1:1 R:R)
        # This takes all risk off the table early
        adj = _position_adjustments.get(sym, {})
        initial_stop = adj.get("stop_price", stop_price)
        initial_risk_pct = abs((initial_stop - entry) / entry * 100) if entry > 0 else 2.0
        breakeven_triggered = adj.get("breakeven_triggered", False)

        if not breakeven_triggered and pnl_pct >= initial_risk_pct:
            # Move stop to entry (break-even)
            be_stop = round(entry * 1.0001, 4) if position_side == "long"                       else round(entry * 0.9999, 4)
            if sym not in _position_adjustments:
                _position_adjustments[sym] = {}
            _position_adjustments[sym]["stop_price"]           = be_stop
            _position_adjustments[sym]["breakeven_triggered"]  = True
            save_position_state(sym, _position_adjustments[sym])
            be_pnl = (be_stop - entry) / entry * 100
            log_agent("system", "RILEY",
                f"{sym} Breakeven activated at 1R: stop moved to ${be_stop:.4f} "
                f"({be_pnl:+.2f}%) — risk free at {pnl_pct:+.1f}% profit")
            if notify_fn:
                notify_fn(
                    f"\U0001f512 *Break-Even: {sym}*\n"
                    f"\U0001f4c8 P&L: {pnl_pct:+.1f}% \u2014 stop moved to entry\n"
                    f"\u2705 Trade is now risk-free"
                )
            stop_price = be_stop
            stop_pct   = be_pnl

        # Continue trailing once past break-even (Riley 1-min trail — both sides)
        update_trailing_stop(sym, pnl_pct, profile, notify_fn,
                             entry_price=entry, current_price=current)
        # Refresh after potential trail update
        stop_price, tp_price = get_effective_price_levels(sym, profile, entry)
        stop_pct, tp_pct     = get_effective_levels(sym, profile, entry)

        # ── S/R strength-against-position: exit immediately, don't wait for stop ──
        _sr_close_reason = _check_sr_strength_against_position(sym, position_side, current)
        if _sr_close_reason:
            log_agent("system", "RILEY",
                f"{sym} IMMEDIATE CLOSE — {_sr_close_reason} ({pnl_pct:+.2f}%)")
            close_position(sym, qty, f"Riley S/R reversal: {_sr_close_reason}",
                           notify_fn, entry, current, pnl_pct)
            _position_adjustments.pop(sym, None)
            clear_position_state(sym)
            continue

        # ── 11am morning loss-check: don't hold a morning loser into midday ──
        # Riley trades the full session (9:30am-3:30pm ET) now, but morning
        # entries that are still red by 11am are cut — if a position opened in
        # the morning push is still open at 11am and P&L is negative, close it.
        # Positive-P&L positions are classified as swing trades and may be
        # held into the afternoon/overnight.
        try:
            import pytz as _ptz_riley_w
            _et_riley = datetime.now(_ptz_riley_w.timezone("America/New_York"))
            _hr_riley = _et_riley.hour + _et_riley.minute / 60
            _window_closing = (11.0 <= _hr_riley < 11.25)
            _window_flag    = adj.get("riley_window_close_checked_date")
            _today_riley    = _et_riley.strftime("%Y-%m-%d %H")
            if (_window_closing and pnl_pct < 0 and not is_crypto(sym)
                    and _window_flag != _today_riley):
                if sym not in _position_adjustments:
                    _position_adjustments[sym] = {}
                _position_adjustments[sym]["riley_window_close_checked_date"] = _today_riley
                save_position_state(sym, _position_adjustments[sym])
                log_agent("system", "RILEY",
                    f"{sym} 11AM MORNING LOSS-CHECK — closing losing position "
                    f"({pnl_pct:+.2f}%) — Riley does not carry morning losers into midday")
                close_position(sym, qty,
                    "11am morning loss-check — exiting losing position",
                    notify_fn, entry, current, pnl_pct)
                _position_adjustments.pop(sym, None)
                clear_position_state(sym)
                continue
        except Exception as _rw_e:
            log.warning("Riley window check failed %s: %s", sym, _rw_e)

        # ── Hard stop loss (price level check) ───────────────────────────
        stop_hit = (current <= stop_price) if position_side == "long" \
                   else (current >= stop_price)
        if stop_hit:
            log_agent("risk", "RISK",
                f"STOP LOSS triggered: {sym} @ ${current:.4f} "
                f"(stop ${stop_price:.4f} | {pnl_pct:+.2f}%)")
            close_position(sym, qty,
                f"Stop loss hit @ ${current:.4f} (stop ${stop_price:.4f}, {pnl_pct:+.2f}%)",
                notify_fn, entry, current, pnl_pct)
            _position_adjustments.pop(sym, None)
            clear_position_state(sym)
            _session_stopped_tickers.add(sym)
            log_agent("system", "COOLDOWN",
                f"{sym} added to session stop-loss cooldown — blocked from re-entry today")
            continue

        # ── Zone-based take profit ────────────────────────────────────────────
        # Close when price ENTERS the next S/R zone — not just one exact price
        # This prevents "just short of TP" failures Riley warns about
        tp_zone_top    = tp_price * 1.002   # zone is TP ± 0.2%
        tp_zone_bottom = tp_price * 0.998

        tp_hit = False
        tp_reason = ""
        if position_side == "long":
            if current >= tp_zone_bottom:    # entered TP zone from below
                tp_hit   = True
                tp_reason = f"entered TP zone ${tp_zone_bottom:.4f}–${tp_zone_top:.4f}"
        else:
            if current <= tp_zone_top:       # entered TP zone from above
                tp_hit   = True
                tp_reason = f"entered TP zone ${tp_zone_bottom:.4f}–${tp_zone_top:.4f}"

        if tp_hit:
            log_agent("system", "MANAGER",
                f"TAKE PROFIT triggered: {sym} @ ${current:.4f} "
                f"({tp_reason} | {pnl_pct:+.2f}%)")
            close_position(sym, qty,
                f"TP zone hit @ ${current:.4f} ({tp_reason}, {pnl_pct:+.2f}%)",
                notify_fn, entry, current, pnl_pct)
            _position_adjustments.pop(sym, None)
            clear_position_state(sym)
            continue

        # Trading style — review every position every cycle (no free passes)

        # ── AI position review (HOLD or CLOSE only) ──────────────────────
        try:
            review = agent_position_reviewer(
                sym, entry, current, pnl_pct, profile,
                effective_stop=stop_pct,
                effective_tp=tp_pct
            )
            action = review.get("action", "HOLD")
            reason = review.get("reason", "")

            log_agent("claude", "CLAUDE",
                f"{sym} → {action} | {reason} ({pnl_pct:+.2f}%)")

            if action == "CLOSE":
                close_position(sym, qty, reason, notify_fn,
                               entry, current, pnl_pct)
                _position_adjustments.pop(sym, None)
                clear_position_state(sym)
            # HOLD — trailing stop system handles all level changes

        except Exception as e:
            log.error("AI review failed %s: %s", sym, e)


# ── Single ticker scan ────────────────────────────────────────────────────────

# ── Backtester ────────────────────────────────────────────────────────────────

_backtest_cache: dict = {}      # {ticker+direction: (timestamp, result)}
BACKTEST_CACHE_SECONDS = 3600   # cache for 1 hour — data doesn't change intraday
BACKTEST_DAYS          = 90     # look back 90 days
BACKTEST_MIN_SETUPS    = 5      # need at least this many setups to trust the result
BACKTEST_WIN_RATE_BLOCK = 0.35  # block if win rate below this (needs 20+ setups)

def _compute_ema(closes: list, period: int) -> list:
    result, k = [], 2 / (period + 1)
    for i, v in enumerate(closes):
        if i < period - 1:
            result.append(None)
        elif i == period - 1:
            result.append(sum(closes[:period]) / period)
        else:
            result.append(v * k + result[-1] * (1 - k))
    return result

def _compute_rsi(closes: list, period: int = 14) -> list:
    result = [None] * period
    gains, losses = [], []
    for i in range(1, len(closes)):
        d = closes[i] - closes[i-1]
        gains.append(max(d, 0))
        losses.append(max(-d, 0))
    if len(gains) < period:
        return [None] * len(closes)
    avg_g = sum(gains[:period]) / period
    avg_l = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        avg_g = (avg_g * (period-1) + gains[i]) / period
        avg_l = (avg_l * (period-1) + losses[i]) / period
        rs = avg_g / avg_l if avg_l != 0 else 100
        result.append(round(100 - 100 / (1 + rs), 2))
    return result

def run_backtest(ticker: str, direction: str, profile: dict) -> dict:
    """
    Simulate historical entries with same direction signal over last 90 days.
    Uses EMA crossover + RSI as signal proxies.

    Returns:
      {
        win_rate: 0.0-1.0,
        total_setups: int,
        wins: int,
        avg_return: float,
        best_return: float,
        worst_return: float,
        verdict: "STRONG|MODERATE|WEAK|INSUFFICIENT",
        summary: str
      }
    """
    cache_key = f"{ticker}_{direction}"
    import time as _time
    now = _time.time()

    if cache_key in _backtest_cache:
        cached_time, cached_result = _backtest_cache[cache_key]
        if now - cached_time < BACKTEST_CACHE_SECONDS:
            return cached_result

    try:
        from datetime import datetime, timezone, timedelta
        start = (datetime.now(timezone.utc) - timedelta(days=BACKTEST_DAYS)).strftime("%Y-%m-%d")
        end   = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        feed = "iex" if not is_crypto(ticker) else None
        sym  = alpaca_symbol(ticker)

        if is_crypto(ticker):
            bars = alpaca.get_crypto_bars(sym, "1Day", start=start, end=end).df
        else:
            bars = alpaca.get_bars(sym, "1Day", start=start, end=end,
                                   feed=feed, adjustment="raw").df

        if len(bars) < 20:
            result = {
                "win_rate": 0.5, "total_setups": 0, "wins": 0,
                "avg_return": 0, "best_return": 0, "worst_return": 0,
                "verdict": "INSUFFICIENT",
                "summary": f"Only {len(bars)} days of data — insufficient for backtest"
            }
            _backtest_cache[cache_key] = (now, result)
            return result

        closes = bars["close"].tolist()
        ema9   = _compute_ema(closes, 9)
        ema21  = _compute_ema(closes, 21)
        rsi    = _compute_rsi(closes, 14)

        # Take profit and stop loss from profile
        tp_pct   = profile["tp"] / 100
        stop_pct = abs(profile["stop"]) / 100

        wins, losses, returns = 0, 0, []

        # Scan for signal setups
        for i in range(21, len(closes) - 5):
            if ema9[i] is None or ema21[i] is None or rsi[i] is None:
                continue

            # BULLISH signal: EMA9 crosses above EMA21 + RSI < 70 (not overbought)
            # BEARISH signal: EMA9 crosses below EMA21 + RSI > 30 (not oversold)
            bullish_signal = (
                ema9[i] > ema21[i] and
                ema9[i-1] <= ema21[i-1] and
                rsi[i] < 70
            )
            bearish_signal = (
                ema9[i] < ema21[i] and
                ema9[i-1] >= ema21[i-1] and
                rsi[i] > 30
            )

            if direction == "BULLISH" and not bullish_signal:
                continue
            if direction == "BEARISH" and not bearish_signal:
                continue

            # Simulate the trade over the next 5 days
            entry = closes[i]
            future = closes[i+1:i+6]
            if not future:
                continue

            hit_tp   = False
            hit_stop = False
            exit_ret = 0.0

            for fp in future:
                ret = (fp - entry) / entry
                if direction == "BULLISH":
                    if ret >= tp_pct:
                        hit_tp   = True
                        exit_ret = ret
                        break
                    if ret <= -stop_pct:
                        hit_stop = True
                        exit_ret = ret
                        break
                else:  # BEARISH (short)
                    ret = -ret  # invert for short
                    if ret >= tp_pct:
                        hit_tp   = True
                        exit_ret = ret
                        break
                    if ret <= -stop_pct:
                        hit_stop = True
                        exit_ret = ret
                        break

            if not hit_tp and not hit_stop:
                # Use last day's return
                exit_ret = (future[-1] - entry) / entry
                if direction == "BEARISH":
                    exit_ret = -exit_ret

            if exit_ret > 0:
                wins += 1
            else:
                losses += 1
            returns.append(round(exit_ret * 100, 2))

        total = wins + losses
        if total < BACKTEST_MIN_SETUPS:
            result = {
                "win_rate": 0.5, "total_setups": total, "wins": wins,
                "avg_return": 0, "best_return": 0, "worst_return": 0,
                "verdict": "INSUFFICIENT",
                "summary": f"Only {total} setups found — need {BACKTEST_MIN_SETUPS}+ for reliable backtest"
            }
        else:
            win_rate   = wins / total
            avg_ret    = sum(returns) / len(returns)
            best_ret   = max(returns)
            worst_ret  = min(returns)

            if win_rate >= 0.60:
                verdict = "STRONG"
            elif win_rate >= 0.50:
                verdict = "MODERATE"
            elif win_rate >= BACKTEST_WIN_RATE_BLOCK:
                verdict = "WEAK"
            else:
                verdict = "POOR"

            result = {
                "win_rate":     round(win_rate, 3),
                "total_setups": total,
                "wins":         wins,
                "avg_return":   round(avg_ret, 2),
                "best_return":  round(best_ret, 2),
                "worst_return": round(worst_ret, 2),
                "verdict":      verdict,
                "summary": (
                    f"{total} setups in 90d: {wins}W/{losses}L "
                    f"({win_rate*100:.0f}% win rate) | "
                    f"avg {avg_ret:+.1f}% | "
                    f"best {best_ret:+.1f}% | worst {worst_ret:+.1f}%"
                )
            }

        _backtest_cache[cache_key] = (now, result)
        log_agent("system", "BACKTEST",
            f"{ticker} {direction}: {result['summary']}")
        return result

    except Exception as e:
        log.warning("Backtest failed for %s: %s", ticker, e)
        result = {
            "win_rate": 0.5, "total_setups": 0, "wins": 0,
            "avg_return": 0, "best_return": 0, "worst_return": 0,
            "verdict": "INSUFFICIENT",
            "summary": f"Backtest error: {e}"
        }
        _backtest_cache[cache_key] = (now, result)
        return result


# ── Multi-timeframe confirmation ──────────────────────────────────────────────

_mtf_cache: dict = {}
MTF_CACHE_SECONDS = 1800  # cache 30 min — same as scan interval

def _get_tf_direction(ticker: str, timeframe: str) -> str:
    """
    Get trend direction for a ticker on a given timeframe.
    Uses EMA9 vs EMA21 crossover as the signal.
    Returns: 'BULLISH', 'BEARISH', or 'NEUTRAL'
    """
    try:
        from datetime import datetime, timezone, timedelta
        sym  = alpaca_symbol(ticker)
        days = 30 if timeframe in ("4Hour", "1Day") else 7

        start = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
        end   = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        if is_crypto(ticker):
            bars = alpaca.get_crypto_bars(sym, timeframe, start=start,
                                          end=end, limit=50).df
        else:
            bars = alpaca.get_bars(sym, timeframe, start=start, end=end,
                                   limit=50, feed="iex", adjustment="raw").df

        if len(bars) < 21:
            return "NEUTRAL"

        closes = [c for c in bars["close"].tolist() if c is not None]
        if len(closes) < 21:
            return "NEUTRAL"

        ema9   = _compute_ema(closes, 9)
        ema21  = _compute_ema(closes, 21)

        # Safely get last two non-None values
        e9_vals  = [v for v in ema9  if v is not None]
        e21_vals = [v for v in ema21 if v is not None]

        if len(e9_vals) < 2 or len(e21_vals) < 2:
            return "NEUTRAL"

        e9_last,  e9_prev  = e9_vals[-1],  e9_vals[-2]
        e21_last, e21_prev = e21_vals[-1], e21_vals[-2]

        if e9_last > e21_last and e9_prev > e21_prev:
            return "BULLISH"
        elif e9_last < e21_last and e9_prev < e21_prev:
            return "BEARISH"
        else:
            return "NEUTRAL"

    except Exception as e:
        log.warning("MTF check failed %s %s: %s", ticker, timeframe, e)
        return "NEUTRAL"


def _check_1min_structure(ticker: str, signal_direction: str) -> str:
    """
    Riley Coleman 1-min execution check — has price broken the recent 1-min
    swing structure in the direction of the signal?
    Returns 'structure broken' or 'structure intact'.
    """
    try:
        sym = alpaca_symbol(ticker)
        # Bar fetch — guarded on its own: the Alpaca SDK can raise
        # "list index out of range" internally for sparse symbols (e.g.
        # BTCUSD, ETHUSD) rather than returning an empty frame.
        try:
            if is_crypto(ticker):
                bars = alpaca.get_crypto_bars(sym, "1Min", limit=15).df
            else:
                bars = alpaca.get_bars(sym, "1Min", limit=15, feed="iex").df
        except (IndexError, Exception) as _e_fetch:
            log.warning("1-min structure bar fetch failed %s: %s", ticker, _e_fetch)
            return "structure intact"

        if bars is None or bars.empty:
            return "structure intact"

        closes = [c for c in bars["close"].tolist() if c is not None]
        highs  = [h for h in bars["high"].tolist()  if h is not None]
        lows   = [l for l in bars["low"].tolist()   if l is not None]
        if len(closes) < 6 or len(highs) < 6 or len(lows) < 6:
            return "structure intact"

        last_6_highs = highs[-6:-1]
        last_6_lows  = lows[-6:-1]
        if not last_6_highs or not last_6_lows:
            return "structure intact"

        last_close = closes[-1]
        swing_high = max(last_6_highs)
        swing_low  = min(last_6_lows)

        if signal_direction == "BULLISH" and last_close > swing_high:
            return "structure broken"
        if signal_direction == "BEARISH" and last_close < swing_low:
            return "structure broken"
        return "structure intact"
    except Exception as e:
        log.warning("1-min structure check failed %s: %s", ticker, e)
        return "structure intact"


def check_multi_timeframe(ticker: str, signal_direction: str) -> dict:
    """
    Riley Coleman timeframe hierarchy:
      15-min = primary trend filter — dominates the vote (double weight)
      5-min  = confirmation layer — structure should match the 15-min direction
      1-min  = execution only — not used in trend voting, logged for context

    Returns:
      {
        confirmed: bool,
        score: 0-3 (15min agreement counts double, 5min counts single),
        m15: direction,
        m5: direction,
        m1_structure: 'structure broken' | 'structure intact',
        confidence_adjust: int  (-25 to 0)
        summary: str
      }
    """
    import time as _time
    cache_key = f"mtf_{ticker}_{signal_direction}"
    now = _time.time()

    if cache_key in _mtf_cache:
        cached_time, result = _mtf_cache[cache_key]
        if now - cached_time < MTF_CACHE_SECONDS:
            return result

    m15 = _get_tf_direction(ticker, "15Min")
    m5  = _get_tf_direction(ticker, "5Min")
    m1_structure = _check_1min_structure(ticker, signal_direction)

    log_agent("system", "BIAS", f"{ticker} [BIAS] 15min:{m15} 5min:{m5} 1min:{m1_structure}")

    # 15-min counts double (primary trend filter), 5-min counts single (confirmation)
    score = 0
    if m15 == signal_direction:
        score += 2
    if m5 == signal_direction:
        score += 1

    m15_neutral = m15 == "NEUTRAL"
    m5_neutral  = m5  == "NEUTRAL"

    # ── Riley Rule: 15-min trend DOMINATES the vote ──────────────────────────
    # "If 15-min is bearish, the system strongly favors shorts regardless of 5-min."
    # A signal against the 15-min trend is counter-trend and gets penalized;
    # a signal with the 15-min trend is confirmed regardless of the 5-min reading.
    if m15 == "BULLISH" and signal_direction == "BEARISH":
        log_agent("system", "MTF",
            f"{ticker} — 15min BULLISH, signal BEARISH — counter-trend, -10 conf")
        result = {
            "confirmed":          False,
            "score":              score,
            "m15":                m15,
            "m5":                 m5,
            "m1_structure":       m1_structure,
            "confidence_adjust":  -10,
            "alignment":          "TREND_OVERRIDE",
            "blocked":            False,
            "override_direction": "BULLISH",
            "summary":            f"15min:{m15} 5min:{m5} 1min:{m1_structure} — counter-trend short (-10)"
        }
        log_agent("system", "MTF", f"{ticker} — {result['summary']}")
        _mtf_cache[cache_key] = (now, result)
        return result

    if m15 == "BEARISH" and signal_direction == "BULLISH":
        log_agent("system", "MTF",
            f"{ticker} — 15min BEARISH, signal BULLISH — counter-trend, -10 conf")
        result = {
            "confirmed":          False,
            "score":              score,
            "m15":                m15,
            "m5":                 m5,
            "m1_structure":       m1_structure,
            "confidence_adjust":  -10,
            "alignment":          "TREND_OVERRIDE",
            "blocked":            False,
            "override_direction": "BEARISH",
            "summary":            f"15min:{m15} 5min:{m5} 1min:{m1_structure} — counter-trend long (-10)"
        }
        log_agent("system", "MTF", f"{ticker} — {result['summary']}")
        _mtf_cache[cache_key] = (now, result)
        return result

    if m15 == signal_direction:
        # 15-min (the dominant filter) agrees — confirmed regardless of 5-min;
        # 5-min only adjusts how strong the confirmation is.
        if m5 == signal_direction:
            result = {
                "confirmed":         True,
                "score":             3,
                "m15":               m15,
                "m5":                m5,
                "m1_structure":      m1_structure,
                "confidence_adjust": 0,
                "alignment":         "STRONG",
                "blocked":           False,
                "summary":           f"15min:{m15} 5min:{m5} 1min:{m1_structure} — with-trend (15min+5min aligned)"
            }
        else:
            result = {
                "confirmed":         True,
                "score":             score,
                "m15":               m15,
                "m5":                m5,
                "m1_structure":      m1_structure,
                "confidence_adjust": -5,
                "alignment":         "MODERATE",
                "blocked":           False,
                "summary":           f"15min:{m15} 5min:{m5} 1min:{m1_structure} — 15min (primary) aligned, 5min diverges (-5)"
            }
        log_agent("system", "MTF", f"{ticker} — {result['summary']}")
        _mtf_cache[cache_key] = (now, result)
        return result

    # 15-min NEUTRAL — fall back to combined score voting
    if score == 3:
        confirmed, confidence_adjust, verdict = True, 0, "STRONG — 15min+5min aligned"
    elif score == 2 or (score == 1 and (m15_neutral or m5_neutral)):
        confirmed, confidence_adjust, verdict = True, -5, "MODERATE — partial alignment"
    else:
        confirmed, confidence_adjust, verdict = False, -25, "WEAK — primary timeframe contradicts signal"

    result = {
        "confirmed":         confirmed,
        "score":             score,
        "m15":               m15,
        "m5":                m5,
        "m1_structure":      m1_structure,
        "confidence_adjust": confidence_adjust,
        "alignment":         "NEUTRAL_15M",
        "blocked":           False,
        "summary":           f"15min:{m15} 5min:{m5} 1min:{m1_structure} → {verdict}"
    }

    log_agent("system", "MTF", f"{ticker} — {result['summary']}")
    _mtf_cache[cache_key] = (now, result)
    return result


# ── Earnings & macro calendar ─────────────────────────────────────────────────

# Major macro events that cause market-wide volatility
# These block ALL stock entries within 48 hours
MACRO_EVENTS = [
    "FOMC decision", "Fed raises rates", "Fed cuts rates", "rate hike today",
    "rate cut today", "CPI report", "CPI data today", "inflation report today",
    "nonfarm payroll", "jobs report today", "GDP release", "PCE report today",
    "Fed meeting today", "Federal Reserve decision today"
]

_calendar_cache: dict = {}   # {ticker: (timestamp, result)} — cache for 1 hour
CALENDAR_CACHE_SECONDS = 3600

def _check_earnings_calendar(ticker: str) -> tuple[bool, str]:
    """
    Check if ticker has earnings within 48 hours using Alpaca news.
    Returns (has_event, description).
    """
    import time as _time
    now = _time.time()

    # Use cache to avoid hammering the API
    if ticker in _calendar_cache:
        cached_time, cached_result = _calendar_cache[ticker]
        if now - cached_time < CALENDAR_CACHE_SECONDS:
            return cached_result

    try:
        from datetime import datetime, timezone, timedelta
        # Look ahead 48 hours
        end   = datetime.now(timezone.utc) + timedelta(hours=48)
        start = datetime.now(timezone.utc)

        # Alpaca news with earnings filter
        try:
            news = alpaca.get_news(symbol=ticker, limit=10)
        except Exception:
            news = []

        for article in news:
            headline = (article.headline or "").lower()
            # Only block on UPCOMING earnings announcements, not past results
            upcoming_kw = ["earnings tomorrow", "reports earnings", "earnings preview",
                           "earnings tonight", "earnings after close", "earnings before open",
                           "earnings wednesday", "earnings thursday", "earnings tuesday",
                           "earnings monday", "earnings friday", "due to report",
                           "expected to report", "set to report"]
            if any(kw in headline for kw in upcoming_kw):
                result = (True, f"Upcoming earnings: {article.headline}")
                _calendar_cache[ticker] = (now, result)
                return result

        result = (False, "")
        _calendar_cache[ticker] = (now, result)
        return result

    except Exception as e:
        log.warning("Calendar check failed for %s: %s", ticker, e)
        return (False, "")  # fail open — don't block on API error

def _check_macro_calendar() -> tuple[bool, str]:
    """
    Check for major macro events in the next 48 hours using Alpaca news.
    Returns (has_event, description).
    """
    import time as _time
    cache_key = "__macro__"
    now = _time.time()

    if cache_key in _calendar_cache:
        cached_time, cached_result = _calendar_cache[cache_key]
        if now - cached_time < CALENDAR_CACHE_SECONDS:
            return cached_result

    try:
        from datetime import datetime, timezone, timedelta
        end   = datetime.now(timezone.utc) + timedelta(hours=48)
        start = datetime.now(timezone.utc)

        # Use SPY as proxy for broad market news
        try:
            news = alpaca.get_news(symbol="SPY", limit=20)
        except Exception:
            news = []

        for article in news:
            headline = (article.headline or "").lower()
            if any(kw.lower() in headline for kw in MACRO_EVENTS):
                result = (True, f"Macro event: {article.headline}")
                _calendar_cache[cache_key] = (now, result)
                return result

        result = (False, "")
        _calendar_cache[cache_key] = (now, result)
        return result

    except Exception as e:
        log.warning("Macro calendar check failed: %s", e)
        return (False, "")

def is_event_risk(ticker: str) -> tuple[bool, str]:
    """
    Combined check — returns (True, reason) if entry should be blocked.
    Checks both earnings for specific ticker and broad macro events.
    """
    # Crypto has no earnings — skip
    if is_crypto(ticker):
        return False, ""

    # Check earnings for this specific stock
    has_earnings, earnings_desc = _check_earnings_calendar(ticker)
    if has_earnings:
        return True, earnings_desc

    # Check broad macro events (affects all stocks)
    has_macro, macro_desc = _check_macro_calendar()
    if has_macro:
        return True, macro_desc

    return False, ""



def get_adaptive_confidence_threshold(ticker: str, base_threshold: int) -> int:
    """
    Dynamically adjust confidence threshold based on recent win rate.

    If win rate is high (>65%)  → lower threshold slightly (trade more)
    If win rate is low  (<45%)  → raise threshold (be more selective)
    If insufficient data         → use base threshold unchanged

    Works on rolling 10-trade window for fast adaptation.
    """
    try:
        con  = sqlite3.connect(LESSONS_DB)
        # Get last 10 closed trades for this ticker (or all tickers if < 5 for this one)
        rows = con.execute(
            "SELECT pnl_pct FROM trade_history "
            "WHERE symbol=? AND status='closed' AND pnl_pct IS NOT NULL "
            "ORDER BY id DESC LIMIT 10",
            (ticker,)
        ).fetchall()

        if len(rows) < 5:
            # Not enough per-ticker data — try portfolio-wide recent performance
            rows = con.execute(
                "SELECT pnl_pct FROM trade_history "
                "WHERE status='closed' AND pnl_pct IS NOT NULL "
                "ORDER BY id DESC LIMIT 15"
            ).fetchall()
        con.close()

        if len(rows) < 5:
            return base_threshold  # not enough data

        pnl_list = [r[0] for r in rows]
        wins     = [p for p in pnl_list if p > 0]
        win_rate = len(wins) / len(pnl_list) * 100

        if win_rate >= 65:
            # High win rate — lower threshold by up to 5pts (trade more)
            adjustment = -min(5, round((win_rate - 65) / 4))
        elif win_rate <= 45:
            # Low win rate — raise threshold by up to 8pts (be selective)
            adjustment = min(8, round((45 - win_rate) / 3))
        else:
            adjustment = 0  # 45-65% = neutral zone

        new_threshold = base_threshold + adjustment

        if adjustment != 0:
            log_agent("system", "ADAPTIVE",
                f"{ticker} threshold: {base_threshold}% "
                f"{'→' if adjustment != 0 else ''} {new_threshold}% "
                f"(win rate {win_rate:.0f}% over last {len(pnl_list)} trades, "
                f"adj {adjustment:+d})")

        return new_threshold

    except Exception as e:
        log.warning("Adaptive threshold failed %s: %s", ticker, e)
        return base_threshold


# ─────────────────────────────────────────────────────────────────────────────
# BATCH PROCESSING SYSTEM
# Parallel execution for speed, single Grok call for cost efficiency
# ─────────────────────────────────────────────────────────────────────────────

def batch_grok_analysis(tickers: list, prices: dict) -> dict:
    """
    Single Grok call analyzing ALL tickers simultaneously.
    ~70% cheaper than individual calls, ~3x faster.
    Returns dict: {ticker: analysis_dict}
    """
    import json

    # Build per-ticker context in parallel (lessons, news velocity, sector)
    ticker_contexts = {}

    def _build_context(ticker):
        try:
            news_vel = get_news_velocity(ticker) if not is_crypto(ticker) else \
                       {"velocity": "NORMAL", "breaking": False,
                        "acceleration": 1.0, "summary": ""}
            rotation_adj = get_sector_rotation_adjustment(ticker)
            return ticker, {
                "price":         prices.get(ticker, 0),
                "news_vel":      news_vel.get("velocity", "NORMAL"),
                "news_accel":    news_vel.get("acceleration", 1.0),
                "news_breaking": news_vel.get("breaking", False),
                "rotation_adj":  rotation_adj,
            }
        except Exception as e:
            log.warning("Batch context failed %s: %s", ticker, e)
            return ticker, {"price": prices.get(ticker, 0),
                "news_vel": "NORMAL", "news_accel": 1.0,
                "news_breaking": False, "rotation_adj": 0}

    from concurrent.futures import ThreadPoolExecutor, as_completed as _as_completed
    with ThreadPoolExecutor(max_workers=6, thread_name_prefix="newsvel") as ex:
        futures = {ex.submit(_build_context, t): t for t in tickers}
        for fut in _as_completed(futures, timeout=20):
            try:
                t, ctx = fut.result()
                ticker_contexts[t] = ctx
            except Exception as e:
                t = futures[fut]
                log.warning("Context fetch failed %s: %s", t, e)
                ticker_contexts[t] = {"price": prices.get(t, 0),
                    "news_vel": "NORMAL", "news_accel": 1.0,
                    "news_breaking": False, "rotation_adj": 0}


    # Build compact multi-ticker prompt
    ticker_lines = ""
    for t in tickers:
        ctx = ticker_contexts[t]
        p   = ctx["price"]
        # For crypto: add 24h price context since news velocity is less relevant
        crypto_ctx = ""
        if is_crypto(t):
            try:
                sym = alpaca_symbol(t)  # e.g. BTC/USD
                bars_h = None
                for tf, lim in [("1Hour", 27), ("4Hour", 12)]:
                    try:
                        _b = alpaca.get_crypto_bars(sym, tf, limit=lim).df
                        if not _b.empty and len(_b) >= 2:
                            bars_h = _b
                            break
                    except Exception:
                        continue
                if bars_h is not None and len(bars_h) >= 2:
                    price_1h_ago = float(bars_h["close"].iloc[-2])
                    price_24h_ago = float(bars_h["close"].iloc[max(0, len(bars_h)-25)])
                    high_24h = float(bars_h["high"].max())
                    low_24h  = float(bars_h["low"].min())
                    chg_1h   = (p - price_1h_ago) / price_1h_ago * 100
                    chg_24h  = (p - price_24h_ago) / price_24h_ago * 100
                    pct_range = (p - low_24h) / (high_24h - low_24h) * 100 if high_24h > low_24h else 50
                    crypto_ctx = (
                        f" | 1h:{chg_1h:+.1f}% 24h:{chg_24h:+.1f}%"
                        f" | H:{high_24h:.0f} L:{low_24h:.0f}"
                        f" | range_pos:{pct_range:.0f}%"
                    )
                    log.debug("Crypto context %s: %s", t, crypto_ctx)
                else:
                    crypto_ctx = f" | price:${p:.0f} no history"
            except Exception as _e:
                log.warning("crypto context failed %s: %s", t, _e)
                crypto_ctx = f" | price:${p:.0f}"
        ticker_lines += (
            f"  {t} @ ${p:.2f}{crypto_ctx} | news:{ctx['news_vel']} "
            f"({ctx['news_accel']:.1f}x){'  BREAKING!' if ctx['news_breaking'] else ''}"
            f" | sector adj:{ctx['rotation_adj']:+d}\n"
        )

    # Separate crypto from stocks for better context
    has_crypto = any(is_crypto(t) for t in tickers)
    has_stocks = any(not is_crypto(t) for t in tickers)
    asset_note = ""
    if has_crypto and not has_stocks:
        asset_note = (
            "These are CRYPTO assets trading 24/7. For each one you are given:\n"
            "- Current price, 1h change, 24h change\n"
            "- 24h high and low\n"
            "- range_pos: where price sits in the 24h range (0%=at low, 100%=at high)\n\n"
            "Use range_pos to assess direction — do NOT default to LONG just because price is low:\n"
            "- range_pos 0-20%: price near 24h low.\n"
            "  BEARISH if breaking down with momentum (lower lows = trend continues).\n"
            "  BULLISH only if price bounces off a clear support level with recovery.\n"
            "  A falling price is NOT automatically oversold — it may be in a downtrend.\n"
            "- range_pos 80-100%: price near 24h high.\n"
            "  BEARISH if showing exhaustion or reversal candles at resistance.\n"
            "  BULLISH if breaking out with momentum and news catalyst.\n"
            "- range_pos 40-60%: mid-range, lower confidence in either direction.\n"
            "- 1h drop -2%+: BEARISH if trend is down. BULLISH only if hitting clear support.\n"
            "- 1h rise +2%+: BULLISH if trend is up. BEARISH only if hitting clear resistance.\n"
            "- 24h change -5% or more: likely a downtrend — signal BEARISH if selling continues;\n"
            "  BULLISH only if a specific support level is clearly holding with volume.\n"
            "- 24h change +5% or more: extended move — SHORT at resistance, LONG if clean breakout.\n"
            "Minimum confidence 45% when near 24h extremes. Be specific about direction."
        )
    elif has_crypto:
        asset_note = "NOTE: Mix of stocks and crypto. Apply crypto-specific analysis for BTCUSD/ETHUSD/SOLUSD."

    # ── Market context note — injected into prompt on bearish/bullish days ──
    market_note = ""
    try:
        _mc  = get_market_condition()
        _vix = get_vix_regime()
        if _mc == "BEARISH" and _vix["regime"] in ("ELEVATED", "HIGH", "EXTREME"):
            market_note = (
                f"\n⚠️ MARKET CONTEXT — BEARISH DAY (SPY falling, VIX {_vix['vix']:.1f} {_vix['regime']}):\n"
                "The broad market is in a confirmed downtrend. Your primary job is to find SHORT setups.\n"
                "- Stocks bouncing into resistance in a downtrend = SHORT — do NOT flip to BULLISH\n"
                "- A bounce with RSI 45-65 is NOT a buy — it is a short-entry opportunity\n"
                "- Lower highs forming after a rally = continuation BEARISH\n"
                "- 'Oversold' is irrelevant in a trending market — stocks can stay oversold for hours\n"
                "Signal BULLISH ONLY if you see specific evidence of a reversal: "
                "a sector breaking out against the market, news catalyst, or major support holding.\n"
                "Default to BEARISH on every ticker unless there is a clear positive exception.\n"
            )
        elif _mc == "BULLISH" and _vix["regime"] == "CALM":
            market_note = (
                f"\nMARKET CONTEXT — BULLISH (SPY rising, VIX {_vix['vix']:.1f} CALM):\n"
                "Broad market is trending up. Favor LONG setups at support over reversal shorts.\n"
            )
    except Exception:
        pass

    # ── Performance feedback loop: inject last 3 days of EOD analysis ──────────
    _daily_ctx = ""
    try:
        _da = get_recent_daily_analyses(days=3)
        if _da:
            _daily_ctx = (
                f"\nRecent performance analysis (last 3 sessions):\n{_da}\n"
                "Use this to weight your confidence scores today: "
                "if a pattern consistently worked, boost confidence for similar setups. "
                "If a pattern consistently failed, reduce confidence.\n"
            )
            log_agent("system", "LEARNING",
                f"Learning loop ACTIVE — injecting {len(_da.splitlines())} lines "
                f"of EOD history into Grok prompt")
    except Exception:
        pass

    prompt = f"""You are a directional market analyst with real-time web + X/Twitter access.

{asset_note}{market_note}{_daily_ctx}
Analyze ALL of these assets and signal their most likely direction:
{ticker_lines}
For each ticker, check:
1. Recent X/Twitter sentiment and buzz
2. Any breaking news or catalysts
3. What is the PRIMARY trend direction right now?
4. Where is price relative to key support/resistance zones?
5. Is momentum accelerating or exhausting?

CRITICAL: A FALLING PRICE IS NOT AUTOMATICALLY A BUY.
- A downtrend with continued selling pressure = BEARISH signal.
- Only signal BULLISH if you see a specific reversal: clear support holding, failed breakdown, or oversold bounce with volume.
- Do not label every dip as "oversold". Lower lows are BEARISH, not buying opportunities.

STRATEGY — Signal the direction the market is actually moving:

BULLISH signals (signal LONG — require at least one of):
- Price pulling back to support in an uptrend and bouncing (buy the dip)
- Breakout above prior resistance with momentum or news = continuation
- Failed breakdown / bear trap — price reclaims a support level
- Oversold bounce from a clearly identified key support level

BEARISH signals (signal SHORT — any of these):
- Price in a confirmed downtrend with continued selling pressure = momentum continuation
- Breaking below support with volume = continuation short, NOT a buy
- Lower highs and lower lows in progress = trend continuation, signal BEARISH
- Failed breakout / bull trap — reversed back below resistance
- Parabolic spike into resistance = exhausted buyers, reversal short
- News resolved or priced in, price fading from highs

CONFIDENCE GUIDELINES — be generous, not stingy:
- Strong setup with clear level + momentum: 70-90%
- Good setup with zone or catalyst: 55-70%
- Moderate setup, some context: 40-55%
- Weak / no clear edge: 30-40%
- NEUTRAL only when trend and momentum are genuinely ambiguous in BOTH directions

IMPORTANT: Do NOT return 0% confidence unless you have literally no data.
If there is any news, any price movement, any sector context — give a real directional signal.
Minimum confidence: 30% for any ticker with news velocity > 0.
Only return 0% for tickers with zero news AND zero price movement AND no context.

Return ONLY valid JSON with this exact structure (keep all text fields under 12 words):
{{
  "TICKER1": {{
    "direction": "BULLISH|BEARISH|NEUTRAL",
    "confidence": 0,
    "technical_score": 0,
    "sentiment_score": 0,
    "news_score": 0,
    "catalyst": "max 10 words",
    "risk": "max 8 words",
    "exhaustion_signal": "max 8 words",
    "key_reversal_level": "price",
    "setup_type": "LONG_REVERSAL|SHORT_REVERSAL|BREAKDOWN_SHORT|BREAKOUT_LONG|NEUTRAL"
  }},
  "TICKER2": {{ ... }}
}}"""

    log.info("[GROK_PROMPT] Ticker context sent to Grok:\n%s", ticker_lines.strip())
    try:
        # Grok-with-Claude-fallback so a dead xAI account doesn't NEUTRAL-out the scan.
        raw = grok_chat([{"role": "user", "content": prompt}], max_tokens=2500)
        # Repair common Grok JSON issues before parsing:
        # smart quotes, trailing commas, apostrophes in values
        import re as _re
        raw_clean = raw.replace('\u2019', "\\'").replace('\u2018', "\\'")
        raw_clean = raw_clean.replace('\u201c', '\\"').replace('\u201d', '\\"')
        raw_clean = _re.sub(r',(\s*[}\]])', r'\1', raw_clean)  # trailing commas
        # If truncated mid-JSON, try to close it
        if raw_clean.count('{') > raw_clean.count('}'):
            raw_clean = raw_clean.rstrip().rstrip(',') + '}' * (raw_clean.count('{') - raw_clean.count('}'))
        try:
            data = extract_json(raw_clean)
        except Exception:
            data = extract_json(raw)  # try original if repair made it worse

        # Cache last known good results — use when Grok returns all zeros
        all_zero = all(data.get(t, {}).get("confidence", 0) == 0 for t in tickers)
        if all_zero and hasattr(batch_grok_analysis, '_last_good_results'):
            log.warning("Grok returned all-zero confidence — using last known good results")
            return batch_grok_analysis._last_good_results

        results = {}
        for t in tickers:
            if t in data:
                r = data[t]
                r["direction"]     = r.get("direction", "NEUTRAL").upper()
                r["action"]        = r.get("direction", "HOLD")
                r["news_velocity"] = ticker_contexts[t]["news_vel"]
                r["news_breaking"] = ticker_contexts[t]["news_breaking"]
                r["news_accel"]    = ticker_contexts[t]["news_accel"]

                # Breaking news confidence boost
                if r["news_breaking"] and r["news_accel"] >= 2.0:
                    old_conf = r.get("confidence", 60)
                    r["confidence"] = min(100, old_conf + 10)

                results[t] = r
                log_agent("grok", "GROK",
                    f"{t} ${prices.get(t,0):.2f} — "
                    f"{r['direction']} {r['confidence']}% | {r.get('catalyst','')[:60]}")
            else:
                log.warning("Batch Grok missing result for %s", t)
                results[t] = {"direction": "NEUTRAL", "confidence": 50,
                              "technical_score": 50, "sentiment_score": 50,
                              "news_score": 50, "catalyst": "no data",
                              "risk": "unknown", "exhaustion_signal": "",
                              "key_reversal_level": str(prices.get(t, 0)),
                              "news_velocity": "NORMAL", "news_breaking": False,
                              "news_accel": 1.0}
        # Cache results if meaningful (not all zero)
        if any(results.get(t, {}).get("confidence", 0) > 20 for t in tickers):
            batch_grok_analysis._last_good_results = results

        return results

    except Exception as e:
        log.error("Batch Grok failed: %s — falling back to individual calls", e)
        # Fallback: individual calls
        results = {}
        for t in tickers:
            try:
                results[t] = agent_grok_analyst(t, prices.get(t, 0))
            except Exception as e2:
                log.error("Individual Grok fallback failed %s: %s", t, e2)
                results[t] = {"direction": "NEUTRAL", "confidence": 50,
                              "catalyst": "error", "risk": "unknown",
                              "technical_score": 50, "sentiment_score": 50,
                              "news_score": 50, "exhaustion_signal": "",
                              "key_reversal_level": "0"}
        return results


# ── Σ₀ EV evidence helpers: cheap per-ticker win-rate + directional news ───────
# Feed the convergence_ev scorer with LIVE base rate (realized win-rate) and news
# sentiment, instead of the neutral defaults. Both are cheap (one SQLite read /
# one tail-read of the shared news registry) and cached so a 1-min scan is light.
_EV_NEWS_CACHE = {}
_EV_NEWS_POS = ("surge", "rally", "beat", "beats", "record", "gain", "gains", "rise",
                "rises", "jump", "jumps", "soar", "soars", "upgrade", "upgraded",
                "bullish", "strong", "growth", "profit", "tops", "raises", "raised",
                "outperform", "buy", "rebound", "wins", "approval", "expands")
_EV_NEWS_NEG = ("drop", "drops", "fall", "falls", "plunge", "plunges", "crash", "miss",
                "misses", "loss", "losses", "sink", "sinks", "slump", "downgrade",
                "downgraded", "bearish", "weak", "cut", "cuts", "layoff", "layoffs",
                "probe", "lawsuit", "warn", "warns", "warning", "investigation",
                "recall", "slides", "tumble", "tumbles", "halts", "bankruptcy")


def _ev_recent_win_rate(ticker: str):
    """Realized win-rate in [0,1] for the EV base rate: last 10 closed trades for
    this ticker, else portfolio-wide last 20. None when there isn't enough history
    (the scorer then falls back to its 0.5 prior)."""
    try:
        con = sqlite3.connect(LESSONS_DB)
        rows = con.execute(
            "SELECT pnl_pct FROM trade_history WHERE symbol=? AND status='closed' "
            "AND pnl_pct IS NOT NULL ORDER BY id DESC LIMIT 10", (ticker,)).fetchall()
        if len(rows) < 5:
            rows = con.execute(
                "SELECT pnl_pct FROM trade_history WHERE status='closed' "
                "AND pnl_pct IS NOT NULL ORDER BY id DESC LIMIT 20").fetchall()
        con.close()
        if len(rows) < 5:
            return None
        pnls = [r[0] for r in rows]
        return len([p for p in pnls if p > 0]) / len(pnls)
    except Exception:
        return None


def _ev_realized_rr(ticker: str):
    """Realized reward:risk for the EV `target_r`.

    The trade actually taken is a 3R structural setup (calculate_smart_levels),
    but trailing / zone exits usually close winners before 3R — so the *planned*
    3.0 is optimistic. Feeding the EV the empirically realized reward:risk keeps
    ENTER/SKIP honest and self-limiting: if winners trail out small, the edge
    shrinks and marginal trades stop qualifying.

    EXACT when trades carry risk_pct (the entry stop distance): per-trade
    R = pnl_pct / risk_pct, then avg(win R) / avg(|loss R|). This is unit-correct
    even when stop distances vary trade-to-trade. Falls back to the avg-win% /
    avg-loss% PROXY for legacy rows that predate the risk_pct column. Last 30
    closed trades for the ticker, else portfolio-wide last 40. None (→ caller
    uses planned 3.0) when there isn't a win AND a loss in a ≥10 sample.
    """
    try:
        con = sqlite3.connect(LESSONS_DB)
        rows = con.execute(
            "SELECT pnl_pct, risk_pct FROM trade_history WHERE symbol=? "
            "AND status='closed' AND pnl_pct IS NOT NULL ORDER BY id DESC LIMIT 30",
            (ticker,)).fetchall()
        if len(rows) < 10:
            rows = con.execute(
                "SELECT pnl_pct, risk_pct FROM trade_history WHERE status='closed' "
                "AND pnl_pct IS NOT NULL ORDER BY id DESC LIMIT 40").fetchall()
        con.close()

        # Preferred: EXACT per-trade R when ≥10 trades carry a real stop distance.
        exact = [(p, r) for (p, r) in rows if p is not None and r and r > 0]
        if len(exact) >= 10:
            rs = [p / r for (p, r) in exact]
            wins = [x for x in rs if x > 0]
            losses = [abs(x) for x in rs if x <= 0]
            if wins and losses:
                avg_win = sum(wins) / len(wins)
                avg_loss = sum(losses) / len(losses)
                if avg_loss > 0:
                    return max(0.5, min(3.0, avg_win / avg_loss))

        # Fallback: avg-win% / avg-loss% proxy over whatever closed rows we have.
        pnls = [p for (p, _r) in rows if p is not None]
        wins = [p for p in pnls if p > 0]
        losses = [abs(p) for p in pnls if p <= 0]
        if len(pnls) < 10 or not wins or not losses:
            return None
        avg_win = sum(wins) / len(wins)
        avg_loss = sum(losses) / len(losses)
        if avg_loss <= 0:
            return None
        return max(0.5, min(3.0, avg_win / avg_loss))
    except Exception:
        return None


_EV_WEIGHTS_CACHE = {"ts": 0.0, "weights": None}


def _ev_adapted_weights():
    """EV weights re-scaled by the trader's own realized per-signal edge, or None.

    Closes the learning loop the council only *measured*: reads the graded
    convergence outcomes (data/convergence/trader-outcomes.jsonl — the same file
    sigma0-trader-council.js grades) and calls convergence_ev.adapt_weights,
    which is conservative by construction (needs ≥20 graded rows, ≥5 in each
    strong/weak bucket per signal, ±50% cap). Returns None (→ score_convergence
    uses static base weights) when immature or disabled. Gated by
    SIGMA0_ADAPT_WEIGHTS (default on); cached 5 min so a 1-min scan is light.
    """
    if os.getenv("SIGMA0_ADAPT_WEIGHTS", "1") == "0":
        return None
    import time as _t
    now = _t.time()
    if _EV_WEIGHTS_CACHE["weights"] is not None and now - _EV_WEIGHTS_CACHE["ts"] < 300:
        return _EV_WEIGHTS_CACHE["weights"]
    if now - _EV_WEIGHTS_CACHE["ts"] < 300 and _EV_WEIGHTS_CACHE["ts"] > 0:
        return None  # recently checked, still immature — don't re-read every scan
    weights = None
    try:
        from convergence_ev import adapt_weights, WEIGHTS
        path = os.path.join(os.path.dirname(__file__), "..", "..",
                            "data", "convergence", "trader-outcomes.jsonl")
        rows = []
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fh:
                for ln in fh.readlines()[-500:]:
                    ln = ln.strip()
                    if not ln:
                        continue
                    try:
                        rows.append(json.loads(ln))
                    except Exception:
                        pass
        adapted = adapt_weights(rows)
        # Only return a dict when it actually DIFFERS from base (i.e. it matured
        # and moved something) — otherwise keep None so behaviour is unchanged.
        if adapted and adapted != dict(WEIGHTS):
            weights = adapted
            _changed = {k: v for k, v in adapted.items() if v != WEIGHTS.get(k)}
            log_agent("system", "SIGMA0",
                f"EV weights adapted from realized edge: {_changed}")
    except Exception as _e:
        log.warning("adapt_weights failed: %s", _e)
        weights = None
    _EV_WEIGHTS_CACHE["ts"] = now
    _EV_WEIGHTS_CACHE["weights"] = weights
    return weights


def _ev_news_sentiment(ticker: str):
    """Directional news sentiment in [-1,+1] for `ticker`, from the SHARED CSF news
    registry (the same Alpaca-backed feed Explore/the trader news panel use):
    impact-weighted keyword polarity over recent headlines that tag this ticker.
    0.0 when there's no recent news. Cached 5 minutes."""
    import time as _t
    now = _t.time()
    hit = _EV_NEWS_CACHE.get(ticker)
    if hit and now - hit[0] < 300:
        return hit[1]
    score = 0.0
    try:
        path = os.path.join(os.path.dirname(__file__), "..", "..",
                            "data", "lantern-garage", "trading", "news.jsonl")
        if os.path.exists(path):
            up = ticker.upper()
            num = 0.0
            wsum = 0.0
            with open(path, "r", encoding="utf-8") as fh:
                lines = fh.readlines()[-500:]   # recent tail only — cheap
            for ln in lines:
                try:
                    rec = json.loads(ln)
                except Exception:
                    continue
                if up not in [str(s).upper() for s in (rec.get("symbols") or [])]:
                    continue
                hl = (rec.get("headline") or "").lower()
                pos = sum(1 for w in _EV_NEWS_POS if w in hl)
                neg = sum(1 for w in _EV_NEWS_NEG if w in hl)
                if pos == neg:
                    continue
                w = 0.5 + (rec.get("impact", 40) or 40) / 100.0    # weight by impact
                num += (1.0 if pos > neg else -1.0) * w
                wsum += w
            if wsum > 0:
                score = max(-1.0, min(1.0, num / wsum))
    except Exception:
        score = 0.0
    _EV_NEWS_CACHE[ticker] = (now, score)
    return score


# ── Σ₀ convergence loop: emit a record on ENTER, grade it on close ─────────────
# Closes Observe→Remember→Verify→Converge for the trader: every executed entry
# becomes a ConvergenceRecord in the SHARED store (schema mirrors
# lib/convergence-records.js / src/convergence/objects.py) so the council sees it;
# on close we append a Brier-scored outcome (same rule as
# convergence-outcome-grader.js) so realized edge can re-weight the EV signals.
_CONV_RECORDS = os.path.join(os.path.dirname(__file__), "..", "..",
                             "data", "convergence", "records.jsonl")
_CONV_TRADER_OUTCOMES = os.path.join(os.path.dirname(__file__), "..", "..",
                                     "data", "convergence", "trader-outcomes.jsonl")


def _conv_append(path: str, obj: dict):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(obj) + "\n")
    except Exception as e:
        log.warning("convergence append failed (%s): %s", path, e)


def _conv_emit_entry(ticker: str, direction: str, order_id, ev: dict) -> str:
    """Act stage: persist a ConvergenceRecord for an executed ENTER. Returns the
    record id (stored on the position so close can grade it)."""
    now = datetime.now().isoformat()
    rid = f"cr-trade-{ticker}-{datetime.now().strftime('%Y%m%dT%H%M%S%f')}"
    rec = {
        "id": rid,
        "hypothesis": f"{direction} {ticker} — Σ₀ EV {ev.get('ev_r')}R, p_win {ev.get('p_win')}",
        "evidence_ids": [],
        "result": {
            "action": "ENTER", "ticker": ticker, "direction": direction,
            "order_id": str(order_id) if order_id is not None else None,
            "instruction": ev.get("instruction"), "signals": ev.get("signals"),
            "ev_r": ev.get("ev_r"), "why": ev.get("why"),
        },
        "confidence": float(ev.get("p_win") or 0.5),
        "reasoner": "trader-sigma0",
        "timestamp": now,
        "verified": False,
        "verification_notes": None,
        "source": f"convergence_ev:{ticker}:{order_id}",
        "applied_evidence": [],
        "grounding_signals": list(ev.get("why") or []),
        "allowed_max_confidence": None,
    }
    _conv_append(_CONV_RECORDS, rec)
    return rid


def _conv_grade_close(ticker: str, pnl_pct):
    """Verify/Converge: grade the open ENTER record for `ticker` against realized
    P&L (Brier = (confidence − outcome)²), append to the trader outcomes log so the
    council can recalibrate. No-op if the position had no Σ₀ record."""
    info = _position_adjustments.get(ticker) or {}
    rid = info.get("sigma0_record_id")
    conf = info.get("sigma0_pwin")
    if not rid or conf is None:
        return
    won = (pnl_pct or 0) > 0
    outcome = 1 if won else 0
    # Schema matches convergence-outcome-grader.js (passed + brier_score +
    # confidence) so calibrationSummary() consumes it directly; outcome + signals
    # are kept for the per-signal realized-edge aggregation.
    _conv_append(_CONV_TRADER_OUTCOMES, {
        "record_id": rid, "ticker": ticker,
        "confidence": float(conf), "passed": won, "outcome": outcome,
        "brier_score": round((float(conf) - outcome) ** 2, 4),
        "pnl_pct": pnl_pct, "signals": info.get("sigma0_signals"),
        "graded_at": datetime.now().isoformat(),
    })


def validate_symbol(ticker: str) -> dict:
    """Validate a ticker is a REAL, tradable asset before it's added to the
    watchlist (#1624) — via the Alpaca asset API for equities and a live price
    probe for crypto. Runs Python-side because that's where the Alpaca creds live
    (the Node server has none). Returns {valid, tradable, symbol, name, asset_class,
    price?, reason}."""
    t = (ticker or "").strip().upper()
    if not t or not re.match(r"^[A-Z0-9.\-/]{1,12}$", t):
        return {"valid": False, "tradable": False, "symbol": t, "reason": "invalid format"}
    try:
        if is_crypto(t):
            price = fetch_ticker_price(t)
            ok = bool(price and price > 0)
            return {"valid": ok, "tradable": ok, "symbol": t, "name": t,
                    "asset_class": "crypto", "price": price if ok else None,
                    "reason": "" if ok else "no market data for crypto pair"}
        asset = alpaca.get_asset(t)
        tradable = bool(getattr(asset, "tradable", False))
        return {"valid": True, "tradable": tradable,
                "symbol": getattr(asset, "symbol", t),
                "name": getattr(asset, "name", t),
                "exchange": getattr(asset, "exchange", "") or "",
                "asset_class": getattr(asset, "_raw", {}).get("class", "us_equity")
                               if hasattr(asset, "_raw") else "us_equity",
                "reason": "" if tradable else "asset exists but is not tradable"}
    except Exception:
        return {"valid": False, "tradable": False, "symbol": t,
                "reason": "not a known symbol on Alpaca"}


def fetch_ticker_price(ticker: str) -> float:
    """Fetch current price — used in parallel pre-fetch stage."""
    try:
        if is_crypto(ticker):
            sym = alpaca_symbol(ticker)
            from datetime import timezone, timedelta as _td
            _now   = datetime.now(timezone.utc)
            _end   = _now.isoformat()
            # 60-min window ensures bars are always returned even when Alpaca's
            # free-tier crypto feed runs ~30 min behind on weekends.
            # Per-TF thresholds reject genuinely stale bars while accepting
            # bars that are just delayed by normal Alpaca latency.
            _start = (_now - _td(minutes=60)).isoformat()
            for tf, lim, max_age_sec in [
                ("1Min",  3, 2100),   # accept ≤ 35 min old
                ("5Min",  3, 2400),   # accept ≤ 40 min old
                ("1Hour", 2, 5400),   # accept ≤ 90 min old (last resort)
            ]:
                try:
                    bars = alpaca.get_crypto_bars(
                        sym, tf, start=_start, end=_end, limit=lim).df
                    if bars.empty:
                        continue
                    last_ts = bars.index[-1]
                    if hasattr(last_ts, "to_pydatetime"):
                        last_ts = last_ts.to_pydatetime()
                    if last_ts.tzinfo is None:
                        last_ts = last_ts.replace(tzinfo=timezone.utc)
                    age_sec = (_now - last_ts).total_seconds()
                    if age_sec <= max_age_sec:
                        return float(bars["close"].iloc[-1])
                    log.debug(
                        "fetch_ticker_price %s %s bar %.0f min old (max %d min) — next TF",
                        ticker, tf, age_sec / 60, max_age_sec // 60)
                except Exception:
                    continue
            return 0.0
        else:
            bars = alpaca.get_bars(ticker, "1Min", limit=1, feed="iex").df
            return float(bars["close"].iloc[-1]) if not bars.empty else 0.0
    except Exception as e:
        log.warning("Price fetch failed %s: %s", ticker, e)
        return 0.0


def scan_ticker_stage2(ticker: str, price: float, analysis: dict,
                        open_positions: dict, vix_regime: dict,
                        portfolio_delta: dict, earnings: dict,
                        equity: float, market_bias: str = "NEUTRAL") -> dict:
    """
    Stage 2 of batched scan — runs AFTER Grok batch completes.
    Does: Riley zones, reversal analysis, MTF, backtest, Claude decision.
    Designed to run in parallel threads (one per ticker).
    """
    try:
        return scan_ticker(
            ticker,
            notify_fn=None,
            open_positions=open_positions,
            vix_regime=vix_regime,
            portfolio_delta=portfolio_delta,
            earnings=earnings,
            _precomputed_analysis=analysis,
            _precomputed_price=price,
            market_bias=market_bias,
        )
    except Exception as e:
        log.error("Stage2 scan failed %s: %s", ticker, e)
        return {"status": "skipped", "ticker": ticker, "reason": str(e)}

def scan_ticker(ticker: str, notify_fn=None, open_positions: dict = None,
                vix_regime: dict = None, portfolio_delta: dict = None,
                earnings: dict = None,
                _precomputed_analysis: dict = None,
                _precomputed_price: float = None,
                market_bias: str = "NEUTRAL") -> dict | None:

    # Default to calm regime if not provided
    if vix_regime is None:
        vix_regime = {"regime": "CALM", "allow_new_entries": True,
                      "allow_stocks": True, "allow_crypto": True,
                      "size_multiplier": 1.0, "conf_boost": 0}
    if open_positions is None:
        open_positions = get_open_positions()

    # Check current position side
    pos_side = get_position_side(ticker, open_positions)
    if pos_side != "none":
        # Allow scan to continue — Grok/Claude may signal a flip or exit
        # The risk manager will block double-entry (long→long, short→short)
        log_agent("system", "SCANNER",
            f"{ticker} — already {pos_side}, scanning for flip/exit signal")

    # ── Session stop-loss cooldown ────────────────────────────────────────────
    _check_reset_session_cooldown()
    if ticker in _session_stopped_tickers:
        _cd_reason = f"Session cooldown — {ticker} hit a stop loss earlier today, blocked until next market open"
        log_agent("system", "COOLDOWN", f"{ticker} BLOCKED — {_cd_reason}")
        return {"status": "skipped", "ticker": ticker, "reason": _cd_reason}

    # Time-of-day filter — stocks only, not crypto
    # (Correlation/sector check moved to after Grok so conf is available for the
    #  high-confidence override check.  See below.)
    if not is_crypto(ticker):
        time_ok, time_reason = is_good_entry_time()
        if not time_ok:
            log_agent("system", "SCANNER", f"{ticker} — {time_reason}")
            return {"status": "skipped", "ticker": ticker, "reason": time_reason}

    log_agent("system", "SCANNER", f"Scanning {ticker}...")

    # Use precomputed price if provided (batch mode), else fetch
    if _precomputed_price is not None and _precomputed_price > 0:
        price = _precomputed_price
    else:
        price = get_price(ticker)
    if price <= 0:
        log_agent("system", "SCANNER", f"Skipping {ticker} — no price")
        return {"status": "skipped", "ticker": ticker, "reason": "No price data"}

    # ── Earnings: hard block — ticker-specific binary event, price is unpredictable ─
    # ── Macro: confidence penalty only — NFP/FOMC/CPI affects market broadly but
    #    does not invalidate an individual stock's technical setup.
    if not is_crypto(ticker):
        _has_earnings, _earnings_desc = _check_earnings_calendar(ticker)
        if _has_earnings:
            reason = f"Earnings within 48h — {_earnings_desc}"
            log_agent("system", "EARNINGS", f"{ticker} BLOCKED — {reason}")
            return {"status": "skipped", "ticker": ticker, "reason": reason}
    # Note macro flag; penalty applied after Grok analysis so conf is in scope
    _has_macro, _macro_desc = (False, "")
    if not is_crypto(ticker):
        try:
            _has_macro, _macro_desc = _check_macro_calendar()
        except Exception:
            pass

    equity = get_portfolio_equity()

    # Use precomputed Grok analysis if provided (batch mode), else call individually
    try:
        if _precomputed_analysis is not None:
            analysis = _precomputed_analysis
            log_agent("grok", "GROK",
                f"{ticker} ${price:.2f} → {analysis.get('direction')} "
                f"{analysis.get('confidence')}% | {analysis.get('catalyst','')} "
                f"[batch]")
        else:
            analysis = agent_grok_analyst(ticker, price)
            log_agent("grok", "GROK",
                f"{ticker} ${price:.2f} → {analysis.get('direction')} "
                f"{analysis.get('confidence')}% | {analysis.get('catalyst')}")
    except Exception as e:
        log_agent("system", "GROK", f"Error {ticker}: {e}")
        return {"status": "skipped", "ticker": ticker, "reason": f"Grok error: {e}"}

    conf      = analysis.get("confidence", 0)
    profile   = get_profile(ticker)

    # ── Crypto short guard ──────────────────────────────────────────────────────
    # Alpaca paper trading does not support crypto shorts (no borrow available) —
    # skip immediately rather than running the full pipeline for a dead-end trade.
    if is_crypto(ticker) and analysis.get("direction") == "BEARISH":
        reason = "CRYPTO SHORT SKIPPED — Alpaca paper does not support crypto shorts"
        log_agent("system", "CRYPTO", f"{ticker} {reason}")
        return {"status": "skipped", "ticker": ticker, "reason": reason,
                "confidence": conf, "direction": "BEARISH"}

    # ── Macro event penalty (set up before Grok, applied here now conf exists) ─
    if _has_macro:
        old_conf = conf
        conf = max(0, conf - 10)
        analysis["confidence"] = conf
        log_agent("system", "SCANNER",
            f"{ticker} macro event risk: {old_conf}% → {conf}% (-10) | {_macro_desc}")

    # ── Correlation / sector check (needs conf for high-confidence override) ──
    corr_ok, corr_reason = check_correlation(ticker, open_positions, equity)
    if not corr_ok:
        _override_done = False
        if conf >= 85 and not is_crypto(ticker):
            try:
                ticker_upper  = ticker.upper()
                ticker_sectors = [s for s, m in SECTOR_MAP.items() if ticker_upper in m]
                worst_sym, worst_pnl = None, float("inf")
                for sector in ticker_sectors:
                    for sym, pos in open_positions.items():
                        if sym.replace("/", "").upper() in SECTOR_MAP.get(sector, set()):
                            try:
                                pnl = float(pos.unrealized_plpc) * 100 \
                                      if hasattr(pos, "unrealized_plpc") else 0.0
                                if pnl < worst_pnl:
                                    worst_pnl, worst_sym = pnl, sym
                            except Exception:
                                pass
                if worst_sym:
                    log_agent("risk", "RISK",
                        f"{ticker} conf {conf}% ≥ 85 — sector override: closing "
                        f"{worst_sym} ({worst_pnl:+.1f}%) to make room")
                    p = open_positions[worst_sym]
                    close_position(
                        worst_sym,
                        abs(float(p.qty)) if hasattr(p, "qty") else 0,
                        f"Sector override: replaced by {ticker} ({conf}% conf)",
                        notify_fn,
                        float(p.avg_entry_price) if hasattr(p, "avg_entry_price") else 0,
                        float(p.current_price)   if hasattr(p, "current_price")   else 0,
                        worst_pnl,
                    )
                    _position_adjustments.pop(worst_sym, None)
                    clear_position_state(worst_sym)
                    open_positions.pop(worst_sym, None)
                    _override_done = True
            except Exception as _e:
                log.warning("Sector override failed: %s", _e)
        if not _override_done:
            log_agent("system", "SCANNER", f"{ticker} — {corr_reason}")
            return {"status": "skipped", "ticker": ticker, "reason": corr_reason}

    # ── Strong trend filter (15-min stair-step) ───────────────────────────────
    # 5+ consecutive lower highs = obvious downtrend, blocks counter-trend longs.
    # 5+ consecutive higher lows = obvious uptrend, blocks counter-trend shorts.
    _trend_dir = analysis.get("direction", "NEUTRAL")
    if _trend_dir in ("BULLISH", "BEARISH"):
        _consec = _riley_detect_consecutive_trend(ticker)
        if _trend_dir == "BULLISH" and _consec["lower_highs"] >= 5:
            reason = (f"Strong downtrend — {_consec['lower_highs']} consecutive "
                      f"lower highs on 15-min, blocking counter-trend long")
            log_agent("system", "TREND", f"{ticker} BLOCKED — {reason}")
            return {"status": "skipped", "ticker": ticker, "reason": reason,
                    "confidence": conf, "direction": _trend_dir}
        if _trend_dir == "BEARISH" and _consec["higher_lows"] >= 5:
            reason = (f"Strong uptrend — {_consec['higher_lows']} consecutive "
                      f"higher lows on 15-min, blocking counter-trend short")
            log_agent("system", "TREND", f"{ticker} BLOCKED — {reason}")
            return {"status": "skipped", "ticker": ticker, "reason": reason,
                    "confidence": conf, "direction": _trend_dir}

    # ── Riley Coleman Strategy Gate (computed early — informs both the spike-
    # chase check below and the confidence threshold further down; reused
    # later in the function rather than recomputed) ──────────────────────────
    riley = riley_strategy_gate(ticker, price, analysis.get("direction", "NEUTRAL"), conf)
    _riley_struct = riley.get("structure", {}) or {}
    _riley_full_pass = (
        riley.get("approved")
        and riley.get("entry_quality") in ("PERFECT", "GOOD")
        and (_riley_struct.get("structure_shifted") or _riley_struct.get("entry_candle"))
    )
    _riley_at_zone = bool((riley.get("zone") or {}).get("in_zone"))

    # ── Momentum spike / chase detection ──────────────────────────────────────
    # Don't chase a stock that has already moved >1.5% in the last hour in the
    # same direction as the signal. These entries typically give back the move.
    # Correct behaviour: spikes should be watched for REVERSALS, not followed.
    # Exception: a ticker that spiked but is now sitting AT a confirmed Riley
    # zone (with a bait candle forming) isn't a chase — that's exactly the
    # setup Riley looks for, so the penalty only applies away from a zone.
    if not is_crypto(ticker):
        if _riley_at_zone:
            log_agent("system", "SCANNER",
                f"{ticker} spike-chase check skipped — price is AT a confirmed "
                f"Riley zone (this is the setup, not a chase)")
        else:
            try:
                _bars_1h = alpaca.get_bars(ticker, "5Min", limit=12, feed="iex").df
                if not _bars_1h.empty and len(_bars_1h) >= 4:
                    _chg_1h = ((float(_bars_1h["close"].iloc[-1]) - float(_bars_1h["close"].iloc[0]))
                               / float(_bars_1h["close"].iloc[0]) * 100)
                    _sig = analysis.get("direction", "NEUTRAL")
                    _chasing = ((_sig == "BULLISH" and _chg_1h > 1.5) or
                                (_sig == "BEARISH" and _chg_1h < -1.5))
                    if _chasing:
                        old_conf = conf
                        conf = max(0, old_conf - 20)
                        analysis["confidence"] = conf
                        log_agent("system", "SCANNER",
                            f"{ticker} spike chase: {_chg_1h:+.1f}% in 1h matches {_sig} signal "
                            f"— conf {old_conf}% → {conf}% (-20 chasing penalty)")
            except Exception:
                pass

    # ── Yesterday's analysis: penalise tickers flagged as "avoid" ───────────────
    # If yesterday's EOD analysis called out this ticker as the worst performer
    # or explicitly named it in tomorrow_avoid, apply a -10 warning penalty.
    if not is_crypto(ticker):
        try:
            _yd = get_yesterday_analysis()
            if _yd:
                _avoid_text = (
                    (_yd.get("tomorrow_avoid", "") + " " +
                     _yd.get("avoid_pattern",  "") + " " +
                     _yd.get("worst_ticker",   "")).lower()
                )
                if ticker.lower() in _avoid_text:
                    old_conf = analysis["confidence"]
                    analysis["confidence"] = max(0, old_conf - 10)
                    conf = analysis["confidence"]
                    log_agent("system", "SCANNER",
                        f"{ticker} flagged in yesterday's EOD analysis — "
                        f"conf {old_conf}% → {conf}% (-10 recent loser warning)")
        except Exception:
            pass

    # ── Long/short confidence threshold ───────────────────────────────────────
    # LONG: flat 65% gate — Riley zone/MTF/candle gating doesn't apply to longs
    # (see direction-specific blocks below); Grok BULLISH ≥ 65% is sufficient.
    # SHORT/NEUTRAL: existing profile-based adaptive threshold, with Riley
    # full-gate-pass lowering it to 50% for stocks.
    if analysis.get("direction") == "BULLISH":
        base_threshold = 65
        threshold      = 65
    elif is_crypto(ticker):
        base_threshold = max(profile["conf"], 30)  # floor at 30% for crypto
        threshold = get_adaptive_confidence_threshold(ticker, base_threshold)
    else:
        # Apply adaptive threshold based on recent win rate
        base_threshold = profile["conf"]
        # Riley gate is now the primary quality filter — a setup that clears
        # the FULL gate (zone + direction + pattern confirmed) deserves entry
        # at a lower confidence bar than an unconfirmed setup would need.
        if _riley_full_pass and base_threshold > 50:
            log_agent("system", "RILEY",
                f"{ticker} full Riley gate pass ({riley.get('entry_quality')}) — "
                f"confidence threshold lowered {base_threshold}% → 50%")
            base_threshold = 50
        threshold = get_adaptive_confidence_threshold(ticker, base_threshold)

    # ── ES/NQ correlation check (SPY vs QQQ) — informational only ────────────
    _spy_qqq = check_spy_qqq_alignment()
    if _spy_qqq.get("diverged"):
        log_agent("system", "BIAS",
            f"{ticker} — ES/NQ divergence noted ({_spy_qqq.get('summary','')}) "
            f"— informational only")

    # Apply sector rotation confidence adjustment — direction-aware.
    # Cold sector CONFIRMS a short thesis; hot sector CONTRADICTS it.
    # For BEARISH signals: cold → +5, hot → -5 (opposite of normal).
    # For BULLISH/NEUTRAL signals: cold → -8, hot → +8 (normal behavior).
    rotation_adj = get_sector_rotation_adjustment(ticker)
    _sig_dir     = analysis.get("direction", "NEUTRAL")
    if rotation_adj != 0:
        if _sig_dir == "BEARISH":
            _eff_adj = +5 if rotation_adj < 0 else -5   # flip for shorts
            _sector_label = "COLD→confirms short" if rotation_adj < 0 else "HOT→contradicts short"
        else:
            _eff_adj = rotation_adj
            _sector_label = "HOT" if rotation_adj > 0 else "COLD"
        old_conf = conf
        conf = max(0, min(100, conf + _eff_adj))
        analysis["confidence"] = conf
        log_agent("system", "ROTATION",
            f"{ticker} sector {_sector_label} ({_sig_dir}) — "
            f"conf {old_conf}% → {conf}% ({_eff_adj:+d})")

    # ── Σ₀ expected-value gate (convergence_ev) ───────────────────────────────
    # Riley's detectors above (zone, 1-min structure, pattern, trend) become
    # WEIGHTED EVIDENCE; the ENTER/SKIP call is made on expected value instead of
    # the WAIT/GOOD/PERFECT discipline tiers Riley used for human error control.
    # The convergence record is stashed on `analysis["sigma0"]` so the API/page
    # can show the reasoning + a concrete entry/stop/target instruction. Active
    # unless SIGMA0_EV=0 (kill-switch); when active a SKIP vetoes the trade and an
    # ENTER is not allowed to be blocked by the legacy confidence threshold.
    try:
        from convergence_ev import score_convergence as _score_ev
    except Exception:
        _score_ev = None
    if _score_ev:
        _zone   = (riley.get("zone") or {}).get("nearest_zone") or {}
        _struct = riley.get("structure") or {}
        _pat    = {"PERFECT": "A", "GOOD": "B"}.get(riley.get("entry_quality"))
        # target_r must match the trade actually taken. calculate_smart_levels
        # uses a 3R structural setup, NOT the profile tp/stop percentages the EV
        # used to read (those never matched execution). Prefer the REALIZED
        # win/loss ratio (winners trail out before 3R), else the planned 3.0R.
        _tr     = _ev_realized_rr(ticker) or 3.0
        _dir    = analysis.get("direction", "NEUTRAL")
        # Live evidence (no longer neutral defaults): realized win-rate as the base
        # rate, directional news sentiment from the shared feed, and higher-tf trend
        # agreement from the consecutive-trend read computed upstream (if present).
        # Base rate: prefer REALIZED win-rate (≥5 closed trades); otherwise fall
        # back to the 90-day backtest hit-rate for this ticker+direction so the EV
        # agrees with the downstream backtest filter instead of optimistically
        # entering a historically-losing setup (#1623 — the SOLUSD case: realized
        # was thin → EV used a 0.5 prior and said ENTER while the 90d backtest was
        # 22%). run_backtest is cached, and it's called again downstream, so this
        # is free. Only trust it with a meaningful sample (≥10 setups).
        _wr = _ev_recent_win_rate(ticker)
        if _wr is None:
            try:
                _bt0 = run_backtest(ticker, analysis.get("direction", "NEUTRAL"), profile)
                if _bt0 and (_bt0.get("total_setups", 0) or 0) >= 10:
                    _wr = float(_bt0.get("win_rate") or 0.5)
            except Exception:
                pass
        _news   = _ev_news_sentiment(ticker)
        _consec = locals().get("_consec") or {}
        _hl, _lh = _consec.get("higher_lows", 0), _consec.get("lower_highs", 0)
        # Council input — saved on `analysis` so the post-Claude re-score (below)
        # can fold Claude's conviction in as a graded signal without rebuilding it.
        _ev_input = {
            "direction":         _dir,
            "grok_conf":         conf,   # Grok analyst — Claude folded in after its call
            "in_zone":           bool((riley.get("zone") or {}).get("in_zone")),
            "zone_strength":     _zone.get("strength", 0),
            "zone_touches":      _zone.get("touches", 0),
            "structure_shifted": bool(_struct.get("structure_shifted")),
            "structure_conf":    _struct.get("confidence", 0),
            "pattern_grade":     _pat,
            "trend_aligned":     (_dir == "BULLISH" and _hl >= 3) or (_dir == "BEARISH" and _lh >= 3),
            "trend_conflicts":   (_dir == "BULLISH" and _lh >= 3) or (_dir == "BEARISH" and _hl >= 3),
            "news_sentiment":    _news,
            "backtest_winrate":  _wr if _wr is not None else 0.5,
            "target_r":          _tr,
        }
        analysis["_sigma0_ev_input"] = _ev_input
        _ev = _score_ev(_ev_input, weights=_ev_adapted_weights())
        _ev["instruction"] = {
            "ticker": ticker, "direction": analysis.get("direction"),
            "entry":  round(price, 4),
            "stop":   round(price * (1 + float(profile.get("stop", -4)) / 100.0), 4),
            # target is _tr multiples of the stop distance (kept consistent with the
            # target_r fed to the gate); the executor's structural stop refines it.
            "target": round(price * (1 + _tr * abs(float(profile.get("stop", -4))) / 100.0), 4),
            "rr":     round(_tr, 2),
        }
        analysis["sigma0"] = _ev
        _side = analysis.get("direction", "NEUTRAL")
        _sidelbl = "LONG" if _side == "BULLISH" else "SHORT" if _side == "BEARISH" else "FLAT"
        log_agent("system", "SIGMA0",
            f"{ticker} {_sidelbl} EV {_ev['ev_r']:+.2f}R p_win {_ev['p_win']:.2f} → {_ev['decision']} "
            f"| {', '.join(_ev['why'])}")
        if os.getenv("SIGMA0_EV", "1") != "0":
            if _ev["decision"] == "SKIP":
                return {"status": "skipped", "ticker": ticker,
                        "reason": f"Σ₀ EV {_ev['ev_r']:+.2f}R / p_win {_ev['p_win']:.2f} below entry bar",
                        "confidence": conf, "direction": analysis.get("direction"),
                        "sigma0": _ev}
            threshold = min(threshold, conf)   # EV approved → conf bar can't veto it

    if conf < threshold:
        reason = f"Confidence {conf}% < threshold {threshold}%"
        if threshold != base_threshold:
            reason += f" (adaptive: base {base_threshold}% → {threshold}%)"
        log_agent("system", "SCANNER", f"{ticker} — {reason}")
        return {"status": "skipped", "ticker": ticker, "reason": reason,
                "direction": analysis.get("direction"), "confidence": conf}

    # ── Backtest check ────────────────────────────────────────────────────────
    # Run before Claude to save tokens if historical win rate is too poor
    profile   = get_profile(ticker)
    direction = analysis.get("direction", "BULLISH")
    bt        = run_backtest(ticker, direction, profile)

    # Backtest POOR (win rate < 35%) applies a -10 confidence penalty.
    # WEAK and MODERATE are informational only — passed to Claude as context.
    if bt.get("verdict") == "POOR":
        old_conf = analysis["confidence"]
        analysis["confidence"] = max(0, old_conf - 10)
        conf = analysis["confidence"]
        log_agent("system", "BACKTEST",
            f"{ticker} POOR backtest ({bt.get('summary','')[:60]}) "
            f"— conf {old_conf}% → {conf}% (-10)")

    # ── Multi-timeframe confirmation ──────────────────────────────────────────
    mtf = check_multi_timeframe(ticker, direction)

    if direction != "BULLISH":
        if not mtf["confirmed"] and mtf.get("alignment") != "TREND_OVERRIDE":
            # Weak MTF — timeframes contradict but don't hard block
            # Crypto: smaller penalty since crypto TFs contradict frequently
            adj = mtf.get("confidence_adjust", -5) if is_crypto(ticker) else mtf.get("confidence_adjust", -10)
            old_conf = conf
            conf = max(15, conf + adj)  # floor at 15% so crypto always reaches Riley
            analysis["confidence"] = conf
            log_agent("system", "MTF",
                f"{ticker} — weak MTF alignment: {mtf.get('summary','')} "
                f"— conf {old_conf}% → {conf}% ({adj:+d}), continuing to Riley gate")
        # TREND_OVERRIDE cases fall through to the with-trend flip logic below

        # Adjust confidence based on timeframe alignment
        # Note: weak MTF block above already applied adjustment for contradicting TFs
        # Only apply here for moderate/strong MTF cases (not already handled above)
        if mtf["confidence_adjust"] != 0 and mtf.get("confirmed", True):
            old_conf = analysis["confidence"]
            new_conf = max(15, old_conf + mtf["confidence_adjust"]) if is_crypto(ticker) \
                       else max(0, old_conf + mtf["confidence_adjust"])
            analysis["confidence"] = new_conf
            log_agent("system", "MTF",
                f"{ticker} confidence adjusted: {old_conf}% → {analysis['confidence']}% "
                f"({mtf['confidence_adjust']:+d} from MTF)")
    else:
        log_agent("system", "MTF", f"{ticker} long entry — MTF alignment gate skipped")

    conf      = analysis.get("confidence", 0)
    direction = analysis.get("direction", "NEUTRAL")

    # ── Signal flip check — close existing position if signal reverses ────────
    # Rules:
    # 1. SWING trades (EOD: HOLD) are protected — need 80%+ confidence AND 2h+ hold time
    # 2. DAY trades flip at 65%+ confidence
    # 3. Never flip in the last 15 min of the session (let EOD handle it)
    # 4. VIX ELEVATED/HIGH: flips disabled — only original stop/TP/trailing close positions
    _flip_regime = (vix_regime or {}).get("regime", "CALM")
    _flips_allowed = _flip_regime == "CALM"
    if not _flips_allowed and pos_side != "none":
        log_agent("system", "SCANNER",
            f"{ticker} signal flip suppressed (VIX {_flip_regime}) — "
            f"only mechanical stops can close positions in elevated volatility")
    flip_adj = _position_adjustments.get(ticker, {})
    flip_classification = flip_adj.get("classification", "DAY")
    flip_eod_action = flip_adj.get("eod_action", "CLOSE")
    is_swing = flip_eod_action == "HOLD" or flip_classification == "SWING"

    # Calculate how long position has been open
    entry_time_str = flip_adj.get("entry_time", "")
    hold_minutes = 999  # default to long time if unknown
    if entry_time_str:
        try:
            import dateutil.parser
            entry_dt = dateutil.parser.parse(entry_time_str)
            hold_minutes = (datetime.now(entry_dt.tzinfo) - entry_dt).total_seconds() / 60
        except Exception:
            pass

    # Flip thresholds
    flip_conf_needed = 80 if is_swing else 65
    flip_min_hold    = 120 if is_swing else 15  # minutes

    if _flips_allowed and pos_side == "long" and direction == "BEARISH" and conf >= flip_conf_needed and hold_minutes >= flip_min_hold:
        log_agent("system", "SCANNER",
            f"{ticker} FLIP: long→BEARISH {conf}% "
            f"(held {hold_minutes:.0f}min, {'SWING' if is_swing else 'DAY'}) "
            f"— closing long position first")
        try:
            for p in alpaca.list_positions():
                if p.symbol == ticker:
                    entry_p = float(p.avg_entry_price)
                    curr_p  = float(p.current_price)
                    qty_p   = float(p.qty)
                    pnl_p   = float(p.unrealized_plpc) * 100
                    close_position(ticker, qty_p,
                        f"Signal flip to BEARISH {conf}%",
                        notify_fn, entry_p, curr_p, pnl_p)
                    _position_adjustments.pop(ticker, None)
                    clear_position_state(ticker)
                    open_positions.pop(alpaca_symbol(ticker), None)
                    pos_side = "none"
                    break
        except Exception as e:
            log.warning("Flip close failed %s: %s", ticker, e)

    elif _flips_allowed and pos_side == "short" and direction == "BULLISH" and conf >= flip_conf_needed and hold_minutes >= flip_min_hold:
        log_agent("system", "SCANNER",
            f"{ticker} FLIP: short→BULLISH {conf}% "
            f"(held {hold_minutes:.0f}min, {'SWING' if is_swing else 'DAY'}) "
            f"— closing short position first")
        try:
            for p in alpaca.list_positions():
                if p.symbol == ticker:
                    entry_p = float(p.avg_entry_price)
                    curr_p  = float(p.current_price)
                    qty_p   = float(p.qty)
                    pnl_p   = float(p.unrealized_plpc) * 100
                    close_position(ticker, qty_p,
                        f"Signal flip to BULLISH {conf}%",
                        notify_fn, entry_p, curr_p, pnl_p)
                    _position_adjustments.pop(ticker, None)
                    clear_position_state(ticker)
                    open_positions.pop(alpaca_symbol(ticker), None)
                    pos_side = "none"
                    break
        except Exception as e:
            log.warning("Flip close failed %s: %s", ticker, e)

    elif pos_side != "none" and direction == "NEUTRAL":
        return {"status": "skipped", "ticker": ticker,
                "reason": f"Already {pos_side}, signal NEUTRAL — holding",
                "confidence": conf, "direction": direction,
                "catalyst": analysis.get("catalyst", "")}

    elif pos_side != "none" and direction == ("BULLISH" if pos_side == "long" else "BEARISH"):
        return {"status": "skipped", "ticker": ticker,
                "reason": f"Already {pos_side}, signal agrees — no action",
                "confidence": conf, "direction": direction,
                "catalyst": analysis.get("catalyst", "")}

    # ── Earnings risk gate ───────────────────────────────────────────────────
    if earnings is None:
        earnings = {"days_away": 999, "risk": "LOW", "date": None}

    if earnings["risk"] == "HIGH":
        old_conf = conf
        conf = max(0, conf - 20)
        analysis["confidence"] = conf
        log_agent("system", "EARNINGS",
            f"{ticker} earnings in {earnings['days_away']}d — "
            f"conf {old_conf}% → {conf}% (-20 binary event penalty)")

    # Earnings within a week — reduce confidence to tighten entry bar
    if earnings["risk"] == "MEDIUM":
        conf = max(0, conf - 8)
        analysis["confidence"] = conf
        log_agent("system", "EARNINGS",
            f"{ticker} earnings in {earnings['days_away']}d — "
            f"confidence reduced by 8pts → {conf}%")

    # ── Reversal zone check ───────────────────────────────────────────────────
    # Only enter when price is at a reversal zone — not mid-trend
    reversal = analyze_reversal_zone(ticker, price)

    # ── Trend vs Reversal decision ─────────────────────────────────────────────
    # High confidence (≥75%) + strong MTF alignment = allow trend entry
    # Otherwise require reversal zone confirmation
    # LONG entries skip this entirely — no zone requirement (see point 1/3).
    mtf_score_val  = mtf.get("score", 0) if mtf else 0
    # is_with_trend: True when MTF detected counter-trend and we're going to flip
    # We check MTF alignment directly since direction flip happens after this point
    is_with_trend  = (mtf and mtf.get("alignment") == "TREND_OVERRIDE" and
                      direction != mtf.get("override_direction", ""))  # signal != daily trend
    # With-trend flip = TREND mode regardless of MTF score
    # Counter-trend with high conf = also TREND mode
    trend_mode     = (conf >= 70 and mtf_score_val >= 2) or is_with_trend or \
                     (conf >= 80 and mtf and not mtf.get("confirmed", True))
    reversal_mode  = reversal["in_reversal_zone"]

    if direction == "BULLISH":
        analysis["trade_mode"] = "TREND"
        log_agent("system", "REVERSAL",
            f"{ticker} long entry — reversal zone requirement skipped (TREND mode)")
    else:
        # Override: with-trend flipped direction = always TREND mode
        if is_with_trend:
            analysis["trade_mode"] = "TREND"
        else:
            analysis["trade_mode"] = "TREND" if trend_mode and not reversal_mode else \
                                      "REVERSAL" if reversal_mode else "WAIT"

        if not trend_mode and not reversal_mode:
            if reversal["entry_quality"] == "NO":
                reason = f"No setup — not in reversal zone and confidence {conf}% < 75% for trend"
                log_agent("system", "REVERSAL", f"{ticker} SKIP — {reason}")
                return {"status":"skipped","ticker":ticker,"reason":reason,
                        "confidence":conf,"direction":direction,
                        "catalyst":analysis.get("catalyst","")}

            if reversal["entry_quality"] == "WAIT":
                reason = f"Reversal forming — {reversal['wait_for']}"
                log_agent("system", "REVERSAL",
                    f"{ticker} WAIT — RSI {reversal['rsi']:.0f} | {reversal['wait_for']}")

                # ── Riley watch mode ──────────────────────────────────────────────
                # In a 15-min zone with the 15-min trend aligned, just missing 1-min
                # confirmation — watch it instead of dropping it, capped at 2 tickers.
                _m15 = mtf.get("m15", "NEUTRAL") if mtf else "NEUTRAL"
                if (reversal.get("in_reversal_zone") and _m15 == direction
                        and ticker not in _watch_mode
                        and len(_watch_mode) < WATCH_MODE_MAX_TICKERS):
                    _watch_mode[ticker] = {
                        "ticker":          ticker,
                        "side":            "LONG" if direction == "BULLISH" else "SHORT",
                        "zone_level":      reversal.get("key_level", price),
                        "zone_strength":   reversal.get("strength", 0),
                        "confidence":      conf,
                        "riley_quality":   riley.get("entry_quality", ""),
                        "time_entered":    datetime.now().isoformat(),
                        "candles_checked": 0,
                        "trigger_level":   None,
                    }
                    log_agent("system", "WATCH",
                        f"WATCH MODE: {ticker} added — waiting for 1-min confirmation "
                        f"({'LONG' if direction == 'BULLISH' else 'SHORT'} @ zone "
                        f"${reversal.get('key_level', price):.4f}, str={reversal.get('strength', 0)})")

                return {"status":"skipped","ticker":ticker,"reason":reason,
                        "confidence":conf,"direction":direction,
                        "catalyst":analysis.get("catalyst","")}

        if trend_mode and not reversal_mode:
            log_agent("system", "REVERSAL",
                f"{ticker} TREND MODE — conf {conf}% ≥75% + all 3 TFs aligned | "
                f"RSI {reversal['rsi']:.0f} not at extreme — following trend")
            analysis["confidence"] = min(100, conf + 5)  # small boost for strong trend

        # Boost confidence for high-quality reversal setups
        if reversal["entry_quality"] == "IDEAL":
            old_conf = analysis["confidence"]
            analysis["confidence"] = min(100, old_conf + 8)
            log_agent("system", "REVERSAL",
                f"{ticker} IDEAL reversal — conf {old_conf}%→{analysis['confidence']}% "
                f"RSI {reversal['rsi']:.0f} strength {reversal['strength']} "
                f"level ${reversal['key_level']:.2f}")
        elif reversal["entry_quality"] == "GOOD" and reversal_mode:
            log_agent("system", "REVERSAL",
                f"{ticker} GOOD reversal — RSI {reversal['rsi']:.0f} | "
                f"strength {reversal['strength']} | level ${reversal['key_level']:.2f}")

    # ── Time-of-day confidence adjustment ─────────────────────────────────────
    # Replaces the old strength multiplier in analyze_reversal_zone.
    # Keeps zone strength honest; adjusts confidence directly instead.
    # Not applied to crypto (24/7 market, no opening-hour concept).
    if not is_crypto(ticker):
        _tod = reversal.get("tod_multiplier", 1.0)
        _tod_label = reversal.get("tod_label", "")
        if _tod < 1.0:
            _tod_pen = min(10, round((1.0 - _tod) * 60))  # 0.85 → 9, capped at 10
            old_conf = analysis["confidence"]
            analysis["confidence"] = max(0, old_conf - _tod_pen)
            conf = analysis["confidence"]
            log_agent("system", "REVERSAL",
                f"{ticker} {_tod_label} penalty: {old_conf}% → {conf}% (-{_tod_pen})")
        elif _tod >= 1.15:
            _tod_bon = min(5, round((_tod - 1.0) * 20))   # 1.30 → 6, capped at 5
            old_conf = analysis["confidence"]
            analysis["confidence"] = min(100, old_conf + _tod_bon)
            conf = analysis["confidence"]
            log_agent("system", "REVERSAL",
                f"{ticker} {_tod_label} bonus: {old_conf}% → {conf}% (+{_tod_bon})")

    if direction != "BULLISH":
        if not riley["approved"] and riley["entry_quality"] == "NO":
            # Hard block — price is not near any valid S/R zone. No exceptions.
            # High Grok confidence does not override this: zone confirmation is required.
            riley_reason = riley.get("reason", "")
            log_agent("system", "RILEY",
                f"{ticker} HARD BLOCKED (Riley NO) — {riley_reason[:80]}")
            return {"status": "skipped", "ticker": ticker,
                    "reason": f"Riley NO: {riley_reason}",
                    "confidence": conf, "direction": direction,
                    "catalyst": analysis.get("catalyst", "")}

        if not riley["approved"] and riley["entry_quality"] == "WAIT":
            # Confidence penalty: -25 (was -10). Makes it very unlikely to pass threshold
            # without a strong signal — zone structure shift still not confirmed.
            wait_key   = f"_riley_wait_{ticker}"
            wait_count = getattr(scan_all, wait_key, 0) + 1
            setattr(scan_all, wait_key, wait_count)
            old_conf = analysis["confidence"]
            analysis["confidence"] = max(0, old_conf - 25)
            conf = analysis["confidence"]
            log_agent("system", "RILEY",
                f"{ticker} WAIT×{wait_count} — conf {old_conf}% → {conf}% (-25) "
                f"| {riley['reason']}")

        # ── Minimum zone strength requirement: 60/100 ─────────────────────────────
        # Filters out setups where the nearest zone is too weak to be meaningful.
        # Applied after the WAIT penalty so low-strength WAITs are also caught.
        _sr_data = riley.get("zone", {})
        _zone_str = (_sr_data.get("zone_strength", 0) if _sr_data.get("in_zone")
                     else (_sr_data.get("nearest_zone") or {}).get("strength", 0))
        if _zone_str < 60:
            log_agent("system", "RILEY",
                f"{ticker} BLOCKED — zone strength {_zone_str}/100 below minimum 60 "
                f"(quality: {riley['entry_quality']}, "
                f"dist: {_sr_data.get('dist_to_nearest', 99):.1f}%)")
            return {"status": "skipped", "ticker": ticker,
                    "reason": f"Zone strength {_zone_str}/100 below minimum 60",
                    "confidence": conf, "direction": direction,
                    "catalyst": analysis.get("catalyst", "")}

        # Riley Rule: HEALTHY (stair-step) approach to zone = SKIP
        # UNHEALTHY (parabolic) approach = HIGH probability reversal
        sr_data = riley.get("zone", {})
        if sr_data.get("unhealthy_approach"):
            old_conf = analysis["confidence"]
            analysis["confidence"] = min(100, old_conf + 12)
            log_agent("system", "RILEY",
                f"{ticker} UNHEALTHY APPROACH boost: {old_conf}% → "
                f"{analysis['confidence']}% | {sr_data.get('approach_desc','')}")
        else:
            # Healthy methodical (stair-step) approach — Riley says this is more
            # likely to BREAK THROUGH the zone than reverse off it. Skip the
            # reversal entry entirely and watch instead for a continuation
            # break-and-retest: price breaks the zone, pulls back to it, and
            # shows a 1-min micro-reversal in the breakout direction.
            if sr_data.get("in_zone") or sr_data.get("dist_to_nearest", 99) < 1.5:
                _nz = sr_data.get("nearest_zone") or {}
                _zone_level = _nz.get("mid", price)
                _zone_type  = _nz.get("type", "NONE")

                # A clear, strong bait candle that confirms a direction at the zone
                # overrides the generic "healthy approach = continuation" assumption.
                # A confirmed BEARISH bait candle at SUPPORT is a bearish signal —
                # support is likely to fail — so watch SHORT (not skip as a blocked
                # reversal). A confirmed BULLISH bait candle at RESISTANCE is a
                # bullish signal — resistance is likely to fail — so watch LONG.
                # Only fall back to the generic zone-type-based continuation
                # direction when no such pattern confirms a direction.
                _struct       = riley.get("structure", {}) or {}
                _entry_candle = _struct.get("entry_candle")
                _candle_str   = _struct.get("candle_strength", 0) or 0
                _bait_side    = None
                if _candle_str >= 65:
                    if _entry_candle == "BAIT_CANDLE_BEARISH" and _zone_type == "SUPPORT":
                        _bait_side = "SHORT"
                    elif _entry_candle == "BAIT_CANDLE_BULLISH" and _zone_type == "RESISTANCE":
                        _bait_side = "LONG"

                if _bait_side:
                    _watch_side   = _bait_side
                    _watch_reason = (f"{_entry_candle} confirmed at {_zone_type} — "
                                     f"watching for {_watch_side} break-and-retest")
                    log_agent("system", "RILEY",
                        f"{ticker} {_entry_candle} (strength {_candle_str}) confirmed at "
                        f"{_zone_type} — triggering {_watch_side} watch via break-and-retest "
                        f"(not skipped as a reversal)")
                else:
                    # Resistance breaks UP → continuation long; support breaks DOWN → continuation short
                    _watch_side   = "LONG" if _zone_type == "RESISTANCE" else "SHORT"
                    _watch_reason = "Healthy approach — watching for continuation break-and-retest"
                    log_agent("system", "RILEY",
                        f"{ticker} HEALTHY approach — skipping reversal, "
                        f"watching for continuation break-and-retest")

                if (ticker not in _watch_mode
                        and len(_watch_mode) < WATCH_MODE_MAX_TICKERS):
                    _watch_mode[ticker] = {
                        "ticker":          ticker,
                        "side":            _watch_side,
                        "zone_level":      _zone_level,
                        "zone_strength":   _nz.get("strength", _zone_str),
                        "confidence":      conf,
                        "riley_quality":   riley.get("entry_quality", ""),
                        "time_entered":    datetime.now().isoformat(),
                        "candles_checked": 0,
                        "trigger_level":   None,
                        "continuation":    True,
                        "awaiting_break":  True,
                    }
                return {"status": "skipped", "ticker": ticker,
                        "reason": _watch_reason,
                        "confidence": conf, "direction": direction,
                        "catalyst": analysis.get("catalyst", "")}

        # Note: no confidence penalties here — Riley's healthy/minor zone concerns
        # are handled by the WAIT gate (structure shift required) and Claude's
        # final judgment. Penalties here were causing too many false negatives.

        # Boost confidence for high-quality Riley setups
        if riley["confidence_boost"] > 0:
            old_conf = analysis["confidence"]
            analysis["confidence"] = min(100, old_conf + riley["confidence_boost"])
            log_agent("system", "RILEY",
                f"{ticker} {riley['entry_quality']} setup — "
                f"conf {old_conf}% → {analysis['confidence']}% "
                f"(+{riley['confidence_boost']}) | {riley['reason']}")
    else:
        log_agent("system", "RILEY",
            f"{ticker} long entry — Riley gate scoring, zone requirement, and "
            f"candle pattern confirmation skipped")

    analysis["riley_quality"]    = riley["entry_quality"]
    analysis["riley_zone"]       = riley["zone"].get("zone_type", "NONE")
    analysis["riley_touches"]    = riley["zone"].get("nearest_zone", {}).get("touches", 0)
    analysis["riley_structure"]  = riley["structure"].get("shift_type", "NONE")
    analysis["riley_exhaustive"] = riley["structure"].get("exhaustive", False)
    analysis["riley_candle"]     = riley["structure"].get("entry_candle", "NONE")
    analysis["riley_candle_str"] = riley["structure"].get("candle_strength", 0)

    # ── SHORT entry hard gate (Riley logic) ───────────────────────────────────
    # All four conditions required for a short — if any is missing, skip:
    #   1. Price at a RESISTANCE zone, strength >= 70, 2+ touches
    #   2. 1-min structure shift confirmed
    #   3. Bait candle, H&S, or double-top pattern detected
    #   4. Grok BEARISH confidence >= 65%
    if direction == "BEARISH":
        _short_zone   = riley.get("zone", {}) or {}
        _short_nz     = _short_zone.get("nearest_zone") or {}
        _short_struct = riley.get("structure", {}) or {}

        _at_resistance = (
            bool(_short_zone.get("in_zone"))
            and _short_nz.get("type") == "RESISTANCE"
            and (_short_nz.get("strength", 0) or 0) >= 70
            and (_short_nz.get("touches", 0) or 0) >= 2
        )
        _structure_ok = bool(_short_struct.get("structure_shifted"))
        _pattern_ok   = _short_struct.get("entry_candle") in (
            "BAIT_CANDLE_BEARISH", "HEAD_AND_SHOULDERS", "DOUBLE_TOP")
        _conf_ok = conf >= 65

        if not (_at_resistance and _structure_ok and _pattern_ok and _conf_ok):
            _missing = []
            if not _at_resistance:
                _missing.append(
                    f"resistance zone strength>=70/2+touches (have: "
                    f"{_short_nz.get('type','NONE')} "
                    f"strength={_short_nz.get('strength',0)} "
                    f"touches={_short_nz.get('touches',0)})")
            if not _structure_ok:
                _missing.append("1-min structure shift not confirmed")
            if not _pattern_ok:
                _missing.append(
                    f"no bait/H&S/double-top pattern "
                    f"(have: {_short_struct.get('entry_candle','NONE')})")
            if not _conf_ok:
                _missing.append(f"BEARISH confidence >=65% (have {conf}%)")
            reason = "Short gate failed — " + "; ".join(_missing)
            log_agent("system", "RILEY", f"{ticker} SHORT BLOCKED — {reason}")
            return {"status": "skipped", "ticker": ticker, "reason": reason,
                    "confidence": conf, "direction": direction,
                    "catalyst": analysis.get("catalyst", "")}

    # ── Cache zones for dashboard /api/zones ──────────────────────────────────
    try:
        _zone_data = riley.get("zone", {})
        _zones_list = list(_zone_data.get("zones", []))
        # Mark which zone triggered the entry (nearest approved zone)
        _nearest = _zone_data.get("nearest_zone")
        if _nearest and riley.get("entry_quality") in ("PERFECT", "GOOD"):
            for z in _zones_list:
                if abs((z.get("mid", 0) - _nearest.get("mid", 0))) < 0.01:
                    z["triggered_entry"] = True
                    break
        _last_zones[ticker] = {
            "zones":          _zones_list,
            "in_zone":        _zone_data.get("in_zone", False),
            "riley_result":   riley.get("entry_quality", ""),
            "confidence":     analysis.get("confidence", 0),
            "direction":      analysis.get("direction", "NEUTRAL"),
            "catalyst":       analysis.get("catalyst", ""),
            "candle_pattern": analysis.get("riley_candle", "NONE"),
            "timestamp":      datetime.now().isoformat(),
        }
    except Exception:
        pass

    # ── Counter-direction evaluation (dual-direction scanning) ────────────────
    # Evaluate the OPPOSITE direction using already-fetched zone/RSI/MTF data.
    # No extra API calls — reuses riley["zone"] (sr), reversal["rsi"], and mtf.
    # Presented to Claude alongside the primary signal so it can pick the better
    # setup or HOLD if neither is strong enough.
    analysis["counter_conf"]   = 0
    analysis["counter_reason"] = ""
    if direction in ("BULLISH", "BEARISH") and not is_crypto(ticker):
        counter_dir = "BEARISH" if direction == "BULLISH" else "BULLISH"
        # Only compute counter for SHORT if ticker is shortable
        if counter_dir == "BEARISH" and not can_short(ticker):
            pass  # can't short this ticker, skip counter
        else:
            try:
                _rsi_val = reversal.get("rsi", 50)
                c_score, c_reason = _score_counter_direction(
                    riley.get("zone", {}), counter_dir, _rsi_val, mtf)
                analysis["counter_conf"]   = c_score
                analysis["counter_reason"] = c_reason
                if c_score >= 50:
                    log_agent("system", "SCANNER",
                        f"{ticker} counter-{counter_dir}: {c_score}% | {c_reason[:60]}")
            except Exception as _ce:
                log.debug("Counter direction failed %s: %s", ticker, _ce)

    # ── Trade classifier — DAY vs SWING ──────────────────────────────────
    try:
        classification = agent_trade_classifier(
            ticker, price, analysis, mtf=mtf
        )
    except Exception as e:
        log.warning("Classifier error %s: %s", ticker, e)
        classification = {"classification":"DAY","eod_action":"CLOSE",
                          "stop_pct":-2.5,"tp_pct":4.0,"hold_period":"intraday",
                          "reasoning":"fallback"}

    # Override profile stop/tp with classifier values
    profile_override = dict(profile)
    profile_override["stop"] = classification["stop_pct"]
    profile_override["tp"]   = classification["tp_pct"]

    # Add reversal context to analysis for Claude
    analysis["reversal_zone"]    = reversal["zone_type"]
    analysis["reversal_strength"]= reversal["strength"]
    analysis["reversal_quality"] = reversal["entry_quality"]
    analysis["key_level"]        = reversal["key_level"]
    if portfolio_delta:
        analysis["portfolio_delta_pct"]  = portfolio_delta["net_delta_pct"]
        analysis["portfolio_overexposed"]= portfolio_delta["overexposed"]

    try:
        decision = agent_claude_decision(ticker, price, analysis, equity,
                                         backtest=bt, mtf=mtf,
                                         profile_override=profile_override,
                                         earnings=earnings,
                                         trade_mode=analysis.get("trade_mode", "REVERSAL"))
        decision["confidence"]      = conf
        decision["direction"]       = analysis.get("direction", "")
        decision["classification"]  = classification["classification"]
        decision["eod_action"]      = classification["eod_action"]
        decision["hold_period"]     = classification["hold_period"]
        log_agent("claude", "CLAUDE",
            f"{ticker} → {decision.get('action')} | "
            f"[{classification['classification']}/{classification['hold_period']}] | "
            f"{decision.get('reasoning')}")
    except Exception as e:
        log_agent("system", "CLAUDE", f"Error {ticker}: {e}")
        return {"status": "skipped", "ticker": ticker, "reason": f"Claude error: {e}"}

    # ── Σ₀ council final decision — Grok + Claude folded in as graded evidence ──
    # Claude is no longer a hard gate. Its directional conviction becomes the
    # `claude` council signal and the Σ₀ EV re-scores with BOTH grok + claude; the
    # combined EV is the sole ENTER/SKIP authority (portfolio risk stays enforced
    # downstream by agent_risk_manager — Claude's HOLD was redundant with it). Set
    # SIGMA0_EV=0 to restore the legacy Claude-veto behavior.
    _ev_input = analysis.get("_sigma0_ev_input")
    if os.getenv("SIGMA0_EV", "1") != "0" and _ev_input and _score_ev:
        _cl_action = (decision.get("action") or "HOLD").upper()
        _cl_dir = {"BUY": "BULLISH", "SELL": "BEARISH"}.get(_cl_action, "NEUTRAL")
        if _cl_dir == "NEUTRAL":
            _claude_conf = 35            # HOLD — a lean against, not a veto
        elif _cl_dir == analysis.get("direction"):
            _claude_conf = 78            # confirms the trade direction
        else:
            _claude_conf = 15            # opposes the trade direction
        _ev2_input = dict(_ev_input); _ev2_input["claude_conf"] = _claude_conf
        _ev2 = _score_ev(_ev2_input, weights=_ev_adapted_weights())
        _ev2["instruction"] = (analysis.get("sigma0") or {}).get("instruction")
        analysis["sigma0"] = _ev2       # graded + persisted on the entry record
        log_agent("system", "SIGMA0",
            f"{ticker} council EV {_ev2['ev_r']:+.2f}R p_win {_ev2['p_win']:.2f} "
            f"→ {_ev2['decision']} | claude {_cl_action}({_claude_conf}) "
            f"| {', '.join(_ev2['why'])}")
        if _ev2["decision"] == "SKIP":
            return {"status": "skipped", "ticker": ticker,
                    "reason": f"Σ₀ council EV {_ev2['ev_r']:+.2f}R / p_win {_ev2['p_win']:.2f} below entry bar",
                    "direction": analysis.get("direction"), "confidence": conf,
                    "action": "HOLD", "catalyst": analysis.get("catalyst", ""),
                    "grok_score": analysis.get("confidence", conf), "sigma0": _ev2}
        # Council says ENTER — override a Claude HOLD/no-execute into the directional
        # order. size_pct is already clamped to profile min/max (agent_claude_decision),
        # so it is a valid size even when Claude declined.
        if not decision.get("execute") or _cl_action == "HOLD":
            decision["execute"] = True
            decision["action"] = "BUY" if analysis.get("direction") == "BULLISH" else "SELL"
            log_agent("system", "SIGMA0",
                f"{ticker} council overrides Claude HOLD → {decision['action']} (EV +)")
    elif not decision.get("execute") or decision.get("action") == "HOLD":
        # Legacy: Claude HOLD / no-execute is a hard veto (SIGMA0_EV=0).
        reason = decision.get("reasoning", "No clear signal")
        log_agent("system", "CLAUDE", f"{ticker} — {reason}")
        return {"status": "skipped", "ticker": ticker, "reason": reason,
                "direction": analysis.get("direction"), "confidence": conf,
                "action": "HOLD", "catalyst": analysis.get("catalyst",""),
                "grok_score": analysis.get("confidence", conf)}

    try:
        risk = agent_risk_manager(ticker, price, decision, equity, open_positions)
        approved = risk.get("approved")
        log_agent("risk", "RISK",
            f"{ticker} → {'OK' if approved else 'BLOCKED'} | {risk.get('reason')}")
    except Exception as e:
        log_agent("system", "RISK", f"Error {ticker}: {e}")
        return {"status": "skipped", "ticker": ticker, "reason": f"Risk error: {e}"}

    if not risk.get("approved"):
        reason = risk.get("reason", "Risk check failed")
        return {"status": "skipped", "ticker": ticker, "reason": f"Risk blocked: {reason}",
                "direction": analysis.get("direction"), "confidence": conf}

    # Apply VIX size multiplier — reduces position size in fearful markets
    vix_multiplier = vix_regime.get("size_multiplier", 1.0)
    final_size     = round(risk["size_pct"] * vix_multiplier, 2)

    if vix_multiplier < 1.0:
        log_agent("system", "VIX",
            f"{ticker} size reduced by VIX: {risk['size_pct']}% × {vix_multiplier} "
            f"= {final_size}%")

    # ── Opening hour throttle: max 2 new entries in 9:30-10:00am ET ──────────
    # Opening volatility makes reversal entries unreliable on VIX 20+ days.
    if not is_crypto(ticker):
        import pytz as _ptz
        _et_now = datetime.now(_ptz.timezone("America/New_York"))
        _hour_frac = _et_now.hour + _et_now.minute / 60
        if 9.5 <= _hour_frac < 10.0:
            _today = _et_now.strftime("%Y-%m-%d")
            _oh_entries = getattr(scan_all, "_opening_entries", {})
            if _oh_entries.get(_today, 0) >= 2:
                reason = "Opening hour throttle — max 2 entries in 9:30-10:00am ET"
                log_agent("risk", "RISK", f"{ticker} — {reason}")
                return {"status": "skipped", "ticker": ticker, "reason": reason,
                        "confidence": conf, "direction": direction}

    # ── Riley Coleman levels: structural stop, fixed-$-risk sizing, 3R TP ─────
    # Computed BEFORE the order so the share count reflects the actual risk.
    action = decision["action"]
    # Edge-proportional risk (bounded half-Kelly) from the Σ₀ EV conviction.
    # Default 1.0 (flat risk) unless SIGMA0_EDGE_SIZING is on and this entry has a
    # scored convergence record — then bet more on high-p_win / high-R setups.
    _risk_mult = 1.0
    if os.getenv("SIGMA0_EDGE_SIZING", "1") != "0":
        _s0 = analysis.get("sigma0") or {}
        if _s0.get("p_win") is not None:
            try:
                from convergence_ev import edge_risk_multiplier as _erm
                _risk_mult = _erm(_s0.get("p_win"), _s0.get("target_r"))
            except Exception:
                _risk_mult = 1.0
    levels = calculate_smart_levels(ticker, price, action, profile_override or profile,
                                    risk_multiplier=_risk_mult)
    if levels.get("skip"):
        log_agent("system", "RILEY", f"{ticker} entry skipped — {levels.get('reason')}")
        return {"status": "skipped", "ticker": ticker, "reason": levels.get("reason"),
                "confidence": conf, "direction": direction}

    result = place_order(
        ticker       = ticker,
        action       = decision["action"],
        size_pct     = final_size,
        price        = price,
        order_type   = decision.get("order_type", "MARKET"),
        limit_price  = decision.get("limit_price"),
        qty_override = levels.get("shares"),
    )

    log_agent("system", "EXECUTOR",
        f"{'OK' if result.get('status')=='placed' else 'FAIL'} "
        f"{decision['action']} {result.get('qty','?')} {ticker} @ ${price:.2f}")

    if result.get("status") in ("placed", "simulated"):
        # Reset WAIT counter — trade placed, fresh start next scan
        setattr(scan_all, f"_riley_wait_{ticker}", 0)
        # Track opening hour entries for throttle
        if not is_crypto(ticker):
            import pytz as _ptz2
            _et_now2 = datetime.now(_ptz2.timezone("America/New_York"))
            if 9.5 <= (_et_now2.hour + _et_now2.minute / 60) < 10.0:
                _today2 = _et_now2.strftime("%Y-%m-%d")
                _oh = getattr(scan_all, "_opening_entries", {})
                _oh[_today2] = _oh.get(_today2, 0) + 1
                scan_all._opening_entries = _oh
        # Store Riley smart price levels — computed above, before the order
        _position_adjustments[ticker] = {
            "stop_price":         levels["stop_price"],
            "initial_stop_price": levels["stop_price"],
            "tp_price":       levels["tp_price"],
            "classification": decision.get("classification", "DAY"),
            "eod_action":     decision.get("eod_action", "CLOSE"),
            "hold_period":    decision.get("hold_period", "intraday"),
            "entry_time":     datetime.now().isoformat(),  # for flip protection and hold duration
            "position_side":  "short" if decision["action"] == "SELL" else "long",
            "entry_price":    price,
            "peak_price":     price,
        }
        # Σ₀ convergence record (Act) — emit + stash the id/p_win/signals so the
        # close handler can grade this exact entry against its outcome.
        _sig0 = analysis.get("sigma0")
        if _sig0:
            try:
                _rid = _conv_emit_entry(ticker, analysis.get("direction"),
                                        result.get("order_id") or result.get("id"), _sig0)
                _position_adjustments[ticker]["sigma0_record_id"] = _rid
                _position_adjustments[ticker]["sigma0_pwin"] = _sig0.get("p_win")
                _position_adjustments[ticker]["sigma0_signals"] = _sig0.get("signals")
            except Exception as _e:
                log.warning("sigma0 convergence emit failed %s: %s", ticker, _e)
        save_position_state(ticker, _position_adjustments[ticker])  # persist
        log_agent("system", "LEVELS",
            f"{ticker} levels set: Stop ${levels['stop_price']:.4f} "
            f"({levels['stop_pct']:+.1f}%) | TP ${levels['tp_price']:.4f} "
            f"({levels['tp_pct']:+.1f}%) | {levels['stop_reason']}")

        # Log to persistent trade history
        log_trade_history(
            symbol     = ticker,
            action     = decision["action"],
            qty        = float(result.get("qty", 0)),
            entry_price= price,
            confidence = analysis.get("confidence", 0),
            reasoning  = decision.get("reasoning", ""),
            style      = profile["style"],
            stop_pct   = levels.get("stop_pct"),
        )

    if notify_fn and result.get("status") in ("placed", "simulated"):
        action_label  = decision["action"]
        is_short_trade = action_label == "SELL" and pos_side == "none"
        levels = _position_adjustments.get(ticker, {})
        stop_p = levels.get("stop_price", price * (1 + profile["stop"]/100))
        tp_p   = levels.get("tp_price",   price * (1 + profile["tp"]  /100))
        stop_pct_disp = (stop_p - price) / price * 100
        tp_pct_disp   = (tp_p   - price) / price * 100
        try:
            cls   = decision.get("classification","?")
            hold  = decision.get("hold_period","?")
            _crypto_pos   = is_crypto(ticker)
            _entry_icon   = "₿"   if _crypto_pos else ("📈" if action_label == "BUY" else "🩳")
            _entry_label  = ("₿ LONG" if action_label == "BUY" else "₿ SHORT") if _crypto_pos \
                            else ("🟢 LONG" if action_label == "BUY" else "🔴 SHORT")
            notify_fn(
                f"{_entry_icon} "
                f"*Position Entered: {ticker}*\n"
                f"{_entry_label} @ ${price:.4f}\n"
                f"📊 Qty: {result.get('qty','?')} | "
                f"Riley risk: ${levels.get('target_risk','?')} "
                f"({levels.get('shares','?')} sh)\n"
                f"🎯 Confidence: {analysis.get('confidence')}%\n"
                f"📋 Type: {'📅 SWING' if cls=='SWING' else '⚡ DAY'} — {hold}\n"
                f"🛑 Stop: ${stop_p:.4f} ({stop_pct_disp:+.1f}%)\n"
                f"✅ TP:   ${tp_p:.4f} ({tp_pct_disp:+.1f}%)\n"
                f"💡 {decision.get('reasoning')}\n"
                f"⚠️ {analysis.get('risk')}"
            )
        except Exception as e:
            log.warning("Telegram notify failed: %s", e)

    # Carry the Σ₀ convergence record + entry/stop/target instruction onto the
    # executed signal so the API/page can show WHAT was entered and why.
    if isinstance(result, dict):
        result.setdefault("ticker", ticker)
        result.setdefault("direction", analysis.get("direction"))
        if analysis.get("sigma0"):
            result["sigma0"] = analysis["sigma0"]
    return result

# ── Σ₀ scan cache (Remember-stage retrieval) ──────────────────────────────────
# The batch Grok read is the recurring per-scan cost: it runs for every ticker
# every minute, even when nothing moved. When a ticker's price is essentially
# unchanged since its last read, the directional analysis is too — so reuse it
# instead of paying for the model again. This is the convergence-router pattern:
# retrieve the prior decision rather than recompute it. SAFE because the grounding
# signals (zone / 1-min structure / pattern / EV) are still recomputed fresh
# downstream every scan, and ENTER requires fresh grounding
# (convergence_ev.has_evidence) — a reused read can never manufacture a trade. The
# model is spent only when price actually moves. Kill-switch: SIGMA0_SCAN_CACHE=0.
_SCAN_CACHE_ON   = os.getenv("SIGMA0_SCAN_CACHE", "1") != "0"
_SCAN_CACHE_BAND = float(os.getenv("SIGMA0_SCAN_CACHE_BAND", "0.0015"))  # 0.15% price move = "unchanged"
_SCAN_CACHE_TTL  = float(os.getenv("SIGMA0_SCAN_CACHE_TTL", "600"))      # re-read at least every 10 min
# The engine is spawned as a fresh process per scan (see lib/trader-agent.js), so
# module memory won't survive between scans — the cache lives on disk.
_SCAN_CACHE_FILE = os.path.join(os.path.dirname(__file__), "..", "..",
                                "data", "lantern-garage", "trading", "scan-llm-cache.json")


def _scan_cache_load() -> dict:
    """ticker -> [price, analysis, ts]. Missing/corrupt file → empty."""
    if not _SCAN_CACHE_ON:
        return {}
    try:
        with open(_SCAN_CACHE_FILE) as f:
            return json.load(f) or {}
    except Exception:
        return {}


def _scan_cache_save(cache: dict):
    """Persist atomically, dropping entries older than 3×TTL to bound the file."""
    if not _SCAN_CACHE_ON:
        return
    try:
        now = datetime.now().timestamp()
        cache = {t: v for t, v in cache.items()
                 if isinstance(v, (list, tuple)) and len(v) == 3 and (now - v[2]) < _SCAN_CACHE_TTL * 3}
        os.makedirs(os.path.dirname(_SCAN_CACHE_FILE), exist_ok=True)
        tmp = _SCAN_CACHE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(cache, f)
        os.replace(tmp, _SCAN_CACHE_FILE)
    except Exception:
        pass


def _scan_cache_partition(targets: list, prices: dict, cache: dict):
    """Split targets into (fresh, cached_results). A ticker is served from cache
    when its price moved < BAND since its cached read AND it is younger than TTL."""
    if not _SCAN_CACHE_ON:
        return list(targets), {}
    now = datetime.now().timestamp()
    fresh, cached = [], {}
    for t in targets:
        px = prices.get(t, 0) or 0
        ent = cache.get(t)
        if (ent and len(ent) == 3 and px > 0 and ent[0] > 0
                and (now - ent[2]) < _SCAN_CACHE_TTL
                and abs(px / ent[0] - 1.0) < _SCAN_CACHE_BAND):
            cached[t] = dict(ent[1])       # reuse the prior directional read
        else:
            fresh.append(t)
    return fresh, cached


# ── Σ₀ grounding pre-gate (Reason-stage routing) ──────────────────────────────
# Spend the model only on tickers that could actually produce a trade. ENTER
# requires convergence_ev.has_evidence — ≥1 grounding signal (zone / 1-min
# structure / pattern / trend / news). Riley short-circuits when far from a zone
# (find_sr_zones), so zone/structure/pattern grounding can ONLY exist near a zone.
# Therefore a ticker that is far from every zone AND has no multi-bar trend AND no
# news lean is guaranteed to SKIP — calling the LLM for it is wasted. This gate is
# deliberately CONSERVATIVE and direction-agnostic: near a zone → keep and let the
# full flow decide; held positions always pass (they still need exit/flip scans);
# any error → keep (fail-open). It can never drop a setup the full flow would take.
# Kill-switch: SIGMA0_PREGATE=0.
_PREGATE_ON        = os.getenv("SIGMA0_PREGATE", "1") != "0"
_PREGATE_ZONE_PROX = float(os.getenv("SIGMA0_PREGATE_ZONE_PROX", "3.5"))  # % to a zone that still "counts"


def _has_grounding(ticker: str, price: float, open_positions: dict = None) -> bool:
    if not _PREGATE_ON:
        return True
    try:
        if open_positions and get_position_side(ticker, open_positions) != "none":
            return True                                   # never gate a held position
        sr = find_sr_zones(ticker, price)
        if sr.get("in_zone") or float(sr.get("dist_to_nearest", 99) or 99) <= _PREGATE_ZONE_PROX:
            return True                                   # at/near a zone — let the full flow decide
        _c = _riley_detect_consecutive_trend(ticker) or {}
        if int(_c.get("higher_lows", 0) or 0) >= 3 or int(_c.get("lower_highs", 0) or 0) >= 3:
            return True                                   # a real multi-bar trend can ground it
        if abs(float(_ev_news_sentiment(ticker) or 0.0)) >= 0.2:
            return True                                   # a real news lean can ground it
        return False                                      # far from any zone, trendless, newsless → would SKIP
    except Exception:
        return True                                       # fail-open: never drop on error


# ── Σ₀ LLM-usage counter (so the reduction is observable) ─────────────────────
_LLM_USAGE_FILE = os.path.join(os.path.dirname(__file__), "..", "..",
                               "data", "lantern-garage", "trading", "llm-usage.json")


def _log_llm_usage(reads_made: int, saved_cache: int, saved_pregate: int, candidates: int):
    """Tally Stage-2 model reads vs reads avoided (cache + pre-gate), per day, so
    the API-spend reduction is visible in the feed and on disk. Never breaks a scan."""
    try:
        try:
            with open(_LLM_USAGE_FILE) as f:
                data = json.load(f) or {}
        except Exception:
            data = {}
        day = datetime.now().strftime("%Y-%m-%d")
        e = data.get(day) or {"reads_made": 0, "saved_cache": 0, "saved_pregate": 0,
                              "candidates": 0, "scans": 0}
        e["reads_made"]    += int(reads_made)
        e["saved_cache"]   += int(saved_cache)
        e["saved_pregate"] += int(saved_pregate)
        e["candidates"]    += int(candidates)
        e["scans"]         += 1
        data[day] = e
        for _old in sorted(data)[:-30]:                   # keep ~30 days
            data.pop(_old, None)
        os.makedirs(os.path.dirname(_LLM_USAGE_FILE), exist_ok=True)
        tmp = _LLM_USAGE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, _LLM_USAGE_FILE)
        saved = e["saved_cache"] + e["saved_pregate"]
        tot = e["reads_made"] + saved
        pct = (100 * saved // tot) if tot else 0
        log_agent("system", "SIGMA0",
            f"LLM reads — this scan: {reads_made} made, {saved_cache + saved_pregate} saved "
            f"({saved_cache} cache + {saved_pregate} pre-gate) | today: {e['reads_made']} made / "
            f"{saved} saved ({pct}% avoided) over {e['scans']} scans")
    except Exception:
        pass


# ── Main scan ─────────────────────────────────────────────────────────────────

def scan_all(watchlist: list, notify_fn=None) -> list:
    """Smart scan with VIX regime + market condition routing."""
    log_agent("system", "SCANNER",
        f"Scan starting — {len(watchlist)} tickers — "
        f"{datetime.now().strftime('%H:%M:%S')}")

    manage_positions(notify_fn)

    vix_regime   = get_vix_regime()
    market_bias  = get_market_bias()
    spy_qqq_alignment = check_spy_qqq_alignment()

    # ── Log active VIX regime and market bias at every scan cycle ────────────
    log_agent("system", "VIX",
        f"Scan cycle VIX regime: {vix_regime['regime']} "
        f"(VIX {vix_regime['vix']:.1f}) | "
        f"stop×{vix_regime.get('stop_mult', 1.0):.1f} | "
        f"size×{vix_regime['size_multiplier']:.1f}")
    _bias_icon = {"BULLISH": "📈", "BEARISH": "📉", "NEUTRAL": "➡️"}.get(market_bias, "➡️")
    log_agent("system", "BIAS",
        f"{_bias_icon} SPY market bias: {market_bias} (informational only)")

    if not vix_regime["allow_new_entries"]:
        log_agent("system", "VIX", "EXTREME VIX — all new entries halted")
        if not getattr(scan_all, '_extreme_vix_notified', False):
            scan_all._extreme_vix_notified = True
            if notify_fn:
                notify_fn(
                    f"🚨 *VIX EXTREME: {vix_regime['vix']:.1f}*\n"
                    f"All new entries halted. Only managing existing positions."
                )
        return []
    else:
        scan_all._extreme_vix_notified = False

    # Calculate portfolio delta once for the whole scan cycle
    equity         = get_portfolio_equity()
    portfolio_delta = calculate_portfolio_delta(equity)
    log_agent("system", "DELTA",
        f"Scan delta: {portfolio_delta['net_delta_pct']:+.2f}% per 1% SPY | "
        f"Long ${portfolio_delta['long_delta_usd']:,.0f} "
        f"Short ${portfolio_delta['short_delta_usd']:,.0f}")

    market         = get_market_condition()
    open_positions = get_open_positions()
    stocks         = [t for t in watchlist if not is_crypto(t)]

    # Fetch earnings calendar once per scan — used to gate trades
    try:
        earnings_cal = get_earnings_calendar(stocks)
        high_risk    = [t for t, e in earnings_cal.items() if e["risk"] == "HIGH"]
        if high_risk:
            log_agent("system", "EARNINGS",
                f"Earnings within 3 days: {', '.join(high_risk)} — size reduced")
    except Exception as e:
        log.warning("Earnings calendar failed: %s", e)
        earnings_cal = {}
    crypto      = [t for t in watchlist if is_crypto(t)]
    market_open = is_market_open_alpaca()  # uses Alpaca clock — most reliable

    if not market_open:
        log_agent("system", "SCANNER",
            f"Market closed — skipping {len(stocks)} stocks, crypto only")
        scan_targets = crypto
    else:
        log_agent("system", "SCANNER",
            f"Market {market} + VIX {vix_regime['regime']} — "
            f"scanning {len(stocks)} stocks + {len(crypto)} crypto")
        scan_targets = stocks + crypto

    # Only notify VIX regime on change — persisted across restarts via DB
    def _get_last_vix_regime():
        try:
            con = sqlite3.connect(LESSONS_DB)
            row = con.execute(
                "SELECT hold_period FROM position_state WHERE symbol='__VIX_REGIME__'"
            ).fetchone()
            con.close()
            return row[0] if row else None
        except:
            return None

    def _save_last_vix_regime(regime: str):
        try:
            con = sqlite3.connect(LESSONS_DB)
            con.execute("""
                INSERT INTO position_state (symbol, hold_period, updated_at)
                VALUES ('__VIX_REGIME__', ?, ?)
                ON CONFLICT(symbol) DO UPDATE SET
                    hold_period=excluded.hold_period,
                    updated_at=excluded.updated_at
            """, (regime, datetime.now().isoformat()))
            con.commit()
            con.close()
        except:
            pass

    last_regime = _get_last_vix_regime()
    current_regime = vix_regime["regime"]
    if current_regime != last_regime:
        _save_last_vix_regime(current_regime)  # always persist regime change
        if current_regime in ("ELEVATED", "HIGH") and notify_fn:
            notify_fn(
                f"⚠️ *VIX {current_regime}: {vix_regime['vix']:.1f}*\n"
                f"{vix_regime['description']}\n"
                f"Position sizes: {int(vix_regime['size_multiplier']*100)}% of normal"
            )
        elif current_regime == "CALM" and last_regime in ("ELEVATED","HIGH") and notify_fn:
            notify_fn(f"✅ VIX back to CALM ({vix_regime['vix']:.1f}) — normal sizing resumed")

    trades   = []
    skipped  = []
    analyzed = []

    if scan_targets:
        # ── STAGE 1: Fetch all prices in parallel ────────────────────────────
        t0 = datetime.now()
        from concurrent.futures import ThreadPoolExecutor, as_completed
        import threading

        prices = {}
        with ThreadPoolExecutor(max_workers=min(len(scan_targets), 6),
                                thread_name_prefix="price") as ex:
            price_futures = {ex.submit(fetch_ticker_price, t): t
                             for t in scan_targets}
            try:
                for fut in as_completed(price_futures, timeout=15):
                    t = price_futures[fut]
                    try:
                        prices[t] = fut.result()
                    except Exception as e:
                        prices[t] = 0.0
                        log.warning("Price fetch failed %s: %s", t, e)
            except TimeoutError:
                # Some price fetches timed out — use 0.0 for missing ones
                for fut, t in price_futures.items():
                    if t not in prices:
                        prices[t] = 0.0
                        log.warning("Price fetch timeout %s — skipping", t)

        log_agent("system", "SCANNER",
            f"Stage 1 (prices): {len(prices)} fetched in "
            f"{(datetime.now()-t0).total_seconds():.1f}s")
        scan_all._last_prices = prices   # expose to Telegram report — avoids re-fetch

        # ── STAGE 2: Single Grok call for ALL tickers ────────────────────────
        t1 = datetime.now()
        # Filter to tickers with valid prices
        valid_targets = [t for t in scan_targets if prices.get(t, 0) > 0]
        _pregated = []
        if valid_targets:
            # Σ₀ cache: only re-read tickers whose price actually moved; reuse the
            # rest. The expensive batch shrinks (or skips) when the tape is quiet.
            _cache = _scan_cache_load()
            fresh_targets, cached_results = _scan_cache_partition(valid_targets, prices, _cache)
            # Σ₀ pre-gate: among the moved tickers, only spend the model on those
            # that could actually ENTER; flat/featureless ones would SKIP regardless.
            _pregated = []
            if _PREGATE_ON and fresh_targets:
                _grounded = [t for t in fresh_targets
                             if _has_grounding(t, prices.get(t, 0), open_positions)]
                _pregated = [t for t in fresh_targets if t not in _grounded]
                if _pregated:
                    log_agent("system", "SCANNER",
                        f"Σ₀ pre-gate: skipped {len(_pregated)} flat/featureless ticker(s) "
                        f"pre-LLM ({', '.join(_pregated)})")
                fresh_targets = _grounded
            grok_results = batch_grok_analysis(fresh_targets, prices) if fresh_targets else {}
            _now_ts = datetime.now().timestamp()
            for _t, _a in list(grok_results.items()):           # cache raw, pre-rotation
                if prices.get(_t, 0) > 0 and isinstance(_a, dict):
                    _cache[_t] = [prices[_t], _a, _now_ts]
            _scan_cache_save(_cache)
            grok_results.update(cached_results)
            if cached_results:
                log_agent("system", "SCANNER",
                    f"Σ₀ cache: reused {len(cached_results)}/{len(valid_targets)} LLM "
                    f"reads (price unchanged), {len(fresh_targets)} re-analyzed")
            _log_llm_usage(len(fresh_targets), len(cached_results), len(_pregated), len(valid_targets))
        else:
            grok_results = {}

        # Apply sector rotation adjustments to Grok results — direction-aware
        for t, analysis in grok_results.items():
            rotation_adj = get_sector_rotation_adjustment(t)
            if rotation_adj != 0:
                _sd = analysis.get("direction", "NEUTRAL")
                _ea = (+5 if rotation_adj < 0 else -5) if _sd == "BEARISH" else rotation_adj
                old_conf = analysis.get("confidence", 0)
                analysis["confidence"] = max(0, min(100, old_conf + _ea))
                log_agent("system", "ROTATION",
                    f"{t} sector adj {_ea:+d} ({_sd}) → "
                    f"{old_conf}% → {analysis['confidence']}%")

        log_agent("system", "SCANNER",
            f"Stage 2 (Grok batch): {len(grok_results)} analyzed in "
            f"{(datetime.now()-t1).total_seconds():.1f}s")

        # ── STAGE 3: Riley + Claude in parallel threads ───────────────────────
        t2 = datetime.now()

        # Semaphore to limit concurrent Claude calls (avoid rate limits)
        claude_sem = threading.Semaphore(3)

        def scan_with_semaphore(ticker):
            """Wrap scan_ticker_stage2 with Claude rate limit protection."""
            with claude_sem:
                return scan_ticker_stage2(
                    ticker,
                    price=prices.get(ticker, 0),
                    analysis=grok_results.get(ticker, {}),
                    open_positions=open_positions,
                    vix_regime=vix_regime,
                    portfolio_delta=portfolio_delta,
                    earnings=earnings_cal.get(ticker,
                        {"days_away": 999, "risk": "LOW"}),
                    equity=equity,
                    market_bias=market_bias,
                )

        # Pre-gated tickers (flat + featureless, no LLM read) can't ENTER and hold
        # no position — record as skipped, don't waste a Stage-3 pass on them.
        _stage3_targets = [t for t in valid_targets if t not in _pregated]
        for _pt in _pregated:
            skipped.append({"ticker": _pt, "reason": "Σ₀ pre-gate — no grounding (flat, no zone/trend/news)"})

        with ThreadPoolExecutor(max_workers=max(1, min(len(_stage3_targets), 4)),
                                thread_name_prefix="claude") as ex:
            scan_futures = {ex.submit(scan_with_semaphore, t): t
                           for t in _stage3_targets}
            for fut in as_completed(scan_futures, timeout=90):  # 90s max per scan
                t = scan_futures[fut]
                try:
                    result = fut.result()
                    if result and result.get("status") in ("placed", "simulated"):
                        trades.append(result)
                        open_positions[alpaca_symbol(t)] = True
                        analyzed.append(result)
                    elif result and result.get("status") == "skipped":
                        skipped.append(result)
                        has_ai   = result.get("confidence") is not None
                        not_held = "already" not in result.get("reason","").lower()
                        if has_ai and not_held:
                            analyzed.append(result)
                except Exception as e:
                    log.error("Stage3 failed %s: %s", t, e)
                    skipped.append({"ticker": t, "reason": str(e)})

        total_time = (datetime.now()-t0).total_seconds()
        log_agent("system", "SCANNER",
            f"Stage 3 (Claude parallel): complete in "
            f"{(datetime.now()-t2).total_seconds():.1f}s | "
            f"Total scan: {total_time:.1f}s")

    log_agent("system", "SCANNER",
        f"Done — {len(trades)} trade(s) from {len(scan_targets)} scanned")

    # Store for /scan_detail command
    scan_all._last_results = {
        "scan_targets":   scan_targets,
        "trades":         trades,
        "skipped":        skipped,
        "analyzed":       analyzed,
        "vix_regime":     vix_regime,
        "spy_qqq_alignment": spy_qqq_alignment,
        "market":         market,
        "portfolio_delta": portfolio_delta,
        "earnings_cal":   earnings_cal,
        "timestamp":      datetime.now().strftime("%Y-%m-%d %H:%M"),
        "equity":         equity,
    }

    # Send grouped scan report
    if notify_fn and scan_targets:
        _send_scan_report(
            notify_fn, scan_targets, trades, skipped,
            analyzed, vix_regime, market, market_bias,
            spy_qqq=spy_qqq_alignment
        )

    return trades


def _send_scan_report(notify_fn, scan_targets, trades, skipped,
                      analyzed, vix_regime, market, market_bias="NEUTRAL",
                      spy_qqq=None):
    """Send a grouped scan summary after every cycle."""
    from datetime import datetime
    import pytz
    ET  = pytz.timezone("America/New_York")
    now = datetime.now(ET).strftime("%H:%M")

    regime_icon = {"CALM":"🟢","ELEVATED":"🟡","HIGH":"🔴","EXTREME":"🚨"}.get(
        vix_regime.get("regime","CALM"), "⚪")
    bias_icon   = {"BULLISH":"📈","BEARISH":"📉","NEUTRAL":"➡️"}.get(market_bias, "➡️")

    held    = [r for r in skipped if "already" in r.get("reason","").lower()]
    blocked = [r for r in skipped if r not in held and r.get("confidence") is None]

    # Detect if this is a crypto-only scan for header labelling
    _all_crypto = scan_targets and all(is_crypto(t) for t in scan_targets)
    _scan_label = "₿ *Crypto Scan*" if _all_crypto else "🔍 *Scan Complete*"

    lines = [
        f"{_scan_label} — {now} ET",
        f"{regime_icon} VIX {vix_regime.get('vix',0):.1f} {vix_regime.get('regime','')} "
        f"| {market} | {bias_icon} SPY {market_bias} | {len(scan_targets)} scanned",
    ]

    # ── ES/NQ correlation status (SPY vs QQQ — additive confirmation) ────────
    if spy_qqq:
        if spy_qqq.get("diverged"):
            lines.append(f"⚠️ ES/NQ DIVERGENCE — staying cautious ({spy_qqq.get('summary','')})")
        elif spy_qqq.get("aligned"):
            lines.append(f"✅ ES/NQ aligned ({spy_qqq.get('summary','')})")

    lines.append("")

    # ── Crypto-only: show BTC/ETH/SOL live prices ─────────────────────────────
    if _all_crypto:
        _last_prices = getattr(scan_all, "_last_prices", {})
        _price_parts = []
        for _sym, _label in [("BTCUSD","BTC"), ("ETHUSD","ETH"), ("SOLUSD","SOL")]:
            _p = _last_prices.get(_sym, 0)
            if _p > 0:
                _price_parts.append(
                    f"{_label} ${_p:,.0f}" if _p >= 100 else f"{_label} ${_p:.2f}"
                )
        if _price_parts:
            lines.append("💰 " + " | ".join(_price_parts))
            lines.append("")

    def _ticker_label(ticker):
        """Prefix crypto tickers with ₿ for easy identification."""
        return f"₿{ticker}" if is_crypto(ticker) else ticker

    # Trades executed
    if trades:
        lines.append("✅ *New Trades:*")
        for t in trades:
            action = t.get("action","BUY")
            ticker = t.get("ticker","?")
            conf   = t.get("confidence","?")
            price  = t.get("price","?")
            if is_crypto(ticker):
                icon  = "₿"
                label = "LONG" if action == "BUY" else "SHORT"
            else:
                icon  = "📈" if action == "BUY" else "📉"
                label = action
            lines.append(f"  {icon} *{_ticker_label(ticker)}* {label} @ ${price} | {conf}% conf")
        lines.append("")

    # AI analysis results
    if analyzed:
        lines.append("📊 *Scanned:*")
        for r in analyzed[:8]:
            ticker    = r.get("ticker","?")
            conf      = r.get("confidence","?")
            reason    = r.get("reason","")
            status    = r.get("status","")
            action    = r.get("action","")
            direction = r.get("direction","")

            if status in ("placed","simulated"):
                if is_crypto(ticker):
                    icon = "₿"
                    label = "LONG" if action == "BUY" else "SHORT"
                else:
                    icon  = "📈" if action == "BUY" else "📉"
                    label = action
                lines.append(f"  {icon} *{_ticker_label(ticker)}*: {label} @ {conf}% conf")
            else:
                # Summarise reason concisely
                if "confidence" in reason.lower() and conf:
                    short = f"{conf}% conf — below threshold"
                elif "backtest" in reason.lower():
                    short = f"Backtest weak ({conf}% conf)"
                elif "timeframe" in reason.lower() or "mtf" in reason.lower():
                    short = f"TF conflict ({conf}% conf)"
                elif "sector" in reason.lower():
                    short = f"Sector overexposed ({conf}% conf)"
                elif "event risk" in reason.lower():
                    short = f"Event risk block ({conf}% conf)"
                elif conf:
                    short = f"{conf}% conf — {reason[:50]}"
                else:
                    short = reason[:60]

                dir_icon = "₿" if is_crypto(ticker) else (
                    "📈" if direction=="BULLISH" else "📉" if direction=="BEARISH" else "➡️")
                lines.append(f"  {dir_icon} *{_ticker_label(ticker)}*: {short}")
        lines.append("")

    # Held positions (already long/short)
    if held:
        held_names = [r.get("ticker","?") for r in held]
        lines.append(f"💤 *Already held:* {', '.join(held_names)}")

    # Pre-filtered (event risk, time filter, bias block etc)
    if blocked:
        if _all_crypto:
            # Crypto: show each ticker with its block reason so we know what happened
            lines.append("⛔ *Blocked:*")
            for r in blocked:
                _t  = r.get("ticker", "?")
                _rs = r.get("reason", "")
                # Condense long reasons to one readable line
                if "cooldown" in _rs.lower():
                    _short_rs = "stop-loss cooldown"
                elif "bias" in _rs.lower():
                    _short_rs = _rs[:55]
                elif "mtf" in _rs.lower() or "timeframe" in _rs.lower():
                    _short_rs = "MTF conflict"
                elif "riley" in _rs.lower():
                    _short_rs = f"Riley {r.get('direction','?')}"
                elif "zone" in _rs.lower():
                    _short_rs = "no valid zone"
                else:
                    _short_rs = _rs[:55] if _rs else "pre-filtered"
                lines.append(f"  ₿{_t}: {_short_rs}")
        else:
            blocked_names = [r.get("ticker","?") for r in blocked]
            lines.append(f"⛔ *Pre-filtered:* {', '.join(blocked_names)}")

    lines.append("")
    lines.append("_/scan_detail for full reasoning_")

    notify_fn("\n".join(lines))