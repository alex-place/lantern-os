### Changed

- trader UI: the account panel can no longer freeze silently — an auth redirect (HTML 200) is detected, the bare catch now degrades loudly, a staleness watchdog catches any unknown failure, and a visible STALE badge replaces the easy-to-miss dimming
