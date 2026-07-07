fix(auth): explain the unverified-login bounce + dev self-service confirm link

Signing in with an unconfirmed email used to drop the user back on the "Confirm
your email" screen with no explanation — it read as a broken loop. It now says
why ("This email isn't confirmed yet…") instead of silently bouncing.

Local dev has no mail server, so the confirmation link only went to the server
log and the email gate could never be cleared on the operator's own machine. The
register / login-bounce / resend responses now include a `devVerifyLink` — but
ONLY on a direct, un-proxied loopback request when SMTP is not configured — and
the confirm screen surfaces it as a "🔧 Dev: open confirmation link" button so
the full flow is testable locally. Proxied/public traffic and any SMTP-configured
deployment never receive it (gated by `isLoopback` + `smtpConfigured`, mirroring
`isLocalBypass`). Verified both ways: present on loopback, absent with an
`x-forwarded-for` header.
