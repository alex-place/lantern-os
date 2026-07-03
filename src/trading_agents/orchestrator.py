#!/usr/bin/env python3
"""
main.py — Autonomous Trading System Entry Point
"""

import os, sys, time, logging, threading

# Windows console defaults to cp1252, which can't encode emoji used in startup banners/logs.
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

from datetime import datetime
import pytz
from dotenv import load_dotenv
from flask import Flask, jsonify
import alpaca_trade_api as tradeapi
from apscheduler.schedulers.background import BackgroundScheduler

# Load the repo .env BEFORE importing agents — agents.py constructs API clients at import,
# so the keys must be present. In production the manager already passes a populated env;
# this makes a standalone `python orchestrator.py` work too.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv(os.path.join(_REPO_ROOT, ".env"))
load_dotenv(os.path.join(_REPO_ROOT, ".env.local"))

from agents import (
    scan_all, agent_log, DEFAULT_WATCHLIST,
    get_portfolio_equity, get_open_positions,
    get_profile, close_position, is_market_hours,
    is_crypto
)
# Telegram is an OPTIONAL notifier — never block trading if it's absent/misconfigured.
try:
    from telegram_bot import (
        TelegramCommandHandler, send_message, send_alert,
        build_portfolio_summary,
    )
except Exception as _tg_e:  # noqa: BLE001
    logging.getLogger(__name__).info(f"telegram notifier disabled ({_tg_e})")
    def send_message(text, parse_mode="Markdown"): return False
    def send_alert(text): return False
    def build_portfolio_summary(alpaca): return ""
    class TelegramCommandHandler:  # no-op stub
        def __init__(self, *a, **k): pass
        def start(self, *a, **k): pass
        def stop(self, *a, **k): pass
from price_watcher import PriceWatcher
# Health/status REST API (:5555) — ported into the package (was src.ai_trader_api externally).
try:
    from trader_api import run_api_server
except Exception as _api_e:  # noqa: BLE001
    logging.getLogger(__name__).info(f"trader REST API disabled ({_api_e})")
    def run_api_server(shared_state, host="0.0.0.0", port=5555): pass

load_dotenv()

# Log under the repo (src/trading_agents/orchestrator.py → repo root) so the log path is
# deterministic regardless of the launcher's cwd.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_LOG_PATH = os.path.join(_REPO_ROOT, "logs", "trading.log")
os.makedirs(os.path.dirname(_LOG_PATH), exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(), logging.FileHandler(_LOG_PATH, encoding="utf-8")]
)
log = logging.getLogger(__name__)

ET = pytz.timezone("America/New_York")

# Shared state for REST API
_shared_state = None

def update_shared_state():
    """Update shared state for REST API endpoints."""
    global _shared_state
    if not _shared_state:
        return

    try:
        account = alpaca.get_account()
        _shared_state['equity'] = float(account.equity)
        _shared_state['market_open'] = is_market_open_alpaca()
        _shared_state['paused'] = paused[0]
        _shared_state['uptime'] = int((datetime.now(ET) - _start_time).total_seconds()) if hasattr(__builtins__, '_start_time') else 0

        positions = alpaca.list_positions()
        _shared_state['positions_count'] = len(positions)

        _shared_state['positions'] = []
        for pos in positions:
            _shared_state['positions'].append({
                'symbol': pos.symbol,
                'qty': float(pos.qty),
                'entry_price': float(pos.avg_entry_price),
                'current_price': float(pos.current_price),
                'pnl_pct': float(pos.unrealized_plpc) * 100,
                'stop': None,  # Would be populated from _position_adjustments
                'tp': None,    # Would be populated from _position_adjustments
            })
    except Exception as e:
        log.error(f"Failed to update shared state: {e}")

# Use the SAME broker client agents.py resolved through the live-trading gate — so the
# orchestrator and the trading logic can never disagree on paper-vs-live (agents.py only
# rebinds to LIVE when ALPACA_LIVE=1 AND the readiness gate passes; otherwise PAPER).
from agents import alpaca

watchlist  = list(DEFAULT_WATCHLIST)
paused     = [False]
_scan_lock   = threading.Lock()
_scan_queued = [False]   # set when job_scan_market fires mid-scan — runs once the current scan finishes

# ── AI-trader ON/OFF — cross-process toggle driven by the UI button ─────────────
# The node server writes data/lantern-garage/trading/ai-trader-enabled.json when the
# operator flips the toggle; every order-placing job checks it here. A missing file
# means ON (preserves the default auto-trade behavior). This is the authoritative
# on/off for autonomous trading; existing-position safety (EOD close, price-watcher
# stop-loss) is intentionally NOT gated so turning off never strands open risk.
import json as _json
_ENABLED_FLAG = os.path.join(_REPO_ROOT, "data", "lantern-garage", "trading", "ai-trader-enabled.json")

def trading_enabled() -> bool:
    try:
        with open(_ENABLED_FLAG, encoding="utf-8") as f:
            return bool(_json.load(f).get("enabled", True))
    except FileNotFoundError:
        return True          # unset → ON by default
    except Exception:
        return True          # unreadable → fail safe to ON (don't silently halt)

# ── Market hours ──────────────────────────────────────────────────────────────

def is_market_open_alpaca() -> bool:
    now = datetime.now(ET)
    if now.weekday() >= 5:
        return False
    if now.hour < 9 or now.hour >= 16:
        return False
    if now.hour == 9 and now.minute < 30:
        return False
    return True

def should_scan(ticker: str) -> bool:
    """Stocks only during market hours. Crypto scans 24/7."""
    from agents import is_crypto as _ic
    if _ic(ticker):
        return True   # crypto never pauses
    return is_market_open_alpaca()

# ── Smart notification state ──────────────────────────────────────────────────

_scan_count       = 0
_last_market_cond = None
_last_pnl             = {}
_first_scan_done      = False
_pending_suggestions  = []
_day_start_equity     = None   # equity at start of trading day
_drawdown_triggered   = False  # prevent repeated alerts

DRAWDOWN_LIMIT_PCT    = 5.0    # pause if portfolio drops this % in one day

def check_drawdown_circuit_breaker() -> bool:
    """
    Check if portfolio has dropped more than DRAWDOWN_LIMIT_PCT today.
    If so, pause all trading and send emergency alert.
    Returns True if circuit breaker was triggered.
    """
    global _day_start_equity, _drawdown_triggered

    try:
        account      = alpaca.get_account()
        equity       = float(account.equity)
        last_equity  = float(account.last_equity)  # equity at previous close

        # Use last_equity as day start baseline
        if last_equity <= 0:
            return False

        day_pnl_pct = ((equity - last_equity) / last_equity) * 100

        if day_pnl_pct <= -DRAWDOWN_LIMIT_PCT and not _drawdown_triggered:
            _drawdown_triggered = True
            paused[0] = True
            log.warning("DRAWDOWN CIRCUIT BREAKER triggered: %.2f%% today", day_pnl_pct)
            send_message(
                f"🚨 *EMERGENCY: Drawdown Circuit Breaker*\n\n"
                f"Portfolio dropped *{day_pnl_pct:.2f}%* today\n"
                f"Threshold: -{DRAWDOWN_LIMIT_PCT}%\n\n"
                f"💼 Equity: ${equity:,.2f}\n"
                f"📉 Day P&L: ${equity - last_equity:+,.2f}\n\n"
                f"⛔ *All trading paused automatically*\n"
                f"Review your positions and send /resume when ready.\n"
                f"Use /close ALL to exit all positions if needed."
            )
            return True

        # Reset trigger flag at start of new day if recovered
        if day_pnl_pct > -DRAWDOWN_LIMIT_PCT:
            _drawdown_triggered = False

        return False

    except Exception as e:
        log.warning("Drawdown check failed: %s", e)
        return False

