### Changed

- Post-close reviewer reads the ledger fresh after the session row is appended — its first live run correctly flagged that it was handed a snapshot that could never contain the record it audits
