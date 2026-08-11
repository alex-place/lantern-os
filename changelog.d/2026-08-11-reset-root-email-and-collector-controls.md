### Fixed

- **auth: password-reset links go to the address you typed, or nowhere.** The
  lookup also matched linked-identity (OAuth) emails and then mailed the reset
  link to the profile's ROOT address — requesting a reset for a linked gmail
  delivered the founder inbox instead ("wrong email to the wrong person",
  2026-08-11). Reset lookups are now root-email-exact (`rootOnly`); identity
  emails never receive or trigger reset mail. Anti-enumeration always-200
  behavior unchanged; regression test added.
- **release: the served `public/version.json` ships with the release.** The
  changelog assembler already bumped it, but the release runbook's `git add`
  list omitted it, so v1.15.0 deployed with the site footer/`/version.json`
  still reporting 1.14.2. Runbook fixed; this release carries the corrected
  file.

### Added

- **trading: Kalshi collector off-switch and snapshot retention.**
  `KALSHI_COLLECTOR=0` disables the tight-band poller outright (no polling, no
  snapshot files) without the collateral of `LANTERN_CHAT_ONLY`. New
  `KALSHI_SNAPSHOT_RETAIN_DAYS` (default 14, 0 disables) prunes old tight-band
  JSONL at start and on day rollover — the unrotated 6s snapshots (~2.5 GB/day)
  filled the GCE disk to 100% on 2026-08-06 and silently broke every write on
  the box (sessions, ledgers, deploys) for five days.