def _get_position_snapshot() -> dict:
    try:
        return {p.symbol: float(p.unrealized_plpc) * 100
                for p in alpaca.list_positions()}
    except:
        return {}

def _significant_pnl_change(old: dict, new: dict, threshold: float = 1.5) -> list:
    changed = []
    for sym, new_pnl in new.items():
        old_pnl = old.get(sym)
        if old_pnl is not None and abs(new_pnl - old_pnl) >= threshold:
            changed.append((sym, old_pnl, new_pnl))
    return changed

# ── Scheduled jobs ────────────────────────────────────────────────────────────

def job_premarket():
    """
    Runs at 9:00am ET — 30 min before market open.
    Analyzes overnight news, futures, earnings risk.
    Sends a morning brief to Telegram so you know what to expect.
    """
    from agents import get_premarket_analysis, DEFAULT_WATCHLIST
    log.info("Pre-market analysis starting...")
    try:
        equity   = get_portfolio_equity()
        analysis = get_premarket_analysis(DEFAULT_WATCHLIST, equity)

        bias_icon = {"BULLISH": "📈", "BEARISH": "📉", "NEUTRAL": "➡️"}.get(
            analysis.get("market_bias", "NEUTRAL"), "➡️")
        spy_chg = analysis.get("spy_premarket_chg", 0)

        lines = [
            f"🌅 *Pre-Market Brief — 9:00am ET*",
            f"{bias_icon} Market bias: {analysis.get('market_bias','NEUTRAL')} "
            f"| SPY pre-market: {spy_chg:+.2f}%",
            "",
        ]

        # Earnings alerts
        for alert in analysis.get("alerts", []):
            lines.append(alert)
        if analysis.get("alerts"):
            lines.append("")

        # Per-ticker summary
        lines.append("*Ticker outlook:*")
        for ticker, info in analysis.get("tickers", {}).items():
            bias    = info.get("bias", "NEUTRAL")
            conf    = info.get("confidence", 50)
            summary = info.get("summary", "")[:80]
            watch   = info.get("watch_level", "")
            icon    = "📈" if bias == "BULLISH" else "📉" if bias == "BEARISH" else "➡️"
            earn    = analysis.get("earnings", {}).get(ticker, {})
            earn_tag= f" ⚠️ earnings {earn['days_away']}d" if earn.get("risk") in ("HIGH","MEDIUM") else ""
            lines.append(f"  {icon} *{ticker}*{earn_tag}: {bias} {conf}% — {summary}")
            if watch and watch != "N/A":
                lines.append(f"     Watch: {watch}")

        lines.append("")
        lines.append("_Market opens in 30 minutes_")

        send_message("\n".join(lines))
        log.info("Pre-market brief sent")
    except Exception as e:
        log.error("Pre-market job failed: %s", e)
        send_message(f"⚠️ Pre-market analysis failed: {e}")


def job_scan_market():
    global _scan_count, _last_market_cond, _last_pnl, _first_scan_done

    if paused[0] or not trading_enabled():
        log.info("AI trader is paused/OFF — skipping scan")
        return

    # Drawdown circuit breaker — check before doing anything
    if check_drawdown_circuit_breaker():
        return

    if not _scan_lock.acquire(blocking=False):
        log.info("Scan already in progress — queuing this scan to run after it completes")
        _scan_queued[0] = True
        return

    try:
        _scan_count += 1
        active  = [t for t in watchlist if should_scan(t)]
        skipped = [t for t in watchlist if not should_scan(t)]

        if skipped:
            log.info("Market closed — skipping stocks: %s", skipped)

        if not active:
            log.info("Nothing to scan right now")
            return

        log.info("Starting scan of %d tickers: %s", len(active), active)

        pnl_before = _get_position_snapshot()

        from agents import get_market_condition
        market = get_market_condition()
        market_changed = (market != _last_market_cond and _last_market_cond is not None)
        _last_market_cond = market

        trades = scan_all(active, notify_fn=send_alert)

        pnl_after = _get_position_snapshot()
        pnl_moves = _significant_pnl_change(pnl_before, pnl_after)

        if trades:
            log.info("%d trade(s) executed this cycle", len(trades))

        # Crypto-only scan (after hours) — send a detailed mini-report every scan
        from agents import is_crypto as _ic
        crypto_only = all(_ic(t) for t in active) if active else False
        if crypto_only:
            from agents import (scan_all as _scan_all, agent_log as _alog,
                                _position_adjustments as _padj, get_profile as _gprof)
            import re as _re, pytz
            from datetime import datetime
            et     = pytz.timezone("America/New_York")
            now_et = datetime.now(et).strftime("%H:%M")

            position_lines = []
            signal_lines   = []
            quiet_lines    = []

            _cached_prices = getattr(_scan_all, '_last_prices', {})
            for t in active:
                try:
                    price = _cached_prices.get(t, 0)
                    if price == 0:
                        quiet_lines.append(f'⚪ {t}: unavailable')
                        continue

                    # ── Open position: use smart levels if available ───────────────────────
                    # Use raw ticker (e.g. "BTCUSD") not slash form ("BTC/USD") —
                    # Alpaca's /v2/positions/{symbol} endpoint rejects the slash.
                    try:
                        log.debug("Crypto report: get_position(%r)", t)
                        pos     = alpaca.get_position(t)
                        pnl     = float(pos.unrealized_plpc) * 100
                        entry   = float(pos.avg_entry_price)
                        profile = _gprof(t)
                        adj     = _padj.get(t, {})  # _position_adjustments keyed by ticker
                        if 'stop_price' in adj:
                            stop_p = adj['stop_price']
                            tp_p   = adj['tp_price']
                        else:
                            stop_p = entry * (1 + profile['stop'] / 100)
                            tp_p   = entry * (1 + profile['tp']   / 100)
                        dist_tp   = (tp_p   - price) / price * 100
                        dist_stop = (price  - stop_p) / price * 100
                        icon = '🟢' if pnl >= 0 else '🔴'
                        position_lines.append(
                            f'{icon} *{t}* ${price:,.2f} | P&L {pnl:+.1f}% | '
                            f'TP {dist_tp:+.1f}% | Stop {dist_stop:.1f}% away'
                        )
                        continue
                    except Exception as pos_err:
                        log.debug("Crypto report: no position for %r: %s", t, pos_err)

                    # ── Signal: parse GROK + RILEY entries from agent_log ──────
                    recent_logs   = _alog[-100:]
                    grok_entries  = [e for e in recent_logs
                                     if e.get('agent') == 'GROK'  and t in e.get('body', '')]
                    riley_entries = [e for e in recent_logs
                                     if e.get('agent') == 'RILEY' and t in e.get('body', '')]

                    direction, conf, catalyst = 'NEUTRAL', 0, 'quiet'
                    if grok_entries:
                        body = grok_entries[-1].get('body', '')
                        m = _re.search(
                            r'(BULLISH|BEARISH|NEUTRAL)\s+(\d+)%\s*\|\s*(.{3,60})', body)
                        if m:
                            direction = m.group(1)
                            conf      = int(m.group(2))
                            catalyst  = m.group(3).strip().replace(" [batch]", "").strip()

                    riley_icon = ''
                    if riley_entries:
                        rbody = riley_entries[-1].get('body', '')
                        if 'approved=True' in rbody:
                            riley_icon = ' ✅'
                        elif 'WAIT' in rbody:
                            riley_icon = ' ⏳'
                        elif 'BLOCKED' in rbody or 'approved=False' in rbody:
                            riley_icon = ' 🚫'

                    if direction != 'NEUTRAL':
                        dir_icon = '🟢' if direction == 'BULLISH' else '🔴'
                        signal_lines.append(
                            f'{dir_icon} *{t}* ${price:,.2f} | {direction} {conf}%{riley_icon}\n'
                            f'   _{catalyst[:55]}_'
                        )
                    else:
                        quiet_lines.append(
                            f'⚪ {t}: ${price:,.2f} | neutral — quiet'
                        )

                except Exception as e:
                    log.warning('Crypto report failed %s: %s', t, e)
                    quiet_lines.append(f'⚪ {t}: error')

            trade_note = f' | {len(trades)} trade(s) executed' if trades else ''
            sections = []
            if position_lines:
                sections.append('*💼 Positions:*\n' + '\n'.join(position_lines))
            if signal_lines:
                sections.append('*📊 Signals:*\n' + '\n'.join(signal_lines))
            if quiet_lines:
                sections.append('\n'.join(quiet_lines))

            if sections:
                send_message(
                    f'₿ *Crypto Scan* — {now_et} ET{trade_note}\n\n'
                    + '\n\n'.join(sections)
                )

        # First scan — send full session report
        if not _first_scan_done:
            _first_scan_done = True
            _last_pnl = pnl_after
            from agents import is_crypto as _ic
            # Show what's actually being scanned right now
            scanning_stocks = [t for t in active if not _ic(t)]
            scanning_crypto = [t for t in active if _ic(t)]
            closed_stocks   = [t for t in watchlist if not _ic(t) and t not in active]
            market_status   = "open" if is_market_open_alpaca() else "closed"
            msg  = "🚀 *AI Trader — Session Start*\n\n"
            msg += f"📡 Market: *{market}* ({market_status})\n"
            if scanning_stocks:
                msg += f"📈 Scanning {len(scanning_stocks)} stocks: {', '.join(scanning_stocks)}\n"
            if closed_stocks:
                msg += f"💤 {len(closed_stocks)} stocks paused (market closed)\n"
            msg += f"₿ Scanning {len(scanning_crypto)} crypto: {', '.join(scanning_crypto)}\n"
            msg += f"⏱ Every 15 min (market hours only)\n\n"
            msg += build_portfolio_summary(alpaca)
            send_message(msg)
            return

        # Subsequent scans — only notify on significant events
        alerts = []
        if market_changed:
            emoji = "📈" if market == "BULLISH" else "📉" if market == "BEARISH" else "➡️"
            alerts.append(f"{emoji} *Market condition changed: {market}*")

        for sym, old_pnl, new_pnl in pnl_moves:
            direction = "▲" if new_pnl > old_pnl else "▼"
            alerts.append(
                f"{direction} *{sym}* P&L moved: {old_pnl:+.1f}% → {new_pnl:+.1f}%"
            )

        if alerts:
            send_message("⚡ *Market Update*\n\n" + "\n".join(alerts))

        _last_pnl = pnl_after

    finally:
        _scan_lock.release()

    if _scan_queued[0]:
        _scan_queued[0] = False
        log.info("Running queued scan that arrived while the previous scan was in progress")
        job_scan_market()

