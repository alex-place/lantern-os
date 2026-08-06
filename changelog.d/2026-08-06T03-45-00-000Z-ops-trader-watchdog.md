### Added

- ops: `scripts/trader-watchdog.js` — durable health check for the live day-trader. Catches the failures that look like a quiet market: a disarmed process holding the account lock, a stalled scan loop behind a healthy HTTP endpoint, and silently refused entries. Read-only w.r.t. trading; run it from outside the checkout on a ~5min schedule during market hours.
