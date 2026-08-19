### Fixed

- trader: the post-close session reviewer (#3359) is now actually invoked. It shipped as a module with no caller, so `TRADER_SESSION_REVIEW=1` was a no-op — the flag enabled nothing. It now runs fire-and-forget immediately after the session record is written, so it reads the same row a human would, and is never awaited: a slow or dead API cannot delay the close
