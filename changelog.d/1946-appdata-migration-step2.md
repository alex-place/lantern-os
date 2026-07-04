refactor(desktop): route CSF memory + rag-house + server.js constants through app-paths.dataRoot() — Phase-0 migration step 2 (#1946)

Completes the writable-state migration begun in step 1 (#1983). csf-memory.js +
csf-memory-writer.js (the Memory core object), rag-house.js, and server.js's
conversationLogPath / flatRagHousePath / operatorNotesPath / tesseract paths now
compute data/ locations from dataRoot(), so UNISONA_DESKTOP=1 relocates them to
%APPDATA%\unisona\data. These read via absolute paths (no readJsonl/path.relative
coupling), so the swap is clean. Also fixes a latent bug in rag-house.js: its
2-level repoRoot sent flatRagHousePath/flatRagHouseManifestPath to a non-existent
apps/data + apps/manifests; they now target the real repo-root data//manifests/
(what server.js already serves), while its repoRoot var stays 2-level for
repoSources(). Behaviour-preserving on servers (full test:sigma0 green). Covered by
a recordLifeFact relocation check in test/appdata-migration.test.js. All core
writable-state sites now route through the seam. Strengthens **Remember**.
