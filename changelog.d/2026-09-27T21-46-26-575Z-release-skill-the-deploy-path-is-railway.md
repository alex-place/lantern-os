### Fixed

- release skill: the deploy path is Railway, not the GCE poller. A published GitHub Release does not update unisona.ai; the skill now carries Step 4b (node scripts/railway-deploy.mjs --yes, guarded, verified via /api/version). Found on 2026-09-27 when the v1.16.0 Release published and the site stayed on the 09-11 upload.
