// Dev entry shim — hooks server.js startup to FORCE the dev port (4178).
//
// server.js resolves its port as: LANTERN_GARAGE_PORT || PORT || 4177, and
// binds 0.0.0.0 whenever PORT is set. Some launchers (the preview tool,
// Railway, npm) inject their own PORT, which would otherwise drag the dev
// server onto the wrong port/host. We neutralize PORT here so dev always
// binds dev — deterministically, no matter who launches it.
const DEV_PORT = process.env.LANTERN_DEV_PORT || '4178';

delete process.env.PORT;                       // strip any launcher-injected PORT
process.env.LANTERN_GARAGE_PORT = DEV_PORT;    // force the dev port
process.env.LANTERN_GARAGE_HOST = '127.0.0.1'; // dev stays local-only

require(__dirname + '/server.js');
