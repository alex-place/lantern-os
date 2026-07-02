#!/usr/bin/env python3
"""
Trading Agents CLI — Bridge for Node.js subprocess calls

This module exposes trading agent functions as a command-line interface
that can be called from Node.js (trader-agent.js) via subprocess.

Usage:
  python cli.py <action> <args_json>

Example:
  python cli.py scan_market '{"watchlist": ["SPY", "AAPL"]}'
  python cli.py get_zones '{"ticker": "AAPL"}'
  python cli.py get_market_status '{}'

All output is JSON to stdout.
"""

import sys
import json
import os
import logging
from datetime import datetime, timedelta, timezone

# Setup logging to stderr so stdout stays clean for JSON
logging.basicConfig(
    level=logging.WARNING,
    format='%(asctime)s [%(levelname)s] %(message)s',
    stream=sys.stderr
)
log = logging.getLogger(__name__)


def _flt(v, default=0.0):
    """Coerce Alpaca string/None numeric fields to float, else `default`."""
    if v is None:
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# Import trading agents
try:
    from agents import (
        scan_all,
        get_portfolio_equity,
        get_open_positions,
        is_market_hours,
        is_crypto,
        get_profile,
        agent_log,
        DEFAULT_WATCHLIST,
        ASSET_PROFILES,
        alpaca,
        validate_symbol,
    )
except ImportError as e:
    # agents.py not available — evaluate_* actions still work without it
    validate_symbol = None
    scan_all = None
    get_portfolio_equity = None
    get_open_positions = None
    is_market_hours = lambda: False
    is_crypto = lambda t: False
    get_profile = lambda t: {}
    agent_log = []
    DEFAULT_WATCHLIST = ["SPY", "AAPL", "TSLA", "NVDA", "MSFT"]
    ASSET_PROFILES = {}
    alpaca = None
    _agents_import_error = str(e)


def action_validate_symbol(args):
    """Validate a ticker symbol before it's added to the watchlist (#1624)."""
    ticker = (args.get('ticker') or '').strip()
    if not ticker:
        return {'valid': False, 'reason': 'ticker required'}
    if validate_symbol is None:
        # Engine unavailable — don't hard-block the add, but flag it unverified.
        return {'valid': True, 'tradable': None, 'symbol': ticker.upper(),
                'reason': 'engine unavailable — not verified'}
    return validate_symbol(ticker)


def action_scan_market(args):
    """
    Scan market for trading signals

    Args: {watchlist: ["SPY", "AAPL", ...]}
    Returns: {signals: [...], zones: {...}, timestamp: "...", metadata: {...}}
    """
    watchlist = args.get('watchlist', DEFAULT_WATCHLIST)

    try:
        # Scan all tickers
        signals = scan_all(watchlist)

        # Build zones data from signals
        zones = {}
        for signal in signals:
            if isinstance(signal, dict) and 'symbol' in signal:
                ticker = signal['symbol']
                zones[ticker] = {
                    'mid': signal.get('zone_mid', signal.get('entry_price', 0)),
                    'top': signal.get('resistance', 0),
                    'bottom': signal.get('support', 0),
                    'type': 'SUPPORT' if signal.get('direction') == 'BEARISH' else 'RESISTANCE',
                    'strength': signal.get('confidence', 0),
                    'touches': 1,
                    'triggered_entry': False,
                }

        return {
            'signals': signals,
            'zones': zones,
            # The engine's per-ticker decision log (why each ticker entered or was
            # skipped) — so the UI can SHOW that it's actually looking for entries,
            # not just report "0 signals". Newest last; capped in log_agent at 100.
            'logs': list(agent_log),
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'watchlist_count': len(watchlist),
            'signals_count': len(signals)
        }
    except Exception as e:
        log.error(f"scan_market failed: {str(e)}", exc_info=True)
        return {
            'signals': [],
            'zones': {},
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'error': str(e)
        }