def job_watchlist_scan():
    """
    Every Saturday at 9am ET — deep market research for new tickers.
    3-stage pipeline: Grok broad scan → tradability filter → Sonnet deep research.
    """
    global _pending_suggestions
    from agents import scan_for_new_tickers

    log.info("Weekly watchlist research starting...")
    send_message("🔍 *Weekly Market Research*\n\nRunning 3-stage analysis...\n"
                 "Stage 1: Grok scanning markets + X/Twitter\n"
                 "Stage 2: Filtering for Alpaca tradability\n"
                 "Stage 3: Sonnet deep research on top candidates\n\n"
                 "_This takes ~2 minutes..._")

    suggestions, theme = scan_for_new_tickers(watchlist)

    if not suggestions:
        send_message(
            "🔍 *Weekly Watchlist Research*\n\n"
            "No strong candidates found this week.\n"
            f"Market theme: {theme or 'No clear theme'}"
        )
        return

    _pending_suggestions = suggestions

    add_count   = sum(1 for s in suggestions if s.get("recommendation") == "ADD")
    watch_count = sum(1 for s in suggestions if s.get("recommendation") == "WATCH")

    lines = [
        f"🔍 *Weekly Market Research*\n",
        f"📡 Theme: _{theme}_\n",
        f"Found {add_count} ADD + {watch_count} WATCH recommendations\n",
        "─────────────────────────"
    ]

    for s in suggestions:
        rec   = s.get("recommendation", "WATCH")
        rec_icon = "✅" if rec == "ADD" else "👀"
        dir_icon = "📈" if s.get("direction") == "LONG" else "📉"
        risk_icon = "🟢" if s.get("risk") == "LOW" else \
                    "🟡" if s.get("risk") == "MEDIUM" else "🔴"
        rating = s.get("rating", 5)
        stars  = "★" * rating + "☆" * (10 - rating)

        lines.append(
            f"\n{rec_icon} *{s['ticker']}* — {s.get('name', '')} {dir_icon}\n"
            f"  💰 ${s.get('price', 0):.2f} | {risk_icon} {s.get('risk','')} risk | "
            f"{rating}/10 {stars[:5]}\n"
            f"  📋 {s.get('category','').upper()} | {s.get('optimal_time','')}\n"
            f"  💡 {s.get('thesis','')}\n"
            f"  🎯 Entry: {s.get('entry_zone','')}\n"
            f"  ⚠️ Risk: {s.get('research_risk','')}\n"
            f"  🔗 Overlap: {s.get('overlap','')}\n"
            f"  ➕ Why now: {s.get('add_reason','')}\n"
            f"  📐 Stop: {s.get('stop_pct', -2.5):.1f}% | TP: +{s.get('tp_pct', 5.0):.1f}%"
        )

    lines.append(
        "\n─────────────────────────\n"
        "/approve TICKER — add to watchlist\n"
        "/approve ALL — add all ADD recommendations\n"
        "/reject TICKER — skip\n"
        "/watchlist — see current list"
    )

    send_message("\n".join(lines))


def job_weekly_report():
    """Every Sunday at 8pm ET — weekly report + graduation check."""
    from agents import get_weekly_stats, get_graduation_analysis
    stats = get_weekly_stats()
    s     = stats.get("summary")

    if not s or s["total"] == 0:
        send_message(
            "📅 *Weekly Report*\n\n"
            "No completed trades this week.\n"
            "Bot was scanning and monitoring positions."
        )
    else:
        pnl_emoji = "📈" if s["total_pnl"] >= 0 else "📉"
        msg  = "📅 *Weekly Performance Report*\n\n"
        msg += f"🔢 Trades: {s['total']} | ✅ {s['wins']}W / ❌ {s['losses']}L\n"
        msg += f"🎯 Win rate: {s['win_rate']}%\n"
        msg += f"{pnl_emoji} P&L: ${s['total_pnl']:+.2f}\n"
        msg += f"📊 Avg win: {s['avg_win']:+.2f}% | Avg loss: {s['avg_loss']:+.2f}%\n"
        msg += f"🏆 Best: {s['best_trade']:+.2f}% | Worst: {s['worst_trade']:+.2f}%\n\n"

        trades = stats.get("trades", [])
        if trades:
            msg += "*Recent trades:*\n"
            for t in trades[:8]:
                em = "✅" if (t[2] or 0) > 0 else "❌"
                msg += f"{em} {t[0]} {t[1]}: {(t[2] or 0):+.2f}% (${(t[3] or 0):+.2f})\n"
            msg += "\n"

        lessons = stats.get("lessons", [])
        if lessons:
            msg += "*Lessons this week:*\n"
            for l in lessons[:3]:
                msg += f"• {l[0]}: {l[2]}\n"
            msg += "\n"

        if s["win_rate"] >= 60:
            verdict = "🟢 Excellent week"
        elif s["win_rate"] >= 50:
            verdict = "🟡 Solid week"
        elif s["win_rate"] >= 40:
            verdict = "🟠 Challenging week"
        else:
            verdict = "🔴 Difficult week — review risk settings"
        msg += f"*Verdict:* {verdict}"
        send_message(msg)

    # ── Graduation check ──────────────────────────────────────────────────────
    grad = get_graduation_analysis()
    criteria = "\n".join([
        f"{'✅' if grad['meets_days']    else '❌'} 30+ days active: {grad.get('days_active',0)} days",
        f"{'✅' if grad['meets_trades']  else '❌'} 20+ trades: {grad.get('trades',0)} completed",
        f"{'✅' if grad['meets_winrate'] else '❌'} Win rate ≥ 55%: {grad.get('win_rate',0):.1f}%",
        f"{'✅' if grad['meets_sharpe']  else '❌'} Sharpe ≥ 1.0: {grad.get('sharpe',0):.2f}",
    ])

    if grad["ready"]:
        send_message(
            f"🎓 *GRADUATION READY — Go Live!*\n\n"
            f"{criteria}\n\n"
            f"📊 *30-Day Performance:*\n"
            f"💼 {grad['trades']} trades | {grad['win_rate']}% win rate\n"
            f"📈 Sharpe: {grad['sharpe']:.2f} | Avg: {grad.get('avg_return',0):+.2f}%\n"
            f"💰 Total P&L: ${grad.get('total_pnl_usd',0):+.2f}\n\n"
            f"⚠️ *To go live:*\n"
            f"1. Change TRADING_MODE=live in .env\n"
            f"2. Change ALPACA_BASE_URL to live URL\n"
            f"3. Start with small allocation\n"
            f"4. Keep same risk parameters\n\n"
            f"🚀 Ready when you are!"
        )
    else:
        send_message(
            f"📊 *Graduation Check*\n\n"
            f"{criteria}\n\n"
            f"❗ Missing: {grad['reason']}\n"
            f"Keep paper trading and check again next Sunday."
        )

