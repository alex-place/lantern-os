# Σ₀ Research Flywheel — Runtime Status

Honest, evidence-based answer to "is the research loop actually running?" — not a
guess. Re-run the checks below any time; regenerate the live view with
`GET /api/research/status` (or the Creator Dashboard card).

## Step 1 — Was research running? **NO** (verified 2026-06-19)

| Check | Result | Evidence |
|---|---|---|
| `research-nightly` / `open-video-research` / `yt_dlp` process | **not running** | `Get-CimInstance Win32_Process` matched none |
| Scheduled task (cron/Task Scheduler) | **none** | `Get-ScheduledTask -match research\|lantern\|sigma` empty |
| `editing_priors.json` changing over time | **no** | file absent on the working branch; seed elsewhere |
| Feature corpus | **empty** | `research/open_video/features/features.jsonl` absent |
| `/api/research/status` live | **404 / no response** | pre-#715 server doesn't have the route yet |

The two Node servers that *were* running are the lantern-garage web server and the
trading service — neither does research. **Conclusion: nothing was researching.**

> This is expected: the agent builds and runs the loop on request; it is not a
> daemon that stays resident. Persistence comes from re-running `npm run
> research-nightly` (manually or via a scheduled task), not from a process that
> happens to still be alive.

## Step 2 — Started a real run

Command: `npm run research-nightly` (`scripts/open-video-research.js --nightly`).
Each clip: download (≤480p, first 120s) → analyze whole clip → store features →
**DELETE the video**. Open-license only (allowlist of CC-BY Blender films +
archive.org items filtered to `licenseurl: creativecommons|publicdomain`).

### Latest run — real corpus, weights moved (2026-06-19)

| Field | Value |
|---|---|
| Running now | **NO** (batch run completed; not a resident daemon) |
| Videos analyzed this session | **37** (download → analyze → delete; 0 retained) |
| Sources | allowlist (5 CC-BY Blender films) + archive.org (CC/PD, license-filtered) |
| Failures skipped | a handful of slow/odd-format items (per-download timeout) |
| Current sample count | **37** (`editing_priors.json`) |
| Last analyzed | 2026-06-19T01:20:39Z |
| Adaptation | **priorInformed: true** (37 > 25) — `/api/research/status` → `status: "adapting"`, 100% |

**Learned priors:** hook 0.112 · cut/s 4.983 · motion 0.118 · facecam top_right
(dist: top_right 4, bottom_left 3, top_left 2, bottom_right 1).

**Σ₀ weights moved** (baseline → learned, renormalized — see `research/weight_deltas.json`):

| component | before | after | Δ |
|---|---|---|---|
| hook | 0.15 | **0.126** | −0.024 |
| retention | 0.20 | **0.219** | +0.019 |
| surprise | 0.20 | 0.188 | −0.012 |
| rewatch | 0.10 | 0.109 | +0.009 |
| pacing | 0.10 | 0.094 | −0.006 |

The corpus opens softer than the neutral midpoint (hook 0.112), so the editor
**de-emphasizes the hook component** — a directional, bounded nudge, not a fitted
model. Every source video was deleted; only features/priors are retained.

## How to check / keep it running

```bash
npm run research-nightly        # one real batch (download → analyze → delete → learn)
npm run research-calibrate      # recompute weight deltas from the corpus
curl localhost:4177/api/research/status   # live corpus size, weights, adaptation %
```

Weights begin to adapt automatically once the corpus reaches **> 25 samples**
(`editing-priors-adapter.js`); below that the editor uses baseline weights and the
dashboard shows "collecting".