def action_get_zones(args):
    """
    Get market zones for a specific ticker

    Args: {ticker: "AAPL"}
    Returns: {ticker: "AAPL", support: 0.0, resistance: 0.0, ...}
    """
    ticker = args.get('ticker')
    if not ticker:
        return {'error': 'ticker required'}

    try:
        # Get profile for the ticker
        profile = get_profile(ticker)

        # Get positions to see if we have an open trade
        try:
            positions = alpaca.list_positions()
            position = next((p for p in positions if p.symbol == ticker), None)
        except:
            position = None

        return {
            'ticker': ticker,
            'profile': profile,
            'position': {
                'entry': float(position.avg_entry_price) if position else None,
                'current': float(position.current_price) if position else None,
                'qty': float(position.qty) if position else 0,
            } if position else None,
            'support': None,
            'resistance': None,
            'trend': 'NEUTRAL',
            'volatility': 'NORMAL',
        }
    except Exception as e:
        log.error(f"get_zones failed for {ticker}: {str(e)}")
        return {
            'ticker': ticker,
            'error': str(e)
        }


def action_get_market_status(args):
    """
    Get overall market status

    Args: {}
    Returns: {market_open: bool, vix: float, vix_regime: str, ...}
    """
    try:
        market_open = is_market_hours()

        # Try to get VIX from Alpaca
        vix = 15.0  # Default fallback
        vix_regime = 'CALM'
        try:
            vix_bar = alpaca.get_latest_bar('VIXY')
            if vix_bar:
                vix = float(vix_bar.c)
                if vix < 20:
                    vix_regime = 'CALM'
                elif vix < 30:
                    vix_regime = 'ELEVATED'
                elif vix < 40:
                    vix_regime = 'HIGH'
                else:
                    vix_regime = 'EXTREME'
        except:
            pass

        # Get portfolio equity
        try:
            account = alpaca.get_account()
            equity = float(account.equity)
            last_equity = float(account.last_equity)
            day_pnl_pct = ((equity - last_equity) / last_equity * 100) if last_equity > 0 else 0
        except:
            equity = 0
            day_pnl_pct = 0

        # SPY 1-day / 5-day % change
        spy_1d = 0.0
        spy_5d = 0.0
        try:
            spy_bars = alpaca.get_bars('SPY', '1Day', limit=6).df
            closes = spy_bars['close']
            if len(closes) >= 2:
                spy_1d = (closes.iloc[-1] - closes.iloc[-2]) / closes.iloc[-2] * 100
            if len(closes) >= 2:
                spy_5d = (closes.iloc[-1] - closes.iloc[0]) / closes.iloc[0] * 100
        except:
            pass

        # Honest day P&L from activity (#1691), not equity-vs-last_equity; and the
        # market regime from SPY (the real market), not the account's frozen P&L.
        # TODAY-only unrealized (intraday) + realized bucketed by close date so a
        # multi-day hold never drags a prior session's P&L into today.
        import sqlite3 as _sql
        unrealized = 0.0
        try:
            unrealized = sum(
                _flt(getattr(p, 'unrealized_intraday_pl', None),
                     default=_flt(getattr(p, 'unrealized_pl', 0)))
                for p in alpaca.list_positions())
        except Exception:
            pass
        realized_today = 0.0
        try:
            from agents import LESSONS_DB as _DB
            _con = _sql.connect(_DB)
            _row = _con.execute(
                "SELECT COALESCE(SUM(pnl_usd),0) FROM trade_history "
                "WHERE status='closed' AND pnl_usd IS NOT NULL "
                "AND COALESCE(closed_ts, ts) LIKE ?",
                (datetime.now().strftime('%Y-%m-%d') + '%',)).fetchone()
            _con.close()
            realized_today = float(_row[0] or 0)
        except Exception:
            pass
        day_pnl_usd = round(unrealized + realized_today, 2)
        day_pnl_pct = round(day_pnl_usd / equity * 100, 2) if equity else 0
        return {
            'market_open': market_open,
            'vix': vix,
            'vix_regime': vix_regime,
            'market': 'BULLISH' if spy_1d > 0.1 else 'BEARISH' if spy_1d < -0.1 else 'NEUTRAL',
            'spy_1d': round(float(spy_1d), 2),
            'spy_5d': round(float(spy_5d), 2),
            'day_pnl_pct': day_pnl_pct,
            'day_pnl_usd': day_pnl_usd,
            'equity': equity,
            'timestamp': datetime.utcnow().isoformat() + 'Z'
        }
    except Exception as e:
        log.error(f"get_market_status failed: {str(e)}")
        return {
            'market_open': False,
            'vix': 0.0,
            'vix_regime': 'UNKNOWN',
            'error': str(e),
            'timestamp': datetime.utcnow().isoformat() + 'Z'
        }


