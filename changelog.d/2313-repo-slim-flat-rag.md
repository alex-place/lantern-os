chore(repo): untrack machine-generated flat-RAG dumps (#2313)

Repo-slim (Remember stage). Two large auto-generated concatenations are now
gitignored and rebuilt on demand instead of tracked:
- `data/internal-rag-house/LANTERN-OS-INTERNAL-HOUSE-RAG.flat.md` (1,765 lines)
  — read at runtime as the MCP resource `rag://house`.
- `skills/lantern-rag-dollhouse/references/LANTERN-OS-RAG-DOLLHOUSE.flat.md`
  (16,142 lines) — no runtime consumer; its old generator (`Sync-RagAndPdf.ps1`)
  and most of its 90 source files are already gone from the repo.

New cross-platform generator `scripts/regen-flat-rag.mjs` (Windows dev + Linux
deploy + CI, no PowerShell dependency) rebuilds both, wired as `npm run
regen:rag` and `make regen-rag`. The internal-house rebuild is a faithful port
of `scripts/Update-InternalHouseRag.ps1` (hash-only mode); the dollhouse rebuild
is best-effort from whatever `reports/*.md` + `applications/*.md` currently
exist. Verified: regen recreates both files and `rag://house` still reads the
internal-house dump via the fallback path.

Follow-up #2339: the server now also rebuilds the internal-house dump at boot
when missing or stale (`RAG_HOUSE_MAX_AGE_HOURS`, default 24; disable with
`RAG_HOUSE_BOOT_REGEN=0`), so a fresh clone / GCE deploy serves a populated
`rag://house` with no manual step.
