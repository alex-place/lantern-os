# Creator Intelligence — Subsystem Architecture

`src/creator-intelligence/` is the V10 brain. It is **data-first**: nothing it returns is invented. Every output is either computed from a real uploaded video or aggregated from rows that physically exist in `data/creator-intelligence/`.

## Module map

```
src/creator-intelligence/
├── index.js                      # public API surface + feature-flag gating
├── dataset/
│   ├── schema.js                 # row schemas + validators (general, gaming, edit)
│   ├── dataset-store.js          # read/append/count rows; reports honest sizes
│   └── feature-flags.js          # flag resolution (defaults + env overrides)
├── analysis/
│   └── reverse-engineer.js       # distributions over EXISTING rows; insufficient_data when empty
├── scoring/
│   └── score-engine.js           # viral/retention scoring; guarded by data sufficiency
├── training/
│   └── learning-store.js         # append edits/variants/selections (continuous learning)
└── recommendations/
    └── recommend.js              # editing recommendations derived from analysis/scoring
```

Storage (separate from code, git-ignored except manifests/READMEs):

```
data/creator-intelligence/
├── MANIFEST.json                 # counts + provenance; the source of truth for "how much data exists"
├── general/                      # general Shorts rows (*.jsonl)
├── gaming/                       # gaming Shorts rows (*.jsonl)
└── edits/                        # local continuous-learning events (*.jsonl)
```

## The sufficiency contract

Every public function that could be tempted to invent a number instead returns one of two shapes:

```js
// when enough real data exists
{ status: "ok", value: <number>, basis: { datasetSize, source, computedAt } }

// when it does not
{ status: "insufficient_data", reason: <string>, have: <n>, need: <n> }
```

The UI switches on `status`. There is no third path where a guess leaks through. `MIN_ROWS_FOR_*` thresholds live in `score-engine.js` and are intentionally conservative.

### Why thresholds, not "any data will do"

A handful of rows cannot characterize "viral pacing." Reporting a confident score off 12 samples would itself be a fabrication. Thresholds (e.g. `MIN_ROWS_FOR_DISTRIBUTION = 200`, `MIN_ROWS_FOR_SCORING = 500`) make the honesty rule concrete and testable.

## Data flow

```
upload ─▶ highlight-engine (real ffmpeg) ─▶ HighlightTimeline
                                             │
                          safe-zone-v2 ──────┼─▶ analysis view (always real)
                                             │
                          caption-engine-v3 ─┘
                                             │
        dataset-store (rows? ) ─▶ score-engine ─▶ { ok | insufficient_data }
                                             │
                          variant-engine-v2 ─┴─▶ ranked variants (confidence-tagged)
                                             │
                          export-validator ─▶ ffprobe gates ─▶ allow | block(reason)
                                             │
                          learning-store ◀───┘  (append edit/variant/selection)
```

Two independent truth sources feed the dashboard:

- **Per-video truth** (highlight, safe zones, ffprobe) — available immediately, no dataset required.
- **Population truth** (what tends to perform) — only available once the dataset crosses thresholds; otherwise `insufficient_data`.

## Public API (`index.js`)

```js
const ci = require("../../src/creator-intelligence");

ci.flags()                        // resolved feature flags
ci.dataset.counts()               // { general, gaming, edits } real counts
ci.dataset.appendGeneral(row)     // validate + append; throws on schema violation
ci.analysis.reverseEngineer()     // report OR { status:"insufficient_data" }
ci.scoring.viralScore(features)   // { ok,value,basis } OR { insufficient_data }
ci.scoring.retentionScore(features)
ci.training.recordEdit(event)     // continuous-learning append
ci.recommendations.forVideo(analysis) // editing suggestions (per-video, always real)
```

When `creatorIntelligence` flag is off, `index.js` still loads but population-dependent calls short-circuit to `insufficient_data` with `reason: "subsystem_disabled"`.

## Integration points (server)

- `routes/creator.js` / `routes/creator-entries.js` call `ci.recommendations.forVideo(...)` and `ci.scoring.*` and pass the raw `{status}` through to the client.
- `routes/media.js` already streams source/edited/variant files (added in the media-workflow fix).
- Export path calls `ExportValidator` (see [export-validator.md](export-validator.md)) before writing a final render.

## Non-goals (explicit)

- No bulk scraping of platforms in violation of ToS. Collection adapters are credentialed and rate-limited; absent credentials the dataset stays empty.
- No pretrained "viral model" weights shipped in-repo. Population intelligence is computed locally from rows the operator legitimately collected.
- No synthetic/placeholder metrics to make the UI "look finished."

## Feature flags

(Absorbed from `creator-dashboard-v10-plan.md`, 2026-07-16.) All V10 behavior
ships behind flags in `src/creator-intelligence/dataset/feature-flags.js`
(env-overridable); default **off** for anything unproven so the stable dashboard
is never destabilized:

| Flag | Env var | Default | Gates |
|---|---|---|---|
| `creatorIntelligence` | `LANTERN_CI_ENABLED` | off | whole subsystem |
| `safeZoneV2` | `LANTERN_CI_SAFEZONE_V2` | off | new detector |
| `captionEngineV3` | `LANTERN_CI_CAPTION_V3` | off | new caption engine |
| `variantEngineV2` | `LANTERN_CI_VARIANT_V2` | off | A–E variants |
| `exportValidator` | `LANTERN_CI_EXPORT_VALIDATOR` | **on** | ffprobe gates (safe to enable) |
| `researchReport` | `LANTERN_CI_RESEARCH_REPORT` | off | reverse-engineer report |