def _fetch_watchlist_price(ticker):
    """Fetch price + previous close for a single watchlist ticker (one Alpaca
    round trip for crypto, two for equities). Run via ThreadPoolExecutor so
    the 16-ticker watchlist doesn't pay for these sequentially."""
    try:
        sym = ticker
        # Handle crypto naming (e.g., BTCUSD → BTC/USD for Alpaca)
        if is_crypto(ticker):
            sym = ticker.replace('USD', '/USD')
            try:
                bar = alpaca.get_crypto_bars(sym, '1Hour', limit=2).df
                if not bar.empty:
                    price = float(bar['close'].iloc[-1])
                    prev = float(bar['close'].iloc[-2]) if len(bar) >= 2 else price
                else:
                    price = 0
                    prev = 0
            except Exception:
                price = 0
                prev = 0
            is_crypto_flag = True
        else:
            try:
                trade = alpaca.get_latest_trade(ticker, feed='iex')
                price = float(trade.price) if trade else 0
                day_start = (datetime.now(timezone.utc) - timedelta(days=10)).strftime('%Y-%m-%d')
                bars = alpaca.get_bars(ticker, '1Day', start=day_start, limit=2, feed='iex', sort='desc').df
                prev = float(bars['close'].iloc[1]) if len(bars) >= 2 else price
            except Exception:
                price = 0
                prev = 0
            is_crypto_flag = False

        chg_pct = ((price - prev) / prev * 100) if prev > 0 else 0

        return {
            'ticker': ticker,
            'price': round(price, 4),
            'chg_pct': round(chg_pct, 2),
            'is_crypto': is_crypto_flag
        }
    except Exception as e:
        log.warning(f"Failed to get price for {ticker}: {str(e)}")
        return {
            'ticker': ticker,
            'price': 0,
            'chg_pct': 0,
            'is_crypto': is_crypto(ticker)
        }


def action_get_watchlist_prices(args):
    """
    Get live prices for watchlist tickers

    Args: {tickers: ["SPY", "AAPL", ...]}
    Returns: [{ticker: "SPY", price: 100.50, chg_pct: 0.5, is_crypto: false}, ...]
    """
    tickers = args.get('tickers', DEFAULT_WATCHLIST)

    from concurrent.futures import ThreadPoolExecutor, as_completed

    results = {t: {'ticker': t, 'price': 0, 'chg_pct': 0, 'is_crypto': is_crypto(t)} for t in tickers}
    with ThreadPoolExecutor(max_workers=min(len(tickers), 8), thread_name_prefix="wlprice") as ex:
        futures = {ex.submit(_fetch_watchlist_price, t): t for t in tickers}
        try:
            for fut in as_completed(futures, timeout=30):
                t = futures[fut]
                results[t] = fut.result()
        except TimeoutError:
            log.warning("get_watchlist_prices: some tickers timed out")

    return [results[t] for t in tickers]


