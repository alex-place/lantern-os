### Fixed

- tests: exit-authority failed when CI ran 09:30-10:00 ET on a trading day. It scanned on the real clock, and a signal exit waits until the session is 30 minutes old, so three of its six tests went red with no change to blame. Its scans and fixtures now run on a fixed Wednesday at noon ET. No trading code changed.
