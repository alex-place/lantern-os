fix(orchestration): reconcile the "In Progress" stat against reality + GC stale assigned claims

The Work Board's "In Progress" count came straight from `countJson("assigned")` —
the raw number of `issue-<N>.json` claim files on disk. auto-dispatch's
`markAssigned()` writes one such file per issue it opens a draft PR for and never
removes it, so when the issue later closes the claim lingers forever. 75 stale
closed-issue claims had accumulated with 0 agents actually running and 9 open
issues, so the dashboard read "In Progress: 75" — pure cruft.

`/api/queue/status` now reconciles that count against external reality: a claim is
counted only while its issue is still open AND the claim is fresh (`< 6h`).
Closed-issue and aged-out claims are excluded from the count and surfaced
separately as `staleAssigned`. The same live-claim filter now guards the pending
backlog exclusion, so a stale claim can no longer hide a still-open issue from the
queue forever (the "failed never de-queue" starvation jam).

A new `POST /api/queue/reconcile` endpoint (with `?dryRun=1`) garbage-collects the
stale claim files and appends an audit record per sweep to
`reconcile-log.jsonl`; the server also runs one such sweep at boot (deferred off
the listen path). Improves the Verify/Converge stages — the orchestration stats now
reflect genuinely in-flight work instead of accumulated claim-file leakage.