def action_get_positions(args):
    """
    Get current open positions

    Args: {}
    Returns: {positions: [...], account: {equity: ..., cash: ..., ...}}
    """
    try:
        positions_list = alpaca.list_positions()
        account = alpaca.get_account()

        positions = []
        for pos in positions_list:
            # unrealized_pl is lifetime (from entry price); unrealized_intraday_pl
            # is TODAY-only (from the prior session's close). For a multi-day hold
            # the two differ — intraday excludes the gain/loss that accrued on
            # earlier days, which is exactly what Day P&L must not double-count.
            u_life = _flt(getattr(pos, 'unrealized_pl', 0))
            u_intraday = _flt(getattr(pos, 'unrealized_intraday_pl', None),
                              default=u_life)
            positions.append({
                'symbol': pos.symbol,
                'qty': float(pos.qty),
                'avg_entry_price': float(pos.avg_entry_price),
                'current_price': float(pos.current_price),
                'side': pos.side,
                'market_value': float(pos.market_value),
                'unrealized_pl': u_life,
                'unrealized_intraday_pl': u_intraday,
                'unrealized_plpc': float(pos.unrealized_plpc),
                'pnl_pct': float(pos.unrealized_plpc) * 100,
            })

        # Day P&L from ACTUAL trading activity, not Alpaca's equity-vs-last_equity
        # (which freezes after-hours and shows phantom gains with zero positions —
        # #1691): TODAY-only unrealized on open positions + realized on trades
        # CLOSED TODAY. Two boundary fixes over the original #1691 version:
        #   • realized is bucketed by closed_ts (fall back to ts for legacy rows),
        #     so an overnight hold's result lands on the day it was CLOSED.
        #   • unrealized uses the intraday figure so a position opened yesterday
        #     doesn't drag yesterday's move into today's Day P&L.
        # When flat with no trades today this is exactly $0.
        import sqlite3 as _sql
        from datetime import datetime as _dt
        unrealized_today = sum(p['unrealized_intraday_pl'] for p in positions)
        unrealized_total = sum(p['unrealized_pl'] for p in positions)
        realized_today = 0.0
        try:
            from agents import LESSONS_DB as _DB
            _con = _sql.connect(_DB)
            _today = _dt.now().strftime('%Y-%m-%d')
            _row = _con.execute(
                "SELECT COALESCE(SUM(pnl_usd),0) FROM trade_history "
                "WHERE status='closed' AND pnl_usd IS NOT NULL "
                "AND COALESCE(closed_ts, ts) LIKE ?",
                (_today + '%',)).fetchone()
            _con.close()
            realized_today = float(_row[0] or 0)
        except Exception as _e:
            log.warning("realized-today query failed: %s", _e)
        equity = round(float(account.equity), 2)
        day_pnl = round(unrealized_today + realized_today, 2)
        return {
            'positions': positions,
            'account': {
                'equity': equity,
                'cash': round(float(account.cash), 2),
                'buying_power': round(float(account.buying_power), 2),
                'pnl_today': day_pnl,
                'day_pnl_pct': round(day_pnl / equity * 100, 2) if equity else 0,
                'realized_today': round(realized_today, 2),
                'unrealized': round(unrealized_today, 2),
                'unrealized_total': round(unrealized_total, 2),
            }
        }
    except Exception as e:
        log.error(f"get_positions failed: {str(e)}")
        return {
            'positions': [],
            'account': {
                'equity': 0,
                'cash': 0,
                'buying_power': 0,
                'pnl_today': 0
            },
            'error': str(e)
        }


def action_get_orders(args):
    """
    Broker-truth order history straight from Alpaca — every order the account
    submitted, autonomous (Σ₀ engine) or manual. Args: {limit?: int}.
    Returns: {orders: [{id, symbol, side, qty, type, limit_price, status,
              filled_avg_price, filled_at, submitted_at, created_at}], count}.
    """
    def _f(v):
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None
    try:
        limit = int(args.get('limit', 50) or 50)
        raw = alpaca.list_orders(status='all', limit=max(1, min(limit, 500)),
                                 direction='desc', nested=False)
        orders = []
        for o in raw:
            qty = _f(getattr(o, 'qty', None))
            if not qty:
                qty = _f(getattr(o, 'filled_qty', None)) or 0
            orders.append({
                'id':               str(getattr(o, 'id', '') or ''),
                'symbol':           getattr(o, 'symbol', '') or '',
                'side':             getattr(o, 'side', '') or '',
                'qty':              qty,
                'type':             getattr(o, 'type', None) or getattr(o, 'order_type', None) or 'market',
                'limit_price':      _f(getattr(o, 'limit_price', None)),
                'status':           getattr(o, 'status', '') or '',
                'filled_avg_price': _f(getattr(o, 'filled_avg_price', None)),
                'filled_at':        str(getattr(o, 'filled_at', '') or '') or None,
                'submitted_at':     str(getattr(o, 'submitted_at', '') or '') or None,
                'created_at':       str(getattr(o, 'created_at', '') or '') or None,
            })
        return {'orders': orders, 'count': len(orders)}
    except Exception as e:
        log.error(f"get_orders failed: {str(e)}")
        return {'orders': [], 'count': 0, 'error': str(e)}


