### Fixed
- **OAuth sign-in failures now log the real cause.** A live Google login on unisona.ai
  returned `{"error":"State mismatch"}` and then `{"error":"Session save failed"}` (HTTP
  500) with **nothing in the logs**, making a production auth outage undiagnosable. Both
  branches now log diagnostics — never the OAuth code, token, or profile:
  - the state check reports *which* of its three causes fired (unverifiable cookie —
    what a rotated/unset `SESSION_SECRET` or a cross-instance callback looks like; a
    genuinely different state; or a provider mismatch), plus whether the session and
    cookie were present at all;
  - the session-save failure reports the underlying **store** error (`code`, `errno`,
    `syscall`, `path`, store class, message + a truncated stack) — that callback only
    errors when the session store refuses the write, i.e. a read-only filesystem,
    missing/unwritable session dir, unreachable store, or full disk.
