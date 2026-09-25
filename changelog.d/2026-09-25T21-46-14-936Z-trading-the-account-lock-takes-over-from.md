### Fixed

- trading: the account lock takes over from a holder whose process is gone on this host at once, instead of waiting out the 5-minute stale window (a relaunched runner must not sit idle behind its own dead predecessor)