def action_get_bars(args):
    """
    Get OHLCV bars for a ticker

    Args: {ticker: "AAPL", timeframe: "1h"}
    Returns: {bars: [...], ticker: "AAPL", timeframe: "1h", count: N}
    """
    ticker = args.get('ticker')
    timeframe = args.get('timeframe', '1h')

    if not ticker:
        return {'error': 'ticker required'}

    # Map timeframes to Alpaca format
    timeframe_map = {
        '1m': '1Min',
        '5m': '5Min',
        '15m': '15Min',
        '1h': '1Hour',
        '4h': '4Hour',
        '1d': '1Day',
    }

    alpaca_tf = timeframe_map.get(timeframe, '1Hour')

    # Alpaca's bars endpoint returns no bars at all if `start` is omitted,
    # so request a lookback window wide enough to cover ~100 bars even
    # accounting for weekends/holidays/after-hours gaps.
    lookback_days = {
        '1m': 7, '5m': 14, '15m': 21, '1h': 30, '4h': 60, '1d': 200,
    }
    start = (datetime.now(timezone.utc) - timedelta(days=lookback_days.get(timeframe, 30))).strftime('%Y-%m-%d')

    try:
        if is_crypto(ticker):
            sym = ticker.replace('USD', '/USD')
            bars_df = alpaca.get_crypto_bars(sym, alpaca_tf, start=start, limit=100, sort='desc').df.iloc[::-1]
        else:
            bars_df = alpaca.get_bars(ticker, alpaca_tf, start=start, limit=100, feed='iex', sort='desc').df.iloc[::-1]

        bars = []
        for idx, row in bars_df.iterrows():
            bars.append({
                'timestamp': str(idx),
                'open': float(row['open']),
                'high': float(row['high']),
                'low': float(row['low']),
                'close': float(row['close']),
                'volume': float(row['volume']) if 'volume' in row else 0,
            })

        return {
            'bars': bars,
            'ticker': ticker,
            'timeframe': timeframe,
            'count': len(bars)
        }
    except Exception as e:
        log.error(f"get_bars failed for {ticker}: {str(e)}")
        return {
            'bars': [],
            'ticker': ticker,
            'timeframe': timeframe,
            'count': 0,
            'error': str(e)
        }



def action_evaluate_asset(args):
    """
    Evaluate a single asset through the TradingTesseract (Phase 4, issue #325).

    Args: {
        asset:       str  — ticker symbol, e.g. 'AAPL',
        zones_data:  dict — optional; if omitted, a scan_market is run first,
        market_status: dict — optional; if omitted, get_market_status is called,
        agent_log:   list — optional agent-log entries
    }
    Returns: { asset, cube: {time,market,signal,layer,asset_state},
               confidence, action, evaluated_at }
    """
    try:
        from trading_tesseract import TradingTesseract
    except ImportError as e:
        return {'error': f'TradingTesseract not available: {e}', 'type': 'import_error'}

    asset = args.get('asset', '').upper()
    if not asset:
        return {'error': 'asset is required', 'type': 'validation_error'}

    # Resolve inputs — use provided data or fetch live
    zones_data = args.get('zones_data')
    if zones_data is None:
        try:
            scan = action_scan_market({'watchlist': [asset]})
            zones_data = scan.get('zones', {})
        except Exception:
            zones_data = {}

    market_status = args.get('market_status')
    if market_status is None:
        try:
            market_status = action_get_market_status({})
        except Exception:
            market_status = {}

    agent_log_entries = args.get('agent_log') or []

    tt = TradingTesseract()
    return tt.evaluate(asset, zones_data, market_status, agent_log_entries)


