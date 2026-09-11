'use strict';
/**
 * start.js — the production entry point (railway.json startCommand), #3523.
 *
 * LANTERN_SPLIT=1: the website and the trader run as two processes under
 * lib/split-supervisor.js. Otherwise server.js runs in THIS process, exactly as
 * `node server.js` does, so nothing changes until the switch is set.
 */
if (process.env.LANTERN_SPLIT === '1') require('./lib/split-supervisor').run();
else require('./server.js');
