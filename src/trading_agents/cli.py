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
from datetime import datetime

# Setup logging to stderr so stdout stays clean for JSON
logging.basicConfig(
    level=logging.WARNING,
    format='%(asctime)s [%(levelname)s] %(message)s',
    stream=sys.stderr
)
log = logging.getLogger(__name__)

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
    )
except ImportError as e:
    # agents.py not available — evaluate_* actions still work without it
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

        return {
            'market_open': market_open,
            'vix': vix,
            'vix_regime': vix_regime,
            'market': 'BULLISH' if day_pnl_pct > 0 else 'BEARISH' if day_pnl_pct < 0 else 'NEUTRAL',
            'spy_1d': round(float(spy_1d), 2),
            'spy_5d': round(float(spy_5d), 2),
            'day_pnl_pct': day_pnl_pct,
            'day_pnl_usd': equity - last_equity if 'last_equity' in locals() else 0,
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


def action_get_watchlist_prices(args):
    """
    Get live prices for watchlist tickers

    Args: {tickers: ["SPY", "AAPL", ...]}
    Returns: [{ticker: "SPY", price: 100.50, chg_pct: 0.5, is_crypto: false}, ...]
    """
    tickers = args.get('tickers', DEFAULT_WATCHLIST)

    results = []
    for ticker in tickers:
        try:
            # Get latest bar for the ticker
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
                except:
                    price = 0
                    prev = 0
                is_crypto_flag = True
            else:
                try:
                    bar = alpaca.get_latest_bar(ticker)
                    price = float(bar.c) if bar else 0
                    bars = alpaca.get_bars(ticker, '1Day', limit=2).df
                    prev = float(bars['close'].iloc[-2]) if len(bars) >= 2 else price
                except:
                    price = 0
                    prev = 0
                is_crypto_flag = False

            chg_pct = ((price - prev) / prev * 100) if prev > 0 else 0

            results.append({
                'ticker': ticker,
                'price': round(price, 4),
                'chg_pct': round(chg_pct, 2),
                'is_crypto': is_crypto_flag
            })
        except Exception as e:
            log.warning(f"Failed to get price for {ticker}: {str(e)}")
            results.append({
                'ticker': ticker,
                'price': 0,
                'chg_pct': 0,
                'is_crypto': is_crypto(ticker)
            })

    return results


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
            positions.append({
                'symbol': pos.symbol,
                'qty': float(pos.qty),
                'avg_entry_price': float(pos.avg_entry_price),
                'current_price': float(pos.current_price),
                'side': pos.side,
                'market_value': float(pos.market_value),
                'unrealized_pl': float(pos.unrealized_pl),
                'unrealized_plpc': float(pos.unrealized_plpc),
                'pnl_pct': float(pos.unrealized_plpc) * 100,
            })

        return {
            'positions': positions,
            'account': {
                'equity': round(float(account.equity), 2),
                'cash': round(float(account.cash), 2),
                'buying_power': round(float(account.buying_power), 2),
                'pnl_today': round(float(account.equity) - float(account.last_equity), 2),
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

    try:
        if is_crypto(ticker):
            sym = ticker.replace('USD', '/USD')
            bars_df = alpaca.get_crypto_bars(sym, alpaca_tf, limit=100).df
        else:
            bars_df = alpaca.get_bars(ticker, alpaca_tf, limit=100).df

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
                'get_bars'
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
        'get_bars': action_get_bars,
        'evaluate_asset': action_evaluate_asset,
        'evaluate_watchlist': action_evaluate_watchlist,
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

