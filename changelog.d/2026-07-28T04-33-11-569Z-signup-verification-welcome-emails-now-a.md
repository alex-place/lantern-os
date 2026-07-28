### Fixed

- Signup verification + welcome emails now actually send once Resend is configured. The email-verification gate keyed on smtpConfigured() alone, so a Resend-only prod deploy (RESEND_API_KEY set, no SMTP) fell through to the no-mailer auto-admit path and signed new users in without ever sending a confirmation email — 'the emails aren't wired'. The gate now keys on a new mailerConfigured() (Resend OR SMTP).
