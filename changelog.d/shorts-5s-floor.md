### Creator: allow short-form exports as short as 5s

- The ExportValidator short-form floor dropped from **15s → 5s**, so the editor can ship genuine **5–6s highlight shorts** (e.g. cut from a short reference clip) instead of failing every render under 15s. Previously a short source produced a variant cut below 15s, the validator deleted it, and the project's Renders tab stayed empty with no explanation.
- Changed in two kept-in-sync places: `src/creator-intelligence/scoring/export-validator.js` (`DEFAULTS.minDuration`) and `apps/lantern-garage/lib/job-worker.js` (`EXPORT_MIN_DURATION_SEC`, the cut-list top-up target). `maxDuration` stays 60s.
