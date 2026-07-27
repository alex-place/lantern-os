- feat(orchestration): fresh-slate fleet page. Keys/broker UI removed (migrated to
  settings; all #broker deep links repointed to /settings.html#connections). The page
  is now three jobs: (1) register this machine's resources to the fleet — heartbeats
  carry gpu/vram/ram/availability/donor-only, roster stays git-native in
  config/mesh-members.json (seeded: alex, kriskin, mookman11, dj as donor); (2) the
  training-job board — GitHub issues labeled `training-job` with a fenced
  ```training-job block are the ONLY job source (new GET /api/training-jobs, script
  allowlist + arg charset validation, issue template .github/ISSUE_TEMPLATE/
  training-job.md); (3) run a job as observable autonomous work with the step stream
  on screen (existing admin-gated autowork SSE endpoint). routes/mesh.js was written
  but never wired into server.js — now wired. A needs-attention strip answers "is
  anything stuck" at the top. Browser-verified end-to-end on a live server: roster,
  heartbeat with resources, stranger rejection, board parsing of issue #3007, admin
  gating, zero console errors. 3 new parser unit tests.
