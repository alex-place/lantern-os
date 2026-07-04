### Changed — Email confirmation is now a hard gate; Google sign-in documented

- **Local email+password sign-ups are hard-gated on email confirmation.**
  Registering creates the account but no longer signs you in (`202`,
  `pendingVerification`); the confirmation email is sent and login is refused
  (`403 email_unverified`) until the link is clicked. Adds a resend endpoint
  (`POST /api/auth/resend-verification`) and a "check your email" / resend /
  confirmed-success flow on `/auth.html`. `verify-email` now lands signed-out
  users on the login page. Builds on the existing `mailer` + `auth-tokens`
  (`verify_email`) machinery.
- **Google sign-in ("Continue with Google")** was already wired — it just needs
  credentials. Documented `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and the
  `SMTP_*` / `MAIL_FROM` mail vars in `.env.example`, plus a step-by-step setup
  guide at `docs/GOOGLE-OAUTH.md`.
- Configure real mail delivery with `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` /
  `SMTP_PASS` (`SMTP_SECURE=1` for 465) and `MAIL_FROM`. Without them the
  confirmation link is written to the server log + `data/mail-outbox.jsonl`.
