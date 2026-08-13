### Changed

- watchdog: the locked-out alarm now requires a disarmed lock holder AND a stale state file — the armed server claims the lock via its own exit-only tick, which produced a false ALERT at 09:33 two mornings running