def job_eod_check():
    """
    Forced EOD close — runs at 3:30pm ET.
    Closes ALL open positions unconditionally. No overnight holds, no exceptions.
    """
    from agents import _position_adjustments, close_position, clear_position_state, alpaca as _alpaca
    import pytz
    ET  = pytz.timezone("America/New_York")
    now = datetime.now(ET)
    log.info("EOD forced close starting at %s ET", now.strftime("%H:%M"))

    try:
        positions = _alpaca.list_positions()
    except Exception as e:
        log.error("EOD: failed to fetch positions: %s", e)
        return

    if not positions:
        send_message("🕑 *EOD Check* — No open positions.")
        return

    lines = [f"🕑 *EOD Check* (3:30pm ET)\n🚪 Closing all open positions — no overnight holds\n"]
    closed = 0
    for p in positions:
        sym     = p.symbol
        pnl_pct = float(p.unrealized_plpc) * 100
        try:
            qty     = float(p.qty)
            entry   = float(p.avg_entry_price)
            current = float(p.current_price)
            close_position(sym, qty, "EOD: forced close — no overnight positions allowed",
                           send_alert, entry, current, pnl_pct)
            _position_adjustments.pop(sym, None)
            clear_position_state(sym)
            lines.append(f"  {'🟢' if pnl_pct >= 0 else '🔴'} {sym}: {pnl_pct:+.2f}% — closed")
            closed += 1
            log.info("EOD closed %s: %.2f%%", sym, pnl_pct)
        except Exception as e:
            log.error("EOD close failed %s: %s", sym, e)
            lines.append(f"  ⚠️ {sym}: close failed — {e}")

    send_message("\n".join(lines))
    send_message(f"✅ EOD complete — {closed} closed, 0 held overnight.")



def job_portfolio_update():
    """30-min update — always sends during market hours."""
    global _last_pnl
    update_shared_state()  # Update API state
    try:
        positions = alpaca.list_positions()
    except:
        positions = []

    if not is_market_open_alpaca() and not positions:
        log.info("Market closed + no positions — skipping portfolio update")
        return

    current_pnl = _get_position_snapshot()
    moves       = _significant_pnl_change(_last_pnl, current_pnl, threshold=1.5)

    if paused[0]:
        send_message("⏸ *Bot is paused*\n\n" + build_portfolio_summary(alpaca))
    elif moves:
        move_lines = "\n".join(
            f"{'▲' if n > o else '▼'} *{s}*: {o:+.1f}% → {n:+.1f}%"
            for s, o, n in moves
        )
        send_message(
            f"📊 *Portfolio Update*\n\n"
            f"⚡ Significant moves:\n{move_lines}\n\n"
            + build_portfolio_summary(alpaca)
        )
    elif positions:
        send_message("📊 *Portfolio Update*\n\n" + build_portfolio_summary(alpaca))
    else:
        # No positions but market is open — send lean update so you know it's alive
        try:
            acct   = alpaca.get_account()
            equity = float(acct.equity)
            cash   = float(acct.cash)
            import pytz as _ptz_pu
            _et_pu     = datetime.now(_ptz_pu.timezone("America/New_York"))
            _hr_pu     = _et_pu.hour + _et_pu.minute / 60
            _in_riley  = (9.5 <= _hr_pu < 15.5)
            _status_line = ("📭 No open positions — scanning for entries" if _in_riley
                            else "📭 No open positions — next scan tomorrow 9:15am ET")
            send_message(
                f"📊 *Portfolio Update*\n\n"
                f"💼 Equity: ${equity:,.2f}\n"
                f"💵 Cash:   ${cash:,.2f}\n"
                f"{_status_line}"
            )
        except Exception as e:
            log.warning("Portfolio update failed: %s", e)

    _last_pnl = current_pnl

