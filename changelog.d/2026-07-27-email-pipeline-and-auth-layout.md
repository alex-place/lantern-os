### Fixed
- **Signup confirmation emails: made the unconfigured state impossible to miss, and
  configuration one env var.** The full mail pipeline (verify / password reset /
  new-sign-in templates, nodemailer, signup + forgot-password wiring) already existed —
  production simply has **no mail provider configured**, so every "send" silently fell
  back to the dev outbox file and no user ever received anything. Added a **Resend
  HTTP-API provider** (`RESEND_API_KEY` — one key, HTTPS instead of SMTP egress that
  cloud hosts throttle; takes precedence over SMTP, falls back honestly), a
  `mailerStatus()` diagnostic, and `scripts/test-email.mjs`, which reports the active
  transport and refuses to pretend a dev-outbox write is a delivery.
- **The create-account form's consent row rendered glitched** — the Terms checkbox
  stretched to the full card width and shoved the label text into a 40px column outside
  the card. Cause: `.local-form input { width:100% }` ties with `.tos-consent input`
  at specificity (0,1,1) and wins on source order. `[type="checkbox"]` lifts the
  consent rule above it.

### Added
- **Welcome email** on first successful email verification (guarded so re-confirmations
  never re-send) and a **password-changed security notice** after a completed password
  reset — the standard "if this wasn't you" alert. Both fire-and-forget; failures can
  never block the auth flow.