def action_evaluate_watchlist(args):
    """
    Evaluate every asset in a watchlist through the TradingTesseract.

    Args: {
        watchlist:    list[str] — tickers; defaults to DEFAULT_WATCHLIST,
        zones_data:   dict      — optional; omit to fetch live,
        market_status: dict     — optional; omit to fetch live,
        agent_log:    list      — optional agent-log entries
    }
    Returns: { evaluations: [...sorted by confidence desc], evaluated_at }
    """
    try:
        from trading_tesseract import TradingTesseract
    except ImportError as e:
        return {'error': f'TradingTesseract not available: {e}', 'type': 'import_error'}

    watchlist = args.get('watchlist') or DEFAULT_WATCHLIST

    zones_data = args.get('zones_data')
    if zones_data is None:
        try:
            scan = action_scan_market({'watchlist': watchlist})
            zones_data = scan.get('zones', {})
        except Exception:
            zones_data = {}

    market_status = args.get('market_status')
    if market_status is None:
        try:
            market_status = action_get_market_status({})
        except Exception:
            market_status = {}

    agent_log_entries = args.get('agent_log') or []

    tt = TradingTesseract()
    results = tt.evaluate_watchlist(watchlist, zones_data, market_status, agent_log_entries)
    return {
        'evaluations': results,
        'evaluated_at': results[0]['evaluated_at'] if results else None,
        'count': len(results),
    }


def action_place_order(args):
    """
    Place a manual paper order via Alpaca. Optionally attaches a bracket
    (stop-loss / take-profit) for non-crypto tickers.

    Args: {ticker, side: "buy"|"sell", qty: number, type?: "market"|"limit",
           limit_price?: number, time_in_force?: "day"|"gtc",
           stop_loss?: number, take_profit?: number}
    Returns: {status: "placed"|"error", order_id, ticker, side, qty, type,
              stop_loss, take_profit, submitted_at}
    """
    ticker = args.get('ticker')
    side = str(args.get('side', '')).lower()
    qty = args.get('qty')
    order_type = str(args.get('type') or 'market').lower()
    limit_price = args.get('limit_price')
    stop_loss = args.get('stop_loss')
    take_profit = args.get('take_profit')

    if not ticker or side not in ('buy', 'sell') or not qty or float(qty) <= 0:
        return {'status': 'error', 'error': 'ticker, side (buy/sell), and positive qty are required'}

    try:
        sym = ticker.replace('USD', '/USD') if is_crypto(ticker) else ticker
        tif = args.get('time_in_force') or ('gtc' if is_crypto(ticker) else 'day')

        order_kwargs = dict(
            symbol=sym,
            qty=qty,
            side=side,
            type=order_type,
            time_in_force=tif,
            limit_price=round(float(limit_price), 4) if limit_price else None,
        )

        # Bracket orders (stop-loss / take-profit legs) — Alpaca doesn't
        # support these for crypto, so fall back to a plain order there.
        if (stop_loss or take_profit) and not is_crypto(ticker):
            order_kwargs['order_class'] = 'bracket'
            if take_profit:
                order_kwargs['take_profit'] = {'limit_price': round(float(take_profit), 4)}
            if stop_loss:
                order_kwargs['stop_loss'] = {'stop_price': round(float(stop_loss), 4)}

        order = alpaca.submit_order(**order_kwargs)
        return {
            'status': 'placed', 'order_id': order.id, 'ticker': ticker,
            'side': side, 'qty': qty, 'type': order_type,
            'stop_loss': stop_loss, 'take_profit': take_profit,
            'submitted_at': str(getattr(order, 'submitted_at', '') or ''),
        }
    except Exception as e:
        log.error(f"place_order failed for {ticker}: {str(e)}")
        return {'status': 'error', 'error': str(e), 'ticker': ticker}


