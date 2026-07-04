Desktop app no longer flashes command prompts (#1946). The old window-lifecycle
spawned PowerShell every 3s to poll browser processes — visible console windows.
Replaced with a heartbeat: lib/desktop-heartbeat.js injects a tiny script into served
HTML (desktop mode) that pings /__unisona/beat while open and sendBeacons on close;
the Core self-exits when beats stop and the launcher quits with it. No polling, no
console windows, still clean-quits on window close. Gated on UNISONA_DESKTOP=1.
Strengthens Act (native, flash-free desktop app).
