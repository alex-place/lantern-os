### Fixed

- **auth: un-orphan pre-v1.14.2 accounts and stop advertising unconfigured
  sign-in methods.** The #3136 data-root collapse was correct going forward but
  orphaned every existing account on deployments whose service cwd was the app
  dir (the GCE box): the server read an empty canonical store while the real
  accounts sat in the legacy cwd-relative tree — email+password logins returned
  "Email or password is incorrect" and Google sign-ins silently minted fresh
  guest profiles, i.e. both login methods read as broken. #3136 shipped only a
  startup warning; boot now runs `lib/legacy-data-migrate.js`, a one-time,
  idempotent, fail-soft merge of the auth-critical stores (profiles, auth
  ledgers, billing idempotency) into the canonical root — JSONL merged
  legacy-first so latest-record-wins keeps canonical authority, token/event
  ledgers become the union, binary files never overwrite, canonical files are
  backed up as `*.pre-merge.bak`, and migrated legacy files are retired as
  `*.migrated`. Also: auth.html now renders only the OAuth buttons the server
  actually advertises (matching its own #1877 comment) instead of
  unconditionally showing Google and bouncing users into
  `provider_unconfigured`; if the provider list is unavailable it fails open
  and renders them all.
