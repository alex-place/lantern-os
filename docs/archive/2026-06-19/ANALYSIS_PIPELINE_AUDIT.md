# Analysis Pipeline Audit — "Stuck at 10%" Fix

## Root cause

The analysis pipeline had **no streaming progress, no timeouts, and no watchdog**, and the worker processed one job at a time behind a lock that nothing could clear. Traced flow:

```
entry.html / create.html  (Analyze Highlights)
  → POST /api/creator/analyze            routes/creator.js
  → jobQueue.enqueue("analyze")          lib/job-queue.js
  → JobWorker.processNextJob (2s poll, single-job `currentJob` lock)   lib/job-worker.js
  → processAnalyzeJob
  → analyzeVideoForHighlights            lib/highlight-engine.js   ← the lock-up
  → persist to data/creator/entries/<id>/
```

`processAnalyzeJob` emitted `updateProgress(10, "Starting video analysis")`, then ran
`analyzeVideoForHighlights`, which did `Promise.all([detectMotion, detectAudioSpikes, detectSceneChanges])` —
**three full ffmpeg decodes of the entire video** — and emitted **nothing** until 70%. Four compounding failures:

1. **No progress 10→70%.** Even a healthy analysis sat at exactly 10% for the whole decode. On the user's long gameplay clips that is minutes → "appears to stall."
2. **No ffmpeg timeout.** `detectMotion`'s promise only settled on `close`/`error`. A hung ffmpeg (malformed stream/codec stall) never settled → the job hung at 10% **forever**.
3. **No job watchdog + a poisoning single-job lock** (`if (this.currentJob) return`). One stuck analysis wedged **every** future job permanently.
4. **UI gave up early.** create.html polled 300×500ms = 2.5 min, shorter than a real analysis, so it showed "Job timeout" while the backend kept running.

## Fixes

### `lib/highlight-engine.js`
- `analyzeVideoForHighlights(videoPath, options, onProgress)` now **streams sub-stage progress** (8→66%): `loading_video`, `analyzing_motion` (frame-based, ~1 update/sec of decoded video), then a bump as each of the 3 passes settles, then `detecting_highlights`.
- **Per-process timeout** on every `detectMotion`/`detectAudioSpikes`/`detectSceneChanges`/`getVideoMetadata` ffmpeg/ffprobe spawn (default 4 min; ffprobe 60s). On timeout the process is `SIGKILL`ed and the promise settles — no infinite hang.
- **Duration cap** (`-t maxAnalyzeSeconds`, default 900s) bounds decode time/memory on huge clips; flagged as `metadata.analysisCapped`.
- Fixed a latent correctness bug: motion/audio timestamps used the *count of kept frames* instead of the true frame index.

### `lib/job-worker.js`
- **Idle watchdog** in `executeJob`: if a job emits no progress for `LANTERN_JOB_IDLE_TIMEOUT_MS` (default 5 min) it is failed with `timeout: no progress for 5 min` and the worker is released — one stuck job can no longer poison the queue.
- Streams the engine's sub-stage progress into the job; sets the project `status` to `analyzing` during the run.
- On failure, persists a **structured `analysisError`** (stage + reason) and a **failed run** to the project; on success records a **completed run** and clears the error.

### `lib/entry-store.js`
- `recordAnalysisError` / `clearAnalysisError` / `addAnalysisRun` (audit trail, capped at 20) + `analysisRuns`/`analysisError` backfilled in `normalizeEntry`.
- `repairAllProjects` — scans every project, writes back the normalized metadata, reports missing video/thumbnail.

### `routes/creator-entries.js`
- `POST /api/creator-entries/repair-metadata` → runs `repairAllProjects` (Phase 5 migration).

### `public/entry.html`
- **Analysis failure banner** (Stage / Reason / When) + **Analysis Runs** history, rendered from the persisted project — visible after refresh.

### `public/create.html`
- Poller cap raised to 1200×500ms = 10 min (longer than the 5-min backend watchdog).

## Before / After

| | Before | After |
|---|---|---|
| Progress | Hardcoded jump 10→70, nothing between | Streams 8→66 frame-based, then 70/85/95/100 |
| Hung ffmpeg | Job hangs at 10% forever | Killed after 4 min → job fails with reason |
| Stuck worker | Poisons all future jobs | Idle watchdog fails it (5 min), queue recovers |
| Failure | Silent | `analysisError` persisted + shown (stage + reason) |
| Huge clip | Unbounded decode | Capped at first 15 min (`analysisCapped`) |
| Audit | None | `analysisRuns[]` history per project |

## Verification

Automated harness against the live server + the engine module (11/11 pass):

- `detectMotion honors per-process timeout` — rejects when given a 50ms budget
- `analyze completes (not stuck)` — final status `complete`
- `progress moved past 10%` — observed values `0, 8, 33, 100`
- `multiple distinct progress values` — 4 distinct
- `analysis persisted` + `analysis run recorded`
- `corrupt video fails the job (no hang)` — final status `failed`
- `analysisError persisted with reason` — `Could not read video (ffprobe failed): …`
- `failed run in audit trail`
- `repair-metadata scans projects` — scanned 5

All changed JS is `node --check` clean (incl. `entry.html`/`create.html` inline scripts).

## Known limitations

- The idle watchdog uses `Promise.race`; an orphaned handler keeps running until its own ffmpeg timeouts fire (≤4 min) — it just no longer blocks the queue.
- Analysis is capped at the first 15 min of a clip by default (`maxAnalyzeSeconds`); configurable.
- In-browser click-through (Chrome/Opera GX) confirms rendering; the reliability guarantees themselves are proven at the API/module layer above.

## Tunables (env)

- `LANTERN_JOB_IDLE_TIMEOUT_MS` — idle watchdog (default 300000 = 5 min)
- engine `options.perProcessTimeoutMs` (default 240000) / `options.maxAnalyzeSeconds` (default 900)
