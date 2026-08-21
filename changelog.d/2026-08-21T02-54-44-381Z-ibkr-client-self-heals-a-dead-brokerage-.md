### Changed

- IBKR client self-heals a dead brokerage session: a reachable-but-unauthenticated probe with an old cached LST drops the token so the next request re-handshakes — no more morning blindness after nightly maintenance
