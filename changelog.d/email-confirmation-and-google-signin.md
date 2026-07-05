### Added — Email confirmation for local sign-ups + Google sign-in setup

- **Hard email-confirmation gate for email/password accounts (ADR-0016 follow-up).**
  Registering with email + password now creates the account but does **not** sign
  you in: a confirmation link is emailed and login is blocked (`403 email_unverified`)
  until the link is clicked. New modules `lib/mailer.js` (SMTP via nodemailer, with a
  logged/offline fallback) and `lib/email-verification.js` (stateless signed tokens).
  New routes `GET /api/auth/verify-email` and `POST /api/auth/resend-verification`;
  `/auth.html` gained a "check your email" / resend / confirmed-success flow.
- **Google sign-in ("Continue with Google").** The provider was already wired; it
  just needs credentials. Added `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and the
  `SMTP_*` / `PUBLIC_BASE_URL` vars to `.env.example`, plus a step-by-step setup
  guide at `docs/GOOGLE-OAUTH.md`.
- Configure email delivery with `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` /
  `SMTP_PASS` / `SMTP_FROM` (`SMTP_SECURE=1` for port 465). Without them the
  confirmation link is written to the server log and `data/mail/outbox.jsonl`.
