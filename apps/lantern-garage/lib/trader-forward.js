'use strict';
/**
 * trader-forward.js — the web process hands trader-owned routes to the trader (#3523).
 *
 * With the split on, a few /api/trading routes read or change state that lives INSIDE the
 * trader process. Served by the web process they would lie (a monitor that isn't running
 * there reports "not monitoring") or do harm (starting the Kalshi stop-loss monitor in the
 * web process would run a second executor on the same account). So the web process
 * forwards exactly these to the trader over loopback. Everything else under /api/trading
 * reads files or the broker and is served where it lands.
 *
 * The original request headers go along untouched: the session cookie (signed, so the
 * trader verifies it with the same SESSION_SECRET) and the proxy's x-forwarded-* headers,
 * which keep the trader from mistaking a forwarded internet request for a local one.
 */
const http = require('http');

// path -> why it belongs to the trader process
const FORWARD = new Map([
  ['/api/trading/extended-hours', "the extended-hours switch is the trading loop's in-memory flag"],
  ['/api/trading/overnight-scan', 'alias of /api/trading/extended-hours'],
  ['/api/trading/kalshi/monitor/start', 'starts the Kalshi stop-loss monitor, which must run once, in the trader'],
  ['/api/trading/kalshi/monitor/stop', 'stops that monitor'],
  ['/api/trading/kalshi/monitor/positions', "that monitor's in-memory positions and stats"],
  ['/api/trading/brake/status', 'the brake monitor runs in the trader and keeps its status in memory'],
  ['/api/trading/sigma-trader', "the Sigma schedule's status and its rebalance guard live in the trader"],
  ['/api/trading/champion', 'alias of /api/trading/sigma-trader'],
]);

const shouldForward = (pathname) => FORWARD.has(pathname);

function forward(req, res, url, { target, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const t = new URL(target);
    const headers = { ...req.headers, host: t.host, 'x-lantern-forwarded-by': 'web' };
    const up = http.request({ hostname: t.hostname, port: t.port, method: req.method, path: url.pathname + url.search, headers }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
      r.on('end', () => resolve(true));
      r.on('error', () => resolve(true));
    });
    up.setTimeout(timeoutMs, () => up.destroy(new Error(`no answer in ${Math.round(timeoutMs / 1000)}s`)));
    up.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'trader_unreachable',
          message: `The trader process didn't answer (${e.message}). It restarts on its own; try again in a few seconds.` }));
      }
      resolve(true);
    });
    req.pipe(up);
  });
}

module.exports = { FORWARD, shouldForward, forward };
