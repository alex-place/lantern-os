# Internal House RAG Storage

Status: internal scaffold

This folder stores Lantern OS RAG-house outputs generated from reviewed repository files.

## Files

```text
LANTERN-OS-INTERNAL-HOUSE-RAG.flat.md   # gitignored — rebuild on demand (issue #2313)
RAG-HOUSE-MANIFEST.json
RAG-HOUSE-MANIFEST.sha256
```

`LANTERN-OS-INTERNAL-HOUSE-RAG.flat.md` is machine-generated and **not tracked
in git**. Rebuild it (read at runtime as the MCP resource `rag://house`) with:

```bash
npm run regen:rag      # or: make regen-rag  /  node scripts/regen-flat-rag.mjs
```

`scripts/regen-flat-rag.mjs` is the cross-platform generator (Windows dev, the
Linux deploy host, and CI). The hash-only manifest (`RAG-HOUSE-MANIFEST.json` /
`.sha256`) is still produced by `scripts/Update-InternalHouseRag.ps1` on Windows.

## Storage Rules

- Store paths, hashes, evidence classes, and selected file bodies.
- Keep secrets, `.env` files, raw PIID, private folders, and dirty source state out.
- Prefer hash-only manifests before body import.
- Treat this folder as internal memory, not public release proof.
- Source repositories remain authoritative until promotion is validated.

## Intake States

- `local_verified`: file exists locally and hash was generated during the current run.
- `source_repo_evidence`: source file was inspected and cited.
- `github_metadata`: repo metadata was verified, but file bodies may not be local.
- `operator_asserted`: operator named the source, but local verification is pending.
- `held`: import blocked by missing credentials, secrets risk, physical action, or destructive operation.

## Safe Promotion Path

1. Run the MCP connector verifier.
2. Run the RAG-house updater hash-only.
3. Review the manifest.
4. Re-run with `-IncludeFileBodies` only for approved text surfaces.
5. Validate no secrets or private folders were imported.
6. Commit generated outputs only after review.

## Boundary

This folder is not a trash can and not a dump of every artifact. It is a reviewed, hash-backed memory lane for Lantern OS.