def job_eod_analysis():
    """4:15pm ET Mon-Fri — automated EOD analysis using Claude Sonnet."""
    from agents import (LESSONS_DB, CLAUDE_SONNET, claude, extract_json,
                        get_vix_regime, get_market_condition,
                        get_recent_success_patterns)
    import sqlite3
    from datetime import datetime as _dt

    log.info("EOD analysis starting...")
    today = _dt.now().strftime("%Y-%m-%d")
    today_ts = today + "T00:00:00"

    try:
        con = sqlite3.connect(LESSONS_DB)
        trades = con.execute(
            "SELECT symbol, action, pnl_pct, pnl_usd, confidence, close_reason "
            "FROM trade_history WHERE status='closed' AND ts >= ? ORDER BY ts",
            (today_ts,)
        ).fetchall()
        lessons = con.execute(
            "SELECT symbol, pnl_pct, lesson FROM lessons WHERE ts >= ? ORDER BY id DESC",
            (today_ts,)
        ).fetchall()
        con.close()
    except Exception as e:
        log.error("EOD analysis DB read failed: %s", e)
        return

    if not trades:
        send_message(
            f"📊 *EOD Analysis — {today}*\n\n"
            "No completed trades today. System was scanning and monitoring."
        )
        return

    pnl_pct_vals = [t[2] for t in trades if t[2] is not None]
    pnl_usd_vals = [t[3] for t in trades if t[3] is not None]
    wins   = [p for p in pnl_pct_vals if p > 0]
    losses = [p for p in pnl_pct_vals if p <= 0]
    stats  = {
        "total":     len(trades),
        "wins":      len(wins),
        "losses":    len(losses),
        "win_rate":  round(len(wins) / len(trades) * 100, 1),
        "total_pnl": round(sum(pnl_usd_vals), 2),
        "avg_win":   round(sum(wins) / len(wins), 2) if wins else 0,
        "avg_loss":  round(sum(losses) / len(losses), 2) if losses else 0,
        "best":      max(pnl_pct_vals),
        "worst":     min(pnl_pct_vals),
    }

    try:
        vix_info = get_vix_regime()
        mkt_cond = get_market_condition()
    except Exception:
        vix_info = {"regime": "UNKNOWN", "vix": 0.0}
        mkt_cond = "UNKNOWN"

    trade_text = "\n".join(
        f"  {t[0]} {t[1]}: {(t[2] or 0):+.2f}% (${(t[3] or 0):+.2f}) "
        f"conf={t[4]}% — {(t[5] or '')[:55]}"
        for t in trades[:20]
    )
    lesson_text = "\n".join(
        f"  {l[0]} ({l[1]:+.2f}%): {l[2]}" for l in lessons[:8]
    ) or "  None recorded"
    success_patterns = get_recent_success_patterns(limit=5)
    success_text = "\n".join(
        f"  {p['symbol']} ({p['pnl_pct']:+.2f}%): {p['what_worked']}"
        for p in success_patterns
    ) or "  None recorded"

    # Best and worst ticker by P&L pct
    trades_with_pnl = [(t[0], t[2]) for t in trades if t[2] is not None]
    best_ticker  = max(trades_with_pnl, key=lambda x: x[1])[0] if trades_with_pnl else ""
    worst_ticker = min(trades_with_pnl, key=lambda x: x[1])[0] if trades_with_pnl else ""

    prompt = f"""You are a trading performance coach reviewing today's trading session.

Date: {today}
Market: {mkt_cond} | VIX {vix_info['vix']:.1f} ({vix_info['regime']})

Results: {stats['total']} trades | {stats['wins']}W/{stats['losses']}L | {stats['win_rate']}% win rate
P&L: ${stats['total_pnl']:+.2f} | Avg win: {stats['avg_win']:+.2f}% | Avg loss: {stats['avg_loss']:+.2f}%
Best performer: {best_ticker} | Worst performer: {worst_ticker}

Trades:
{trade_text}

Losses and what went wrong:
{lesson_text}

Wins and what worked:
{success_text}

Analyze today's session. Address:
1. What patterns worked — which entry signals were reliable?
2. What failed — specific patterns to avoid?
3. Did VIX {vix_info['regime']} conditions affect outcomes?
4. Top priority for tomorrow's session

Return ONLY valid JSON:
{{
  "patterns_worked": "2-3 sentences",
  "patterns_failed": "2-3 sentences",
  "vix_assessment": "1 sentence on VIX regime impact",
  "tomorrow_focus": "top 1-2 priorities for tomorrow",
  "tomorrow_avoid": "1-2 things to avoid tomorrow",
  "verdict": "STRONG|GOOD|AVERAGE|POOR|LEARNING_DAY",
  "best_ticker": "{best_ticker}",
  "worst_ticker": "{worst_ticker}",
  "best_setup_type": "short label e.g. reversal at support, breakout long, short at resistance",
  "avoid_pattern": "short label e.g. chasing morning spike, low-volume breakout"
}}"""

    try:
        resp = claude.messages.create(
            model=CLAUDE_SONNET,
            max_tokens=500,
            messages=[{"role": "user", "content": prompt}]
        )
        analysis = extract_json(resp.content[0].text)
    except Exception as e:
        log.error("EOD Claude analysis failed: %s", e)
        send_message(f"⚠️ EOD analysis: stats sent, Claude step failed: {e}\n"
                     f"{stats['total']} trades | {stats['win_rate']}% | ${stats['total_pnl']:+.2f}")
        return

    try:
        import json as _json
        _meta = _json.dumps({
            "best_ticker":    analysis.get("best_ticker", best_ticker),
            "worst_ticker":   analysis.get("worst_ticker", worst_ticker),
            "best_setup_type": analysis.get("best_setup_type", ""),
            "avoid_pattern":  analysis.get("avoid_pattern", ""),
            "win_rate":       stats["win_rate"],
            "vix_regime":     vix_info["regime"],
        })
        con = sqlite3.connect(LESSONS_DB)
        con.execute("""
            INSERT OR REPLACE INTO daily_analysis
            (date, trades, wins, losses, win_rate, total_pnl, avg_win, avg_loss,
             vix_regime, market_bias, patterns_worked, patterns_failed,
             vix_assessment, tomorrow_focus, tomorrow_avoid, verdict, metadata, ts)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            today, stats["total"], stats["wins"], stats["losses"],
            stats["win_rate"], stats["total_pnl"], stats["avg_win"], stats["avg_loss"],
            vix_info["regime"], mkt_cond,
            analysis.get("patterns_worked", ""),
            analysis.get("patterns_failed", ""),
            analysis.get("vix_assessment", ""),
            analysis.get("tomorrow_focus", ""),
            analysis.get("tomorrow_avoid", ""),
            analysis.get("verdict", "AVERAGE"),
            _meta,
            _dt.now().isoformat()
        ))
        con.commit()
        con.close()
    except Exception as e:
        log.warning("EOD DB write failed: %s", e)

    verdict = analysis.get("verdict", "AVERAGE")
    verdict_icon = {"STRONG": "🟢", "GOOD": "🟡", "AVERAGE": "🟠",
                    "POOR": "🔴", "LEARNING_DAY": "📚"}.get(verdict, "📊")
    pnl_icon = "📈" if stats["total_pnl"] >= 0 else "📉"

    send_message(
        f"📊 *EOD Analysis — {today}*\n\n"
        f"{pnl_icon} *{stats['total']} trades* | {stats['wins']}W/{stats['losses']}L "
        f"({stats['win_rate']}%) | ${stats['total_pnl']:+.2f}\n"
        f"VIX {vix_info['vix']:.1f} {vix_info['regime']} | {mkt_cond}\n\n"
        f"{verdict_icon} *{verdict}*\n\n"
        f"✅ *Worked:* {analysis.get('patterns_worked','')}\n\n"
        f"❌ *Failed:* {analysis.get('patterns_failed','')}\n\n"
        f"📡 *VIX:* {analysis.get('vix_assessment','')}\n\n"
        f"🔮 *Tomorrow — focus:* {analysis.get('tomorrow_focus','')}\n"
        f"⚠️ *Tomorrow — avoid:* {analysis.get('tomorrow_avoid','')}"
    )
    log.info("EOD analysis sent for %s", today)


def job_scan_crypto():
    """
    Dedicated 15-min crypto scan — runs 24/7, independent of stock market hours
    and Riley windows.  Goes through the full pipeline: find_sr_zones, Riley gate,
    confidence scoring, VIX regime, dual direction, and Telegram notifications.
    The scan lock prevents overlap with job_scan_market.
    """
    if paused[0] or not trading_enabled():
        log.info("AI trader is paused/OFF — skipping crypto scan")
        return
    if not _scan_lock.acquire(blocking=False):
        log.info("Scan already in progress — skipping crypto scan slot")
        return
    try:
        from agents import is_crypto as _ic
        crypto_tickers = [t for t in watchlist if _ic(t)]
        if not crypto_tickers:
            log.info("No crypto tickers in watchlist — skipping crypto scan")
            return
        log.info("Crypto scan: %d tickers — %s", len(crypto_tickers), crypto_tickers)
        trades = scan_all(crypto_tickers, notify_fn=send_alert)
        if trades:
            log.info("Crypto scan: %d trade(s) executed", len(trades))
    except Exception as e:
        log.error("Crypto scan failed: %s", e)
    finally:
        _scan_lock.release()


def job_crypto_order_timeout():
    """Every-minute sweep — cancels crypto (GTC) orders pending for more than 3 minutes."""
    try:
        from agents import check_pending_crypto_order_timeouts
        check_pending_crypto_order_timeouts()
    except Exception as e:
        log.error("Crypto order timeout check failed: %s", e)


def job_crypto_status():
    """30-min crypto status heartbeat — runs 24/7. Equity + open positions + last scan result."""
    try:
        from agents import scan_all, is_crypto as _ic, get_market_bias

        # No crypto tickers on the watchlist — nothing to report, skip the message
        if not any(_ic(t) for t in DEFAULT_WATCHLIST):
            return

        try:
            acct    = alpaca.get_account()
            equity  = float(acct.equity)
            pnl     = equity - float(acct.last_equity)
            pnl_pct = pnl / float(acct.last_equity) * 100 if float(acct.last_equity) else 0
        except Exception:
            equity = pnl = pnl_pct = 0

        try:
            all_pos    = alpaca.list_positions()
            crypto_pos = [p for p in all_pos
                          if _ic(p.symbol.replace("/", ""))]
        except Exception:
            crypto_pos = []

        last_prices   = getattr(scan_all, "_last_prices",  {})
        last_results  = getattr(scan_all, "_last_results", {})
        last_ts       = last_results.get("timestamp", "—")
        last_trades   = [t for t in (last_results.get("trades")   or []) if _ic(t.get("ticker", ""))]
        last_analyzed = [r for r in (last_results.get("analyzed") or []) if _ic(r.get("ticker", ""))]

        lines = ["₿ *Crypto Status*"]
        lines.append(f"💼 Equity: ${equity:,.2f} ({pnl_pct:+.2f}% today)")
        lines.append("")

        # Current prices
        _price_parts = []
        for _sym, _lbl in [("BTCUSD","BTC"), ("ETHUSD","ETH"), ("SOLUSD","SOL")]:
            _p = last_prices.get(_sym, 0)
            if _p > 0:
                _price_parts.append(f"{_lbl} ${_p:,.0f}" if _p >= 100 else f"{_lbl} ${_p:.4f}")
        if _price_parts:
            lines.append("💰 " + " | ".join(_price_parts))

        # Market bias (SPY) + ES/NQ correlation (SPY vs QQQ — additive confirmation)
        try:
            _bias      = get_market_bias()
            _bias_icon = {"BULLISH":"📈","BEARISH":"📉","NEUTRAL":"➡️"}.get(_bias, "➡️")
            lines.append(f"{_bias_icon} SPY bias: {_bias}")
            from agents import check_spy_qqq_alignment as _cqa
            _align = _cqa()
            if _align.get("diverged"):
                lines.append(f"⚠️ ES/NQ DIVERGENCE — staying cautious ({_align.get('summary','')})")
            elif _align.get("aligned"):
                lines.append(f"✅ ES/NQ aligned ({_align.get('summary','')})")
        except Exception:
            pass
        lines.append("")

        # Open crypto positions
        if crypto_pos:
            lines.append("📂 *Open Positions:*")
            for p in crypto_pos:
                _side   = "LONG" if float(p.qty) > 0 else "SHORT"
                _pnl_p  = round(float(p.unrealized_plpc) * 100, 2)
                _arrow  = "▲" if _pnl_p >= 0 else "▼"
                _entry  = float(p.avg_entry_price)
                _ep_fmt = f"${_entry:,.0f}" if _entry >= 100 else f"${_entry:.4f}"
                lines.append(f"  {_arrow} {p.symbol} {_side} @ {_ep_fmt} | {_pnl_p:+.2f}%")
            lines.append("")
        else:
            lines.append("📭 No open crypto positions")
            lines.append("")

        # Last scan summary
        lines.append(f"🔍 *Last scan:* {last_ts}")
        if last_trades:
            for t in last_trades:
                _act = "LONG" if t.get("action") == "BUY" else "SHORT"
                lines.append(f"  ✅ {t.get('ticker','?')} {_act} @ {t.get('confidence','?')}% conf")
        elif last_analyzed:
            for r in last_analyzed[:4]:
                _c  = r.get("confidence", "?")
                _rs = r.get("reason", "")[:40]
                lines.append(f"  ➡️ {r.get('ticker','?')}: {_c}% — {_rs}")
        else:
            lines.append("  No crypto results yet")

        send_message("\n".join(lines))
    except Exception as e:
        log.warning("Crypto status update failed: %s", e)


def job_watch_mode():
    """
    Riley Coleman watch-mode loop — runs every 2 min, weekdays only, during
    the Riley window (9:30am-3:30pm ET — Riley trades the full session, the
    afternoon is slower but valid setups still occur). Manages tickers parked
    in _watch_mode (waiting for a 1-min bait/H&S pattern + structural break)
    and trails open positions on the faster 1-min cadence Riley's method calls
    for. Existing positions are still managed by the regular scan/portfolio
    jobs outside this window — this is purely the higher-frequency watch/trail
    loop for the active trading window.
    """
    try:
        if paused[0] or not trading_enabled():
            return
        now_et = datetime.now(ET)
        if now_et.weekday() >= 5:
            return
        hour_frac = now_et.hour + now_et.minute / 60
        in_window = (9.5 <= hour_frac < 15.5)
        if not in_window:
            return

        from agents import (
            _watch_mode, _detect_1min_pattern_extreme, _watch_mode_trigger_level,
            check_market_structure_shift, execute_watch_mode_entry,
            update_trailing_stop, get_price,
            _position_adjustments as _padj, get_profile as _gprof,
            save_position_state as _sps, log_agent,
        )

        # ── Trail / break-even open positions on the faster Riley cadence ────
        try:
            for p in alpaca.list_positions():
                sym     = p.symbol.replace("/", "")
                entry   = float(p.avg_entry_price)
                current = float(p.current_price)
                pnl_pct = float(p.unrealized_plpc) * 100
                position_side = "short" if float(p.qty) < 0 else "long"
                profile = _gprof(sym)

                adj          = _padj.get(sym, {})
                initial_stop = adj.get("stop_price", current)
                one_r_pct    = abs((initial_stop - entry) / entry * 100) if entry > 0 else 2.0

                if not adj.get("breakeven_triggered") and pnl_pct >= one_r_pct:
                    be_stop = round(entry * 1.0001, 4) if position_side == "long" else round(entry * 0.9999, 4)
                    if sym not in _padj:
                        _padj[sym] = {}
                    _padj[sym]["stop_price"]          = be_stop
                    _padj[sym]["breakeven_triggered"] = True
                    _padj[sym].setdefault("position_side", position_side)
                    _sps(sym, _padj[sym])
                    log_agent("system", "RILEY",
                        f"{sym} [watch-mode] BREAK-EVEN: stop → ${be_stop:.4f} at {pnl_pct:+.1f}% (1R)")

                update_trailing_stop(sym, pnl_pct, profile, send_message,
                                     entry_price=entry, current_price=current)
        except Exception as e:
            log.warning("Watch mode position trail failed: %s", e)

        # ── Manage watched setups — pattern detection then trigger break ─────
        for ticker in list(_watch_mode.keys()):
            watch = _watch_mode.get(ticker)
            if not watch:
                continue
            try:
                price = get_price(ticker)
                if price <= 0:
                    continue

                # ── Chop detection — if price has stayed within a 0.3% range
                # at the zone level for 4+ consecutive checks, the market is
                # accepting this price rather than reversing or breaking —
                # abandon the watch instead of waiting it out.
                _zone_level = watch.get("zone_level", price)
                _recent = watch.setdefault("recent_prices", [])
                _recent.append(price)
                if len(_recent) > 4:
                    del _recent[:-4]
                if (len(_recent) >= 4 and _zone_level
                        and (max(_recent) - min(_recent)) / _zone_level * 100 <= 0.3):
                    log_agent("system", "WATCH",
                        f"WATCH MODE: {ticker} abandoned — chop detected, "
                        f"market accepting this price")
                    _watch_mode.pop(ticker, None)
                    continue

                side   = watch["side"]
                action = "BUY" if side == "LONG" else "SELL"

                if watch.get("trigger_level") is None:
                    # 1-min confirmation — identical to reversal entries:
                    # bait candle (or H&S) OR a lower-high forming for shorts /
                    # higher-low forming for longs.
                    pat = _detect_1min_pattern_extreme(ticker, action)
                    mtf_dir = "BEARISH" if side == "SHORT" else "BULLISH"
                    shift   = check_market_structure_shift(ticker, mtf_dir)
                    bait_confirmed  = pat.get("extreme") is not None
                    shift_confirmed = (
                        (side == "SHORT" and shift.get("shift_type") in
                            ("PARTIAL_BEARISH", "BEARISH_SWING_BREAK")) or
                        (side == "LONG" and shift.get("shift_type") in
                            ("PARTIAL_BULLISH", "BULLISH_SWING_BREAK"))
                    )
                    if bait_confirmed or shift_confirmed:
                        trigger = _watch_mode_trigger_level(ticker, side)
                        if trigger is not None:
                            watch["trigger_level"] = trigger
                            watch["pattern"]       = pat.get("pattern") or shift.get("shift_type")
                            confirm_desc = pat.get("pattern") or \
                                (f"lower high forming ({shift.get('shift_type')})" if side == "SHORT"
                                 else f"higher low forming ({shift.get('shift_type')})")
                            log_agent("system", "WATCH",
                                f"{ticker} pattern confirmed ({confirm_desc}) — "
                                f"trigger set at ${trigger:.4f}")
                else:
                    trigger   = watch["trigger_level"]
                    # LONG  triggers when price breaks ABOVE the swing high (>= trigger).
                    # SHORT triggers when price breaks BELOW the swing low  (<= trigger).
                    triggered = (price >= trigger) if side == "LONG" else (price <= trigger)
                    if triggered:
                        _wm_conf = watch.get("confidence", 0)
                        execute_watch_mode_entry(ticker, side, trigger, price, send_message,
                                                  confidence=_wm_conf)
                        _watch_mode.pop(ticker, None)
                        continue

                watch["candles_checked"] = watch.get("candles_checked", 0) + 1
                if watch["candles_checked"] > 8:
                    log_agent("system", "WATCH",
                        f"WATCH MODE: {ticker} abandoned — chopped out "
                        f"({watch['candles_checked']} candles, no confirmation)")
                    _watch_mode.pop(ticker, None)

            except Exception as e:
                log.warning("Watch mode check failed %s: %s", ticker, e)

    except Exception as e:
        log.warning("job_watch_mode failed: %s", e)


def job_riley_premarket_zones():
    """
    Riley 9:15am ET pre-market zone identification — runs weekdays only.
    Identifies previous-day high/low, pre-market high/low, and psychological
    round-number levels for each watchlist ticker and caches them; these take
    priority over regular zone detection during the 9:30am-3:30pm Riley window.
    """
    try:
        now_et = datetime.now(ET)
        if now_et.weekday() >= 5:
            return
        from agents import job_riley_premarket_zones as _compute_zones
        _compute_zones(DEFAULT_WATCHLIST)
    except Exception as e:
        log.warning("job_riley_premarket_zones failed: %s", e)


def trigger_emergency_scan():
    if paused[0] or not trading_enabled():
        return
    log.info("[WATCHER] Emergency scan triggered")
    active = [t for t in watchlist if should_scan(t)]
    if active:
        scan_all(active, notify_fn=send_alert)

# ── Dashboard agent log API ───────────────────────────────────────────────────

log_api = Flask(__name__)

@log_api.route("/api/agent-log")
def get_agent_log():
    return jsonify(agent_log[-20:])

@log_api.route("/api/watchlist")
def get_watchlist():
    return jsonify({"watchlist": watchlist, "paused": paused[0]})

@log_api.route("/api/zones")
def get_zones():
    """Zone cache for dashboard — one entry per ticker."""
    import re
    from agents import (_last_zones, _position_adjustments, agent_log,
                        DEFAULT_WATCHLIST, alpaca_symbol, is_crypto)

    positions = {}
    try:
        for p in alpaca.list_positions():
            positions[p.symbol] = p
    except Exception:
        pass

    result = {}
    for ticker in DEFAULT_WATCHLIST:
        cached = _last_zones.get(ticker, {})

        # Open position info
        sym = alpaca_symbol(ticker) if is_crypto(ticker) else ticker
        raw_pos = positions.get(sym) or positions.get(ticker)
        position = None
        if raw_pos:
            try:
                entry = float(raw_pos.avg_entry_price)
                adj   = (_position_adjustments.get(sym) or
                         _position_adjustments.get(ticker) or {})
                position = {
                    "entry":         round(entry, 4),
                    "stop":          adj.get("stop_price"),
                    "tp":            adj.get("tp_price"),
                    "pnl_pct":       round(float(raw_pos.unrealized_plpc) * 100, 2),
                    "side":          "LONG" if float(raw_pos.qty) > 0 else "SHORT",
                    "confidence":    cached.get("confidence", 0),
                    "riley_result":  cached.get("riley_result", ""),
                    "candle_pattern": cached.get("candle_pattern", "NONE"),
                }
            except Exception:
                pass

        # Last Grok signal from agent_log
        last_signal = {}
        for entry in reversed(list(agent_log)[-300:]):
            if entry.get("agent") == "GROK" and ticker in entry.get("body", ""):
                m = re.search(r"(BULLISH|BEARISH|NEUTRAL)\s+(\d+)%", entry.get("body", ""))
                if m:
                    last_signal = {
                        "direction":  m.group(1),
                        "confidence": int(m.group(2)),
                        "timestamp":  entry.get("time", ""),
                    }
                break

        result[ticker] = {
            "ticker":       ticker,
            "zones":        cached.get("zones", []),
            "position":     position,
            "last_signal":  last_signal,
            "riley_result": cached.get("riley_result", ""),
            "confidence":   cached.get("confidence", 0),
            "direction":    cached.get("direction",
                                       last_signal.get("direction", "NEUTRAL")),
            "catalyst":     cached.get("catalyst", ""),
            "timestamp":    cached.get("timestamp", ""),
        }
    return jsonify(result)

def run_log_api():
    log_api.run(host="0.0.0.0", port=5001, debug=False, use_reloader=False)

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("\n" + "="*55)
    print("  🤖 Autonomous AI Trading System")
    print("="*55)
    print(f"  Watchlist:    {len(watchlist)} tickers")
    print(f"  Scan interval: Riley window: 9:30am-3:30pm ET (full session)")
    print(f"  AI models:    Grok → analysis | Haiku → checks | Sonnet → decisions")
    print(f"  Stocks:       market hours only (9:30am-4pm ET)")
    print(f"  Crypto:       24/7")
    print(f"  Confidence:   {os.getenv('CONFIDENCE_THRESH', 65)}%+ required")
    print(f"  Mode:         PAPER TRADING")
    print("="*55)

    try:
        account = alpaca.get_account()
        print(f"  ✓ Alpaca connected — equity: ${float(account.equity):,.2f}")
    except Exception as e:
        print(f"  ✗ Alpaca connection failed: {e}")
        return

    if os.getenv("TELEGRAM_BOT_TOKEN") and os.getenv("TELEGRAM_CHAT_ID"):
        print("  ✓ Telegram configured")
    else:
        print("  ✗ Telegram not configured — check .env")

    print()

    # Initialize shared state for REST API
    global _shared_state
    _shared_state = {
        'uptime': 0,
        'market_open': False,
        'equity': 0.0,
        'positions_count': 0,
        'paused': paused[0],
        'watchlist': watchlist,
        'zones': {},
        'signals': [],
        'positions': [],
        'alerts': [],
        'close_position_queue': [],
    }

    # Agent log API (port 5001)
    threading.Thread(target=run_log_api, daemon=True).start()
    print("  ✓ Agent log API started on port 5001")

    # Trading REST API (port 5555)
    threading.Thread(target=run_api_server, args=(_shared_state,), daemon=True).start()
    print("  ✓ Trading REST API started on port 5555")

    # Telegram command listener
    tg_handler = TelegramCommandHandler(
        alpaca     = alpaca,
        watchlist  = watchlist,
        scan_fn    = scan_all,
        paused_ref = paused,
    )
    tg_handler.start()
    print("  ✓ Telegram command listener started")

    # Startup Telegram message — show what's actually being scanned right now
    from agents import is_crypto as _ic, is_market_hours as _imh
    _market_open   = _imh()
    _active_stocks = [t for t in watchlist if not _ic(t)] if _market_open else []
    _paused_stocks = [t for t in watchlist if not _ic(t)] if not _market_open else []

    _status_lines = []
    if _active_stocks:
        _status_lines.append(f"📈 {len(_active_stocks)} stocks active")
    if _paused_stocks:
        _status_lines.append(f"💤 {len(_paused_stocks)} stocks paused (market closed)")


    import pytz as _ptz
    _ET  = _ptz.timezone("America/New_York")
    _now = datetime.now(_ET)
    _market_open = is_market_open_alpaca()
    _next_open = "9:30am ET Mon-Fri" if _now.weekday() < 4 or \
                 (_now.weekday() == 4 and _now.hour < 16) else "Monday 9:30am ET"

    send_message(
        f"🚀 *AI Trader Started*\n"
        f"📋 {len(watchlist)} stocks on watchlist\n"
        f"{'📈 Market OPEN — scanning now' if _market_open else f'💤 Market closed — next scan at {_next_open}'}\n"
        f"⏱ Riley window: 9:30am-3:30pm ET (full session)\n"
        f"💼 Equity: ${get_portfolio_equity():,.2f}\n\n"
        f"Send /help to see all commands\n"
        f"🔍 Running first scan now..."
    )

    # Scheduler
    scheduler = BackgroundScheduler(
        timezone=ET,
        job_defaults={
            "max_instances": 2,       # allow overlap (scan + portfolio update)
            "misfire_grace_time": 60, # if job missed by <60s still run it
        }
    )
    # Scan every 15 min during market hours 9:30am-4pm ET Mon-Fri
    scheduler.add_job(job_premarket, "cron",
        day_of_week="mon-fri", hour=9, minute=0,
        timezone=ET, id="premarket_brief")
    # Riley window: full session, 9:30am-3:30pm ET — new entries allowed all
    # day when valid Riley setups form (the 11am check only manages losing
    # positions opened in the morning, it does not stop new entries).
    # Morning (faster cadence): 9:30, 9:45, 10:00, 10:15, 10:30, 10:45, 11:00
    scheduler.add_job(job_scan_market, "cron",
        day_of_week="mon-fri", hour="9-10", minute="30,45",
        timezone=ET, id="market_scan_morning")
    scheduler.add_job(job_scan_market, "cron",
        day_of_week="mon-fri", hour=10, minute="0,15",
        timezone=ET, id="market_scan_10h")
    scheduler.add_job(job_scan_market, "cron",
        day_of_week="mon-fri", hour=11, minute="0",
        timezone=ET, id="market_scan_morning_close")
    # Midday: 11:30, 12:00, 12:30 — catches setups after morning volatility settles
    scheduler.add_job(job_scan_market, "cron",
        day_of_week="mon-fri", hour=11, minute=30,
        timezone=ET, id="market_scan_midday_1130")
    scheduler.add_job(job_scan_market, "cron",
        day_of_week="mon-fri", hour=12, minute="0,30",
        timezone=ET, id="market_scan_midday_12h")
    # Afternoon (slower cadence — every 30 min): 1:00, 1:30, 2:00, 2:30, 3:00, 3:30
    # The afternoon session is slower but valid Riley setups still occur.
    scheduler.add_job(job_scan_market, "cron",
        day_of_week="mon-fri", hour=13, minute="0,30",
        timezone=ET, id="market_scan_afternoon_13h")
    scheduler.add_job(job_scan_market, "cron",
        day_of_week="mon-fri", hour=14, minute="0,30",
        timezone=ET, id="market_scan_afternoon_14h")
    scheduler.add_job(job_scan_market, "cron",
        day_of_week="mon-fri", hour=15, minute="0,30",
        timezone=ET, id="market_scan_afternoon_close")
    scheduler.add_job(job_portfolio_update, "cron",
        day_of_week="mon-fri", hour="9-15", minute="*/30",
        timezone=ET, id="portfolio_update")
    scheduler.add_job(
        job_eod_check, "cron",
        day_of_week="mon-fri", hour=15, minute=30,
        timezone=ET, id="eod_check"
    )
    scheduler.add_job(
        job_eod_analysis, "cron",
        day_of_week="mon-fri", hour=16, minute=15,
        timezone=ET, id="eod_analysis"
    )
    # ── Dedicated crypto scan — every 15 min, 24/7 ───────────────────────────
    # Runs independently of stock market hours and Riley windows.
    # The scan lock prevents overlap with job_scan_market.
    # During stock market hours: provides extra crypto coverage between Riley windows.
    # Outside market hours: only scan active (stocks are skipped by scan_all anyway).
    scheduler.add_job(job_scan_crypto, "cron",
        minute="0,15,30,45",
        timezone=ET, id="crypto_scan_15min")
    scheduler.add_job(job_crypto_status, "interval",
        minutes=30, id="crypto_status_30min")
    # ── Cancel crypto (GTC) orders stuck pending for more than 3 minutes —
    # they never expire on their own and would otherwise tie up buying power.
    scheduler.add_job(job_crypto_order_timeout, "interval",
        minutes=1, id="crypto_order_timeout")
    # ── Riley watch-mode loop — every 2 min; the job itself only acts during
    # the Riley window (9:30am-3:30pm ET weekdays — full session), but stays
    # registered around the clock so it never misses the window's start.
    scheduler.add_job(job_watch_mode, "interval",
        minutes=2, id="riley_watch_mode")
    # ── Riley pre-market zone identification — 9:15am ET weekdays, ahead of
    # the 9:30am-3:30pm trading window. Caches prev-day/pre-market high-low and
    # psychological levels that take priority over regular zone detection.
    scheduler.add_job(job_riley_premarket_zones, "cron",
        day_of_week="mon-fri", hour=9, minute=15,
        timezone=ET, id="riley_premarket_zones")
    scheduler.add_job(
        job_weekly_report, "cron",
        day_of_week="sun", hour=20, minute=0,
        timezone=ET, id="weekly_report"
    )
    scheduler.add_job(
        job_watchlist_scan, "cron",
        day_of_week="sat", hour=9, minute=0,
        timezone=ET, id="watchlist_scan"
    )
    scheduler.start()
    print("  ✓ Scheduler started — 9:30/9:45/10:00... every 15min, Mon-Fri\n")

    # Price watcher
    from agents import alpaca_symbol
    watcher = PriceWatcher(
        alpaca            = alpaca,
        watchlist         = watchlist,
        notify_fn         = send_alert,
        scan_trigger_fn   = trigger_emergency_scan,
        get_positions_fn  = get_open_positions,
        is_crypto_fn      = is_crypto,
        alpaca_symbol_fn  = alpaca_symbol,
        get_profile_fn    = get_profile,
        close_position_fn = close_position,
        is_market_hours_fn= is_market_hours,
    )
    watcher.start()
    print("  ✓ Price watcher started — checking every 30 seconds")

    # Run first scan immediately in background
    # This IS the session start scan — results go to Telegram via job_scan_market
    def first_scan():
        time.sleep(3)  # short delay so watcher initializes first
        job_scan_market()
    threading.Thread(target=first_scan, daemon=True).start()
    print("  ✓ First scan running now...")
    print(f"\n  Dashboard agent feed: http://localhost:5001/api/agent-log")
    print(f"  Watchlist API:        http://localhost:5001/api/watchlist")
    print("\n  Press Ctrl+C to stop\n")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n  Shutting down...")
        try:
            scheduler.shutdown(wait=False)
        except:
            pass
        try:
            send_message("🛑 *AI Trader stopped* — manual shutdown")
        except:
            pass
        print("  Done.")
        os._exit(0)

if __name__ == "__main__":
    main()