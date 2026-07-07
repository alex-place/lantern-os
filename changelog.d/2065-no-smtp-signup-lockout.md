fix(auth): don't let a no-SMTP deploy permanently lock out local signups (#2065)

Local registration hard-gated login on `emailVerified`, but with SMTP unconfigured
the confirmation link only reached the server log — so a real (proxied/public) user
on a self-hosted, mailer-less deploy could never clear the gate and was locked out
forever.

When `smtpConfigured() === false` **and** the request is not a direct loopback hit,
registration now marks the account verified and signs the user in (and login rescues
any account created before this fix the same way), with a one-time operator warning
that email verification is disabled. Loopback requests are exempt, so the operator's
local confirm-email flow (and dev link) stays testable. When SMTP *is* configured the
hard email gate is unchanged.

Verified end-to-end against the dev server: proxied register → `ok` + verified + signed
in; proxied login → `ok` (not locked out); loopback register → confirm flow preserved.
