/**
 * Trading routes — market group.
 *
 * Split out of routes/trading.js (behavior-preserving). Branch bodies are
 * verbatim; the only change is require('../lib/...') -> require('../../lib/...')
 * because this file lives one directory deeper. All shared module-level
 * bindings arrive via the ctx object built in trading.js.
 */

module.exports = async function marketRoutes(req, res, url, ctx) {
  const { deps, sendJson, bridge, traderAgent, getPriceFeed, tradingMemory, getEffectiveUserId } = ctx;


  // ── Integrated Trader Agent Routes (Local, Single-App Model) ──────────────

  // GET /api/trading/zones
  // Market zones (support/resistance) from local trader agent
  if (url.pathname === '/api/trading/zones' && req.method === 'GET') {
    if (!traderAgent) {
      sendJson(res, { zones: {}, error: 'TraderAgent not initialized' }, 503);
      return true;
    }
    try {
      // Never block a page GET on a fresh 90s market scan (#1227). Serve the
      // last-good cached scan instantly; warm/refresh the cache in the background.
      // Cold cache → honest "not ready" now; data appears on a later poll.
      const cacheEntry = traderAgent.cache && traderAgent.cache['market_scan'];
      if (!cacheEntry || !cacheEntry.data) {
        traderAgent.scanMarket().catch(() => {}); // background warm
        sendJson(res, { zones: {}, available: false, reason: 'market scan warming up — data not ready yet' }, 200);
        return true;
      }
      // A cached scan that FAILED (#1861) is not "warming up" — surface the honest
      // reason so the chart shows an unavailable state instead of eternal warm-up
      // or silently-empty overlays. scanMarket() already backs off (short fail
      // TTL), so re-poll to trigger a retry only once the backoff has elapsed.
      if (cacheEntry.data.error) {
        const failStale = (Date.now() - cacheEntry.time) >= (traderAgent._scanFailTtl || 30000);
        if (failStale) traderAgent.scanMarket().catch(() => {}); // background retry
        // Surface the meaningful cause, not the traceback header: prefer the last
        // Error/Exception line (e.g. the Alpaca "Key ID must be given" ValueError),
        // fall back to the first line. Strip CRs so the message stays one line.
        const lines = String(cacheEntry.data.error).replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean);
        const cause = [...lines].reverse().find((l) => /error|exception/i.test(l)) || lines[0] || 'backend error';
        sendJson(res, {
          zones: {}, available: false, failed: true,
          reason: 'market data unavailable — ' + cause.slice(0, 160),
        }, 200);
        return true;
      }
      const scanFresh = (Date.now() - cacheEntry.time) < traderAgent.cacheExpiry;
      if (!scanFresh) traderAgent.scanMarket().catch(() => {}); // refresh in background, serve stale now
      const scan = cacheEntry.data;
      const signals = Array.isArray(scan.signals) ? scan.signals : [];
      if (!scan.error) {
        // The engine's per-ticker decision log (#1623) — surface the REASONS each
        // ticker entered or was skipped (Grok/Riley/Σ₀ EV/threshold), so the feed
        // proves the scanner is actually evaluating every ticker, not just "0
        // signals". Keep only the informative per-ticker lines (drop the engine's
        // own scan-cycle banners, which the summary below already conveys).
        // Keep the feed to the SIGNAL, not the firehose: the Σ₀ EV verdict per
        // ticker (one line each) plus any executed trade / entry / error. Drop the
        // Riley/backtest/break-retest/zone debug spam (~15 lines a scan) that was
        // burying the actual decisions and trades.
        const TRADE_RE = /→\s*ENTER|executed|order placed|placed order|filled|\bEXIT\b|closed.*p&l|trade taken|order failed|trade failed/i;
        const engineLogs = Array.isArray(scan.logs) ? scan.logs : [];
        const decisionLines = engineLogs
          .filter((l) => {
            if (!l || !l.body) return false;
            const agent = String(l.agent || l.type || '').toLowerCase();
            return agent === 'sigma0' || TRADE_RE.test(l.body);
          })
          .slice(-15)
          .map((l, i) => ({
            id: `scan_${scan.timestamp}_eng_${i}`,
            agent: (l.agent || l.type || 'scanner').toString().toLowerCase(),
            action: String(l.body).slice(0, 160),
            symbol: '',
            timestamp: scan.timestamp,
          }));
        const logEntries = [
          {
            id: `scan_${scan.timestamp}_summary`,
            agent: 'scanner',
            action: `Scanned ${scan.watchlist_count ?? '?'} tickers — ${signals.length} signal${signals.length === 1 ? '' : 's'}`,
            symbol: '',
            timestamp: scan.timestamp,
          },
          ...decisionLines,
          ...signals.filter((s) => s && s.symbol).map((s) => ({
            id: `scan_${scan.timestamp}_${s.symbol}`,
            agent: s.agent || 'scanner',
            action: s.direction || s.action || s.status || 'signal',
            symbol: s.symbol,
            confidence: s.confidence,
            timestamp: scan.timestamp,
          })),
        ];
        tradingMemory.recordNewSignals({ logs: logEntries }).catch((e) => {
          console.error('[Trading] /zones agent-log write failed:', e.message);
        });
      }

      // Reshape into the per-ticker shape trader-dashboard.html expects:
      // { zones: [...], position, last_signal, confidence, direction, catalyst }
      let positions = [];
      try {
        const posData = await traderAgent.getPositions();
        positions = (posData && posData.positions) || [];
      } catch (e) {
        console.error('[Trading] /zones positions fetch failed:', e.message);
      }
      const reshaped = {};
      const tickers = new Set([
        ...Object.keys(scan.zones || {}),
        ...signals.map((s) => s.symbol || s.ticker).filter(Boolean),
      ]);
      for (const ticker of tickers) {
        const sig = signals.find((s) => (s.symbol || s.ticker) === ticker) || null;
        const pos = positions.find((p) => p.symbol === ticker) || null;
        reshaped[ticker] = {
          zones: scan.zones && scan.zones[ticker] ? [scan.zones[ticker]] : [],
          position: pos ? { entry: pos.avg_entry_price, current: pos.current_price, qty: pos.qty, pnl_pct: pos.pnl_pct } : null,
          last_signal: sig,
          confidence: (sig && sig.confidence) || 0,
          direction: (sig && sig.direction) || 'NEUTRAL',
          catalyst: (sig && sig.catalyst) || '',
        };
      }
      sendJson(res, { zones: reshaped }, 200);
    } catch (error) {
      console.error('[Trading] /zones error:', error.message);
      sendJson(res, { zones: {}, error: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/watchlist-prices
  // Live prices for monitored tickers
  if (url.pathname === '/api/trading/watchlist-prices' && req.method === 'GET') {
    if (!traderAgent) {
      sendJson(res, [], 503);
      return true;
    }
    try {
      const prices = await traderAgent.getWatchlistPrices();
      sendJson(res, prices || [], 200);
    } catch (error) {
      console.error('[Trading] /watchlist-prices error:', error.message);
      sendJson(res, [], 500);
    }
    return true;
  }

  // GET /api/trading/bars-multi?timeframe=5m
  // OHLCV bars for the whole watchlist in one subprocess call — used to
  // draw the candlestick/line charts on the trader dashboard.
  if (url.pathname === '/api/trading/bars-multi' && req.method === 'GET') {
    if (!traderAgent) {
      sendJson(res, { bars: {} }, 503);
      return true;
    }
    const ALLOWED_TIMEFRAMES = new Set(['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1mo']);
    const timeframeParam = url.searchParams.get('timeframe') || '5m';
    const timeframe = ALLOWED_TIMEFRAMES.has(timeframeParam) ? timeframeParam : '5m';
    try {
      const result = await traderAgent.getBarsMulti(traderAgent.watchlist, timeframe);
      sendJson(res, result, 200);
    } catch (error) {
      console.error('[Trading] /bars-multi error:', error.message);
      sendJson(res, { bars: {}, timeframe, error: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/positions
  // Prefer the user's connected IBKR account (per-user OAuth, ADR-0022) so the
  // header equity / Day P&L and the summary row reflect the broker they linked.
  // Falls back to the legacy Alpaca traderAgent when no IBKR account is connected.
  if (url.pathname === '/api/trading/positions' && req.method === 'GET') {
    // Preview/demo: `?demo=champion` serves a simulated snapshot of the champion
    // DCA strategy (lib/champion-demo) so the dashboard can be shown fully
    // populated without a linked broker. Read-only + labeled demo; never touches
    // a real account. Placed first so it short-circuits before any broker call.
    if (url.searchParams.get('demo') === 'champion') {
      // positionsLive marks the fixture to the live quote feed (user report:
      // "the same numbers for days" — the baked snapshot never moved). Fail-soft
      // to the static snapshot inside positionsLive if quotes are down.
      sendJson(res, await require('../../lib/champion-demo').positionsLive(), 200);
      return true;
    }
    try {
      // OPERATOR VIEW (2026-08-06). The autonomous trader manages the operator
      // account under the fixed id 'local-owner', but this route resolves the
      // BROWSER session's profile id. Those are different identities, so an
      // admin signed in normally queried a profile with no linked broker and the
      // dashboard rendered $0.00 account value / $0 buying power while the bot
      // was trading a $960k IBKR account — the UI could not see the book it
      // exists to monitor.
      //
      // ADMIN ONLY, and only as a FALLBACK below: an admin whose own profile has
      // a broker linked still sees their own account, and non-admins are
      // unaffected, so no real account can leak to a normal user.
      const _sessionUid = getEffectiveUserId(req);
      const _isAdmin = (() => { try { return require('../../lib/auth-middleware').isAdmin(req); } catch (_e) { return false; } })();
      const OPERATOR_UID = process.env.TRADER_OPERATOR_UID || 'local-owner';
      const uid = _sessionUid;
      const alpaca = require('../../lib/alpaca-adapter');
      const { preferredBroker } = require('../../lib/broker-facade');
      // Serve the Alpaca account view (the user's own OAuth account, else the
      // operator's server paper keys). This is the real paper account, not a sim.
      const serveAlpaca = async () => {
        const alpacaAccount = await alpaca.getAccount(uid).catch(() => null);
        if (!alpacaAccount) return false;
        const ap = (await alpaca.getPositions(uid).catch(() => null)) || { positions: [] };
        alpacaAccount.unrealized = (ap.positions || []).reduce((s, p) => s + (Number(p.unrealized_pl) || 0), 0);
        sendJson(res, { positions: ap.positions || [], account: alpacaAccount }, 200);
        return true;
      };
      // BROKER_PREFER=alpaca → Alpaca first; the IBKR path below stays the fallback.
      if (preferredBroker(uid, req) === 'alpaca' && await serveAlpaca()) return true;
      const ibkrAccount = await bridge.getIBKRAccount(uid).catch(() => null);
      if (ibkrAccount) {
        // IBKR keeps just-closed names in the portfolio snapshot as qty:0 rows; they're
        // not positions anymore (a $0 "Long" line the user reads as clutter/loss). Drop them.
        const ibkrPositions = (await bridge.getIBKRPositions(uid).catch(() => []))
          .filter((p) => Math.abs(Number(p && p.qty) || 0) > 0);
        // Reconcile the header's Unrealized P&L with the positions the user actually
        // sees. `ibkrAccount.unrealized` comes from IBKR's /pnl/partitioned `upl`, a
        // real-time subscription that lags on CPAPI (it returned a stale, rounded
        // 6480 while the 10 live positions summed to 1895.84 — the exact mismatch a
        // user reported). The per-position unrealized_pl is derived from the same
        // live marks shown in each row ((current − avg) × qty), so summing it makes
        // the summary reconcile with the table by construction. Day P&L (`pnl_today`,
        // IBKR `dpl`) and Realized (`realized_today`, `rpl`) are genuinely distinct
        // broker metrics and are left untouched.
        if (Array.isArray(ibkrPositions) && ibkrPositions.length) {
          const sumUpl = ibkrPositions.reduce(
            (t, p) => t + (Number(p && p.unrealized_pl) || 0), 0);
          ibkrAccount.unrealized = Math.round(sumUpl * 100) / 100;
          // REALIZED TODAY. IBKR reports $0 on the paper CPAPI (both `rpl` and the
          // portfolio summary), so tally it from the autopilot ledger.
          //
          // SUM EVERY exit row for the day. Two earlier assumptions are now wrong:
          //
          //   "one value per symbol (its LAST exit row)" — true when the ledger was
          //   written at order-placement time and earlier rows were phantom
          //   re-attempts. Since #3203 a row exists only when a sell actually
          //   FILLED, so every row is a real closed trade and keeping just the last
          //   one silently drops the others. SMH alone round-tripped 4x on
          //   2026-08-06.
          //
          //   "skip symbols still open (their exits didn't fill)" — a symbol that
          //   closed and was RE-ENTERED the same day is open again, so its realized
          //   P&L vanished. On 2026-08-07 that dropped QQQ (+$218.48) and XLK
          //   (-$641.92): realized read -$230.98 instead of -$654.42, and Day P&L
          //   would have shown +$80.55 instead of -$342.89.
          //
          // Superseded/estimated rows carry event:'exit_superseded', so they are
          // excluded by the event filter without any special case.
          try {
            const fs = require('fs'), path = require('path');
            const logPath = path.join(__dirname, '..', '..', '..', '..', 'data', 'lantern-garage', 'trading', 'autopilot-trades.jsonl');
            const today = new Date().toISOString().slice(0, 10);
            let realized = 0, any = false;
            for (const line of fs.readFileSync(logPath, 'utf8').split(String.fromCharCode(10))) {
              if (!line.trim()) continue;
              let r; try { r = JSON.parse(line); } catch (_e) { continue; }
              if (!r || r.event !== 'exit') continue;
              if (String(r.ts || '').slice(0, 10) !== today) continue;
              if (r.pnl == null || !Number.isFinite(Number(r.pnl))) continue;
              realized += Number(r.pnl); any = true;
            }
            if (any) ibkrAccount.realized_today = Math.round(realized * 100) / 100;
          } catch (_e) { /* keep the broker realized if the ledger isn't readable */ }
          // DAY P&L = realized today + current unrealized.
          //
          // The previous derivation summed each position's move since YESTERDAY'S
          // CLOSE (prevClose = price/(1+chg%)). For an intraday trader that is
          // simply the wrong quantity: a position opened at 15:36 was credited
          // with the entire morning rally it was never in. Worse, it added
          // `realized_today`, which IBKR CPAPI always reports as 0.00, so every
          // closed loss vanished. On 2026-08-07 that showed +$1,383.96 while the
          // broker read -$337.60 and the fills said -$654.42 realized: the
          // formula counted gains the account never captured and ignored the
          // losses it actually took. It printed a profit on every losing day this
          // week (+$584, +$538, +$1,386).
          //
          // realized_today is reconciled from the ledger just above, and the
          // ledger is now fill-priced (lib/fill-ledger.js), so this is consistent
          // with the positions table the user is looking at. It excludes
          // commissions, which the ledger does not track — expect a small gap to
          // the broker's own dpl, in that direction only.
          try {
            let unreal = 0;
            for (const p of ibkrPositions) unreal += Number(p.unrealized_pl) || 0;
            const realized = Number(ibkrAccount.realized_today) || 0;
            ibkrAccount.pnl_today = Math.round((realized + unreal) * 100) / 100;
            ibkrAccount.pnl_pct = ibkrAccount.equity ? (ibkrAccount.pnl_today / ibkrAccount.equity) * 100 : 0;
            ibkrAccount.pnl_basis = 'realized(ledger fills) + unrealized; excludes commissions';
          } catch (_e) { /* keep the broker dpl if positions are unreadable */ }
        }
        sendJson(res, { positions: ibkrPositions, account: ibkrAccount }, 200);
        return true;
      }
      // No IBKR account (or IBKR preferred but unavailable) → Alpaca fallback.
      if (await serveAlpaca()) return true;
      // Nothing resolved for the session profile — fall back to the operator
      // account so the admin dashboard shows the book the trader actually runs.
      if (_isAdmin && _sessionUid !== OPERATOR_UID) {
        const opAccount = await bridge.getIBKRAccount(OPERATOR_UID).catch(() => null);
        if (opAccount) {
          const opPositions = (await bridge.getIBKRPositions(OPERATOR_UID).catch(() => []))
            .filter((p) => Math.abs(Number(p && p.qty) || 0) > 0);
          if (opPositions.length) {
            opAccount.unrealized = Math.round(opPositions.reduce((t, p) => t + (Number(p && p.unrealized_pl) || 0), 0) * 100) / 100;
          }
          // Flagged so the UI can never silently present the operator book as
          // the viewer's own account.
          sendJson(res, { positions: opPositions, account: opAccount, operator_view: true }, 200);
          return true;
        }
      }
    } catch (_e) { /* fall through to the legacy agent */ }
    // No broker connected (no IBKR, no Alpaca account, no legacy agent). Emit an
    // explicit `available:false` + reason so callers — the chat's trader_positions
    // tool especially — can degrade honestly ("connect a broker") instead of
    // mis-reading the empty `{account:{}}` as a real $0 account or surfacing a raw
    // endpoint error. Additive: `positions`/`account` are still present. (#2725)
    if (!traderAgent) {
      sendJson(res, { available: false, reason: 'no trading backend configured', positions: [], account: {} }, 503);
      return true;
    }
    try {
      const positions = await traderAgent.getPositions();
      sendJson(res, positions, 200);
    } catch (error) {
      console.error('[Trading] /positions error:', error.message);
      sendJson(res, { available: false, reason: error.message || 'broker request failed', positions: [], account: {} }, 500);
    }
    return true;
  }

  // GET /api/trading/portfolio/history?range=1D
  // Robinhood-style portfolio equity curve for the dashboard chart. Ranges:
  // 1D/1W/1M/3M/YTD/1Y/ALL. Sourced from the user's Alpaca account (own OAuth or
  // the operator's paper keys). Always 200 with { ok, ... }; ok:false carries an
  // honest `reason` (no broker connected) so the chart degrades to a flat baseline
  // rather than erroring.
  if (url.pathname === '/api/trading/portfolio/history' && req.method === 'GET') {
    try {
      const ALLOWED = new Set(['1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL']);
      const rangeParam = String(url.searchParams.get('range') || '1D').toUpperCase();
      const range = ALLOWED.has(rangeParam) ? rangeParam : '1D';
      // Preview/demo curve for the champion strategy (see the positions route).
      if (url.searchParams.get('demo') === 'champion') {
        sendJson(res, require('../../lib/champion-demo').history(range), 200);
        return true;
      }
      const uid = getEffectiveUserId(req);
      const alpaca = require('../../lib/alpaca-adapter');
      const out = await alpaca.getPortfolioHistory(uid, range);
      sendJson(res, out, 200);
    } catch (error) {
      sendJson(res, { ok: false, reason: error.message }, 200);
    }
    return true;
  }

  // GET /api/trading/market-status
  // Market status (VIX, SPY trend, market hours)
  if (url.pathname === '/api/trading/market-status' && req.method === 'GET') {
    if (!traderAgent) {
      sendJson(res, { market_open: false }, 503);
      return true;
    }
    try {
      const status = await traderAgent.getMarketStatus();
      sendJson(res, status, 200);
    } catch (error) {
      console.error('[Trading] /market-status error:', error.message);
      sendJson(res, { market_open: false, error: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/symbols/search?q=SP — symbol-search popup (#1692). Filters the
  // cached all-Alpaca-assets list by symbol/name, ranked (exact > prefix > contains).
  if (url.pathname === '/api/trading/symbols/search' && req.method === 'GET') {
    if (!traderAgent) { sendJson(res, { results: [], error: 'TraderAgent not initialized' }, 503); return true; }
    const q = (url.searchParams.get('q') || '').trim().toUpperCase();
    const klass = (url.searchParams.get('class') || '').trim();   // optional filter: us_equity | crypto
    const limit = Math.min(60, parseInt(url.searchParams.get('limit'), 10) || 30);
    try {
      // Prefer the connected IBKR account's own contract search — makes ANY tradable
      // US stock/ETF findable (not just a seed list), and only shows tradable names.
      // Falls back to the Yahoo probe below when no IBKR account is linked. Skip for
      // the crypto filter (IBKR crypto isn't tradable on this account).
      if (q && klass !== 'crypto') {
        const ibkr = await bridge.searchIBKRSymbols(getEffectiveUserId(req), q).catch(() => null);
        if (Array.isArray(ibkr) && ibkr.length) {
          sendJson(res, { results: ibkr.slice(0, limit), total: ibkr.length, query: q, source: 'ibkr' }, 200);
          return true;
        }
      }
      // Alpaca asset universe (the app's primary broker): gives the popup a full
      // tradable-symbol pool for fuzzy search. traderAgent.getAllAssets() is stubbed to
      // [] (the IBKR CPAPI has no bulk dump), so without this an Alpaca-only user got
      // just the single exact-ticker Yahoo probe below.
      const _alpaca = require('../../lib/alpaca-adapter');
      let assets = await traderAgent.getAllAssets();
      if ((!assets || !assets.length) && klass !== 'crypto' && _alpaca.available(getEffectiveUserId(req))) {
        assets = await _alpaca.listAssets(getEffectiveUserId(req)).catch(() => []);
      }
      let pool = klass ? (assets || []).filter((a) => a.class === klass) : (assets || []);
      let results;
      if (!q) {
        results = pool.slice(0, limit);
      } else {
        const scored = [];
        for (const a of pool) {
          const sym = (a.symbol || '').toUpperCase();
          const name = (a.name || '').toUpperCase();
          let score = -1;
          if (sym === q) score = 0;
          else if (sym.startsWith(q)) score = 1;
          else if (name.startsWith(q)) score = 2;
          else if (sym.includes(q)) score = 3;
          else if (name.includes(q)) score = 4;
          if (score >= 0) scored.push([score, sym.length, a]);
        }
        scored.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
        results = scored.slice(0, limit).map((s) => s[2]);
      }
      // Fallback (#1860): when the broker asset universe is unavailable (no
      // Alpaca creds → empty pool) but the user typed a query, validate it as an
      // exact ticker via the keyless Yahoo probe so "+ Add symbol" still works
      // for real symbols instead of returning nothing.
      if (!results.length && q && !pool.length) {
        const v = await traderAgent.validateSymbol(q);
        if (v && v.valid) {
          results = [{
            symbol: v.symbol, name: v.name || v.symbol,
            exchange: v.exchange || '', class: v.asset_class || 'us_equity',
            tradable: v.tradable !== false,
          }];
        }
      }
      sendJson(res, { results, total: pool.length, query: q }, 200);
    } catch (error) {
      sendJson(res, { results: [], error: error.message }, 200);
    }
    return true;
  }

  // GET /api/trading/logo?symbol=SPY — brand-logo proxy. Prefers logo.dev (crisp,
  // icon-style, high-res) when LOGODEV_TOKEN is set, else falls back to FMP. Served
  // same-origin so the page can sample luminance without CORS taint. (#1713)
  if (url.pathname === '/api/trading/logo' && req.method === 'GET') {
    const sym = (url.searchParams.get('symbol') || '').trim().toUpperCase();
    if (!sym || !/^[A-Z0-9.\-]{1,12}$/.test(sym)) { res.writeHead(400); res.end('bad symbol'); return true; }
    const https = require('https');
    const token = process.env.LOGODEV_TOKEN || '';
    const fmpUrl = `https://financialmodelingprep.com/image-stock/${encodeURIComponent(sym)}.png`;
    const ldUrl = token
      ? `https://img.logo.dev/ticker/${encodeURIComponent(sym)}?token=${encodeURIComponent(token)}&size=128&format=png&retina=true&fallback=404`
      : '';
    // FMP serves one generic stand-in image for every symbol it has no logo
    // for — passing it through gave every small-cap the same samey badge.
    // Detect it by hash and 404 instead, so the client's colored monogram
    // fallback renders. (logo.dev placeholders are disabled via fallback=404.)
    const PLACEHOLDER_SHA1 = 'b4e668e07c9d189f20f9e7302a5d8d1089abfb3a';
    const pipeFrom = (srcUrl, onFail) => {
      const rq = https.get(srcUrl, (up) => {
        const ct = up.headers['content-type'] || '';
        if (!(up.statusCode >= 200 && up.statusCode < 300 && ct.startsWith('image'))) { up.resume(); onFail(); return; }
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => {
          const buf = Buffer.concat(chunks);
          const sha = require('crypto').createHash('sha1').update(buf).digest('hex');
          if (sha === PLACEHOLDER_SHA1) { onFail(); return; }
          res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
          res.end(buf);
        });
        up.on('error', onFail);
      });
      rq.on('error', onFail);
      rq.setTimeout(8000, () => { rq.destroy(); onFail(); });
    };
    const sendFmp = () => pipeFrom(fmpUrl, () => { if (!res.headersSent) { res.writeHead(404); res.end(); } });
    if (ldUrl) pipeFrom(ldUrl, sendFmp); else sendFmp();
    return true;
  }

  // GET /api/trading/symbol-stats?ticker= — returns/volume/technicals from Yahoo
  // daily bars, for the expanded info panel (#1711).
  if (url.pathname === '/api/trading/symbol-stats' && req.method === 'GET') {
    const ticker = (url.searchParams.get('ticker') || '').trim();
    if (!ticker) { sendJson(res, { error: 'ticker required' }, 400); return true; }
    try {
      const yahoo = require('../../lib/market-data-yahoo');
      const data = await yahoo.getBars(ticker, '1d');
      const bars = (data && Array.isArray(data.bars)) ? data.bars : [];
      if (bars.length < 2) { sendJson(res, { ticker, returns: {}, available: false }, 200); return true; }
      const closes = bars.map((b) => b.close);
      const price = closes[closes.length - 1];
      const retOver = (n) => { if (bars.length <= n) return null; const p0 = closes[bars.length - 1 - n]; return p0 ? +(((price - p0) / p0) * 100).toFixed(2) : null; };
      const yr = new Date().getUTCFullYear();
      const yi = bars.findIndex((b) => new Date(b.timestamp).getUTCFullYear() === yr);
      const ytd = yi >= 0 && closes[yi] ? +(((price - closes[yi]) / closes[yi]) * 100).toFixed(2) : null;
      const avgVol = Math.round(bars.slice(-30).reduce((s, b) => s + (b.volume || 0), 0) / Math.min(30, bars.length));
      const sma = (n) => { const sl = closes.slice(-Math.min(n, closes.length)); return sl.reduce((s, c) => s + c, 0) / sl.length; };
      const s20 = sma(20), s50 = sma(50), s200 = sma(200);
      const bull = [s20, s50, s200].filter((s) => price > s).length;
      const technical = bull >= 3 ? 'Strong Buy' : bull === 2 ? 'Buy' : bull === 1 ? 'Sell' : 'Strong Sell';
      // Yahoo-summary fundamentals (#2412) — prev close/open, ranges, mkt cap,
      // beta, P/E, EPS, div yield, target — so the focused view reaches parity
      // with the Yahoo quote page. Best-effort; null on failure (panel degrades).
      let quote = null;
      try { quote = await yahoo.getQuoteSummary(ticker); } catch (_e) { quote = null; }
      sendJson(res, {
        ticker, price,
        returns: { '1M': retOver(21), '3M': retOver(63), 'YTD': ytd, '1Y': retOver(252), '3Y': retOver(756) },
        volume: bars[bars.length - 1].volume, avgVolume: avgVol,
        technical, bullCount: bull,
        sma20: +s20.toFixed(2), sma50: +s50.toFixed(2),
        quote,
        available: true,
      }, 200);
    } catch (error) {
      sendJson(res, { error: error.message, returns: {} }, 200);
    }
    return true;
  }

  // GET /api/trading/symbol-info?ticker=AAPL — name/exchange/asset_class for the
  // watchlist info panel (#1631). Read-only; reuses the Alpaca-backed validator.
  if (url.pathname === '/api/trading/symbol-info' && req.method === 'GET') {
    const ticker = (url.searchParams.get('ticker') || '').trim();
    if (!ticker) { sendJson(res, { error: 'ticker required' }, 400); return true; }
    if (!traderAgent) { sendJson(res, { error: 'TraderAgent not initialized' }, 503); return true; }
    try {
      const info = await traderAgent.validateSymbol(ticker);
      sendJson(res, info || {}, 200);
    } catch (error) {
      sendJson(res, { error: error.message }, 200);
    }
    return true;
  }


  // ── Price Feed (Phase 5) ──────────────────────────────────────────────────

  // GET /api/trading/price-feed?symbol=AAPL&range=1D
  // Returns: { symbol, range, ticks, source, current_price, open_price, generated_at }
  if (url.pathname === '/api/trading/price-feed' && req.method === 'GET') {
    const symbol = (url.searchParams.get('symbol') || 'SPY').toUpperCase();
    const range  = url.searchParams.get('range') || '1D';
    try {
      const data = await getPriceFeed().getTicks(symbol, range);
      sendJson(res, data);
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }

  // GET /api/trading/price-feed/watchlist?range=1D
  // Returns: [{ symbol, range, ticks, source, current_price, ... }, ...]
  if (url.pathname === '/api/trading/price-feed/watchlist' && req.method === 'GET') {
    const range     = url.searchParams.get('range') || '1D';
    const DEFAULT_WL = ['SPY', 'AAPL', 'TSLA', 'NVDA', 'MSFT'];
    const watchlist = url.searchParams.get('symbols')
      ? url.searchParams.get('symbols').split(',').map(s => s.trim().toUpperCase())
      : DEFAULT_WL;
    try {
      const results = await getPriceFeed().getWatchlistTicks(watchlist, range);
      sendJson(res, results);
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }

  // ── Crypto Collector Routes ──────────────────────────────────────────────────
  // Real-time crypto pricing and news from Kalshi markets + CoinGecko

  // GET /api/trading/crypto/prices
  // Returns latest crypto prices (BTC, ETH, SOL, XRP, DOGE) from Kalshi prediction markets
  if (url.pathname === '/api/trading/crypto/prices' && req.method === 'GET') {
    try {
      const cryptoCollector = deps.cryptoCollector;
      if (!cryptoCollector) {
        return sendJson(res, { error: 'Crypto collector not initialized' }, 503), true;
      }
      const prices = cryptoCollector.getLatestPrices();
      sendJson(res, { timestamp: new Date().toISOString(), prices }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to fetch crypto prices', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/crypto/prices/historical?limit=100
  // Returns historical crypto price snapshots (JSONL-based time series)
  if (url.pathname === '/api/trading/crypto/prices/historical' && req.method === 'GET') {
    try {
      const cryptoCollector = deps.cryptoCollector;
      if (!cryptoCollector) {
        return sendJson(res, { error: 'Crypto collector not initialized' }, 503), true;
      }
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam ? Number(limitParam) : 100;
      const prices = cryptoCollector.getHistoricalPrices(limit);
      sendJson(res, { timestamp: new Date().toISOString(), count: prices.length, prices }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to fetch historical prices', details: error.message }, 500);
    }
    return true;
  }

  return false;
};
