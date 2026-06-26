### Autowork: Vertex AI (funded Gemini) as the lead provider

`callLlm` (the autowork plan/patch engine) now supports **Vertex AI** — Gemini on a
funded GCP project — and puts it first in the auto cascade. The free-tier
`GEMINI_API_KEY` caps at 20 req/min, which can't even finish one autowork run (the
plan call exhausts the minute budget, the patch call gets rate-limited). Vertex uses
the project's paid quota with real rate limits, so the full plan → patch → tests →
PR pipeline completes.

- Auth is Application Default Credentials (gcloud), **not** an API key: a short-lived
  OAuth token is minted via `gcloud auth application-default print-access-token` and
  cached ~50 min.
- Config: `VERTEX_PROJECT` (required), `VERTEX_LOCATION` (default `us-central1`),
  `VERTEX_MODEL` (default `gemini-2.5-flash`). Absent `VERTEX_PROJECT`, the cascade
  is unchanged.
- Verified: autowork ran end-to-end on real backlog issues via Vertex and opened
  linked draft PRs (#1279, #1280, #1282, #1283) where every cloud provider had
  previously failed (all out of credits / free-tier throttled).
