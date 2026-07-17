### Fixed

- **Registration no longer leaks which emails have accounts** (#2617): `POST /api/auth/local/register` returned `409 email_taken` for an existing address vs `202` for a new one — a clean account-enumeration oracle. It now returns the identical generic `202 "check your email"` for both, and emails the EXISTING owner a password-reset link so a legit re-register can recover (best-effort; register is already IP-throttled, so it can't be turned into a mail bomb).
- **RAG House architecture map tells the truth** (#2499, #2498):
  - The "Persona Narrators" card claimed 6 personas "route conversations by keyword" tagged **Live** — but keyword persona routing was removed in the one-assistant refactor (#1664). Rewritten to describe the real design: a single Keystone assistant whose capabilities are native tool calls (documents / web / market data / repo / memory).
  - "Read full docs →" and "Tesseract Loop" both linked to `docs/TESSERACT-CONVERGENCE-LOOP.md`, which 404s (missing from disk). Repointed to the existing `docs/TESSERACT-CSF-SINGULARITY.md`.