def action_get_bars_multi(args):
    """
    Get OHLCV bars for multiple tickers in a single process call (avoids
    spawning one Python process per ticker for chart refreshes).

    Args: {tickers: ["SPY", "AAPL", ...], timeframe: "5m"}
    Returns: {bars: {TICKER: {bars: [...], count: N}}, timeframe: "5m"}
    """
    tickers = args.get('tickers') or DEFAULT_WATCHLIST
    timeframe = args.get('timeframe', '5m')

    from concurrent.futures import ThreadPoolExecutor, as_completed

    result = {ticker: {'bars': [], 'count': 0} for ticker in tickers}
    with ThreadPoolExecutor(max_workers=min(len(tickers), 8), thread_name_prefix="bars") as ex:
        futures = {ex.submit(action_get_bars, {'ticker': t, 'timeframe': timeframe}): t for t in tickers}
        try:
            for fut in as_completed(futures, timeout=60):
                t = futures[fut]
                try:
                    bars_result = fut.result()
                    result[t] = {
                        'bars': bars_result.get('bars', []),
                        'count': bars_result.get('count', 0),
                    }
                except Exception as e:
                    log.warning(f"get_bars_multi: {t} failed: {e}")
        except TimeoutError:
            log.warning("get_bars_multi: some tickers timed out")

    return {'bars': result, 'timeframe': timeframe}


def action_list_assets(args):
    """All active, tradable Alpaca assets for the symbol-search popup (#1692).
    Big list (~11k equities + crypto) — the Node bridge caches it and filters
    per query, so this only runs ~once an hour."""
    try:
        raw = list(alpaca.list_assets(status='active'))
        try:
            raw += list(alpaca.list_assets(status='active', asset_class='crypto'))
        except Exception:
            pass
        out = []
        seen = set()
        for a in raw:
            sym = getattr(a, 'symbol', '')
            if not sym or sym in seen or not getattr(a, 'tradable', False):
                continue
            seen.add(sym)
            klass = a._raw.get('class', 'us_equity') if hasattr(a, '_raw') else 'us_equity'
            out.append({
                'symbol': sym,
                'name': (getattr(a, 'name', '') or '')[:80],
                'exchange': getattr(a, 'exchange', '') or '',
                'class': klass,
            })
        return {'assets': out, 'count': len(out)}
    except Exception as e:
        log.error("list_assets failed: %s", e)
        return {'assets': [], 'error': str(e)}


def main():
    """Main CLI entry point"""
    if len(sys.argv) < 2:
        print(json.dumps({
            'error': 'Usage: cli.py <action> [args_json]',
            'actions': [
                'scan_market',
                'get_zones',
                'get_market_status',
                'get_watchlist_prices',
                'get_positions',
                'get_bars',
                'get_bars_multi',
                'place_order'
            ]
        }))
        sys.exit(1)

    action = sys.argv[1]
    args = {}

    if len(sys.argv) > 2:
        try:
            args = json.loads(sys.argv[2])
        except json.JSONDecodeError as e:
            print(json.dumps({
                'error': f'Invalid JSON args: {str(e)}'
            }))
            sys.exit(1)

    # Route to action handler
    handlers = {
        'scan_market': action_scan_market,
        'get_zones': action_get_zones,
        'get_market_status': action_get_market_status,
        'get_watchlist_prices': action_get_watchlist_prices,
        'get_positions': action_get_positions,
        'get_orders': action_get_orders,
        'get_bars': action_get_bars,
        'get_bars_multi': action_get_bars_multi,
        'place_order': action_place_order,
        'evaluate_asset': action_evaluate_asset,
        'evaluate_watchlist': action_evaluate_watchlist,
        'validate_symbol': action_validate_symbol,
        'list_assets': action_list_assets,
    }

    if action not in handlers:
        print(json.dumps({
            'error': f'Unknown action: {action}',
            'available_actions': list(handlers.keys())
        }))
        sys.exit(1)

    try:
        result = handlers[action](args)
        print(json.dumps(result))
        sys.exit(0)
    except Exception as e:
        log.error(f"Action {action} failed: {str(e)}", exc_info=True)
        print(json.dumps({
            'error': str(e),
            'action': action,
            'type': type(e).__name__
        }))
        sys.exit(1)


if __name__ == '__main__':
    main()

