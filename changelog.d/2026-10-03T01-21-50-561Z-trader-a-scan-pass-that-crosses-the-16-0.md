### Fixed

- trader: a scan pass that crosses the 16:00 bell opens nothing — the scan loop and the engine runner re-read the session window when the pass reaches the brain, after its scan; on 2026-10-02 a tick that began at 15:59 bought TLT at 16:00:23, ten minutes after the weekend flat
