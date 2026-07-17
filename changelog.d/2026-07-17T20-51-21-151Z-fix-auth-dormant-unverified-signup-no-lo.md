### Changed

- fix(auth): dormant unverified signup no longer blocks re-registration (#2703) — email_taken now reserved for verified/OAuth-linked profiles; unverified local-only signups re-issue verification idempotently
